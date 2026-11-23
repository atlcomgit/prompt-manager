import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import Module from 'node:module';
import type { BashScriptsRequest, BashScriptsResponse } from '../src/types/bashScripts.js';
import { BashScriptsService } from '../src/services/bashScriptsService.js';
import { readBashScript, saveBashScript } from '../src/services/bashScriptFile.js';

/** Каждый сценарий получает собственный контракт VS Code, не открывая реальный редактор. */
function loadController(vscode: unknown): typeof import('../src/providers/bashScriptsHostController.js').BashScriptsHostController {
	const moduleId = require.resolve('../src/providers/bashScriptsHostController.js');
	const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
	const original = loader._load;
	const cached = require.cache[moduleId];
	delete require.cache[moduleId];
	loader._load = function(name, ...args) { return name === 'vscode' ? vscode : original.call(this, name, ...args); };
	try {
		return require(moduleId).BashScriptsHostController;
	} finally {
		loader._load = original;
		if (cached) require.cache[moduleId] = cached;
		else delete require.cache[moduleId];
	}
}

/** Реальные файлы проверяют конфликт редактирования, биты исполнения, ссылку и окончания строк. */
test('Bash editor saves the selected version, preserves permissions and refuses stale or dirty files', async t => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bash-edit-'));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	const file = path.join(dir, 'original.sh');
	const link = path.join(dir, 'linked.sh');
	await fs.writeFile(file, '#!/bin/bash\r\nexit 0\r\n', { mode: 0o700 });
	await fs.symlink(file, link);
	const first = await readBashScript(link);
	// Для регистрации готового скрипта требуется только чтение, даже когда блокировка файла занята редактором.
	await fs.mkdir(file + '.lock');
	await saveBashScript(link, first.content, first.revision, () => []);
	await fs.rmdir(file + '.lock');
	await assert.rejects(saveBashScript(link, 'exit 2', first.revision, () => [file]), /несохранённые/);
	await saveBashScript(link, '#!/bin/bash\nexit 1\n', first.revision, () => []);
	assert.equal(await fs.readFile(file, 'utf8'), '#!/bin/bash\r\nexit 1\r\n');
	assert.equal((await fs.stat(file)).mode & 0o777, 0o700);
	assert.ok((await fs.lstat(link)).isSymbolicLink());
	await assert.rejects(saveBashScript(link, 'old', first.revision, () => []), /изменился/);
	const newFile = path.join(dir, 'new.bash');
	const missing = await readBashScript(newFile);
	await fs.writeFile(newFile, 'newer');
	await assert.rejects(saveBashScript(newFile, 'mine', missing.revision, () => []), /изменился/);
	await fs.unlink(newFile);
	await saveBashScript(newFile, 'exit 0', missing.revision, () => []);
	assert.equal(await fs.readFile(newFile, 'utf8'), 'exit 0');
	await assert.rejects(readBashScript(path.join(dir, 'file.json')), /расширением/);
	await fs.writeFile(newFile, Buffer.from([0xff, 0x00]));
	const native = await readBashScript(newFile);
	assert.match(native.nativeEditorReason!, /кодировки/);
	await saveBashScript(newFile, '', native.revision, () => []);
	assert.deepEqual(await fs.readFile(newFile), Buffer.from([0xff, 0x00]));
	await fs.truncate(newFile, 1024 * 1024 + 1);
	assert.match((await readBashScript(newFile)).nativeEditorReason!, /1 МиБ/);
});

