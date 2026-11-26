import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BashScriptsService, BASH_SCRIPTS_FILE } from '../services/bashScriptsService.js';
import { readBashScript, saveBashScript } from '../services/bashScriptFile.js';
import type { BashScriptEntry, BashScriptRef, BashScriptsRequest, BashScriptsResponse, BashScriptsResult } from '../types/bashScripts.js';

/** Исключения относятся только к автодобавлению. В этих папках файл можно выбрать вручную. */
const AUTO_EXCLUDE = '{**/.git/**,**/node_modules/**,**/vendor/**,**/.venv/**,**/dist/**,**/build/**,**/out/**,**/out-tests/**,**/.vscode/prompt-manager/**}';
const AVAILABILITY_KEY = 'bashScripts.availability.v1';

/** Связывает события оболочки и терминала с одной командой, пока сохраняется начало её запуска. */
interface TerminalRun {
	ref: BashScriptRef;
	id: string;
	command: string;
	catalog: BashScriptsService;
	execution?: vscode.TerminalShellExecution;
	startRecorded: boolean;
	ended?: { at: string; code?: number; by: 'shell' | 'terminal' };
}

/** Открытый терминал запусков одного скрипта. Повторный запуск идёт в него, пока оболочка свободна. */
interface ScriptTerminal {
	ref: BashScriptRef;
	/** Запуски этого терминала от старого к новому. */
	runIds: string[];
	/** Окружение терминала задано при создании: другой файл или рабочая папка требуют нового терминала. */
	scriptPath: string;
	cwd: string;
	panelCwd: string;
	/** Оболочка выполняет команду — запуск скрипта или набранную пользователем после его окончания. */
	executing: boolean;
}

/** Встроенный Git сообщает уже открытые корни, включая вложенные репозитории и рабочие деревья. */
interface RepositoryList {
	readonly repositories: readonly { rootUri: { fsPath: string } }[];
	onDidOpenRepository?: (listener: () => void) => vscode.Disposable;
	onDidCloseRepository?: (listener: () => void) => vscode.Disposable;
}

/** Связывает панели с каталогом текущего workspace и терминалами именно этого Extension Host. */
export class BashScriptsHostController implements vscode.Disposable {
	private catalog: BashScriptsService;
	private discovery: 'initial' | 'foldersChanged' | 'ready' = 'initial';
	private scanPending?: Promise<void>;
	private listSnapshot?: Promise<BashScriptsResult>;
	private verifyRestored = false;
	private savedAvailability = '';
	private repositoryWarning?: string;
	private readonly subscriptions: vscode.Disposable[] = [];
	private notifyTimer?: ReturnType<typeof setTimeout>;
	private readonly runs = new Map<vscode.Terminal, TerminalRun>();
	/** Терминалы отправленных запусков до их закрытия. Порядок вставки соответствует времени последнего запуска. */
	private readonly terminals = new Map<vscode.Terminal, ScriptTerminal>();
	private repositoryRoots: string[] = [];
	private repositoriesReady?: Promise<void>;
	private disposed = false;

