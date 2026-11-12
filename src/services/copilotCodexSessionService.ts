import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
import WebSocket from 'ws';
import { discoverAgentHostEndpoint, parseAgentHostEndpoint, type AgentHostEndpoint } from '../utils/agentHostEndpoint.js';

/** Небольшой контракт AHP для создания сессии; тестовая реализация не обращается к рабочим ресурсам. */
export interface AgentHostRpc {
	call(method: string, params: Record<string, unknown>): Promise<unknown>;
	dispose(): void;
}

/** Подготовленная сессия уже опубликована сервером и имеет подтверждённые разрешения. */
export interface PreparedCopilotCodexSession {
	/** Штатный opener VS Code разрешает именно эту опубликованную backend identity. */
	openLink: string;
}

/** Срок одного RPC и предел ожидания локальной команды именования. */
const RPC_TIMEOUT_MS = 10_000;
const PREPARE_TIMEOUT_MS = 5_000;
/** Ключ разрешений встроенного провайдера Codex, не общая настройка Copilot. */
const FULL_ACCESS_KEY = 'codex.permissionsPreset';

/** Сужает JSON-объект, не доверяя структуре ответа внешнего процесса. */
function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown> : {};
}

/**
 * Локальный WebSocket JSON-RPC с таймаутами, heartbeat и освобождением ожиданий при закрытии.
 * Проверки транспорта: tests/copilotCodexSessionService.test.ts.
 */
export class AgentHostRpcClient implements AgentHostRpc {
	/** Идентификаторы ожидающих RPC уникальны внутри собственного соединения. */
	private sequence = 0;
	/** Повторное закрытие из error/close не освобождает ожидания дважды. */
	private closed = false;
	/** Heartbeat предотвращает закрытие соединения при ожидании готовности новой сессии. */
	private heartbeat?: ReturnType<typeof setInterval>;
	/** Каждый ожидающий ответ имеет собственный ограниченный срок жизни. */
	private readonly pending = new Map<number, {
		resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>;
	}>();

