/**
 * Message types for communication between extension and webviews
 */

import type { EditorPromptViewState, Prompt, PromptConfig, PromptContextFileCard, PromptCustomGroup, SidebarState, PromptStatistics, PromptStatus } from './prompt.js';
import type { GitOverlayActionKind, GitOverlayChangeFile, GitOverlayChangeGroup, GitOverlayFileHistoryPayload, GitOverlayProjectCommitMessage, GitOverlayProjectReviewRequestInput, GitOverlayReviewCliSetupRequest, GitOverlaySnapshot } from './git.js';

export type GitOverlayBusyReason =
	| { kind: 'label'; label: string }
	| { kind: 'file'; filePath: string }
	| { kind: 'git' };

export interface ClipboardImagePayload {
	mimeType: string;
	dataBase64: string;
}

// ---- Messages FROM webview TO extension ----

export type WebviewToExtensionMessage =
	| { type: 'ready'; bootId?: string }
	| { type: 'getPrompts' }
	| { type: 'getPrompt'; id: string }
	| { type: 'savePrompt'; prompt: Prompt; source?: 'manual' | 'status-change' | 'autosave' }
	| { type: 'deletePrompt'; id: string }
	| { type: 'duplicatePrompt'; id: string }
	| { type: 'createPrompt' }
	| { type: 'openPrompt'; id: string }
	| { type: 'importPrompt' }
	| { type: 'exportPrompt'; id: string }
	| { type: 'startChatPreflight'; id: string; prompt?: Prompt; forceRebindChat?: boolean; requestId?: string }
	| { type: 'startChat'; id: string; prompt?: Prompt; forceRebindChat?: boolean; requestId?: string; skipBranchMismatchCheck?: boolean; originalStatus?: PromptStatus }
	| { type: 'openChat'; id: string; sessionId: string }
	| { type: 'stopChat'; id?: string }
	| { type: 'generateTitle'; content: string }
	| { type: 'generateDescription'; content: string }
	| { type: 'generateSlug'; title: string; description: string }
	| { type: 'improvePromptText'; content: string; projects?: string[] }
	| { type: 'generateReportFromStagedChanges'; prompt: Prompt }
	| { type: 'saveSidebarState'; state: SidebarState }
	| { type: 'savePromptEditorViewState'; promptId?: string; promptUuid?: string; state: EditorPromptViewState }
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
	| { type: 'openGitOverlay'; promptBranch: string; projects: string[] }
	| { type: 'gitOverlayVisibility'; open: boolean; promptBranch: string; projects: string[] }
	| { type: 'refreshGitOverlay'; promptBranch: string; projects: string[]; mode?: 'local' | 'fetch' | 'sync' }
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
	| { type: 'gitOverlayOpenDiff'; project: string; filePath: string }
	| { type: 'gitOverlayOpenMergeEditor'; project: string; filePath: string }
	| { type: 'gitOverlayOpenReviewRequest'; url: string }
	| { type: 'gitOverlaySetupReviewCli'; request: GitOverlayReviewCliSetupRequest }
	| { type: 'gitOverlayAssignReviewProvider'; host: string; provider: 'github' | 'gitlab'; promptBranch: string; projects: string[] }
	| { type: 'gitOverlayGenerateCommitMessage'; prompt: Prompt; project?: string; projects?: string[]; includeAllChanges?: boolean; requestId?: string }
	| { type: 'gitOverlayCommitStaged'; prompt: Prompt; messages: GitOverlayProjectCommitMessage[]; includeAllChanges?: boolean; requestId?: string }
	| { type: 'gitOverlayCreateReviewRequest'; prompt: Prompt; requests: GitOverlayProjectReviewRequestInput[] }
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
	}
	| { type: 'markDirty'; dirty: boolean; prompt?: Prompt; promptId?: string; configFieldChangedAt?: Record<string, number> }
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
	| { type: 'confirmPromptVoiceRecording'; sessionId: string }
	| { type: 'cancelPromptVoiceRecording'; sessionId: string }
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
	| {
		type: 'prompt';
		prompt: Prompt | null;
		reason?: 'open' | 'save' | 'sync' | 'ai-enrichment' | 'external-config';
		previousId?: string;
		editorViewState?: EditorPromptViewState;
		aiEnrichment?: { title: boolean; description: boolean };
	}
	| { type: 'promptSaved'; prompt: PromptConfig; previousId?: string }
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
	| { type: 'gitOverlayBusy'; action: string | null; reason?: GitOverlayBusyReason | null }
	| { type: 'gitOverlayFileHistory'; history: GitOverlayFileHistoryPayload }
	| { type: 'gitOverlayCommitMessagesGenerated'; messages: GitOverlayProjectCommitMessage[]; requestId?: string }
	| { type: 'gitOverlayActionCompleted'; action: GitOverlayActionKind }
	| { type: 'branches'; branches: Array<{ name: string; current: boolean; project: string }> }
	| { type: 'branchStatus'; hasChanges: boolean; details: string }
	| { type: 'error'; message: string; requestId?: string }
	| { type: 'info'; message: string; requestId?: string }
	| { type: 'clearNotice' }
	| { type: 'pickedFiles'; files: string[] }
	| { type: 'contextFileCards'; files: PromptContextFileCard[]; requestId?: string }
	| { type: 'pickedHttpExamplesFile'; file: string }
	| { type: 'inlineSuggestion'; suggestion: string }
	| { type: 'inlineSuggestions'; suggestions: string[] }
	| { type: 'statistics'; data: PromptStatistics }
	| { type: 'statisticsUiState'; hourlyRateInput: string }
	| { type: 'globalContext'; context: string; canLoadRemote: boolean }
	| { type: 'globalContextLoaded'; context: string; canLoadRemote: boolean }
	| { type: 'globalContextLoadFailed'; message: string }
	| { type: 'projectInstructions'; content: string; exists: boolean }
	| { type: 'gitOverlayTrackedBranchPreference'; branch: string; branchesByProject?: Record<string, string> }
	| { type: 'availableLanguages'; options: Array<{ id: string; name: string }> }
	| { type: 'availableFrameworks'; options: Array<{ id: string; name: string }> }
	| { type: 'startChatPreflightResult'; requestId?: string; shouldOpenGitFlow: boolean; snapshot?: GitOverlaySnapshot }
	| { type: 'triggerStartChat'; promptId?: string }
	| { type: 'promptSaving'; id: string; promptUuid?: string; saving: boolean }
	| { type: 'triggerCreatePrompt' }
	| { type: 'chatStarted'; promptId: string; requestId?: string }
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
	| { type: 'promptLoading' }
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
	};
