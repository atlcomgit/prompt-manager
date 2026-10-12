import type { ClaudeChatSessionBinding, ClaudeChatSessionSnapshot, ClaudeChatState } from '../types/claudeChat.js';

/** Claude использует UUID без требования конкретной версии генератора. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Маркер должен полностью попадать в первые 200 символов firstPrompt SDK. */
const LAUNCH_MARKER = /^\[\[prompt-manager-claude:([0-9a-f-]{36})\]\]$/;

/** Проверяет внешний идентификатор до использования в пути или вызове SDK; см. claudeChat.test.ts. */
export function isClaudeChatSessionId(value: unknown): value is string {
	return typeof value === 'string' && SESSION_ID.test(value);
}

/** Создаёт непересекающийся с обычным текстом маркер одной попытки запуска. */
export function createClaudeChatLaunchMarker(requestId: string): string {
	if (!isClaudeChatSessionId(requestId)) throw new Error('Для маркера Claude требуется UUID запроса.');
	return `[[prompt-manager-claude:${requestId.toLowerCase()}]]`;
}

/** Не принимает случайный текст в качестве маркера сохранённого запуска. */
export function isClaudeChatLaunchMarker(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const match = LAUNCH_MARKER.exec(value);
	return Boolean(match && isClaudeChatSessionId(match[1]));
}

/** Сравнивает полный префикс, а не подстроку из цитаты, названия или другого запроса. */
export function hasClaudeChatLaunchMarker(text: unknown, marker: string): boolean {
	return typeof text === 'string' && text.startsWith(marker)
		&& (text.length === marker.length || /\s/.test(text[marker.length]));
}

/** Нормализует только разделители абсолютного пути; переходы вверх и нулевые байты запрещены. */
export function normalizeClaudeChatProjectPath(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.includes('\0') || value !== value.trim()) return undefined;
	const normalized = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
	if (!normalized.startsWith('/') && !/^[a-z]:\//i.test(normalized)) return undefined;
	if (normalized.split('/').some(part => part === '..' || part === '.')) return undefined;
	return /^[a-z]:\/$/i.test(normalized) ? normalized : normalized.replace(/\/+$/, '') || '/';
}

/** Проверяет сохраняемые миллисекунды без округления и повторного начисления испорченных значений. */
function isMilliseconds(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Отбрасывает повреждённые привязки и не объединяет один UUID из разных проектов; см. claudeChat.test.ts. */
export function normalizeClaudeChatState(value: unknown): ClaudeChatState | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	const sessions = new Map<string, ClaudeChatSessionBinding>();
	const conflicted = new Set<string>();
	for (const candidate of Array.isArray(input.sessions) ? input.sessions : []) {
		if (!candidate || typeof candidate !== 'object') continue;
		const binding = candidate as Record<string, unknown>;
		const projectPath = normalizeClaudeChatProjectPath(binding.projectPath);
		if (!isClaudeChatSessionId(binding.sessionId) || !projectPath || !isMilliseconds(binding.accountedMs)) continue;
		const sessionId = binding.sessionId.toLowerCase();
		const previous = sessions.get(sessionId);
		if (previous && previous.projectPath !== projectPath) conflicted.add(sessionId);
		const completionHandledAt = isMilliseconds(binding.completionHandledAt) ? binding.completionHandledAt : undefined;
		sessions.set(sessionId, {
			sessionId, projectPath,
			accountedMs: Math.max(previous?.accountedMs ?? 0, binding.accountedMs),
			...(completionHandledAt !== undefined || previous?.completionHandledAt !== undefined
				? { completionHandledAt: Math.max(previous?.completionHandledAt ?? 0, completionHandledAt ?? 0) } : {}),
		});
	}
	const result: ClaudeChatState = { sessions: [...sessions.values()].filter(item => !conflicted.has(item.sessionId)) };
	if (isMilliseconds(input.copilotAccountedMs)) result.copilotAccountedMs = input.copilotAccountedMs;
	const pending = input.pendingLaunch;
	if (pending && typeof pending === 'object' && !Array.isArray(pending)) {
		const launch = pending as Record<string, unknown>;
		const projectPaths = [...new Set((Array.isArray(launch.projectPaths) ? launch.projectPaths : [])
			.map(normalizeClaudeChatProjectPath).filter((item): item is string => item !== undefined))];
		if (isClaudeChatLaunchMarker(launch.marker) && isMilliseconds(launch.startedAt) && projectPaths.length > 0) {
			result.pendingLaunch = { marker: launch.marker, projectPaths, startedAt: launch.startedAt };
		}
	}
	return result;
}