test('Список и поиск получают актуальные корни Git и имена рабочих папок без повторного обхода файлов', async t => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bash-projects-'));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	const nested = path.join(dir, 'packages', 'backend');
	const file = path.join(nested, 'check.sh');
	await fs.mkdir(nested, { recursive: true });
	await fs.writeFile(file, 'exit 0');
	const disposable = { dispose() {} };
	const subscribe = () => disposable;
	let scans = 0;
	let gitRequests = 0;
	let workspaceChanged = () => {};
	let opened = () => {};
	let closed = () => {};
	const folder = { uri: { fsPath: dir }, name: 'Общий проект' };
	const workspace = { isTrusted: true, workspaceFolders: [folder],
		onDidChangeWorkspaceFolders: (listener: () => void) => { workspaceChanged = listener; return disposable; },
		createFileSystemWatcher: () => ({ ...disposable, onDidCreate: subscribe, onDidChange: subscribe, onDidDelete: subscribe }),
		findFiles: async () => { scans++; return [{ fsPath: file }]; },
	};
	const git = { repositories: [{ rootUri: { fsPath: dir } }, { rootUri: { fsPath: nested } }],
		onDidOpenRepository: (listener: () => void) => { opened = listener; return disposable; },
		onDidCloseRepository: (listener: () => void) => { closed = listener; return disposable; },
	};
	const Controller = loadController({ workspace, Uri: { file: (fsPath: string) => ({ fsPath }) }, RelativePattern: class {},
		window: { onDidChangeWindowState: subscribe, onDidStartTerminalShellExecution: subscribe, onDidEndTerminalShellExecution: subscribe, onDidCloseTerminal: subscribe } });
	let notifyPanel!: () => void;
	const panelChanged = new Promise<void>(resolve => { notifyPanel = resolve; });
	const host = new Controller(path.join(dir, 'global'), path.join(dir, 'project'), notifyPanel, async () => {
		gitRequests++;
		if (gitRequests === 1) throw new Error('Git ещё не готов');
		return git;
	});
	t.after(() => host.dispose());
	async function request(action: 'list' | 'scan') {
		let response: BashScriptsResponse | undefined;
		await host.handleMessage({ type: 'bashScriptsRequest', requestId: action, action }, async message => { response = message; });
		assert.equal(response?.error, undefined);
		return response!.result!;
	}
	const outer = { root: dir, name: folder.name, relativePath: 'packages/backend/check.sh' };
	const inner = { root: nested, name: 'backend', relativePath: 'check.sh' };
	assert.equal(gitRequests, 0);
	const initial = await request('list');
	assert.match(initial.warning!, /Git ещё не готов/);
	assert.deepEqual(initial.entries![0].project, outer);
	const discovered = await request('list');
	assert.equal(discovered.warning, undefined);
	assert.deepEqual(discovered.entries![0].project, inner);
	git.repositories.pop();
	closed();
	await panelChanged;
	assert.deepEqual((await request('list')).entries![0].project, outer);
	git.repositories.push({ rootUri: { fsPath: nested } });
	opened();
	assert.deepEqual((await request('list')).entries![0].project, inner);
	assert.equal(scans, 1);
	workspace.workspaceFolders.push({ uri: { fsPath: nested }, name: 'Сервер' });
	workspaceChanged();
	const searched = await request('scan');
	assert.equal(searched.entries![0].id, initial.entries![0].id);
	assert.deepEqual(searched.entries![0].project, { ...inner, name: 'Сервер' });
	assert.equal(scans, 2);
	assert.equal(gitRequests, 2);
	await t.test('Чтение по абсолютному пути сохраняет исходный относительный путь, пока он ведёт к выбранному файлу', async () => {
		const entry = initial.entries![0];
		async function readPicked() {
			let response: BashScriptsResponse | undefined;
			await host.handleMessage({ type: 'bashScriptsRequest', requestId: 'picked', action: 'read',
				ref: { scope: entry.scope, id: entry.id }, path: file, base: { path: entry.path, name: entry.name },
			}, async message => { response = message; });
			assert.equal(response?.error, undefined);
			assert.equal(response?.result?.content, 'exit 0');
			return response?.result?.path;
		}
		assert.equal(await readPicked(), entry.path);
		workspace.workspaceFolders.reverse();
		workspaceChanged();
		const otherFile = path.resolve(nested, entry.path);
		await fs.mkdir(path.dirname(otherFile), { recursive: true });
		await fs.writeFile(otherFile, 'echo other');
		assert.equal(await readPicked(), file);
	});
});

