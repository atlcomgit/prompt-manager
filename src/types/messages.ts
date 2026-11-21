/**
 * Message types for communication between extension and webviews
 */

import type { ChatMemorySummary, EditorPromptViewState, EditorPromptPlanViewMode, Prompt, PromptConfig, PromptContextFileCard, PromptCustomGroup, SidebarState, PromptStatistics, PromptStatus } from './prompt.js';
import type { GitOverlayActionKind, GitOverlayChangeFile, GitOverlayChangeGroup, GitOverlayFileHistoryPayload, GitOverlayProjectCommitMessage, GitOverlayProjectReviewRequestInput, GitOverlayProjectSnapshot, GitOverlayReviewCliSetupRequest, GitOverlaySnapshot } from './git.js';
import type { DockerComposeProjectActionKind, DockerContainerActionKind, DockerWorkspaceActionKind } from './docker.js';
import type { DashboardQuickCommandEdit, DashboardQuickCommandTarget, DashboardQuickNotesWidgetState, PromptDashboardPreferences } from './promptDashboardPreferences.js';
import type { QuickCommandTemplateResult } from '../utils/quickCommandTemplate.js';
import type {
	QuickNoteAttachSource,
	QuickNoteChecklistSuggestionInput,
	QuickNoteFile,
	QuickNoteOperation,
	QuickNoteOperationResult,
	QuickNoteScope,
	QuickNotesState,
} from './quickNotes.js';
import type { PromptEditorLayout, PromptUiSettingsSnapshot } from './promptEditorLayout.js';
import type { PromptHoverTarget, PromptHoverPreviewResult } from './promptHoverPreview.js';
import type {
	PromptDashboardAnalysisState,
	PromptDashboardCollapsedSections,
	PromptDashboardLayoutMode,
	PromptDashboardLayouts,
	PromptDashboardSectionOrder,
	PromptDashboardSectionKey,
	PromptDashboardSnapshot,
	PromptDashboardWidgetKind,
	PromptDashboardWidgetSnapshot,
} from './promptDashboard.js';

export type GlobalContextSourceMessage = 'empty' | 'manual' | 'remote';
export type ChatContextAutoLoadStateMessage = 'started' | 'completed' | 'fallback';
export type PromptVoiceDebugDetails = Record<string, string | number | boolean | null | undefined>;

export type GitOverlayBusyReason =
	| { kind: 'label'; label: string }
	| { kind: 'file'; filePath: string }
	| { kind: 'git' };

export interface ClipboardImagePayload {
	mimeType: string;
	dataBase64: string;
}

/** Target prompt identity used by prompt-open flows before full prompt data loads. */
export interface PromptOpenTarget {
	id: string;
	promptUuid?: string;
}

// ---- Messages FROM webview TO extension ----