	/** Сообщения с токенами и сырые ошибки транспорта не попадают в пользовательскую диагностику. */
	private constructor(private readonly socket: WebSocket) {
		socket.on('message', data => {
			try {
				const message = record(JSON.parse(String(data)));
				if (message.method === 'ping' && message.id !== undefined) {
					socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: null }));
					return;
				}
				const id = Number(message.id);
				const pending = this.pending.get(id);
				if (!pending) return;
				this.pending.delete(id);
				clearTimeout(pending.timer);
				if (message.error) pending.reject(new Error('Agent Host отклонил запрос настройки сессии.'));
				else pending.resolve(message.result);
			} catch { this.dispose(); }
		});
		socket.on('close', () => this.dispose());
		socket.on('error', () => this.dispose());
	}

	/** Подключается исключительно к проверенному локальному endpoint и согласует версию AHP. */
	static async connect(endpoint: AgentHostEndpoint): Promise<AgentHostRpcClient> {
		if (!parseAgentHostEndpoint({ schemaVersion: 2, ...endpoint })) {
			throw new Error('Некорректный локальный endpoint Agent Host.');
		}
		const address = endpoint.endpoint;
		// ws+unix выставляет socketPath, по которому HTTP-обёртка VS Code распознаёт локальный IPC.
		// createConnection ниже использует исходный путь: URL-кодирование не меняет имя файла сокета.
		const url = new URL(address.type === 'tcp'
			? `ws://${address.host === '::1' ? '[::1]' : address.host}:${address.port}/`
			: `ws+unix://${address.path.split('/').map(encodeURIComponent).join('/')}:/`);
		url.searchParams.set('tkn', endpoint.connectionToken);
		const socket = new WebSocket(url, {
			handshakeTimeout: RPC_TIMEOUT_MS, maxPayload: 2 * 1024 * 1024,
			...(address.type === 'socket' ? { createConnection: () => createConnection(address.path) } : {}),
		});
		const client = new AgentHostRpcClient(socket);
		try {
			await new Promise<void>((resolve, reject) => {
				socket.once('open', resolve);
				socket.once('error', (error: Error & { code?: unknown }) => {
					// Только известный системный код или HTTP-статус: сырое сообщение может содержать URL с токеном.
					const code = typeof error.code === 'string'
						&& ['ECONNREFUSED', 'ECONNRESET', 'ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT'].includes(error.code)
						? error.code : undefined;
					const status = /^Unexpected server response: (\d{3})$/.exec(error.message)?.[1];
					const transport = address.type === 'socket' ? 'Unix-сокет' : 'TCP';
					const reason = code ?? (status ? `HTTP ${status}` : undefined);
					reject(new Error(`Не удалось подключиться к локальному Agent Host (${transport}${reason ? `, ${reason}` : ''}).`));
				});
			});
			const initialized = record(await client.call('initialize', {
				clientId: randomUUID(), protocolVersions: ['1.1.0'],
				clientInfo: { name: 'prompt-manager', version: '1' }, initialSubscriptions: [],
			}));
			if (initialized.protocolVersion !== '1.1.0') throw new Error('Версия Agent Host не поддерживает этот запуск.');
			client.heartbeat = setInterval(() => { void client.call('ping', {}).catch(() => client.dispose()); }, 5000);
			client.heartbeat.unref?.();
			return client;
		} catch (error) { client.dispose(); throw error; }
	}

	/** Не повторяет изменяющий запрос после таймаута: сервер мог уже применить его. */
	call(method: string, params: Record<string, unknown>): Promise<unknown> {
		if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error('Соединение с Agent Host закрыто.'));
		}
		const id = ++this.sequence;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Agent Host не подтвердил ${method} вовремя.`));
			}, RPC_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), error => {
					if (error) this.dispose();
				});
			} catch { this.dispose(); }
		});
	}

	/** Закрывает только собственное соединение, не останавливая Agent Host или чужие сессии. */
	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.heartbeat) clearInterval(this.heartbeat);
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error('Соединение с Agent Host закрыто.'));
		}
		this.pending.clear();
		this.socket.terminate();
	}
}

/** Создаёт новый Codex с Full Access, не изменяя глобальные настройки или существующие сессии. */
export class CopilotCodexSessionService {
	/** Подмена транспорта используется в tests/copilotCodexSessionService.test.ts без рабочей БД и LM. */
	constructor(
		private readonly globalStoragePath?: string,
		private readonly connect: (globalStoragePath?: string) => Promise<AgentHostRpc> = async storagePath =>
			AgentHostRpcClient.connect(await discoverAgentHostEndpoint(storagePath)),
	) { }

	/**
	 * Публикует сессию штатным локальным /rename; это не отправка текста задачи модели.
	 * Проверки успешного запуска и отказов: tests/copilotCodexSessionService.test.ts.
	 */
	async prepare(title: string, folders: string[]): Promise<PreparedCopilotCodexSession> {
		if (!folders.length || folders.some(folder => !isAbsolute(folder) || folder.includes('\0'))) {
			throw new Error('Для запуска Codex требуются абсолютные пути открытой рабочей области.');
		}
		const rpc = await this.connect(this.globalStoragePath);
		const id = randomUUID();
		const channel = `ahp-session:/${id}`;
		let created = false;
		let publicationAttempted = false;
		try {
			const config = { isolation: 'folder', [FULL_ACCESS_KEY]: 'full-access' };
			const workingDirectories = [...new Set(folders)].map(folder => pathToFileURL(folder).toString());
			const resolved = record(await rpc.call('resolveSessionConfig', {
				provider: 'codex', workingDirectory: workingDirectories[0], config,
			}));
			const property = record(record(record(resolved.schema).properties)[FULL_ACCESS_KEY]);
			if (record(resolved.values)[FULL_ACCESS_KEY] !== 'full-access'
				|| property.readOnly === true || !Array.isArray(property.enum) || !property.enum.includes('full-access')) {
				throw new Error('Agent Host не разрешает Full Access для Codex.');
			}
			created = true;
			await rpc.call('createSession', { channel, provider: 'codex', workingDirectories, config });
			const state = await this.readState(rpc, channel);
			this.assertFullAccess(state);
			const chat = state.defaultChat;
			if (typeof chat !== 'string' || !/^ahp-chat:\/[a-f0-9-]+$/i.test(chat)) {
				throw new Error('Agent Host не вернул идентификатор нового чата Codex.');
			}
			await rpc.call('subscribe', { channel: chat });
			const turnId = randomUUID();
			const safeTitle = title.replace(/[\r\n\u0000-\u001f]/g, ' ').trim().slice(0, 200) || 'Prompt Manager';
			publicationAttempted = true;
			const acknowledgement = record(await rpc.call('dispatchAction', {
				channel: chat, clientSeq: 1, action: {
					type: 'chat/turnStarted', turnId, startedAt: new Date().toISOString(),
					message: { text: `/rename ${safeTitle}`, origin: { kind: 'user' } },
				},
			}));
			if (acknowledgement.rejectionReason || acknowledgement.serverSeq === -1) {
				throw new Error('Agent Host не подтвердил подготовку нового чата Codex.');
			}
			// Ожидаем завершения именно локального turn и публикации identity, а не фиксированную паузу.
			const deadline = Date.now() + PREPARE_TIMEOUT_MS;
			while (Date.now() < deadline) {
				const current = await this.readState(rpc, channel);
				this.assertFullAccess(current);
				const chatState = await this.readState(rpc, chat);
				const turns = Array.isArray(chatState.turns) ? chatState.turns.map(record) : [];
				const turn = turns.find(candidate => candidate.id === turnId);
				if (turn?.state === 'error' || turn?.state === 'cancelled') throw new Error('Не удалось назвать новый чат Codex.');
				if (turn?.state === 'complete' && current.title === safeTitle) {
					const listing = record(await rpc.call('listSessions', {}));
					if (Array.isArray(listing.items) && listing.items.some(item => record(item).resource === channel)) {
						return { openLink: `agent-host-session://ahp-session/${id}` };
					}
				}
				await new Promise(resolve => setTimeout(resolve, 100));
			}
			throw new Error('Agent Host не опубликовал подготовленный чат Codex вовремя.');
		} catch (error) {
			// После публикации чат мог быть открыт вручную: его удаление уже нельзя безопасно автоматизировать.
			if (created && !publicationAttempted) {
				try {
					// Не удаляем сессию, если за время подготовки в ней уже появился чужой запрос.
					const state = await this.readState(rpc, channel);
					if (typeof state.defaultChat === 'string' && /^ahp-chat:\/[a-f0-9-]+$/i.test(state.defaultChat)) {
						const chat = await this.readState(rpc, state.defaultChat);
						const turns = Array.isArray(chat.turns) ? chat.turns.map(record) : [];
						const active = record(chat.activeTurn).id;
						if (!active && turns.length === 0) {
							await rpc.call('disposeSession', { channel });
						}
					}
				} catch { /* Исходная ошибка не маскируется ошибкой проверки или очистки. */ }
			}
			throw error;
		} finally { rpc.dispose(); }
	}

	/** Читает подтверждённое серверное состояние только указанной новой сессии или её чата. */
	private async readState(rpc: AgentHostRpc, channel: string): Promise<Record<string, unknown>> {
		return record(record(record(await rpc.call('subscribe', { channel })).snapshot).state);
	}

	/** Успех RPC сам по себе не подтверждает фактические разрешения. */
	private assertFullAccess(state: Record<string, unknown>): void {
		if (record(record(state.config).values)[FULL_ACCESS_KEY] !== 'full-access') {
			throw new Error('Agent Host не подтвердил Full Access нового чата Codex.');
		}
	}
}
