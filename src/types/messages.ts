/**
 * Message types for communication between extension and webviews
 */

import type { Prompt, PromptConfig, SidebarState, PromptStatistics, PromptStatus } from './prompt.js';

// ---- Messages FROM webview TO extension ----

export type WebviewToExtensionMessage =
	| { type: 'ready' }
	| { type: 'getPrompts' }
	| { type: 'getPrompt'; id: string }
	| { type: 'savePrompt'; prompt: Prompt; source?: 'manual' | 'status-change' | 'autosave' }
	| { type: 'deletePrompt'; id: string }
	| { type: 'duplicatePrompt'; id: string }
	| { type: 'createPrompt' }
	| { type: 'openPrompt'; id: string }
	| { type: 'importPrompt' }
	| { type: 'exportPrompt'; id: string }
	| { type: 'startChat'; id: string; prompt?: Prompt }
	| { type: 'openChat'; id: string; sessionId: string }
	| { type: 'generateTitle'; content: string }
	| { type: 'generateDescription'; content: string }
	| { type: 'generateSlug'; title: string; description: string }
	| { type: 'saveSidebarState'; state: SidebarState }
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
	| { type: 'updateTimeSpent'; id: string; field: 'timeSpentWriting' | 'timeSpentImplementing'; delta: number }
	| { type: 'pickFile' }
	| { type: 'pasteFiles'; files: string[] }
	| { type: 'openFile'; file: string }
	| { type: 'requestSuggestion'; textBefore: string; globalContext?: string }
	| { type: 'getStatistics'; month?: number; year?: number }
	| { type: 'exportReport'; rows: Array<{ taskNumber: string; title: string; hours: number }> }
	| { type: 'markDirty'; dirty: boolean; prompt?: Prompt }
	| { type: 'showStatistics' }
	| { type: 'updatePromptStatus'; id: string; status: PromptStatus }
	| { type: 'getGlobalContext' }
	| { type: 'saveGlobalContext'; context: string }
	| { type: 'createBranch'; branch: string; projects: string[] }
	| { type: 'openPromptContentInEditor'; content: string; promptId?: string; title?: string };

// ---- Messages FROM extension TO webview ----

export type ExtensionToWebviewMessage =
	| { type: 'prompts'; prompts: PromptConfig[] }
	| { type: 'prompt'; prompt: Prompt | null }
	| { type: 'promptSaved'; prompt: PromptConfig }
	| { type: 'promptDeleted'; id: string }
	| { type: 'promptDuplicated'; prompt: PromptConfig }
	| { type: 'sidebarState'; state: SidebarState }
	| { type: 'workspaceFolders'; folders: string[] }
	| { type: 'availableModels'; models: Array<{ id: string; name: string }> }
	| { type: 'availableSkills'; skills: Array<{ id: string; name: string; description: string }> }
	| { type: 'availableMcpTools'; tools: Array<{ id: string; name: string; description: string }> }
	| { type: 'availableHooks'; hooks: Array<{ id: string; name: string; description: string }> }
	| { type: 'generatedTitle'; title: string }
	| { type: 'generatedDescription'; description: string }
	| { type: 'generatedSlug'; slug: string }
	| { type: 'branches'; branches: Array<{ name: string; current: boolean; project: string }> }
	| { type: 'branchStatus'; hasChanges: boolean; details: string }
	| { type: 'error'; message: string }
	| { type: 'info'; message: string }
	| { type: 'pickedFiles'; files: string[] }
	| { type: 'inlineSuggestion'; suggestion: string }
	| { type: 'inlineSuggestions'; suggestions: string[] }
	| { type: 'statistics'; data: PromptStatistics }
	| { type: 'globalContext'; context: string }
	| { type: 'availableLanguages'; options: Array<{ id: string; name: string }> }
	| { type: 'availableFrameworks'; options: Array<{ id: string; name: string }> }
	| { type: 'promptSaving'; id: string; saving: boolean }
	| { type: 'triggerCreatePrompt' }
	| { type: 'chatStarted'; promptId: string }
	| { type: 'promptContentUpdated'; content: string; writingDeltaMs?: number };
