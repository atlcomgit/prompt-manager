/**
 * Editor App — Main component for prompt configuration form
 */
import React, { useState, useCallback, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { unstable_batchedUpdates } from 'react-dom';
import { getVsCodeApi } from '../shared/vscodeApi';
import { useMessageListener } from '../shared/useMessageListener';
import { useT } from '../shared/i18n';
import { PromptStatusText } from '../shared/PromptStatusText';
import { TextField } from './components/TextField';
import { TextArea } from './components/TextArea';
import { RichTextEditor } from './components/RichTextEditor';
import { MultiSelect } from './components/MultiSelect';
import { StatusSelect } from './components/StatusSelect';
import { ActionBar, resolveChatEntryState } from './components/ActionBar';
import { ChatLaunchOpenStepLabel } from './components/ChatLaunchOpenStepLabel';
import { TimerDisplay } from './components/TimerDisplay';
import { ContextFileCard } from './components/ContextFileCard';
import { ChatMemoryBlock } from './components/ChatMemoryBlock';
import { PromptVoiceOverlay } from './components/PromptVoiceOverlay';
import { GitOverlay } from './components/GitOverlay';
import { CustomGroupsManagerModal } from './components/CustomGroupsManagerModal';
import { ProgressLine, resolveEditorProgressMode } from './components/ProgressLine';
import type { ClipboardImagePayload, GlobalContextSourceMessage } from '../../types/messages';
import type {
  ChatMemorySummary,
  EditorPromptContentHeights,
  EditorPromptExpandedSections,
  EditorPromptManualSectionOverrides,
  EditorPromptSectionKey,
  EditorPromptSectionHeights,
  EditorPromptTab,
  EditorPromptViewState,
  Prompt,
  PromptContextFileCard,
  PromptCustomGroup,
  PromptStatus,
} from '../../types/prompt';
import type { GitOverlayActionKind, GitOverlayActionScope, GitOverlayChangeFile, GitOverlayChangeGroup, GitOverlayFileHistoryPayload, GitOverlayProjectCommitMessage, GitOverlayProjectReviewRequestInput, GitOverlayProjectSnapshot, GitOverlayReviewCliSetupRequest, GitOverlaySnapshot } from '../../types/git';
import {
  createDefaultEditorPromptViewState,
  createDefaultPrompt,
  normalizeEditorPromptViewState,
  PROMPT_EDITOR_SECTION_KEYS,
  shouldShowPromptPlanForStatus,
} from '../../types/prompt';
import { TimeTrackingService } from '../../services/timeTrackingService';
import { appendRecognizedPromptText } from './voice/promptVoiceUtils';
import { usePromptVoiceController } from './voice/usePromptVoiceController';
import { getChangedLineIndexes } from '../../utils/planLineDiff.js';
import {
  buildContextFileCardPlaceholder,
  dedupeContextFileReferences,
  normalizeContextFileReference,
} from '../../utils/contextFiles.js';
import { diffPromptConfigSyncFields, PROMPT_CONFIG_SYNC_FIELDS } from '../../utils/promptExternalSync.js';
import { shouldApplyPromptAiEnrichmentState, shouldApplyPromptSaveResult } from '../../utils/promptSaveFeedback.js';
import {
  PROMPT_CHAT_LAUNCH_PHASE_ORDER,
  resolvePromptChatContextAutoLoadDisplay,
  resolvePromptChatLaunchInactivePhase,
  resolveNextPromptChatLaunchPhase,
  shouldAutoExpandPromptBranchList,
  type PromptChatContextAutoLoadRuntimeState,
  resolvePromptChatLaunchPhase,
  resolvePromptChatLaunchStepStatesFromPhase,
  resolvePromptEditorExpandedSections,
  resolvePromptPlanPlaceholderState,
  shouldResetPromptChatLaunchTracking,
  shouldShowPromptChatLaunchBlock,
  togglePromptEditorSectionExpansion,
} from '../../utils/promptEditorBehavior.js';
import type { PromptChatLaunchPhase, PromptChatLaunchRenameState } from '../../utils/promptEditorBehavior.js';
import {
  resolveGitOverlayBusyActionName,
  resolveGitOverlayDonePersistence,
  shouldResetGitOverlayStateOnPromptOpen,
} from '../../utils/gitOverlay.js';

const vscode = getVsCodeApi();
const initialBootId = (window as typeof window & { __WEBVIEW_BOOT_ID__?: string }).__WEBVIEW_BOOT_ID__ || '';

interface SelectOption {
  id: string;
  name: string;
  description?: string;
}

type InlineNotice = { kind: 'error' | 'info'; message: string };
type ChatEntryAction = 'start' | 'open';
type GitOverlayMode = 'default' | 'start-chat-preflight' | 'open-chat-preflight';
type GitOverlayTrackedRequestKind = 'generate' | 'commit';
type GitOverlayTrackedRequest = {
  requestId: string;
  kind: GitOverlayTrackedRequestKind;
  projects: string[];
  action: string;
  processLabel: string;
  holdUntilSnapshot: boolean;
  bulk: boolean;
  createdAt: number;
};

const CHAT_LAUNCH_COMPLETION_HOLD_MS = 2000;
const CHAT_LAUNCH_MIN_PHASE_VISIBLE_MS = 1000;
const EDITOR_FORM_SHELL_WIDTH_PX = 840;
// Keep blank switch placeholders visible long enough to make the target layout readable.
const PROMPT_SWITCH_PLACEHOLDER_MIN_VISIBLE_MS = 450;
const PROMPT_OPEN_SECTION_MEASURE_SETTLE_MS = 640;
// Process tab has large report/plan blocks whose child layout stabilizes after markdown render.
const PROMPT_PROCESS_OPEN_SECTION_MEASURE_SETTLE_MS = 1400;
// Plan content arrives through a separate host message, so keep its saved space reserved.
const PROMPT_PROCESS_PLAN_HYDRATION_TIMEOUT_MS = 5000;
const EDITOR_FORM_CONTENT_WIDTH_PX = 800;
const EDITOR_PROMPT_TABS: EditorPromptTab[] = ['main', 'process'];
const PANEL_LEFT_ACCENT_SHADOW = 'inset 3px 0 0 var(--vscode-widget-shadow, rgba(0, 0, 0, 0.35))';
const PROMPT_EDITOR_SECTION_KEY_SET = new Set<EditorPromptSectionKey>(PROMPT_EDITOR_SECTION_KEYS);

/** Check that a DOM section key belongs to the prompt editor section contract. */
const isEditorPromptSectionKey = (value: string | null): value is EditorPromptSectionKey => (
  Boolean(value && PROMPT_EDITOR_SECTION_KEY_SET.has(value as EditorPromptSectionKey))
);

/** Keep persisted layout heights finite and positive before using them in inline styles. */
const normalizeEditorLayoutHeight = (value: unknown): number | undefined => {
  const parsed = typeof value === 'number'
    ? value
    : (typeof value === 'string' ? Number.parseInt(value, 10) : NaN);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined;
};

/** Post a debug log event through the extension host diagnostics channel. */
const postEditorDebugLog = (scope: string, message: string, payload?: Record<string, unknown>): void => {
  vscode.postMessage({ type: 'debugLog', scope, message, payload });
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

const normalizeGitOverlayTrackedRequestProjects = (projects: string[]): string[] => Array.from(new Set(
  (projects || [])
    .map(project => project.trim())
    .filter(Boolean),
));

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

const extractGitOverlayFileName = (filePath: string): string => {
  const normalizedPath = String(filePath || '').trim().replace(/\\/g, '/');
  if (!normalizedPath) {
    return '';
  }

  const segments = normalizedPath.split('/').filter(Boolean);
  return segments[segments.length - 1] || normalizedPath;
};

const areFileListsEqual = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((filePath, index) => filePath === right[index]);
};

const clearPromptConfigFieldChangedAt = (
  current: Record<string, number>,
  clearedFields: string[],
): Record<string, number> => {
  if (clearedFields.length === 0) {
    return current;
  }

  const cleared = new Set(clearedFields);
  const next: Record<string, number> = {};
  for (const field of PROMPT_CONFIG_SYNC_FIELDS) {
    if (cleared.has(field)) {
      continue;
    }

    const value = current[field];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      next[field] = value;
    }
  }

  return next;
};

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Failed to read clipboard blob.'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

async function readClipboardImagePayloads(): Promise<ClipboardImagePayload[]> {
  if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
    return [];
  }

  try {
    const items = await navigator.clipboard.read();
    const images: ClipboardImagePayload[] = [];

    for (const item of items) {
      for (const type of item.types) {
        if (!type.startsWith('image/')) {
          continue;
        }

        const blob = await item.getType(type);
        const dataBase64 = await blobToBase64(blob);
        if (!dataBase64) {
          continue;
        }

        images.push({
          mimeType: type,
          dataBase64,
        });
      }
    }

    return images;
  } catch {
    return [];
  }
}

const VoiceMicIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={styles.inlineIcon}>
    <path
      fill="currentColor"
      d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a1 1 0 1 1 2 0 7 7 0 0 1-6 6.93V21h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-3.07A7 7 0 0 1 5 11a1 1 0 1 1 2 0 5 5 0 1 0 10 0z"
    />
  </svg>
);

const OpenFileIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={styles.inlineIcon}>
    <path
      fill="currentColor"
      d="M4 1.5A1.5 1.5 0 0 0 2.5 3v10A1.5 1.5 0 0 0 4 14.5h8A1.5 1.5 0 0 0 13.5 13V5.88a1.5 1.5 0 0 0-.44-1.06L10.12 1.94a1.5 1.5 0 0 0-1.06-.44H4ZM4 3h4.25v2.25A1.75 1.75 0 0 0 10 7h2v6H4V3Z"
    />
    <path
      fill="currentColor"
      d="M6.75 10.75a.75.75 0 0 1 0-1.5h2.44L6.97 7.03a.75.75 0 1 1 1.06-1.06l2.22 2.22V5.75a.75.75 0 0 1 1.5 0V10a.75.75 0 0 1-.75.75H6.75Z"
    />
  </svg>
);

const ProjectInstructionsIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={styles.inlineIcon}>
    <path
      fill="currentColor"
      d="M3 2.25A1.25 1.25 0 0 1 4.25 1h6.69c.33 0 .65.13.88.37l1.81 1.8c.23.24.37.56.37.89v9.69A1.25 1.25 0 0 1 12.75 15h-8.5A1.25 1.25 0 0 1 3 13.75v-11.5Zm1.5.25v11h8V4.56L10.94 3H4.5Zm1.25 3a.75.75 0 0 1 .75-.75h4a.75.75 0 0 1 0 1.5h-4a.75.75 0 0 1-.75-.75Zm0 2.75a.75.75 0 0 1 .75-.75h4a.75.75 0 0 1 0 1.5h-4a.75.75 0 0 1-.75-.75Zm0 2.75a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5H6.5a.75.75 0 0 1-.75-.75Z"
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
  const readStoredEditorViewState = (): EditorPromptViewState => {
    const normalizeViewState = (value: unknown): EditorPromptViewState | null => {
      if (!value || typeof value !== 'object') {
        return null;
      }

      return normalizeEditorPromptViewState(value as Partial<EditorPromptViewState>);
    };

    const normalizeLegacyExpandedSections = (value: unknown): EditorPromptViewState | null => {
      if (!value || typeof value !== 'object') {
        return null;
      }

      return normalizeEditorPromptViewState({
        expandedSections: value as Partial<EditorPromptViewState['expandedSections']>,
      });
    };

    const stateValue = initialWebviewStateRef.current?.['pm.editor.viewState'];
    const normalizedStateValue = normalizeViewState(stateValue);
    if (normalizedStateValue) {
      return normalizedStateValue;
    }

    const legacyStateValue = initialWebviewStateRef.current?.['pm.editor.expandedSections'];
    const normalizedLegacyStateValue = normalizeLegacyExpandedSections(legacyStateValue);
    if (normalizedLegacyStateValue) {
      return normalizedLegacyStateValue;
    }

    if (storage) {
      const rawValue = storage.getItem('pm.editor.viewState');
      if (rawValue) {
        try {
          const parsed = JSON.parse(rawValue);
          const normalized = normalizeViewState(parsed);
          if (normalized) {
            return normalized;
          }
        } catch {
          // ignore corrupted local state
        }
      }

      const legacyRawValue = storage.getItem('pm.editor.expandedSections');
      if (legacyRawValue) {
        try {
          const parsed = JSON.parse(legacyRawValue);
          const normalized = normalizeLegacyExpandedSections(parsed);
          if (normalized) {
            return normalized;
          }
        } catch {
          // ignore corrupted local state
        }
      }
    }

    return createDefaultEditorPromptViewState();
  };
  const initialEditorViewStateRef = useRef<EditorPromptViewState | null>(null);
  if (!initialEditorViewStateRef.current) {
    initialEditorViewStateRef.current = readStoredEditorViewState();
  }

  const [prompt, setPrompt] = useState<Prompt>(createDefaultPrompt());
  const [isLoaded, setIsLoaded] = useState(false);
  const [isPromptSwitchPlaceholderVisible, setIsPromptSwitchPlaceholderVisible] = useState(false);
  const [isPromptOpenLayoutSettling, setIsPromptOpenLayoutSettling] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  // Start with loader visible: on new panel creation promptLoading is never sent
  // (only sent when reusing an existing singleton panel), so we show the loader
  // immediately and hide it once the first 'prompt' message with reason='open' arrives.
  const [showLoader, setShowLoader] = useState(true);
  const isPromptSwitchPlaceholderVisibleRef = useRef(false);
  const promptSwitchPlaceholderStartedAtRef = useRef(0);
  const promptSwitchPlaceholderTimerRef = useRef<number | null>(null);
  const promptOpenLayoutSettleTimerRef = useRef<number | null>(null);
  const sectionMeasurementResumeTimerRef = useRef<number | null>(null);
  const sectionMeasurementSuspendedUntilRef = useRef(0);
  const pendingPromptOpenMessageRef = useRef<any | null>(null);
  const handleMessageRef = useRef<(msg: any) => void>(() => undefined);
  const promptSwitchRestoreViewStateRef = useRef<EditorPromptViewState | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isStartingChat, setIsStartingChat] = useState(false);
  const [isOpeningChat, setIsOpeningChat] = useState(false);
  const [pendingExternalStartChatPromptId, setPendingExternalStartChatPromptId] = useState<string | null>(null);
  const [isChatPanelOpen, setIsChatPanelOpen] = useState(false);
  const [workspaceFolders, setWorkspaceFolders] = useState<string[]>([]);
  const [availableModels, setAvailableModels] = useState<SelectOption[]>([]);
  const [availableSkills, setAvailableSkills] = useState<SelectOption[]>([]);
  const [availableMcpTools, setAvailableMcpTools] = useState<SelectOption[]>([]);
  const [availableHooks, setAvailableHooks] = useState<SelectOption[]>([]);
  const [customGroups, setCustomGroups] = useState<PromptCustomGroup[]>([]);
  const [showCustomGroupsManager, setShowCustomGroupsManager] = useState(false);
  const [availableLanguages, setAvailableLanguages] = useState<SelectOption[]>([]);
  const [availableFrameworks, setAvailableFrameworks] = useState<SelectOption[]>([]);
  const [allowedBranchesSetting, setAllowedBranchesSetting] = useState<string[]>(['master', 'main', 'prod', 'develop', 'dev']);
  const [workspaceTrackedBranchPreference, setWorkspaceTrackedBranchPreference] = useState('');
  const [workspaceTrackedBranchesByProjectPreference, setWorkspaceTrackedBranchesByProjectPreference] = useState<Record<string, string>>({});
  const [pageWidth, setPageWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : EDITOR_FORM_SHELL_WIDTH_PX));
  const [branches, setBranches] = useState<Array<{ name: string; current: boolean; project: string }>>([]);
  const [branchesResolved, setBranchesResolved] = useState(false);
  const [showBranches, setShowBranches] = useState(
    () => initialEditorViewStateRef.current?.branchesExpanded ?? createDefaultEditorPromptViewState().branchesExpanded,
  );
  const [branchesExpandedManual, setBranchesExpandedManual] = useState(
    () => initialEditorViewStateRef.current?.branchesExpandedManual
      ?? createDefaultEditorPromptViewState().branchesExpandedManual,
  );
  const [gitOverlayOpen, setGitOverlayOpen] = useState(false);
  const [gitOverlayMode, setGitOverlayMode] = useState<GitOverlayMode>('default');
  const [gitOverlaySnapshot, setGitOverlaySnapshot] = useState<GitOverlaySnapshot | null>(null);
  const [gitOverlayFileHistory, setGitOverlayFileHistory] = useState<GitOverlayFileHistoryPayload | null>(null);
  const [gitOverlayCommitMessages, setGitOverlayCommitMessages] = useState<Record<string, string>>({});
  const [gitOverlayBusyAction, setGitOverlayBusyAction] = useState<string | null>(null);
  const [gitOverlayWaitingForSnapshotAction, setGitOverlayWaitingForSnapshotAction] = useState<string | null>(null);
  const [gitOverlayProcessLabel, setGitOverlayProcessLabel] = useState<string | null>(null);
  const [gitOverlayPendingGenerateProjects, setGitOverlayPendingGenerateProjects] = useState<string[]>([]);
  const [gitOverlayPendingCommitProjects, setGitOverlayPendingCommitProjects] = useState<string[]>([]);
  const [gitOverlayHasPendingBulkGenerate, setGitOverlayHasPendingBulkGenerate] = useState(false);
  const [gitOverlayHasPendingBulkCommit, setGitOverlayHasPendingBulkCommit] = useState(false);
  const gitOverlayPendingProjectDetailsRef = useRef<Record<string, true>>({});
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
  const [canLoadRemoteGlobalContext, setCanLoadRemoteGlobalContext] = useState(false);
  const [globalContextAutoLoadEnabled, setGlobalContextAutoLoadEnabled] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [templateVars, setTemplateVars] = useState<Record<string, string>>({});
  const [globalContext, setGlobalContext] = useState('');
  const [globalContextSource, setGlobalContextSource] = useState<GlobalContextSourceMessage>('empty');
  const [projectInstructions, setProjectInstructions] = useState('');
  const [projectInstructionsExists, setProjectInstructionsExists] = useState(false);
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [expandedSections, setExpandedSections] = useState<EditorPromptExpandedSections>(
    () => initialEditorViewStateRef.current?.expandedSections || createDefaultEditorPromptViewState().expandedSections,
  );
  const [manualSectionOverrides, setManualSectionOverrides] = useState<EditorPromptManualSectionOverrides>(
    () => initialEditorViewStateRef.current?.manualSectionOverrides || createDefaultEditorPromptViewState().manualSectionOverrides,
  );
  const [activeTab, setActiveTab] = useState<EditorPromptTab>(
    () => initialEditorViewStateRef.current?.activeTab || createDefaultEditorPromptViewState().activeTab,
  );
  const [promptPlanState, setPromptPlanState] = useState<{ exists: boolean; content: string }>({ exists: false, content: '' });
  const [isPromptPlanHydrating, setIsPromptPlanHydrating] = useState(false);
  const [planHighlightedLineIndexes, setPlanHighlightedLineIndexes] = useState<number[]>([]);
  const [notice, setNotice] = useState<InlineNotice | null>(null);
  const [contextFileCards, setContextFileCards] = useState<PromptContextFileCard[]>([]);
  const [promptContentHeight, setPromptContentHeight] = useState<number | undefined>(
    () => initialEditorViewStateRef.current?.contentHeights.promptContent || readStoredHeight('pm.editor.promptContentHeight'),
  );
  const [reportHeight, setReportHeight] = useState<number | undefined>(
    () => initialEditorViewStateRef.current?.contentHeights.report || readStoredHeight('pm.editor.reportHeight'),
  );
  const [globalContextHeight, setGlobalContextHeight] = useState<number | undefined>(
    () => initialEditorViewStateRef.current?.contentHeights.globalContext || readStoredHeight('pm.editor.globalContextHeight'),
  );
  const [projectInstructionsHeight, setProjectInstructionsHeight] = useState<number | undefined>(
    () => initialEditorViewStateRef.current?.contentHeights.projectInstructions || readStoredHeight('pm.editor.projectInstructionsHeight'),
  );
  const [sectionHeights, setSectionHeights] = useState<EditorPromptSectionHeights>(
    () => initialEditorViewStateRef.current?.sectionHeights || {},
  );
  const [promptContentFocusSignal, setPromptContentFocusSignal] = useState(0);
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(
    () => initialEditorViewStateRef.current?.descriptionExpanded || createDefaultEditorPromptViewState().descriptionExpanded,
  );
  const editorViewStateRef = useRef<EditorPromptViewState>(normalizeEditorPromptViewState({
    activeTab,
    expandedSections,
    manualSectionOverrides,
    descriptionExpanded: isDescriptionExpanded,
    branchesExpanded: showBranches,
    branchesExpandedManual,
    contentHeights: initialEditorViewStateRef.current?.contentHeights,
    sectionHeights: initialEditorViewStateRef.current?.sectionHeights,
  }));
  const contextFileCardRequestIdRef = useRef('');
  const shouldShowFooterGitFlow = prompt.status === 'draft'
    || prompt.status === 'in-progress'
    || prompt.status === 'completed'
    || prompt.status === 'report'
    || prompt.status === 'review';
  const isPersistedPrompt = Boolean((prompt.promptUuid || '').trim());
  const hasChatSession = prompt.chatSessionIds.length > 0;
  const chatEntryState = resolveChatEntryState({
    status: prompt.status,
    hasChatSession,
    isChatPanelOpen,
    isPersistedPrompt,
    isStartingChat,
  });
  const [chatLaunchRequestStarted, setChatLaunchRequestStarted] = useState(false);
  const [chatLaunchRenameState, setChatLaunchRenameState] = useState<PromptChatLaunchRenameState>('idle');
  const [chatLaunchCompletionHold, setChatLaunchCompletionHold] = useState(false);
  const [chatContextAutoLoadState, setChatContextAutoLoadState] = useState<PromptChatContextAutoLoadRuntimeState>('idle');
  const [chatMemorySummary, setChatMemorySummary] = useState<ChatMemorySummary | null>(null);
  const chatLaunchCompletionTimerRef = useRef<number | null>(null);
  const chatLaunchPhaseTimerRef = useRef<number | null>(null);
  const chatLaunchPhaseVisibleSinceRef = useRef<number>(Date.now());
  const rawChatLaunchPhase = resolvePromptChatLaunchPhase({
    hasChatEntry: chatEntryState.hasChatEntry,
    chatRequestStarted: chatLaunchRequestStarted,
    chatRenameState: chatLaunchRenameState,
    chatLaunchCompletionHold: false,
  });
  const chatLaunchCompletionShownForKeyRef = useRef(rawChatLaunchPhase === 'ready');
  const previousChatLaunchTrackingPromptRef = useRef<Pick<Prompt, 'id' | 'promptUuid'>>({
    id: prompt.id,
    promptUuid: prompt.promptUuid,
  });
  const [displayedChatLaunchPhase, setDisplayedChatLaunchPhase] = useState<PromptChatLaunchPhase>(
    resolvePromptChatLaunchInactivePhase(rawChatLaunchPhase),
  );
  const showChatLaunchCompletionState = prompt.status === 'in-progress'
    && displayedChatLaunchPhase === 'ready'
    && chatLaunchCompletionHold;
  const shouldShowChatLaunchBlock = shouldShowPromptChatLaunchBlock({
    status: prompt.status,
    hasChatEntry: chatEntryState.hasChatEntry,
    chatRequestStarted: chatLaunchRequestStarted,
    chatLaunchCompletionHold: showChatLaunchCompletionState,
    chatRenameState: chatLaunchRenameState,
    completionShownOnce: chatLaunchCompletionShownForKeyRef.current,
  });
  const chatLaunchPhase = displayedChatLaunchPhase;
  const chatLaunchAutoloadStepState = chatLaunchPhase === 'prepare'
    ? 'pending'
    : chatLaunchPhase === 'autoload'
      ? 'active'
      : 'done';
  const chatLaunchStateLabel = chatLaunchPhase === 'ready'
    ? t('editor.chatLaunchStatusReady')
    : chatLaunchPhase === 'renaming'
      ? t('editor.chatLaunchStatusRenaming')
    : chatLaunchPhase === 'prepare' || chatLaunchPhase === 'autoload' || chatLaunchPhase === 'opening'
      ? t('editor.chatLaunchStatusStarting')
      : t('editor.chatLaunchStatusWaiting');
  const chatLaunchDescription = chatLaunchPhase === 'ready'
    ? t('editor.chatLaunchDescriptionReady')
    : chatLaunchPhase === 'renaming'
      ? t('editor.chatLaunchDescriptionRenaming')
    : chatLaunchPhase === 'prepare' || chatLaunchPhase === 'autoload' || chatLaunchPhase === 'opening'
      ? t('editor.chatLaunchDescriptionStarting')
      : t('editor.chatLaunchDescriptionWaiting');
  const chatLaunchHint = chatLaunchPhase === 'ready'
    ? t('editor.chatLaunchHintReady')
    : chatLaunchPhase === 'renaming'
      ? t('editor.chatLaunchHintRenaming')
    : t('editor.chatLaunchHint');
  const [chatLaunchActivityFrame, setChatLaunchActivityFrame] = useState(0);
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
  const gitOverlayOpenRef = useRef(false);
  const gitOverlayBusyActionRef = useRef<string | null>(null);
  /** Timestamp when the busy state was last set (used for min display time). */
  const gitOverlayBusyStartTimeRef = useRef<number>(0);
  const gitOverlayTrackedRequestsRef = useRef<Record<string, GitOverlayTrackedRequest>>({});
  const gitOverlayHoldBusyUntilSnapshotRef = useRef(false);
  const gitOverlayPendingCommitMessageGenerationRef = useRef(false);
  const gitOverlayPendingCompletionActionRef = useRef<GitOverlayActionKind | null>(null);
  const handleStartChatRef = useRef<() => void>(() => undefined);
  const handleOpenChatRef = useRef<() => void>(() => undefined);
  const globalContextTextareaRef = useRef<HTMLTextAreaElement>(null);
  const projectInstructionsTextareaRef = useRef<HTMLTextAreaElement>(null);
  const saveTimeoutRef = useRef<number | null>(null);
  const currentPromptIdRef = useRef<string>('__new__');
  // Tracks the latest host open request so stale switch payloads cannot repaint the editor.
  const activePromptOpenRequestVersionRef = useRef(0);
  const activeSaveIdRef = useRef<string | null>(null);
  const activeSaveRequestIdRef = useRef<string | null>(null);
  const activeSaveClearedDirtyRef = useRef(false);
  const recalcTriggeredForRef = useRef<Set<string>>(new Set());
  const pendingBackgroundRecalcTimerRef = useRef<number | null>(null);
  const promptPlanStateRef = useRef<{ exists: boolean; content: string }>({ exists: false, content: '' });
  const hasSeenPromptPlanSnapshotRef = useRef(false);
  const promptPlanHydrationTimerRef = useRef<number | null>(null);
  const promptPlanHydrationRequestRef = useRef<{
    promptId: string;
    promptUuid: string;
    openRequestVersion: number;
    startedAt: number;
  } | null>(null);

  // Auto-save refs
  const promptRef = useRef<Prompt>(prompt);
  const isDirtyRef = useRef(false);
  const isSavingRef = useRef(false);
  const isOpeningChatRef = useRef(false);
  const localReportDirtyRef = useRef(false);
  const pendingReportOverrideRef = useRef<string | null>(null);
  const autoSaveTimerRef = useRef<number | null>(null);
  const userChangeCounterRef = useRef(0);
  const saveStartCounterRef = useRef(0);
  const isExternalEditorOpenRef = useRef(false);
  /** true once the prompt has been saved at least once (manually or loaded from storage) */
  const hasBeenSavedRef = useRef(false);
  const promptConfigFieldChangedAtRef = useRef<Record<string, number>>({});
  const previousPromptConfigSnapshotRef = useRef<Prompt>(prompt);
  const skipNextPromptConfigTrackingRef = useRef(false);
  const pendingEditorViewStateSaveRef = useRef<{
    promptId?: string;
    promptUuid?: string;
    state: EditorPromptViewState;
  } | null>(null);
  const editorViewStateSaveTimerRef = useRef<number | null>(null);
  const promptSwitchTimingRef = useRef<{
    promptId?: string;
    promptUuid?: string;
    openRequestVersion: number;
    startedAt: number;
  } | null>(null);
  const lastLoggedSectionHeightsRef = useRef<string>('');

  /** Keep live section measurement paused while prompt content settles after open. */
  const getSectionMeasurementResumeDelay = useCallback((): number => {
    const delay = sectionMeasurementSuspendedUntilRef.current - Date.now();
    return delay > 0 ? delay : 0;
  }, []);

  /** Clear the post-open layout lock timer. */
  const clearPromptOpenLayoutSettleTimer = useCallback(() => {
    if (promptOpenLayoutSettleTimerRef.current !== null) {
      window.clearTimeout(promptOpenLayoutSettleTimerRef.current);
      promptOpenLayoutSettleTimerRef.current = null;
    }
  }, []);

  /** Clear pending Process plan hydration timeout without changing the visible state. */
  const clearPromptPlanHydrationTimer = useCallback(() => {
    if (promptPlanHydrationTimerRef.current !== null) {
      window.clearTimeout(promptPlanHydrationTimerRef.current);
      promptPlanHydrationTimerRef.current = null;
    }
  }, []);

  /** Stop the temporary Plan placeholder once the host has answered or the request changed. */
  const finishPromptPlanHydration = useCallback((reason: string, payload?: Record<string, unknown>) => {
    const currentRequest = promptPlanHydrationRequestRef.current;
    clearPromptPlanHydrationTimer();
    promptPlanHydrationRequestRef.current = null;
    setIsPromptPlanHydrating(false);

    if (!currentRequest) {
      return;
    }

    postEditorDebugLog('editor-layout', 'promptPlan.hydrationFinished', {
      reason,
      promptId: currentRequest.promptId,
      promptUuid: currentRequest.promptUuid,
      openRequestVersion: currentRequest.openRequestVersion,
      durationMs: Date.now() - currentRequest.startedAt,
      ...(payload || {}),
    });
  }, [clearPromptPlanHydrationTimer]);

  /** Reserve the saved Process Plan height until the async plan snapshot is loaded. */
  const startPromptPlanHydration = useCallback((
    nextPrompt: Prompt,
    nextViewState: EditorPromptViewState,
    openRequestVersion: number,
  ) => {
    clearPromptPlanHydrationTimer();
    promptPlanHydrationRequestRef.current = null;
    setIsPromptPlanHydrating(false);

    const savedPlanSectionHeight = normalizeEditorLayoutHeight(nextViewState.sectionHeights?.plan);
    const shouldHydratePlan = nextViewState.activeTab === 'process'
      && shouldShowPromptPlanForStatus(nextPrompt.status)
      && Boolean(savedPlanSectionHeight);
    if (!shouldHydratePlan) {
      return;
    }

    const promptId = String(nextPrompt.id || '__new__').trim() || '__new__';
    const promptUuid = String(nextPrompt.promptUuid || '').trim();
    promptPlanHydrationRequestRef.current = {
      promptId,
      promptUuid,
      openRequestVersion,
      startedAt: Date.now(),
    };
    setIsPromptPlanHydrating(true);

    postEditorDebugLog('editor-layout', 'promptPlan.hydrationStarted', {
      promptId,
      promptUuid,
      openRequestVersion,
      savedPlanSectionHeight,
      timeoutMs: PROMPT_PROCESS_PLAN_HYDRATION_TIMEOUT_MS,
    });

    promptPlanHydrationTimerRef.current = window.setTimeout(() => {
      const currentRequest = promptPlanHydrationRequestRef.current;
      promptPlanHydrationTimerRef.current = null;
      if (!currentRequest || currentRequest.promptId !== promptId) {
        return;
      }

      promptPlanHydrationRequestRef.current = null;
      setIsPromptPlanHydrating(false);
      postEditorDebugLog('editor-layout', 'promptPlan.hydrationTimeout', {
        promptId,
        promptUuid,
        openRequestVersion,
        durationMs: Date.now() - currentRequest.startedAt,
      });
    }, PROMPT_PROCESS_PLAN_HYDRATION_TIMEOUT_MS);
  }, [clearPromptPlanHydrationTimer]);

  /** Lock saved section heights briefly until child editors finish their first layout pass. */
  const startPromptOpenLayoutSettle = useCallback((tab: EditorPromptTab = 'main') => {
    clearPromptOpenLayoutSettleTimer();
    if (sectionMeasurementResumeTimerRef.current !== null) {
      window.clearTimeout(sectionMeasurementResumeTimerRef.current);
      sectionMeasurementResumeTimerRef.current = null;
    }
    const settleMs = tab === 'process'
      ? PROMPT_PROCESS_OPEN_SECTION_MEASURE_SETTLE_MS
      : PROMPT_OPEN_SECTION_MEASURE_SETTLE_MS;
    sectionMeasurementSuspendedUntilRef.current = Date.now() + settleMs;
    setIsPromptOpenLayoutSettling(true);
    promptOpenLayoutSettleTimerRef.current = window.setTimeout(() => {
      promptOpenLayoutSettleTimerRef.current = null;
      setIsPromptOpenLayoutSettling(false);
    }, settleMs);
  }, [clearPromptOpenLayoutSettleTimer]);

  /** Read the currently rendered section card heights from the live editor DOM. */
  const captureRenderedSectionHeights = useCallback((): EditorPromptSectionHeights => {
    const nextHeights: EditorPromptSectionHeights = { ...editorViewStateRef.current.sectionHeights };
    if (typeof document === 'undefined'
      || isPromptSwitchPlaceholderVisibleRef.current
      || getSectionMeasurementResumeDelay() > 0) {
      return nextHeights;
    }

    document.querySelectorAll<HTMLElement>('[data-pm-editor-section]').forEach((section) => {
      if (section.getAttribute('data-pm-editor-section-placeholder') === 'true') {
        return;
      }
      const sectionKey = section.getAttribute('data-pm-editor-section');
      if (!isEditorPromptSectionKey(sectionKey)) {
        return;
      }
      const height = normalizeEditorLayoutHeight(section.getBoundingClientRect().height);
      if (height) {
        nextHeights[sectionKey] = height;
      }
    });

    return nextHeights;
  }, [getSectionMeasurementResumeDelay]);

  /** Build a latest editor view state snapshot with live field and section heights. */
  const captureEditorViewStateSnapshot = useCallback((): EditorPromptViewState => normalizeEditorPromptViewState({
    activeTab,
    branchesExpanded: showBranches,
    branchesExpandedManual,
    expandedSections,
    manualSectionOverrides,
    descriptionExpanded: isDescriptionExpanded,
    contentHeights: {
      ...editorViewStateRef.current.contentHeights,
      ...(promptContentHeight ? { promptContent: promptContentHeight } : {}),
      ...(reportHeight ? { report: reportHeight } : {}),
      ...(globalContextHeight ? { globalContext: globalContextHeight } : {}),
      ...(projectInstructionsHeight ? { projectInstructions: projectInstructionsHeight } : {}),
    },
    sectionHeights: captureRenderedSectionHeights(),
  }), [
    activeTab,
    branchesExpandedManual,
    captureRenderedSectionHeights,
    expandedSections,
    globalContextHeight,
    isDescriptionExpanded,
    manualSectionOverrides,
    projectInstructionsHeight,
    promptContentHeight,
    reportHeight,
    showBranches,
  ]);

  /** Flush one queued layout-state save to the extension without awaiting host persistence. */
  const flushEditorViewStateSaveQueue = useCallback(() => {
    if (editorViewStateSaveTimerRef.current !== null) {
      window.clearTimeout(editorViewStateSaveTimerRef.current);
      editorViewStateSaveTimerRef.current = null;
    }
    const pendingSave = pendingEditorViewStateSaveRef.current;
    pendingEditorViewStateSaveRef.current = null;
    if (!pendingSave) {
      return;
    }

    vscode.postMessage({
      type: 'savePromptEditorViewState',
      promptId: pendingSave.promptId,
      promptUuid: pendingSave.promptUuid,
      state: pendingSave.state,
    });
  }, []);

  /** Queue a layout-state save separately from prompt save/open critical paths. */
  const enqueueEditorViewStateSave = useCallback((options?: { prompt?: Prompt; flush?: boolean; reason?: string }) => {
    const targetPrompt = options?.prompt || promptRef.current;
    const captureStartedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const state = captureEditorViewStateSnapshot();
    const captureFinishedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    editorViewStateRef.current = state;

    const currentState = (vscode.getState?.() || {}) as Record<string, unknown>;
    vscode.setState?.({ ...currentState, 'pm.editor.viewState': state });
    if (storage) {
      storage.setItem('pm.editor.viewState', JSON.stringify(state));
    }

    pendingEditorViewStateSaveRef.current = {
      promptId: targetPrompt.id || undefined,
      promptUuid: targetPrompt.promptUuid || undefined,
      state,
    };

    if (options?.reason) {
      postEditorDebugLog('editor-layout', 'viewState.capture', {
        reason: options.reason,
        promptId: targetPrompt.id || '__new__',
        promptUuid: targetPrompt.promptUuid || '',
        flush: options.flush === true,
        captureDurationMs: Math.round(captureFinishedAt - captureStartedAt),
        activeTab: state.activeTab,
        branchesExpanded: state.branchesExpanded,
        branchesExpandedManual: state.branchesExpandedManual,
        contentHeights: state.contentHeights,
        sectionHeights: state.sectionHeights,
        sectionCount: Object.keys(state.sectionHeights || {}).length,
        isLoaded,
        placeholderVisible: isPromptSwitchPlaceholderVisibleRef.current,
      });
    }

    if (options?.flush) {
      flushEditorViewStateSaveQueue();
      return;
    }

    if (editorViewStateSaveTimerRef.current === null) {
      editorViewStateSaveTimerRef.current = window.setTimeout(flushEditorViewStateSaveQueue, 0);
    }
  }, [captureEditorViewStateSnapshot, flushEditorViewStateSaveQueue, isLoaded, storage]);

  const enqueueEditorViewStateSaveRef = useRef(enqueueEditorViewStateSave);
  useEffect(() => {
    enqueueEditorViewStateSaveRef.current = enqueueEditorViewStateSave;
  }, [enqueueEditorViewStateSave]);

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

  const syncGitOverlayTrackedRequestState = useCallback(() => {
    const trackedRequests = Object.values(gitOverlayTrackedRequestsRef.current);
    setGitOverlayPendingGenerateProjects(Array.from(new Set(
      trackedRequests
        .filter(request => request.kind === 'generate')
        .flatMap(request => request.projects),
    )));
    setGitOverlayPendingCommitProjects(Array.from(new Set(
      trackedRequests
        .filter(request => request.kind === 'commit')
        .flatMap(request => request.projects),
    )));
    setGitOverlayHasPendingBulkGenerate(trackedRequests.some(request => request.kind === 'generate' && request.bulk));
    setGitOverlayHasPendingBulkCommit(trackedRequests.some(request => request.kind === 'commit' && request.bulk));
  }, []);

  const getLatestGitOverlayTrackedRequest = useCallback((): GitOverlayTrackedRequest | null => {
    const trackedRequests = Object.values(gitOverlayTrackedRequestsRef.current);
    if (trackedRequests.length === 0) {
      return null;
    }

    return trackedRequests.reduce<GitOverlayTrackedRequest | null>((latest, request) => {
      if (!latest || request.createdAt > latest.createdAt) {
        return request;
      }

      return latest;
    }, null);
  }, []);

  const hasGitOverlayTrackedRequest = useCallback((requestId?: string): boolean => {
    const normalizedRequestId = (requestId || '').trim();
    if (!normalizedRequestId) {
      return false;
    }

    return Boolean(gitOverlayTrackedRequestsRef.current[normalizedRequestId]);
  }, []);

  const registerGitOverlayTrackedRequest = useCallback((request: GitOverlayTrackedRequest) => {
    gitOverlayTrackedRequestsRef.current[request.requestId] = request;
    syncGitOverlayTrackedRequestState();
  }, [syncGitOverlayTrackedRequestState]);

  const finishGitOverlayTrackedRequest = useCallback((requestId?: string): boolean => {
    const normalizedRequestId = (requestId || '').trim();
    if (!normalizedRequestId || !gitOverlayTrackedRequestsRef.current[normalizedRequestId]) {
      return false;
    }

    delete gitOverlayTrackedRequestsRef.current[normalizedRequestId];
    syncGitOverlayTrackedRequestState();
    return true;
  }, [syncGitOverlayTrackedRequestState]);

  const clearGitOverlayTrackedRequests = useCallback(() => {
    gitOverlayTrackedRequestsRef.current = {};
    syncGitOverlayTrackedRequestState();
  }, [syncGitOverlayTrackedRequestState]);

  /** Minimum time (ms) the busy spinner remains visible so the user can see it. */
  const GIT_OVERLAY_MIN_BUSY_DISPLAY_MS = 350;

  const resetGitOverlayBusyState = useCallback(() => {
    gitOverlayHoldBusyUntilSnapshotRef.current = false;
    gitOverlayPendingCommitMessageGenerationRef.current = false;
    gitOverlayPendingCompletionActionRef.current = null;
    setGitOverlayWaitingForSnapshotAction(null);
    setGitOverlayBusyAction(null);
    setGitOverlayProcessLabel(null);
  }, []);

  const clearGitOverlayBusyState = useCallback((options?: { force?: boolean }) => {
    if (!options?.force) {
      const latestTrackedRequest = getLatestGitOverlayTrackedRequest();
      if (latestTrackedRequest) {
        gitOverlayHoldBusyUntilSnapshotRef.current = latestTrackedRequest.holdUntilSnapshot;
        gitOverlayPendingCommitMessageGenerationRef.current = latestTrackedRequest.kind === 'generate';
        gitOverlayPendingCompletionActionRef.current = null;
        setGitOverlayWaitingForSnapshotAction(null);
        setGitOverlayBusyAction(latestTrackedRequest.action);
        setGitOverlayProcessLabel(latestTrackedRequest.processLabel);
        return;
      }
    }

    // Ensure the spinner stays visible for at least GIT_OVERLAY_MIN_BUSY_DISPLAY_MS
    // so the user can perceive it even for fast git operations.
    const elapsed = Date.now() - gitOverlayBusyStartTimeRef.current;
    const remaining = GIT_OVERLAY_MIN_BUSY_DISPLAY_MS - elapsed;
    if (remaining > 0 && gitOverlayBusyStartTimeRef.current > 0) {
      setTimeout(() => resetGitOverlayBusyState(), remaining);
      return;
    }

    resetGitOverlayBusyState();
  }, [getLatestGitOverlayTrackedRequest, resetGitOverlayBusyState]);

  const createGitOverlayTrackedRequestId = useCallback((kind: GitOverlayTrackedRequestKind): string => (
    `git-overlay-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  ), []);

  const setGitOverlayBusyState = useCallback((
    action: string | null,
    processLabel: string | null,
    holdUntilSnapshot: boolean = false,
    pendingCompletionAction: GitOverlayActionKind | null = null,
  ) => {
    gitOverlayHoldBusyUntilSnapshotRef.current = holdUntilSnapshot;
    gitOverlayPendingCompletionActionRef.current = pendingCompletionAction;
    if (action) {
      gitOverlayBusyStartTimeRef.current = Date.now();
      setGitOverlayWaitingForSnapshotAction(null);
    }
    setGitOverlayBusyAction(action);
    setGitOverlayProcessLabel(processLabel);
  }, []);

  const preserveGitOverlayBusyStateUntilSnapshot = useCallback((): boolean => {
    const activeBusyAction = gitOverlayBusyActionRef.current;
    if (!gitOverlayHoldBusyUntilSnapshotRef.current
      || !activeBusyAction
      || activeBusyAction === 'overlay:loading'
      || activeBusyAction.startsWith('refresh:')) {
      return false;
    }

    gitOverlayPendingCommitMessageGenerationRef.current = false;
    gitOverlayPendingCompletionActionRef.current = null;
    setGitOverlayWaitingForSnapshotAction(activeBusyAction);
    return true;
  }, []);

  const resolveGitOverlayBusyReasonLabel = useCallback((reason: any): string | null => {
    if (!reason || typeof reason !== 'object') {
      return null;
    }

    if (reason.kind === 'label') {
      const label = typeof reason.label === 'string' ? reason.label.trim() : '';
      return label || null;
    }

    if (reason.kind === 'file') {
      const fileName = extractGitOverlayFileName(typeof reason.filePath === 'string' ? reason.filePath : '');
      if (!fileName) {
        return t('editor.gitOverlayProcessRefreshState');
      }
      return t('editor.gitOverlayProcessUpdatedFile').replace('{file}', fileName);
    }

    if (reason.kind === 'git') {
      return t('editor.gitOverlayProcessGitState');
    }

    return null;
  }, [t]);

  useEffect(() => {
    gitOverlayBusyActionRef.current = gitOverlayBusyAction;
  }, [gitOverlayBusyAction]);

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
    setGlobalContextSource(context.trim() ? 'manual' : 'empty');
    vscode.postMessage({ type: 'saveGlobalContext', context });
  }, []);

  const persistProjectInstructions = useCallback((content: string) => {
    setProjectInstructions(content);
    vscode.postMessage({ type: 'saveProjectInstructions', content });
  }, []);

  const handleResetGlobalContext = useCallback(() => {
    persistGlobalContext('');
    setNotice(null);
  }, [persistGlobalContext]);

  const handleLoadGlobalContext = useCallback(() => {
    if (isLoadingGlobalContext || !canLoadRemoteGlobalContext) {
      return;
    }
    setNotice(null);
    setIsLoadingGlobalContext(true);
    vscode.postMessage({ type: 'loadRemoteGlobalContext' });
  }, [canLoadRemoteGlobalContext, isLoadingGlobalContext]);

  /** Cancel delayed silent chat-time refresh while the user keeps switching prompts. */
  const clearPendingBackgroundRecalc = useCallback(() => {
    if (pendingBackgroundRecalcTimerRef.current !== null) {
      window.clearTimeout(pendingBackgroundRecalcTimerRef.current);
      pendingBackgroundRecalcTimerRef.current = null;
    }
  }, []);

  // Refresh bound chat timing after open without turning on the global editor progress line.
  const requestBackgroundImplementingTimeRefresh = useCallback((nextPrompt: Prompt) => {
    const promptId = String(nextPrompt.id || '').trim();
    if (!promptId || !(nextPrompt.chatSessionIds || []).length || recalcTriggeredForRef.current.has(promptId)) {
      return;
    }

    clearPendingBackgroundRecalc();
    pendingBackgroundRecalcTimerRef.current = window.setTimeout(() => {
      pendingBackgroundRecalcTimerRef.current = null;
      const currentPromptId = String(promptRef.current.id || '').trim();
      if (currentPromptId !== promptId || recalcTriggeredForRef.current.has(promptId)) {
        return;
      }
      recalcTriggeredForRef.current.add(promptId);
      vscode.postMessage({ type: 'recalcImplementingTime', id: promptId, silent: true });
    }, 900);
  }, [clearPendingBackgroundRecalc]);

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
    setPlanHighlightedLineIndexes([]);
    promptPlanStateRef.current = { exists: false, content: '' };
    hasSeenPromptPlanSnapshotRef.current = false;
  }, [prompt.id]);

  useEffect(() => {
    promptPlanStateRef.current = promptPlanState;
  }, [promptPlanState]);

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

  const buildPromptForSaveFrom = useCallback((basePrompt: Prompt): Prompt => {
    const timeSpent = Date.now() - openedAtRef.current;
    const updatedPrompt = applyElapsedTimeByContext(basePrompt, timeSpent);
    openedAtRef.current = Date.now();
    return updatedPrompt;
  }, []);

  const buildPromptForSave = useCallback((): Prompt => buildPromptForSaveFrom(promptRef.current), [buildPromptForSaveFrom]);

  // Preserve elapsed time in the current status bucket before switching status.
  const buildPromptForStatusChange = useCallback((status: PromptStatus): Prompt => {
    const timeSpent = Date.now() - openedAtRef.current;
    const updatedPrompt = TimeTrackingService.applyElapsedBeforeStatusChange(promptRef.current, status, timeSpent);
    openedAtRef.current = Date.now();
    return updatedPrompt;
  }, []);

  const createStartChatRequestId = useCallback(
    (): string => `start-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    [],
  );

  const closeGitOverlay = useCallback(() => {
    setGitOverlayOpen(false);
    setGitOverlayMode('default');
    gitOverlayPendingProjectDetailsRef.current = {};
    clearGitOverlayBusyState();
    resetStartChatPreflightTracking();
  }, [clearGitOverlayBusyState, resetStartChatPreflightTracking]);

  useEffect(() => {
    gitOverlayPendingProjectDetailsRef.current = {};
  }, [gitOverlaySnapshot?.generatedAt]);

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

  const handleEditorTabChange = useCallback((tab: EditorPromptTab) => {
    if (activeTab === tab) {
      return;
    }

    setActiveTab(tab);
  }, [activeTab]);

  const dispatchStartChat = useCallback((requestId: string, options?: { skipBranchMismatchCheck?: boolean }) => {
    const latestPrompt = promptRef.current;
    const isPersisted = Boolean((latestPrompt.promptUuid || '').trim());
    const originalStatus = latestPrompt.status;
    const shouldForceRebindChat = latestPrompt.status === 'draft';
    if (!isPersisted || !latestPrompt.content || (!shouldForceRebindChat && latestPrompt.chatSessionIds.length > 0)) {
      return;
    }

    handleEditorTabChange('process');

    pendingChatStartRequestIdRef.current = requestId;
    acceptedChatStartRequestIdRef.current = '';
    pendingChatStartPreflightRequestIdRef.current = '';
    pendingGitOverlayStartChatRequestIdRef.current = '';
    chatLaunchCompletionShownForKeyRef.current = false;
    setChatLaunchRequestStarted(false);
    setChatLaunchRenameState('idle');
    setChatContextAutoLoadState('idle');
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
    vscode.postMessage({
      type: 'startChat',
      id: updatedPrompt.id || '__new__',
      prompt: updatedPrompt,
      forceRebindChat: shouldForceRebindChat,
      requestId,
      skipBranchMismatchCheck: options?.skipBranchMismatchCheck === true,
      originalStatus,
      globalContext,
      globalContextSource,
    });
  }, [buildPromptForSave, globalContext, globalContextSource, handleEditorTabChange]);

  const continueOpenChat = useCallback(() => {
    if (isOpeningChatRef.current) {
      return;
    }

    const latestPrompt = promptRef.current;
    const requestedSessionId = String(latestPrompt.chatSessionIds[0] || '').trim();

    setNotice(null);
    setIsOpeningChat(true);

    if (latestPrompt.status !== 'in-progress') {
      const promptToSave = { ...buildPromptForSaveFrom(latestPrompt), status: 'in-progress' as const };
      promptRef.current = promptToSave;
      setPrompt(promptToSave);
      if (hasBeenSavedRef.current || promptToSave.id) {
        activeSaveIdRef.current = (promptToSave.id || latestPrompt.id || '__new__').trim() || '__new__';
        setIsSaving(true);
        setIsDirty(false);
        enqueueEditorViewStateSave({ prompt: promptToSave, reason: 'before-save:continue-open-chat' });
        vscode.postMessage({ type: 'savePrompt', prompt: promptToSave, source: 'status-change' });
      }
    }

    /* Let the host resolve the latest bound session from persisted storage. */
    if (latestPrompt.id) {
      vscode.postMessage({ type: 'openChat', id: latestPrompt.id, sessionId: requestedSessionId });
      return;
    }

    setIsOpeningChat(false);
    vscode.postMessage({ type: 'openChatPanel' });
  }, [buildPromptForSaveFrom, enqueueEditorViewStateSave]);

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
    if (projectInstructions.trim()) chunks.push(`Инструкция проекта: ${toShortText(projectInstructions, 64)}`);
    return chunks;
  }, [globalContext, projectInstructions]);

  const hasGlobalContext = globalContext.trim().length > 0;
  const normalizedReportText = useMemo(
    () => (prompt.report || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
    [prompt.report],
  );

  const hasReportContent = normalizedReportText.length > 0 || prompt.httpExamples.trim().length > 0;

  const reportSummary = useMemo(() => {
    const chunks: string[] = [];
    if (normalizedReportText) chunks.push(`Результат: ${toShortText(normalizedReportText, 64)}`);
    if (prompt.httpExamples.trim()) chunks.push(`HTTP: ${toShortText(prompt.httpExamples.trim(), 56)}`);
    return chunks;
  }, [normalizedReportText, prompt.httpExamples]);

  const normalizedNotesText = useMemo(
    () => (prompt.notes || '').replace(/\s+/g, ' ').trim(),
    [prompt.notes],
  );

  const hasNotesContent = normalizedNotesText.length > 0;

  const notesSummary = useMemo(() => {
    const chunks: string[] = [];
    if (normalizedNotesText) chunks.push(`Заметки: ${toShortText(normalizedNotesText, 64)}`);
    return chunks;
  }, [normalizedNotesText]);

  const planSummary = useMemo(() => {
    const chunks: string[] = [];
    const nonEmptyLines = promptPlanState.content
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    if (nonEmptyLines.length > 0) {
      chunks.push(toShortText(nonEmptyLines[0], 64));
      if (nonEmptyLines.length > 1) {
        chunks.push(`Строк: ${nonEmptyLines.length}`);
      }
    }

    return chunks;
  }, [promptPlanState.content]);

  const planLines = useMemo(() => promptPlanState.content.split(/\r?\n/), [promptPlanState.content]);

  const planLineSegments = useMemo(() => {
    const highlightedLineIndexSet = new Set(planHighlightedLineIndexes);
    const segments: Array<{ highlighted: boolean; lines: Array<{ index: number; text: string }> }> = [];

    for (let index = 0; index < planLines.length; index += 1) {
      const highlighted = highlightedLineIndexSet.has(index);
      const lastSegment = segments[segments.length - 1];
      const lineEntry = { index, text: planLines[index] };

      if (!lastSegment || lastSegment.highlighted !== highlighted) {
        segments.push({ highlighted, lines: [lineEntry] });
        continue;
      }

      lastSegment.lines.push(lineEntry);
    }

    return segments;
  }, [planLines, planHighlightedLineIndexes]);

  const shouldShowPlanSection = isPersistedPrompt && shouldShowPromptPlanForStatus(prompt.status);

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

  const groupsSummary = useMemo(() => {
    const chunks: string[] = [];
    const ids = prompt.customGroupIds || [];
    if (ids.length === 0) {
      return chunks;
    }
    const names = ids.map(id => {
      const group = customGroups.find(item => item.id === id);
      return group?.name || id;
    });
    chunks.push(`${t('editor.groups')}: ${toShortText(names.join(', '), 80)}`);
    return chunks;
  }, [prompt.customGroupIds, customGroups, t]);

  const filesSummary = useMemo(() => {
    const chunks: string[] = [];
    const files = dedupeContextFileReferences(prompt.contextFiles)
      .map(filePath => {
        const segments = filePath.split(/[\\/]/).filter(Boolean);
        return segments.length > 0 ? segments[segments.length - 1] : filePath;
      })
      .join(', ');
    if (files) chunks.push(`Файлы: ${toShortText(files, 56)}`);
    return chunks;
  }, [prompt.contextFiles]);

  const normalizedContextFiles = useMemo(
    () => dedupeContextFileReferences(prompt.contextFiles),
    [prompt.contextFiles],
  );

  const contextFileCardMap = useMemo(() => {
    const nextMap = new Map<string, PromptContextFileCard>();
    for (const fileCard of contextFileCards) {
      nextMap.set(normalizeContextFileReference(fileCard.path), fileCard);
    }
    return nextMap;
  }, [contextFileCards]);

  const visibleContextFileCards = useMemo(
    () => normalizedContextFiles.map(filePath => contextFileCardMap.get(filePath) || buildContextFileCardPlaceholder(filePath)),
    [contextFileCardMap, normalizedContextFiles],
  );

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

  const handlePasteContextFilesFromClipboard = useCallback(async () => {
    const clipboardImages = await readClipboardImagePayloads();
    if (clipboardImages.length > 0) {
      vscode.postMessage({
        type: 'pasteClipboardImages',
        promptId: (promptRef.current.id || '').trim() || undefined,
        images: clipboardImages,
      });
      return;
    }

    vscode.postMessage({ type: 'pasteFilesFromClipboard' });
  }, []);

  const handleOpenPromptPlanInEditor = useCallback(() => {
    if (!(promptRef.current.promptUuid || '').trim()) {
      return;
    }
    vscode.postMessage({ type: 'openPromptPlanInEditor', promptId: prompt.id });
  }, [prompt.id]);

  const handleOpenPromptConfigInEditor = useCallback(() => {
    if (!(promptRef.current.promptUuid || '').trim()) {
      return;
    }
    vscode.postMessage({ type: 'openPromptConfigInEditor', promptId: prompt.id });
  }, [prompt.id]);

  const handleOpenProjectInstructionsInEditor = useCallback(() => {
    vscode.postMessage({ type: 'openProjectInstructionsInEditor' });
  }, []);

  useEffect(() => {
    const readyTimer = window.setTimeout(() => {
      vscode.postMessage({ type: 'ready', bootId: bootIdRef.current });
      vscode.postMessage({ type: 'getCustomGroups' });
    }, 0);

    // Track writing time
    const interval = setInterval(() => {
      if (document.hasFocus() && promptRef.current.id) {
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
  }, []);

  useEffect(() => {
    currentPromptIdRef.current = (prompt.id || '__new__').trim() || '__new__';
  }, [prompt.id]);

  useEffect(() => {
    setChatMemorySummary(null);
  }, [prompt.id]);

  useEffect(() => {
    if (normalizedContextFiles.length === 0) {
      contextFileCardRequestIdRef.current = '';
      setContextFileCards([]);
      return;
    }

    const requestId = `context-files-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    contextFileCardRequestIdRef.current = requestId;
    vscode.postMessage({ type: 'requestContextFileCards', files: normalizedContextFiles, requestId });
  }, [normalizedContextFiles]);

  // Keep refs in sync with state
  useEffect(() => { promptRef.current = prompt; }, [prompt]);
  useEffect(() => { isDirtyRef.current = isDirty; }, [isDirty]);
  useEffect(() => { isSavingRef.current = isSaving; }, [isSaving]);
  useEffect(() => { isOpeningChatRef.current = isOpeningChat; }, [isOpeningChat]);
  useEffect(() => { gitOverlayOpenRef.current = gitOverlayOpen; }, [gitOverlayOpen]);

  useEffect(() => {
    const previousPrompt = previousPromptConfigSnapshotRef.current;
    if (skipNextPromptConfigTrackingRef.current) {
      skipNextPromptConfigTrackingRef.current = false;
      previousPromptConfigSnapshotRef.current = prompt;
      return;
    }

    const changedFields = diffPromptConfigSyncFields(previousPrompt, prompt);
    if (changedFields.length > 0) {
      const now = Date.now();
      const nextChangedAt = { ...promptConfigFieldChangedAtRef.current };
      for (const field of changedFields) {
        nextChangedAt[field] = now;
      }
      promptConfigFieldChangedAtRef.current = nextChangedAt;
    }

    previousPromptConfigSnapshotRef.current = prompt;
  }, [prompt]);

  useEffect(() => {
    if (!isDirty) {
      promptConfigFieldChangedAtRef.current = {};
    }
  }, [isDirty]);

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
      if (promptSwitchPlaceholderTimerRef.current) {
        window.clearTimeout(promptSwitchPlaceholderTimerRef.current);
      }
      if (editorViewStateSaveTimerRef.current !== null) {
        window.clearTimeout(editorViewStateSaveTimerRef.current);
        editorViewStateSaveTimerRef.current = null;
      }
      clearPromptOpenLayoutSettleTimer();
      if (sectionMeasurementResumeTimerRef.current !== null) {
        window.clearTimeout(sectionMeasurementResumeTimerRef.current);
        sectionMeasurementResumeTimerRef.current = null;
      }
      clearPromptPlanHydrationTimer();
      clearPendingBackgroundRecalc();
    };
  }, [clearPendingBackgroundRecalc, clearPromptOpenLayoutSettleTimer, clearPromptPlanHydrationTimer]);

  const setPromptSwitchPlaceholderActive = useCallback((active: boolean) => {
    isPromptSwitchPlaceholderVisibleRef.current = active;
    setIsPromptSwitchPlaceholderVisible(active);
  }, []);

  const clearPromptSwitchPlaceholderDelay = useCallback(() => {
    if (promptSwitchPlaceholderTimerRef.current !== null) {
      window.clearTimeout(promptSwitchPlaceholderTimerRef.current);
      promptSwitchPlaceholderTimerRef.current = null;
    }
    pendingPromptOpenMessageRef.current = null;
  }, []);

  /** Apply prompt-specific saved heights before real prompt fields arrive. */
  const applyPromptLayoutHeights = useCallback((viewState: EditorPromptViewState) => {
    const contentHeights = viewState.contentHeights || {};
    const nextPromptContentHeight = normalizeEditorLayoutHeight(contentHeights.promptContent);
    const nextReportHeight = normalizeEditorLayoutHeight(contentHeights.report);
    const nextGlobalContextHeight = normalizeEditorLayoutHeight(contentHeights.globalContext);
    const nextProjectInstructionsHeight = normalizeEditorLayoutHeight(contentHeights.projectInstructions);

    if (nextPromptContentHeight) { setPromptContentHeight(nextPromptContentHeight); }
    if (nextReportHeight) { setReportHeight(nextReportHeight); }
    if (nextGlobalContextHeight) { setGlobalContextHeight(nextGlobalContextHeight); }
    if (nextProjectInstructionsHeight) { setProjectInstructionsHeight(nextProjectInstructionsHeight); }
    setSectionHeights(viewState.sectionHeights || {});
  }, []);

  const handleMessage = useCallback((msg: any) => {
    switch (msg.type) {
      case 'promptLoading':
        {
          const nextOpenRequestVersion = Number(msg.openRequestVersion || 0);
          if (nextOpenRequestVersion > 0 && nextOpenRequestVersion < activePromptOpenRequestVersionRef.current) {
            break;
          }
          if (nextOpenRequestVersion > 0) {
            activePromptOpenRequestVersionRef.current = nextOpenRequestVersion;
          }
          promptSwitchTimingRef.current = {
            promptId: String(msg.promptId || '').trim() || undefined,
            promptUuid: String(msg.promptUuid || '').trim() || undefined,
            openRequestVersion: nextOpenRequestVersion,
            startedAt: Date.now(),
          };
        }
        enqueueEditorViewStateSave({ prompt: promptRef.current, flush: true, reason: 'before-switch' });
        finishPromptPlanHydration('switch');
        clearPromptOpenLayoutSettleTimer();
        if (sectionMeasurementResumeTimerRef.current !== null) {
          window.clearTimeout(sectionMeasurementResumeTimerRef.current);
          sectionMeasurementResumeTimerRef.current = null;
        }
        sectionMeasurementSuspendedUntilRef.current = Number.MAX_SAFE_INTEGER;
        setIsPromptOpenLayoutSettling(false);
        clearPendingBackgroundRecalc();
        clearPromptSwitchPlaceholderDelay();
        promptSwitchRestoreViewStateRef.current = editorViewStateRef.current;
        const loadingEditorViewState = normalizeEditorPromptViewState(msg.editorViewState);
        postEditorDebugLog('editor-layout', 'promptLoading.apply', {
          promptId: String(msg.promptId || '').trim() || '__new__',
          promptUuid: String(msg.promptUuid || '').trim(),
          openRequestVersion: Number(msg.openRequestVersion || 0),
          activeTab: loadingEditorViewState.activeTab,
          branchesExpanded: loadingEditorViewState.branchesExpanded,
          branchesExpandedManual: loadingEditorViewState.branchesExpandedManual,
          contentHeights: loadingEditorViewState.contentHeights,
          sectionHeights: loadingEditorViewState.sectionHeights,
          sectionCount: Object.keys(loadingEditorViewState.sectionHeights || {}).length,
        });
        setActiveTab(loadingEditorViewState.activeTab);
        setExpandedSections(loadingEditorViewState.expandedSections);
        setManualSectionOverrides(loadingEditorViewState.manualSectionOverrides);
        setIsDescriptionExpanded(loadingEditorViewState.descriptionExpanded);
        setShowBranches(loadingEditorViewState.branchesExpanded);
        setBranchesExpandedManual(loadingEditorViewState.branchesExpandedManual);
        applyPromptLayoutHeights(loadingEditorViewState);
        promptSwitchPlaceholderStartedAtRef.current = Date.now();
        setPromptSwitchPlaceholderActive(true);
        setShowLoader(true);
        clearChatStartTimeout();
        startChatLockRef.current = false;
        setIsStartingChat(false);
        setChatLaunchRequestStarted(false);
        setChatLaunchRenameState('idle');
        resetChatStartRequestTracking();
        resetStartChatPreflightTracking();
        setIsLoaded(false);
        setIsChatPanelOpen(false);
        setNotice(null);
        setIsLoadingGlobalContext(false);
        setIsRecalculating(false);
        setIsGeneratingTitle(false);
        setIsGeneratingDescription(false);
        setGitOverlayOpen(false);
        setGitOverlayMode('default');
        setGitOverlaySnapshot(null);
        setGitOverlayFileHistory(null);
        setGitOverlayCommitMessages({});
        clearGitOverlayTrackedRequests();
        clearGitOverlayBusyState({ force: true });
        setGitOverlayCompletedActions({ push: false, 'review-request': false, merge: false });
        setPromptPlanState({ exists: false, content: '' });
        break;
      case 'promptLoadingCancelled':
        {
          const cancelledOpenRequestVersion = Number(msg.openRequestVersion || 0);
          if (cancelledOpenRequestVersion === 0
            || cancelledOpenRequestVersion !== activePromptOpenRequestVersionRef.current) {
            break;
          }

          clearPromptSwitchPlaceholderDelay();
          const restoreViewState = promptSwitchRestoreViewStateRef.current;
          if (restoreViewState) {
            setActiveTab(restoreViewState.activeTab);
            setExpandedSections(restoreViewState.expandedSections);
            setManualSectionOverrides(restoreViewState.manualSectionOverrides);
            setIsDescriptionExpanded(restoreViewState.descriptionExpanded);
            setShowBranches(restoreViewState.branchesExpanded);
            setBranchesExpandedManual(restoreViewState.branchesExpandedManual);
            applyPromptLayoutHeights(restoreViewState);
          }
          promptSwitchRestoreViewStateRef.current = null;
          finishPromptPlanHydration('cancelled');
          sectionMeasurementSuspendedUntilRef.current = 0;
          setPromptSwitchPlaceholderActive(false);
          activePromptOpenRequestVersionRef.current = 0;
          setShowLoader(false);
          setIsLoaded(true);
        }
        break;
      case 'prompt':
        if (msg.prompt) {
          const incomingPromptId = (String(msg.prompt.id || '__new__').trim() || '__new__');
          const incomingPromptUuid = (String(msg.prompt.promptUuid || '').trim() || '');
          const currentPromptId = (currentPromptIdRef.current || '__new__').trim() || '__new__';
          const currentPromptUuid = (String(promptRef.current.promptUuid || '').trim() || '');
          const activeSaveId = (activeSaveIdRef.current || '').trim();
          const activeSaveRequestId = (activeSaveRequestIdRef.current || '').trim();
          const previousPromptId = (String(msg.previousId || '').trim() || '');
          const reason: 'open' | 'save' | 'sync' | 'ai-enrichment' | 'external-config' | undefined = msg.reason;
          const incomingRequestId = (String(msg.requestId || '').trim() || '');
          const isOpenPayload = reason === 'open';
          const incomingOpenRequestVersion = Number(msg.openRequestVersion || 0);
          if (isOpenPayload && incomingOpenRequestVersion > 0
            && incomingOpenRequestVersion < activePromptOpenRequestVersionRef.current) {
            break;
          }
          if (isOpenPayload
            && incomingOpenRequestVersion > 0
            && isPromptSwitchPlaceholderVisibleRef.current
            && promptSwitchPlaceholderStartedAtRef.current > 0) {
            const placeholderVisibleMs = Date.now() - promptSwitchPlaceholderStartedAtRef.current;
            const remainingPlaceholderMs = PROMPT_SWITCH_PLACEHOLDER_MIN_VISIBLE_MS - placeholderVisibleMs;
            if (remainingPlaceholderMs > 0) {
              pendingPromptOpenMessageRef.current = msg;
              if (promptSwitchPlaceholderTimerRef.current !== null) {
                window.clearTimeout(promptSwitchPlaceholderTimerRef.current);
              }
              postEditorDebugLog('editor-layout', 'promptOpen.delayed', {
                promptId: incomingPromptId,
                promptUuid: incomingPromptUuid,
                openRequestVersion: incomingOpenRequestVersion,
                placeholderVisibleMs,
                delayMs: remainingPlaceholderMs,
                minVisibleMs: PROMPT_SWITCH_PLACEHOLDER_MIN_VISIBLE_MS,
              });
              promptSwitchPlaceholderTimerRef.current = window.setTimeout(() => {
                promptSwitchPlaceholderTimerRef.current = null;
                const pendingPromptOpenMessage = pendingPromptOpenMessageRef.current;
                pendingPromptOpenMessageRef.current = null;
                if (pendingPromptOpenMessage) {
                  unstable_batchedUpdates(() => handleMessageRef.current(pendingPromptOpenMessage));
                }
              }, remainingPlaceholderMs);
              break;
            }
          }
          if (reason === 'save' && activeSaveRequestId && incomingRequestId !== activeSaveRequestId) {
            break;
          }
          /** Принимаем save-ответ для нового промпта только если UUID совпадает или отсутствует */
          const isNewPromptSaveResponse = currentPromptId === '__new__' && reason === 'save'
            && (incomingPromptUuid === '' || currentPromptUuid === '' || incomingPromptUuid === currentPromptUuid);
          const isRelatedToCurrentPrompt = incomingPromptId === currentPromptId
            || (incomingPromptUuid !== '' && currentPromptUuid !== '' && incomingPromptUuid === currentPromptUuid)
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
            if (incomingOpenRequestVersion > 0) {
              activePromptOpenRequestVersionRef.current = incomingOpenRequestVersion;
            }
            const nextEditorViewState = normalizeEditorPromptViewState(msg.editorViewState);
            const promptSwitchTiming = promptSwitchTimingRef.current;
            postEditorDebugLog('editor-layout', 'promptOpen.apply', {
              promptId: incomingPromptId,
              promptUuid: incomingPromptUuid,
              openRequestVersion: incomingOpenRequestVersion,
              durationMs: promptSwitchTiming ? Date.now() - promptSwitchTiming.startedAt : null,
              placeholderVisible: isPromptSwitchPlaceholderVisibleRef.current,
              activeTab: nextEditorViewState.activeTab,
              branchesExpanded: nextEditorViewState.branchesExpanded,
              branchesExpandedManual: nextEditorViewState.branchesExpandedManual,
              contentHeights: nextEditorViewState.contentHeights,
              sectionHeights: nextEditorViewState.sectionHeights,
              sectionCount: Object.keys(nextEditorViewState.sectionHeights || {}).length,
            });
            promptSwitchTimingRef.current = null;
            const shouldResetGitOverlayState = shouldResetGitOverlayStateOnPromptOpen({
              overlayOpen: gitOverlayOpenRef.current,
              currentPromptId,
              currentPromptUuid,
              incomingPromptId,
              incomingPromptUuid,
              previousPromptId,
            });
            clearPromptSwitchPlaceholderDelay();
            promptSwitchRestoreViewStateRef.current = null;
            setPromptSwitchPlaceholderActive(false);
            setShowLoader(false);
            setIsGeneratingTitle(Boolean(msg.aiEnrichment?.title));
            setIsGeneratingDescription(Boolean(msg.aiEnrichment?.description));
            setChatLaunchRequestStarted(false);
            setChatLaunchRenameState('idle');
            setNotice(null);
            if (shouldResetGitOverlayState) {
              setGitOverlayOpen(false);
              setGitOverlayMode('default');
              resetStartChatPreflightTracking();
              setGitOverlaySnapshot(null);
              setGitOverlayFileHistory(null);
              setGitOverlayCommitMessages({});
              clearGitOverlayBusyState();
              setGitOverlayCompletedActions({ push: false, 'review-request': false, merge: false });
            }
            skipNextPromptConfigTrackingRef.current = true;
            promptRef.current = msg.prompt;
            setPrompt(msg.prompt);
            setActiveTab(nextEditorViewState.activeTab);
            setExpandedSections(nextEditorViewState.expandedSections);
            setManualSectionOverrides(nextEditorViewState.manualSectionOverrides);
            setIsDescriptionExpanded(nextEditorViewState.descriptionExpanded);
            setShowBranches(nextEditorViewState.branchesExpanded);
            setBranchesExpandedManual(nextEditorViewState.branchesExpandedManual);
            applyPromptLayoutHeights(nextEditorViewState);
            startPromptOpenLayoutSettle(nextEditorViewState.activeTab);
            startPromptPlanHydration(msg.prompt, nextEditorViewState, incomingOpenRequestVersion);
            localReportDirtyRef.current = false;
            currentPromptIdRef.current = incomingPromptId;
            hasBeenSavedRef.current = Boolean(msg.prompt.id);
            userChangeCounterRef.current = 0;
            saveStartCounterRef.current = 0;
            setIsDirty(false);
            setIsLoaded(true);
            setIsSaving(false);
            activeSaveIdRef.current = null;
            activeSaveRequestIdRef.current = null;
            activeSaveClearedDirtyRef.current = false;
            if ((msg.prompt.chatSessionIds || []).length > 0) {
              releaseStartChatPendingState();
              requestBackgroundImplementingTimeRefresh(msg.prompt);
            }
            requestPromptPlanState(msg.prompt.id);
            break;
          }

          // Reset autosave lock state per prompt to avoid inheriting from previous prompt
          hasBeenSavedRef.current = Boolean(msg.prompt.id);

          if (reason === 'sync') {
            // Background sync (chat completion, recalc, status change) — merge only server-side fields, keep user edits
            skipNextPromptConfigTrackingRef.current = true;
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

          if (reason === 'external-config') {
            const changedFields = diffPromptConfigSyncFields(promptRef.current, msg.prompt);
            promptConfigFieldChangedAtRef.current = clearPromptConfigFieldChangedAt(
              promptConfigFieldChangedAtRef.current,
              changedFields,
            );
            skipNextPromptConfigTrackingRef.current = true;
            promptRef.current = msg.prompt;
            setPrompt(msg.prompt);
            if (incomingPromptId !== currentPromptId && incomingPromptId !== '__new__') {
              currentPromptIdRef.current = incomingPromptId;
            }
            setIsLoaded(true);
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
            skipNextPromptConfigTrackingRef.current = true;
            promptRef.current = enrichedPrompt;
            setPrompt(enrichedPrompt);
            const nextPromptId = (String(msg.prompt.id || '').trim() || '');
            if (nextPromptId && nextPromptId !== '__new__' && nextPromptId !== currentPromptIdRef.current) {
              currentPromptIdRef.current = nextPromptId;
            }
            if (previousPromptId && activeSaveIdRef.current === previousPromptId && nextPromptId) {
              activeSaveIdRef.current = nextPromptId;
            }
            setIsGeneratingTitle(false);
            setIsGeneratingDescription(false);
            // Don't touch isDirty — user's pending edits stay intact
            requestPromptPlanState(msg.prompt.id);
            break;
          }

          const userChangedAfterSave = userChangeCounterRef.current !== saveStartCounterRef.current;
          const shouldMergeAfterSave = reason === 'save' && userChangedAfterSave && saveStartCounterRef.current > 0;
          skipNextPromptConfigTrackingRef.current = true;
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
          activeSaveIdRef.current = null;
          activeSaveRequestIdRef.current = null;
          activeSaveClearedDirtyRef.current = false;
          if (reason === 'save' && msg.aiEnrichment) {
            setIsGeneratingTitle(Boolean(msg.aiEnrichment.title));
            setIsGeneratingDescription(Boolean(msg.aiEnrichment.description));
          }
          if ((msg.prompt.chatSessionIds || []).length > 0) {
            releaseStartChatPendingState();
            requestBackgroundImplementingTimeRefresh(msg.prompt);
          }
          requestPromptPlanState(msg.prompt.id);
        }
        break;
      case 'promptPlanUpdated':
        {
          const incomingPromptId = String(msg.promptId || '').trim();
          const currentPromptId = String(currentPromptIdRef.current || '').trim();
          // Отклоняем snapshot с пустым promptId, если у webview уже есть непустой ID.
          // Это защищает от race condition, когда старый FileSystemWatcher после rename
          // отправляет пустой snapshot до обновления watcher на новый путь.
          if (currentPromptId && !incomingPromptId) {
            break;
          }
          if (incomingPromptId && currentPromptId && incomingPromptId !== currentPromptId) {
            break;
          }

          const nextPlanState = {
            exists: Boolean(msg.exists),
            content: Boolean(msg.exists) ? String(msg.content || '') : '',
          };
          const previousPlanState = promptPlanStateRef.current;
          const shouldHighlightChangedLines = hasSeenPromptPlanSnapshotRef.current
            && (previousPlanState.exists !== nextPlanState.exists
              || previousPlanState.content !== nextPlanState.content);
          const nextHighlightedLineIndexes = shouldHighlightChangedLines && nextPlanState.exists
            ? getChangedLineIndexes(previousPlanState.exists ? previousPlanState.content : '', nextPlanState.content)
            : [];

          hasSeenPromptPlanSnapshotRef.current = true;
          promptPlanStateRef.current = nextPlanState;
          setPlanHighlightedLineIndexes(nextHighlightedLineIndexes);
          setPromptPlanState(nextPlanState);
          finishPromptPlanHydration('updated', {
            promptId: incomingPromptId || currentPromptId || '__new__',
            exists: nextPlanState.exists,
            contentLength: nextPlanState.content.length,
          });
        }
        break;
      case 'promptSaved':
        if ((activeSaveRequestIdRef.current || '').trim()) {
          const incomingRequestId = (String(msg.requestId || '').trim() || '');
          if (incomingRequestId !== (activeSaveRequestIdRef.current || '').trim()) {
            break;
          }
        }
        if (!shouldApplyPromptSaveResult(
          msg.prompt?.id,
          msg.prompt?.promptUuid,
          msg.previousId,
          currentPromptIdRef.current,
          promptRef.current.promptUuid,
          activeSaveIdRef.current,
        )) {
          break;
        }
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
          const activeSaveRequestId = (activeSaveRequestIdRef.current || '').trim();
          if (activeSaveRequestId) {
            const incomingRequestId = (String(msg.requestId || '').trim() || '');
            if (incomingRequestId !== activeSaveRequestId) {
              break;
            }
          }
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
            activeSaveRequestIdRef.current = null;
            activeSaveClearedDirtyRef.current = false;
          }
        }
        break;
      case 'promptContentUpdated':
        // Content updated from external editor — show changes but do NOT auto-save
        // (user decides when to save in the external editor)
        promptRef.current = { ...promptRef.current, content: msg.content || '' };
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
      case 'customGroups':
        setCustomGroups(Array.isArray(msg.groups) ? msg.groups : []);
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
        setCanLoadRemoteGlobalContext(msg.canLoadRemote === true);
        setGlobalContextAutoLoadEnabled(msg.autoLoadEnabled === true);
        setGlobalContextSource(msg.source || 'empty');
        break;
      case 'globalContextLoaded':
        setIsLoadingGlobalContext(false);
        setNotice(null);
        setGlobalContext(msg.context || '');
        setCanLoadRemoteGlobalContext(msg.canLoadRemote === true);
        setGlobalContextAutoLoadEnabled(msg.autoLoadEnabled === true);
        setGlobalContextSource(msg.source || 'empty');
        break;
      case 'globalContextLoadFailed':
        setIsLoadingGlobalContext(false);
        showInlineNotice('error', msg.message || 'Не удалось загрузить общую инструкцию.');
        break;
      case 'projectInstructions':
        setProjectInstructions(msg.content || '');
        setProjectInstructionsExists(msg.exists === true);
        break;
      case 'promptAiEnrichmentState':
        if (!shouldApplyPromptAiEnrichmentState(
          msg.promptId,
          msg.promptUuid,
          currentPromptIdRef.current,
          promptRef.current.promptUuid,
          activeSaveIdRef.current,
        )) {
          break;
        }

        setIsGeneratingTitle(Boolean(msg.title));
        setIsGeneratingDescription(Boolean(msg.description));
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
            clearGitOverlayBusyState();
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
        setChatLaunchRenameState('idle');
        releaseStartChatPendingState();
        break;
      case 'chatContextAutoLoadState':
        if (!shouldHandleChatStartMessage(msg.requestId)) {
          break;
        }
        setChatContextAutoLoadState(
          msg.state === 'started'
            ? 'active'
            : msg.state === 'completed'
              ? 'completed'
              : 'fallback',
        );
        break;
      case 'chatRequestStarted':
        if (!shouldHandleChatStartMessage(msg.requestId)) {
          break;
        }
        if ((msg.requestId || '').trim() === pendingChatStartRequestIdRef.current) {
          acceptedChatStartRequestIdRef.current = pendingChatStartRequestIdRef.current;
          pendingChatStartRequestIdRef.current = '';
        }
        setChatLaunchRequestStarted(true);
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
        setIsOpeningChat(false);
        setIsChatPanelOpen(true);
        break;
      case 'chatLaunchRenameState':
        if (!shouldHandleChatStartMessage(msg.requestId)) {
          break;
        }
        setChatLaunchRenameState(msg.state === 'started' ? 'active' : 'completed');
        break;
      case 'chatMemorySummary':
        if (msg.memorySummary) {
          const targetPromptId = (msg.promptId || '__new__').trim() || '__new__';
          const currentPromptId = (currentPromptIdRef.current || '__new__').trim() || '__new__';
          if (targetPromptId !== currentPromptId) {
            break;
          }
          setChatMemorySummary(msg.memorySummary as ChatMemorySummary);
        }
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
            enqueueEditorViewStateSave({ prompt: updatedPrompt, reason: 'before-save:improved-prompt-autosave' });
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
        {
          const previousBusyAction = gitOverlayBusyActionRef.current;
          const nextBusyAction = (msg.action || '').trim() || null;
          const shouldPreservePreviousBusyAction = Boolean(
            previousBusyAction
            && previousBusyAction !== 'overlay:loading'
            && !previousBusyAction.startsWith('refresh:')
          );

          if (!nextBusyAction) {
            if (!shouldPreservePreviousBusyAction) {
              clearGitOverlayBusyState();
            }
            break;
          }

          if (shouldPreservePreviousBusyAction) {
            break;
          }

          setGitOverlayBusyState(
            nextBusyAction,
            resolveGitOverlayBusyReasonLabel(msg.reason),
            nextBusyAction === 'overlay:loading' || nextBusyAction.startsWith('refresh:'),
          );
        }
        break;
      case 'gitOverlaySnapshot':
        {
        const reviewProjects = Array.isArray(msg.snapshot?.projects)
          ? msg.snapshot.projects
            .filter((project: GitOverlaySnapshot['projects'][number]) => Boolean(project.review.remote)
              || Boolean(project.review.setupAction)
              || Boolean(project.review.request)
              || Boolean(project.review.unsupportedReason)
              || Boolean(project.review.error))
            .map((project: GitOverlaySnapshot['projects'][number]) => ({
              project: project.project,
              host: project.review.remote?.host || null,
              provider: project.review.remote?.provider || null,
              cliCommand: project.review.remote?.cliCommand || null,
              cliAvailable: project.review.remote?.cliAvailable ?? null,
              setupAction: project.review.setupAction || null,
              unsupportedReason: project.review.unsupportedReason || null,
              hasRequest: Boolean(project.review.request),
              requestState: project.review.request?.state || null,
              error: project.review.error || null,
            }))
          : [];
        logGitOverlayDebug('snapshot.received', {
          projectCount: Array.isArray(msg.snapshot?.projects) ? msg.snapshot.projects.length : 0,
          promptBranch: String(msg.snapshot?.promptBranch || '').trim(),
          trackedBranchCount: Array.isArray(msg.snapshot?.trackedBranches) ? msg.snapshot.trackedBranches.length : 0,
          reviewProjects,
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
        if (finishGitOverlayTrackedRequest(msg.requestId)) {
          setGitOverlayWaitingForSnapshotAction(null);
          clearGitOverlayBusyState();
          break;
        }
        if (gitOverlayPendingCommitMessageGenerationRef.current || gitOverlayPendingCompletionActionRef.current) {
          setGitOverlayWaitingForSnapshotAction(null);
          break;
        }
        clearGitOverlayBusyState();
        break;
        }
      case 'gitOverlayOtherProjectsSnapshot':
        setGitOverlaySnapshot((prev) => {
          if (!prev) {
            return prev;
          }

          return {
            ...prev,
            otherProjects: Array.isArray(msg.otherProjects) ? msg.otherProjects : [],
          };
        });
        break;
      case 'gitOverlayProjectSnapshot':
        {
        const snapshotGeneratedAt = String(msg.snapshotGeneratedAt || '').trim();
        const projectSnapshot = (msg.projectSnapshot || null) as GitOverlayProjectSnapshot | null;
        const projectName = (projectSnapshot?.project || '').trim();
        if (snapshotGeneratedAt && projectName) {
          delete gitOverlayPendingProjectDetailsRef.current[`${snapshotGeneratedAt}:${projectName}`];
        }

        setGitOverlaySnapshot((prev) => {
          if (!prev || !projectSnapshot || prev.generatedAt !== snapshotGeneratedAt) {
            return prev;
          }

            const mergeProjectSnapshot = (currentProject: GitOverlayProjectSnapshot): GitOverlayProjectSnapshot => {
            let mergedProjectSnapshot = projectSnapshot;

            if (currentProject.changeDetailsHydrated && mergedProjectSnapshot.changeDetailsHydrated === false) {
            mergedProjectSnapshot = {
              ...mergedProjectSnapshot,
              changeGroups: currentProject.changeGroups,
              changeDetailsHydrated: true,
            };
            }

            if (currentProject.branchDetailsHydrated && mergedProjectSnapshot.branchDetailsHydrated === false) {
            mergedProjectSnapshot = {
              ...mergedProjectSnapshot,
              upstream: currentProject.upstream,
              ahead: currentProject.ahead,
              behind: currentProject.behind,
              lastCommit: currentProject.lastCommit,
              branches: currentProject.branches,
              cleanupBranches: currentProject.cleanupBranches,
              staleLocalBranches: currentProject.staleLocalBranches,
              graph: currentProject.graph,
              branchDetailsHydrated: true,
            };
            }

            if (currentProject.reviewHydrated && mergedProjectSnapshot.reviewHydrated === false) {
            mergedProjectSnapshot = {
              ...mergedProjectSnapshot,
              review: currentProject.review,
              reviewHydrated: true,
            };
            }

            return mergedProjectSnapshot;
            };

          let selectedChanged = false;
          const nextProjects = prev.projects.map((project) => {
            if (project.project !== projectSnapshot.project) {
              return project;
            }
            selectedChanged = true;
              return mergeProjectSnapshot(project);
          });

          let otherChanged = false;
          const nextOtherProjects = (prev.otherProjects || []).map((project) => {
            if (project.project !== projectSnapshot.project) {
              return project;
            }
            otherChanged = true;
              return mergeProjectSnapshot(project);
          });

          if (!selectedChanged && !otherChanged) {
            return prev;
          }

          return {
            ...prev,
            projects: nextProjects,
            otherProjects: nextOtherProjects,
          };
        });
        break;
        }
      case 'gitOverlayFileHistory':
        setGitOverlayFileHistory(msg.history || null);
        clearGitOverlayBusyState();
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
        if (finishGitOverlayTrackedRequest(msg.requestId)) {
          clearGitOverlayBusyState();
          break;
        }
        if (gitOverlayPendingCommitMessageGenerationRef.current) {
          clearGitOverlayBusyState();
          break;
        }
        if (!gitOverlayHoldBusyUntilSnapshotRef.current) {
          clearGitOverlayBusyState();
        }
        break;
      case 'gitOverlayActionCompleted':
        setGitOverlayCompletedActions((prev) => ({
          ...prev,
          [msg.action]: true,
        }));
        if (gitOverlayPendingCompletionActionRef.current === msg.action) {
          gitOverlayPendingCompletionActionRef.current = null;
          // Keep busy until snapshot confirms the side-effects (e.g. push updates remote state)
          if (!preserveGitOverlayBusyStateUntilSnapshot()) {
            clearGitOverlayBusyState();
          }
        }
        break;
      case 'contextFileCards': {
        const requestId = (msg.requestId || '').trim();
        if (requestId && requestId !== contextFileCardRequestIdRef.current) {
          break;
        }

        setContextFileCards(Array.isArray(msg.files) ? msg.files : []);
        break;
      }
      case 'pickedFiles':
        if (msg.files && msg.files.length > 0) {
          const nextContextFiles = dedupeContextFileReferences([
            ...promptRef.current.contextFiles,
            ...msg.files,
          ]);
          const currentContextFiles = dedupeContextFileReferences(promptRef.current.contextFiles);
          if (areFileListsEqual(currentContextFiles, nextContextFiles)) {
            break;
          }

          setPrompt(prev => ({
            ...prev,
            contextFiles: nextContextFiles,
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
          const matchesSaveRequest = requestId === (activeSaveRequestIdRef.current || '').trim();
          const matchesChatStartRequest = shouldHandleChatStartMessage(requestId);
          const matchesPreflightRequest = requestId === pendingChatStartPreflightRequestIdRef.current;
          const matchesGitOverlayTrackedRequest = hasGitOverlayTrackedRequest(requestId);
          if (matchesSaveRequest) {
            setIsSaving(false);
            if (activeSaveClearedDirtyRef.current) {
              setIsDirty(true);
            }
            activeSaveIdRef.current = null;
            activeSaveRequestIdRef.current = null;
            activeSaveClearedDirtyRef.current = false;
            showInlineNotice('error', msg.message);
            break;
          }
          if (!matchesChatStartRequest && !matchesPreflightRequest && !matchesGitOverlayTrackedRequest) {
            break;
          }
          if (!matchesChatStartRequest && !matchesPreflightRequest && matchesGitOverlayTrackedRequest) {
            showInlineNotice('error', msg.message);
            break;
          }
        }
        releaseStartChatPendingState({ resetSaving: true });
        setChatLaunchRequestStarted(false);
        setChatLaunchRenameState('idle');
        setChatLaunchCompletionHold(false);
        setIsOpeningChat(false);
        setIsSaving(false);
        setIsGeneratingTitle(false);
        setIsGeneratingDescription(false);
        setIsImprovingPromptText(false);
        setIsGeneratingReport(false);
        setIsRecalculating(false);
        if (!preserveGitOverlayBusyStateUntilSnapshot()) {
          clearGitOverlayBusyState();
        }
        activeSaveIdRef.current = null;
        activeSaveRequestIdRef.current = null;
        activeSaveClearedDirtyRef.current = false;
        resetChatStartRequestTracking();
        resetStartChatPreflightTracking();
        showInlineNotice('error', msg.message);
        break;
      case 'info':
        if (hasGitOverlayTrackedRequest(msg.requestId)) {
          showInlineNotice('info', msg.message);
          break;
        }
				if (gitOverlayHoldBusyUntilSnapshotRef.current) {
					const activeBusyAction = gitOverlayBusyActionRef.current;
					if (activeBusyAction && activeBusyAction !== 'overlay:loading' && !activeBusyAction.startsWith('refresh:')) {
						setGitOverlayWaitingForSnapshotAction(activeBusyAction);
					}
				}
        if (!gitOverlayHoldBusyUntilSnapshotRef.current
          && !gitOverlayPendingCommitMessageGenerationRef.current
          && !gitOverlayPendingCompletionActionRef.current) {
          clearGitOverlayBusyState();
        }
        showInlineNotice('info', msg.message);
        break;
      case 'clearNotice':
        clearChatStartTimeout();
        startChatLockRef.current = false;
        setIsStartingChat(false);
        setChatLaunchRequestStarted(false);
        setChatLaunchRenameState('idle');
        setChatLaunchCompletionHold(false);
        setIsOpeningChat(false);
        resetChatStartRequestTracking();
        resetStartChatPreflightTracking();
        setNotice(null);
        break;
      case 'implementingTimeRecalculated':
        setIsRecalculating(false);
        break;
    }
  }, [applyPromptLayoutHeights, clearChatStartTimeout, clearPendingBackgroundRecalc, clearPromptOpenLayoutSettleTimer, clearPromptSwitchPlaceholderDelay, createStartChatRequestId, dispatchStartChat, enqueueEditorViewStateSave, finishPromptPlanHydration, releaseStartChatPendingState, requestBackgroundImplementingTimeRefresh, resetChatStartRequestTracking, resetStartChatPreflightTracking, setPromptSwitchPlaceholderActive, shouldHandleChatStartMessage, showInlineNotice, startPromptOpenLayoutSettle, startPromptPlanHydration]);

  handleMessageRef.current = handleMessage;

  const batchedHandleMessage = useCallback((msg: any) => {
    unstable_batchedUpdates(() => handleMessage(msg));
  }, [handleMessage]);

  useMessageListener(batchedHandleMessage);

  useEffect(() => () => {
    clearChatStartTimeout();
  }, [clearChatStartTimeout]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') {
        return;
      }
      enqueueEditorViewStateSaveRef.current({ flush: true, reason: 'page-hidden' });
      clearChatStartTimeout();
      startChatLockRef.current = false;
      setIsStartingChat(false);
      setChatLaunchRequestStarted(false);
      setChatLaunchRenameState('idle');
      setChatLaunchCompletionHold(false);
      resetChatStartRequestTracking();
      resetStartChatPreflightTracking();
      setNotice(null);
    };

    const handlePageExit = () => {
      enqueueEditorViewStateSaveRef.current({ flush: true, reason: 'page-exit' });
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageExit);
    window.addEventListener('beforeunload', handlePageExit);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageExit);
      window.removeEventListener('beforeunload', handlePageExit);
      enqueueEditorViewStateSaveRef.current({ flush: true, reason: 'effect-cleanup' });
    };
  }, [clearChatStartTimeout, resetChatStartRequestTracking, resetStartChatPreflightTracking]);

  // Notify extension about dirty state changes
  useEffect(() => {
    vscode.postMessage({
      type: 'markDirty',
      dirty: isDirty,
      prompt: isDirty ? prompt : undefined,
      promptId: currentPromptIdRef.current || '',
      configFieldChangedAt: isDirty ? promptConfigFieldChangedAtRef.current : undefined,
    });
  }, [isDirty, prompt]);

  /** Ref to track whether auto-expand already fired for this prompt load */
  const branchAutoExpandedRef = useRef(false);

  useEffect(() => {
    if (prompt.projects.length === 0) {
      setBranchesResolved(false);
      setBranches([]);
      setShowBranches(false);
      setBranchesExpandedManual(false);
      return;
    }
    setBranchesResolved(false);
    branchAutoExpandedRef.current = false;
    vscode.postMessage({ type: 'getBranches', projects: prompt.projects });
  }, [prompt.projects]);

  // Auto-expand branch list on first resolve if mismatch detected
  useEffect(() => {
    if (shouldAutoExpandPromptBranchList({
      branchesResolved,
      hasBranchMismatch,
      branchesExpandedManual,
      autoExpanded: branchAutoExpandedRef.current,
    })) {
      branchAutoExpandedRef.current = true;
      setShowBranches(true);
    }
  }, [branchesExpandedManual, branchesResolved, hasBranchMismatch]);

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
    if (!projectInstructionsHeight) {
      return;
    }
    const currentState = (vscode.getState?.() || {}) as Record<string, unknown>;
    vscode.setState?.({ ...currentState, 'pm.editor.projectInstructionsHeight': projectInstructionsHeight });
    if (storage) {
      storage.setItem('pm.editor.projectInstructionsHeight', String(projectInstructionsHeight));
    }
  }, [projectInstructionsHeight, storage]);

  /** Current large-field heights that should travel with per-prompt editor view state. */
  const editorContentHeights = useMemo<EditorPromptContentHeights>(() => {
    const nextHeights: EditorPromptContentHeights = {};
    if (promptContentHeight) { nextHeights.promptContent = promptContentHeight; }
    if (reportHeight) { nextHeights.report = reportHeight; }
    if (globalContextHeight) { nextHeights.globalContext = globalContextHeight; }
    if (projectInstructionsHeight) { nextHeights.projectInstructions = projectInstructionsHeight; }
    return nextHeights;
  }, [globalContextHeight, projectInstructionsHeight, promptContentHeight, reportHeight]);

  useEffect(() => {
    const nextEditorViewState = normalizeEditorPromptViewState({
      activeTab,
      expandedSections,
      manualSectionOverrides,
      descriptionExpanded: isDescriptionExpanded,
      branchesExpanded: showBranches,
      branchesExpandedManual,
      contentHeights: editorContentHeights,
      sectionHeights,
    });
    editorViewStateRef.current = nextEditorViewState;
    const currentState = (vscode.getState?.() || {}) as Record<string, unknown>;
    vscode.setState?.({ ...currentState, 'pm.editor.viewState': nextEditorViewState });
    if (storage) {
      storage.setItem('pm.editor.viewState', JSON.stringify(nextEditorViewState));
    }
  }, [activeTab, branchesExpandedManual, editorContentHeights, expandedSections, manualSectionOverrides, isDescriptionExpanded, sectionHeights, showBranches, storage]);

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

  useEffect(() => {
    if (!projectInstructionsTextareaRef.current || typeof ResizeObserver === 'undefined') {
      return;
    }
    const textarea = projectInstructionsTextareaRef.current;
    const observer = new ResizeObserver(() => {
      const nextHeight = Math.round(textarea.getBoundingClientRect().height);
      if (nextHeight > 0) {
        setProjectInstructionsHeight(nextHeight);
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
      dispatchPromptSave(updatedPrompt, 'autosave', { clearDirty: true });
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
    const nextContent = appendRecognizedPromptText(promptRef.current.content, normalized);
    promptRef.current = { ...promptRef.current, content: nextContent };
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
    promptRef.current = { ...promptRef.current, [field]: value };
    setPrompt(prev => ({ ...prev, [field]: value }));
    if (field === 'report') {
      localReportDirtyRef.current = true;
    }
    if (field !== 'timeSpentWriting' && field !== 'timeSpentImplementing') {
      userChangeCounterRef.current++;
      setIsDirty(true);
      // Content field saves on blur, not on every keystroke
      if (field !== 'content') {
        scheduleAutoSave(1500);
      }
    }
  };

  /** Update a select/toggle field with near-immediate auto-save. */
  const updateFieldAndSaveNow = <K extends keyof Prompt>(field: K, value: Prompt[K]) => {
    promptRef.current = { ...promptRef.current, [field]: value };
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
    setGitOverlayBusyState('overlay:loading', t('editor.gitOverlayProcessLoading'), true);
    vscode.postMessage({
      type: 'openGitOverlay',
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
    });
  }, [logGitOverlayDebug, prompt.branch, prompt.id, prompt.projects, resetStartChatPreflightTracking, setGitOverlayBusyState, t]);

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
    const processLabel = mode === 'sync'
      ? t('editor.gitOverlayPullAllChanges')
      : t('editor.gitOverlayProcessRefreshState');

    setGitOverlayBusyState(`refresh:${mode}`, processLabel, true);
    vscode.postMessage({
      type: 'refreshGitOverlay',
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
      mode,
    });
  }, [prompt.branch, prompt.projects, setGitOverlayBusyState, t]);

  const handleGitOverlayHydrateProjectDetails = useCallback((projectName: string) => {
    const snapshotGeneratedAt = (gitOverlaySnapshot?.generatedAt || '').trim();
    const normalizedProjectName = projectName.trim();
    if (!snapshotGeneratedAt || !normalizedProjectName) {
      return;
    }

    const requestKey = `${snapshotGeneratedAt}:${normalizedProjectName}`;
    if (gitOverlayPendingProjectDetailsRef.current[requestKey]) {
      return;
    }

    gitOverlayPendingProjectDetailsRef.current[requestKey] = true;
    vscode.postMessage({
      type: 'gitOverlayHydrateProjectDetails',
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
      project: normalizedProjectName,
      snapshotGeneratedAt,
    });
  }, [gitOverlaySnapshot, prompt.branch, prompt.projects]);

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
    setGitOverlayBusyState('switchBranch:tracked', t('editor.gitOverlaySwitchAllToTracked'), true);
    vscode.postMessage({
      type: 'gitOverlaySwitchBranch',
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
      branch,
      trackedBranchesByProject: normalizedTrackedBranchesByProject,
    });
  }, [gitOverlayBusyAction, gitOverlayMode, logGitOverlayDebug, prompt.branch, prompt.projects, setGitOverlayBusyState, t]);

  const handleGitOverlayEnsurePromptBranch = useCallback((trackedBranchesByProject: Record<string, string>) => {
    const normalizedTrackedBranchesByProject = normalizeTrackedBranchesByProject(trackedBranchesByProject);
    const trackedBranch = resolveSingleTrackedBranch(normalizedTrackedBranchesByProject);
    setGitOverlayBusyState('ensurePromptBranch', t('editor.gitOverlayEnsurePromptBranch'), true);
    vscode.postMessage({
      type: 'gitOverlayEnsurePromptBranch',
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
      trackedBranch,
      trackedBranchesByProject: normalizedTrackedBranchesByProject,
    });
  }, [prompt.branch, prompt.projects, setGitOverlayBusyState, t]);

  const handleGitOverlayMergePromptBranch = useCallback((
    trackedBranchesByProject: Record<string, string>,
    stayOnTrackedBranch: boolean,
    projects?: string[],
  ) => {
    const normalizedTrackedBranchesByProject = normalizeTrackedBranchesByProject(trackedBranchesByProject);
    const trackedBranch = resolveSingleTrackedBranch(normalizedTrackedBranchesByProject);
    setGitOverlayBusyState('mergePromptBranch', t('editor.gitOverlayMergeNow'), true);
    vscode.postMessage({
      type: 'gitOverlayMergePromptBranch',
      promptBranch: prompt.branch.trim(),
      projects: (projects && projects.length > 0 ? projects : prompt.projects),
      trackedBranch,
      trackedBranchesByProject: normalizedTrackedBranchesByProject,
      stayOnTrackedBranch,
    });
  }, [prompt.branch, prompt.projects, setGitOverlayBusyState, t]);

  const handleGitOverlayApplyBranchTargets = useCallback((
    sourceBranchesByProject: Record<string, string>,
    targetBranchesByProject: Record<string, string>,
    project?: string,
  ) => {
    const normalizedSourceBranchesByProject = normalizeTrackedBranchesByProject(sourceBranchesByProject);
    const normalizedTargetBranchesByProject = normalizeTrackedBranchesByProject(targetBranchesByProject);
    setGitOverlayBusyState(
      project ? `applyBranchTargets:${project}` : 'applyBranchTargets:all',
      project ? `${t('editor.gitOverlaySwitch')}: ${project}` : t('editor.gitOverlaySwitchAll'),
      true,
    );
    vscode.postMessage({
      type: 'gitOverlayApplyBranchTargets',
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
      sourceBranchesByProject: normalizedSourceBranchesByProject,
      targetBranchesByProject: normalizedTargetBranchesByProject,
    });
  }, [prompt.branch, prompt.projects, setGitOverlayBusyState, t]);

  const handleGitOverlayDeleteBranch = useCallback((branch: string) => {
    setGitOverlayBusyState(`deleteBranch:${branch}`, `${t('editor.gitOverlayDeleteBranch')}: ${branch}`, true);
    vscode.postMessage({
      type: 'gitOverlayDeleteBranch',
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
      branch,
    });
  }, [prompt.branch, prompt.projects, setGitOverlayBusyState, t]);

  const handleGitOverlayPush = useCallback((branch?: string, projects?: string[]) => {
    setGitOverlayBusyState('pushPromptBranch', t('editor.gitOverlayPushPromptBranch'), true, 'push');
    vscode.postMessage({
      type: 'gitOverlayPush',
      promptBranch: prompt.branch.trim(),
      projects: (projects && projects.length > 0 ? projects : prompt.projects),
      branch,
    });
  }, [prompt.branch, prompt.projects, setGitOverlayBusyState, t]);

  const handleGitOverlayStageAll = useCallback((project?: string, trackedOnly?: boolean) => {
    setGitOverlayBusyState(
      project ? `stageAll:${project}` : (trackedOnly ? 'stageTracked:all' : 'stageAll:all'),
      trackedOnly ? t('editor.gitOverlayStageTracked') : t('editor.gitOverlayStageAll'),
      true,
    );
    vscode.postMessage({
      type: 'gitOverlayStageAll',
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
      project,
      trackedOnly,
    });
  }, [prompt.branch, prompt.projects, setGitOverlayBusyState, t]);

  const handleGitOverlayUnstageAll = useCallback((project?: string) => {
    setGitOverlayBusyState(project ? `unstageAll:${project}` : 'unstageAll:all', t('editor.gitOverlayUnstageAll'), true);
    vscode.postMessage({
      type: 'gitOverlayUnstageAll',
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
      project,
    });
  }, [prompt.branch, prompt.projects, setGitOverlayBusyState, t]);

  const handleGitOverlayStageFile = useCallback((project: string, filePath: string) => {
    setGitOverlayBusyState(
      `stageFile:${project}:${filePath}`,
      `${t('editor.gitOverlayStage')}: ${extractGitOverlayFileName(filePath)}`,
      true,
    );
    vscode.postMessage({
      type: 'gitOverlayStageFile',
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
      project,
      filePath,
    });
  }, [prompt.branch, prompt.projects, setGitOverlayBusyState, t]);

  const handleGitOverlayUnstageFile = useCallback((project: string, filePath: string) => {
    setGitOverlayBusyState(
      `unstageFile:${project}:${filePath}`,
      `${t('editor.gitOverlayUnstage')}: ${extractGitOverlayFileName(filePath)}`,
      true,
    );
    vscode.postMessage({
      type: 'gitOverlayUnstageFile',
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
      project,
      filePath,
    });
  }, [prompt.branch, prompt.projects, setGitOverlayBusyState, t]);

  const handleGitOverlayLoadFileHistory = useCallback((project: string, filePath: string) => {
    setGitOverlayBusyState(
      `fileHistory:${project}:${filePath}`,
      `${t('editor.gitOverlayFileHistory')}: ${extractGitOverlayFileName(filePath)}`,
    );
    vscode.postMessage({ type: 'gitOverlayLoadFileHistory', project, filePath });
  }, [setGitOverlayBusyState, t]);

  const handleGitOverlayOpenFile = useCallback((project: string, filePath: string) => {
    vscode.postMessage({ type: 'gitOverlayOpenFile', project, filePath });
  }, []);

  const handleGitOverlayOpenDiff = useCallback((project: string, filePath: string) => {
    vscode.postMessage({ type: 'gitOverlayOpenDiff', project, filePath });
  }, []);

  const handleGitOverlayDiscardFile = useCallback((project: string, filePath: string, group: GitOverlayChangeGroup, previousPath?: string) => {
    setGitOverlayBusyState(
      `discardFile:${project}:${group}:${filePath}`,
      `${t('editor.gitOverlayDiscardFile')}: ${extractGitOverlayFileName(filePath)}`,
      true,
    );
    vscode.postMessage({
      type: 'gitOverlayDiscardFile',
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
      project,
      filePath,
      previousPath,
      group,
    });
  }, [prompt.branch, prompt.projects, setGitOverlayBusyState, t]);

  const handleGitOverlayDiscardProjectChanges = useCallback((project: string, changes: GitOverlayChangeFile[]) => {
    setGitOverlayBusyState(`discardProject:${project}`, `${t('editor.gitOverlayDiscardProjectChanges')}: ${project}`, true);
    vscode.postMessage({
      type: 'gitOverlayDiscardProjectChanges',
      promptBranch: prompt.branch.trim(),
      projects: prompt.projects,
      project,
      changes,
    });
  }, [prompt.branch, prompt.projects, setGitOverlayBusyState, t]);

  const handleGitOverlayOpenMergeEditor = useCallback((project: string, filePath: string) => {
    vscode.postMessage({ type: 'gitOverlayOpenMergeEditor', project, filePath });
  }, []);

  const handleGitOverlayCommitMessageChange = useCallback((project: string, value: string) => {
    setGitOverlayCommitMessages((prev) => ({
      ...prev,
      [project]: value,
    }));
  }, []);

  const handleGitOverlayGenerateCommitMessage = useCallback((project?: string, projects?: string[], scope?: GitOverlayActionScope) => {
    const normalizedProjects = normalizeGitOverlayTrackedRequestProjects(
      Array.isArray(projects) && projects.length > 0
        ? projects
        : (project ? [project] : []),
    );

    if (normalizedProjects.length === 0) {
      return;
    }

    const busyAction = resolveGitOverlayBusyActionName(
      'generateCommitMessage',
      normalizedProjects.map(projectName => ({ project: projectName })),
      scope,
    );
    if (!busyAction) {
      return;
    }

    const requestId = createGitOverlayTrackedRequestId('generate');
    const processLabel = busyAction === 'generateCommitMessage:all'
      ? t('editor.gitOverlayGenerateAllCommitMessages')
      : `${t('editor.gitOverlayGenerateCommitMessage')}: ${normalizedProjects[0]}`;

    registerGitOverlayTrackedRequest({
      requestId,
      kind: 'generate',
      projects: normalizedProjects,
      action: busyAction,
      processLabel,
      holdUntilSnapshot: false,
      bulk: busyAction === 'generateCommitMessage:all',
      createdAt: Date.now(),
    });
    gitOverlayPendingCommitMessageGenerationRef.current = true;
    setGitOverlayBusyState(busyAction, processLabel, false);
    vscode.postMessage({
      type: 'gitOverlayGenerateCommitMessage',
      prompt: buildPromptForSave(),
      project: scope === 'single' ? normalizedProjects[0] : undefined,
      projects: normalizedProjects,
      includeAllChanges: true,
      requestId,
    });
  }, [buildPromptForSave, createGitOverlayTrackedRequestId, registerGitOverlayTrackedRequest, setGitOverlayBusyState, t]);

  const handleGitOverlayCommitStaged = useCallback((messages: GitOverlayProjectCommitMessage[], scope?: GitOverlayActionScope) => {
    const normalizedMessages = (messages || [])
      .map((item) => ({
        project: (item.project || '').trim(),
        message: (item.message || '').trim(),
      }))
      .filter(item => Boolean(item.project) && Boolean(item.message));

    if (normalizedMessages.length === 0) {
      return;
    }

    const busyAction = resolveGitOverlayBusyActionName('commitStaged', normalizedMessages, scope);
    if (!busyAction) {
      return;
    }

    const requestId = createGitOverlayTrackedRequestId('commit');
    const processLabel = busyAction === 'commitStaged:all'
      ? t('editor.gitOverlayCommitAll')
      : `${t('editor.gitOverlayCommitProject')}: ${normalizedMessages[0].project}`;

    registerGitOverlayTrackedRequest({
      requestId,
      kind: 'commit',
      projects: normalizeGitOverlayTrackedRequestProjects(normalizedMessages.map(item => item.project)),
      action: busyAction,
      processLabel,
      holdUntilSnapshot: true,
      bulk: busyAction === 'commitStaged:all',
      createdAt: Date.now(),
    });

    setGitOverlayBusyState(
      busyAction,
      processLabel,
      true,
    );
    vscode.postMessage({
      type: 'gitOverlayCommitStaged',
      prompt: buildPromptForSave(),
      messages: normalizedMessages,
      includeAllChanges: true,
      requestId,
    });
  }, [buildPromptForSave, createGitOverlayTrackedRequestId, registerGitOverlayTrackedRequest, setGitOverlayBusyState, t]);

  const handleGitOverlayCreateReviewRequest = useCallback((requests: GitOverlayProjectReviewRequestInput[], scope?: GitOverlayActionScope) => {
    const normalizedRequests = (requests || [])
      .map((item) => ({
        project: (item.project || '').trim(),
        targetBranch: (item.targetBranch || '').trim(),
        title: (item.title || '').trim(),
        draft: item.draft !== false,
        removeSourceBranch: item.removeSourceBranch === true,
      }))
      .filter(item => Boolean(item.project) && Boolean(item.targetBranch) && Boolean(item.title));

    if (normalizedRequests.length === 0) {
      return;
    }

    const busyAction = resolveGitOverlayBusyActionName('createReviewRequest', normalizedRequests, scope);
    if (!busyAction) {
      return;
    }

    setGitOverlayBusyState(
      busyAction,
      busyAction === 'createReviewRequest:all'
        ? t('editor.gitOverlayCreateAllReviewRequests')
        : t('editor.gitOverlayCreateReviewRequest').replace('{label}', 'MR/PR'),
      true,
    );
    vscode.postMessage({
      type: 'gitOverlayCreateReviewRequest',
      prompt: buildPromptForSave(),
      requests: normalizedRequests,
    });
  }, [buildPromptForSave, setGitOverlayBusyState, t]);

  const handleGitOverlayOpenReviewRequest = useCallback((url: string) => {
    vscode.postMessage({ type: 'gitOverlayOpenReviewRequest', url });
  }, []);

  const handleGitOverlaySetupReviewCli = useCallback((request: GitOverlayReviewCliSetupRequest) => {
    const normalizedProject = (request.project || '').trim();
    const normalizedHost = (request.host || '').trim();
    if (!normalizedProject || !normalizedHost || (request.cliCommand !== 'gh' && request.cliCommand !== 'glab')) {
      return;
    }

      logGitOverlayDebug('setupReviewCli.dispatched', {
        project: normalizedProject,
        cliCommand: request.cliCommand,
        host: normalizedHost,
        action: request.action,
      });

    vscode.postMessage({
      type: 'gitOverlaySetupReviewCli',
      request: {
        project: normalizedProject,
        cliCommand: request.cliCommand,
        host: normalizedHost,
        action: request.action,
      },
    });
    }, [logGitOverlayDebug]);

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

  const dispatchPromptSave = useCallback((
    updatedPrompt: Prompt,
    source: 'manual' | 'status-change' | 'autosave',
    options: { clearDirty?: boolean } = {},
  ) => {
    enqueueEditorViewStateSave({ prompt: updatedPrompt, reason: `before-save:${source}` });
    const requestId = crypto.randomUUID();
    saveStartCounterRef.current = userChangeCounterRef.current;
    activeSaveIdRef.current = (updatedPrompt.id || '__new__').trim() || '__new__';
    activeSaveRequestIdRef.current = requestId;
    activeSaveClearedDirtyRef.current = Boolean(options.clearDirty);
    setIsSaving(true);
    if (options.clearDirty) {
      setIsDirty(false);
    }
    vscode.postMessage({ type: 'savePrompt', prompt: updatedPrompt, source, requestId });
  }, [enqueueEditorViewStateSave]);

  const handleSave = (
    source: 'manual' | 'status-change' | 'autosave' | unknown = 'manual',
    promptOverride?: Prompt,
  ) => {
    const normalizedSource: 'manual' | 'status-change' | 'autosave' =
      source === 'status-change' || source === 'autosave' || source === 'manual'
        ? source
        : 'manual';
    const promptBase = promptOverride ?? promptRef.current;
    const updatedPrompt = buildPromptForSaveFrom(promptBase);

    if (promptOverride) {
      promptRef.current = updatedPrompt;
      setPrompt(updatedPrompt);
    }

    // First manual save unlocks auto-save for this prompt
    if (normalizedSource === 'manual' || normalizedSource === 'status-change') {
      hasBeenSavedRef.current = true;
    }

    if (autoSaveTimerRef.current) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }

    dispatchPromptSave(updatedPrompt, normalizedSource);
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
    logReportDebug('reset.save-dispatched', {
      promptId: nextPrompt.id || '__new__',
      reportLength: nextPrompt.report.length,
    });
    dispatchPromptSave(nextPrompt, 'manual', { clearDirty: true });
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
    const isPersisted = Boolean((latestPrompt.promptUuid || '').trim());
    const shouldForceRebindChat = latestPrompt.status === 'draft';
    if (
      startChatLockRef.current
      || isStartingChat
      || isGeneratingTitle
      || isGeneratingDescription
      || !isPersisted
      || !latestPrompt.content
      || (!shouldForceRebindChat && latestPrompt.chatSessionIds.length > 0)
    ) {
      return;
    }

    handleEditorTabChange('process');

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
    const updatedPrompt = buildPromptForStatusChange(status);
    promptRef.current = updatedPrompt;
    setPrompt(updatedPrompt);
    // For never-saved prompts, just mark dirty — don't trigger save
    if (!hasBeenSavedRef.current) {
      setIsDirty(true);
      return;
    }
    if (autoSaveTimerRef.current) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    dispatchPromptSave(updatedPrompt, 'status-change', { clearDirty: true });
  };

  const handleFooterMarkCompleted = () => {
    handleEditorTabChange('main');
    handleSetStatus('completed');
  };

  const handleStopChatAndSetStatus = () => {
    handleEditorTabChange('main');

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
      if (activeSaveClearedDirtyRef.current) {
        setIsDirty(true);
      }
      activeSaveIdRef.current = null;
      activeSaveRequestIdRef.current = null;
      activeSaveClearedDirtyRef.current = false;
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
      setBranchesExpandedManual(true);
      setShowBranches(!showBranches);
    }
  };

  const handleSwitchBranch = (branch: string) => {
    vscode.postMessage({ type: 'switchBranch', branch, projects: prompt.projects });
    setBranchesExpandedManual(true);
    setShowBranches(false);
  };

  const openActionLabel = `📝 ${t('editor.open')}`;
  const hasPlanContent = promptPlanState.exists && promptPlanState.content.trim().length > 0;
  const planPlaceholderState = resolvePromptPlanPlaceholderState({
    chatMode: prompt.chatMode,
    status: prompt.status,
    planExists: promptPlanState.exists,
    hasPlanContent,
  });
  const shouldAutoExpandPlanSection = planPlaceholderState === 'plan-mode';
  const effectiveExpandedSections = useMemo(
    () => resolvePromptEditorExpandedSections({
      expandedSections,
      manualSectionOverrides,
      hasNotesContent,
      hasPlanContent,
      shouldExpandPlanSection: shouldAutoExpandPlanSection,
      hasReportContent,
    }),
    [expandedSections, manualSectionOverrides, hasNotesContent, hasPlanContent, hasReportContent, shouldAutoExpandPlanSection],
  );

  const toggleSection = (key: EditorPromptSectionKey) => {
    const nextSectionState = togglePromptEditorSectionExpansion({
      key,
      effectiveExpandedSections,
      expandedSections,
      manualSectionOverrides,
	  hasNotesContent,
	  hasPlanContent,
	  hasReportContent,
    });

    setExpandedSections(nextSectionState.expandedSections);
    setManualSectionOverrides(nextSectionState.manualSectionOverrides);
  };

  const chatLaunchStepStates = resolvePromptChatLaunchStepStatesFromPhase(chatLaunchPhase);

  const chatContextAutoLoadDisplay = resolvePromptChatContextAutoLoadDisplay({
    enabled: globalContextAutoLoadEnabled,
    canLoadRemote: canLoadRemoteGlobalContext,
    source: globalContextSource,
    runtimeState: chatContextAutoLoadState,
  });
  const chatContextAutoLoadSummary = chatContextAutoLoadDisplay.kind === 'active'
    ? t('editor.chatLaunchAutoLoadStatusActive')
    : chatContextAutoLoadDisplay.kind === 'completed'
      ? t('editor.chatLaunchAutoLoadStatusCompleted')
      : chatContextAutoLoadDisplay.kind === 'fallback'
        ? t('editor.chatLaunchAutoLoadStatusFallback')
        : chatContextAutoLoadDisplay.kind === 'enabled'
          ? t('editor.chatLaunchAutoLoadStatusEnabled')
          : chatContextAutoLoadDisplay.kind === 'disabled-setting'
            ? t('editor.chatLaunchAutoLoadStatusDisabledSetting')
            : chatContextAutoLoadDisplay.kind === 'disabled-no-url'
              ? t('editor.chatLaunchAutoLoadStatusDisabledNoUrl')
              : t('editor.chatLaunchAutoLoadStatusDisabledManual');

  const chatLaunchSteps: Array<{ key: string; label: React.ReactNode; state: 'done' | 'active' | 'pending' }> = [
    {
      key: 'prepare',
      label: t('editor.chatLaunchStepPrepare'),
      state: chatLaunchStepStates.prepare,
    },
    {
      key: 'autoload',
      label: (
        <span style={styles.chatLaunchStepLabelSingleLine}>
          {`${t('editor.chatLaunchAutoLoadLabel')}: ${chatContextAutoLoadSummary}`}
        </span>
      ),
      state: chatLaunchAutoloadStepState,
    },
    {
      key: 'open',
      label: (
        <ChatLaunchOpenStepLabel
          label={t('editor.chatLaunchStepOpen')}
          modelName={selectedModelName}
        />
      ),
      state: chatLaunchStepStates.open,
    },
    {
      key: 'bind',
      label: t('editor.chatLaunchStepBind'),
      state: chatLaunchStepStates.bind,
    },
    {
      key: 'rename',
      label: t('editor.chatLaunchStepRename'),
      state: chatLaunchStepStates.rename,
    },
  ];
  const completedChatLaunchStepCount = chatLaunchSteps.filter((step) => step.state === 'done').length;

  useLayoutEffect(() => {
    const nextTrackingPrompt = {
      id: prompt.id,
      promptUuid: prompt.promptUuid,
    };
    if (!shouldResetPromptChatLaunchTracking(previousChatLaunchTrackingPromptRef.current, nextTrackingPrompt)) {
      previousChatLaunchTrackingPromptRef.current = nextTrackingPrompt;
      return;
    }

    previousChatLaunchTrackingPromptRef.current = nextTrackingPrompt;
    chatLaunchCompletionShownForKeyRef.current = rawChatLaunchPhase === 'ready';
    if (chatLaunchCompletionTimerRef.current !== null) {
      window.clearTimeout(chatLaunchCompletionTimerRef.current);
      chatLaunchCompletionTimerRef.current = null;
    }
    if (chatLaunchPhaseTimerRef.current !== null) {
      window.clearTimeout(chatLaunchPhaseTimerRef.current);
      chatLaunchPhaseTimerRef.current = null;
    }

    chatLaunchPhaseVisibleSinceRef.current = Date.now();
    setDisplayedChatLaunchPhase(resolvePromptChatLaunchInactivePhase(rawChatLaunchPhase));
    setChatLaunchCompletionHold(false);
    setChatLaunchRequestStarted(false);
    setChatLaunchRenameState('idle');
    setChatContextAutoLoadState('idle');
  }, [prompt.id, prompt.promptUuid, rawChatLaunchPhase]);

  useLayoutEffect(() => {
    const displayedPhaseIndex = PROMPT_CHAT_LAUNCH_PHASE_ORDER.indexOf(displayedChatLaunchPhase);
    const targetPhaseIndex = PROMPT_CHAT_LAUNCH_PHASE_ORDER.indexOf(rawChatLaunchPhase);

    if (chatLaunchPhaseTimerRef.current !== null) {
      window.clearTimeout(chatLaunchPhaseTimerRef.current);
      chatLaunchPhaseTimerRef.current = null;
    }

    if (prompt.status !== 'in-progress' || displayedPhaseIndex < 0 || targetPhaseIndex < 0) {
      const inactivePhase = resolvePromptChatLaunchInactivePhase(rawChatLaunchPhase);
      if (displayedChatLaunchPhase !== inactivePhase) {
        chatLaunchPhaseVisibleSinceRef.current = Date.now();
        setDisplayedChatLaunchPhase(inactivePhase);
      }
      return;
    }

    if (targetPhaseIndex < displayedPhaseIndex) {
      chatLaunchPhaseVisibleSinceRef.current = Date.now();
      setDisplayedChatLaunchPhase(rawChatLaunchPhase);
      return;
    }

    if (targetPhaseIndex === displayedPhaseIndex) {
      return;
    }

    const nextPhase = resolveNextPromptChatLaunchPhase(displayedChatLaunchPhase, rawChatLaunchPhase);
    const elapsedMs = Date.now() - chatLaunchPhaseVisibleSinceRef.current;
    const remainingMs = Math.max(0, CHAT_LAUNCH_MIN_PHASE_VISIBLE_MS - elapsedMs);
    const applyNextPhase = () => {
      chatLaunchPhaseVisibleSinceRef.current = Date.now();
      setDisplayedChatLaunchPhase(nextPhase);
      chatLaunchPhaseTimerRef.current = null;
    };

    if (remainingMs === 0) {
      applyNextPhase();
      return;
    }

    chatLaunchPhaseTimerRef.current = window.setTimeout(applyNextPhase, remainingMs);
  }, [displayedChatLaunchPhase, rawChatLaunchPhase, prompt.status]);

  useLayoutEffect(() => {
    const canTrackCompletion = prompt.status === 'in-progress';
    const launchCompleted = canTrackCompletion && displayedChatLaunchPhase === 'ready';
    const completionAlreadyShownForKey = chatLaunchCompletionShownForKeyRef.current;

    if (launchCompleted && !completionAlreadyShownForKey) {
      if (chatLaunchCompletionTimerRef.current !== null) {
        window.clearTimeout(chatLaunchCompletionTimerRef.current);
      }

      chatLaunchCompletionShownForKeyRef.current = true;
      setChatLaunchCompletionHold(true);
      chatLaunchCompletionTimerRef.current = window.setTimeout(() => {
        setChatLaunchCompletionHold(false);
        chatLaunchCompletionTimerRef.current = null;
      }, CHAT_LAUNCH_COMPLETION_HOLD_MS);
    } else if ((!canTrackCompletion || displayedChatLaunchPhase !== 'ready') && chatLaunchCompletionHold) {
      if (chatLaunchCompletionTimerRef.current !== null) {
        window.clearTimeout(chatLaunchCompletionTimerRef.current);
        chatLaunchCompletionTimerRef.current = null;
      }

      setChatLaunchCompletionHold(false);
    }

  }, [chatLaunchCompletionHold, displayedChatLaunchPhase, prompt.status]);

  useEffect(() => {
    if (!shouldShowChatLaunchBlock || chatLaunchPhase === 'ready') {
      setChatLaunchActivityFrame(0);
      return;
    }

    const intervalMs = chatLaunchPhase === 'prepare' || chatLaunchPhase === 'autoload' || chatLaunchPhase === 'opening'
      ? 220
      : 360;
    const timer = window.setInterval(() => {
      setChatLaunchActivityFrame(prev => (prev + 1) % 6);
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [chatLaunchPhase, shouldShowChatLaunchBlock]);

  useEffect(() => {
    return () => {
      if (chatLaunchCompletionTimerRef.current !== null) {
        window.clearTimeout(chatLaunchCompletionTimerRef.current);
        chatLaunchCompletionTimerRef.current = null;
      }
      if (chatLaunchPhaseTimerRef.current !== null) {
        window.clearTimeout(chatLaunchPhaseTimerRef.current);
        chatLaunchPhaseTimerRef.current = null;
      }
    };
  }, []);

  const shouldShowPromptSwitchPlaceholder = isPromptSwitchPlaceholderVisible && !isLoaded;
  const shouldShowProcessMemoryPlaceholder = shouldShowPromptSwitchPlaceholder
    && Boolean(normalizeEditorLayoutHeight(sectionHeights.memory));
  const shouldShowProcessPlanHydrationPlaceholder = isPromptPlanHydrating
    && activeTab === 'process'
    && isLoaded
    && !shouldShowPromptSwitchPlaceholder
    && Boolean(normalizeEditorLayoutHeight(sectionHeights.plan));

  /** Capture rendered section heights so the next prompt switch can reserve exact blank space. */
  useEffect(() => {
    if (!isLoaded || shouldShowPromptSwitchPlaceholder || typeof document === 'undefined') {
      return;
    }

    const scheduleMeasurementAfterSettle = (): boolean => {
      const delayMs = getSectionMeasurementResumeDelay();
      if (delayMs <= 0) {
        return false;
      }
      if (sectionMeasurementResumeTimerRef.current === null) {
        sectionMeasurementResumeTimerRef.current = window.setTimeout(() => {
          sectionMeasurementResumeTimerRef.current = null;
          collectSectionHeights();
        }, delayMs + 16);
      }
      return true;
    };

    const collectSectionHeights = () => {
      if (isPromptSwitchPlaceholderVisibleRef.current) {
        return;
      }
      if (scheduleMeasurementAfterSettle()) {
        return;
      }
      const nextHeights: EditorPromptSectionHeights = {};
      const sections = document.querySelectorAll<HTMLElement>('[data-pm-editor-section]');
      sections.forEach((section) => {
        if (isPromptSwitchPlaceholderVisibleRef.current
          || section.getAttribute('data-pm-editor-section-placeholder') === 'true') {
          return;
        }
        const sectionKey = section.getAttribute('data-pm-editor-section');
        if (!isEditorPromptSectionKey(sectionKey)) {
          return;
        }
        const height = normalizeEditorLayoutHeight(section.getBoundingClientRect().height);
        if (height) {
          nextHeights[sectionKey] = height;
        }
      });

      if (Object.keys(nextHeights).length === 0) {
        return;
      }
      setSectionHeights((previous) => {
        let changed = false;
        const merged: EditorPromptSectionHeights = { ...previous };
        for (const key of PROMPT_EDITOR_SECTION_KEYS) {
          const nextHeight = nextHeights[key];
          if (!nextHeight) {
            continue;
          }
          if (Math.abs((previous[key] || 0) - nextHeight) > 1) {
            merged[key] = nextHeight;
            changed = true;
          }
        }
        if (changed) {
          const serializedHeights = JSON.stringify(merged);
          if (serializedHeights !== lastLoggedSectionHeightsRef.current) {
            lastLoggedSectionHeightsRef.current = serializedHeights;
            postEditorDebugLog('editor-layout', 'sectionHeights.measured', {
              promptId: promptRef.current.id || '__new__',
              promptUuid: promptRef.current.promptUuid || '',
              activeTab,
              sectionHeights: merged,
              sectionCount: Object.keys(merged).length,
            });
          }
        }
        return changed ? merged : previous;
      });
    };

    collectSectionHeights();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(collectSectionHeights);
    document.querySelectorAll<HTMLElement>('[data-pm-editor-section]').forEach(section => observer.observe(section));
    return () => {
      observer.disconnect();
      if (sectionMeasurementResumeTimerRef.current !== null) {
        window.clearTimeout(sectionMeasurementResumeTimerRef.current);
        sectionMeasurementResumeTimerRef.current = null;
      }
    };
  }, [activeTab, effectiveExpandedSections, getSectionMeasurementResumeDelay, isLoaded, prompt.id, shouldShowPromptSwitchPlaceholder]);

  /** Render a transparent blank block with stable dimensions. */
  const renderBlankPlaceholderBlock = (
    key: string,
    width: React.CSSProperties['width'] = '100%',
    height: React.CSSProperties['height'] = '14px',
    extraStyle?: React.CSSProperties,
  ) => (
    <span
      key={key}
      aria-hidden="true"
      data-pm-editor-placeholder-block="true"
      style={{
        ...styles.blankPlaceholderBlock,
        width,
        height,
        ...extraStyle,
      }}
    />
  );

  /** Render blank label/control space matching a compact form field. */
  const renderBlankPlaceholderField = (key: string, width: React.CSSProperties['width'] = '100%') => (
    <div key={key} style={{ ...styles.blankPlaceholderField, width }}>
      {renderBlankPlaceholderBlock(`${key}-label`, '42%', '12px')}
      {renderBlankPlaceholderBlock(`${key}-control`, '100%', '32px')}
    </div>
  );

  /** Render empty header summary space with a fixed visual footprint. */
  const renderSectionSummaryPlaceholder = (key: EditorPromptSectionKey) => (
    <>
      {renderBlankPlaceholderBlock(`${key}-summary-a`, '96px', '20px', styles.sectionSummaryPlaceholderChip)}
      {renderBlankPlaceholderBlock(`${key}-summary-b`, '72px', '20px', styles.sectionSummaryPlaceholderChip)}
    </>
  );

  /** Render blank fixed-height content for each prompt editor section. */
  const renderSectionBlankPlaceholderBody = (key: EditorPromptSectionKey) => {
    const promptTextHeight = promptContentHeight ? `${promptContentHeight}px` : '260px';
    const reportEditorHeight = reportHeight ? `${reportHeight}px` : '280px';
    const globalTextHeight = globalContextHeight ? `${globalContextHeight}px` : '72px';
    const projectInstructionTextHeight = projectInstructionsHeight ? `${projectInstructionsHeight}px` : '72px';

    switch (key) {
      case 'basic':
        return (
          <div data-pm-editor-section-placeholder-body="basic" style={styles.blankPlaceholderStack}>
            <div style={styles.blankPlaceholderFieldRow}>
              {renderBlankPlaceholderField('basic-title')}
              {renderBlankPlaceholderBlock('basic-title-ai', '36px', '32px')}
            </div>
            <div style={styles.blankPlaceholderFieldRow}>
              {renderBlankPlaceholderField('basic-description')}
              {renderBlankPlaceholderBlock('basic-description-ai', '36px', '32px')}
            </div>
            {renderBlankPlaceholderBlock('basic-status', '100%', '34px')}
          </div>
        );
      case 'time':
        return (
          <div data-pm-editor-section-placeholder-body="time" style={styles.blankPlaceholderStack}>
            <div style={styles.blankPlaceholderFourCol}>
              {['writing', 'implementing', 'task', 'untracked'].map(item => renderBlankPlaceholderBlock(`time-${item}`, '100%', '54px'))}
            </div>
            {renderBlankPlaceholderBlock('time-controls', '48%', '30px')}
          </div>
        );
      case 'workspace':
        return (
          <div data-pm-editor-section-placeholder-body="workspace" style={styles.blankPlaceholderStack}>
            {renderBlankPlaceholderField('workspace-projects')}
            <div style={styles.blankPlaceholderTwoCol}>
              {renderBlankPlaceholderField('workspace-task')}
              {renderBlankPlaceholderField('workspace-branch')}
            </div>
          </div>
        );
      case 'prompt':
        return (
          <div data-pm-editor-section-placeholder-body="prompt" style={styles.blankPlaceholderStack}>
            <div style={styles.blankPlaceholderToolbarRow}>
              {renderBlankPlaceholderBlock('prompt-label', '120px', '14px')}
              {renderBlankPlaceholderBlock('prompt-actions', '46%', '24px')}
            </div>
            {renderBlankPlaceholderBlock('prompt-textarea', '100%', promptTextHeight, styles.blankPlaceholderTextarea)}
          </div>
        );
      case 'globalPrompt':
        return (
          <div data-pm-editor-section-placeholder-body="globalPrompt" style={styles.blankPlaceholderStack}>
            {renderBlankPlaceholderBlock('global-context', '100%', globalTextHeight, styles.blankPlaceholderTextarea)}
            {renderBlankPlaceholderBlock('project-instructions', '100%', projectInstructionTextHeight, styles.blankPlaceholderTextarea)}
          </div>
        );
      case 'tech':
      case 'integrations':
        return (
          <div data-pm-editor-section-placeholder-body={key} style={styles.blankPlaceholderStack}>
            {renderBlankPlaceholderField(`${key}-first`)}
            {renderBlankPlaceholderField(`${key}-second`)}
            {key === 'integrations' ? renderBlankPlaceholderField(`${key}-third`) : null}
          </div>
        );
      case 'agent':
        return (
          <div data-pm-editor-section-placeholder-body="agent" style={styles.blankPlaceholderTwoCol}>
            {renderBlankPlaceholderField('agent-model')}
            {renderBlankPlaceholderField('agent-mode')}
          </div>
        );
      case 'groups':
        return (
          <div data-pm-editor-section-placeholder-body="groups" style={styles.blankPlaceholderChipRow}>
            {renderBlankPlaceholderBlock('groups-a', '84px', '28px')}
            {renderBlankPlaceholderBlock('groups-b', '118px', '28px')}
            {renderBlankPlaceholderBlock('groups-c', '74px', '28px')}
          </div>
        );
      case 'files':
        return (
          <div data-pm-editor-section-placeholder-body="files" style={styles.blankPlaceholderCardGrid}>
            {renderBlankPlaceholderBlock('files-a', '100%', '196px', styles.blankPlaceholderCard)}
            {renderBlankPlaceholderBlock('files-b', '100%', '196px', styles.blankPlaceholderCard)}
          </div>
        );
      case 'notes':
        return (
          <div data-pm-editor-section-placeholder-body="notes" style={styles.blankPlaceholderStack}>
            {renderBlankPlaceholderBlock('notes-status', '40%', '22px')}
            {renderBlankPlaceholderBlock('notes-textarea', '100%', '144px', styles.blankPlaceholderTextarea)}
          </div>
        );
      case 'memory':
        return (
          <div data-pm-editor-section-placeholder-body="memory" style={styles.blankPlaceholderStack}>
            {renderBlankPlaceholderBlock('memory-row-a', '100%', '28px')}
            {renderBlankPlaceholderBlock('memory-row-b', '82%', '28px')}
            {renderBlankPlaceholderBlock('memory-row-c', '68%', '28px')}
          </div>
        );
      case 'plan':
        return renderBlankPlaceholderBlock('plan-content', '100%', '150px', styles.blankPlaceholderTextarea);
      case 'report':
        return (
          <div data-pm-editor-section-placeholder-body="report" style={styles.blankPlaceholderStack}>
            {renderBlankPlaceholderBlock('report-editor', '100%', reportEditorHeight, styles.blankPlaceholderTextarea)}
            {renderBlankPlaceholderField('report-http')}
          </div>
        );
      default:
        return (
          <div data-pm-editor-section-placeholder-body={key} style={styles.blankPlaceholderStack}>
            {renderBlankPlaceholderBlock(`${key}-line-a`, '100%', '28px')}
            {renderBlankPlaceholderBlock(`${key}-line-b`, '72%', '28px')}
          </div>
        );
    }
  };

  /** Resolve the best known section height for blank prompt-switch placeholders. */
  const resolveBlankPlaceholderSectionMinHeight = (key: EditorPromptSectionKey): number | undefined => {
    const savedHeight = normalizeEditorLayoutHeight(sectionHeights[key]);
    if (savedHeight) {
      return savedHeight;
    }

    const collapsedHeaderHeight = 42;
    if (!effectiveExpandedSections[key]) {
      return collapsedHeaderHeight;
    }

    switch (key) {
      case 'prompt':
        return collapsedHeaderHeight + 56 + (promptContentHeight || 260);
      case 'globalPrompt':
        return collapsedHeaderHeight + 46 + (globalContextHeight || 72) + (projectInstructionsHeight || 72);
      case 'report':
        return collapsedHeaderHeight + 72 + (reportHeight || 280);
      case 'files':
        return collapsedHeaderHeight + 232;
      case 'basic':
        return collapsedHeaderHeight + 150;
      case 'workspace':
        return collapsedHeaderHeight + 122;
      case 'time':
        return collapsedHeaderHeight + 108;
      case 'notes':
        return collapsedHeaderHeight + 198;
      case 'memory':
        return collapsedHeaderHeight + 112;
      case 'plan':
        return collapsedHeaderHeight + 184;
      default:
        return collapsedHeaderHeight + 104;
    }
  };

  const renderSection = (
    key: EditorPromptSectionKey,
    title: string,
    summaryItems: string[],
    content: React.ReactNode,
    headerActions?: React.ReactNode,
  ) => {
    const visibleItems = summaryItems.slice(0, 3);
    const hiddenCount = Math.max(0, summaryItems.length - visibleItems.length);
    const isExpanded = effectiveExpandedSections[key];
    const shouldShowSectionPlaceholder = shouldShowPromptSwitchPlaceholder
      || (key === 'plan' && shouldShowProcessPlanHydrationPlaceholder);
    const isContentVisible = isLoaded || shouldShowSectionPlaceholder;
    const savedSectionHeight = normalizeEditorLayoutHeight(sectionHeights[key]);
    const placeholderSectionHeight = shouldShowSectionPlaceholder
      ? resolveBlankPlaceholderSectionMinHeight(key)
      : undefined;
    const lockedSectionHeight = savedSectionHeight && (shouldShowSectionPlaceholder || (isPromptOpenLayoutSettling && isLoaded))
      ? savedSectionHeight
      : undefined;
    const fallbackPlaceholderMinHeight = !lockedSectionHeight ? placeholderSectionHeight : undefined;

    return (
      <section
        style={{
          ...styles.sectionCard,
          ...(fallbackPlaceholderMinHeight ? { minHeight: `${fallbackPlaceholderMinHeight}px` } : {}),
          ...(lockedSectionHeight ? {
            height: `${lockedSectionHeight}px`,
            minHeight: `${lockedSectionHeight}px`,
            maxHeight: `${lockedSectionHeight}px`,
            boxSizing: 'border-box' as const,
            overflow: 'hidden',
          } : {}),
        }}
        data-pm-editor-section={key}
        data-pm-editor-section-placeholder={shouldShowSectionPlaceholder ? 'true' : undefined}
      >
      <div
        style={{
          ...styles.sectionHeaderRow,
          ...(isExpanded ? styles.sectionHeaderRowExpanded : styles.sectionHeaderRowCollapsed),
        }}
      >
      <button
        type="button"
        style={styles.sectionHeaderBtn}
        onClick={() => toggleSection(key)}
        aria-expanded={isExpanded}
      >
        <span style={styles.sectionHeaderLeft}>
          <span style={styles.sectionArrow}>{isExpanded ? '▾' : '▸'}</span>
          <span style={styles.sectionTitle}>{title}</span>
        </span>
        <span
          style={{
            ...styles.sectionSummaryWrap,
            ...(isContentVisible ? styles.blockContentVisible : styles.blockContentHidden),
          }}
          data-pm-editor-summary-placeholder={shouldShowSectionPlaceholder ? 'true' : undefined}
        >
          {shouldShowSectionPlaceholder ? (
            renderSectionSummaryPlaceholder(key)
          ) : visibleItems.length > 0 ? (
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
      {headerActions ? (
        <div
          style={{
            ...styles.sectionHeaderActions,
            ...(isContentVisible ? styles.blockContentVisible : styles.blockContentHidden),
          }}
        >
          {shouldShowSectionPlaceholder
            ? renderBlankPlaceholderBlock(`${key}-header-action`, '78px', '24px')
            : headerActions}
        </div>
      ) : null}
      </div>
      {isExpanded && (
        <div style={styles.sectionBody}>
          <div
            style={{
              ...styles.sectionBodyContent,
              ...(isContentVisible ? styles.blockContentVisible : styles.blockContentHidden),
            }}
          >
            {shouldShowSectionPlaceholder ? renderSectionBlankPlaceholderBody(key) : content}
          </div>
        </div>
      )}
      </section>
    );
  };

  // ---- Memory section for the Process tab (uses renderSection) ----
  const showMemorySection = prompt.status !== 'draft' && chatMemorySummary !== null;
  const shouldRenderMemorySection = shouldShowProcessMemoryPlaceholder || showMemorySection;

  /** Format character count as a short human-readable label (e.g. "5.8k") */
  const formatChars = (count: number): string => {
    if (count >= 1000) {
      return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    }
    return String(count);
  };

  const memorySummary = useMemo(() => {
    if (!chatMemorySummary) { return []; }
    const chunks: string[] = [];
    if (chatMemorySummary.totalChars > 0) {
      chunks.push(`${formatChars(chatMemorySummary.totalChars)} ${t('editor.memoryBlockChars')}`);
    }
    if (chatMemorySummary.totals.attachedFilesCount > 0) {
      chunks.push(`${chatMemorySummary.totals.attachedFilesCount} ${t('editor.memoryBlockFiles').toLowerCase()}`);
    }
    if (chatMemorySummary.totals.describedFilesCount > 0) {
      chunks.push(`${chatMemorySummary.totals.describedFilesCount} ${t('editor.memoryBlockDescribedFiles').toLowerCase()}`);
    }
    if (chatMemorySummary.shortTermCommits > 0 || chatMemorySummary.longTermSummaries > 0) {
      chunks.push(`${chatMemorySummary.shortTermCommits + chatMemorySummary.longTermSummaries} ${t('editor.memoryBlockHistory').toLowerCase()}`);
    }
    return chunks;
  }, [chatMemorySummary, t]);

  const footerChatLaunchBlock = shouldShowChatLaunchBlock ? (
    <div style={styles.chatLaunchDock}>
      <section style={styles.chatLaunchCard} aria-live="polite">
        <div style={styles.chatLaunchTopRow}>
          <div style={styles.chatLaunchStatusRow}>
            <span style={styles.chatLaunchStatusDot} aria-hidden="true" />
            <span style={styles.chatLaunchStatusText}>{chatLaunchStateLabel}</span>
          </div>
          <div style={styles.chatLaunchTopMeta}>
            {chatLaunchPhase !== 'ready' ? (
              <div style={styles.chatLaunchActivity} aria-hidden="true">
                {Array.from({ length: 6 }, (_, index) => {
                  const isActive = index === chatLaunchActivityFrame;
                  const isTrailing = index === ((chatLaunchActivityFrame + 5) % 6);
                  return (
                    <span
                      key={`chat-launch-activity-${index}`}
                      style={{
                        ...styles.chatLaunchActivityBar,
                        ...(isActive
                          ? styles.chatLaunchActivityBarActive
                          : isTrailing
                            ? styles.chatLaunchActivityBarTrailing
                            : null),
                      }}
                    />
                  );
                })}
              </div>
            ) : null}
            <span
              style={{
                ...styles.chatLaunchProgressBadge,
                ...(chatLaunchPhase === 'ready'
                  ? styles.chatLaunchProgressBadgeDone
                  : styles.chatLaunchProgressBadgeActive),
              }}
            >
              {`${completedChatLaunchStepCount}/${chatLaunchSteps.length}`}
            </span>
          </div>
        </div>

        <div style={styles.chatLaunchBody}>
          <div style={styles.chatLaunchHeaderCopy}>
            <h3 style={styles.chatLaunchTitle}>{t('editor.chatLaunchTitle')}</h3>
            <p style={styles.chatLaunchDescription}>{chatLaunchDescription}</p>
          </div>

          <div style={styles.chatLaunchSteps}>
            {chatLaunchSteps.map((step, index) => (
              <div
                key={step.key}
                style={{
                  ...styles.chatLaunchStep,
                  ...(step.state === 'done'
                    ? styles.chatLaunchStepDone
                    : step.state === 'active'
                      ? styles.chatLaunchStepActive
                      : styles.chatLaunchStepPending),
                }}
              >
                <span style={styles.chatLaunchStepLine} aria-hidden="true">
                  {index < chatLaunchSteps.length - 1 ? <span style={styles.chatLaunchStepLineInner} /> : null}
                </span>
                <span
                  style={{
                    ...styles.chatLaunchStepMarker,
                    ...(step.state === 'done'
                      ? styles.chatLaunchStepMarkerDone
                      : step.state === 'active'
                        ? styles.chatLaunchStepMarkerActive
                        : styles.chatLaunchStepMarkerPending),
                  }}
                  aria-hidden="true"
                >
                  {step.state === 'done' ? '✓' : step.state === 'active' ? <span style={styles.chatLaunchStepLoader} /> : '•'}
                </span>
                <div style={styles.chatLaunchStepBody}>
                  <span style={styles.chatLaunchStepLabel}>{step.label}</span>
                  <span
                    style={{
                      ...styles.chatLaunchStepBadge,
                      ...(step.state === 'done'
                        ? styles.chatLaunchStepBadgeDone
                        : step.state === 'active'
                          ? styles.chatLaunchStepBadgeActive
                          : styles.chatLaunchStepBadgePending),
                    }}
                  >
                    {step.state === 'done'
                      ? t('editor.chatLaunchStepStateDone')
                      : step.state === 'active'
                        ? t('editor.chatLaunchStepStateActive')
                        : t('editor.chatLaunchStepStatePending')}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div
          style={{
            ...styles.chatLaunchHint,
            ...(chatLaunchPhase === 'ready' ? styles.chatLaunchHintDone : null),
          }}
        >
          {chatLaunchHint}
        </div>
      </section>
    </div>
  ) : null;

  return (
    <div style={styles.container}>
      <div style={styles.contentShell}>
        {/* Loading overlay — stays centered within the prompt form shell */}
        {showLoader && !isLoaded && (
          <div style={styles.loadingOverlay} data-pm-editor-loading-overlay="true">
            <div style={styles.loadingSpinner} />
          </div>
        )}

        {/* Header */}
        <div style={styles.header}>
          <h2
            style={{
              ...styles.headerTitle,
              ...((isLoaded || shouldShowPromptSwitchPlaceholder) ? styles.blockContentVisible : styles.blockContentHidden),
            }}
          >
            {shouldShowPromptSwitchPlaceholder
              ? renderBlankPlaceholderBlock('header-title', '52%', '18px', styles.headerTitlePlaceholder)
              : (prompt.title || prompt.id || t('editor.newPrompt'))}
          </h2>
          <div
            style={{
              ...styles.headerRight,
              ...(isLoaded ? styles.blockContentVisible : styles.blockContentHidden),
            }}
          >
            <span
              style={{
                ...styles.dirtyIndicator,
                ...(isDirty ? styles.blockContentVisible : styles.blockContentHidden),
              }}
            >● {t('editor.unsaved')}</span>
            <div style={styles.headerActionGroup}>
              <div style={styles.headerTabs} role="tablist" aria-label={t('editor.viewTabs')}>
                {EDITOR_PROMPT_TABS.map(tab => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tab}
                    style={{
                      ...styles.headerTabBtn,
                      ...(activeTab === tab ? styles.headerTabBtnActive : null),
                    }}
                    onClick={() => handleEditorTabChange(tab)}
                  >
                    {tab === 'main' ? t('editor.tabMain') : t('editor.tabProcess')}
                  </button>
                ))}
              </div>
              <button
                type="button"
                style={styles.headerIconBtn}
                onClick={handleOpenProjectInstructionsInEditor}
                title={t('editor.openProjectInstructionsTooltip')}
                aria-label={t('editor.openProjectInstructionsTooltip')}
              >
                <ProjectInstructionsIcon />
              </button>
              <button
                type="button"
                style={{
                  ...styles.headerIconBtn,
                  ...(!isPersistedPrompt ? styles.headerIconBtnDisabled : null),
                }}
                onClick={handleOpenPromptConfigInEditor}
                disabled={!isPersistedPrompt}
                title={t('editor.openConfigTooltip')}
                aria-label={t('editor.openConfigTooltip')}
              >
                <OpenFileIcon />
              </button>
            </div>
          </div>
        </div>

        <ProgressLine
          mode={editorProgressMode}
          modeAttributeName="data-pm-editor-progress"
          phaseAttributeName="data-pm-editor-progress-phase"
        />

        {/* Main content */}
        <div style={styles.body}>
          <div style={styles.formGrid}>
          {activeTab === 'main' ? (
            <>
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
                      {openActionLabel}
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
                      onBlur={() => { if (isDirty) { scheduleAutoSave(300); } }}
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
                    {canLoadRemoteGlobalContext && (!hasGlobalContext || isLoadingGlobalContext) ? (
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

              <div style={styles.field}>
                <div style={styles.promptFieldHeader}>
                  <div style={styles.promptFieldLabelRow}>
                    <label style={styles.label}>{t('editor.projectInstructions')}</label>
                  </div>
                  <div style={styles.promptFieldActions}>
                    <button
                      type="button"
                      style={styles.linkBtn}
                      onClick={handleOpenProjectInstructionsInEditor}
                      title={t('editor.openProjectInstructionsTooltip')}
                    >
                      {openActionLabel}
                    </button>
                  </div>
                </div>
                <textarea
                  ref={projectInstructionsTextareaRef}
                  value={projectInstructions}
                  onChange={e => {
                    persistProjectInstructions(e.target.value);
                  }}
                  placeholder={t('editor.projectInstructionsPlaceholder')}
                  rows={3}
                  style={{
                    ...styles.globalContextTextarea,
                    height: projectInstructionsHeight ? `${projectInstructionsHeight}px` : undefined,
                  }}
                />
                <span style={styles.varHint}>
                  {projectInstructionsExists
                    ? t('editor.projectInstructionsHint')
                    : t('editor.projectInstructionsMissingHint')}
                </span>
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

          {renderSection('groups', t('editor.groups'), groupsSummary, (
            <>
              <div style={styles.field}>
                <div style={styles.promptFieldHeader}>
                  <div style={styles.promptFieldLabelRow}>
                    <label style={styles.label}>{t('editor.groupsLabel')}</label>
                  </div>
                  <div style={styles.promptFieldActions}>
                    <button
                      type="button"
                      onClick={() => setShowCustomGroupsManager(true)}
                      style={styles.linkBtn}
                      title={t('editor.groupsManageTitle')}
                    >
                      {t('editor.groupsManage')}
                    </button>
                  </div>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  {customGroups.length === 0 && (
                    <span style={{ color: 'var(--vscode-descriptionForeground)', fontSize: 12 }}>
                      {t('editor.groupsEmptyHint')}
                    </span>
                  )}
                  {customGroups.map(group => {
                    const isSelected = (prompt.customGroupIds || []).includes(group.id);
                    return (
                      <button
                        key={group.id}
                        type="button"
                        onClick={() => {
                          const current = prompt.customGroupIds || [];
                          const next = isSelected
                            ? current.filter(id => id !== group.id)
                            : [...current, group.id];
                          updateFieldAndSaveNow('customGroupIds', next);
                        }}
                        style={{
                          ...styles.toggleBtn,
                          ...(isSelected ? styles.toggleBtnActive : {}),
                          borderLeft: `3px solid ${group.color || 'var(--vscode-charts-blue)'}`,
                        }}
                        title={group.name}
                      >
                        {isSelected ? '✓ ' : ''}{group.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          ))}

          {renderSection('files', 'Файлы', filesSummary, (
            <>
              <div style={styles.field}>
                <label style={styles.label}>{t('editor.contextFiles')}</label>
                <div style={styles.fileList}>
                  <div style={styles.fileGrid}>
                    {visibleContextFileCards.map((fileCard) => (
                      <ContextFileCard
                        key={fileCard.path}
                        file={fileCard}
                        onOpen={() => {
                          vscode.postMessage({ type: 'openFile', file: fileCard.path });
                        }}
                        onRemove={() => {
                          const normalizedPath = normalizeContextFileReference(fileCard.path);
                          const updated = dedupeContextFileReferences(prompt.contextFiles).filter(
                            existingPath => normalizeContextFileReference(existingPath) !== normalizedPath,
                          );
                          updateFieldAndSaveNow('contextFiles', updated);
                        }}
                      />
                    ))}
                    <button
                      type="button"
                      style={styles.fileActionCard}
                      onClick={() => {
                        vscode.postMessage({ type: 'pickFile' });
                      }}
                      title={t('editor.addFileHint')}
                    >
                      <span style={styles.fileActionGlyph}>＋</span>
                      <span style={styles.fileActionText}>
                        <span style={styles.fileActionTitle}>{t('editor.addFile')}</span>
                        <span style={styles.fileActionHint}>{t('editor.addFileHint')}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      style={styles.fileActionCard}
                      onClick={handlePasteContextFilesFromClipboard}
                      title={t('editor.clipboardTooltip')}
                    >
                      <span style={styles.fileActionGlyph}>📋</span>
                      <span style={styles.fileActionText}>
                        <span style={styles.fileActionTitle}>{t('editor.fromClipboard')}</span>
                        <span style={styles.fileActionHint}>{t('editor.fromClipboardHint')}</span>
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            </>
          ))}

            </>
          ) : (
            <>

            {renderSection('notes', t('editor.notes'), notesSummary, (
            <>
              {/* Show the prompt status first inside notes, matching the prompt list color contract. */}
              <div style={styles.notesStatusRow}>
                <span style={styles.notesStatusLabel}>{t('filter.status')}:</span>
                <PromptStatusText status={prompt.status} style={styles.notesStatusText} />
              </div>
              <div style={styles.field}>
              <label style={styles.label}>{t('editor.notes')}</label>
              <TextArea
                value={prompt.notes || ''}
                onChange={v => updateField('notes', v)}
                placeholder={t('editor.notesPlaceholder')}
                rows={6}
              />
              </div>
            </>
            ), (
              /* Keep the section title unchanged and surface the status as a right-side header action. */
              <PromptStatusText status={prompt.status} variant="badge" style={styles.sectionStatusText} />
            ))}

          {shouldRenderMemorySection ? renderSection('memory', t('editor.memoryBlockTitle'), memorySummary, (
            chatMemorySummary ? <ChatMemoryBlock summary={chatMemorySummary} /> : null
          )) : null}

          {(shouldShowPromptSwitchPlaceholder || shouldShowPlanSection) ? renderSection('plan', 'План', planSummary, (
            <>
              {hasPlanContent ? (
                <div style={styles.planRawContent} role="log" aria-live="polite" aria-atomic="false">
                  {planLineSegments.map((segment, segmentIndex) => (
                    <div
                      key={`plan-segment-${segment.lines[0]?.index ?? segmentIndex}`}
                      style={segment.highlighted ? styles.planRawHighlightedBlock : styles.planRawSegment}
                    >
                      {segment.lines.map((line) => (
                        <div key={`plan-line-${line.index}`} style={styles.planRawLine}>
							{line.text.length > 0 ? line.text : '\u00A0'}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
          ) : planPlaceholderState === 'plan-mode' ? (
            <div style={styles.planModeNotice} role="status" aria-live="polite">
              <span style={styles.planModeNoticeBadge}>PLAN</span>
              <span style={styles.planModeNoticeText}>{t('editor.planModeStarted')}</span>
            </div>
		      ) : planPlaceholderState === 'empty' ? (
                <div style={styles.planRawContentEmpty}>{t('editor.planEmpty')}</div>
              ) : (
                <div style={styles.planRawContentEmpty}>{t('editor.planMissing')}</div>
              )}
            </>
          ), hasPlanContent ? (
            <button
              type="button"
              style={styles.linkBtn}
              onClick={handleOpenPromptPlanInEditor}
              title={t('editor.open')}
            >
              {openActionLabel}
            </button>
          ) : null) : null}

          {renderSection('report', 'Отчет', reportSummary, (
            <>
              <div style={styles.field}>
                <label style={styles.label}>{t('editor.workResult')}</label>
                <RichTextEditor
                  key={`${prompt.id || '__new__'}:report`}
                  value={prompt.report || ''}
                  onChange={v => updateField('report', v)}
                  onDebug={logMainRichTextDebug}
                  autoModeKey={prompt.id}
                  autoResize
                  suspendAutoResize={shouldShowPromptSwitchPlaceholder || isPromptOpenLayoutSettling}
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
                    {openActionLabel}
                  </button>
                </div>
              </div>
            </>
          ))}

            </>
          )}
          </div>
        </div>

        {/* Footer */}
        <div style={{ ...styles.footerArea, ...(isLoaded ? styles.blockContentVisible : styles.blockContentHidden) }}>
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
          {activeTab === 'process' ? footerChatLaunchBlock : null}
          <ActionBar
            onSave={() => handleSave('manual')}
            onShowHistory={handleShowHistory}
            onStartChat={handleStartChat}
            onOpenChat={handleOpenChat}
            onOpenGitFlow={handleOpenGitOverlay}
            onMarkCompleted={handleFooterMarkCompleted}
            onMarkStopped={handleStopChatAndSetStatus}
            showStatusActions={prompt.status === 'in-progress'}
            showGitFlowAction={shouldShowFooterGitFlow}
            hasChatSession={hasChatSession}
            isChatPanelOpen={isChatPanelOpen}
            isSaving={isSaving}
            isStartingChat={isStartingChat}
            isOpeningChat={isOpeningChat}
            isGeneratingTitle={isGeneratingTitle}
            isGeneratingDescription={isGeneratingDescription}
            hasContent={!!prompt.content}
            isPersistedPrompt={isPersistedPrompt}
            status={prompt.status}
            activeTab={activeTab}
          />
        </div>
      </div>

      {gitOverlayOpen ? (
        <GitOverlay
          open={gitOverlayOpen}
          mode={gitOverlayMode}
          snapshot={gitOverlaySnapshot}
          commitMessages={gitOverlayCommitMessages}
          busyAction={gitOverlayBusyAction}
          waitingForSnapshotAction={gitOverlayWaitingForSnapshotAction}
          processLabel={gitOverlayProcessLabel}
          pendingCommitMessageGenerationProjects={gitOverlayPendingGenerateProjects}
          pendingCommitProjects={gitOverlayPendingCommitProjects}
          pendingBulkCommitMessageGeneration={gitOverlayHasPendingBulkGenerate}
          pendingBulkCommit={gitOverlayHasPendingBulkCommit}
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
          onHydrateProjectDetails={handleGitOverlayHydrateProjectDetails}
          onContinueStartChat={() => {
            const requestId = pendingGitOverlayStartChatRequestIdRef.current || createStartChatRequestId();
            closeGitOverlay();
            dispatchStartChat(requestId, { skipBranchMismatchCheck: true });
          }}
          onContinueOpenChat={() => {
            closeGitOverlay();
            handleOpenChatRef.current();
          }}
          onMarkCompletedInPlace={handleFooterMarkCompleted}
          onDone={(status) => {
            const donePersistence = resolveGitOverlayDonePersistence(status, promptRef.current.status);
            closeGitOverlay();
            if (donePersistence.source === 'status-change' && donePersistence.nextStatus) {
              handleSetStatus(donePersistence.nextStatus);
              return;
            }
            handleSave('manual');
          }}
          t={t}
        />
      ) : null}
      <CustomGroupsManagerModal
        open={showCustomGroupsManager}
        groups={customGroups}
        onClose={() => setShowCustomGroupsManager(false)}
        onSave={(groups) => {
          vscode.postMessage({ type: 'replaceCustomGroups', groups });
        }}
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
    position: 'relative',
    width: `${EDITOR_FORM_SHELL_WIDTH_PX}px`,
    maxWidth: '100%',
  },
  blockContentVisible: {
    visibility: 'visible',
  },
  blockContentHidden: {
    visibility: 'hidden',
  },
  blankPlaceholderBlock: {
    display: 'inline-block',
    flexShrink: 0,
    borderRadius: '4px',
    background: 'transparent',
    border: '1px solid transparent',
    boxSizing: 'border-box' as const,
  },
  headerTitlePlaceholder: {
    verticalAlign: 'middle',
  },
  sectionSummaryPlaceholderChip: {
    borderRadius: '999px',
  },
  blankPlaceholderStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    width: '100%',
  },
  blankPlaceholderField: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    minWidth: 0,
  },
  blankPlaceholderFieldRow: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: '8px',
    width: '100%',
  },
  blankPlaceholderTwoCol: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: '12px',
    width: '100%',
  },
  blankPlaceholderFourCol: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
    gap: '8px',
    width: '100%',
  },
  blankPlaceholderToolbarRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    width: '100%',
  },
  blankPlaceholderTextarea: {
    display: 'block',
    borderRadius: '4px',
    minHeight: '60px',
  },
  blankPlaceholderChipRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '8px',
    width: '100%',
  },
  blankPlaceholderCardGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: '12px',
    width: '100%',
  },
  blankPlaceholderCard: {
    borderRadius: '10px',
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'color-mix(in srgb, var(--vscode-editor-background) 82%, transparent)',
    backdropFilter: 'blur(2px)',
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
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    marginLeft: 'auto',
    flexShrink: 0,
  },
  headerActionGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  headerTabs: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '2px',
    padding: '2px',
    borderRadius: '8px',
    border: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-sideBar-background)',
  },
  headerTabBtn: {
    border: 'none',
    borderRadius: '6px',
    background: 'transparent',
    color: 'var(--vscode-descriptionForeground)',
    cursor: 'pointer',
    padding: '6px 12px',
    fontSize: '12px',
    fontWeight: 600,
    fontFamily: 'var(--vscode-font-family)',
    whiteSpace: 'nowrap',
  },
  headerTabBtnActive: {
    background: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
  },
  headerIconBtn: {
    width: '32px',
    height: '32px',
    padding: 0,
    border: '1px solid var(--vscode-button-border, transparent)',
    borderRadius: '6px',
    background: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '15px',
    lineHeight: 1,
    flexShrink: 0,
  },
  headerIconBtnDisabled: {
    opacity: 0.6,
    cursor: 'not-allowed',
  },
  dirtyIndicator: {
    color: 'var(--vscode-textLink-foreground)',
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
  footerArea: {
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    background: 'var(--vscode-editor-background)',
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
  chatLaunchDock: {
    flexShrink: 0,
    padding: '12px 20px 16px',
    background: 'var(--vscode-editor-background)',
  },
  chatLaunchCard: {
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '10px',
    padding: '14px 16px 16px',
    background: 'var(--vscode-editor-background)',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    boxShadow: PANEL_LEFT_ACCENT_SHADOW,
  },
  chatLaunchTopRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    paddingBottom: '10px',
    borderBottom: '1px solid var(--vscode-panel-border)',
  },
  chatLaunchStatusRow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
  },
  chatLaunchStatusDot: {
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    background: 'var(--vscode-progressBar-background, var(--vscode-textLink-foreground))',
    flexShrink: 0,
  },
  chatLaunchStatusText: {
    color: 'var(--vscode-foreground)',
    fontSize: '12px',
    fontWeight: 600,
  },
  chatLaunchTopMeta: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    flexShrink: 0,
  },
  chatLaunchActivity: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    flexShrink: 0,
  },
  chatLaunchActivityBar: {
    width: '10px',
    height: '4px',
    borderRadius: '999px',
    background: 'color-mix(in srgb, var(--vscode-descriptionForeground) 16%, transparent)',
    transition: 'background-color 0.18s ease, transform 0.18s ease',
  },
  chatLaunchActivityBarActive: {
    background: 'var(--vscode-progressBar-background, var(--vscode-textLink-foreground))',
    transform: 'scaleX(1.15)',
  },
  chatLaunchActivityBarTrailing: {
    background: 'color-mix(in srgb, var(--vscode-progressBar-background, var(--vscode-textLink-foreground)) 45%, transparent)',
  },
  chatLaunchProgressBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    borderRadius: '999px',
    minWidth: '50px',
    padding: '4px 10px',
    fontSize: '11px',
    fontWeight: 700,
    letterSpacing: '0.03em',
    border: '1px solid transparent',
  },
  chatLaunchProgressBadgeActive: {
    background: 'var(--vscode-badge-background)',
    color: 'var(--vscode-badge-foreground)',
  },
  chatLaunchProgressBadgeDone: {
    background: 'color-mix(in srgb, var(--vscode-testing-iconPassed) 16%, transparent)',
    borderColor: 'color-mix(in srgb, var(--vscode-testing-iconPassed) 40%, transparent)',
    color: 'var(--vscode-testing-iconPassed)',
  },
  chatLaunchBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
  },
  chatLaunchHeaderCopy: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    minWidth: 0,
  },
  chatLaunchTitle: {
    margin: 0,
    fontSize: '16px',
    fontWeight: 700,
    color: 'var(--vscode-foreground)',
  },
  chatLaunchDescription: {
    margin: 0,
    fontSize: '12px',
    lineHeight: 1.5,
    color: 'var(--vscode-descriptionForeground)',
  },
  chatLaunchSteps: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '10px',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '10px',
    background: 'var(--vscode-input-background, var(--vscode-editor-background))',
  },
  chatLaunchStep: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '12px',
    padding: '10px 12px',
    minHeight: '44px',
    position: 'relative',
    borderRadius: '8px',
    border: '1px solid transparent',
  },
  chatLaunchStepDone: {
    color: 'var(--vscode-foreground)',
    background: 'color-mix(in srgb, var(--vscode-testing-iconPassed) 10%, transparent)',
    borderColor: 'color-mix(in srgb, var(--vscode-testing-iconPassed) 24%, transparent)',
  },
  chatLaunchStepActive: {
    color: 'var(--vscode-foreground)',
    background: 'color-mix(in srgb, var(--vscode-progressBar-background, var(--vscode-textLink-foreground)) 10%, transparent)',
    borderColor: 'color-mix(in srgb, var(--vscode-progressBar-background, var(--vscode-textLink-foreground)) 28%, transparent)',
  },
  chatLaunchStepPending: {
    color: 'var(--vscode-descriptionForeground)',
    background: 'transparent',
    borderColor: 'color-mix(in srgb, var(--vscode-panel-border) 70%, transparent)',
  },
  chatLaunchStepLine: {
    position: 'relative',
    width: '12px',
    alignSelf: 'stretch',
    display: 'inline-flex',
    justifyContent: 'center',
    flexShrink: 0,
  },
  chatLaunchStepLineInner: {
    width: '1px',
    flex: 1,
    background: 'var(--vscode-panel-border)',
  },
  chatLaunchStepMarker: {
    width: '18px',
    height: '18px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    fontWeight: 700,
    borderRadius: '50%',
    boxSizing: 'border-box',
  },
  chatLaunchStepMarkerDone: {
    background: 'color-mix(in srgb, var(--vscode-testing-iconPassed) 16%, transparent)',
    border: '1px solid color-mix(in srgb, var(--vscode-testing-iconPassed) 40%, transparent)',
    color: 'var(--vscode-testing-iconPassed)',
  },
  chatLaunchStepMarkerActive: {
    background: 'color-mix(in srgb, var(--vscode-progressBar-background, var(--vscode-textLink-foreground)) 16%, transparent)',
    border: '1px solid color-mix(in srgb, var(--vscode-progressBar-background, var(--vscode-textLink-foreground)) 44%, transparent)',
    color: 'var(--vscode-progressBar-background, var(--vscode-textLink-foreground))',
  },
  chatLaunchStepMarkerPending: {
    background: 'transparent',
    border: '1px solid var(--vscode-panel-border)',
    color: 'var(--vscode-descriptionForeground)',
  },
  chatLaunchStepLoader: {
    width: '10px',
    height: '10px',
    border: '2px solid color-mix(in srgb, var(--vscode-progressBar-background, var(--vscode-textLink-foreground)) 30%, transparent)',
    borderTopColor: 'var(--vscode-progressBar-background, var(--vscode-textLink-foreground))',
    borderRadius: '50%',
    animation: 'pm-spin 0.8s linear infinite',
    boxSizing: 'border-box',
  },
  chatLaunchStepBody: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    flex: 1,
    minWidth: 0,
  },
  chatLaunchStepLabel: {
    fontSize: '12px',
    lineHeight: 1.4,
    color: 'inherit',
    minWidth: 0,
  },
  chatLaunchStepLabelSingleLine: {
    display: 'inline-block',
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  chatLaunchStepBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '3px 8px',
    borderRadius: '999px',
    fontSize: '10px',
    fontWeight: 700,
    letterSpacing: '0.03em',
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  chatLaunchStepBadgeDone: {
    background: 'color-mix(in srgb, var(--vscode-testing-iconPassed) 14%, transparent)',
    color: 'var(--vscode-testing-iconPassed)',
  },
  chatLaunchStepBadgeActive: {
    background: 'color-mix(in srgb, var(--vscode-progressBar-background, var(--vscode-textLink-foreground)) 14%, transparent)',
    color: 'var(--vscode-progressBar-background, var(--vscode-textLink-foreground))',
  },
  chatLaunchStepBadgePending: {
    background: 'color-mix(in srgb, var(--vscode-descriptionForeground) 10%, transparent)',
    color: 'var(--vscode-descriptionForeground)',
  },
  chatLaunchHint: {
    fontSize: '11px',
    lineHeight: 1.5,
    color: 'var(--vscode-descriptionForeground)',
    padding: '10px 12px',
    borderRadius: '8px',
    background: 'var(--vscode-editor-background)',
    border: '1px solid var(--vscode-panel-border)',
  },
  chatLaunchHintDone: {
    background: 'color-mix(in srgb, var(--vscode-testing-iconPassed) 10%, var(--vscode-editor-background))',
    borderColor: 'color-mix(in srgb, var(--vscode-testing-iconPassed) 22%, transparent)',
  },
  // ---- Memory section content styles (Process tab) ----
  memoryBlockContent: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  memoryBlockRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '8px',
  },
  memoryBlockRowLabel: {
    fontSize: '12px',
    fontWeight: 600,
    color: 'var(--vscode-descriptionForeground)',
    whiteSpace: 'nowrap',
    minWidth: '110px',
    paddingTop: '2px',
  },
  memoryBlockChips: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px',
  },
  memoryBlockChip: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: '4px',
    fontSize: '11px',
    lineHeight: 1.5,
    background: 'color-mix(in srgb, var(--vscode-foreground) 6%, transparent)',
    color: 'var(--vscode-foreground)',
    whiteSpace: 'nowrap',
  },
  sectionCard: {
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '6px',
    background: 'var(--vscode-editor-background)',
    overflow: 'visible',
    boxShadow: PANEL_LEFT_ACCENT_SHADOW,
  },
  sectionHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    paddingRight: '12px',
    background: 'var(--vscode-sideBar-background)',
    boxShadow: PANEL_LEFT_ACCENT_SHADOW,
    borderTopLeftRadius: '6px',
    borderTopRightRadius: '6px',
  },
  sectionHeaderRowExpanded: {
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
  },
  sectionHeaderRowCollapsed: {
    borderBottomLeftRadius: '6px',
    borderBottomRightRadius: '6px',
  },
  sectionHeaderBtn: {
    width: 'auto',
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '10px',
    border: 'none',
    background: 'transparent',
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
  sectionHeaderActions: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    flexShrink: 0,
  },
  sectionStatusText: {
    fontSize: '11px',
    fontWeight: 600,
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
  planRawContent: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: '12px 14px',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '6px',
    background: 'var(--vscode-sideBar-background)',
    color: 'var(--vscode-foreground)',
    fontFamily: 'var(--vscode-editor-font-family)',
    fontSize: '12px',
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
    overflow: 'visible',
  },
  planRawSegment: {
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
  },
  planRawHighlightedBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
    padding: '2px 0',
    borderRadius: '6px',
    background: 'var(--vscode-diffEditor-insertedLineBackground, var(--vscode-diffEditor-insertedTextBackground, rgba(46, 160, 67, 0.18)))',
    boxShadow: 'inset 3px 0 0 var(--vscode-charts-green, var(--vscode-terminal-ansiGreen))',
  },
  planRawLine: {
    padding: '1px 4px',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
  },
  planRawContentEmpty: {
    padding: '8px 10px',
    border: '1px dashed var(--vscode-panel-border)',
    borderRadius: '6px',
    color: 'var(--vscode-descriptionForeground)',
    fontSize: '12px',
  },
  planModeNotice: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '12px 14px',
    borderRadius: '10px',
    border: '1px solid color-mix(in srgb, var(--vscode-progressBar-background, var(--vscode-textLink-foreground)) 38%, transparent)',
    background: 'color-mix(in srgb, var(--vscode-progressBar-background, var(--vscode-textLink-foreground)) 16%, transparent)',
    boxShadow: 'inset 4px 0 0 var(--vscode-progressBar-background, var(--vscode-textLink-foreground))',
    color: 'var(--vscode-foreground)',
  },
  planModeNoticeBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    minWidth: '48px',
    padding: '4px 8px',
    borderRadius: '999px',
    background: 'var(--vscode-progressBar-background, var(--vscode-textLink-foreground))',
    color: 'var(--vscode-button-foreground, #ffffff)',
    fontSize: '11px',
    fontWeight: 800,
    letterSpacing: '0.08em',
  },
  planModeNoticeText: {
    fontSize: '12px',
    lineHeight: 1.5,
    fontWeight: 700,
    color: 'var(--vscode-foreground)',
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
  notesStatusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'wrap',
  },
  notesStatusLabel: {
    fontSize: '12px',
    fontWeight: 500,
    color: 'var(--vscode-descriptionForeground)',
  },
  notesStatusText: {
    fontSize: '12px',
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
    gap: '10px',
  },
  fileGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: '12px',
    alignItems: 'stretch',
  },
  fileActionCard: {
    minHeight: '196px',
    padding: '14px',
    borderRadius: '10px',
    border: '1px dashed var(--vscode-input-border, var(--vscode-panel-border))',
    background: 'color-mix(in srgb, var(--vscode-editor-background) 68%, var(--vscode-input-background))',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '16px',
    textAlign: 'left',
    fontFamily: 'var(--vscode-font-family)',
  },
  fileActionGlyph: {
    fontSize: '24px',
    lineHeight: 1,
    color: 'var(--vscode-textLink-foreground)',
  },
  fileActionText: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  fileActionTitle: {
    fontSize: '13px',
    lineHeight: 1.4,
    fontWeight: 600,
  },
  fileActionHint: {
    fontSize: '11px',
    lineHeight: 1.4,
    color: 'var(--vscode-descriptionForeground)',
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
