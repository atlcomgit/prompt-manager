/** Область каталога определяет, в каких рабочих пространствах видна запись. */
export type BashScriptScope = 'project' | 'global';

export interface BashScriptRef {
	scope: BashScriptScope;
	id: string;
}

/** Неизвестный результат сохраняется без кода завершения. */
export interface BashScriptRun {
	id: string;
	startedAt: string;
	finishedAt?: string;
	exitCode?: number;
	/** Закрытие вкладки может произойти намного позже завершения команды. */
	endedBy?: 'shell' | 'terminal';
}

export interface BashScriptEntry extends BashScriptRef {
	name: string;
	path: string;
	absolutePath: string;
	/** Ближайший корень рабочей папки или известного Git-репозитория на момент чтения каталога. */
	project?: { root: string; name: string; relativePath: string };
	available: boolean;
	history: BashScriptRun[];
	/** Только запуски, для которых этот хост ещё наблюдает терминал. */
	activeRunIds?: string[];
}

/** Один запрос относится к одному диалогу или действию строки. */
export interface BashScriptsRequest {
	type: 'bashScriptsRequest';
	requestId: string;
	action: 'list' | 'scan' | 'run' | 'hide' | 'choose' | 'read' | 'save' | 'openFile';
	ref?: BashScriptRef;
	scope?: BashScriptScope;
	path?: string;
	name?: string;
	content?: string;
	revision?: string;
	base?: { name: string; path: string };
}

export interface BashScriptsResult {
	entries?: BashScriptEntry[];
	warning?: string;
	exists?: boolean;
	nativeEditorReason?: string;
	path?: string;
	content?: string;
	revision?: string;
}

export interface BashScriptsResponse {
	type: 'bashScriptsResponse';
	requestId: string;
	result?: BashScriptsResult;
	error?: string;
}