export type WebviewToExtensionMessage =
	| { type: 'ready'; bootId?: string; assetVersion?: string }
	| { type: 'getPrompts' }
	/** Чтение текста для одной карточки без открытия редактора и побочных записей. */
	| { type: 'getPromptHoverPreview'; target: PromptHoverTarget; requestId: string }
	| { type: 'getPrompt'; id: string }
	| {
		type: 'savePrompt';
		prompt: Prompt;
		source?: 'manual' | 'status-change' | 'autosave';
		requestId?: string;
		localRevision?: number;
	}
	| { type: 'deletePrompt'; id: string }
	| { type: 'duplicatePrompt'; id: string }
	| { type: 'createPrompt' }
	| ({ type: 'openPrompt' } & PromptOpenTarget)
	| { type: 'importPrompt' }
	| { type: 'exportPrompt'; id: string }
	| { type: 'startChatPreflight'; id: string; prompt?: Prompt; forceRebindChat?: boolean; requestId?: string }
	| {
		type: 'startChat';
		id: string;
		prompt?: Prompt;
		forceRebindChat?: boolean;
		requestId?: string;
		skipBranchMismatchCheck?: boolean;
		originalStatus?: PromptStatus;
		globalContext?: string;
		globalContextSource?: GlobalContextSourceMessage;
	}
	| { type: 'openChat'; id: string; sessionId: string }
	| { type: 'stopChat'; id?: string }
	| { type: 'generateTitle'; content: string }
	| { type: 'generateDescription'; content: string }
	| { type: 'generateSlug'; title: string; description: string }
	| { type: 'improvePromptText'; content: string; projects?: string[] }
	| { type: 'generateReportFromStagedChanges'; prompt: Prompt }
	| { type: 'saveSidebarState'; state: SidebarState }
	| { type: 'savePromptEditorViewState'; promptId?: string; promptUuid?: string; state: EditorPromptViewState }
	/** Persist a user-selected plan view separately from layout snapshots to prevent stale overwrites. */
	| { type: 'savePromptPlanViewMode'; promptId?: string; promptUuid?: string; mode: EditorPromptPlanViewMode }
	/** Глобальное представление формы сохраняется отдельно от локальной вкладки Process. */
	| { type: 'savePromptEditorLayout'; state: PromptEditorLayout; baseState?: PromptEditorLayout; requestId: string }
	/** requestId связывает подтверждение записи с действием; старые webview могут его не передавать. */
	| { type: 'savePromptDashboardCollapsedSections'; state: PromptDashboardCollapsedSections; baseState?: PromptDashboardCollapsedSections; layoutMode?: PromptDashboardLayoutMode; requestId?: string }
	| { type: 'savePromptDashboardSectionOrder'; order: PromptDashboardSectionOrder; layoutMode?: PromptDashboardLayoutMode; requestId?: string }
	/** Полный снимок внутренних настроек; пустые поля являются явным сохранённым выбором. */
	| { type: 'savePromptDashboardPreferences'; state: PromptDashboardPreferences; baseState?: PromptDashboardPreferences; requestId?: string }
	| { type: 'savePromptDashboardQuickCommand'; edit: DashboardQuickCommandEdit; migration?: PromptDashboardPreferences; requestId: string }
	| { type: 'promptDashboardLayoutModeChanged'; layoutMode: PromptDashboardLayoutMode }
	| { type: 'getSidebarState' }
	| { type: 'getWorkspaceFolders' }
	| { type: 'getAvailableModels' }
	| { type: 'getAvailableSkills' }
	| { type: 'getAvailableMcpTools' }
	| { type: 'getAvailableHooks' }
	| { type: 'toggleFavorite'; id: string }
	| { type: 'checkBranchStatus'; branch: string; projects: string[] }
	| { type: 'switchBranch'; branch: string; projects: string[] }
	| { type: 'getBranches'; projects: string[] }
	| { type: 'getPromptDashboardSnapshot'; prompt: Prompt; requestId?: string; forceRefresh?: boolean }
	| { type: 'refreshPromptDashboard'; prompt: Prompt; requestId?: string }
	| {
		type: 'refreshPromptDashboardWidget';
		prompt: Prompt;
		widget: PromptDashboardWidgetKind;
		section?: PromptDashboardSectionKey;
		requestId?: string;
	}
	| {
		type: 'hydratePromptDashboardProjectsDetails';
		prompt: Prompt;
		projects?: string[];
		requestId?: string;
		reason?: 'details' | 'dirty-files';
	}
	| { type: 'promptDashboardPullProject'; prompt: Prompt; project: string; requestId?: string }
	| { type: 'promptDashboardSwitchBranch'; prompt: Prompt; project: string; branch: string; requestId?: string }
	| { type: 'promptDashboardSwitchBranches'; prompt: Prompt; branchesByProject: Record<string, string>; requestId?: string }
	| { type: 'promptDashboardDockerAction'; prompt?: Prompt; containerId: string; action: DockerContainerActionKind; requestId?: string }
	| { type: 'promptDashboardDockerWorkspaceAction'; prompt?: Prompt; action: DockerWorkspaceActionKind; requestId?: string }
	| { type: 'promptDashboardDockerComposeAction'; prompt?: Prompt; projectPath: string; composeFilePath: string; action: DockerComposeProjectActionKind; requestId?: string }
	| { type: 'promptDashboardOpenDockerComposeFile'; projectPath: string; composeFilePath: string; requestId?: string }
	| { type: 'promptDashboardOpenDockerLogs'; containerId: string; requestId?: string }
	| { type: 'promptDashboardOpenDockerTerminal'; containerId: string; requestId?: string }
	| { type: 'promptDashboardDockerLiveMetricsVisibility'; visible: boolean }
	| { type: 'promptDashboardOpenFilePatch'; project: string; filePath: string; previousPath?: string; mode: 'commit' | 'branch'; ref: string; baseRef?: string }
	| { type: 'promptDashboardOpenTodoMarker'; project: string; filePath: string; line: number; column?: number; requestId?: string }
	| { type: 'analyzePromptDashboardReview'; prompt: Prompt; requestId?: string }
	/** До передачи текста клиент удостоверяется, что хост доступен и пользователь ещё ожидает вставку. */
	| { type: 'promptDashboardQuickCommandPrepare'; requestId: string }
	| { type: 'promptDashboardQuickCommandInsert'; requestId: string; promptId: string; promptUuid: string; text: string; target: DashboardQuickCommandTarget; hostDeadline: number }
	| { type: 'promptDashboardQuickCommandCopy'; promptId: string; promptUuid: string; text: string }
	| { type: 'promptDashboardQuickCommandPreview'; requestId: string; promptId: string; promptUuid: string; text: string }
	/** Быстрые заметки: состояние обеих областей и операции; ответы приходят адресно по requestId. */
	| { type: 'quickNotesRequestState'; requestId?: string }
	| { type: 'quickNotesSetDescriptionHeight'; height: number }
	| { type: 'quickNotesApply'; operation: QuickNoteOperation; requestId: string }
	/** Копирует файлы во временную папку черновика окна заметки. */
	| { type: 'quickNotesAttach'; scope: QuickNoteScope; draftId: string; source: QuickNoteAttachSource; requestId: string }
	/** Blocks of local files uploaded by a browser while connected to VS Code Remote Tunnel. */
	| { type: 'quickNotesUploadChunk'; scope: QuickNoteScope; draftId: string; requestId: string;
		uploadId: string; name: string; fileSize: number; chunkIndex: number; chunkCount: number; dataBase64: string }
	| { type: 'quickNotesCancelUpload'; scope: QuickNoteScope; draftId: string; uploadId: string }
	/** Удаляет временные копии отменённого черновика. */
	| { type: 'quickNotesDiscardDraft'; scope: QuickNoteScope; draftId: string }
	/** Удалить только несохранённую копию файла, сохранив исходное вложение до Save. */
	| { type: 'quickNotesRemoveDraftFile'; scope: QuickNoteScope; draftId: string; storedName: string; requestId: string }
	| { type: 'quickNotesOpenFile'; scope: QuickNoteScope; noteId: string; storedName: string; draftId?: string }
	/** Открывает quick-notes.json области, например при ошибке чтения. */
	| { type: 'quickNotesOpenStorageFile'; scope: QuickNoteScope }
	| { type: 'quickNotesCreatePrompt'; scope: QuickNoteScope; noteId: string; requestId: string }
	| { type: 'quickNotesOpenPrompt'; promptId: string; promptUuid?: string }
	| { type: 'quickNotesSuggestItem'; input: QuickNoteChecklistSuggestionInput; requestId: string }
	/** Открывает страницу доски заметок отдельной вкладкой редактора. */
	| { type: 'quickNotesOpenBoard' }
	/** Страница доски запрашивает и сохраняет вид заметок; base защищает параллельные правки других полей. */
	| { type: 'quickNotesRequestPreferences' }
	| { type: 'quickNotesSavePreferences'; state: DashboardQuickNotesWidgetState; baseState?: DashboardQuickNotesWidgetState }
	| { type: 'openGitOverlay'; promptBranch: string; projects: string[] }
	| { type: 'gitOverlayVisibility'; open: boolean; promptBranch: string; projects: string[] }
	| { type: 'refreshGitOverlay'; promptBranch: string; projects: string[]; mode?: 'local' | 'fetch' | 'sync' }
	| { type: 'gitOverlayHydrateProjectDetails'; promptBranch: string; projects: string[]; project: string; snapshotGeneratedAt: string }
	| { type: 'saveGitOverlayTrackedBranchPreference'; branch: string; branchesByProject?: Record<string, string> }
	| { type: 'gitOverlayApplyBranchTargets'; promptBranch: string; projects: string[]; sourceBranchesByProject?: Record<string, string>; targetBranchesByProject?: Record<string, string> }
	| { type: 'gitOverlaySwitchBranch'; promptBranch: string; projects: string[]; branch?: string; trackedBranchesByProject?: Record<string, string> }
	| { type: 'gitOverlayEnsurePromptBranch'; promptBranch: string; projects: string[]; trackedBranch?: string; trackedBranchesByProject?: Record<string, string> }
	| { type: 'gitOverlayMergePromptBranch'; promptBranch: string; projects: string[]; trackedBranch?: string; trackedBranchesByProject?: Record<string, string>; stayOnTrackedBranch?: boolean }
	| { type: 'gitOverlayDeleteBranch'; promptBranch: string; projects: string[]; branch: string }
	| { type: 'gitOverlayPush'; promptBranch: string; projects: string[]; branch?: string }
	| { type: 'gitOverlayStageAll'; promptBranch: string; projects: string[]; project?: string; trackedOnly?: boolean }
	| { type: 'gitOverlayUnstageAll'; promptBranch: string; projects: string[]; project?: string }
	| { type: 'gitOverlayStageFile'; promptBranch: string; projects: string[]; project: string; filePath: string }
	| { type: 'gitOverlayUnstageFile'; promptBranch: string; projects: string[]; project: string; filePath: string }
	| { type: 'gitOverlayDiscardFile'; promptBranch: string; projects: string[]; project: string; filePath: string; previousPath?: string; group: GitOverlayChangeGroup }
	| { type: 'gitOverlayDiscardProjectChanges'; promptBranch: string; projects: string[]; project: string; changes: GitOverlayChangeFile[] }
	| { type: 'gitOverlayLoadFileHistory'; project: string; filePath: string }
	| { type: 'gitOverlayOpenFile'; project: string; filePath: string }
	/** Виджет передаёт выбранную группу изменений, даже если SCM ещё не обновил список. */
	| { type: 'gitOverlayOpenDiff'; project: string; filePath: string; change?: GitOverlayChangeFile }
	| { type: 'gitOverlayOpenMergeEditor'; project: string; filePath: string }
	| { type: 'gitOverlayOpenReviewRequest'; url: string }
	| { type: 'gitOverlaySetupReviewCli'; request: GitOverlayReviewCliSetupRequest }
	| { type: 'gitOverlayAssignReviewProvider'; host: string; provider: 'github' | 'gitlab'; promptBranch: string; projects: string[] }
	| { type: 'gitOverlayGenerateCommitMessage'; prompt: Prompt; project?: string; projects?: string[]; includeAllChanges?: boolean; requestId?: string }
	/** Подтверждает применение внешних commit messages в состоянии Git Flow webview. */
	| { type: 'gitOverlayCommitMessagesApplied'; cleanupTokens: string[]; requestId?: string }
	| { type: 'gitOverlayCommitStaged'; prompt: Prompt; messages: GitOverlayProjectCommitMessage[]; includeAllChanges?: boolean; requestId?: string }
	| {
		type: 'gitOverlayCreateReviewRequest';
		prompt: Prompt;
		promptBranch?: string;
		projects?: string[];
		requests: GitOverlayProjectReviewRequestInput[];
		requestId?: string;
	}
	| { type: 'updateTimeSpent'; id: string; field: 'timeSpentWriting' | 'timeSpentImplementing'; delta: number }
	| { type: 'pickFile' }
	| { type: 'pickHttpExamplesFile' }
	| { type: 'pasteClipboardImages'; promptId?: string; images: ClipboardImagePayload[] }
	| { type: 'pasteFilesFromClipboard' }
	| { type: 'pasteFiles'; files: string[] }
	| { type: 'requestContextFileCards'; files: string[]; requestId?: string }
	| { type: 'openFile'; file: string }
	| { type: 'requestSuggestion'; textBefore: string; globalContext?: string }
	| { type: 'getStatistics'; dateFrom?: string; dateTo?: string; minFiveMin?: boolean }
	| { type: 'getStatisticsUiState' }
	| { type: 'saveStatisticsUiState'; hourlyRateInput: string }
	| {
		type: 'exportReport';
		format: 'html' | 'md';
		rows: Array<{ taskNumber: string; title: string; hours: number; status?: PromptStatus; reportSummary?: string }>;
		hourlyRate?: number;
		includeReport?: boolean;
		showHours?: boolean;
		showCost?: boolean;
		/** actual uses reportRows totalTime; scaled uses the positive Hours input. */
		hoursMode?: 'actual' | 'scaled';
		/** Full date range displayed in generated statistics documents. */
		period?: { dateFrom: string; dateTo: string };
	}
	/** Export the currently visible statistics table rows to a real XLSX workbook. */
	| { type: 'exportStatisticsXlsx'; rows: PromptStatistics['reportRows'] }
	| {
		type: 'markDirty';
		dirty: boolean;
		prompt?: Prompt;
		promptId?: string;
		configFieldChangedAt?: Record<string, number>;
		localRevision?: number;
	}
	| { type: 'showStatistics' }
	| { type: 'updatePromptStatus'; id: string; status: PromptStatus }
	| { type: 'moveAllPromptsToNextStatus'; status: PromptStatus }
	| { type: 'moveSelectedPromptsToStatus'; ids: string[]; status: PromptStatus }
	| { type: 'archivePrompts'; ids: string[] }
	| { type: 'getGlobalContext' }
	| { type: 'getProjectInstructions' }
	| { type: 'saveGlobalContext'; context: string }
	| { type: 'saveProjectInstructions'; content: string }
	| { type: 'loadRemoteGlobalContext' }
	| { type: 'createBranch'; branch: string; projects: string[] }
	| { type: 'openPromptContentInEditor'; content: string; promptId?: string; title?: string }
	| { type: 'openPromptReportInEditor'; report: string; promptId?: string; title?: string }
	| { type: 'openPromptConfigInEditor'; promptId?: string }
	| { type: 'openProjectInstructionsInEditor' }
	| { type: 'openPromptPlanInEditor'; promptId?: string }
	| { type: 'requestPromptPlanState'; promptId?: string }
	| { type: 'showPromptHistory'; id: string }
	| { type: 'recalcImplementingTime'; id: string; silent?: boolean }
	| { type: 'getNextTaskNumber' }
	| { type: 'openChatPanel' }
	| { type: 'startPromptVoiceRecording'; sessionId: string }
	| { type: 'pausePromptVoiceRecording'; sessionId: string }
	| { type: 'resumePromptVoiceRecording'; sessionId: string }
	| { type: 'markPromptVoiceManualConfirmIntent'; sessionId: string }
	| { type: 'confirmPromptVoiceRecording'; sessionId: string }
	| { type: 'cancelPromptVoiceRecording'; sessionId: string }
	| { type: 'promptVoiceDebugEvent'; sessionId?: string; event: string; status?: string; details?: PromptVoiceDebugDetails }
	| { type: 'reportEditorReady'; promptId: string }
	| { type: 'reportEditorUpdate'; promptId: string; report: string; previousReport?: string; activityDeltaMs?: number }
	| { type: 'reportEditorSave'; promptId: string; report: string; previousReport?: string; activityDeltaMs?: number }
	| { type: 'reportEditorGenerate'; promptId: string }
	| { type: 'mainReportUpdate'; promptId: string; report: string }
	| { type: 'getCustomGroups' }
	| { type: 'createCustomGroup'; group: { name: string; color?: string; order?: number } }
	| { type: 'updateCustomGroup'; id: string; patch: { name?: string; color?: string; order?: number } }
	| { type: 'deleteCustomGroup'; id: string }
	| { type: 'replaceCustomGroups'; groups: Array<Partial<PromptCustomGroup>> }
	| { type: 'updatePromptCustomGroups'; id: string; customGroupIds: string[] }
	| { type: 'quickAddPrompt'; content: string }
	| { type: 'debugLog'; scope: string; message: string; payload?: unknown };

