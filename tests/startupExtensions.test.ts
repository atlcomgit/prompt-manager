import test from 'node:test';
import assert from 'node:assert/strict';
import { StartupExtensions } from '../src/services/startupExtensions.js';

function extension(id: string, event: string, main?: string) {
	return { id, isActive: false, packageJSON: { activationEvents: [event], main } };
}

function createRegistry(...extensions: ReturnType<typeof extension>[]) {
	return { all: extensions };
}

test('startup waits only for the providers used by each operation', async t => {
	t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
	const promptManager = extension('prompt', 'onStartupFinished', 'extension.js');
	const unrelated = extension('unrelated', '*', 'extension.js');
	const provider = extension('models', 'onStartupFinished', 'extension.js');
	const lazy = extension('debugger', 'onDebug', 'debugger.js');
	const theme = extension('theme', '*');
	const extensions = createRegistry(promptManager, unrelated, provider, lazy, theme);
	const messages: string[] = [];
	const startup = new StartupExtensions(extensions, message => messages.push(message), 'prompt');
	t.after(() => startup.dispose());
	const whenModelsReady = startup.forProviders('MODELS', 'debugger', 'theme');
	let hydrated = false;
	const models = whenModelsReady().then(ready => { hydrated = ready; });
	const local = startup.run(() => 'local context');
	promptManager.isActive = true;
	t.mock.timers.tick(1000);
	assert.equal(await local, 'local context');
	assert.equal(hydrated, false);
	assert.deepEqual(startup.startingProviders(['models', 'debugger', 'theme']), ['models']);
	provider.isActive = true;
	t.mock.timers.tick(1000);
	await models;
	assert.ok(hydrated);
	assert.deepEqual(messages, []);
	assert.equal(unrelated.isActive, false);
	assert.equal(lazy.isActive, false);
});

test('a stuck startup provider times out and can still report that it is unavailable', async t => {
	t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
	const messages: string[] = [];
	const startup = new StartupExtensions(createRegistry(extension('copilot', '*', 'main.js')), line => messages.push(line), 'prompt');
	t.after(() => startup.dispose());
	const waiting = startup.forProviders('copilot')();
	t.mock.timers.tick(10_000);
	assert.equal(await waiting, true);
	assert.deepEqual(startup.startingProviders(['copilot']), ['copilot']);
	assert.equal(messages.length, 1);
	assert.match(messages[0], /copilot/);
});

test('остановка хоста отменяет ожидающие и новые задачи', async t => {
	t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
	const startup = new StartupExtensions(createRegistry(extension('slow', '*', 'slow.js')), () => {}, 'slow');
	const pending = startup.whenReady();
	const job = startup.run(() => assert.fail('ранняя задача запущена после остановки'));
	startup.dispose();
	t.mock.timers.tick(60_000);
	assert.equal(await pending, false);
	await job;
	await startup.run(() => assert.fail('новая задача запущена после остановки'));
});

test('закрытие в момент готовности не запускает уже поставленный callback', async t => {
	t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
	const startup = new StartupExtensions(createRegistry(), () => {}, 'prompt');
	const work = startup.run(() => assert.fail('задача запущена в закрытом окне'));
	t.mock.timers.tick(1000);
	startup.dispose();
	await work;
	assert.equal(await startup.whenReady(), false);
});
