/** Привязка промпта к локальной сессии Claude и уже начисленному времени в миллисекундах. */
export interface ClaudeChatSessionBinding {
	/** UUID, подтверждённый точным маркером отправленного запроса. */
	sessionId: string;
	/** Абсолютный каталог проекта, в котором хранится эта сессия. */
	projectPath: string;
	/** Часть суммарного времени сессии, уже включённая во время промпта. */
	accountedMs: number;
	/** Момент окончания запроса, для которого уже выполнены действия завершения. */
	completionHandledAt?: number;
}

/** Незавершённая привязка нового чата; маркер относится только к одной попытке запуска. */
export interface ClaudeChatPendingLaunch {
	/** Полная служебная строка в начале первого пользовательского сообщения. */
	marker: string;
	/** Допустимые абсолютные каталоги проектов без поиска по другим рабочим областям. */
	projectPaths: string[];
	/** Время начала запуска в миллисекундах Unix. */
	startedAt: number;
}

/** Сохраняемое состояние Claude не смешивается с идентификаторами чатов Copilot. */
export interface ClaudeChatState {
	/** Проверенные сессии, включая прежние запуски этого промпта. */
	sessions: ClaudeChatSessionBinding[];
	/** Уже учтённое время Copilot при переключении цели чата, без потери начисленного времени Claude. */
	copilotAccountedMs?: number;
	/** Запуск, для которого ещё не найден единственный подтверждённый transcript. */
	pendingLaunch?: ClaudeChatPendingLaunch;
}

/** Проверенное состояние последнего запроса и завершённых интервалов работы. */
export interface ClaudeChatSessionSnapshot {
	/** Сумма только окончательных, неперекрывающихся длительностей в миллисекундах. */
	totalElapsedMs: number;
	/** Пользовательское название, сохранённое Claude через штатное переименование. */
	customTitle?: string;
	/** Время последнего настоящего пользовательского сообщения в миллисекундах Unix. */
	lastRequestStarted?: number;
	/** Время подтверждённого окончания последнего запроса в миллисекундах Unix. */
	lastRequestEnded?: number;
	/** Истинно только после окончательной длительности без незавершённых фоновых работ. */
	completed: boolean;
}

/** Уже разрешённый вызывающей стороной каталог Claude; настройки сервис не изменяет. */
export interface ClaudeChatConfiguration {
	/** Абсолютный эффективный CLAUDE_CONFIG_DIR, а не обязательно ~/.claude. */
	configDir: string;
	/** Штатный CLAUDE_CODE_PROJECT_DIR_NAME при его явном использовании. */
	projectDirName?: string;
}

/** Только необходимые метаданные публичного listSessions, без содержимого переписки. */
export interface ClaudeChatSessionInfo {
	/** UUID из публичного SDK. */
	sessionId: string;
	/** Первые 200 символов первого содержательного пользовательского сообщения. */
	firstPrompt?: string;
	/** Исходный или перенесённый рабочий каталог, если он известен SDK. */
	cwd?: string;
}

/** Подменяемые операции SDK позволяют тестировать сервис без CLI и учётных записей. */
export interface ClaudeChatSdkAdapter {
	/** Читает ограниченный список метаданных только одного проекта. */
	listSessions(options: {
		dir: string;
		includeWorktrees: false;
		includeProgrammatic: false;
		limit: number;
	}): Promise<ClaudeChatSessionInfo[]>;
	/** Переименовывает существующую сессию официальным API без запуска модели. */
	renameSession(sessionId: string, title: string, options: { dir: string }): Promise<void>;
}
