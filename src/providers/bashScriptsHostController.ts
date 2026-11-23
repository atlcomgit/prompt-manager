import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BashScriptsService, BASH_SCRIPTS_FILE } from '../services/bashScriptsService.js';
import { readBashScript, saveBashScript } from '../services/bashScriptFile.js';
import type { BashScriptEntry, BashScriptRef, BashScriptsRequest, BashScriptsResponse, BashScriptsResult } from '../types/bashScripts.js';

/** Исключения относятся только к автодобавлению. В этих папках файл можно выбрать вручную. */
const AUTO_EXCLUDE = '{**/.git/**,**/node_modules/**,**/vendor/**,**/.venv/**,**/dist/**,**/build/**,**/out/**,**/out-tests/**,**/.vscode/prompt-manager/**}';
const RUN_COMMAND = 'bash -- "$PROMPT_MANAGER_BASH_SCRIPT"';
const AVAILABILITY_KEY = 'bashScripts.availability.v1';

/** Связывает события оболочки и вкладки с одной командой, пока сохраняется начало её запуска. */
interface TerminalRun {
	ref: BashScriptRef;
	id: string;
	catalog: BashScriptsService;
	execution?: vscode.TerminalShellExecution;
	startRecorded: boolean;
	ended?: { at: string; code?: number; by: 'shell' | 'terminal' };
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
	private repositoryRoots: string[] = [];
	private repositoriesReady?: Promise<void>;
	private disposed = false;

	constructor(private readonly globalDir: string, private readonly projectDir: string, private readonly changed: () => void,
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
				const run = this.runs.get(terminal);
				if (run && !run.execution && execution.commandLine.value === RUN_COMMAND) {
					run.execution = execution;
					if (run.startRecorded) this.invalidate();
				}
			}),
			vscode.window.onDidEndTerminalShellExecution(event => {
				const run = this.runs.get(event.terminal);
				if (run && (run.execution === event.execution ||
					(!run.execution && event.execution.commandLine.value === RUN_COMMAND))) {
					this.finish(event.terminal, 'shell', event.exitCode);
				}
			}),
			vscode.window.onDidCloseTerminal(terminal => this.finish(terminal, 'terminal')),
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
		for (const entry of entries) entry.activeRunIds = active.get(entry.scope + ':' + entry.id);
		if (this.repositoryWarning) warnings.push(this.repositoryWarning);
		return { entries, warning: warnings.join('\n') || undefined };
	}

	async handleMessage(message: BashScriptsRequest, post: (message: BashScriptsResponse) => Promise<void>, panel?: vscode.WebviewPanel): Promise<void> {
		let response: BashScriptsResponse;
		try {
			const result = await this.apply(message, panel);
			response = { type: 'bashScriptsResponse', requestId: message.requestId, result };
		} catch (error) {
			response = { type: 'bashScriptsResponse', requestId: message.requestId, error: error instanceof Error ? error.message : String(error) };
		}
		await post(response);
	}

	private async apply(message: BashScriptsRequest, panel?: vscode.WebviewPanel): Promise<BashScriptsResult> {
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
		if (action === 'hide' || action === 'run') {
			if (!ref || !message.path) throw new Error('Выберите скрипт в актуальном списке.');
			try {
				if (action === 'hide') await this.catalog.hide(ref, message.path);
				else {
					const entry = await this.catalog.get(ref);
					if (entry.absolutePath !== message.path) {
						throw new Error('Путь скрипта изменился в другом окне. Проверьте обновлённую запись перед запуском.');
					}
					await this.run(entry, panel);
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
				return { path: samePath ? basePath : message.path, content, revision, exists: mode !== undefined, nativeEditorReason };
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

	/** В одной группе VS Code может выбрать новую вкладку даже с preserveFocus. Возвращаем только панель запуска. */
	private keepLauncherVisible(panel: vscode.WebviewPanel, terminalName: string): void {
		const tabs = vscode.window.tabGroups;
		const group = tabs.activeTabGroup;
		const original = group.activeTab;
		if (!panel.active || group.viewColumn !== panel.viewColumn || !original) return;
		let created: vscode.Tab | undefined;
		let timeout: ReturnType<typeof setTimeout>;
		const opened = tabs.onDidChangeTabs(event => {
			const active = group.activeTab;
			created ??= event.opened.find(tab => tab.group === group
				&& tab.input instanceof vscode.TabInputTerminal && tab.label === terminalName);
			if (created && event.opened.includes(created)) {
				// Открытие и выбор приходят соседними событиями. Поздний ручной щелчок уже принадлежит пользователю.
				clearTimeout(timeout);
				timeout = setTimeout(done, 150);
			}
			if (group.isActive && group.tabs.includes(original) && (!active || active === original)) return;
			done();
			if (created && active === created && group.isActive && group.tabs.includes(original)) {
				panel.reveal(group.viewColumn, true);
			}
		});
		const closed = panel.onDidDispose(() => done());
		timeout = setTimeout(done, 5000);
		function done() { opened.dispose(); closed.dispose(); clearTimeout(timeout); }
	}

	/** У отдельной вкладки есть собственные ввод и вывод даже при одновременном запуске одного файла. */
	private async run(entry: BashScriptEntry, panel?: vscode.WebviewPanel): Promise<void> {
		if (!entry.available || !/\.(?:sh|bash)$/i.test(entry.absolutePath)) throw new Error('Файл Bash-скрипта недоступен.');
		const run: TerminalRun = { ref: { scope: entry.scope, id: entry.id }, id: randomUUID(),
			catalog: this.catalog, startRecorded: false };
		const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(entry.absolutePath));
		const name = 'Bash · ' + entry.name;
		if (panel?.active) this.keepLauncherVisible(panel, name);
		const terminal = vscode.window.createTerminal({ name,
			location: { viewColumn: panel?.viewColumn ?? vscode.ViewColumn.Active, preserveFocus: true },
			cwd: folder?.uri.fsPath ?? path.dirname(entry.absolutePath), shellPath: 'bash',
			env: { PROMPT_MANAGER_BASH_SCRIPT: entry.absolutePath } });
		this.runs.set(terminal, run);
		let startedAt: string;
		try {
			if (terminal.exitStatus) throw new Error('Не удалось открыть терминал Bash.');
			// Ждём интеграцию только своей новой вкладки. При её отсутствии Bash принимает ту же постоянную команду.
			const integration = terminal.shellIntegration ?? await this.waitForIntegration(terminal);
			if (terminal.exitStatus || !this.runs.has(terminal)) throw new Error('Терминал Bash закрыт до запуска.');
			startedAt = new Date().toISOString();
			if (integration) run.execution = integration.executeCommand(RUN_COMMAND);
			else terminal.sendText(RUN_COMMAND);
		} catch (error) {
			this.runs.delete(terminal);
			terminal.dispose();
			throw error;
		}
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

	/** Различает окончание команды и закрытие вкладки после отправки команды. */
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
	}
}