// ---- Messages FROM extension TO webview ----

export type ExtensionToWebviewMessage =
	| { type: 'prompts'; prompts: PromptConfig[]; archivedPrompts?: PromptConfig[] }
	/** Ответ применяется только к текущему наведению и точной identity строки. */
	| { type: 'promptHoverPreview'; target: PromptHoverTarget; requestId: string; result: PromptHoverPreviewResult }
	| {
		type: 'prompt';
		prompt: Prompt | null;
		reason?: 'open' | 'save' | 'sync' | 'ai-enrichment' | 'external-config';
		previousId?: string;
		requestId?: string;
		openRequestVersion?: number;
		editorViewState?: EditorPromptViewState;
		editorLayout?: PromptEditorLayout;
		/** Независимые настройки обеих ширин панели. */
		promptDashboardLayouts?: PromptDashboardLayouts;
		/** Отсутствие записи сохраняет возможность переноса legacy-настроек webview. */
		promptDashboardPreferences?: PromptDashboardPreferences;
		promptDashboardCollapsedSections?: PromptDashboardCollapsedSections;
		promptDashboardSectionOrder?: PromptDashboardSectionOrder;
		aiEnrichment?: { title: boolean; description: boolean };
	}
	| { type: 'promptAgentProgress'; promptId: string; promptUuid?: string; progress?: number }
	| { type: 'promptSaved'; prompt: PromptConfig; previousId?: string; requestId?: string }
	| { type: 'promptAiEnrichmentState'; promptId: string; promptUuid?: string; title: boolean; description: boolean }
	| { type: 'promptDeleted'; id: string }
	| { type: 'promptDuplicated'; prompt: PromptConfig }
	| { type: 'sidebarState'; state: SidebarState }
	| { type: 'sidebarSelectionChanged'; id: string | null }
	| { type: 'workspaceFolders'; folders: string[] }
	| { type: 'availableModels'; models: Array<{ id: string; name: string }> }
	| { type: 'availableSkills'; skills: Array<{ id: string; name: string; description: string }> }
	| { type: 'availableMcpTools'; tools: Array<{ id: string; name: string; description: string }> }
	| { type: 'availableHooks'; hooks: Array<{ id: string; name: string; description: string }> }
	| { type: 'allowedBranches'; branches: string[] }
	| { type: 'generatedTitle'; title: string }
	| { type: 'generatedDescription'; description: string }
	| { type: 'generatedSlug'; slug: string }
	| { type: 'improvedPromptText'; content: string }
	| { type: 'generatedReport'; report: string }
	| { type: 'gitOverlaySnapshot'; snapshot: GitOverlaySnapshot; requestId?: string }
	| { type: 'gitOverlayOtherProjectsSnapshot'; otherProjects: GitOverlaySnapshot['projects'] }
	| { type: 'gitOverlayProjectSnapshot'; projectSnapshot: GitOverlayProjectSnapshot; snapshotGeneratedAt: string }
	| { type: 'gitOverlayBusy'; action: string | null; reason?: GitOverlayBusyReason | null }
	| { type: 'gitOverlayFileHistory'; history: GitOverlayFileHistoryPayload }
	| {
		type: 'gitOverlayCommitMessagesGenerated';
		messages: Array<GitOverlayProjectCommitMessage & { scmCleanupToken?: string }>;
		requestId?: string;
	}
	| { type: 'gitOverlayActionCompleted'; action: GitOverlayActionKind }
	| { type: 'branches'; branches: Array<{ name: string; current: boolean; project: string }> }
	| { type: 'promptDashboardSnapshot'; snapshot: PromptDashboardSnapshot; requestId?: string }
	/** Подтверждает локальную запись настройки; облачная доставка выполняется Settings Sync отдельно. */
	| { type: 'promptDashboardStateSaved'; requestId: string; settings?: PromptUiSettingsSnapshot }
	| { type: 'promptDashboardQuickCommandSaved'; requestId: string; settings: PromptUiSettingsSnapshot; error?: string }
	| { type: 'promptDashboardQuickCommandReady'; requestId: string; hostTime: number }
	| { type: 'promptDashboardQuickCommandFinished'; requestId: string; expired?: boolean }
	| { type: 'promptDashboardQuickCommandPreviewResult'; requestId: string; result: QuickCommandTemplateResult }
	| { type: 'promptDashboardQuickCommandPreviewInvalidated' }
	/** Изменения из другого окна применяются отдельно от одноразовой начальной гидратации. */
	| { type: 'promptUiSettingsChanged'; settings: PromptUiSettingsSnapshot }
	| { type: 'promptDashboardWidgetSnapshot'; promptId: string; promptUuid?: string; widget: PromptDashboardWidgetSnapshot<unknown>; requestId?: string }
	/** Завершает dashboard request, который host безопасно отбросил после collapse race. */
	| { type: 'promptDashboardRequestCompleted'; requestId: string; target: PromptDashboardWidgetKind }
	| { type: 'promptDashboardAnalysis'; promptId: string; promptUuid?: string; analysis: PromptDashboardAnalysisState; requestId?: string }
	/** Полное состояние заметок; requestId и result подтверждают операцию отправившей панели. */
	| { type: 'quickNotesState'; state: QuickNotesState; requestId?: string; result?: QuickNoteOperationResult; generatingTitleKeys?: string[]; descriptionHeight?: number }
	| { type: 'quickNotesTitleGeneration'; generatingTitleKeys: string[] }
	/** Добавленные в черновик копии с адресами превью изображений для текущей панели. */
	| {
		type: 'quickNotesAttached';
		requestId: string;
		draftId: string;
		files: QuickNoteFile[];
		previewUris: Record<string, string>;
		skipped: string[];
		error?: string;
	}
	| { type: 'quickNotesUploadResult'; requestId: string; draftId: string; file?: QuickNoteFile; previewUri?: string; error?: string }
	| { type: 'quickNotesDraftFileRemoved'; requestId: string; ok: boolean; error?: string }
	| { type: 'quickNotesPromptCreated'; requestId: string; ok: boolean; promptTitle?: string; message?: string }
	/** Пустой text вместе с error означает, что пункт предложить не удалось. */
	| { type: 'quickNotesSuggestion'; requestId: string; text: string; error?: string }
	/** Актуальный вид заметок для страницы доски. */
	| { type: 'quickNotesPreferences'; state: DashboardQuickNotesWidgetState }
	| { type: 'branchStatus'; hasChanges: boolean; details: string }
	| { type: 'error'; message: string; requestId?: string; retainPromptDashboardBusy?: boolean }
	| { type: 'info'; message: string; requestId?: string; retainPromptDashboardBusy?: boolean }
	| { type: 'clearNotice' }
	| { type: 'pickedFiles'; files: string[] }
	| { type: 'contextFileCards'; files: PromptContextFileCard[]; requestId?: string }
	| { type: 'pickedHttpExamplesFile'; file: string }
	| { type: 'inlineSuggestion'; suggestion: string }
	| { type: 'inlineSuggestions'; suggestions: string[] }
	| { type: 'statistics'; data: PromptStatistics }
	| { type: 'statisticsUiState'; hourlyRateInput: string }
	| {
		type: 'globalContext';
		context: string;
		canLoadRemote: boolean;
		autoLoadEnabled: boolean;
		source: GlobalContextSourceMessage;
	}
	| {
		type: 'globalContextLoaded';
		context: string;
		canLoadRemote: boolean;
		autoLoadEnabled: boolean;
		source: GlobalContextSourceMessage;
	}
	| { type: 'globalContextLoadFailed'; message: string }
	| { type: 'projectInstructions'; content: string; exists: boolean }
	| { type: 'gitOverlayTrackedBranchPreference'; branch: string; branchesByProject?: Record<string, string> }
	| { type: 'availableLanguages'; options: Array<{ id: string; name: string }> }
	| { type: 'availableFrameworks'; options: Array<{ id: string; name: string }> }
	| { type: 'startChatPreflightResult'; requestId?: string; shouldOpenGitFlow: boolean; snapshot?: GitOverlaySnapshot }
	| { type: 'triggerStartChat'; promptId?: string }
	| { type: 'promptSaving'; id: string; promptUuid?: string; saving: boolean; requestId?: string }
	| { type: 'triggerCreatePrompt' }
	| { type: 'chatStarted'; promptId: string; requestId?: string }
	| { type: 'chatContextAutoLoadState'; promptId: string; requestId?: string; state: ChatContextAutoLoadStateMessage }
	| { type: 'chatRequestStarted'; promptId: string; requestId?: string; sessionId?: string }
	| { type: 'chatMemorySummary'; promptId: string; memorySummary: ChatMemorySummary }
	| { type: 'promptContentUpdated'; content: string; writingDeltaMs?: number }
	| { type: 'reportContentUpdated'; report: string; timeSpentWriting?: number; timeSpentOnTask?: number; updatedAt?: string }
	| { type: 'promptPlanUpdated'; promptId?: string; exists: boolean; content: string }
	| { type: 'contentEditorOpened' }
	| { type: 'contentEditorClosed'; reverted: boolean; content: string }
	| { type: 'contentEditorSaved' }
	| { type: 'reportEditorInit'; promptId: string; title: string; report: string }
	| { type: 'reportEditorExternalUpdate'; report: string; updatedAt?: string }
	| { type: 'reportEditorSynced'; report: string; updatedAt?: string }
	| { type: 'reportEditorSaved'; updatedAt?: string }
	| { type: 'implementingTimeRecalculated'; id: string; timeMs: number; sessionsCount: number }
	| {
		type: 'promptLoading';
		promptId?: string;
		promptUuid?: string;
		openRequestVersion?: number;
		editorViewState?: EditorPromptViewState;
		/** Независимые настройки обеих ширин панели. */
		promptDashboardLayouts?: PromptDashboardLayouts;
		promptDashboardCollapsedSections?: PromptDashboardCollapsedSections;
		promptDashboardSectionOrder?: PromptDashboardSectionOrder;
	}
	| { type: 'promptLoadingCancelled'; promptId?: string; openRequestVersion?: number }
	| { type: 'nextTaskNumber'; taskNumber: string }
	| { type: 'chatOpened'; promptId: string; requestId?: string }
	| { type: 'chatLaunchRenameState'; promptId: string; requestId?: string; state: 'started' | 'completed' }
	| { type: 'customGroups'; groups: PromptCustomGroup[] }
	| {
		type: 'promptVoiceState';
		sessionId: string;
		status: 'recording' | 'paused' | 'preparing-model' | 'processing' | 'correcting' | 'error' | 'cancelled' | 'transcribed';
		elapsedMs?: number;
		level?: number;
		levels?: number[];
		message?: string;
		progress?: number | null;
		errorBadge?: string;
		errorHint?: string;
		text?: string;
	}
	| {
		type: 'promptVoiceQueueState';
		sessionId: string;
		status: 'queued' | 'preparing-model' | 'processing' | 'correcting' | 'completed' | 'error';
		elapsedMs?: number;
		message?: string;
		progress?: number | null;
		errorBadge?: string;
		errorHint?: string;
		text?: string;
		autoRestart?: boolean;
	};
