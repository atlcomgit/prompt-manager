import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http = require('node:http');
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import {
	AgentHostRpcClient, CopilotCodexSessionService, type AgentHostRpc,
} from '../src/services/copilotCodexSessionService.js';

/** Транспорт моделирует серверные состояния; ни рабочая БД, ни LM, ни установленный host не используются. */
function createRpc(options: { deny?: boolean; resetPermissions?: boolean; rejectRename?: boolean;
	failCreate?: boolean; userTurn?: boolean } = {}) {
	const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
	let channel = '', turnId = '', title = '', disposed = false;
	const chat = 'ahp-chat:/11111111-1111-1111-1111-111111111111';
	const rpc: AgentHostRpc = {
		async call(method, params) {
			calls.push({ method, params });
			switch (method) {
				case 'resolveSessionConfig': return {
					values: { 'codex.permissionsPreset': options.deny ? 'default' : 'full-access' },
					schema: { properties: { 'codex.permissionsPreset': { enum: ['default', 'full-access'] } } },
				};
				case 'createSession':
					channel = String(params.channel);
					if (options.failCreate) throw new Error('create failed');
					return null;
				case 'subscribe': return { snapshot: { state: params.channel === chat
					? { turns: options.userTurn ? [{ id: 'new-user-turn', state: 'complete' }]
						: turnId ? [{ id: turnId, state: 'complete' }] : [] }
					: { defaultChat: chat, title, config: { values: {
						'codex.permissionsPreset': options.resetPermissions ? 'default' : 'full-access',
					} } } } };
				case 'dispatchAction': {
					const action = params.action as { turnId: string; message: { text: string } };
					turnId = action.turnId;
					title = action.message.text.slice('/rename '.length);
					return options.rejectRename ? { rejectionReason: 'denied' } : { serverSeq: 3 };
				}
				case 'listSessions': return { items: [{ resource: channel, provider: 'codex' }] };
				case 'disposeSession': return null;
				default: throw new Error(`Unexpected method: ${method}`);
			}
		},
		dispose() { disposed = true; },
	};
	return { rpc, calls, isDisposed: () => disposed };
}

/** Очистка не уничтожает запрос, появившийся в опубликованной сессии параллельно с ошибкой подготовки. */
test('Codex preparation preserves a session that received another user turn', async () => {
	const fake = createRpc({ resetPermissions: true, userTurn: true });
	const service = new CopilotCodexSessionService(undefined, async () => fake.rpc);
	await assert.rejects(service.prepare('Test', ['/testing/project']));
	assert.equal(fake.calls.some(call => call.method === 'disposeSession'), false);
	assert.equal(fake.isDisposed(), true);
});

/** Пустые и некорректные пути не приводят даже к подключению к рабочему host. */
test('Codex preparation refuses invalid workspace paths before connecting', async () => {
	let connected = false;
	const service = new CopilotCodexSessionService(undefined, async () => { connected = true; return createRpc().rpc; });
	for (const folders of [[], ['relative/path'], ['/testing/invalid\0path']]) {
		await assert.rejects(service.prepare('Test', folders));
	}
	assert.equal(connected, false);
});

/** Первый серверный config содержит full-access, а единственный служебный turn — локальное именование. */
test('Codex preparation confirms Full Access and publishes an exact native open link', async () => {
	const fake = createRpc();
	const service = new CopilotCodexSessionService(undefined, async () => fake.rpc);
	const result = await service.prepare('Test\nTitle', ['/testing/project', '/testing/project']);
	const create = fake.calls.find(call => call.method === 'createSession')!;
	assert.deepEqual(create.params.config, { isolation: 'folder', 'codex.permissionsPreset': 'full-access' });
	assert.deepEqual(create.params.workingDirectories, ['file:///testing/project']);
	assert.equal(result.openLink, String(create.params.channel).replace('ahp-session:/', 'agent-host-session://ahp-session/'));
	const actions = fake.calls.filter(call => call.method === 'dispatchAction');
	assert.equal(actions.length, 1);
	assert.equal(((actions[0].params.action as { message: { text: string } }).message.text), '/rename Test Title');
	assert.equal(fake.calls.some(call => call.method === 'disposeSession'), false);
	assert.equal(fake.isDisposed(), true);
});