	constructor(private readonly launcherPath: string, private readonly globalDir: string, private readonly projectDir: string, private readonly changed: () => void,
		private readonly getRepositories?: () => Promise<RepositoryList | null>, private readonly workspaceState?: vscode.Memento) {
		this.catalog = this.createCatalog();
		const saved = workspaceState?.get(AVAILABILITY_KEY);
		if (Array.isArray(saved)) {
			this.savedAvailability = JSON.stringify(saved);
			this.catalog.restoreAvailability(saved);
			this.verifyRestored = true;
		}
		this.subscriptions.push(
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				this.catalog = this.createCatalog();
				this.scanPending = undefined;
				this.discovery = 'foldersChanged';
				this.invalidate();
			}),
			vscode.window.onDidChangeWindowState(state => {
				if (state.focused && this.discovery === 'ready') void this.verifyAvailability(true);
			}),
			vscode.window.onDidStartTerminalShellExecution(({ terminal, execution }) => {
				// Любая команда занимает оболочку: повторный запуск прервал бы её через Ctrl+C.
				const shell = this.terminals.get(terminal);
				if (shell) shell.executing = true;
				const run = this.runs.get(terminal);
				if (run && !run.execution && execution.commandLine.value === run.command) {
					run.execution = execution;
					if (run.startRecorded) this.invalidate();
				}
			}),
			vscode.window.onDidEndTerminalShellExecution(event => {
				const shell = this.terminals.get(event.terminal);
				if (shell) shell.executing = false;
				const run = this.runs.get(event.terminal);
				if (run && (run.execution === event.execution ||
					(!run.execution && event.execution.commandLine.value === run.command))) {
					this.finish(event.terminal, 'shell', event.exitCode);
				}
			}),
			vscode.window.onDidCloseTerminal(terminal => {
				// Закрытый терминал больше нельзя показать. Строка убирает кнопку при следующем чтении списка.
				if (this.terminals.delete(terminal)) this.notifySoon();
				this.finish(terminal, 'terminal');
			}),
		);
		for (const dir of [globalDir, projectDir]) {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), BASH_SCRIPTS_FILE));
			this.subscriptions.push(watcher, watcher.onDidCreate(() => this.notifySoon()), watcher.onDidChange(() => this.notifySoon()),
				watcher.onDidDelete(() => this.notifySoon()));
		}
		// Создание, удаление и переименование файла меняют доступность уже показанных записей.
		const scripts = vscode.workspace.createFileSystemWatcher('**/*.{sh,bash}');
		const refreshAvailability = (uri: vscode.Uri) => {
			if (this.catalog.invalidateAvailability(uri.fsPath)) this.notifySoon();
		};
		this.subscriptions.push(scripts, scripts.onDidCreate(refreshAvailability), scripts.onDidDelete(refreshAvailability),
			scripts.onDidChange(refreshAvailability));
	}

	private invalidate(): void {
		this.listSnapshot = undefined;
		this.changed();
	}

	private notifySoon(): void {
		if (this.disposed) return;
		this.listSnapshot = undefined;
		clearTimeout(this.notifyTimer);
		this.notifyTimer = setTimeout(this.changed, 150);
	}

	private async verifyAvailability(externalOnly: boolean): Promise<void> {
		const catalog = this.catalog;
		const [files, catalogs] = await Promise.all([catalog.recheckAvailability(externalOnly),
			externalOnly && catalog.catalogsChanged().catch(() => true)]);
		if ((files || catalogs) && catalog === this.catalog) this.notifySoon();
	}

	private createCatalog(): BashScriptsService {
		const catalog = new BashScriptsService({ globalStorageDir: this.globalDir, projectStorageDir: this.projectDir,
			workspaceRoots: vscode.workspace.workspaceFolders?.map(folder => ({ root: folder.uri.fsPath, name: folder.name })) ?? [] });
		if (this.repositoryRoots.length) catalog.setRepositoryRoots(this.repositoryRoots);
		return catalog;
	}

	/** Подключаем источник при первом чтении. Открытие и закрытие репозитория обновляет видимые группы. */
	private observeRepositories(): Promise<void> {
		if (!this.getRepositories) return Promise.resolve();
		return this.repositoriesReady ??= this.getRepositories().then(git => {
			if (!git || this.disposed) {
				this.repositoriesReady = undefined;
				return;
			}
			const update = () => {
				this.repositoryRoots = git.repositories.map(repository => repository.rootUri.fsPath);
				this.catalog.setRepositoryRoots(this.repositoryRoots);
			};
			const changed = () => { update(); this.notifySoon(); };
			if (git.onDidOpenRepository) this.subscriptions.push(git.onDidOpenRepository(changed));
			if (git.onDidCloseRepository) this.subscriptions.push(git.onDidCloseRepository(changed));
			this.repositoryWarning = undefined;
			changed();
		}).catch(error => {
			this.repositoriesReady = undefined;
			const warning = 'Репозитории Git: ' + (error instanceof Error ? error.message : String(error));
			if (this.repositoryWarning !== warning) {
				this.repositoryWarning = warning;
				this.notifySoon();
			}
		});
	}

	private scan(): Promise<void> {
		if (this.scanPending) return this.scanPending;
		const catalog = this.catalog;
		this.scanPending = (async () => {
			const files = await vscode.workspace.findFiles('**/*.{sh,bash}', AUTO_EXCLUDE);
			if (catalog !== this.catalog) return;
			await catalog.scan(files.map(file => file.fsPath));
			if (catalog === this.catalog) this.discovery = 'ready';
		})().finally(() => { if (catalog === this.catalog) this.scanPending = undefined; });
		return this.scanPending;
	}

	/** Одна панель наполняет снимок для остальных. Изменения каталога сбрасывают его до следующего чтения. */
	private list(): Promise<BashScriptsResult> {
		void this.observeRepositories();
		if (this.listSnapshot) return this.listSnapshot;
		const catalog = this.catalog;
		const result = this.readList(catalog);
		this.listSnapshot = result;
		void result.then(snapshot => {
			if (this.disposed || this.catalog !== catalog || this.listSnapshot !== result) return;
			if (snapshot.warning) this.listSnapshot = undefined;
			if (!snapshot.warning && this.workspaceState && snapshot.entries) {
				const pairs = [...new Map(snapshot.entries.map(entry => [entry.absolutePath, entry.available] as const))];
				const serialized = JSON.stringify(pairs);
				if (serialized !== this.savedAvailability) {
					this.savedAvailability = serialized;
					void Promise.resolve(this.workspaceState.update(AVAILABILITY_KEY, pairs)).catch(() => {
						if (this.savedAvailability === serialized) this.savedAvailability = '';
					});
				}
			}
			if (this.verifyRestored) {
				this.verifyRestored = false;
				void this.verifyAvailability(false);
			}
		}, () => { if (this.listSnapshot === result) this.listSnapshot = undefined; });
		return result;
	}

	private async readList(catalog: BashScriptsService): Promise<BashScriptsResult> {
		const warnings: string[] = [];
		try {
			const discover = this.discovery === 'foldersChanged' || (this.discovery === 'initial' && await catalog.needsDiscovery());
			if (discover && catalog === this.catalog) await this.scan();
			if (catalog === this.catalog) this.discovery = 'ready';
		} catch (error) { warnings.push('Автопоиск: ' + String(error)); }
		const entries = await catalog.list((scope, error) => {
			const label = scope === 'global' ? 'Глобальные скрипты' : 'Проектные скрипты';
			warnings.push(label + ': ' + (error instanceof Error ? error.message : String(error)));
		}, true);
		const active = new Map<string, string[]>();
		for (const run of this.runs.values()) {
			if (!run.execution || run.ended) continue;
			const key = run.ref.scope + ':' + run.ref.id;
			active.set(key, [...(active.get(key) ?? []), run.id]);
		}
		// Один терминал представлен последним запуском. Новые терминалы идут первыми: строка показывает последний.
		const opened = new Map<string, string[]>();
		for (const { ref, runIds } of this.terminals.values()) {
			const key = ref.scope + ':' + ref.id;
			opened.set(key, [runIds[runIds.length - 1], ...(opened.get(key) ?? [])]);
		}
		for (const entry of entries) {
			entry.activeRunIds = active.get(entry.scope + ':' + entry.id);
			entry.terminalRunIds = opened.get(entry.scope + ':' + entry.id);
		}
		if (this.repositoryWarning) warnings.push(this.repositoryWarning);
		return { entries, warning: warnings.join('\n') || undefined };
	}

	async handleMessage(message: BashScriptsRequest, post: (message: BashScriptsResponse) => Promise<void>): Promise<void> {
		let response: BashScriptsResponse;
		try {
			const result = await this.apply(message);
			response = { type: 'bashScriptsResponse', requestId: message.requestId, result };
		} catch (error) {
			response = { type: 'bashScriptsResponse', requestId: message.requestId, error: error instanceof Error ? error.message : String(error) };
		}
		await post(response);
	}

	private async apply(message: BashScriptsRequest): Promise<BashScriptsResult> {
		if (!vscode.workspace.isTrusted) throw new Error('Для работы с Bash-скриптами нужна доверенная рабочая область.');
		const { action, ref } = message;
		if (action === 'list') return this.list();
		if (action === 'scan') {
			let warning: string | undefined;
			try { await this.scan(); }
			catch (error) { warning = 'Автопоиск: ' + String(error); }
			this.catalog.invalidateAvailability();
			this.notifySoon();
			const snapshot = await this.list();
			return warning ? { ...snapshot, warning: [warning, snapshot.warning].filter(Boolean).join('\n') } : snapshot;
		}
		if (action === 'choose') {
			const [file] = await vscode.window.showOpenDialog({ title: 'Выбрать Bash-скрипт', canSelectMany: false,
				canSelectFiles: true, canSelectFolders: false, filters: { 'Bash скрипты': ['sh', 'bash'] } }) ?? [];
			return file ? { path: file.fsPath } : {};
		}
		if (ref && (!ref.id || (ref.scope !== 'project' && ref.scope !== 'global'))) throw new Error('Выберите запись каталога.');
		if (action === 'showTerminal') {
			// Показ — явное действие пользователя: панель открывается, фокус переходит в терминал для ввода.
			const terminal = [...this.terminals].find(([, run]) => !!message.runId && run.runIds.includes(message.runId)
				&& run.ref.scope === ref?.scope && run.ref.id === ref.id)?.[0];
			if (!terminal) {
				this.invalidate();
				throw new Error('Терминал этого запуска уже закрыт.');
			}
			terminal.show();
			return {};
		}
		if (action === 'hide' || action === 'run') {
			if (!ref || !message.path) throw new Error('Выберите скрипт в актуальном списке.');
			try {
				if (action === 'hide') await this.catalog.hide(ref, message.path);
				else {
					const entry = await this.catalog.get(ref);
					if (entry.absolutePath !== message.path) {
						throw new Error('Путь скрипта изменился в другом окне. Проверьте обновлённую запись перед запуском.');
					}
					await this.run(entry);
				}
			} finally {
				// При отказе строка тоже получает новый путь или признак недоступности.
				this.invalidate();
			}
			return {};
		} else {
			const scope = ref?.scope ?? message.scope;
			if ((scope !== 'project' && scope !== 'global') || !message.path) throw new Error('Укажите область и путь скрипта.');
			const file = this.catalog.resolvePath(scope, message.path);
			if (action === 'copyPath') {
				// Буфер VS Code доступен и там, где браузер Tunnel запрещает webview запись в буфер обмена.
				if (message.pathKind !== 'relative' && message.pathKind !== 'absolute') throw new Error('Укажите вид пути.');
				const { absolutePath, relativePath } = this.catalog.describePath(scope, file);
				const text = message.pathKind === 'absolute' ? absolutePath : relativePath;
				if (!text) throw new Error('Файл находится вне проектов рабочей области, относительного пути нет.');
				await vscode.env.clipboard.writeText(text);
				return {};
			}
			if (action === 'read' || action === 'openFile') {
				const { content, revision, mode, nativeEditorReason } = await readBashScript(file);
				if (action === 'openFile') {
					if (mode === undefined) throw new Error('Файл отсутствует.');
					await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
					return {};
				}
				// Файл читается по выбранному пути. Для прежней привязки сохраняем её форму пути из каталога.
				const basePath = message.base?.path;
				const samePath = ref && basePath && basePath !== message.path
					&& (path.isAbsolute(basePath) || vscode.workspace.workspaceFolders?.length)
					&& path.relative(this.catalog.resolvePath(scope, basePath), file) === '';
				return { path: samePath ? basePath : message.path, content, revision, exists: mode !== undefined, nativeEditorReason,
					...this.catalog.describePath(scope, file) };
			}
			if (action !== 'save' || !message.name?.trim() || typeof message.content !== 'string' || !message.revision) {
				throw new Error('Укажите название и загрузите файл перед сохранением.');
			}
			const { content, revision } = message;
			const write = () => saveBashScript(file, content, revision, () => vscode.workspace.textDocuments
				.filter(document => document.isDirty && document.uri.fsPath).map(document => document.uri.fsPath), !ref);
			if (ref) {
				if (!message.base) throw new Error('Откройте редактор записи повторно.');
				await this.catalog.edit(ref, message.name, message.path, message.base, write);
			} else await this.catalog.register(scope, message.name, message.path, write);
		}
		this.invalidate();
		return {};
	}

	/**
	 * Повторный запуск идёт в свободный терминал этого же скрипта, иначе создаётся новый со своими вводом и выводом.
	 * Терминал создаётся в нижней панели без show(): VS Code не открывает панель и не переключает вкладки,
	 * поэтому «Обзор» и фокус остаются на месте. Вкладка редактора так не умеет: она всегда становится видимой.
	 */
	private async run(entry: BashScriptEntry): Promise<void> {
		if (!entry.available || !/\.(?:sh|bash)$/i.test(entry.absolutePath)) throw new Error('Файл Bash-скрипта недоступен.');
		const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(entry.absolutePath));
		const cwd = folder?.uri.fsPath ?? path.dirname(entry.absolutePath);
		// Для внешнего файла панель получает рабочую папку окна, в котором нажали кнопку.
		const panelCwd = folder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? cwd;
		const ref = { scope: entry.scope, id: entry.id };
		const reused = this.idleTerminal(ref, entry.absolutePath, cwd, panelCwd);
		const id = randomUUID();
		const previousRuns = reused && this.terminals.get(reused)?.runIds;
		const session = previousRuns?.[0] ?? id;
		// Оболочка принимает номер один раз. Ручной повтор старой строки лишь исполняет файл.
		const run: TerminalRun = { ref, id, catalog: this.catalog, startRecorded: false,
			command: `. "$PROMPT_MANAGER_BASH_LAUNCHER" ${session} ${(previousRuns?.length ?? 0) + 1}` };
		const terminal = reused ?? vscode.window.createTerminal({ name: 'Bash · ' + entry.name, location: vscode.TerminalLocation.Panel,
			cwd, shellPath: 'bash', env: { PROMPT_MANAGER_BASH_SCRIPT: entry.absolutePath, PROMPT_MANAGER_BASH_CWD: cwd,
				PROMPT_MANAGER_BASH_LAUNCHER: this.launcherPath, PROMPT_MANAGER_BASH_SESSION: session, PROMPT_MANAGER_BASH_LAST: '0',
				PROMPT_MANAGER_BASH_PANEL_CWD: panelCwd } });
		this.runs.set(terminal, run);
		let startedAt: string;
		try {
			if (terminal.exitStatus) throw new Error('Не удалось открыть терминал Bash.');
			// Без интеграции оболочки ту же команду и отправку результата выполняет обычный Bash.
			const integration = terminal.shellIntegration ?? await this.waitForIntegration(terminal);
			if (terminal.exitStatus || !this.runs.has(terminal)) throw new Error('Терминал Bash закрыт до запуска.');
			startedAt = new Date().toISOString();
			if (integration) run.execution = integration.executeCommand(run.command);
			else terminal.sendText(run.command);
		} catch (error) {
			this.runs.delete(terminal);
			// Терминал с выводом прошлых запусков остаётся у пользователя, закрывается только созданный сейчас.
			if (!reused) terminal.dispose();
			throw error;
		}
		// Команда отправлена: терминал можно показать, даже если историю не удастся записать.
		// Повторно использованный терминал переносится в конец, чтобы строка показывала его как последний.
		const shell = this.terminals.get(terminal) ?? { ref: run.ref, runIds: [], scriptPath: entry.absolutePath, cwd, panelCwd, executing: false };
		this.terminals.delete(terminal);
		shell.runIds.push(run.id);
		// Мгновенная команда могла завершиться до этой строки: тогда оболочка уже свободна.
		shell.executing = !run.ended;
		this.terminals.set(terminal, shell);
		try {
			await run.catalog.recordRun(run.ref, { id: run.id, startedAt });
			run.startRecorded = true;
		} catch (error) {
			this.runs.delete(terminal);
			void vscode.window.showWarningMessage('Скрипт отправлен в терминал. Не удалось записать запуск в историю: ' + String(error));
			return;
		}
		if (run.ended) await this.saveCompletion(run, run.ended);
	}

	/**
	 * Последний открытый терминал скрипта, в который безопасно отправить команду. Подходит только терминал
	 * с интеграцией оболочки, подтверждённым окончанием прошлой команды и тем же файлом и рабочей папкой.
	 * Без интеграции занятость неизвестна, а VS Code перед командой посылает Ctrl+C и прервал бы работающую программу.
	 */
	private idleTerminal(ref: BashScriptRef, scriptPath: string, cwd: string, panelCwd: string): vscode.Terminal | undefined {
		let found: vscode.Terminal | undefined;
		for (const [terminal, shell] of this.terminals) {
			if (shell.ref.scope === ref.scope && shell.ref.id === ref.id && shell.scriptPath === scriptPath && shell.cwd === cwd && shell.panelCwd === panelCwd
				&& !shell.executing && !this.runs.has(terminal) && !terminal.exitStatus && terminal.shellIntegration) found = terminal;
		}
		return found;
	}

	private waitForIntegration(terminal: vscode.Terminal): Promise<vscode.TerminalShellIntegration | undefined> {
		return new Promise(resolve => {
			const done = () => {
				clearTimeout(timer);
				ready.dispose();
				close.dispose();
				resolve(terminal.shellIntegration);
			};
			const ready = vscode.window.onDidChangeTerminalShellIntegration(e => { if (e.terminal === terminal) done(); });
			const close = vscode.window.onDidCloseTerminal(t => { if (t === terminal) done(); });
			const timer = setTimeout(done, 1500);
		});
	}

	/** Различает окончание команды и закрытие терминала после отправки команды. */
	private finish(terminal: vscode.Terminal, by: 'shell' | 'terminal', code?: number): void {
		const run = this.runs.get(terminal);
		if (!run) return;
		this.runs.delete(terminal);
		run.ended = { at: new Date().toISOString(), code, by };
		// Быстрая команда может завершиться, пока каталог ещё сохраняет её старт.
		if (run.startRecorded) void this.saveCompletion(run, run.ended);
	}

	private async saveCompletion(run: TerminalRun, ended: NonNullable<TerminalRun['ended']>): Promise<void> {
		try {
			await run.catalog.finishRun(run.ref, run.id, ended.at, ended.code, ended.by);
		} catch (error) {
			void vscode.window.showWarningMessage('Не удалось сохранить результат запуска Bash: ' + String(error));
		} finally {
			this.invalidate();
		}
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.notifyTimer);
		this.subscriptions.forEach(subscription => subscription.dispose());
		this.runs.clear();
		this.terminals.clear();
	}
}