/** Повторяет кодирование CLI 2.1.234+: длинный путь получает 31-based hash, не произвольный slug. */
export function encodeClaudeChatProjectPath(projectPath: string): string {
	const encoded = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
	if (encoded.length <= 200) return encoded;
	let hash = 0;
	for (let index = 0; index < projectPath.length; index++) hash = ((hash << 5) - hash + projectPath.charCodeAt(index)) | 0;
	return `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

/** Ошибка контракта не выдаётся за отсутствие сессии или успешно измеренное нулевое время. */
export class ClaudeChatSessionError extends Error {
	/** Причина, пригодная для обработки manager без разбора локализованного текста. */
	readonly code: 'invalid-state' | 'unsafe-path' | 'ambiguous-session' | 'not-main-session'
		| 'unsupported-transcript' | 'session-changed' | 'sdk-error' | 'disposed';

	/** Создаёт безопасную диагностику без текста сообщений и значений настроек пользователя. */
	constructor(code: ClaudeChatSessionError['code'], message: string) {
		super(message);
		this.name = 'ClaudeChatSessionError';
		this.code = code;
	}
}

/** Минимальный узел ancestry: содержимое сообщений и результаты инструментов не удерживаются в памяти. */
interface TranscriptNode {
	/** Связи и вид записи нужны для отделения пользовательских запросов от tool_result и meta. */
	id: string;
	parentId: string | null;
	kind: string;
	userKind?: 'human' | 'tool' | 'meta';
	/** Время записи, финальная длительность и признак продолжающихся фоновых работ. */
	timestamp: number;
	durationMs?: number;
	pending: boolean;
	/** Только первый ограниченный префикс используется для проверки launch marker. */
	prefix?: string;
	cwd?: string;
}

/** Результат разбора включает ровно тот префикс, по которому разрешено подтвердить новую привязку. */
export interface ClaudeChatTranscriptAnalysis {
	/** Измеренное состояние; промежуточные фоновые длительности не начисляются. */
	snapshot: ClaudeChatSessionSnapshot;
	/** Первый обычный запрос позволяет проверить маркер, проект и время именно нового запуска. */
	firstUser?: { prefix: string; timestamp: number; cwd?: string };
}

/** Извлекает только ограниченный префикс настоящего запроса, не выдавая tool_result или meta за ввод пользователя. */
export function getClaudeChatHumanUser(entry: Record<string, unknown>): ClaudeChatTranscriptAnalysis['firstUser'] {
	if (entry.type !== 'user' || entry.isMeta || entry.isSynthetic || entry.isCompactSummary
		|| entry.isVisibleInTranscriptOnly || entry.isSidechain || entry.teamName || entry.agentId) return undefined;
	const content = (entry.message as Record<string, unknown> | undefined)?.content;
	const blocks = Array.isArray(content) ? content : [];
	if (blocks.some(block => block?.type === 'tool_result')) return undefined;
	const text = typeof content === 'string' ? content
		: blocks.filter(block => block?.type === 'text' && typeof block.text === 'string')
			.map(block => block.text as string).join('\n');
	const timestamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
	if (!isMilliseconds(timestamp)) return undefined;
	return { prefix: text.slice(0, 200), timestamp, cwd: normalizeClaudeChatProjectPath(entry.cwd) };
}

/** Потоковый разбор метаданных JSONL без хранения текста переписки; см. claudeChat.test.ts. */
export class ClaudeChatTranscriptAccumulator {
	/** Ограниченный граф содержит только связи, даты и длительности уникальных записей. */
	private readonly nodes = new Map<string, TranscriptNode>();
	/** Служебное название не влияет на пользовательские интервалы. */
	private customTitle: string | undefined;
	/** Корневой sidechain не становится пустой корректной сессией. */
	private sawSidechain = false;

	/** UUID задаётся после проверки пути и сопоставляется с каждой записью. */
	constructor(private readonly sessionId: string) {}

	/** Принимает одну законченную JSON-запись и оставляет только необходимые метаданные. */
	add(value: unknown): void {
		if (!value || typeof value !== 'object' || Array.isArray(value)) this.unsupported();
		const entry = value as Record<string, unknown>;
		if (entry.sessionId !== undefined && entry.sessionId !== this.sessionId) {
			throw new ClaudeChatSessionError('unsafe-path', 'Идентификатор внутри transcript не совпадает с привязкой.');
		}
		if (entry.forkedFrom || entry.parentSessionId) {
			throw new ClaudeChatSessionError('not-main-session', 'Копия или дочерняя сессия не подтверждает новый запуск.');
		}
		if (entry.isSidechain === true || entry.teamName || entry.agentId) {
			this.sawSidechain = true;
			return;
		}
		if (entry.type === 'custom-title') {
			if (typeof entry.customTitle === 'string') this.customTitle = entry.customTitle;
			return;
		}
		// Компактация и очередь имеют отдельную семантику ancestry; не восстанавливаем время предположениями.
		const attachment = entry.attachment as Record<string, unknown> | undefined;
		if (entry.isCompactSummary || entry.subtype === 'compact_boundary' || entry.type === 'compact_boundary'
			|| (attachment?.type === 'queued_command' && attachment.isMeta !== true)) this.unsupported();
		if (!['user', 'assistant', 'system', 'progress', 'attachment'].includes(String(entry.type))) return;
		if (!isClaudeChatSessionId(entry.uuid)
			|| (entry.parentUuid !== null && !isClaudeChatSessionId(entry.parentUuid))) this.unsupported();
		if (entry.sessionId !== this.sessionId) this.unsupported();
		const timestamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
		const isDuration = entry.type === 'system' && entry.subtype === 'turn_duration';
		if ((entry.type === 'user' || isDuration) && !isMilliseconds(timestamp)) this.unsupported();
		const node: TranscriptNode = {
			id: entry.uuid as string, parentId: entry.parentUuid as string | null,
			kind: String(entry.type), timestamp: Number.isFinite(timestamp) ? timestamp : 0, pending: false,
		};
		if (entry.type === 'user') {
			const message = entry.message as Record<string, unknown> | undefined;
			const content = message?.content;
			const blocks = Array.isArray(content) ? content : [];
			const toolResult = blocks.some(block => block?.type === 'tool_result');
			const synthetic = entry.isMeta === true || entry.isSynthetic === true || entry.isVisibleInTranscriptOnly === true;
			node.userKind = toolResult ? 'tool' : synthetic ? 'meta' : 'human';
			if (node.userKind === 'human') {
				const user = getClaudeChatHumanUser(entry);
				node.prefix = user?.prefix;
				node.cwd = user?.cwd;
			}
		}
		if (isDuration) {
			if (!isMilliseconds(entry.durationMs)) this.unsupported();
			for (const key of ['pendingBackgroundAgentCount', 'pendingWorkflowCount']) {
				if (entry[key] !== undefined && !isMilliseconds(entry[key])) this.unsupported();
			}
			node.durationMs = entry.durationMs as number;
			node.pending = Number(entry.pendingBackgroundAgentCount ?? 0) > 0 || Number(entry.pendingWorkflowCount ?? 0) > 0;
		}
		const previous = this.nodes.get(node.id);
		if (previous && JSON.stringify(previous) !== JSON.stringify(node)) this.unsupported();
		if (!previous) this.nodes.set(node.id, node);
		if (this.nodes.size > 100_000) this.unsupported();
	}

	/** Считает окончательные длительности по ancestry; неполная последняя строка запрещает completed. */
	finish(incomplete = false): ClaudeChatTranscriptAnalysis {
		const users = [...this.nodes.values()].filter(node => node.userKind === 'human');
		if (users.length === 0 && this.sawSidechain) {
			throw new ClaudeChatSessionError('not-main-session', 'Transcript относится к дочерней сессии.');
		}
		// Кэш ancestry предотвращает квадратичный проход больших последовательностей tool_result.
		const owners = new Map<string, TranscriptNode | undefined>();
		const owner = (id: string | null): TranscriptNode | undefined => {
			const visited = new Set<string>();
			let current = id;
			let found: TranscriptNode | undefined;
			while (current !== null) {
				if (visited.has(current)) this.unsupported();
				if (owners.has(current)) { found = owners.get(current); break; }
				visited.add(current);
				const node = this.nodes.get(current);
				if (!node) this.unsupported();
				if (node.userKind === 'human' || node.userKind === 'meta') { found = node; break; }
				current = node.parentId;
			}
			for (const key of visited) owners.set(key, found);
			return found;
		};
		const durations = new Map<string, TranscriptNode[]>();
		const positions = new Map([...this.nodes.keys()].map((id, index) => [id, index]));
		const lastActivity = new Map<string, number>();
		for (const node of this.nodes.values()) {
			if (node.kind === 'assistant' || node.userKind === 'tool' || node.userKind === 'meta') {
				const request = owner(node.parentId);
				if (request?.userKind === 'human') lastActivity.set(request.id, positions.get(node.id)!);
			}
			if (node.durationMs === undefined) continue;
			const request = owner(node.parentId);
			if (!request || request.userKind !== 'human') this.unsupported();
			const group = durations.get(request.id) ?? [];
			group.push(node);
			durations.set(request.id, group);
		}
		let totalElapsedMs = 0;
		let lastRequestEnded: number | undefined;
		for (let index = 0; index < users.length; index++) {
			const user = users[index];
			const previous = users[index - 1];
			if (owner(user.parentId)?.id !== previous?.id
				|| (previous && user.timestamp < previous.timestamp)) this.unsupported();
			const group = durations.get(user.id) ?? [];
			const final = group.filter(node => !node.pending);
			// Несколько финалов нельзя считать независимыми: они могут описывать один продолжающийся запрос.
			if (final.length > 1 || (final.length === 1 && group.at(-1) !== final[0])) this.unsupported();
			const ended = final[0];
			if (!ended) {
				if (index < users.length - 1) this.unsupported();
				continue;
			}
			if (ended.timestamp < user.timestamp || group.some(node => node.durationMs! > ended.durationMs!)
				|| (users[index + 1] && ended.timestamp > users[index + 1].timestamp)) this.unsupported();
			// Ответы после финала в той же ветви означают продолжение, которое нельзя объявить завершённым.
			if ((lastActivity.get(user.id) ?? -1) > positions.get(ended.id)!) this.unsupported();
			totalElapsedMs += ended.durationMs!;
			if (!Number.isSafeInteger(totalElapsedMs)) this.unsupported();
			if (index === users.length - 1) lastRequestEnded = ended.timestamp;
		}
		const first = users[0];
		const last = users.at(-1);
		return {
			snapshot: {
				totalElapsedMs, completed: lastRequestEnded !== undefined && !incomplete,
				...(this.customTitle !== undefined ? { customTitle: this.customTitle } : {}),
				...(last ? { lastRequestStarted: last.timestamp } : {}),
				...(lastRequestEnded !== undefined && !incomplete ? { lastRequestEnded } : {}),
			},
			...(first ? { firstUser: { prefix: first.prefix ?? '', timestamp: first.timestamp, cwd: first.cwd } } : {}),
		};
	}

	/** Прерывает расчёт, если формат не позволяет доказать точную длительность без догадок. */
	private unsupported(): never {
		throw new ClaudeChatSessionError('unsupported-transcript', 'Формат или связи transcript не позволяют точно учесть время.');
	}
}