/** Контракт терминала VS Code исполняется настоящим Bash с теми же командой, путём и окружением. */
test('Bash host scans lazily and starts an isolated editor terminal with the actual Bash exit code', async t => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bash-host-'));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	const root = path.join(dir, 'workspace');
	await fs.mkdir(root);
	const file = path.join(root, "a b'\u0024(x).sh");
	await fs.writeFile(file, 'printf "%s" "$PWD"\nexit 7\n');
	const disposable = { dispose() {} };
	const subscribe = () => disposable;
	let found = 0;
	let shown = 0;
	let changed = 0;
	let fileDeleted = (_uri: { fsPath: string }) => {};
	let commandOutput = '';
	let terminalOptions: { location: { viewColumn: number; preserveFocus: boolean }; cwd: string; shellPath: string; env: Record<string, string> } | undefined;
	type TerminalEvent = { terminal: unknown; execution: unknown; exitCode: number };
	let end = (_event: TerminalEvent) => {};
	const vscode = {
		Uri: { file: (fsPath: string) => ({ fsPath }) }, RelativePattern: class {}, ViewColumn: { Active: -1 },
		workspace: { workspaceFolders: [{ uri: { fsPath: root } }], textDocuments: [], isTrusted: true,
			onDidChangeWorkspaceFolders: subscribe,
			createFileSystemWatcher: (pattern: unknown) => ({ ...disposable, onDidCreate: subscribe, onDidChange: subscribe,
				onDidDelete: (callback: typeof fileDeleted) => {
					if (pattern === '**/*.{sh,bash}') fileDeleted = callback;
					return disposable;
				} }),
			findFiles: async (include: string, exclude: string) => {
				found++; assert.equal(include, '**/*.{sh,bash}'); assert.match(exclude, /node_modules/); return [{ fsPath: file }];
			},
			getWorkspaceFolder: () => ({ uri: { fsPath: root } }),
		},
		window: { onDidChangeWindowState: subscribe, onDidStartTerminalShellExecution: subscribe, onDidCloseTerminal: subscribe,
			onDidEndTerminalShellExecution: (listener: typeof end) => { end = listener; return disposable; },
			createTerminal: (options: NonNullable<typeof terminalOptions>) => {
				terminalOptions = options;
				const terminal = { ...disposable, show: () => { shown++; }, shellIntegration: {
					executeCommand: (command: string) => {
						const execution = { commandLine: { value: command } };
						execFile(options.shellPath, ['-c', command], { cwd: options.cwd, env: { ...process.env, ...options.env } },
							(error, stdout) => {
								commandOutput = stdout;
								end({ terminal, execution, exitCode: Number(error?.code ?? 0) });
							});
						return execution;
					},
				} };
				return terminal;
			},
		},
	};
	const Controller = loadController(vscode);
	const host = new Controller(path.join(dir, 'global'), path.join(root, '.metadata'), () => { changed++; });
	t.after(() => host.dispose());
	async function request(data: Omit<BashScriptsRequest, 'type' | 'requestId'>) {
		let response: BashScriptsResponse | undefined;
		await host.handleMessage({ type: 'bashScriptsRequest', requestId: 'r', ...data }, async message => { response = message; });
		return response!;
	}
	assert.equal(found, 0);
	const entry = (await request({ action: 'list' })).result!.entries![0];
	assert.equal((await request({ action: 'list' })).result!.entries!.length, 1);
	assert.equal(found, 1);
	assert.equal(entry.absolutePath, file);
	const ref = { scope: entry.scope, id: entry.id };
	vscode.workspace.isTrusted = false;
	assert.match((await request({ action: 'run', ref, path: file })).error!, /доверенная/);
	assert.equal(shown, 0);
	vscode.workspace.isTrusted = true;
	assert.match((await request({ action: 'run', ref, path: path.join(root, 'previous.sh') })).error!, /изменился/);
	assert.equal(shown, 0);
	changed = 0;
	assert.equal((await request({ action: 'run', ref, path: file })).error, undefined);
	assert.equal(shown, 0);
	assert.deepEqual(terminalOptions?.location, { viewColumn: vscode.ViewColumn.Active, preserveFocus: true });
	for (let i = 0; i < 200 && changed < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(commandOutput, root);
	const history = (await request({ action: 'list' })).result!.entries![0].history;
	assert.equal(history.length, 1);
	assert.equal(history[0].exitCode, 7);
	assert.equal(history[0].endedBy, 'shell');
	assert.ok(history[0].finishedAt);
	await fs.unlink(file);
	const beforeDeletion = changed;
	fileDeleted({ fsPath: file });
	for (let i = 0; i < 100 && changed === beforeDeletion; i++) await new Promise(resolve => setTimeout(resolve, 10));
	assert.ok(changed > beforeDeletion);
	const beforeMissingRun = changed;
	assert.match((await request({ action: 'run', ref, path: file })).error!, /недоступен/);
	assert.ok(changed > beforeMissingRun);
	assert.equal((await request({ action: 'list' })).result!.entries![0].available, false);
	const missing = (await request({ action: 'read', ref, path: entry.path })).result!;
	assert.equal(missing.exists, false);
	const rename = await request({ action: 'save', ref, path: entry.path, name: 'Проверка', content: '',
		revision: missing.revision, base: { name: entry.name, path: entry.path } });
	assert.equal(rename.error, undefined);
	assert.equal((await request({ action: 'list' })).result!.entries![0].available, false);
	await assert.rejects(fs.stat(file), { code: 'ENOENT' });
	assert.equal(shown, 0);
	assert.ok((await request({ action: 'hide', ref, path: path.join(root, 'old.sh') })).error);
	assert.equal((await request({ action: 'list' })).result!.entries!.length, 1);
	assert.equal((await request({ action: 'hide', ref, path: file })).error, undefined);
	assert.deepEqual((await request({ action: 'scan' })).result!.entries, []);
	// Повреждённый каталог проекта не лишает пользователя глобального скрипта и его истории.
	const globalFile = path.join(dir, 'global.sh');
	await fs.writeFile(globalFile, 'exit 0');
	const globalRead = (await request({ action: 'read', scope: 'global', path: globalFile })).result!;
	assert.equal((await request({ action: 'save', scope: 'global', path: globalFile, name: 'Общий',
		content: globalRead.content, revision: globalRead.revision })).error, undefined);
	await fs.writeFile(path.join(root, '.metadata', 'bash-scripts.json'), '{');
	const partial = (await request({ action: 'scan' })).result!;
	assert.match(partial.warning!, /Проектные скрипты/);
	assert.deepEqual(partial.entries!.map(item => item.scope), ['global']);

	// Одна и та же ссылка доступна для ручной регистрации, редактирования и выполнения настоящим Bash.
	const target = path.join(root, 'tool');
	const alias = path.join(root, 'tool.sh');
	await fs.writeFile(target, '#!/bin/bash\nexit 1\n');
	await fs.symlink(target, alias);
	const viaLink = (await request({ action: 'read', scope: 'global', path: alias })).result!;
	assert.equal((await request({ action: 'save', scope: 'global', path: alias, name: 'Инструмент',
		content: viaLink.content, revision: viaLink.revision })).error, undefined);
	const tool = (await request({ action: 'list' })).result!.entries!.find(script => script.absolutePath === alias)!;
	assert.equal(tool.available, true);
	const edited = '#!/usr/bin/env bash\nexit 8\n';
	assert.equal((await request({ action: 'save', ref: tool, base: { name: tool.name, path: tool.path }, path: alias,
		name: tool.name, content: edited, revision: viaLink.revision })).error, undefined);
	assert.equal(await fs.readFile(target, 'utf8'), edited);
	assert.equal((await request({ action: 'run', ref: tool, path: alias })).error, undefined);
	const globalCatalog = new BashScriptsService({ globalStorageDir: path.join(dir, 'global'), workspaceRoots: [root] });
	for (let i = 0; i < 200 && !(await globalCatalog.get(tool)).history[0]?.finishedAt; i++) {
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	assert.equal((await globalCatalog.get(tool)).history[0].exitCode, 8);
});

/** Отказ открытия, короткая команда и недоступная история имеют разные пользовательские результаты. */
test('Bash history follows a dispatched command even with an immediate exit or a failing history store', async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bash-history-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const file = path.join(root, 'ok.sh');
	await fs.writeFile(file, 'exit 0');
	const projectDir = path.join(root, 'project');
	const globalDir = path.join(root, 'global');
	const catalog = new BashScriptsService({ workspaceRoots: [root], projectStorageDir: projectDir, globalStorageDir: globalDir });
	const ref = await catalog.register('project', 'Проверка', file);
	const disposable = { dispose() {} };
	const subscribe = () => disposable;
	type EndEvent = { terminal: unknown; execution: unknown; exitCode?: number };
	let end = (_event: EndEvent) => {};
	let started = (_event: EndEvent) => {};
	const closeListeners = new Set<(terminal: unknown) => void>();
	let lastTerminal: unknown;
	const shown: number[] = [];
	const warnings: string[] = [];
	let mode: 'closed' | 'rejected' | 'instant' | 'no-code' | 'plain' = 'closed';
	let dispatched = 0;
	const Controller = loadController({
		Uri: { file: (fsPath: string) => ({ fsPath }) }, RelativePattern: class {}, ViewColumn: { Active: -1 },
		workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: root } }], getWorkspaceFolder: () => ({ uri: { fsPath: root } }),
			onDidChangeWorkspaceFolders: subscribe, createFileSystemWatcher: () => ({
				...disposable, onDidCreate: subscribe, onDidChange: subscribe, onDidDelete: subscribe,
			}) },
		window: { onDidChangeWindowState: subscribe, onDidChangeTerminalShellIntegration: subscribe,
			onDidStartTerminalShellExecution: (listener: typeof started) => { started = listener; return disposable; },
			onDidCloseTerminal: (listener: (terminal: unknown) => void) => {
				closeListeners.add(listener);
				return { dispose: () => closeListeners.delete(listener) };
			},
			onDidEndTerminalShellExecution: (listener: typeof end) => { end = listener; return disposable; },
			showWarningMessage: (message: string) => { warnings.push(message); },
			createTerminal: () => {
				const terminal = { ...disposable, exitStatus: mode === 'closed' ? { code: 1 } : undefined,
					show: () => shown.push(dispatched), sendText: (value: string) => {
						assert.equal(value, 'bash -- "$PROMPT_MANAGER_BASH_SCRIPT"');
						dispatched++;
					}, shellIntegration: mode === 'plain' ? undefined : { executeCommand(value: string) {
						if (mode === 'rejected') throw new Error('Команда отклонена терминалом');
						dispatched++;
						const execution = { commandLine: { value } };
						end({ terminal, execution, exitCode: mode === 'no-code' ? undefined : 9 });
						return execution;
					} } };
				lastTerminal = terminal;
				return terminal;
			} },
	});
	const host = new Controller(globalDir, projectDir, () => {});
	t.after(() => host.dispose());
	const run = async () => {
		let response: BashScriptsResponse | undefined;
		await host.handleMessage({ type: 'bashScriptsRequest', action: 'run', ref, path: file, requestId: 'r' },
			async message => { response = message; });
		return response!;
	};
	assert.match((await run()).error!, /открыть терминал/);
	mode = 'rejected';
	assert.match((await run()).error!, /Команда отклонена/);
	assert.equal(dispatched, 0);
	assert.deepEqual((await catalog.get(ref)).history, []);

	mode = 'instant';
	assert.equal((await run()).error, undefined);
	const history = (await catalog.get(ref)).history;
	assert.equal(history.length, 1);
	assert.equal(history[0].exitCode, 9);
	assert.equal(history[0].endedBy, 'shell');
	assert.ok(history[0].startedAt <= history[0].finishedAt!);

	mode = 'no-code';
	assert.equal((await run()).error, undefined);
	const noCode = (await catalog.get(ref)).history[0];
	assert.equal(noCode.endedBy, 'shell');
	assert.equal(noCode.exitCode, undefined);
	assert.ok(noCode.finishedAt);

	mode = 'plain';
	assert.equal((await run()).error, undefined);
	const unfinished = (await catalog.get(ref)).history[0];
	assert.equal(unfinished.finishedAt, undefined);
	const activeIds = async () => {
		let list: BashScriptsResponse | undefined;
		await host.handleMessage({ type: 'bashScriptsRequest', action: 'list', requestId: 'live' }, async response => { list = response; });
		return list!.result!.entries![0].activeRunIds;
	};
	assert.equal(await activeIds(), undefined);
	started({ terminal: lastTerminal, execution: { commandLine: { value: 'bash -- "$PROMPT_MANAGER_BASH_SCRIPT"' } } });
	assert.deepEqual(await activeIds(), [unfinished.id]);
	closeListeners.forEach(listener => listener(lastTerminal));
	for (let i = 0; i < 200 && !(await catalog.get(ref)).history[0].finishedAt; i++) {
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	const plainHistory = (await catalog.get(ref)).history;
	assert.equal(plainHistory.length, 3);
	assert.equal(plainHistory[0].endedBy, 'terminal');
	assert.equal(plainHistory[0].exitCode, undefined);

	// Ошибка файловой системы после отправки не отменяет команду и не вызывает повторный запуск.
	mode = 'instant';
	t.mock.method(BashScriptsService.prototype, 'recordRun', async () => { throw new Error('EACCES'); });
	assert.equal((await run()).error, undefined);
	assert.equal(dispatched, 4);
	assert.deepEqual(shown, []);
	assert.deepEqual((await catalog.get(ref)).history, plainHistory);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /отправлен.*историю.*EACCES/);
});

