/** Тип обычной сессии Copilot Chat: её модель хранится в общих ключах и здесь не переприменяется. */
const LOCAL_CHAT_SESSION_TYPE = 'local';

/** Ключ состояния VS Code с типом сессии, который получает новый чат (например, `agent-host-codex`). */
export const USER_SELECTED_CHAT_SESSION_TYPE_STATE_KEY = 'chat.userSelectedSessionType';

/** Тип сессии Copilot Chat для Codex, работающего через Agent Host. */
export const CODEX_AGENT_HOST_SESSION_TYPE = 'agent-host-codex';

/** Возвращает true, если новый чат будет сессией Codex через Agent Host. */
export function isCodexAgentHostSessionType(sessionType: string | undefined | null): boolean {
	return String(sessionType || '').trim() === CODEX_AGENT_HOST_SESSION_TYPE;
}

/**
 * Настройка VS Code с режимом новой пустой сессии чата. VS Code применяет её повторно, когда у новой
 * сессии меняется список режимов, поэтому режим Agent включается и в Codex, где он появляется позже Ask.
 */
export const NEW_CHAT_SESSION_DEFAULT_MODE_SECTION = 'chat';
export const NEW_CHAT_SESSION_DEFAULT_MODE_KEY = 'newSession.defaultMode';
export const NEW_CHAT_SESSION_AGENT_MODE = 'agent';

/** Значения настройки по уровням, как их возвращает `WorkspaceConfiguration.inspect`. */
export type InspectedStringSetting = {
	globalValue?: unknown;
	workspaceValue?: unknown;
	workspaceFolderValue?: unknown;
};

/**
 * Возвращает true, если пользователь нигде не задавал режим новой сессии и его можно выставить в Agent.
 * Заданное пользователем значение (даже другое) не перезаписывается.
 */
export function shouldSetNewSessionDefaultAgentMode(inspected: InspectedStringSetting | undefined): boolean {
	const userValues = [inspected?.globalValue, inspected?.workspaceValue, inspected?.workspaceFolderValue];
	return !userValues.some(value => typeof value === 'string' && value.trim() !== '');
}

/**
 * Режим чата для запуска промпта. Для Codex всегда используется Agent: режима Plan в сессии Codex нет,
 * и без явного Agent новый чат остаётся в Ask.
 */
export function resolveChatModeForSessionType(
	promptChatMode: string | undefined | null,
	sessionType: string | undefined | null,
): 'agent' | 'plan' {
	if (isCodexAgentHostSessionType(sessionType)) {
		return 'agent';
	}
	return promptChatMode === 'plan' ? 'plan' : 'agent';
}

/** Минимальная запись кеша моделей VS Code, нужная для проверки модели типа сессии. */
export type CachedSessionTypeModelEntry = {
	identifier?: string;
	metadata?: {
		id?: string;
		vendor?: string;
		isUserSelectable?: boolean;
		targetChatSessionType?: string;
	};
};

/** Запомненная модель типа сессии и селектор для `workbench.action.chat.open`. */
export type SessionTypeModelSelection = {
	sessionType: string;
	identifier: string;
	selector: {
		vendor: string;
		id: string;
	};
};

/** Возвращает ключ состояния VS Code, где панель чата помнит модель для указанного типа сессии. */
export function getSessionTypePanelModelStateKey(sessionType: string): string {
	return `chat.currentLanguageModel.panel.${sessionType}`;
}

/**
 * Находит запомненную модель для выбранного типа сессии чата (например, Codex через Agent Host).
 * Возвращает `undefined` для обычной сессии, неизвестной модели или модели другого типа сессии,
 * чтобы не подставить в чат модель, которую выбранный тип сессии не поддерживает.
 */
export function resolveSessionTypeRememberedModel(
	sessionType: string | undefined | null,
	rememberedIdentifier: string | undefined | null,
	cachedModels: CachedSessionTypeModelEntry[],
): SessionTypeModelSelection | undefined {
	const normalizedSessionType = String(sessionType || '').trim();
	const identifier = String(rememberedIdentifier || '').trim();
	if (!normalizedSessionType || normalizedSessionType === LOCAL_CHAT_SESSION_TYPE) {
		return undefined;
	}
	if (!identifier.startsWith(`${normalizedSessionType}:`)) {
		return undefined;
	}

	const entry = cachedModels.find(candidate => String(candidate?.identifier || '').trim() === identifier);
	const metadata = entry?.metadata;
	const vendor = String(metadata?.vendor || '').trim();
	const id = String(metadata?.id || '').trim();
	if (!metadata || !vendor || !id || metadata.isUserSelectable === false) {
		return undefined;
	}
	if (String(metadata.targetChatSessionType || '').trim() !== normalizedSessionType) {
		return undefined;
	}

	return {
		sessionType: normalizedSessionType,
		identifier,
		selector: { vendor, id },
	};
}
