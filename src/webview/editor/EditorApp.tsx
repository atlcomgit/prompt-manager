/**
 * Editor App — Main component for prompt configuration form
 */

import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { getVsCodeApi } from '../shared/vscodeApi';
import { useMessageListener } from '../shared/useMessageListener';
import { useT } from '../shared/i18n';
import { TextField } from './components/TextField';
import { TextArea } from './components/TextArea';
import { RichTextEditor } from './components/RichTextEditor';
import { MultiSelect } from './components/MultiSelect';
import { StatusSelect } from './components/StatusSelect';
import { ActionBar } from './components/ActionBar';
import { TimerDisplay } from './components/TimerDisplay';
import { PromptVoiceOverlay } from './components/PromptVoiceOverlay';
import { GitOverlay } from './components/GitOverlay';
import { ProgressLine, resolveEditorProgressMode } from './components/ProgressLine';
import type { Prompt, PromptStatus } from '../../types/prompt';
import type { GitOverlayActionKind, GitOverlayChangeFile, GitOverlayChangeGroup, GitOverlayFileHistoryPayload, GitOverlayProjectCommitMessage, GitOverlayProjectReviewRequestInput, GitOverlayReviewCliSetupRequest, GitOverlaySnapshot } from '../../types/git';
import { createDefaultPrompt } from '../../types/prompt';
import { TimeTrackingService } from '../../services/timeTrackingService';
import { appendRecognizedPromptText } from './voice/promptVoiceUtils';
import { usePromptVoiceController } from './voice/usePromptVoiceController';
import { buildPlanChecklistSummary, parsePlanChecklist } from '../../utils/planChecklist.js';

const vscode = getVsCodeApi();
const initialBootId = (window as typeof window & { __WEBVIEW_BOOT_ID__?: string }).__WEBVIEW_BOOT_ID__ || '';

interface SelectOption {
  id: string;
  name: string;
  description?: string;
}

type SectionKey = 'basic' | 'workspace' | 'prompt' | 'globalPrompt' | 'report' | 'plan' | 'tech' | 'integrations' | 'agent' | 'files' | 'time';
type InlineNotice = { kind: 'error' | 'info'; message: string };
type ChatEntryAction = 'start' | 'open';
type GitOverlayMode = 'default' | 'start-chat-preflight' | 'open-chat-preflight';

const CHAT_START_TIMEOUT_MS = 15000;
const EDITOR_FORM_SHELL_WIDTH_PX = 840;
const EDITOR_FORM_CONTENT_WIDTH_PX = 800;

const DEFAULT_EXPANDED_SECTIONS: Record<SectionKey, boolean> = {
  basic: true,
  workspace: false,
  prompt: true,
  globalPrompt: false,
  report: false,
  plan: false,
  tech: false,
  integrations: false,
  agent: false,
  files: false,
  time: false,
};

const ensureTrailingNewline = (text: string): string => (text.endsWith('\n') ? text : `${text}\n`);

const normalizeTrackedBranchesByProject = (value?: Record<string, string>): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [project, branch] of Object.entries(value || {})) {
    const normalizedProject = project.trim();
    const normalizedBranch = typeof branch === 'string' ? branch.trim() : '';
    if (!normalizedProject || !normalizedBranch) {
      continue;
    }
    result[normalizedProject] = normalizedBranch;
  }
  return result;
};

const areTrackedBranchesByProjectEqual = (
  left?: Record<string, string>,
  right?: Record<string, string>,
): boolean => {
  const normalizedLeft = normalizeTrackedBranchesByProject(left);
  const normalizedRight = normalizeTrackedBranchesByProject(right);
  const leftEntries = Object.entries(normalizedLeft).sort(([leftProject], [rightProject]) => leftProject.localeCompare(rightProject));
  const rightEntries = Object.entries(normalizedRight).sort(([leftProject], [rightProject]) => leftProject.localeCompare(rightProject));

  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  return leftEntries.every(([project, branch], index) => {
    const [rightProject, rightBranch] = rightEntries[index];
    return project === rightProject && branch === rightBranch;
  });
};

const resolveSingleTrackedBranch = (trackedBranchesByProject?: Record<string, string>): string => {
  const uniqueBranches = Array.from(new Set(
    Object.values(normalizeTrackedBranchesByProject(trackedBranchesByProject)),
  ));

  return uniqueBranches.length === 1 ? uniqueBranches[0] : '';
};

const VoiceMicIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={styles.inlineIcon}>
    <path
      fill="currentColor"
      d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a1 1 0 1 1 2 0 7 7 0 0 1-6 6.93V21h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-3.07A7 7 0 0 1 5 11a1 1 0 1 1 2 0 5 5 0 1 0 10 0z"
    />
  </svg>
);