/** Панель получает фактические запуски даже после смены рабочих папок и ошибки записи результата. */
test('Active shell runs survive workspace folder changes and clear after completion or a failed history write', { timeout: 10000 }, async t => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bash-active-'));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	const file = path.join(dir, 'check.sh');
	await fs.writeFile(file, 'exit 0');
	const folder = { name: 'Проект', uri: { fsPath: dir } };
	const disposable = { dispose() {} };
	const subscribe = () => disposable;
	let foldersChanged = () => {};
	let shellEnded = (_event: { terminal: unknown; execution: unknown; exitCode: number }) => {};
	let terminate: (exitCode: number) => void = () => { assert.fail('Скрипт ещё не запущен'); };
	let panelChanged = () => {};
	const warnings: string[] = [];
	const workspace = {
		isTrusted: true, workspaceFolders: [folder], getWorkspaceFolder: () => folder,
		findFiles: async () => [{ fsPath: file }],
		onDidChangeWorkspaceFolders: (listener: () => void) => { foldersChanged = listener; return disposable; },
		createFileSystemWatcher: () => ({ ...disposable, onDidCreate: subscribe, onDidChange: subscribe, onDidDelete: subscribe }),
	};
	const Controller = loadController({
		workspace, Uri: { file: (fsPath: string) => ({ fsPath }) }, RelativePattern: class {}, ViewColumn: { Active: -1 },
		window: {
			onDidChangeWindowState: subscribe, onDidStartTerminalShellExecution: subscribe, onDidCloseTerminal: subscribe,
			onDidEndTerminalShellExecution: (listener: typeof shellEnded) => { shellEnded = listener; return disposable; },
			showWarningMessage: (message: string) => { warnings.push(message); },
			createTerminal: () => {
				const terminal = { ...disposable, shellIntegration: { executeCommand(value: string) {
					const execution = { commandLine: { value } };
					terminate = exitCode => shellEnded({ terminal, execution, exitCode });
					return execution;
				} } };
				return terminal;
			},
		},
	});
	const host = new Controller(path.join(dir, 'global'), path.join(dir, 'metadata'), () => panelChanged());
	t.after(() => host.dispose());
	async function request(data: Omit<BashScriptsRequest, 'requestId' | 'type'>) {
		let response: BashScriptsResponse | undefined;
		await host.handleMessage({ type: 'bashScriptsRequest', requestId: 'active', ...data }, async value => { response = value; });
		assert.equal(response?.error, undefined);
		return response!.result!;
	}
	const readEntry = async () => (await request({ action: 'list' })).entries![0];
	const entry = await readEntry();
	const start = async () => {
		await request({ action: 'run', ref: { scope: entry.scope, id: entry.id }, path: file });
		const active = await readEntry();
		const run = active.history[0];
		assert.equal(run.finishedAt, undefined);
		assert.deepEqual(active.activeRunIds, [run.id]);
		return run.id;
	};
	const finish = async (exitCode: number) => {
		const changed = new Promise<void>(resolve => { panelChanged = resolve; });
		terminate(exitCode);
		await changed;
		return readEntry();
	};
	const first = await start();
	workspace.workspaceFolders.push({ name: 'Вторая папка', uri: { fsPath: path.join(dir, 'other') } });
	foldersChanged();
	assert.deepEqual((await readEntry()).activeRunIds, [first]);
	const completed = await finish(0);
	assert.deepEqual(completed.activeRunIds ?? [], []);
	assert.equal(completed.history[0].id, first);
	assert.equal(completed.history[0].exitCode, 0);
	assert.ok(completed.history[0].finishedAt);

	const second = await start();
	t.mock.method(BashScriptsService.prototype, 'finishRun', async () => { throw new Error('EACCES'); });
	const failedWrite = await finish(7);
	assert.deepEqual(failedWrite.activeRunIds ?? [], []);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /EACCES/);
	assert.equal(failedWrite.history[0].id, second);
});