/** Отказ политики не создаёт сессию, а сбой после create очищает только собственный точный UUID. */
for (const option of ['deny', 'resetPermissions', 'rejectRename', 'failCreate'] as const) {
	test(`Codex preparation stops on ${option} and closes its connection`, async () => {
		const fake = createRpc({ [option]: true });
		const service = new CopilotCodexSessionService(undefined, async () => fake.rpc);
		await assert.rejects(service.prepare('Test', ['/testing/project']));
		const create = fake.calls.find(call => call.method === 'createSession');
		const cleanup = fake.calls.find(call => call.method === 'disposeSession');
		assert.equal(Boolean(create), option !== 'deny');
		assert.equal(Boolean(cleanup), option !== 'deny' && option !== 'rejectRename');
		if (cleanup) assert.equal(cleanup.params.channel, create?.params.channel);
		assert.equal(fake.isDisposed(), true);
	});
}

/** Реальный loopback WebSocket проверяет handshake, параллельные RPC и отказ ожидающего RPC при закрытии. */
test('Agent Host transport correlates requests and rejects pending work when the peer closes', async () => {
	const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	await once(server, 'listening');
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	server.on('connection', socket => socket.on('message', raw => {
		const message = JSON.parse(String(raw));
		if (message.method === 'close') { socket.close(); return; }
		socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id,
			result: message.method === 'initialize' ? { protocolVersion: '1.1.0' } : message.params }));
	}));
	let client: AgentHostRpcClient | undefined;
	try {
		client = await AgentHostRpcClient.connect({ pid: process.pid, connectionToken: 'testing',
			endpoint: { type: 'tcp', host: '127.0.0.1', port: address.port } });
		assert.deepEqual(await Promise.all([client.call('first', { value: 1 }), client.call('second', { value: 2 })]),
			[{ value: 1 }, { value: 2 }]);
		await assert.rejects(client.call('close', {}), /закрыто/);
	} finally {
		client?.dispose();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
});

/** Unix-сокет объявляется явно: HTTP-обёртка VS Code не должна направлять его через обычный HTTP agent. */
test('Agent Host Unix socket survives an HTTP proxy wrapper and preserves its auth token',
	{ skip: process.platform === 'win32' }, async () => {
	// Изолированный HTTP/WS-сервер использует собственный сокет; рабочий Agent Host и БД не затрагиваются.
	const temporaryRoot = join(tmpdir(), 'codex');
	await mkdir(temporaryRoot, { recursive: true });
	const directory = await mkdtemp(join(temporaryRoot, 'pm-uds-'));
	const socketPath = join(directory, 'agent #:%? host.sock');
	const token = 'testing-token:+/&?= #%';
	const server = http.createServer();
	const websocketServer = new WebSocketServer({ server, verifyClient: (info: { req: http.IncomingMessage }) =>
		new URL(info.req.url || '', 'http://localhost').searchParams.get('tkn') === token });
	const originalRequest = http.request;
	let ordinaryHttpRequests = 0;
	let socketRequests = 0;
	let client: AgentHostRpcClient | undefined;
	try {
		server.listen(socketPath);
		await once(server, 'listening');
		websocketServer.on('connection', socket => socket.on('message', raw => {
			const message = JSON.parse(String(raw));
			socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id,
				result: message.method === 'initialize' ? { protocolVersion: '1.1.0' } : { unixSocket: true } }));
		}));
		// Как createHttpPatch VS Code, обёртка выделяет запросы с socketPath до выбора HTTP proxy agent.
		// Неправильно объявленный запрос останавливается, чтобы тест никогда не обращался к localhost:80.
		http.request = ((...args: Parameters<typeof http.request>) => {
			const options = args[0] as http.RequestOptions;
			if (!options.socketPath) {
				ordinaryHttpRequests++;
				throw new Error('Unix socket would be routed through the HTTP proxy agent');
			}
			socketRequests++;
			return originalRequest(...args);
		}) as typeof http.request;
		client = await AgentHostRpcClient.connect({ pid: process.pid, connectionToken: token,
			endpoint: { type: 'socket', path: socketPath } });
		assert.deepEqual(await client.call('check', {}), { unixSocket: true });
		assert.equal(ordinaryHttpRequests, 0);
		assert.equal(socketRequests, 1);
		// Отказ авторизации показывает безопасный код ответа, не путь сокета и не token из URL.
		await assert.rejects(AgentHostRpcClient.connect({ pid: process.pid, connectionToken: 'wrong-testing-token',
			endpoint: { type: 'socket', path: socketPath } }), error => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /Unix-сокет, HTTP 401/);
			assert.equal(error.message.includes('wrong-testing-token'), false);
			assert.equal(error.message.includes(socketPath), false);
			return true;
		});
		assert.equal(ordinaryHttpRequests, 0);
	} finally {
		http.request = originalRequest;
		client?.dispose();
		for (const socket of websocketServer.clients) socket.terminate();
		await new Promise<void>(resolve => websocketServer.close(() => resolve()));
		await new Promise<void>(resolve => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
