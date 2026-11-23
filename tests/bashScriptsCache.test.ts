import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { Memento } from 'vscode';
import type { BashScriptsHostController } from '../src/providers/bashScriptsHostController.js';
import type { BashScriptsResponse } from '../src/types/bashScripts.js';

/** Load the normal host entry point with only the VS Code API provided by the test. */
function loadController(vscode: unknown): typeof BashScriptsHostController {
	const id = require.resolve('../src/providers/bashScriptsHostController.js');
	const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
	const original = loader._load;
	const cached = require.cache[id];
	delete require.cache[id];
	loader._load = function(name, ...args) { return name === 'vscode' ? vscode : original.call(this, name, ...args); };
	try {
		return require(id).BashScriptsHostController;
	} finally {
		loader._load = original;
		if (cached) require.cache[id] = cached;
		else delete require.cache[id];
	}
}

/** Requests take the same path as a dashboard panel, including response and warning handling. */
async function request(host: BashScriptsHostController, action: 'list' | 'scan') {
	let reply: BashScriptsResponse | undefined;
	await host.handleMessage({ type: 'bashScriptsRequest', requestId: action, action }, async message => { reply = message; });
	assert.equal(reply?.error, undefined);
	assert.equal(reply?.result?.warning, undefined);
	assert.ok(reply?.result?.entries);
	return reply.result.entries;
}

test('Bash discovery survives restart and only invalidated script paths are checked again', { timeout: 15_000 }, async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-bash-cache-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const disposable = { dispose() {} };
	const subscribe = () => disposable;
	const found: string[] = [];
	let scans = 0;
	let scriptChanged!: (uri: { fsPath: string }) => void;
	const Controller = loadController({
		Uri: { file: (fsPath: string) => ({ fsPath }) }, RelativePattern: class {},
		window: { onDidChangeWindowState: subscribe, onDidStartTerminalShellExecution: subscribe, onDidCloseTerminal: subscribe, onDidEndTerminalShellExecution: subscribe },
		workspace: {
			isTrusted: true, workspaceFolders: [{ name: 'Project', uri: { fsPath: root } }],
			onDidChangeWorkspaceFolders: subscribe,
			findFiles: async () => { scans++; return found.map(fsPath => ({ fsPath })); },
			createFileSystemWatcher: (pattern: unknown) => ({
				...disposable, onDidCreate: subscribe, onDidChange: subscribe,
				onDidDelete: (listener: typeof scriptChanged) => {
					if (typeof pattern === 'string') scriptChanged = listener;
					return disposable;
				},
			}),
		},
	});
	const values = new Map<string, unknown>();
	const storage: Memento = {
		keys: () => [...values.keys()],
		get: <T>(key: string, fallback?: T) => (values.get(key) ?? fallback) as T,
		update: async (key, value) => { values.set(key, value); },
	};
	const start = (changed = () => {}, git?: ConstructorParameters<typeof Controller>[3]) =>
		new Controller(path.join(root, 'global'), path.join(root, 'project'), changed, git, storage);

	let host = start();
	t.after(() => host.dispose());
	assert.deepEqual(await request(host, 'list'), []);
	assert.equal(scans, 1);
	host.dispose();
	host = start();
	assert.deepEqual(await request(host, 'list'), []);
	assert.equal(scans, 1, 'reopening an empty scanned catalog should not walk the workspace');

	const files = ['one.sh', 'two.sh', 'three.sh'].map(name => path.join(root, name));
	await Promise.all(files.map(file => fs.writeFile(file, 'exit 0\n')));
	found.push(...files);
	const stats = t.mock.method(fs, 'lstat');
	const checked = () => stats.mock.calls.map(call => String(call.arguments[0])).filter(file => files.includes(file)).sort();
	const entries = await request(host, 'scan');
	assert.deepEqual(entries.map(entry => entry.absolutePath).sort(), [...files].sort());
	assert.ok(entries.every(entry => entry.available));
	assert.equal(scans, 2);
	assert.deepEqual(checked(), [...files].sort(), 'manual discovery checks each registered script');
	stats.mock.resetCalls();
	await Promise.all([request(host, 'list'), request(host, 'list')]);
	assert.deepEqual(checked(), []);

	await fs.unlink(files[1]);
	scriptChanged({ fsPath: files[1] });
	const changedEntries = await request(host, 'list');
	assert.equal(changedEntries.find(entry => entry.absolutePath === files[1])?.available, false);
	assert.deepEqual(checked(), [files[1]], 'only the deleted script is probed');
	stats.mock.restore();
	host.dispose();

	// Change a file while VS Code is closed. Hold Git and disk independently across the first response.
	await fs.unlink(files[0]);
	let releaseDisk!: () => void;
	let releaseGit!: () => void;
	let reportChange!: () => void;
	const disk = new Promise<void>(resolve => { releaseDisk = resolve; });
	const git = new Promise<null>(resolve => { releaseGit = () => resolve(null); });
	const change = new Promise<void>(resolve => { reportChange = resolve; });
	t.after(() => { releaseDisk(); releaseGit(); });
	const lstat = fs.lstat;
	t.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
		if (files.includes(String(args[0]))) await disk;
		return lstat(...args);
	});
	host = start(reportChange, () => git);
	const restored = await request(host, 'list');
	assert.equal(scans, 2, 'restoring a populated catalog should not walk the workspace');
	assert.deepEqual(restored.map(entry => [entry.id, entry.available]), changedEntries.map(entry => [entry.id, entry.available]));
	releaseDisk();
	await change;
	const verified = await request(host, 'list');
	assert.equal(verified.find(entry => entry.absolutePath === files[0])?.available, false);
	releaseGit();
});
