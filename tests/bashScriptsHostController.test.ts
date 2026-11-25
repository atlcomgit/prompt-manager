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

/** Команда запуска контроллера: переход в рабочую папку и выполнение файла одним аргументом. */
const RUN_COMMAND = 'cd -- "$PROMPT_MANAGER_BASH_CWD" && bash -- "$PROMPT_MANAGER_BASH_SCRIPT"';

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
	const copied: string[] = [];
	const Controller = loadController({ workspace, Uri: { file: (fsPath: string) => ({ fsPath }) }, RelativePattern: class {},
		env: { clipboard: { writeText: async (text: string) => { copied.push(text); } } },
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
	await t.test('Чтение сообщает абсолютный путь и путь от ближайшего проекта, копирование пишет их в буфер VS Code', async () => {
		const entry = initial.entries![0];
		async function send(data: Omit<BashScriptsRequest, 'type' | 'requestId'>) {
			let response: BashScriptsResponse | undefined;
			await host.handleMessage({ type: 'bashScriptsRequest', requestId: 'copy', ...data }, async message => { response = message; });
			return response!;
		}
		const read = await send({ action: 'read', scope: entry.scope, path: entry.path });
		assert.equal(read.error, undefined);
		assert.equal(read.result?.absolutePath, file);
		assert.equal(read.result?.relativePath, 'check.sh', 'путь отсчитывается от вложенного репозитория, как в строке');
		for (const pathKind of ['relative', 'absolute'] as const) {
			assert.equal((await send({ action: 'copyPath', scope: entry.scope, path: entry.path, pathKind })).error, undefined);
		}
		assert.deepEqual(copied, ['check.sh', file]);
		// Файл вне рабочих папок и репозиториев имеет только абсолютный путь.
		const outside = path.join(path.dirname(dir), 'outside.sh');
		const external = await send({ action: 'read', scope: 'global', path: outside });
		assert.equal(external.result?.absolutePath, outside);
		assert.equal(external.result?.relativePath, undefined);
		assert.match((await send({ action: 'copyPath', scope: 'global', path: outside, pathKind: 'relative' })).error!, /вне проектов/);
		assert.match((await send({ action: 'copyPath', scope: entry.scope, path: entry.path })).error!, /вид пути/);
		assert.deepEqual(copied, ['check.sh', file], 'отказ не меняет буфер обмена');
	});
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
test('Bash host scans lazily and starts an isolated panel terminal with the actual Bash exit code', async t => {
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
	let terminalOptions: { location: number; cwd: string; shellPath: string; env: Record<string, string> } | undefined;
	type TerminalEvent = { terminal: unknown; execution: unknown; exitCode: number };
	let end = (_event: TerminalEvent) => {};
	const vscode = {
		Uri: { file: (fsPath: string) => ({ fsPath }) }, RelativePattern: class {}, TerminalLocation: { Panel: 1 },
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
	assert.equal(terminalOptions?.location, vscode.TerminalLocation.Panel);
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
		Uri: { file: (fsPath: string) => ({ fsPath }) }, RelativePattern: class {}, TerminalLocation: { Panel: 1 },
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
						assert.equal(value, RUN_COMMAND);
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

	// Свободный терминал прошлых запусков иначе был бы использован повторно. Пользователь закрывает его.
	closeListeners.forEach(listener => listener(lastTerminal));
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
	started({ terminal: lastTerminal, execution: { commandLine: { value: RUN_COMMAND } } });
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
		workspace, Uri: { file: (fsPath: string) => ({ fsPath }) }, RelativePattern: class {}, TerminalLocation: { Panel: 1 },
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

/** Запуск не трогает вкладки редактора и панель, а кнопка строки показывает нужный терминал до его закрытия. */
test('Scripts start in an unrevealed panel terminal that the row can show until the terminal closes', async t => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bash-panel-'));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	const projectDir = path.join(dir, 'metadata');
	const globalDir = path.join(dir, 'global');
	const file = path.join(dir, 'build.sh');
	await fs.writeFile(file, 'exit 0');
	const catalog = new BashScriptsService({ projectStorageDir: projectDir, globalStorageDir: globalDir, workspaceRoots: [dir] });
	const ref = await catalog.register('project', 'Сборка', file);
	const disposable = { dispose() {} };
	const subscribe = () => disposable;
	const closeListeners = new Set<(terminal: unknown) => void>();
	const terminals: { name: string; shown: unknown[][] }[] = [];
	let changed = 0;
	// Мок без tabGroups и ViewColumn: обращение запуска к вкладкам редактора завершило бы тест ошибкой.
	const Controller = loadController({
		Uri: { file: (fsPath: string) => ({ fsPath }) }, RelativePattern: class {}, TerminalLocation: { Panel: 1 },
		workspace: { isTrusted: true, workspaceFolders: [{ name: 'Проект', uri: { fsPath: dir } }],
			getWorkspaceFolder: () => undefined, onDidChangeWorkspaceFolders: subscribe,
			createFileSystemWatcher: () => ({ ...disposable, onDidCreate: subscribe, onDidChange: subscribe, onDidDelete: subscribe }) },
		window: { onDidChangeWindowState: subscribe, onDidStartTerminalShellExecution: subscribe, onDidEndTerminalShellExecution: subscribe,
			onDidCloseTerminal: (listener: (terminal: unknown) => void) => {
				closeListeners.add(listener);
				return { dispose: () => closeListeners.delete(listener) };
			},
			createTerminal: (options: { name: string; location: unknown }) => {
				assert.equal(options.location, 1);
				const terminal = { ...disposable, name: options.name, shown: [] as unknown[][],
					show(...args: unknown[]) { terminal.shown.push(args); },
					shellIntegration: { executeCommand: (value: string) => ({ commandLine: { value } }) } };
				terminals.push(terminal);
				return terminal;
			} },
	});
	const host = new Controller(globalDir, projectDir, () => { changed++; });
	t.after(() => host.dispose());
	async function request(data: Omit<BashScriptsRequest, 'type' | 'requestId'>) {
		let response: BashScriptsResponse | undefined;
		await host.handleMessage({ type: 'bashScriptsRequest', requestId: 'panel', ...data }, async message => { response = message; });
		return response!;
	}
	const entry = async () => (await request({ action: 'list' })).result!.entries![0];
	// Закрытие сохраняет итог запуска в истории. Ожидаем это обновление, а не фиксированное время.
	const close = async (terminal: unknown) => {
		const before = changed;
		closeListeners.forEach(listener => listener(terminal));
		for (let i = 0; i < 200 && changed === before; i++) await new Promise(resolve => setTimeout(resolve, 10));
	};
	assert.equal((await request({ action: 'run', ref, path: file })).error, undefined);
	assert.equal((await request({ action: 'run', ref, path: file })).error, undefined);
	assert.deepEqual(terminals.map(terminal => [terminal.name, terminal.shown.length]), [['Bash · Сборка', 0], ['Bash · Сборка', 0]]);
	const running = await entry();
	assert.deepEqual(running.terminalRunIds, running.history.map(run => run.id), 'новый терминал идёт первым');
	const [newer, older] = running.terminalRunIds!;

	assert.equal((await request({ action: 'showTerminal', ref, runId: older })).error, undefined);
	assert.deepEqual(terminals.map(terminal => terminal.shown), [[[]], []], 'показывается терминал выбранного запуска с фокусом');
	assert.match((await request({ action: 'showTerminal', ref: { ...ref, scope: 'global' }, runId: older })).error!, /уже закрыт/);

	await close(terminals[0]);
	assert.deepEqual((await entry()).terminalRunIds, [newer]);
	const beforeClosed = changed;
	assert.match((await request({ action: 'showTerminal', ref, runId: older })).error!, /уже закрыт/);
	assert.ok(changed > beforeClosed, 'отказ обновляет список, чтобы строка убрала устаревшую кнопку');
	await close(terminals[1]);
	const closed = await entry();
	assert.equal(closed.terminalRunIds, undefined);
	assert.deepEqual(closed.history.map(run => run.endedBy), ['terminal', 'terminal']);
	assert.deepEqual(terminals.map(terminal => terminal.shown.length), [1, 0]);
});

/** Повторный запуск идёт в свободный терминал скрипта. Занятая оболочка, другой файл и закрытый процесс требуют нового. */
test('Rerunning a script reuses its idle terminal and opens a new one only for a busy shell, another file or an exited process', async t => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bash-reuse-'));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	const projectDir = path.join(dir, 'metadata');
	const globalDir = path.join(dir, 'global');
	const file = path.join(dir, 'build.sh');
	const other = path.join(dir, 'other.sh');
	await fs.writeFile(file, 'exit 0');
	await fs.writeFile(other, 'exit 0');
	const catalog = new BashScriptsService({ projectStorageDir: projectDir, globalStorageDir: globalDir, workspaceRoots: [dir] });
	const ref = await catalog.register('project', 'Сборка', file);
	const disposable = { dispose() {} };
	const subscribe = () => disposable;
	type Execution = { commandLine: { value: string } };
	type ShellEvent = { terminal: unknown; execution: Execution; exitCode?: number };
	type FakeTerminal = { commands: string[]; env: Record<string, string>; shown: number; last?: Execution; exitStatus?: { code: number } };
	let started = (_event: ShellEvent) => {};
	let ended = (_event: ShellEvent) => {};
	const terminals: FakeTerminal[] = [];
	const Controller = loadController({
		Uri: { file: (fsPath: string) => ({ fsPath }) }, RelativePattern: class {}, TerminalLocation: { Panel: 1 },
		workspace: { isTrusted: true, workspaceFolders: [{ name: 'Проект', uri: { fsPath: dir } }],
			getWorkspaceFolder: () => ({ uri: { fsPath: dir } }), onDidChangeWorkspaceFolders: subscribe,
			createFileSystemWatcher: () => ({ ...disposable, onDidCreate: subscribe, onDidChange: subscribe, onDidDelete: subscribe }) },
		window: { onDidChangeWindowState: subscribe, onDidCloseTerminal: subscribe, showWarningMessage: () => {},
			onDidStartTerminalShellExecution: (listener: typeof started) => { started = listener; return disposable; },
			onDidEndTerminalShellExecution: (listener: typeof ended) => { ended = listener; return disposable; },
			createTerminal: (options: { env: Record<string, string> }) => {
				const terminal = { ...disposable, commands: [] as string[], env: options.env, shown: 0,
					last: undefined as Execution | undefined, exitStatus: undefined as { code: number } | undefined,
					show() { terminal.shown++; },
					shellIntegration: { executeCommand(value: string) {
						terminal.commands.push(value);
						terminal.last = { commandLine: { value } };
						started({ terminal, execution: terminal.last });
						return terminal.last;
					} } };
				terminals.push(terminal);
				return terminal;
			} },
	});
	const host = new Controller(globalDir, projectDir, () => {});
	t.after(() => host.dispose());
	async function request(data: Omit<BashScriptsRequest, 'type' | 'requestId'>) {
		let response: BashScriptsResponse | undefined;
		await host.handleMessage({ type: 'bashScriptsRequest', requestId: 'reuse', ...data }, async message => { response = message; });
		assert.equal(response?.error, undefined);
		return response!.result!;
	}
	const entry = async () => (await request({ action: 'list' })).entries![0];
	const run = async () => {
		await request({ action: 'run', ref, path: (await entry()).absolutePath });
		return (await entry()).history[0].id;
	};
	// Окончание сохраняется в историю асинхронно: дожидаемся записи, чтобы следующий запуск видел актуальный каталог.
	const finish = async (terminal: FakeTerminal, id: string) => {
		ended({ terminal, execution: terminal.last!, exitCode: 0 });
		for (let i = 0; i < 200 && !(await catalog.get(ref)).history.find(item => item.id === id)?.finishedAt; i++) {
			await new Promise(resolve => setTimeout(resolve, 10));
		}
	};

	const first = await run();
	assert.equal(terminals.length, 1);
	assert.deepEqual(terminals[0].commands, [RUN_COMMAND]);
	assert.equal(terminals[0].env.PROMPT_MANAGER_BASH_CWD, dir);
	await finish(terminals[0], first);
	const second = await run();
	assert.equal(terminals.length, 1, 'свободный терминал скрипта используется повторно');
	assert.deepEqual(terminals[0].commands, [RUN_COMMAND, RUN_COMMAND]);
	assert.deepEqual((await entry()).terminalRunIds, [second], 'терминал показан последним запуском');
	await request({ action: 'showTerminal', ref, runId: first });
	assert.equal(terminals[0].shown, 1, 'прежний запуск того же терминала по-прежнему можно показать');

	// Пока команда выполняется, повторная отправка прервала бы её: нужен новый терминал.
	const third = await run();
	assert.equal(terminals.length, 2);
	assert.deepEqual((await entry()).terminalRunIds, [third, second]);
	await finish(terminals[0], second);
	await finish(terminals[1], third);
	// Пользователь запустил в терминале свою программу после окончания скрипта: этот терминал занят.
	started({ terminal: terminals[1], execution: { commandLine: { value: 'tail -f build.log' } } });
	const fourth = await run();
	assert.deepEqual(terminals.map(terminal => terminal.commands.length), [3, 1], 'занятый пользователем терминал пропущен');
	await finish(terminals[0], fourth);
	ended({ terminal: terminals[1], execution: { commandLine: { value: 'tail -f build.log' } }, exitCode: 130 });
	const fifth = await run();
	assert.deepEqual(terminals.map(terminal => terminal.commands.length), [4, 1], 'выбирается терминал последнего запуска');
	await finish(terminals[0], fifth);

	// Окружение терминала задано при создании, поэтому другой файл скрипта получает новый терминал.
	await catalog.edit(ref, 'Сборка', other, { name: 'Сборка', path: 'build.sh' });
	const sixth = await run();
	assert.equal(terminals.length, 3);
	assert.equal(terminals[2].env.PROMPT_MANAGER_BASH_SCRIPT, other);
	await finish(terminals[2], sixth);
	// Завершённый процесс оболочки не принимает команды.
	terminals[2].exitStatus = { code: 0 };
	await run();
	assert.equal(terminals.length, 4);
});