export const EditorApp: React.FC = () => {
  const t = useT();
  const bootIdRef = useRef<string>(initialBootId);
  const initialWebviewStateRef = useRef<Record<string, unknown>>((vscode.getState?.() || {}) as Record<string, unknown>);
  const storage = typeof window !== 'undefined' ? window.localStorage : null;
  const readStoredHeight = (key: string): number | undefined => {
    const stateValue = initialWebviewStateRef.current?.[key];
    const parsedStateValue = typeof stateValue === 'number'
      ? stateValue
      : (typeof stateValue === 'string' ? Number.parseInt(stateValue, 10) : NaN);
    if (Number.isFinite(parsedStateValue) && parsedStateValue > 0) {
      return parsedStateValue;
    }
    if (!storage) {
      return undefined;
    }
    const rawValue = storage.getItem(key);
    const parsed = rawValue ? Number.parseInt(rawValue, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  const readStoredExpandedSections = (): Record<SectionKey, boolean> => {
    const stateValue = initialWebviewStateRef.current?.['pm.editor.expandedSections'];

    const normalize = (value: unknown): Record<SectionKey, boolean> | null => {
      if (!value || typeof value !== 'object') {
        return null;
      }
      const candidate = value as Record<string, unknown>;
      const keys: Array<Exclude<SectionKey, 'agent' | 'files'>> = ['basic', 'workspace', 'prompt', 'globalPrompt', 'report', 'plan', 'tech', 'integrations', 'time'];
      const allValid = keys.every((key) => typeof candidate[key] === 'boolean');
      if (!allValid) {
        return null;
      }
      return {
        basic: Boolean(candidate.basic),
        workspace: Boolean(candidate.workspace),
        prompt: Boolean(candidate.prompt),
        globalPrompt: Boolean(candidate.globalPrompt),
        report: Boolean(candidate.report),
        plan: Boolean(candidate.plan),
        tech: Boolean(candidate.tech),
        integrations: Boolean(candidate.integrations),
        agent: typeof candidate.agent === 'boolean' ? Boolean(candidate.agent) : DEFAULT_EXPANDED_SECTIONS.agent,
        files: typeof candidate.files === 'boolean' ? Boolean(candidate.files) : DEFAULT_EXPANDED_SECTIONS.files,
        time: Boolean(candidate.time),
      };
    };

    if (stateValue) {
      const normalized = normalize(stateValue);
      if (normalized) {
        return normalized;
      }
    }

    if (storage) {
      const rawValue = storage.getItem('pm.editor.expandedSections');
      if (rawValue) {
        try {
          const parsed = JSON.parse(rawValue);
          const normalized = normalize(parsed);
          if (normalized) {
            return normalized;
          }
        } catch {
          // ignore corrupted local state
        }
      }
    }

    return { ...DEFAULT_EXPANDED_SECTIONS };
  };

  const [prompt, setPrompt] = useState<Prompt>(createDefaultPrompt());
  const [isLoaded, setIsLoaded] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  // Start with loader visible: on new panel creation promptLoading is never sent
  // (only sent when reusing an existing singleton panel), so we show the loader
  // immediately and hide it once the first 'prompt' message with reason='open' arrives.
  const [showLoader, setShowLoader] = useState(true);
  const showLoaderTimerRef = useRef<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isStartingChat, setIsStartingChat] = useState(false);
  const [pendingExternalStartChatPromptId, setPendingExternalStartChatPromptId] = useState<string | null>(null);
  const [isChatPanelOpen, setIsChatPanelOpen] = useState(false);
  const [workspaceFolders, setWorkspaceFolders] = useState<string[]>([]);
  const [availableModels, setAvailableModels] = useState<SelectOption[]>([]);
  const [availableSkills, setAvailableSkills] = useState<SelectOption[]>([]);
  const [availableMcpTools, setAvailableMcpTools] = useState<SelectOption[]>([]);
  const [availableHooks, setAvailableHooks] = useState<SelectOption[]>([]);
  const [availableLanguages, setAvailableLanguages] = useState<SelectOption[]>([]);
  const [availableFrameworks, setAvailableFrameworks] = useState<SelectOption[]>([]);
  const [allowedBranchesSetting, setAllowedBranchesSetting] = useState<string[]>(['master', 'main', 'prod', 'develop', 'dev']);
  const [workspaceTrackedBranchPreference, setWorkspaceTrackedBranchPreference] = useState('');
  const [workspaceTrackedBranchesByProjectPreference, setWorkspaceTrackedBranchesByProjectPreference] = useState<Record<string, string>>({});
  const [pageWidth, setPageWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : EDITOR_FORM_SHELL_WIDTH_PX));
  const [branches, setBranches] = useState<Array<{ name: string; current: boolean; project: string }>>([]);
  const [branchesResolved, setBranchesResolved] = useState(false);
  const [showBranches, setShowBranches] = useState(false);
  const [gitOverlayOpen, setGitOverlayOpen] = useState(false);
  const [gitOverlayMode, setGitOverlayMode] = useState<GitOverlayMode>('default');
  const [gitOverlaySnapshot, setGitOverlaySnapshot] = useState<GitOverlaySnapshot | null>(null);
  const [gitOverlayFileHistory, setGitOverlayFileHistory] = useState<GitOverlayFileHistoryPayload | null>(null);
  const [gitOverlayCommitMessages, setGitOverlayCommitMessages] = useState<Record<string, string>>({});
  const [gitOverlayBusyAction, setGitOverlayBusyAction] = useState<string | null>(null);
  const [gitOverlayCompletedActions, setGitOverlayCompletedActions] = useState<Record<GitOverlayActionKind, boolean>>({
    push: false,
    'review-request': false,
    merge: false,
  });
  const [inlineSuggestion, setInlineSuggestion] = useState<string>('');
  const [inlineSuggestions, setInlineSuggestions] = useState<string[]>([]);
  const [autoCompleteEnabled, setAutoCompleteEnabled] = useState(false);
  const [requestSuggestionSignal, setRequestSuggestionSignal] = useState(0);
  const [isSuggestionLoading, setIsSuggestionLoading] = useState(false);
  const [isImprovingPromptText, setIsImprovingPromptText] = useState(false);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [isGeneratingTitle, setIsGeneratingTitle] = useState(false);
  const [isGeneratingDescription, setIsGeneratingDescription] = useState(false);
  const [isLoadingGlobalContext, setIsLoadingGlobalContext] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [templateVars, setTemplateVars] = useState<Record<string, string>>({});
  const [globalContext, setGlobalContext] = useState('');
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Record<SectionKey, boolean>>(() => readStoredExpandedSections());
  const [promptPlanState, setPromptPlanState] = useState<{ exists: boolean; content: string }>({ exists: false, content: '' });
  const [notice, setNotice] = useState<InlineNotice | null>(null);
  const [promptContentHeight, setPromptContentHeight] = useState<number | undefined>(() => readStoredHeight('pm.editor.promptContentHeight'));
  const [reportHeight, setReportHeight] = useState<number | undefined>(() => readStoredHeight('pm.editor.reportHeight'));
  const [globalContextHeight, setGlobalContextHeight] = useState<number | undefined>(() => readStoredHeight('pm.editor.globalContextHeight'));
  const [promptContentFocusSignal, setPromptContentFocusSignal] = useState(0);
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false);
  const shouldShowFooterGitFlow = prompt.status === 'draft'
    || prompt.status === 'in-progress'
    || prompt.status === 'completed'
    || prompt.status === 'report'
    || prompt.status === 'review';
  const shouldDockGitOverlaySecondHalf = pageWidth >= EDITOR_FORM_SHELL_WIDTH_PX * 2;
  const editorProgressMode = resolveEditorProgressMode({
    isSaving,
    isStartingChat,
    isImprovingPromptText,
    isGeneratingReport,
    isGeneratingTitle,
    isGeneratingDescription,
    isSuggestionLoading,
    isRecalculating,
    isLoadingGlobalContext,
  });
  const startChatLockRef = useRef(false);
  const chatStartTimeoutRef = useRef<number | null>(null);
  const pendingChatStartRequestIdRef = useRef<string>('');
  const acceptedChatStartRequestIdRef = useRef<string>('');
  const pendingChatStartPreflightRequestIdRef = useRef<string>('');
  const pendingGitOverlayStartChatRequestIdRef = useRef<string>('');
  const pendingChatPreflightActionRef = useRef<ChatEntryAction | ''>('');
  const hasReportedGitOverlayVisibilityRef = useRef(false);
  const handleStartChatRef = useRef<() => void>(() => undefined);
  const handleOpenChatRef = useRef<() => void>(() => undefined);
  const globalContextTextareaRef = useRef<HTMLTextAreaElement>(null);
  const saveTimeoutRef = useRef<number | null>(null);
  const currentPromptIdRef = useRef<string>('__new__');
  const activeSaveIdRef = useRef<string | null>(null);
  const recalcTriggeredForRef = useRef<string>('');

  // Auto-save refs
  const promptRef = useRef<Prompt>(prompt);
  const isDirtyRef = useRef(false);
  const isSavingRef = useRef(false);
  const localReportDirtyRef = useRef(false);
  const pendingReportOverrideRef = useRef<string | null>(null);
  const autoSaveTimerRef = useRef<number | null>(null);
  const userChangeCounterRef = useRef(0);
  const saveStartCounterRef = useRef(0);
  const isExternalEditorOpenRef = useRef(false);
  /** true once the prompt has been saved at least once (manually or loaded from storage) */
  const hasBeenSavedRef = useRef(false);

  // Time tracking
  const openedAtRef = useRef<number>(Date.now());
  const lastFocusRef = useRef<number>(Date.now());

  // Detect {{variable}} patterns in content
  const detectedVars = useMemo(() => {
    const regex = /\{\{(\w+)\}\}/g;
    const vars = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = regex.exec(prompt.content)) !== null) {
      vars.add(match[1]);
    }
    return Array.from(vars);
  }, [prompt.content]);

  const logReportDebug = useCallback((message: string, payload?: Record<string, unknown>) => {
    vscode.postMessage({ type: 'debugLog', scope: 'editor-report', message, payload });
  }, []);

  const logMainRichTextDebug = useCallback((message: string, payload?: Record<string, unknown>) => {
    logReportDebug(`mainRichText.${message}`, payload);
  }, [logReportDebug]);

  const logGitOverlayDebug = useCallback((message: string, payload?: Record<string, unknown>) => {
    vscode.postMessage({ type: 'debugLog', scope: 'editor-git-overlay', message, payload });
  }, []);

  useEffect(() => {
    if (!gitOverlayOpen) {
      return;
    }
    logGitOverlayDebug('busyAction.changed', {
      busyAction: gitOverlayBusyAction,
      mode: gitOverlayMode,
      open: gitOverlayOpen,
    });
  }, [gitOverlayBusyAction, gitOverlayMode, gitOverlayOpen, logGitOverlayDebug]);

  const clearChatStartTimeout = useCallback(() => {
    if (chatStartTimeoutRef.current) {
      window.clearTimeout(chatStartTimeoutRef.current);
      chatStartTimeoutRef.current = null;
    }
  }, []);

  const resetChatStartRequestTracking = useCallback(() => {
    pendingChatStartRequestIdRef.current = '';
    acceptedChatStartRequestIdRef.current = '';
  }, []);

  const resetStartChatPreflightTracking = useCallback(() => {
    pendingChatStartPreflightRequestIdRef.current = '';
    pendingGitOverlayStartChatRequestIdRef.current = '';
    pendingChatPreflightActionRef.current = '';
  }, []);

  const shouldHandleChatStartMessage = useCallback((requestId?: string): boolean => {
    const normalizedRequestId = (requestId || '').trim();
    if (!normalizedRequestId) {
      return true;
    }
    return normalizedRequestId === pendingChatStartRequestIdRef.current
      || normalizedRequestId === acceptedChatStartRequestIdRef.current;
  }, []);

  const persistGlobalContext = useCallback((context: string) => {
    setGlobalContext(context);
    vscode.postMessage({ type: 'saveGlobalContext', context });
  }, []);

  const handleResetGlobalContext = useCallback(() => {
    persistGlobalContext('');
    setNotice(null);
  }, [persistGlobalContext]);

  const handleLoadGlobalContext = useCallback(() => {
    if (isLoadingGlobalContext) {
      return;
    }
    setNotice(null);
    setIsLoadingGlobalContext(true);
    vscode.postMessage({ type: 'loadRemoteGlobalContext' });
  }, [isLoadingGlobalContext]);

  const releaseStartChatPendingState = useCallback((options?: { resetSaving?: boolean }) => {
    clearChatStartTimeout();
    startChatLockRef.current = false;
    setIsStartingChat(false);
    if (options?.resetSaving) {
      setIsSaving(false);
      activeSaveIdRef.current = null;
    }
  }, [clearChatStartTimeout]);

  useEffect(() => {
    setIsDescriptionExpanded(false);
  }, [prompt.id]);

  useEffect(() => {
    const handleResize = () => setPageWidth(window.innerWidth);

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const showInlineNotice = useCallback((kind: InlineNotice['kind'], message: string) => {
    const normalizedMessage = (message || '').trim();
    if (!normalizedMessage) {
      return;
    }
    setNotice({ kind, message: normalizedMessage });
  }, []);

  const handleChatStartTimeout = useCallback(() => {
    if (!startChatLockRef.current) {
      return;
    }
    releaseStartChatPendingState({ resetSaving: true });
    resetChatStartRequestTracking();
    showInlineNotice('error', t('actions.startChatTimeout'));
  }, [releaseStartChatPendingState, resetChatStartRequestTracking, showInlineNotice, t]);

  const scheduleChatStartTimeout = useCallback(() => {
    clearChatStartTimeout();
    chatStartTimeoutRef.current = window.setTimeout(handleChatStartTimeout, CHAT_START_TIMEOUT_MS);
  }, [clearChatStartTimeout, handleChatStartTimeout]);

  const buildPromptForSaveFrom = useCallback((basePrompt: Prompt): Prompt => {
    const timeSpent = Date.now() - openedAtRef.current;
    const updatedPrompt = applyElapsedTimeByContext(basePrompt, timeSpent);
    openedAtRef.current = Date.now();
    return updatedPrompt;
  }, []);

  const buildPromptForSave = useCallback((): Prompt => buildPromptForSaveFrom(promptRef.current), [buildPromptForSaveFrom]);

  const createStartChatRequestId = useCallback(
    (): string => `start-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    [],
  );

  const closeGitOverlay = useCallback(() => {
    setGitOverlayOpen(false);
    setGitOverlayMode('default');
    resetStartChatPreflightTracking();
  }, [resetStartChatPreflightTracking]);

  useEffect(() => {
    if (!hasReportedGitOverlayVisibilityRef.current && !gitOverlayOpen) {
      return;
    }

    hasReportedGitOverlayVisibilityRef.current = true;
    vscode.postMessage({
      type: 'gitOverlayVisibility',
      open: gitOverlayOpen,
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
    });
  }, [gitOverlayOpen, prompt.branch, prompt.projects]);

  const dispatchStartChat = useCallback((requestId: string, options?: { skipBranchMismatchCheck?: boolean }) => {
    const latestPrompt = promptRef.current;
    const originalStatus = latestPrompt.status;
    const shouldForceRebindChat = latestPrompt.status === 'draft';
    if (!latestPrompt.content || (!shouldForceRebindChat && latestPrompt.chatSessionIds.length > 0)) {
      return;
    }

    pendingChatStartRequestIdRef.current = requestId;
    acceptedChatStartRequestIdRef.current = '';
    pendingChatStartPreflightRequestIdRef.current = '';
    pendingGitOverlayStartChatRequestIdRef.current = '';
    setNotice(null);
    setIsChatPanelOpen(false);
    hasBeenSavedRef.current = true;

    const updatedPrompt = {
      ...buildPromptForSave(),
      status: 'in-progress' as const,
      chatSessionIds: shouldForceRebindChat ? [] : latestPrompt.chatSessionIds,
    };

    startChatLockRef.current = true;
    setIsStartingChat(true);
    scheduleChatStartTimeout();
    vscode.postMessage({
      type: 'startChat',
      id: updatedPrompt.id || '__new__',
      prompt: updatedPrompt,
      forceRebindChat: shouldForceRebindChat,
      requestId,
      skipBranchMismatchCheck: options?.skipBranchMismatchCheck === true,
      originalStatus,
    });
  }, [buildPromptForSave, scheduleChatStartTimeout]);

  const continueOpenChat = useCallback(() => {
    const latestPrompt = promptRef.current;

    if (latestPrompt.status !== 'in-progress') {
      const promptToSave = { ...buildPromptForSaveFrom(latestPrompt), status: 'in-progress' as const };
      promptRef.current = promptToSave;
      setPrompt(promptToSave);
      if (hasBeenSavedRef.current || promptToSave.id) {
        activeSaveIdRef.current = (promptToSave.id || latestPrompt.id || '__new__').trim() || '__new__';
        setIsSaving(true);
        setIsDirty(false);
        vscode.postMessage({ type: 'savePrompt', prompt: promptToSave, source: 'status-change' });
      }
    }

    if (latestPrompt.id && latestPrompt.chatSessionIds.length > 0) {
      vscode.postMessage({ type: 'openChat', id: latestPrompt.id, sessionId: latestPrompt.chatSessionIds[0] });
      return;
    }

    vscode.postMessage({ type: 'openChatPanel' });
  }, [buildPromptForSaveFrom]);

  const requestChatEntryPreflight = useCallback((action: ChatEntryAction): string | null => {
    const latestPrompt = promptRef.current;
    const shouldRunBranchPreflight = latestPrompt.projects.length > 0
      && Boolean((latestPrompt.branch || '').trim());

    if (!shouldRunBranchPreflight) {
      return null;
    }

    const requestId = createStartChatRequestId();
    pendingChatStartPreflightRequestIdRef.current = requestId;
    pendingGitOverlayStartChatRequestIdRef.current = '';
    pendingChatPreflightActionRef.current = action;
    startChatLockRef.current = true;
    setIsStartingChat(true);
    setNotice(null);
    setIsChatPanelOpen(false);
    vscode.postMessage({
      type: 'startChatPreflight',
      id: latestPrompt.id || '__new__',
      prompt: latestPrompt,
      forceRebindChat: action === 'start' && latestPrompt.status === 'draft',
      requestId,
    });
    return requestId;
  }, [createStartChatRequestId]);

  const targetBranch = prompt.branch.trim();

  /** Allowed branches that don't trigger a mismatch warning */
  const ALLOWED_BRANCHES = useMemo(() => {
    const set = new Set((allowedBranchesSetting || []).map(b => b.trim()).filter(Boolean));
    if (set.size === 0) {
      set.add('master');
      set.add('main');
      set.add('prod');
      set.add('develop');
      set.add('dev');
    }
    if (targetBranch) { set.add(targetBranch); }
    return set;
  }, [allowedBranchesSetting, targetBranch]);

  /** Map project → current branch (from resolved branches) */
  const currentBranchByProject = useMemo(() => {
    const map = new Map<string, string>();
    for (const branchInfo of branches) {
      if (branchInfo.current) {
        map.set(branchInfo.project, branchInfo.name);
      }
    }
    return map;
  }, [branches]);

  /** Whether any selected project has a branch NOT in the allowed set */
  const hasBranchMismatch = useMemo(() => {
    if (prompt.projects.length === 0 || !branchesResolved) { return false; }
    return prompt.projects.some(p => {
      const cur = currentBranchByProject.get(p);
      return cur ? !ALLOWED_BRANCHES.has(cur) : false;
    });
  }, [prompt.projects, branchesResolved, currentBranchByProject, ALLOWED_BRANCHES]);

  const shouldShowSwitchBranchBtn = useMemo(() => {
    if (!targetBranch || prompt.projects.length === 0 || !branchesResolved) {
      return false;
    }

    return prompt.projects.some(projectName => currentBranchByProject.get(projectName) !== targetBranch);
  }, [targetBranch, prompt.projects, currentBranchByProject, branchesResolved]);

  const toShortText = (value: string, maxLength = 64): string => {
    const normalized = value.trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }
    return `${normalized.slice(0, maxLength - 1)}…`;
  };

  const joinSelected = (values: string[]): string => values
    .map(v => v.trim())
    .filter(Boolean)
    .join(', ');

  const modelOptions = useMemo(() => {
    const items = [...availableModels];
    const currentModel = prompt.model.trim();
    if (currentModel && !items.some(item => item.id === currentModel)) {
      items.unshift({ id: currentModel, name: currentModel });
    }
    return items;
  }, [availableModels, prompt.model]);

  const selectedModelName = useMemo(() => {
    if (!prompt.model.trim()) {
      return '';
    }
    const selected = modelOptions.find(m => m.id === prompt.model.trim());
    if (selected) {
      return selected.name;
    }
    return prompt.model.trim();
  }, [prompt.model, modelOptions]);

  const basicSummary = useMemo(() => {
    const chunks: string[] = [];
    if (prompt.title.trim()) chunks.push(`Заголовок: ${toShortText(prompt.title, 48)}`);
    if (prompt.description.trim()) chunks.push(`Описание: ${toShortText(prompt.description, 48)}`);
    return chunks;
  }, [prompt.title, prompt.description]);

  const promptSummary = useMemo(() => {
    const chunks: string[] = [];
    if (prompt.content.trim()) chunks.push(`Текст: ${toShortText(prompt.content.replace(/\s+/g, ' '), 48)}`);
    return chunks;
  }, [prompt.content]);

  const globalPromptSummary = useMemo(() => {
    const chunks: string[] = [];
    if (globalContext.trim()) chunks.push(`Контекст: ${toShortText(globalContext, 64)}`);
    return chunks;
  }, [globalContext]);

  const hasGlobalContext = globalContext.trim().length > 0;

  const reportSummary = useMemo(() => {
    const chunks: string[] = [];
    const reportText = (prompt.report || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (reportText) chunks.push(`Результат: ${toShortText(reportText, 64)}`);
    if (prompt.httpExamples.trim()) chunks.push(`HTTP: ${toShortText(prompt.httpExamples.trim(), 56)}`);
    return chunks;
  }, [prompt.report, prompt.httpExamples]);

  const planChecklistItems = useMemo(() => parsePlanChecklist(promptPlanState.content), [promptPlanState.content]);

  const planSummary = useMemo(() => buildPlanChecklistSummary(planChecklistItems), [planChecklistItems]);

  const shouldShowPlanSection = prompt.status === 'in-progress' && promptPlanState.exists;

  const workspaceSummary = useMemo(() => {
    const chunks: string[] = [];
    const projects = joinSelected(prompt.projects);
    if (projects) chunks.push(`Проекты: ${toShortText(projects, 64)}`);
    if (prompt.taskNumber.trim()) chunks.push(`Задача: ${prompt.taskNumber.trim()}`);
    if (prompt.branch.trim()) chunks.push(`Ветка: ${prompt.branch.trim()}`);
    return chunks;
  }, [prompt.projects, prompt.taskNumber, prompt.branch]);

  const techSummary = useMemo(() => {
    const chunks: string[] = [];
    const languages = joinSelected(prompt.languages);
    const frameworks = joinSelected(prompt.frameworks);
    if (languages) chunks.push(`Языки: ${toShortText(languages, 64)}`);
    if (frameworks) chunks.push(`Фреймворки: ${toShortText(frameworks, 64)}`);
    return chunks;
  }, [prompt.languages, prompt.frameworks]);

  const integrationsSummary = useMemo(() => {
    const chunks: string[] = [];
    const skills = joinSelected(prompt.skills);
    const mcpTools = joinSelected(prompt.mcpTools);
    const hooks = joinSelected(prompt.hooks);
    if (skills) chunks.push(`Skills: ${toShortText(skills, 56)}`);
    if (mcpTools) chunks.push(`MCP: ${toShortText(mcpTools, 56)}`);
    if (hooks) chunks.push(`Hooks: ${toShortText(hooks, 56)}`);
    return chunks;
  }, [prompt.skills, prompt.mcpTools, prompt.hooks]);

  const agentSummary = useMemo(() => {
    const chunks: string[] = [];
    if (selectedModelName) chunks.push(`Модель: ${toShortText(selectedModelName, 56)}`);
    chunks.push(`Режим: ${prompt.chatMode === 'agent' ? 'Agent' : 'Plan'}`);
    return chunks;
  }, [selectedModelName, prompt.chatMode]);

  const filesSummary = useMemo(() => {
    const chunks: string[] = [];
    const files = prompt.contextFiles
      .map(filePath => {
        const segments = filePath.split(/[\\/]/).filter(Boolean);
        return segments.length > 0 ? segments[segments.length - 1] : filePath;
      })
      .join(', ');
    if (files) chunks.push(`Файлы: ${toShortText(files, 56)}`);
    return chunks;
  }, [prompt.contextFiles]);

  const timeSummary = useMemo(() => {
    const totalMs = (prompt.timeSpentWriting || 0) + (prompt.timeSpentImplementing || 0) + (prompt.timeSpentOnTask || 0) + (prompt.timeSpentUntracked || 0);
    const minutes = Math.round(totalMs / 60000);
    return minutes > 0 ? [`Всего: ${minutes} мин`] : [];
  }, [prompt.timeSpentWriting, prompt.timeSpentImplementing, prompt.timeSpentUntracked, prompt.timeSpentOnTask]);

  const analyzedProjectsCount = useMemo(() => {
    if (prompt.projects.length > 0) {
      return prompt.projects.length;
    }
    return workspaceFolders.length;
  }, [prompt.projects, workspaceFolders]);

  /** Simple Markdown → HTML converter */
  const renderMarkdown = (md: string): string => {
    let html = md
      // Escape HTML
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      // Code blocks
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="lang-$1">$2</code></pre>')
      // Inline code
      .replace(/`([^`]+)`/g, '<code style="background:var(--vscode-textCodeBlock-background);padding:1px 4px;border-radius:3px;">$1</code>')
      // Headers
      .replace(/^### (.+)$/gm, '<h3 style="margin:12px 0 6px;">$1</h3>')
      .replace(/^## (.+)$/gm, '<h2 style="margin:14px 0 8px;">$1</h2>')
      .replace(/^# (.+)$/gm, '<h1 style="margin:16px 0 10px;">$1</h1>')
      // Bold + italic
      .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // Unordered lists
      .replace(/^[-*] (.+)$/gm, '<li style="margin-left:20px;">$1</li>')
      // Ordered lists
      .replace(/^\d+\. (.+)$/gm, '<li style="margin-left:20px;list-style-type:decimal;">$1</li>')
      // Links
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:var(--vscode-textLink-foreground);">$1</a>')
      // Highlight template variables
      .replace(/\{\{(\w+)\}\}/g, '<span style="background:var(--vscode-editorWarning-background,rgba(255,200,0,0.2));padding:1px 4px;border-radius:3px;color:var(--vscode-editorWarning-foreground);">{{$1}}</span>')
      // Line breaks
      .replace(/\n/g, '<br/>');

    // Substitute template variable values
    for (const [key, val] of Object.entries(templateVars)) {
      if (val) {
        html = html.replace(
          new RegExp(`\\{\\{${key}\\}\\}`, 'g'),
          `<span style="background:var(--vscode-diffEditor-insertedTextBackground,rgba(0,200,0,0.15));padding:1px 4px;border-radius:3px;">${val}</span>`
        );
      }
    }
    return html;
  };

  const requestPromptPlanState = useCallback((promptId?: string) => {
    vscode.postMessage({ type: 'requestPromptPlanState', promptId });
  }, []);

  useEffect(() => {
    const readyTimer = window.setTimeout(() => {
      vscode.postMessage({ type: 'ready', bootId: bootIdRef.current });
    }, 0);

    // Track writing time
    const interval = setInterval(() => {
      if (document.hasFocus() && prompt.id) {
        const delta = Date.now() - lastFocusRef.current;
        if (delta < 5000) { // Only count if <5s since last check (to avoid counting idle time)
          // Will be saved when prompt is saved
        }
        lastFocusRef.current = Date.now();
      }
    }, 1000);

    return () => {
      window.clearTimeout(readyTimer);
      clearInterval(interval);
    };
  }, [prompt.id]);

  useEffect(() => {
    currentPromptIdRef.current = (prompt.id || '__new__').trim() || '__new__';
  }, [prompt.id]);

  // Keep refs in sync with state
  useEffect(() => { promptRef.current = prompt; }, [prompt]);
  useEffect(() => { isDirtyRef.current = isDirty; }, [isDirty]);
  useEffect(() => { isSavingRef.current = isSaving; }, [isSaving]);

  useEffect(() => {
    logReportDebug('state.reportChanged', {
      promptId: prompt.id || '__new__',
      reportLength: (prompt.report || '').length,
      localReportDirty: localReportDirtyRef.current,
      globalDirty: isDirty,
      pendingOverrideLength: pendingReportOverrideRef.current?.length ?? null,
    });
  }, [isDirty, logReportDebug, prompt.id, prompt.report]);

  // Cleanup auto-save timer and loader timer on unmount
  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) {
        window.clearTimeout(autoSaveTimerRef.current);
      }
      if (showLoaderTimerRef.current) {
        window.clearTimeout(showLoaderTimerRef.current);
      }
    };
  }, []);

  const handleMessage = useCallback((msg: any) => {
    switch (msg.type) {
      case 'promptLoading':
        clearChatStartTimeout();
        startChatLockRef.current = false;
        setIsStartingChat(false);
        resetChatStartRequestTracking();
        resetStartChatPreflightTracking();
        setIsLoaded(false);
        setIsChatPanelOpen(false);
        setNotice(null);
        setIsLoadingGlobalContext(false);
        setIsGeneratingTitle(false);
        setIsGeneratingDescription(false);
        setGitOverlayOpen(false);
        setGitOverlayMode('default');
        setGitOverlaySnapshot(null);
        setGitOverlayFileHistory(null);
        setGitOverlayCommitMessages({});
        setGitOverlayBusyAction(null);
        setGitOverlayCompletedActions({ push: false, 'review-request': false, merge: false });
        setPromptPlanState({ exists: false, content: '' });
        // Delay showing the loader so fast loads don't flash
        if (showLoaderTimerRef.current) { window.clearTimeout(showLoaderTimerRef.current); }
        showLoaderTimerRef.current = window.setTimeout(() => { setShowLoader(true); }, 300);
        break;
      case 'prompt':
        if (msg.prompt) {
          const incomingPromptId = (String(msg.prompt.id || '__new__').trim() || '__new__');
          const currentPromptId = (currentPromptIdRef.current || '__new__').trim() || '__new__';
          const activeSaveId = (activeSaveIdRef.current || '').trim();
          const previousPromptId = (String(msg.previousId || '').trim() || '');
          const reason: 'open' | 'save' | 'sync' | 'ai-enrichment' | undefined = msg.reason;
          const isOpenPayload = reason === 'open';
          const isNewPromptSaveResponse = currentPromptId === '__new__' && reason === 'save';
          const isRelatedToCurrentPrompt = incomingPromptId === currentPromptId
            || previousPromptId === currentPromptId
            || (activeSaveId !== '' && (incomingPromptId === activeSaveId || previousPromptId === activeSaveId))
            || isNewPromptSaveResponse;

          if (!isOpenPayload && !isRelatedToCurrentPrompt) {
            break;
          }

          if (autoSaveTimerRef.current) {
            window.clearTimeout(autoSaveTimerRef.current);
            autoSaveTimerRef.current = null;
          }

          if (isOpenPayload) {
            if (showLoaderTimerRef.current) { window.clearTimeout(showLoaderTimerRef.current); showLoaderTimerRef.current = null; }
            setShowLoader(false);
            setIsGeneratingTitle(false);
            setIsGeneratingDescription(false);
            setNotice(null);
            setGitOverlayOpen(false);
            setGitOverlayMode('default');
            resetStartChatPreflightTracking();
            setGitOverlaySnapshot(null);
            setGitOverlayFileHistory(null);
            setGitOverlayCommitMessages({});
            setGitOverlayBusyAction(null);
            setGitOverlayCompletedActions({ push: false, 'review-request': false, merge: false });
            setPrompt(msg.prompt);
            localReportDirtyRef.current = false;
            currentPromptIdRef.current = incomingPromptId;
            hasBeenSavedRef.current = Boolean(msg.prompt.id);
            userChangeCounterRef.current = 0;
            saveStartCounterRef.current = 0;
            setIsDirty(false);
            setIsLoaded(true);
            setIsSaving(false);
            activeSaveIdRef.current = null;
            if ((msg.prompt.chatSessionIds || []).length > 0) {
              releaseStartChatPendingState();
              const pid = String(msg.prompt.id || '').trim();
              if (pid && recalcTriggeredForRef.current !== pid) {
                recalcTriggeredForRef.current = pid;
                vscode.postMessage({ type: 'recalcImplementingTime', id: pid, silent: true });
                setIsRecalculating(true);
              }
            }
            requestPromptPlanState(msg.prompt.id);
            break;
          }

          // Reset autosave lock state per prompt to avoid inheriting from previous prompt
          hasBeenSavedRef.current = Boolean(msg.prompt.id);

          if (reason === 'sync') {
            // Background sync (chat completion, recalc, status change) — merge only server-side fields, keep user edits
            setPrompt(prev => ({
              ...prev,
              chatSessionIds: msg.prompt.chatSessionIds ?? prev.chatSessionIds,
              timeSpentImplementing: Math.max(msg.prompt.timeSpentImplementing || 0, prev.timeSpentImplementing || 0),
              timeSpentOnTask: Math.max(msg.prompt.timeSpentOnTask || 0, prev.timeSpentOnTask || 0),
              timeSpentUntracked: Math.max(msg.prompt.timeSpentUntracked || 0, prev.timeSpentUntracked || 0),
              updatedAt: msg.prompt.updatedAt || prev.updatedAt,
              status: msg.prompt.status || prev.status,
              report: (prev.report || '').trim() ? prev.report : (msg.prompt.report || prev.report),
            }));
            // Don't touch isDirty — user's pending edits stay intact
            if ((msg.prompt.chatSessionIds || []).length > 0) {
              releaseStartChatPendingState();
            }
            requestPromptPlanState(msg.prompt.id);
            break;
          }

          if (reason === 'ai-enrichment') {
            // Background AI enrichment may also rename the prompt slug after the title changes.
            const enrichedPrompt = {
              ...promptRef.current,
              id: msg.prompt.id || promptRef.current.id,
              promptUuid: msg.prompt.promptUuid || promptRef.current.promptUuid,
              title: msg.prompt.title || promptRef.current.title,
              description: msg.prompt.description || promptRef.current.description,
              updatedAt: msg.prompt.updatedAt || promptRef.current.updatedAt,
            };
            promptRef.current = enrichedPrompt;
            setPrompt(enrichedPrompt);
            const nextPromptId = (String(msg.prompt.id || '').trim() || '');
            if (nextPromptId && nextPromptId !== '__new__' && nextPromptId !== currentPromptIdRef.current) {
              currentPromptIdRef.current = nextPromptId;
            }
            if (previousPromptId && activeSaveIdRef.current === previousPromptId && nextPromptId) {
              activeSaveIdRef.current = nextPromptId;
            }
            // Don't touch isDirty — user's pending edits stay intact
            requestPromptPlanState(msg.prompt.id);
            break;
          }

          const userChangedAfterSave = userChangeCounterRef.current !== saveStartCounterRef.current;
          const shouldMergeAfterSave = reason === 'save' && userChangedAfterSave && saveStartCounterRef.current > 0;
          if (shouldMergeAfterSave) {
            // User changed something after save started — merge only server-generated fields, keep user edits
          const mergedPrompt = {
            ...promptRef.current,
            id: msg.prompt.id || promptRef.current.id,
            title: promptRef.current.title || msg.prompt.title,
            description: promptRef.current.description || msg.prompt.description,
            updatedAt: msg.prompt.updatedAt,
            chatSessionIds: msg.prompt.chatSessionIds || promptRef.current.chatSessionIds,
            timeSpentWriting: Math.max(msg.prompt.timeSpentWriting || 0, promptRef.current.timeSpentWriting || 0),
            timeSpentImplementing: Math.max(msg.prompt.timeSpentImplementing || 0, promptRef.current.timeSpentImplementing || 0),
            timeSpentOnTask: Math.max(msg.prompt.timeSpentOnTask || 0, promptRef.current.timeSpentOnTask || 0),
            timeSpentUntracked: Math.max(msg.prompt.timeSpentUntracked || 0, promptRef.current.timeSpentUntracked || 0),
          };
          promptRef.current = mergedPrompt;
          setPrompt(mergedPrompt);
            // Keep isDirty = true so next auto-save picks up user's changes
          } else {
          promptRef.current = msg.prompt;
            setPrompt(msg.prompt);
            localReportDirtyRef.current = false;
            setIsDirty(false);
          }
          if (pendingReportOverrideRef.current !== null && (msg.prompt.report || '') === pendingReportOverrideRef.current) {
            logReportDebug('prompt.override-confirmed', {
              promptId: incomingPromptId,
              reportLength: (msg.prompt.report || '').length,
            });
            pendingReportOverrideRef.current = null;
          }
          // Update currentPromptIdRef when backend assigns a real ID to a new prompt
          if (incomingPromptId !== currentPromptId && incomingPromptId !== '__new__') {
            currentPromptIdRef.current = incomingPromptId;
          }
          setIsLoaded(true);
          setIsSaving(false);
          setIsGeneratingTitle(false);
          setIsGeneratingDescription(false);
          activeSaveIdRef.current = null;
          if ((msg.prompt.chatSessionIds || []).length > 0) {
            releaseStartChatPendingState();
            // Auto-recalc implementing time on first load
            const pid = String(msg.prompt.id || '').trim();
            if (pid && recalcTriggeredForRef.current !== pid) {
              recalcTriggeredForRef.current = pid;
              vscode.postMessage({ type: 'recalcImplementingTime', id: pid, silent: true });
              setIsRecalculating(true);
            }
          }
          requestPromptPlanState(msg.prompt.id);
        }
        break;
      case 'promptPlanUpdated':
        {
          const incomingPromptId = String(msg.promptId || '').trim();
          const currentPromptId = String(currentPromptIdRef.current || '').trim();
          if (incomingPromptId && currentPromptId && incomingPromptId !== currentPromptId) {
            break;
          }

          setPromptPlanState({
            exists: Boolean(msg.exists),
            content: Boolean(msg.exists) ? String(msg.content || '') : '',
          });
        }
        break;
      case 'promptSaved':
        setIsSaving(false);
        // Only clear isDirty if user hasn't changed anything since save started
        if (userChangeCounterRef.current === saveStartCounterRef.current) {
          setIsDirty(false);
        }
        // Don't clear activeSaveIdRef here — the 'prompt' handler (reason: 'save')
        // that follows needs it to match the incoming prompt to the current panel.
        break;
      case 'promptSaving':
        {
          const incomingId = String(msg.id || '').trim() || '__new__';
          const currentId = currentPromptIdRef.current || '__new__';
          const activeSaveId = activeSaveIdRef.current;
          const isRelated = incomingId === currentId || incomingId === activeSaveId;
          if (!isRelated) {
            break;
          }
          setIsSaving(Boolean(msg.saving));
          if (!msg.saving) {
            activeSaveIdRef.current = null;
          }
        }
        break;
      case 'promptContentUpdated':
        // Content updated from external editor — show changes but do NOT auto-save
        // (user decides when to save in the external editor)
        setPrompt(prev => {
          const nextContent = msg.content || '';
          const activityDeltaMs = Number.isFinite(msg.writingDeltaMs) ? Math.max(0, Number(msg.writingDeltaMs)) : 0;
          const deltaPatch = TimeTrackingService.buildElapsedPatch(prev.status, activityDeltaMs);
          const nextTimePatch = Object.keys(deltaPatch).length > 0
            ? {
              ...(deltaPatch.timeSpentWriting !== undefined
                ? { timeSpentWriting: (prev.timeSpentWriting || 0) + deltaPatch.timeSpentWriting }
                : {}),
              ...(deltaPatch.timeSpentOnTask !== undefined
                ? { timeSpentOnTask: (prev.timeSpentOnTask || 0) + deltaPatch.timeSpentOnTask }
                : {}),
            }
            : null;
          if (prev.content === nextContent) {
            if (!nextTimePatch || activityDeltaMs <= 0) {
              return prev;
            }
            return { ...prev, ...nextTimePatch };
          }
          return {
            ...prev,
            content: nextContent,
            ...(nextTimePatch || {}),
          };
        });
        openedAtRef.current = Date.now();
        break;
      case 'reportContentUpdated':
        {
        const currentReport = promptRef.current.report || '';
        const incomingReport = typeof msg.report === 'string' ? msg.report : currentReport;
        if (pendingReportOverrideRef.current !== null && incomingReport !== pendingReportOverrideRef.current) {
          logReportDebug('reportContentUpdated.ignored.pendingOverride', {
            promptId: promptRef.current.id || '__new__',
            previousLength: currentReport.length,
            incomingLength: incomingReport.length,
            pendingLength: pendingReportOverrideRef.current.length,
          });
          break;
        }
        if (pendingReportOverrideRef.current !== null && incomingReport === pendingReportOverrideRef.current) {
          logReportDebug('reportContentUpdated.override-confirmed', {
            promptId: promptRef.current.id || '__new__',
            incomingLength: incomingReport.length,
          });
          pendingReportOverrideRef.current = null;
        }
        const hasLocalUnsavedReportChanges = localReportDirtyRef.current && incomingReport !== currentReport;

        logReportDebug('reportContentUpdated.received', {
          promptId: promptRef.current.id || '__new__',
          previousLength: currentReport.length,
          incomingLength: incomingReport.length,
          dirty: isDirtyRef.current,
          ignoredDueToDirty: hasLocalUnsavedReportChanges,
        });

        setPrompt(prev => {
          const nextReport = hasLocalUnsavedReportChanges ? prev.report : incomingReport;
          logReportDebug('reportContentUpdated.stateApply', {
            promptId: prev.id || '__new__',
            previousLength: (prev.report || '').length,
            nextLength: (nextReport || '').length,
            usedIncoming: !hasLocalUnsavedReportChanges,
          });
          return {
            ...prev,
            report: nextReport,
            timeSpentWriting: Math.max(msg.timeSpentWriting || 0, prev.timeSpentWriting || 0),
            timeSpentOnTask: Math.max(msg.timeSpentOnTask || 0, prev.timeSpentOnTask || 0),
            updatedAt: msg.updatedAt || prev.updatedAt,
          };
        });
        if (!hasLocalUnsavedReportChanges) {
          localReportDirtyRef.current = false;
        }
        hasBeenSavedRef.current = true;
        break;
        }
      case 'contentEditorOpened':
        isExternalEditorOpenRef.current = true;
        break;
      case 'contentEditorClosed':
        isExternalEditorOpenRef.current = false;
        if (msg.reverted && msg.content !== undefined) {
          // External editor was closed without saving — revert content to saved version
          setPrompt(prev => {
            if (prev.content === msg.content) {
              return prev;
            }
            return { ...prev, content: msg.content };
          });
          setIsDirty(false);
        }
        break;
      case 'contentEditorSaved':
        // External editor saved — trigger auto-save of the full prompt
        userChangeCounterRef.current++;
        setIsDirty(true);
        scheduleAutoSave(50);
        break;
      case 'workspaceFolders':
        setWorkspaceFolders(msg.folders);
        break;
      case 'availableModels':
        setAvailableModels(msg.models);
        break;
      case 'availableSkills':
        setAvailableSkills(msg.skills);
        break;
      case 'availableMcpTools':
        setAvailableMcpTools(msg.tools);
        break;
      case 'availableHooks':
        setAvailableHooks(msg.hooks);
        break;
      case 'availableLanguages':
        setAvailableLanguages(msg.options);
        break;
      case 'availableFrameworks':
        setAvailableFrameworks(msg.options);
        break;
      case 'allowedBranches':
        setAllowedBranchesSetting(Array.isArray(msg.branches) ? msg.branches : []);
        break;
      case 'gitOverlayTrackedBranchPreference':
        setWorkspaceTrackedBranchPreference((msg.branch || '').trim());
        setWorkspaceTrackedBranchesByProjectPreference(normalizeTrackedBranchesByProject(msg.branchesByProject));
        break;
      case 'globalContext':
        setGlobalContext(msg.context || '');
        break;
      case 'globalContextLoaded':
        setIsLoadingGlobalContext(false);
        setNotice(null);
        setGlobalContext(msg.context || '');
        break;
      case 'globalContextLoadFailed':
        setIsLoadingGlobalContext(false);
        showInlineNotice('error', msg.message || 'Не удалось загрузить общую инструкцию.');
        break;
      case 'triggerStartChat':
        {
          const targetPromptId = (msg.promptId || currentPromptIdRef.current || '__new__').trim() || '__new__';
          const currentPromptId = (currentPromptIdRef.current || '__new__').trim() || '__new__';
          if (isLoaded && targetPromptId === currentPromptId) {
            handleStartChatRef.current();
            break;
          }

          setPendingExternalStartChatPromptId(targetPromptId);
        }
        break;
      case 'startChatPreflightResult':
        {
          const requestId = (msg.requestId || '').trim();
          const matchesPreflightRequest = requestId === pendingChatStartPreflightRequestIdRef.current;
          const matchesStartRequest = requestId === pendingChatStartRequestIdRef.current;
          if (requestId && !matchesPreflightRequest && !matchesStartRequest) {
            break;
          }

          const preflightAction: ChatEntryAction = matchesStartRequest
            ? 'start'
            : (pendingChatPreflightActionRef.current || 'start');

          pendingChatStartPreflightRequestIdRef.current = '';
          pendingChatPreflightActionRef.current = '';
          if (matchesStartRequest) {
            resetChatStartRequestTracking();
            releaseStartChatPendingState({ resetSaving: true });
          } else {
            releaseStartChatPendingState();
          }

          if (msg.shouldOpenGitFlow) {
            pendingGitOverlayStartChatRequestIdRef.current = requestId;
            setGitOverlayMode(preflightAction === 'open' ? 'open-chat-preflight' : 'start-chat-preflight');
            setGitOverlayOpen(true);
            setGitOverlaySnapshot(msg.snapshot || null);
            setGitOverlayFileHistory(null);
            setGitOverlayCommitMessages({});
            setGitOverlayBusyAction(null);
            setGitOverlayCompletedActions({ push: false, 'review-request': false, merge: false });
            break;
          }

          if (preflightAction === 'open') {
            continueOpenChat();
            break;
          }

          dispatchStartChat(requestId || createStartChatRequestId(), { skipBranchMismatchCheck: true });
        }
        break;
      case 'chatStarted':
        if (!shouldHandleChatStartMessage(msg.requestId)) {
          break;
        }
        if ((msg.requestId || '').trim() === pendingChatStartRequestIdRef.current) {
          acceptedChatStartRequestIdRef.current = pendingChatStartRequestIdRef.current;
          pendingChatStartRequestIdRef.current = '';
        }
        if (promptRef.current.status !== 'in-progress') {
          const nextPrompt = { ...promptRef.current, status: 'in-progress' as const };
          promptRef.current = nextPrompt;
          setPrompt(nextPrompt);
        }
        releaseStartChatPendingState();
        break;
      case 'chatOpened':
        if (!shouldHandleChatStartMessage(msg.requestId)) {
          break;
        }
        if ((msg.requestId || '').trim() === pendingChatStartRequestIdRef.current) {
          acceptedChatStartRequestIdRef.current = pendingChatStartRequestIdRef.current;
          pendingChatStartRequestIdRef.current = '';
        }
        if (promptRef.current.status !== 'in-progress') {
          const nextPrompt = { ...promptRef.current, status: 'in-progress' as const };
          promptRef.current = nextPrompt;
          setPrompt(nextPrompt);
        }
        releaseStartChatPendingState();
        setIsChatPanelOpen(true);
        break;
      case 'generatedTitle':
        setIsGeneratingTitle(false);
        setPrompt(prev => ({ ...prev, title: msg.title }));
        userChangeCounterRef.current++;
        setIsDirty(true);
        scheduleAutoSave(50);
        break;
      case 'generatedDescription':
        setIsGeneratingDescription(false);
        setPrompt(prev => ({ ...prev, description: msg.description }));
        userChangeCounterRef.current++;
        setIsDirty(true);
        scheduleAutoSave(50);
        break;
      case 'generatedSlug':
        setPrompt(prev => ({ ...prev, id: msg.slug }));
        userChangeCounterRef.current++;
        setIsDirty(true);
        scheduleAutoSave(50);
        break;
      case 'improvedPromptText':
        setPrompt(prev => {
          const activityDeltaMs = Math.max(0, Date.now() - openedAtRef.current);
          const improvedContent = typeof msg.content === 'string'
            ? ensureTrailingNewline(msg.content)
            : prev.content;
          const deltaPatch = TimeTrackingService.buildElapsedPatch(prev.status, activityDeltaMs);
          const updatedPrompt: Prompt = {
            ...prev,
            content: improvedContent,
            ...(deltaPatch.timeSpentWriting !== undefined
              ? { timeSpentWriting: (prev.timeSpentWriting || 0) + deltaPatch.timeSpentWriting }
              : {}),
            ...(deltaPatch.timeSpentOnTask !== undefined
              ? { timeSpentOnTask: (prev.timeSpentOnTask || 0) + deltaPatch.timeSpentOnTask }
              : {}),
          };
          openedAtRef.current = Date.now();
          if (hasBeenSavedRef.current) {
            activeSaveIdRef.current = (updatedPrompt.id || '__new__').trim() || '__new__';
            setIsSaving(true);
            setIsDirty(false);
            vscode.postMessage({ type: 'savePrompt', prompt: updatedPrompt, source: 'autosave' });
          } else {
            setIsDirty(true);
          }
          return updatedPrompt;
        });
        setIsImprovingPromptText(false);
        break;
      case 'generatedReport':
        setPrompt(prev => ({
          ...prev,
          report: typeof msg.report === 'string' ? msg.report : prev.report,
        }));
        userChangeCounterRef.current++;
        setIsDirty(true);
        setIsGeneratingReport(false);
        scheduleAutoSave(50);
        break;
      case 'gitOverlayBusy':
        setGitOverlayBusyAction((previousBusyAction) => {
          const nextBusyAction = (msg.action || '').trim() || null;
          if (!nextBusyAction) {
            if (
              previousBusyAction
              && previousBusyAction !== 'overlay:loading'
              && !previousBusyAction.startsWith('refresh:')
            ) {
              return previousBusyAction;
            }

            return null;
          }

          if (
            previousBusyAction
            && previousBusyAction !== 'overlay:loading'
            && !previousBusyAction.startsWith('refresh:')
          ) {
            return previousBusyAction;
          }

          return nextBusyAction;
        });
        break;
      case 'gitOverlaySnapshot':
        logGitOverlayDebug('snapshot.received', {
          projectCount: Array.isArray(msg.snapshot?.projects) ? msg.snapshot.projects.length : 0,
          promptBranch: String(msg.snapshot?.promptBranch || '').trim(),
          trackedBranchCount: Array.isArray(msg.snapshot?.trackedBranches) ? msg.snapshot.trackedBranches.length : 0,
        });
        setGitOverlaySnapshot(msg.snapshot || null);
        setGitOverlayCommitMessages((prev) => {
          if (!msg.snapshot) {
            return {};
          }

          const next: Record<string, string> = {};
          for (const project of msg.snapshot.projects || []) {
            const totalChanges = project.changeGroups.merge.length
              + project.changeGroups.staged.length
              + project.changeGroups.workingTree.length
              + project.changeGroups.untracked.length;
            if (project.available && totalChanges > 0 && prev[project.project]) {
              next[project.project] = prev[project.project];
            }
          }
          return next;
        });
        setGitOverlayBusyAction(null);
        break;
      case 'gitOverlayFileHistory':
        setGitOverlayFileHistory(msg.history || null);
        setGitOverlayBusyAction(null);
        break;
      case 'gitOverlayCommitMessagesGenerated':
        setGitOverlayCommitMessages((prev) => {
          const next = { ...prev };
          for (const item of msg.messages || []) {
            const projectName = (item.project || '').trim();
            if (!projectName) {
              continue;
            }
            next[projectName] = item.message || '';
          }
          return next;
        });
        setGitOverlayBusyAction(null);
        break;
      case 'gitOverlayActionCompleted':
        setGitOverlayCompletedActions((prev) => ({
          ...prev,
          [msg.action]: true,
        }));
        setGitOverlayBusyAction(null);
        break;
      case 'pickedFiles':
        if (msg.files && msg.files.length > 0) {
          setPrompt(prev => ({
            ...prev,
            contextFiles: [...prev.contextFiles, ...msg.files],
          }));
          userChangeCounterRef.current++;
          setIsDirty(true);
          scheduleAutoSave(50);
        }
        break;
      case 'pickedHttpExamplesFile': {
        const nextFile = (msg.file || '').trim();
        const currentFile = (promptRef.current.httpExamples || '').trim();
        if (!nextFile || nextFile === currentFile) {
          break;
        }
        setPrompt(prev => ({
          ...prev,
          httpExamples: nextFile,
        }));
        userChangeCounterRef.current++;
        setIsDirty(true);
        scheduleAutoSave(50);
        break;
      }
      case 'branches':
        setBranches(msg.branches);
        setBranchesResolved(true);
        break;
      case 'nextTaskNumber':
        setPrompt(prev => ({ ...prev, taskNumber: msg.taskNumber }));
        userChangeCounterRef.current++;
        setIsDirty(true);
        scheduleAutoSave(50);
        break;
      case 'inlineSuggestion':
        setInlineSuggestion(msg.suggestion || '');
        break;
      case 'inlineSuggestions':
        setInlineSuggestions(msg.suggestions || []);
        break;
      case 'branchStatus':
        if (msg.hasChanges) {
          // Show warning about uncommitted changes
        }
        break;
      case 'error':
        if ((msg.requestId || '').trim()) {
          const requestId = (msg.requestId || '').trim();
          const matchesPendingRequest = requestId === pendingChatStartRequestIdRef.current;
          const matchesPreflightRequest = requestId === pendingChatStartPreflightRequestIdRef.current;
          if (!matchesPendingRequest && !matchesPreflightRequest) {
            break;
          }
        }
        releaseStartChatPendingState({ resetSaving: true });
        setIsSaving(false);
        setIsGeneratingTitle(false);
        setIsGeneratingDescription(false);
        setIsImprovingPromptText(false);
        setIsGeneratingReport(false);
        setIsRecalculating(false);
        setGitOverlayBusyAction(null);
        activeSaveIdRef.current = null;
        resetChatStartRequestTracking();
        resetStartChatPreflightTracking();
        showInlineNotice('error', msg.message);
        break;
      case 'info':
        setGitOverlayBusyAction(null);
        showInlineNotice('info', msg.message);
        break;
      case 'clearNotice':
        clearChatStartTimeout();
        startChatLockRef.current = false;
        setIsStartingChat(false);
        resetChatStartRequestTracking();
        resetStartChatPreflightTracking();
        setNotice(null);
        break;
      case 'implementingTimeRecalculated':
        setIsRecalculating(false);
        break;
    }
  }, [clearChatStartTimeout, createStartChatRequestId, dispatchStartChat, releaseStartChatPendingState, resetChatStartRequestTracking, resetStartChatPreflightTracking, shouldHandleChatStartMessage, showInlineNotice]);

  useMessageListener(handleMessage);

  useEffect(() => () => {
    clearChatStartTimeout();
  }, [clearChatStartTimeout]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') {
        return;
      }
      clearChatStartTimeout();
      startChatLockRef.current = false;
      setIsStartingChat(false);
      resetChatStartRequestTracking();
      resetStartChatPreflightTracking();
      setNotice(null);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [clearChatStartTimeout, resetChatStartRequestTracking, resetStartChatPreflightTracking]);

  // Notify extension about dirty state changes
  useEffect(() => {
    vscode.postMessage({ type: 'markDirty', dirty: isDirty, prompt: isDirty ? prompt : undefined, promptId: currentPromptIdRef.current || '' });
  }, [isDirty, prompt]);

  /** Ref to track whether auto-expand already fired for this prompt load */
  const branchAutoExpandedRef = useRef(false);

  useEffect(() => {
    if (prompt.projects.length === 0) {
      setBranchesResolved(false);
      setBranches([]);
      setShowBranches(false);
      return;
    }
    setBranchesResolved(false);
    branchAutoExpandedRef.current = false;
    vscode.postMessage({ type: 'getBranches', projects: prompt.projects });
  }, [prompt.projects]);

  // Auto-expand branch list on first resolve if mismatch detected
  useEffect(() => {
    if (branchesResolved && hasBranchMismatch && !branchAutoExpandedRef.current) {
      branchAutoExpandedRef.current = true;
      setShowBranches(true);
    }
  }, [branchesResolved, hasBranchMismatch]);

  useEffect(() => {
    if (!promptContentHeight) {
      return;
    }
    const currentState = (vscode.getState?.() || {}) as Record<string, unknown>;
    vscode.setState?.({ ...currentState, 'pm.editor.promptContentHeight': promptContentHeight });
    if (storage) {
      storage.setItem('pm.editor.promptContentHeight', String(promptContentHeight));
    }
  }, [promptContentHeight, storage]);

  useEffect(() => {
    if (!reportHeight) {
      return;
    }
    const currentState = (vscode.getState?.() || {}) as Record<string, unknown>;
    vscode.setState?.({ ...currentState, 'pm.editor.reportHeight': reportHeight });
    if (storage) {
      storage.setItem('pm.editor.reportHeight', String(reportHeight));
    }
  }, [reportHeight, storage]);

  useEffect(() => {
    if (!globalContextHeight) {
      return;
    }
    const currentState = (vscode.getState?.() || {}) as Record<string, unknown>;
    vscode.setState?.({ ...currentState, 'pm.editor.globalContextHeight': globalContextHeight });
    if (storage) {
      storage.setItem('pm.editor.globalContextHeight', String(globalContextHeight));
    }
  }, [globalContextHeight, storage]);

  useEffect(() => {
    const currentState = (vscode.getState?.() || {}) as Record<string, unknown>;
    vscode.setState?.({ ...currentState, 'pm.editor.expandedSections': expandedSections });
    if (storage) {
      storage.setItem('pm.editor.expandedSections', JSON.stringify(expandedSections));
    }
  }, [expandedSections, storage]);

  useEffect(() => {
    if (!globalContextTextareaRef.current || typeof ResizeObserver === 'undefined') {
      return;
    }
    const textarea = globalContextTextareaRef.current;
    const observer = new ResizeObserver(() => {
      const nextHeight = Math.round(textarea.getBoundingClientRect().height);
      if (nextHeight > 0) {
        setGlobalContextHeight(nextHeight);
      }
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, []);

  const applyElapsedTimeByContext = useCallback((basePrompt: Prompt, elapsedMs: number): Prompt => {
    return TimeTrackingService.applyElapsedToPrompt(basePrompt, elapsedMs);
  }, []);

  /** Schedule an auto-save with the given delay. Cancels any pending auto-save. */
  const scheduleAutoSave = (delayMs: number) => {
    // Never auto-save a prompt that hasn't been saved manually at least once
    if (!hasBeenSavedRef.current) {
      return;
    }
    if (autoSaveTimerRef.current) {
      window.clearTimeout(autoSaveTimerRef.current);
    }
    autoSaveTimerRef.current = window.setTimeout(() => {
      autoSaveTimerRef.current = null;
      // Double-check in case ref was reset between scheduling and execution
      if (!hasBeenSavedRef.current) {
        return;
      }
      // If already saving, reschedule
      if (isSavingRef.current) {
        scheduleAutoSave(1500);
        return;
      }
      const currentPrompt = promptRef.current;
      const timeSpent = Date.now() - openedAtRef.current;
      const updatedPrompt = applyElapsedTimeByContext(currentPrompt, timeSpent);
      openedAtRef.current = Date.now();
      saveStartCounterRef.current = userChangeCounterRef.current;
      activeSaveIdRef.current = (updatedPrompt.id || '__new__').trim() || '__new__';
      setIsSaving(true);
      setIsDirty(false);
      vscode.postMessage({ type: 'savePrompt', prompt: updatedPrompt, source: 'autosave' });
    }, delayMs);
  };

  const handleVoiceTranscriptionReady = (text: string) => {
    const normalized = text.trim();
    if (!normalized) {
      return;
    }

    setShowPreview(false);
    setInlineSuggestion('');
    setInlineSuggestions([]);
    setPrompt(prev => ({
      ...prev,
      content: appendRecognizedPromptText(prev.content, normalized),
    }));
    userChangeCounterRef.current++;
    setIsDirty(true);
    scheduleAutoSave(1500);
    setPromptContentFocusSignal(prev => prev + 1);
  };

  const voiceController = usePromptVoiceController({
    onOpen: () => {
      setShowPreview(false);
      setInlineSuggestion('');
      setInlineSuggestions([]);
    },
    onTranscriptionReady: handleVoiceTranscriptionReady,
  });

  /** Update a text field with debounced auto-save (1.5 s). */
  const updateField = <K extends keyof Prompt>(field: K, value: Prompt[K]) => {
    setPrompt(prev => ({ ...prev, [field]: value }));
    if (field === 'report') {
      localReportDirtyRef.current = true;
    }
    if (field !== 'timeSpentWriting' && field !== 'timeSpentImplementing') {
      userChangeCounterRef.current++;
      setIsDirty(true);
      scheduleAutoSave(1500);
    }
  };

  /** Update a select/toggle field with near-immediate auto-save. */
  const updateFieldAndSaveNow = <K extends keyof Prompt>(field: K, value: Prompt[K]) => {
    setPrompt(prev => ({ ...prev, [field]: value }));
    if (field === 'report') {
      localReportDirtyRef.current = true;
    }
    if (field !== 'timeSpentWriting' && field !== 'timeSpentImplementing') {
      userChangeCounterRef.current++;
      setIsDirty(true);
      scheduleAutoSave(50);
    }
  };

  const handleOpenGitOverlay = useCallback(() => {
	resetStartChatPreflightTracking();
	setGitOverlayMode('default');
    logGitOverlayDebug('open.requested', {
      promptId: prompt.id || '__new__',
      promptBranch: prompt.branch.trim(),
      projectCount: prompt.projects.length,
      projects: prompt.projects,
    });
    setGitOverlayOpen(true);
    setGitOverlayFileHistory(null);
    setGitOverlayBusyAction('overlay:loading');
    vscode.postMessage({
      type: 'openGitOverlay',
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
    });
  }, [logGitOverlayDebug, prompt.branch, prompt.id, prompt.projects, resetStartChatPreflightTracking]);

  const handleGitOverlayTrackedBranchChange = (trackedBranchesByProject: Record<string, string>) => {
    const normalizedTrackedBranchesByProject = normalizeTrackedBranchesByProject(trackedBranchesByProject);
    const normalizedTrackedBranch = resolveSingleTrackedBranch(normalizedTrackedBranchesByProject);
    const currentTrackedBranchesByProject = normalizeTrackedBranchesByProject(promptRef.current.trackedBranchesByProject);
    const currentTrackedBranch = (promptRef.current.trackedBranch || '').trim();

    if (
      !areTrackedBranchesByProjectEqual(normalizedTrackedBranchesByProject, currentTrackedBranchesByProject)
      || normalizedTrackedBranch !== currentTrackedBranch
    ) {
      setPrompt(prev => ({
        ...prev,
        trackedBranch: normalizedTrackedBranch,
        trackedBranchesByProject: normalizedTrackedBranchesByProject,
      }));
      userChangeCounterRef.current++;
      setIsDirty(true);
      scheduleAutoSave(50);
    }

    setWorkspaceTrackedBranchPreference(normalizedTrackedBranch);
    setWorkspaceTrackedBranchesByProjectPreference(prev => ({
      ...prev,
      ...normalizedTrackedBranchesByProject,
    }));
    vscode.postMessage({
      type: 'saveGitOverlayTrackedBranchPreference',
      branch: normalizedTrackedBranch,
      branchesByProject: normalizedTrackedBranchesByProject,
    });
  };

  const handleRefreshGitOverlay = useCallback((mode: 'local' | 'fetch' | 'sync' = 'local') => {
    setGitOverlayBusyAction(`refresh:${mode}`);
    vscode.postMessage({
      type: 'refreshGitOverlay',
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
      mode,
    });
  }, [prompt.branch, prompt.projects]);

  const handleGitOverlaySwitchBranch = useCallback((trackedBranchesByProject: Record<string, string>) => {
    const normalizedTrackedBranchesByProject = normalizeTrackedBranchesByProject(trackedBranchesByProject);
    const branch = resolveSingleTrackedBranch(normalizedTrackedBranchesByProject);
    logGitOverlayDebug('switchBranch.requested', {
      branch,
      trackedBranchesByProject: normalizedTrackedBranchesByProject,
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
      mode: gitOverlayMode,
      previousBusyAction: gitOverlayBusyAction,
    });
    setGitOverlayBusyAction('switchBranch:tracked');
    vscode.postMessage({
      type: 'gitOverlaySwitchBranch',
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
      branch,
      trackedBranchesByProject: normalizedTrackedBranchesByProject,
    });
  }, [gitOverlayBusyAction, gitOverlayMode, logGitOverlayDebug, prompt.branch, prompt.projects, t]);

  const handleGitOverlayEnsurePromptBranch = useCallback((trackedBranchesByProject: Record<string, string>) => {
    const normalizedTrackedBranchesByProject = normalizeTrackedBranchesByProject(trackedBranchesByProject);
    const trackedBranch = resolveSingleTrackedBranch(normalizedTrackedBranchesByProject);
    setGitOverlayBusyAction('ensurePromptBranch');
    vscode.postMessage({
      type: 'gitOverlayEnsurePromptBranch',
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
      trackedBranch,
      trackedBranchesByProject: normalizedTrackedBranchesByProject,
    });
  }, [prompt.branch, prompt.projects]);

  const handleGitOverlayMergePromptBranch = useCallback((
    trackedBranchesByProject: Record<string, string>,
    stayOnTrackedBranch: boolean,
    projects?: string[],
  ) => {
    const normalizedTrackedBranchesByProject = normalizeTrackedBranchesByProject(trackedBranchesByProject);
    const trackedBranch = resolveSingleTrackedBranch(normalizedTrackedBranchesByProject);
    setGitOverlayBusyAction('mergePromptBranch');
    vscode.postMessage({
      type: 'gitOverlayMergePromptBranch',
      promptBranch: prompt.branch.trim(),
      projects: (projects && projects.length > 0 ? projects : prompt.projects),
      trackedBranch,
      trackedBranchesByProject: normalizedTrackedBranchesByProject,
      stayOnTrackedBranch,
    });
  }, [prompt.branch, prompt.projects]);

  const handleGitOverlayApplyBranchTargets = useCallback((
    sourceBranchesByProject: Record<string, string>,
    targetBranchesByProject: Record<string, string>,
    project?: string,
  ) => {
    const normalizedSourceBranchesByProject = normalizeTrackedBranchesByProject(sourceBranchesByProject);
    const normalizedTargetBranchesByProject = normalizeTrackedBranchesByProject(targetBranchesByProject);
    setGitOverlayBusyAction(project ? `applyBranchTargets:${project}` : 'applyBranchTargets:all');
    vscode.postMessage({
      type: 'gitOverlayApplyBranchTargets',
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
      sourceBranchesByProject: normalizedSourceBranchesByProject,
      targetBranchesByProject: normalizedTargetBranchesByProject,
    });
  }, [prompt.branch, prompt.projects]);

  const handleGitOverlayDeleteBranch = useCallback((branch: string) => {
    setGitOverlayBusyAction(`${t('editor.gitOverlayDeleteBranch')}: ${branch}`);
    vscode.postMessage({
      type: 'gitOverlayDeleteBranch',
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
      branch,
    });
  }, [prompt.branch, prompt.projects, t]);

  const handleGitOverlayPush = useCallback((branch?: string, projects?: string[]) => {
    setGitOverlayBusyAction('pushPromptBranch');
    vscode.postMessage({
      type: 'gitOverlayPush',
      promptBranch: prompt.branch.trim(),
      projects: (projects && projects.length > 0 ? projects : prompt.projects),
      branch,
    });
  }, [prompt.branch, prompt.projects]);

  const handleGitOverlayStageAll = useCallback((project?: string, trackedOnly?: boolean) => {
    setGitOverlayBusyAction(trackedOnly ? t('editor.gitOverlayStageTracked') : t('editor.gitOverlayStageAll'));
    vscode.postMessage({
      type: 'gitOverlayStageAll',
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
      project,
      trackedOnly,
    });
  }, [prompt.branch, prompt.projects, t]);

  const handleGitOverlayUnstageAll = useCallback((project?: string) => {
    setGitOverlayBusyAction(t('editor.gitOverlayUnstageAll'));
    vscode.postMessage({
      type: 'gitOverlayUnstageAll',
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
      project,
    });
  }, [prompt.branch, prompt.projects, t]);

  const handleGitOverlayStageFile = useCallback((project: string, filePath: string) => {
    setGitOverlayBusyAction(`${t('editor.gitOverlayStage')}: ${filePath}`);
    vscode.postMessage({
      type: 'gitOverlayStageFile',
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
      project,
      filePath,
    });
  }, [prompt.branch, prompt.projects, t]);

  const handleGitOverlayUnstageFile = useCallback((project: string, filePath: string) => {
    setGitOverlayBusyAction(`${t('editor.gitOverlayUnstage')}: ${filePath}`);
    vscode.postMessage({
      type: 'gitOverlayUnstageFile',
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
      project,
      filePath,
    });
  }, [prompt.branch, prompt.projects, t]);

  const handleGitOverlayLoadFileHistory = useCallback((project: string, filePath: string) => {
    setGitOverlayBusyAction(`${t('editor.gitOverlayFileHistory')}: ${filePath}`);
    vscode.postMessage({ type: 'gitOverlayLoadFileHistory', project, filePath });
  }, [t]);

  const handleGitOverlayOpenFile = useCallback((project: string, filePath: string) => {
    vscode.postMessage({ type: 'gitOverlayOpenFile', project, filePath });
  }, []);

  const handleGitOverlayOpenDiff = useCallback((project: string, filePath: string) => {
    vscode.postMessage({ type: 'gitOverlayOpenDiff', project, filePath });
  }, []);

  const handleGitOverlayDiscardFile = useCallback((project: string, filePath: string, group: GitOverlayChangeGroup, previousPath?: string) => {
    setGitOverlayBusyAction(`discardFile:${project}:${group}:${filePath}`);
    vscode.postMessage({
      type: 'gitOverlayDiscardFile',
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
      project,
      filePath,
      previousPath,
      group,
    });
  }, [prompt.branch, prompt.projects]);

  const handleGitOverlayDiscardProjectChanges = useCallback((project: string, changes: GitOverlayChangeFile[]) => {
    setGitOverlayBusyAction(`discardProject:${project}`);
    vscode.postMessage({
      type: 'gitOverlayDiscardProjectChanges',
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
      project,
      changes,
    });
  }, [prompt.branch, prompt.projects]);

  const handleGitOverlayOpenMergeEditor = useCallback((project: string, filePath: string) => {
    vscode.postMessage({ type: 'gitOverlayOpenMergeEditor', project, filePath });
  }, []);

  const handleGitOverlayCommitMessageChange = useCallback((project: string, value: string) => {
    setGitOverlayCommitMessages((prev) => ({
      ...prev,
      [project]: value,
    }));
  }, []);

  const handleGitOverlayGenerateCommitMessage = useCallback((project?: string) => {
    setGitOverlayBusyAction(project ? `generateCommitMessage:${project}` : 'generateCommitMessage:all');
    vscode.postMessage({
      type: 'gitOverlayGenerateCommitMessage',
      prompt: buildPromptForSave(),
      project,
      includeAllChanges: true,
    });
  }, []);

  const handleGitOverlayCommitStaged = useCallback((messages: GitOverlayProjectCommitMessage[]) => {
    const normalizedMessages = (messages || [])
      .map((item) => ({
        project: (item.project || '').trim(),
        message: (item.message || '').trim(),
      }))
      .filter(item => Boolean(item.project) && Boolean(item.message));

    if (normalizedMessages.length === 0) {
      return;
    }

    setGitOverlayBusyAction(
      normalizedMessages.length === 1
        ? `commitStaged:${normalizedMessages[0].project}`
        : 'commitStaged:all'
    );
    vscode.postMessage({
      type: 'gitOverlayCommitStaged',
      prompt: buildPromptForSave(),
      messages: normalizedMessages,
      includeAllChanges: true,
    });
  }, []);

  const handleGitOverlayCreateReviewRequest = useCallback((requests: GitOverlayProjectReviewRequestInput[]) => {
    const normalizedRequests = (requests || [])
      .map((item) => ({
        project: (item.project || '').trim(),
        targetBranch: (item.targetBranch || '').trim(),
        title: (item.title || '').trim(),
      }))
      .filter(item => Boolean(item.project) && Boolean(item.targetBranch) && Boolean(item.title));

    if (normalizedRequests.length === 0) {
      return;
    }

    setGitOverlayBusyAction(
      normalizedRequests.length === 1
        ? `createReviewRequest:${normalizedRequests[0].project}`
        : 'createReviewRequest:all'
    );
    vscode.postMessage({
      type: 'gitOverlayCreateReviewRequest',
      prompt: buildPromptForSave(),
      requests: normalizedRequests,
    });
  }, []);

  const handleGitOverlayOpenReviewRequest = useCallback((url: string) => {
    vscode.postMessage({ type: 'gitOverlayOpenReviewRequest', url });
  }, []);

  const handleGitOverlaySetupReviewCli = useCallback((request: GitOverlayReviewCliSetupRequest) => {
    const normalizedProject = (request.project || '').trim();
    const normalizedHost = (request.host || '').trim();
    if (!normalizedProject || !normalizedHost || (request.cliCommand !== 'gh' && request.cliCommand !== 'glab')) {
      return;
    }

    vscode.postMessage({
      type: 'gitOverlaySetupReviewCli',
      request: {
        project: normalizedProject,
        cliCommand: request.cliCommand,
        host: normalizedHost,
        action: request.action,
      },
    });
  }, []);

  /** Сохраняет привязку хоста к провайдеру и обновляет overlay */
  const handleGitOverlayAssignReviewProvider = useCallback((host: string, provider: 'github' | 'gitlab') => {
    const normalizedHost = (host || '').trim().toLowerCase();
    if (!normalizedHost || (provider !== 'github' && provider !== 'gitlab')) {
      return;
    }

    vscode.postMessage({
      type: 'gitOverlayAssignReviewProvider',
      host: normalizedHost,
      provider,
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
    });
  }, [prompt.branch, prompt.projects]);

  const handleSave = (source: 'manual' | 'status-change' | 'autosave' | unknown = 'manual') => {
    const normalizedSource: 'manual' | 'status-change' | 'autosave' =
      source === 'status-change' || source === 'autosave' || source === 'manual'
        ? source
        : 'manual';
    const updatedPrompt = buildPromptForSave();

    // First manual save unlocks auto-save for this prompt
    if (normalizedSource === 'manual' || normalizedSource === 'status-change') {
      hasBeenSavedRef.current = true;
    }

    activeSaveIdRef.current = (updatedPrompt.id || prompt.id || '__new__').trim() || '__new__';
    setIsSaving(true);
    vscode.postMessage({ type: 'savePrompt', prompt: updatedPrompt, source: normalizedSource });
  };

  const handleResetReport = () => {
    if (autoSaveTimerRef.current) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }

    const nextPrompt = buildPromptForSaveFrom({
      ...promptRef.current,
      report: '',
    });

    logReportDebug('reset.start', {
      promptId: nextPrompt.id || '__new__',
      previousLength: (promptRef.current.report || '').length,
      nextLength: nextPrompt.report.length,
    });

    pendingReportOverrideRef.current = '';
    localReportDirtyRef.current = true;
    promptRef.current = nextPrompt;
    setPrompt(nextPrompt);
    if (nextPrompt.id) {
      vscode.postMessage({
        type: 'mainReportUpdate',
        promptId: nextPrompt.id,
        report: nextPrompt.report,
      });
    }
    userChangeCounterRef.current++;

    if (!hasBeenSavedRef.current && !nextPrompt.id) {
      logReportDebug('reset.local-only', {
        promptId: nextPrompt.id || '__new__',
      });
      setIsDirty(true);
      return;
    }

    hasBeenSavedRef.current = true;
    saveStartCounterRef.current = userChangeCounterRef.current;
    activeSaveIdRef.current = (nextPrompt.id || '__new__').trim() || '__new__';
    setIsSaving(true);
    setIsDirty(false);
    logReportDebug('reset.save-dispatched', {
      promptId: nextPrompt.id || '__new__',
      reportLength: nextPrompt.report.length,
    });
    vscode.postMessage({ type: 'savePrompt', prompt: nextPrompt, source: 'manual' });
  };

  const handleOpenHttpExamples = useCallback(() => {
    const file = prompt.httpExamples.trim();
    if (!file) {
      return;
    }
    vscode.postMessage({ type: 'openFile', file });
  }, [prompt.httpExamples]);

  const handlePickHttpExamples = useCallback(() => {
    vscode.postMessage({ type: 'pickHttpExamplesFile' });
  }, []);

  const handleStartChat = () => {
    const latestPrompt = promptRef.current;
    const shouldForceRebindChat = latestPrompt.status === 'draft';
    if (startChatLockRef.current || isStartingChat || !latestPrompt.content || (!shouldForceRebindChat && latestPrompt.chatSessionIds.length > 0)) {
      return;
    }
    const preflightRequestId = requestChatEntryPreflight('start');
    if (preflightRequestId) {
      return;
    }

    dispatchStartChat(createStartChatRequestId());
  };

  useEffect(() => {
    handleStartChatRef.current = handleStartChat;
  }, [handleStartChat]);

  useEffect(() => {
    handleOpenChatRef.current = continueOpenChat;
  }, [continueOpenChat]);

  useEffect(() => {
    const targetPromptId = (pendingExternalStartChatPromptId || '').trim();
    if (!targetPromptId || !isLoaded) {
      return;
    }

    const currentPromptId = (currentPromptIdRef.current || '__new__').trim() || '__new__';
    if (targetPromptId !== currentPromptId) {
      return;
    }

    setPendingExternalStartChatPromptId(null);
    handleStartChatRef.current();
  }, [isLoaded, pendingExternalStartChatPromptId, prompt.id]);

  const handleOpenChat = () => {
    const latestPrompt = promptRef.current;
    if (!latestPrompt.content) {
      return;
    }

    const preflightRequestId = requestChatEntryPreflight('open');
    if (preflightRequestId) {
      return;
    }

    continueOpenChat();
  };

  const handleRecalcImplementingTime = () => {
    if (isRecalculating || !prompt.id || prompt.chatSessionIds.length === 0) {
      return;
    }
    setIsRecalculating(true);
    vscode.postMessage({ type: 'recalcImplementingTime', id: prompt.id });
  };

  const handleShowHistory = () => {
    const promptId = (prompt.id || '').trim();
    if (!promptId) {
      return;
    }
    vscode.postMessage({ type: 'showPromptHistory', id: promptId });
  };

  const handleSetStatus = (status: PromptStatus) => {
    const updatedPrompt = {
      ...prompt,
      status,
    };
    setPrompt(updatedPrompt);
    // For never-saved prompts, just mark dirty — don't trigger save
    if (!hasBeenSavedRef.current) {
      setIsDirty(true);
      return;
    }
    // Use buildPromptForSave to also update timeSpentWriting (like manual save)
    const promptToSave = { ...buildPromptForSave(), status };
    setPrompt(promptToSave);
    activeSaveIdRef.current = (promptToSave.id || prompt.id || '__new__').trim() || '__new__';
    setIsSaving(true);
    setIsDirty(false);
    vscode.postMessage({ type: 'savePrompt', prompt: promptToSave, source: 'status-change' });
  };

  const handleStopChatAndSetStatus = () => {
    const promptId = (prompt.id || '').trim();
    if (promptId) {
      vscode.postMessage({ type: 'stopChat', id: promptId });
    }

    handleSetStatus('stopped');
  };

  useEffect(() => {
    if (!isSaving) {
      if (saveTimeoutRef.current) {
        window.clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      return;
    }

    saveTimeoutRef.current = window.setTimeout(() => {
      setIsSaving(false);
      activeSaveIdRef.current = null;
    }, 15000);

    return () => {
      if (saveTimeoutRef.current) {
        window.clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
    };
  }, [isSaving]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isSaveCombo = (event.ctrlKey || event.metaKey)
        && (event.code === 'KeyS' || event.key.toLowerCase() === 's' || event.keyCode === 83);
      if (isSaveCombo) {
        event.preventDefault();
        handleSave('manual');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSave]);

  const handleGenerateTitle = () => {
    if (!prompt.content.trim() || isGeneratingTitle) {
      return;
    }

    setIsGeneratingTitle(true);
    vscode.postMessage({ type: 'generateTitle', content: prompt.content });
  };

  const handleGenerateDescription = () => {
    if (!prompt.content.trim() || isGeneratingDescription) {
      return;
    }

    setIsGeneratingDescription(true);
    vscode.postMessage({ type: 'generateDescription', content: prompt.content });
  };

  const handleImprovePromptText = () => {
    const content = prompt.content.trim();
    if (!content || isImprovingPromptText) {
      return;
    }
    setIsImprovingPromptText(true);
    vscode.postMessage({ type: 'improvePromptText', content, projects: prompt.projects });
  };

  const handleGenerateReport = () => {
    if (isGeneratingReport) {
      return;
    }

    setIsGeneratingReport(true);
    vscode.postMessage({ type: 'generateReportFromStagedChanges', prompt });
  };

  const handleShowBranches = () => {
    if (prompt.projects.length > 0) {
      vscode.postMessage({ type: 'getBranches', projects: prompt.projects });
      setShowBranches(!showBranches);
    }
  };

  const handleSwitchBranch = (branch: string) => {
    vscode.postMessage({ type: 'switchBranch', branch, projects: prompt.projects });
    setShowBranches(false);
  };

  const toggleSection = (key: SectionKey) => {
    setExpandedSections(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const renderSection = (key: SectionKey, title: string, summaryItems: string[], content: React.ReactNode) => {
    const visibleItems = summaryItems.slice(0, 3);
    const hiddenCount = Math.max(0, summaryItems.length - visibleItems.length);

    return (
      <section style={styles.sectionCard}>
      <button
        type="button"
        style={styles.sectionHeaderBtn}
        onClick={() => toggleSection(key)}
        aria-expanded={expandedSections[key]}
      >
        <span style={styles.sectionHeaderLeft}>
          <span style={styles.sectionArrow}>{expandedSections[key] ? '▾' : '▸'}</span>
          <span style={styles.sectionTitle}>{title}</span>
        </span>
        <span
          style={{
            ...styles.sectionSummaryWrap,
            ...(isLoaded ? styles.blockContentVisible : styles.blockContentHidden),
          }}
        >
          {visibleItems.length > 0 ? (
            <>
              {visibleItems.map((item, index) => (
                <span key={`${key}-summary-${index}`} style={styles.sectionSummaryChip} title={item}>
                  {toShortText(item, 34)}
                </span>
              ))}
              {hiddenCount > 0 && (
                <span style={styles.sectionSummaryMore}>+{hiddenCount}</span>
              )}
            </>
          ) : (
            <span style={styles.sectionSummaryEmpty}>Пусто</span>
          )}
        </span>
      </button>
      {expandedSections[key] && (
        <div style={styles.sectionBody}>
          <div
            style={{
              ...styles.sectionBodyContent,
              ...(isLoaded ? styles.blockContentVisible : styles.blockContentHidden),
            }}
          >
            {content}
          </div>
        </div>
      )}
      </section>
    );
  };

  return (
    <div style={styles.container}>
      {/* Loading overlay — covers only the form area width */}
      {showLoader && !isLoaded && (
        <div style={styles.loadingOverlay}>
          <div style={styles.loadingSpinner} />
        </div>
      )}

      <div style={styles.contentShell}>
        {/* Header */}
        <div style={styles.header}>
          <h2
            style={{
              ...styles.headerTitle,
              ...(isLoaded ? styles.blockContentVisible : styles.blockContentHidden),
            }}
          >
            {prompt.title || prompt.id || t('editor.newPrompt')}
          </h2>
          <span
            style={{
              ...styles.dirtyIndicator,
              ...((isLoaded && isDirty) ? styles.blockContentVisible : styles.blockContentHidden),
            }}
          >● {t('editor.unsaved')}</span>
        </div>

        <ProgressLine
          mode={editorProgressMode}
          modeAttributeName="data-pm-editor-progress"
          phaseAttributeName="data-pm-editor-progress-phase"
        />

        {/* Main content */}
        <div style={styles.body}>
          <div style={styles.formGrid}>
          {renderSection('basic', 'Основное', basicSummary, (
            <>
              <div style={styles.fieldRow}>
                <TextField
                  label={t('editor.title')}
                  value={prompt.title}
                  onChange={v => updateField('title', v)}
                  placeholder={t('editor.titlePlaceholder')}
                />
                <button
                  style={{
                    ...styles.aiBtn,
                    ...((!prompt.content.trim() || isGeneratingTitle) ? styles.aiBtnDisabled : {}),
                  }}
                  onClick={handleGenerateTitle}
                  title={isGeneratingTitle ? t('editor.generating') : t('editor.aiGenerate')}
                  disabled={!prompt.content.trim() || isGeneratingTitle}
                  aria-busy={isGeneratingTitle}
                >
                  {isGeneratingTitle ? <span style={styles.aiBtnSpinner} aria-hidden="true" /> : '✨'}
                </button>
              </div>

              <div style={styles.fieldRow}>
                <div style={styles.collapsibleFieldWrap}>
                  <button
                    type="button"
                    style={styles.collapsibleFieldToggle}
                    onClick={() => setIsDescriptionExpanded(prev => !prev)}
                    aria-expanded={isDescriptionExpanded}
                  >
                    <span style={styles.collapsibleFieldToggleLeft}>
                      <span style={styles.sectionArrow}>{isDescriptionExpanded ? '▾' : '▸'}</span>
                      <span style={styles.label}>{t('editor.description')}</span>
                    </span>
                    {!isDescriptionExpanded ? (
                      <span style={styles.collapsibleFieldSummary}>
                        {prompt.description.trim() ? toShortText(prompt.description.trim(), 72) : 'Пусто'}
                      </span>
                    ) : null}
                  </button>

                  {isDescriptionExpanded ? (
                    <div style={styles.fieldRow}>
                      <div style={styles.fieldFlexFill}>
                        <input
                          type="text"
                          value={prompt.description}
                          onChange={e => updateField('description', e.target.value)}
                          placeholder={t('editor.descPlaceholder')}
                          style={styles.textInput}
                        />
                      </div>
                      <button
                        style={{
                          ...styles.aiBtn,
                          ...((!prompt.content.trim() || isGeneratingDescription) ? styles.aiBtnDisabled : {}),
                        }}
                        onClick={handleGenerateDescription}
                        title={isGeneratingDescription ? t('editor.generating') : t('editor.aiGenerate')}
                        disabled={!prompt.content.trim() || isGeneratingDescription}
                        aria-busy={isGeneratingDescription}
                      >
                        {isGeneratingDescription ? <span style={styles.aiBtnSpinner} aria-hidden="true" /> : '✨'}
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>

              <StatusSelect
                value={prompt.status}
                onChange={v => handleSetStatus(v as PromptStatus)}
              />
            </>
          ))}

          {renderSection('time', 'Учёт времени', timeSummary, (
            <TimerDisplay
              timeWriting={prompt.timeSpentWriting}
              timeImplementing={prompt.timeSpentImplementing}
              timeOnTask={prompt.timeSpentOnTask || 0}
              timeUntracked={prompt.timeSpentUntracked || 0}
              onUntrackedChange={(ms) => updateField('timeSpentUntracked', ms)}
              hasChatSessions={prompt.chatSessionIds.length > 0}
              isRecalculating={isRecalculating}
              onRecalcImplementingTime={handleRecalcImplementingTime}
            />
          ))}

          {renderSection('workspace', 'Рабочее окружение', workspaceSummary, (
            <>
              <MultiSelect
                label={t('editor.projects')}
                selected={prompt.projects}
                options={workspaceFolders.map(f => ({ id: f, name: f }))}
                onChange={v => updateFieldAndSaveNow('projects', v)}
                placeholder={t('editor.projectsPlaceholder')}
              />

              <div style={styles.twoCol}>
                <div>
                  <TextField
                    label={t('editor.taskNumber')}
                    value={prompt.taskNumber}
                    onChange={v => updateField('taskNumber', v)}
                    placeholder={t('editor.taskPlaceholder')}
                  />
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button style={styles.linkBtn} onClick={() => {
                      vscode.postMessage({ type: 'getNextTaskNumber' });
                    }}>
                      {t('editor.nextTaskNumber')}
                    </button>
                  </div>
                </div>
                <div>
                  <TextField
                    label={t('editor.gitBranch')}
                    value={prompt.branch}
                    onChange={v => updateField('branch', v)}
                    placeholder={t('editor.gitBranchPlaceholder')}
                  />
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {prompt.projects.length > 0 && (
                      <button style={styles.linkBtn} onClick={handleShowBranches}>
                        {t('editor.showBranches')}
                      </button>
                    )}
                    {shouldShowSwitchBranchBtn && (
                      <button style={styles.linkBtn} onClick={() => {
                        const branchName = targetBranch;
                        vscode.postMessage({ type: 'createBranch', branch: branchName, projects: prompt.projects });
                      }}>
                        {t('editor.createBranch')}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {showBranches && branches.length > 0 && (
                <div style={styles.branchList}>
                  <label style={styles.label}>{t('editor.branchesLabel')}</label>
                  {branches.map((b, i) => {
                    const isMismatch = b.current && !ALLOWED_BRANCHES.has(b.name);
                    const isMatchedTarget = b.current && !!targetBranch && b.name === targetBranch;
                    return (
                      <button
                        key={`${b.project}-${b.name}-${i}`}
                        style={{
                          ...styles.branchItem,
                          ...(b.current ? styles.branchItemCurrent : {}),
                          ...(isMatchedTarget ? styles.branchItemMatched : {}),
                          ...(isMismatch ? styles.branchItemMismatch : {}),
                          ...(b.name === prompt.branch && !b.current ? styles.branchItemSelected : {}),
                        }}
                        onClick={() => handleSwitchBranch(b.name)}
                      >
                        <span>{b.current ? '● ' : '○ '}{b.name}</span>
                        <span style={styles.branchProject}>{b.project}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          ))}

          {renderSection('prompt', 'Промпт', promptSummary, (
            <>
              <div style={styles.field}>
                <div style={styles.promptFieldHeader}>
                  <div style={styles.promptFieldLabelRow}>
                    <label style={styles.label}>{t('editor.promptText')}</label>
                    <span
                      style={styles.promptLoadingIndicator}
                      aria-live="polite"
                      aria-label={isImprovingPromptText
                        ? t('editor.generating')
                        : (isSuggestionLoading ? t('textArea.suggestTooltip') : '')}
                    >
                      {isImprovingPromptText ? '⏳' : (isSuggestionLoading ? '⏳' : '')}
                    </span>
                  </div>
                  <div style={styles.promptFieldActions}>
                    <button
                      style={{
                        ...styles.linkBtn,
                        ...((!prompt.content.trim() || isImprovingPromptText) ? styles.linkBtnDisabled : {}),
                      }}
                      onClick={handleImprovePromptText}
                      disabled={!prompt.content.trim() || isImprovingPromptText}
                      title={t('editor.generatePromptTooltip')}
                    >
                      {isImprovingPromptText ? t('editor.generating') : t('editor.generatePrompt')}
                    </button>
                    <span style={styles.generateProjectsHint} title={t('editor.generateProjectsTooltip')}>
                      {`${t('editor.generateProjectsPrefix')}: ${analyzedProjectsCount}`}
                    </span>
                    <button
                      style={{
                        ...styles.linkBtn,
                        fontWeight: showPreview ? 600 : 400,
                      }}
                      onClick={() => setShowPreview(!showPreview)}
                    >
                      {showPreview ? `✏️ ${t('editor.edit')}` : `👁 ${t('editor.preview')}`}
                    </button>
                    <button
                      style={styles.linkBtn}
                      onClick={() => {
                        vscode.postMessage({
                          type: 'openPromptContentInEditor',
                          content: prompt.content,
                          promptId: prompt.id,
                          title: prompt.title,
                        });
                      }}
                    >
                      {`📝 ${t('editor.open')}`}
                    </button>
                    <label style={styles.autoCompleteLabelInline}>
                      <input
                        type="checkbox"
                        checked={autoCompleteEnabled}
                        onChange={e => setAutoCompleteEnabled(e.target.checked)}
                        style={{ margin: 0 }}
                      />
                      Автодополнение
                    </label>
                    <button
                      style={styles.linkBtn}
                      onClick={() => setRequestSuggestionSignal(prev => prev + 1)}
                      title={t('textArea.suggestTooltip')}
                    >
                      {t('textArea.suggest')}
                    </button>
                    <button
                      type="button"
                      style={{
                        ...styles.linkBtn,
                        ...styles.iconLinkBtn,
                        ...(voiceController.isVisible ? styles.linkBtnDisabled : {}),
                      }}
                      onClick={() => { void voiceController.startRecording(); }}
                      title={t('editor.voiceRecordFromMic')}
                      aria-label={t('editor.voiceRecordFromMic')}
                      disabled={voiceController.isVisible}
                    >
                      <VoiceMicIcon />
                    </button>
                  </div>
                </div>
                {showPreview ? (
                  <div
                    style={styles.previewPane}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(prompt.content) }}
                  />
                ) : (
                  <div
                    style={{
                      ...styles.promptTextAreaWrap,
                      ...(voiceController.isVisible ? styles.promptTextAreaWrapWithOverlay : null),
                    }}
                  >
                    {voiceController.isVisible && (
                      <PromptVoiceOverlay
                        status={voiceController.status}
                        elapsedLabel={voiceController.elapsedLabel}
                        maxDurationLabel={voiceController.maxDurationLabel}
                        levels={voiceController.levels}
                        progressMessage={voiceController.progressMessage}
                        progressPercent={voiceController.progressPercent}
                        errorMessage={voiceController.errorMessage}
                        errorBadge={voiceController.errorBadge}
                        errorHint={voiceController.errorHint}
                        onConfirm={voiceController.confirmRecording}
                        onPause={voiceController.pauseRecording}
                        onResume={voiceController.resumeRecording}
                        onCancel={voiceController.cancelRecording}
                        t={t}
                      />
                    )}
                    <TextArea
                      value={prompt.content}
                      onChange={v => { updateField('content', v); setInlineSuggestion(''); setInlineSuggestions([]); }}
                      placeholder={t('editor.promptPlaceholder')}
                      rows={12}
                      required
                      autoCompleteEnabled={autoCompleteEnabled}
                      onAutoCompleteChange={setAutoCompleteEnabled}
                      showControls={false}
                      persistedHeight={promptContentHeight}
                      onHeightChange={setPromptContentHeight}
                      requestSuggestionSignal={requestSuggestionSignal}
                      onSuggestionLoadingChange={setIsSuggestionLoading}
                      onRequestSuggestion={(textBefore) => {
                        vscode.postMessage({
                          type: 'requestSuggestion',
                          textBefore,
                          globalContext,
                        });
                      }}
                      suggestion={inlineSuggestion}
                      suggestions={inlineSuggestions}
                      focusSignal={promptContentFocusSignal}
                    />
                  </div>
                )}
              </div>

              {detectedVars.length > 0 && (
                <div style={styles.field}>
                  <label style={styles.label}>{t('editor.templateVars')}</label>
                  <div style={styles.varsGrid}>
                    {detectedVars.map(v => (
                      <div key={v} style={styles.varRow}>
                        <span style={styles.varName}>{`{{${v}}}`}</span>
                        <input
                          style={styles.varInput}
                          value={templateVars[v] || ''}
                          onChange={e => setTemplateVars(prev => ({ ...prev, [v]: e.target.value }))}
                          placeholder={`${t('editor.valueFor')} ${v}`}
                        />
                      </div>
                    ))}
                  </div>
                  <span style={styles.varHint}>{t('editor.templateHint')}</span>
                </div>
              )}

            </>
          ))}

          {renderSection('globalPrompt', 'Общая инструкция', globalPromptSummary, (
            <>
              <div style={styles.field}>
                <div style={styles.promptFieldHeader}>
                  <div style={styles.promptFieldLabelRow}>
                    <label style={styles.label}>{t('editor.globalContext')}</label>
                  </div>
                  <div style={styles.promptFieldActions}>
                    {hasGlobalContext && !isLoadingGlobalContext ? (
                      <button
                        type="button"
                        style={styles.linkBtn}
                        onClick={handleResetGlobalContext}
                      >
                        {t('editor.resetGlobalContext')}
                      </button>
                    ) : null}
                    {(!hasGlobalContext || isLoadingGlobalContext) ? (
                      <button
                        type="button"
                        style={{
                          ...styles.linkBtn,
                          ...styles.linkBtnWithSpinner,
                          ...(isLoadingGlobalContext ? styles.linkBtnDisabled : null),
                        }}
                        onClick={handleLoadGlobalContext}
                        disabled={isLoadingGlobalContext}
                        aria-busy={isLoadingGlobalContext}
                      >
                        {isLoadingGlobalContext ? (
                          <span style={styles.linkBtnSpinner} aria-hidden="true" />
                        ) : (
                          <span aria-hidden="true">📥</span>
                        )}
                        <span>
                          {isLoadingGlobalContext
                            ? t('editor.loadingGlobalContext')
                            : t('editor.loadGlobalContext')}
                        </span>
                      </button>
                    ) : null}
                  </div>
                </div>
                <textarea
                  ref={globalContextTextareaRef}
                  value={globalContext}
                  disabled={isLoadingGlobalContext}
                  onChange={e => {
                    persistGlobalContext(e.target.value);
                  }}
                  placeholder={t('editor.globalContextPlaceholder')}
                  rows={3}
                  style={{
                    ...styles.globalContextTextarea,
                    ...(isLoadingGlobalContext ? styles.globalContextTextareaDisabled : null),
                    height: globalContextHeight ? `${globalContextHeight}px` : undefined,
                  }}
                />
                <span style={styles.varHint}>{t('editor.globalContextHint')}</span>
              </div>
            </>
          ))}

          {renderSection('tech', 'Технологии', techSummary, (
            <>
              <MultiSelect
                label={t('editor.languages')}
                selected={prompt.languages}
                options={availableLanguages}
                onChange={v => updateFieldAndSaveNow('languages', v)}
                allowCustom
                placeholder={t('editor.langPlaceholder')}
              />

              <MultiSelect
                label={t('editor.frameworks')}
                selected={prompt.frameworks}
                options={availableFrameworks}
                onChange={v => updateFieldAndSaveNow('frameworks', v)}
                allowCustom
                placeholder={t('editor.frameworksPlaceholder')}
              />
            </>
          ))}

          {renderSection('integrations', 'Интеграции', integrationsSummary, (
            <>
              <MultiSelect
                label={t('editor.skills')}
                selected={prompt.skills}
                options={availableSkills}
                onChange={v => updateFieldAndSaveNow('skills', v)}
                placeholder={t('editor.skillsPlaceholder')}
              />

              <MultiSelect
                label={t('editor.mcpTools')}
                selected={prompt.mcpTools}
                options={availableMcpTools}
                onChange={v => updateFieldAndSaveNow('mcpTools', v)}
                placeholder={t('editor.mcpPlaceholder')}
              />

              <MultiSelect
                label={t('editor.hooks')}
                selected={prompt.hooks}
                options={availableHooks}
                onChange={v => updateFieldAndSaveNow('hooks', v)}
                placeholder={t('editor.hooksPlaceholder')}
              />
            </>
          ))}

          {renderSection('agent', 'Агент', agentSummary, (
            <>
              <div style={styles.agentInlineRow}>
                <div style={{ ...styles.field, ...styles.agentFieldModel }}>
                  <label style={styles.label}>{t('editor.aiModel')}</label>
                  <select
                    value={prompt.model}
                    onChange={e => updateFieldAndSaveNow('model', e.target.value)}
                    style={{ ...styles.select, ...styles.agentModelSelect }}
                  >
                    <option value="">{t('common.auto')}</option>
                    {modelOptions.map(m => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </div>

                <div style={{ ...styles.field, ...styles.agentFieldMode }}>
                  <label style={styles.label}>{t('editor.chatMode')}</label>
                  <div style={styles.toggleGroup}>
                    {(['agent', 'plan'] as const).map(mode => (
                      <button
                        key={mode}
                        style={{
                          ...styles.toggleBtn,
                          ...(prompt.chatMode === mode ? styles.toggleBtnActive : {}),
                        }}
                        onClick={() => updateFieldAndSaveNow('chatMode', mode)}
                        title={mode === 'agent' ? t('editor.chatModeAgent') : t('editor.chatModePlan')}
                      >
                        {mode === 'agent' ? `🤖 ${t('editor.chatModeAgent')}` : `📋 ${t('editor.chatModePlan')}`}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </>
          ))}

          {renderSection('files', 'Файлы', filesSummary, (
            <>
              <div style={styles.field}>
                <label style={styles.label}>{t('editor.contextFiles')}</label>
                <div style={styles.fileList}>
                  {prompt.contextFiles.map((f, i) => (
                    <div key={i} style={styles.fileItem}>
                      <span
                        style={styles.fileLink}
                        onClick={(e) => {
                          e.stopPropagation();
                          vscode.postMessage({ type: 'openFile', file: f });
                        }}
                        title={`${t('editor.openInEditor')} ${f}`}
                      >📄 {f}</span>
                      <button
                        style={styles.removeBtn}
                        onClick={() => {
                          const updated = prompt.contextFiles.filter((_, idx) => idx !== i);
                          updateFieldAndSaveNow('contextFiles', updated);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <div style={styles.fileActions}>
                    <button
                      style={styles.addFileBtn}
                      onClick={() => {
                        vscode.postMessage({ type: 'pickFile' });
                      }}
                    >
                      {t('editor.addFile')}
                    </button>
                    <button
                      style={styles.addFileBtn}
                      onClick={async () => {
                        try {
                          const text = await navigator.clipboard.readText();
                          if (text) {
                            const files = text.split('\n')
                              .map(f => f.trim())
                              .filter(f => {
                                if (!f || f.length === 0) return false;
                                if (f.includes('/') || f.includes('\\')) return true;
                                if (/\.[a-zA-Z0-9]{1,10}$/.test(f)) return true;
                                return false;
                              });
                            if (files.length > 0) {
                              vscode.postMessage({ type: 'pasteFiles', files });
                            }
                          }
                        } catch {
                          // Clipboard not available or permission denied
                        }
                      }}
                      title={t('editor.clipboardTooltip')}
                    >
                      {t('editor.fromClipboard')}
                    </button>
                  </div>
                </div>
              </div>
            </>
          ))}

          {renderSection('report', 'Отчет', reportSummary, (
            <>
              <div style={styles.field}>
                <label style={styles.label}>{t('editor.workResult')}</label>
                <RichTextEditor
                  value={prompt.report || ''}
                  onChange={v => updateField('report', v)}
                  onDebug={logMainRichTextDebug}
                  autoModeKey={prompt.id}
                  placeholder={t('editor.reportPlaceholder')}
                  contentPadding="compact"
                  persistedHeight={reportHeight}
                  onHeightChange={setReportHeight}
                  canReset={Boolean((prompt.report || '').trim())}
                  onOpen={() => {
                    vscode.postMessage({
                      type: 'openPromptReportInEditor',
                      report: prompt.report || '',
                      promptId: prompt.id,
                      title: prompt.title,
                    });
                  }}
                  openLabel={t('editor.open')}
                  openTitle={t('editor.open')}
                  onSecondaryAction={handleGenerateReport}
                  secondaryActionLabel={isGeneratingReport ? t('editor.generating') : t('editor.generateReport')}
                  secondaryActionTitle={t('editor.generateReportTooltip')}
                  secondaryActionDisabled={isGeneratingReport}
                  onReset={handleResetReport}
                />
              </div>

              <div style={styles.fieldRow}>
                <TextField
                  label={t('editor.httpExamples')}
                  value={prompt.httpExamples}
                  onChange={v => updateField('httpExamples', v)}
                />
                <div style={styles.fieldActionGroup}>
                  <button
                    style={styles.fieldActionBtn}
                    onClick={handlePickHttpExamples}
                    title={t('editor.choose')}
                  >
                    {t('editor.choose')}
                  </button>
                  <button
                    style={{
                      ...styles.fieldActionBtn,
                      ...(!prompt.httpExamples.trim() ? styles.fieldActionBtnDisabled : {}),
                    }}
                    onClick={handleOpenHttpExamples}
                    disabled={!prompt.httpExamples.trim()}
                    title={prompt.httpExamples.trim()
                      ? `${t('editor.openInEditor')} ${prompt.httpExamples.trim()}`
                      : t('editor.openInEditor')}
                  >
                    ↗ {t('editor.open')}
                  </button>
                </div>
              </div>
            </>
          ))}

          {shouldShowPlanSection ? renderSection('plan', 'План', planSummary, (
            <div style={styles.planChecklistList}>
              {planChecklistItems.length > 0 ? planChecklistItems.map(item => (
                <div key={`${item.lineNumber}-${item.text}`} style={styles.planChecklistItem}>
                  <span
                    style={{
                      ...styles.planChecklistIcon,
                      ...(item.checked ? styles.planChecklistIconCompleted : styles.planChecklistIconPending),
                    }}
                    aria-hidden="true"
                  >
                    {item.checked ? '☑' : '☐'}
                  </span>
                  <span
                    style={{
                      ...styles.planChecklistText,
                      ...(item.checked ? styles.planChecklistTextCompleted : null),
                    }}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
                  />
                </div>
              )) : (
                <div style={styles.planChecklistEmpty}>В файле plan.md не найдено пунктов чеклиста.</div>
              )}
            </div>
          )) : null}
          </div>
        </div>

        {/* Footer */}
        <div style={isLoaded ? styles.blockContentVisible : styles.blockContentHidden}>
          {notice && (
            <div
              style={{
                ...styles.footerNotice,
                ...(notice.kind === 'error' ? styles.footerNoticeError : styles.footerNoticeInfo),
              }}
              role={notice.kind === 'error' ? 'alert' : 'status'}
            >
              <span style={styles.noticeText}>{notice.message}</span>
              <button
                type="button"
                style={styles.noticeCloseBtn}
                onClick={() => setNotice(null)}
                aria-label="Close notification"
              >
                ✕
              </button>
            </div>
          )}
          <ActionBar
            onSave={() => handleSave('manual')}
            onShowHistory={handleShowHistory}
            onStartChat={handleStartChat}
            onOpenChat={handleOpenChat}
            onOpenGitFlow={handleOpenGitOverlay}
            onMarkCompleted={() => handleSetStatus('completed')}
            onMarkStopped={handleStopChatAndSetStatus}
            showStatusActions={prompt.status === 'in-progress'}
            showGitFlowAction={shouldShowFooterGitFlow}
            hasChatSession={prompt.chatSessionIds.length > 0}
            isChatPanelOpen={isChatPanelOpen}
            isSaving={isSaving}
            isStartingChat={isStartingChat}
            hasContent={!!prompt.content}
            status={prompt.status}
          />
        </div>
      </div>

      <GitOverlay
        open={gitOverlayOpen}
        mode={gitOverlayMode}
        snapshot={gitOverlaySnapshot}
        commitMessages={gitOverlayCommitMessages}
        busyAction={gitOverlayBusyAction}
        completedActions={gitOverlayCompletedActions}
        promptStatus={prompt.status}
        promptTitle={prompt.title}
        promptTaskNumber={prompt.taskNumber}
        selectedProjects={prompt.projects}
        dockToSecondHalf={shouldDockGitOverlaySecondHalf}
        preferredTrackedBranch={(prompt.trackedBranch || '').trim() || workspaceTrackedBranchPreference}
        preferredTrackedBranchesByProject={{
          ...workspaceTrackedBranchesByProjectPreference,
          ...(prompt.trackedBranchesByProject || {}),
        }}
        onClose={closeGitOverlay}
        onRefresh={handleRefreshGitOverlay}
        onApplyBranchTargets={handleGitOverlayApplyBranchTargets}
        onSwitchBranch={handleGitOverlaySwitchBranch}
        onEnsurePromptBranch={handleGitOverlayEnsurePromptBranch}
        onPush={handleGitOverlayPush}
        onCreateReviewRequest={handleGitOverlayCreateReviewRequest}
        onMergePromptBranch={handleGitOverlayMergePromptBranch}
        onDiscardFile={handleGitOverlayDiscardFile}
        onDiscardProjectChanges={handleGitOverlayDiscardProjectChanges}
        onOpenFile={handleGitOverlayOpenFile}
        onOpenDiff={handleGitOverlayOpenDiff}
        onOpenReviewRequest={handleGitOverlayOpenReviewRequest}
        onSetupReviewCli={handleGitOverlaySetupReviewCli}
        onAssignReviewProvider={handleGitOverlayAssignReviewProvider}
        onOpenMergeEditor={handleGitOverlayOpenMergeEditor}
        onGenerateCommitMessage={handleGitOverlayGenerateCommitMessage}
        onCommitStaged={handleGitOverlayCommitStaged}
        onCommitMessageChange={handleGitOverlayCommitMessageChange}
        onUpdateProjects={(projects) => updateFieldAndSaveNow('projects', projects)}
        onTrackedBranchChange={handleGitOverlayTrackedBranchChange}
        onContinueStartChat={() => {
          const requestId = pendingGitOverlayStartChatRequestIdRef.current || createStartChatRequestId();
          closeGitOverlay();
          dispatchStartChat(requestId, { skipBranchMismatchCheck: true });
        }}
        onContinueOpenChat={() => {
          closeGitOverlay();
          handleOpenChatRef.current();
        }}
        onDone={(status) => {
          closeGitOverlay();
          if (status) {
            handleSetStatus(status);
          }
        }}
        t={t}
      />
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    overflow: 'hidden',
    position: 'relative',
  },
  contentShell: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    width: `${EDITOR_FORM_SHELL_WIDTH_PX}px`,
    maxWidth: '100%',
  },
  blockContentVisible: {
    visibility: 'visible',
  },
  blockContentHidden: {
    visibility: 'hidden',
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: `${EDITOR_FORM_SHELL_WIDTH_PX}px`,
    maxWidth: '100%',
    zIndex: 1000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'color-mix(in srgb, var(--vscode-editor-background) 70%, transparent)',
    pointerEvents: 'all',
    animation: 'pm-fade-in 0.2s ease-out',
  },
  loadingSpinner: {
    width: '36px',
    height: '36px',
    border: '3px solid var(--vscode-descriptionForeground)',
    borderTopColor: 'var(--vscode-focusBorder)',
    borderRadius: '50%',
    animation: 'pm-spin 0.8s linear infinite',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '12px 20px',
    borderBottom: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-editor-background)',
  },
  headerTitle: {
    margin: 0,
    fontSize: '16px',
    fontWeight: 600,
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  dirtyIndicator: {
    color: 'var(--vscode-editorWarning-foreground)',
    fontSize: '12px',
    whiteSpace: 'nowrap',
  },
  footerNotice: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    padding: '10px 20px',
    fontSize: '12px',
    borderTop: '1px solid var(--vscode-panel-border)',
  },
  footerNoticeError: {
    background: 'var(--vscode-inputValidation-errorBackground)',
    color: 'var(--vscode-errorForeground)',
  },
  footerNoticeInfo: {
    background: 'var(--vscode-inputValidation-infoBackground)',
    color: 'var(--vscode-foreground)',
  },
  noticeText: {
    flex: 1,
    minWidth: 0,
  },
  noticeCloseBtn: {
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    padding: '0',
    fontSize: '12px',
    lineHeight: 1,
  },
  body: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px 20px',
  },
  formGrid: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    maxWidth: `${EDITOR_FORM_CONTENT_WIDTH_PX}px`,
  },
  sectionCard: {
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '6px',
    background: 'var(--vscode-editor-background)',
    overflow: 'visible',
  },
  sectionHeaderBtn: {
    width: '100%',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '10px',
    border: 'none',
    background: 'var(--vscode-sideBar-background)',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    padding: '10px 12px',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: '12px',
  },
  sectionHeaderLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    minWidth: 0,
  },
  sectionArrow: {
    color: 'var(--vscode-descriptionForeground)',
    width: '10px',
    flexShrink: 0,
  },
  sectionTitle: {
    fontSize: '13px',
    fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  sectionSummaryWrap: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: '6px',
    maxWidth: '68%',
  },
  sectionSummaryChip: {
    maxWidth: '220px',
    fontSize: '11px',
    color: 'var(--vscode-foreground)',
    background: 'var(--vscode-badge-background)',
    borderRadius: '4px',
    padding: '2px 8px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  sectionSummaryMore: {
    fontSize: '11px',
    fontWeight: 700,
    color: 'var(--vscode-descriptionForeground)',
    whiteSpace: 'nowrap',
  },
  sectionSummaryEmpty: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    whiteSpace: 'nowrap',
  },
  sectionBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    padding: '12px',
  },
  sectionBodyContent: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  planChecklistList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  planChecklistItem: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '8px',
    padding: '8px 10px',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '6px',
    background: 'var(--vscode-sideBar-background)',
  },
  planChecklistIcon: {
    flexShrink: 0,
    lineHeight: 1.2,
    fontSize: '14px',
    marginTop: '1px',
  },
  planChecklistIconCompleted: {
    color: 'var(--vscode-testing-iconPassed, var(--vscode-terminal-ansiGreen))',
  },
  planChecklistIconPending: {
    color: 'var(--vscode-descriptionForeground)',
  },
  planChecklistText: {
    minWidth: 0,
    fontSize: '13px',
    lineHeight: 1.5,
    color: 'var(--vscode-foreground)',
    overflowWrap: 'anywhere',
  },
  planChecklistTextCompleted: {
    color: 'var(--vscode-descriptionForeground)',
    textDecoration: 'line-through',
  },
  planChecklistEmpty: {
    padding: '8px 10px',
    border: '1px dashed var(--vscode-panel-border)',
    borderRadius: '6px',
    color: 'var(--vscode-descriptionForeground)',
    fontSize: '12px',
  },
  fieldRow: {
    display: 'flex',
    gap: '8px',
    alignItems: 'flex-end',
  },
  fieldActionGroup: {
    display: 'flex',
    gap: '8px',
    flexShrink: 0,
  },
  fieldActionBtn: {
    minHeight: '32px',
    padding: '0 10px',
    background: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
    border: '1px solid var(--vscode-button-border, transparent)',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  fieldActionBtnDisabled: {
    opacity: 0.6,
    cursor: 'not-allowed',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  fieldFlexFill: {
    flex: 1,
  },
  label: {
    fontSize: '12px',
    fontWeight: 500,
    color: 'var(--vscode-foreground)',
    marginBottom: '2px',
  },
  textInput: {
    width: '100%',
    padding: '6px 8px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border, transparent)',
    borderRadius: '4px',
    fontSize: '13px',
    fontFamily: 'var(--vscode-font-family)',
    boxSizing: 'border-box',
    outline: 'none',
  },
  select: {
    padding: '6px 8px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border, transparent)',
    borderRadius: '4px',
    fontSize: '13px',
    fontFamily: 'var(--vscode-font-family)',
  },
  collapsibleFieldWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    flex: 1,
  },
  collapsibleFieldToggle: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    width: '100%',
    padding: '0',
    border: 'none',
    background: 'transparent',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    fontFamily: 'var(--vscode-font-family)',
    textAlign: 'left',
  },
  collapsibleFieldToggleLeft: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
  },
  collapsibleFieldSummary: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  toggleGroup: {
    display: 'flex',
    gap: '0px',
    borderRadius: '4px',
    overflow: 'hidden',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
    width: 'fit-content',
  },
  toggleBtn: {
    padding: '5px 14px',
    border: 'none',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
    fontWeight: 500,
    borderRight: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
    transition: 'background 0.15s, color 0.15s',
  },
  toggleBtnActive: {
    background: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
  },
  separator: {
    height: '1px',
    background: 'var(--vscode-panel-border)',
    margin: '4px 0',
  },
  twoCol: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '12px',
  },
  agentInlineRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '12px',
    alignItems: 'flex-start',
  },
  agentFieldModel: {
    flex: '1 1 200px',
    minWidth: '200px',
  },
  agentFieldMode: {
    flex: '1 1 260px',
    minWidth: '260px',
  },
  agentModelSelect: {
    minWidth: '200px',
  },
  linkBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--vscode-textLink-foreground)',
    cursor: 'pointer',
    fontSize: '12px',
    padding: '4px 0',
    fontFamily: 'var(--vscode-font-family)',
    whiteSpace: 'nowrap',
  },
  iconLinkBtn: {
    minWidth: '28px',
    minHeight: '24px',
    padding: '0',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkBtnDisabled: {
    opacity: 0.6,
    cursor: 'not-allowed',
    border: 'none',
  },
  linkBtnWithSpinner: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
  },
  linkBtnSpinner: {
    width: '12px',
    height: '12px',
    border: '2px solid color-mix(in srgb, currentColor 35%, transparent)',
    borderTopColor: 'currentColor',
    borderRadius: '50%',
    animation: 'pm-spin 0.8s linear infinite',
    flexShrink: 0,
  },
  inlineIcon: {
    width: '15px',
    height: '15px',
    display: 'block',
  },
  generateProjectsHint: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    whiteSpace: 'nowrap',
  },
  promptFieldHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'nowrap',
  },
  promptFieldLabelRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
  },
  promptLoadingIndicator: {
    fontSize: '12px',
    width: '16px',
    textAlign: 'center',
    flexShrink: 0,
  },
  promptFieldActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'nowrap',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  promptTextAreaWrap: {
    position: 'relative',
  },
  promptTextAreaWrapWithOverlay: {
    isolation: 'isolate',
  },
  autoCompleteLabelInline: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '11px',
    cursor: 'pointer',
    color: 'var(--vscode-descriptionForeground)',
    whiteSpace: 'nowrap',
  },
  branchList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: '8px',
    background: 'var(--vscode-input-background)',
    borderRadius: '4px',
    maxHeight: '200px',
    overflowY: 'auto',
  },
  branchItem: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '4px 8px',
    border: 'none',
    background: 'transparent',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    borderRadius: '4px',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
    textAlign: 'left',
  },
  branchItemCurrent: {
    fontWeight: 600,
  },
  branchItemMismatch: {
    background: 'var(--vscode-inputValidation-errorBackground)',
    color: 'var(--vscode-errorForeground)',
  },
  branchItemMatched: {
    background: 'var(--vscode-inputValidation-infoBackground)',
    color: 'var(--vscode-testing-iconPassed)',
  },
  branchItemSelected: {
    background: 'var(--vscode-list-activeSelectionBackground)',
    color: 'var(--vscode-list-activeSelectionForeground)',
  },
  branchProject: {
    fontSize: '10px',
    opacity: 0.7,
  },
  aiBtn: {
    padding: '6px 10px',
    background: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '14px',
    flexShrink: 0,
    minWidth: '36px',
    minHeight: '32px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  aiBtnDisabled: {
    opacity: 0.7,
    cursor: 'not-allowed',
  },
  aiBtnSpinner: {
    width: '14px',
    height: '14px',
    border: '2px solid color-mix(in srgb, var(--vscode-button-secondaryForeground) 35%, transparent)',
    borderTopColor: 'var(--vscode-button-secondaryForeground)',
    borderRadius: '50%',
    animation: 'pm-spin 0.8s linear infinite',
  },
  fileList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  fileItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '4px 8px',
    background: 'var(--vscode-input-background)',
    borderRadius: '4px',
    fontSize: '12px',
  },
  fileLink: {
    cursor: 'pointer',
    color: 'var(--vscode-textLink-foreground)',
    textDecoration: 'none',
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  removeBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--vscode-errorForeground)',
    cursor: 'pointer',
    padding: '2px 4px',
    fontSize: '11px',
    flexShrink: 0,
  },
  fileActions: {
    display: 'flex',
    gap: '6px',
  },
  addFileBtn: {
    padding: '4px 8px',
    background: 'transparent',
    border: '1px dashed var(--vscode-input-border, var(--vscode-panel-border))',
    borderRadius: '4px',
    color: 'var(--vscode-textLink-foreground)',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
  },
  previewPane: {
    padding: '12px 16px',
    background: 'var(--vscode-input-background)',
    borderRadius: '4px',
    border: '1px solid var(--vscode-input-border, transparent)',
    minHeight: '200px',
    maxHeight: '500px',
    overflowY: 'auto',
    fontSize: '13px',
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
    wordWrap: 'break-word',
  },
  varsGrid: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '8px',
    background: 'var(--vscode-input-background)',
    borderRadius: '4px',
  },
  varRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  varName: {
    fontSize: '12px',
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    color: 'var(--vscode-editorWarning-foreground)',
    minWidth: '100px',
    flexShrink: 0,
  },
  varInput: {
    flex: 1,
    padding: '4px 8px',
    background: 'var(--vscode-editor-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border, transparent)',
    borderRadius: '4px',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
  },
  varHint: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    marginTop: '4px',
  },
  globalContextTextarea: {
    width: '100%',
    padding: '8px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border, transparent)',
    borderRadius: '4px',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: '13px',
    lineHeight: '1.5',
    resize: 'vertical',
    outline: 'none',
    minHeight: '60px',
    boxSizing: 'border-box' as const,
  },
  globalContextTextareaDisabled: {
    opacity: 0.75,
    cursor: 'progress',
  },
};