test('Launching from a panel restores its tab only when the new terminal displaced it', async t => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bash-focus-'));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	const projectDir = path.join(dir, 'metadata');
	const globalDir = path.join(dir, 'global');
	const file = path.join(dir, 'build.sh');
	await fs.writeFile(file, 'exit 0');
	const catalog = new BashScriptsService({ projectStorageDir: projectDir, globalStorageDir: globalDir, workspaceRoots: [dir] });
	const { scope, id } = await catalog.register('project', 'Сборка', file);
	const disposable = { dispose() {} };
	const subscribe = () => disposable;
	class TabInputTerminal {}
	const group = { viewColumn: 2, isActive: true, activeTab: undefined as unknown, tabs: [] as unknown[] };
	const original = { group, label: 'Обзор', input: {} };
	const other = { group, label: 'README.md', input: {} };
	const listeners = new Set<(event: { opened: unknown[] }) => void>();
	const reveal = t.mock.fn();
	const panel = { active: true, viewColumn: group.viewColumn, onDidDispose: subscribe, reveal };
	let terminalName = '';
	const Controller = loadController({
		Uri: { file: (fsPath: string) => ({ fsPath }) }, RelativePattern: class {}, TabInputTerminal,
		workspace: { isTrusted: true, workspaceFolders: [{ name: 'Проект', uri: { fsPath: dir } }],
			getWorkspaceFolder: () => undefined, onDidChangeWorkspaceFolders: subscribe,
			createFileSystemWatcher: () => ({ ...disposable, onDidCreate: subscribe, onDidChange: subscribe, onDidDelete: subscribe }) },
		window: { onDidChangeWindowState: subscribe, onDidStartTerminalShellExecution: subscribe, onDidEndTerminalShellExecution: subscribe, onDidCloseTerminal: subscribe,
			tabGroups: { activeTabGroup: group, onDidChangeTabs(listener: (event: { opened: unknown[] }) => void) {
				listeners.add(listener);
				return { dispose: () => listeners.delete(listener) };
			} },
			createTerminal: (options: { name: string; location: { viewColumn: number; preserveFocus: boolean } }) => {
				assert.deepEqual(options.location, { viewColumn: panel.viewColumn, preserveFocus: true });
				terminalName = options.name;
				return { ...disposable, shellIntegration: { executeCommand: (value: string) => ({ commandLine: { value } }) } };
			} },
	});
	const host = new Controller(globalDir, projectDir, () => {});
	t.after(() => host.dispose());
	for (const mode of ['active', 'switched', 'inactive'] as const) {
		panel.active = mode !== 'inactive';
		group.activeTab = panel.active ? original : other;
		group.tabs = [original, other];
		reveal.mock.resetCalls();
		await host.handleMessage({ type: 'bashScriptsRequest', action: 'run', path: file, requestId: mode, ref: { scope, id } },
			async response => { assert.equal(response.error, undefined); }, panel as unknown as import('vscode').WebviewPanel);
		assert.equal(terminalName, 'Bash · Сборка');
		if (mode === 'switched') {
			group.activeTab = other;
			listeners.forEach(notify => notify({ opened: [] }));
		}
		const terminalTab = { group, label: terminalName, input: new TabInputTerminal() };
		group.tabs.push(terminalTab);
		listeners.forEach(notify => notify({ opened: [terminalTab] }));
		group.activeTab = terminalTab;
		listeners.forEach(notify => notify({ opened: [] }));
		assert.deepEqual(reveal.mock.calls.map(call => call.arguments), mode === 'active' ? [[group.viewColumn, true]] : []);
		assert.equal(listeners.size, 0);
	}
});
