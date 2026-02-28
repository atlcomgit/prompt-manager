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
import type { Prompt, PromptStatus } from '../../types/prompt';
import { createDefaultPrompt } from '../../types/prompt';

const vscode = getVsCodeApi();

interface SelectOption {
  id: string;
  name: string;
  description?: string;
}

type SectionKey = 'basic' | 'workspace' | 'prompt' | 'globalPrompt' | 'report' | 'tech' | 'integrations' | 'agent' | 'files' | 'time';

const DEFAULT_EXPANDED_SECTIONS: Record<SectionKey, boolean> = {
  basic: true,
  workspace: false,
  prompt: true,
  globalPrompt: false,
  report: false,
  tech: false,
  integrations: false,
  agent: false,
  files: false,
  time: false,
};

export const EditorApp: React.FC = () => {
  const t = useT();
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
      const keys: Array<Exclude<SectionKey, 'agent' | 'files'>> = ['basic', 'workspace', 'prompt', 'globalPrompt', 'report', 'tech', 'integrations', 'time'];
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
  const [isChatPanelOpen, setIsChatPanelOpen] = useState(false);
  const [workspaceFolders, setWorkspaceFolders] = useState<string[]>([]);
  const [availableModels, setAvailableModels] = useState<SelectOption[]>([]);
  const [availableSkills, setAvailableSkills] = useState<SelectOption[]>([]);
  const [availableMcpTools, setAvailableMcpTools] = useState<SelectOption[]>([]);
  const [availableHooks, setAvailableHooks] = useState<SelectOption[]>([]);
  const [availableLanguages, setAvailableLanguages] = useState<SelectOption[]>([]);
  const [availableFrameworks, setAvailableFrameworks] = useState<SelectOption[]>([]);
  const [branches, setBranches] = useState<Array<{ name: string; current: boolean; project: string }>>([]);
  const [branchesResolved, setBranchesResolved] = useState(false);
  const [showBranches, setShowBranches] = useState(false);
  const [inlineSuggestion, setInlineSuggestion] = useState<string>('');
  const [inlineSuggestions, setInlineSuggestions] = useState<string[]>([]);
  const [autoCompleteEnabled, setAutoCompleteEnabled] = useState(false);
  const [requestSuggestionSignal, setRequestSuggestionSignal] = useState(0);
  const [isSuggestionLoading, setIsSuggestionLoading] = useState(false);
  const [isImprovingPromptText, setIsImprovingPromptText] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [templateVars, setTemplateVars] = useState<Record<string, string>>({});
  const [globalContext, setGlobalContext] = useState('');
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Record<SectionKey, boolean>>(() => readStoredExpandedSections());
  const [promptContentHeight, setPromptContentHeight] = useState<number | undefined>(() => readStoredHeight('pm.editor.promptContentHeight'));
  const [reportHeight, setReportHeight] = useState<number | undefined>(() => readStoredHeight('pm.editor.reportHeight'));
  const [globalContextHeight, setGlobalContextHeight] = useState<number | undefined>(() => readStoredHeight('pm.editor.globalContextHeight'));
  const startChatLockRef = useRef(false);
  const globalContextTextareaRef = useRef<HTMLTextAreaElement>(null);
  const saveTimeoutRef = useRef<number | null>(null);
  const currentPromptIdRef = useRef<string>('__new__');
  const activeSaveIdRef = useRef<string | null>(null);
  const recalcTriggeredForRef = useRef<string>('');

  // Auto-save refs
  const promptRef = useRef<Prompt>(prompt);
  const isSavingRef = useRef(false);
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

  const targetBranch = prompt.branch.trim();

  const shouldShowSwitchBranchBtn = useMemo(() => {
    if (!targetBranch || prompt.projects.length === 0 || !branchesResolved) {
      return false;
    }

    const currentByProject = new Map<string, string>();
    for (const branchInfo of branches) {
      if (branchInfo.current) {
        currentByProject.set(branchInfo.project, branchInfo.name);
      }
    }

    return prompt.projects.some(projectName => currentByProject.get(projectName) !== targetBranch);
  }, [targetBranch, prompt.projects, branches]);

  const sortedAvailableModels = useMemo(
    () => [...availableModels].sort((a, b) => `${a.name} ${a.id}`.localeCompare(`${b.name} ${b.id}`, 'ru', { sensitivity: 'base' })),
    [availableModels]
  );

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

  const selectedModelName = useMemo(() => {
    if (!prompt.model.trim()) {
      return '';
    }
    const selected = sortedAvailableModels.find(m => m.id === prompt.model.trim());
    if (selected) {
      return `${selected.name} (${selected.id})`;
    }
    return prompt.model.trim();
  }, [prompt.model, sortedAvailableModels]);

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

  const reportSummary = useMemo(() => {
    const chunks: string[] = [];
    const reportText = (prompt.report || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (reportText) chunks.push(`Результат: ${toShortText(reportText, 64)}`);
    return chunks;
  }, [prompt.report]);

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
    const totalMs = (prompt.timeSpentWriting || 0) + (prompt.timeSpentImplementing || 0) + (prompt.timeSpentUntracked || 0);
    const minutes = Math.round(totalMs / 60000);
    return minutes > 0 ? [`Всего: ${minutes} мин`] : [];
  }, [prompt.timeSpentWriting, prompt.timeSpentImplementing, prompt.timeSpentUntracked]);

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

  useEffect(() => {
    vscode.postMessage({ type: 'ready' });

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

    return () => clearInterval(interval);
  }, [prompt.id]);

  useEffect(() => {
    currentPromptIdRef.current = (prompt.id || '__new__').trim() || '__new__';
  }, [prompt.id]);

  // Keep refs in sync with state
  useEffect(() => { promptRef.current = prompt; }, [prompt]);
  useEffect(() => { isSavingRef.current = isSaving; }, [isSaving]);

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
        setIsLoaded(false);
        setIsChatPanelOpen(false);
        // Delay showing the loader so fast loads don't flash
        if (showLoaderTimerRef.current) { window.clearTimeout(showLoaderTimerRef.current); }
        showLoaderTimerRef.current = window.setTimeout(() => { setShowLoader(true); }, 300);
        break;
      case 'prompt':
        if (msg.prompt) {
          const incomingPromptId = (String(msg.prompt.id || '__new__').trim() || '__new__');
          const currentPromptId = (currentPromptIdRef.current || '__new__').trim() || '__new__';
          const activeSaveId = (activeSaveIdRef.current || '').trim();
          const reason: 'open' | 'save' | 'sync' | undefined = msg.reason;
          const isOpenPayload = reason === 'open';
          const isNewPromptSaveResponse = currentPromptId === '__new__' && reason === 'save';
          const isRelatedToCurrentPrompt = incomingPromptId === currentPromptId || (activeSaveId !== '' && incomingPromptId === activeSaveId) || isNewPromptSaveResponse;

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
            setPrompt(msg.prompt);
            currentPromptIdRef.current = incomingPromptId;
            hasBeenSavedRef.current = Boolean(msg.prompt.id);
            userChangeCounterRef.current = 0;
            saveStartCounterRef.current = 0;
            setIsDirty(false);
            setIsLoaded(true);
            setIsSaving(false);
            activeSaveIdRef.current = null;
            if ((msg.prompt.chatSessionIds || []).length > 0) {
              startChatLockRef.current = false;
              setIsStartingChat(false);
              const pid = String(msg.prompt.id || '').trim();
              if (pid && recalcTriggeredForRef.current !== pid) {
                recalcTriggeredForRef.current = pid;
                vscode.postMessage({ type: 'recalcImplementingTime', id: pid });
                setIsRecalculating(true);
              }
            }
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
              timeSpentUntracked: Math.max(msg.prompt.timeSpentUntracked || 0, prev.timeSpentUntracked || 0),
              updatedAt: msg.prompt.updatedAt || prev.updatedAt,
              status: msg.prompt.status || prev.status,
              // Merge report only if user hasn't written one yet
              report: (prev.report || '').trim() ? prev.report : (msg.prompt.report || prev.report),
            }));
            // Don't touch isDirty — user's pending edits stay intact
            if ((msg.prompt.chatSessionIds || []).length > 0) {
              startChatLockRef.current = false;
              setIsStartingChat(false);
            }
            break;
          }

          const userChangedAfterSave = userChangeCounterRef.current !== saveStartCounterRef.current;
          const shouldMergeAfterSave = reason === 'save' && userChangedAfterSave && saveStartCounterRef.current > 0;
          if (shouldMergeAfterSave) {
            // User changed something after save started — merge only server-generated fields, keep user edits
            setPrompt(prev => ({
              ...prev,
              id: msg.prompt.id || prev.id,
              title: prev.title || msg.prompt.title,
              description: prev.description || msg.prompt.description,
              updatedAt: msg.prompt.updatedAt,
              chatSessionIds: msg.prompt.chatSessionIds || prev.chatSessionIds,
            }));
            // Keep isDirty = true so next auto-save picks up user's changes
          } else {
            setPrompt(msg.prompt);
            setIsDirty(false);
          }
          // Update currentPromptIdRef when backend assigns a real ID to a new prompt
          if (incomingPromptId !== currentPromptId && incomingPromptId !== '__new__') {
            currentPromptIdRef.current = incomingPromptId;
          }
          setIsLoaded(true);
          setIsSaving(false);
          activeSaveIdRef.current = null;
          if ((msg.prompt.chatSessionIds || []).length > 0) {
            startChatLockRef.current = false;
            setIsStartingChat(false);
            // Auto-recalc implementing time on first load
            const pid = String(msg.prompt.id || '').trim();
            if (pid && recalcTriggeredForRef.current !== pid) {
              recalcTriggeredForRef.current = pid;
              vscode.postMessage({ type: 'recalcImplementingTime', id: pid });
              setIsRecalculating(true);
            }
          }
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
          const writingDeltaMs = Number.isFinite(msg.writingDeltaMs) ? Math.max(0, Number(msg.writingDeltaMs)) : 0;
          if (prev.content === nextContent) {
            if (writingDeltaMs <= 0) {
              return prev;
            }
            return { ...prev, timeSpentWriting: (prev.timeSpentWriting || 0) + writingDeltaMs };
          }
          return {
            ...prev,
            content: nextContent,
            timeSpentWriting: (prev.timeSpentWriting || 0) + writingDeltaMs,
          };
        });
        openedAtRef.current = Date.now();
        break;
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
      case 'globalContext':
        setGlobalContext(msg.context || '');
        break;
      case 'chatStarted':
        startChatLockRef.current = false;
        setIsStartingChat(false);
        break;
      case 'chatOpened':
        startChatLockRef.current = false;
        setIsStartingChat(false);
        setIsChatPanelOpen(true);
        break;
      case 'generatedTitle':
        setPrompt(prev => ({ ...prev, title: msg.title }));
        userChangeCounterRef.current++;
        setIsDirty(true);
        scheduleAutoSave(50);
        break;
      case 'generatedDescription':
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
          const writingDeltaMs = Math.max(0, Date.now() - openedAtRef.current);
          const updatedPrompt: Prompt = {
            ...prev,
            content: msg.content || prev.content,
            timeSpentWriting: (prev.timeSpentWriting || 0) + writingDeltaMs,
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
        // Could show inline error
        startChatLockRef.current = false;
        setIsStartingChat(false);
        setIsSaving(false);
        setIsImprovingPromptText(false);
        setIsRecalculating(false);
        activeSaveIdRef.current = null;
        break;
      case 'info':
        // Could show inline info
        break;
      case 'implementingTimeRecalculated':
        setIsRecalculating(false);
        break;
    }
  }, []);

  useMessageListener(handleMessage);

  // Notify extension about dirty state changes
  useEffect(() => {
    vscode.postMessage({ type: 'markDirty', dirty: isDirty, prompt: isDirty ? prompt : undefined, promptId: currentPromptIdRef.current || '' });
  }, [isDirty, prompt]);

  useEffect(() => {
    if (!targetBranch || prompt.projects.length === 0) {
      setBranchesResolved(false);
      setBranches([]);
      setShowBranches(false);
      return;
    }
    setBranchesResolved(false);
    vscode.postMessage({ type: 'getBranches', projects: prompt.projects });
  }, [targetBranch, prompt.projects]);

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
      const updatedPrompt: Prompt = {
        ...currentPrompt,
        timeSpentWriting: currentPrompt.timeSpentWriting + timeSpent,
      };
      openedAtRef.current = Date.now();
      saveStartCounterRef.current = userChangeCounterRef.current;
      activeSaveIdRef.current = (updatedPrompt.id || '__new__').trim() || '__new__';
      setIsSaving(true);
      setIsDirty(false);
      vscode.postMessage({ type: 'savePrompt', prompt: updatedPrompt, source: 'autosave' });
    }, delayMs);
  };

  /** Update a text field with debounced auto-save (1.5 s). */
  const updateField = <K extends keyof Prompt>(field: K, value: Prompt[K]) => {
    setPrompt(prev => ({ ...prev, [field]: value }));
    if (field !== 'timeSpentWriting' && field !== 'timeSpentImplementing') {
      userChangeCounterRef.current++;
      setIsDirty(true);
      scheduleAutoSave(1500);
    }
  };

  /** Update a select/toggle field with near-immediate auto-save. */
  const updateFieldAndSaveNow = <K extends keyof Prompt>(field: K, value: Prompt[K]) => {
    setPrompt(prev => ({ ...prev, [field]: value }));
    if (field !== 'timeSpentWriting' && field !== 'timeSpentImplementing') {
      userChangeCounterRef.current++;
      setIsDirty(true);
      scheduleAutoSave(50);
    }
  };

  const buildPromptForSave = (): Prompt => {
    // Track writing time
    const timeSpent = Date.now() - openedAtRef.current;
    const updatedPrompt: Prompt = {
      ...prompt,
      timeSpentWriting: prompt.timeSpentWriting + timeSpent,
    };
    openedAtRef.current = Date.now();
    return updatedPrompt;
  };

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

  const handleStartChat = () => {
    if (startChatLockRef.current || isStartingChat || !prompt.content || prompt.chatSessionIds.length > 0) {
      return;
    }
    hasBeenSavedRef.current = true;
    // Set status to in-progress immediately — both locally and in the payload sent to backend.
    // This prevents the status from reverting to draft if the user switches prompts before
    // the backend's startChat handler finishes and sends a sync message.
    const updatedPrompt = { ...buildPromptForSave(), status: 'in-progress' as const };
    setPrompt(prev => ({ ...prev, status: 'in-progress' }));
    startChatLockRef.current = true;
    setIsStartingChat(true);
    activeSaveIdRef.current = (updatedPrompt.id || prompt.id || '__new__').trim() || '__new__';
    setIsSaving(true);
    vscode.postMessage({ type: 'savePrompt', prompt: updatedPrompt, source: 'autosave' });
    vscode.postMessage({ type: 'startChat', id: updatedPrompt.id || '__new__', prompt: updatedPrompt });
  };

  const handleOpenChat = () => {
    if (prompt.id && prompt.chatSessionIds.length > 0) {
      vscode.postMessage({ type: 'openChat', id: prompt.id, sessionId: prompt.chatSessionIds[0] });
    } else {
      // Chat was opened but session ID not yet tracked — just switch to chat panel
      vscode.postMessage({ type: 'openChatPanel' });
    }
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
    if (prompt.content) {
      vscode.postMessage({ type: 'generateTitle', content: prompt.content });
    }
  };

  const handleGenerateDescription = () => {
    if (prompt.content) {
      vscode.postMessage({ type: 'generateDescription', content: prompt.content });
    }
  };

  const handleImprovePromptText = () => {
    const content = prompt.content.trim();
    if (!content || isImprovingPromptText) {
      return;
    }
    setIsImprovingPromptText(true);
    vscode.postMessage({ type: 'improvePromptText', content, projects: prompt.projects });
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
        <span style={styles.sectionSummaryWrap}>
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
      {expandedSections[key] && <div style={styles.sectionBody}>{content}</div>}
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

      {/* Header */}
      <div style={styles.header}>
        <h2 style={styles.headerTitle}>
          {prompt.title || prompt.id || t('editor.newPrompt')}
        </h2>
        {isDirty && <span style={styles.dirtyIndicator}>● {t('editor.unsaved')}</span>}
      </div>

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
                <button style={styles.aiBtn} onClick={handleGenerateTitle} title={t('editor.aiGenerate')}>
                  ✨
                </button>
              </div>

              <div style={styles.fieldRow}>
                <TextField
                  label={t('editor.description')}
                  value={prompt.description}
                  onChange={v => updateField('description', v)}
                  placeholder={t('editor.descPlaceholder')}
                />
                <button style={styles.aiBtn} onClick={handleGenerateDescription} title={t('editor.aiGenerate')}>
                  ✨
                </button>
              </div>

              <StatusSelect
                value={prompt.status}
                onChange={v => handleSetStatus(v as PromptStatus)}
              />
            </>
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
                  {branches.map((b, i) => (
                    <button
                      key={`${b.project}-${b.name}-${i}`}
                      style={{
                        ...styles.branchItem,
                        ...(b.current ? styles.branchItemCurrent : {}),
                        ...(b.name === prompt.branch ? styles.branchItemSelected : {}),
                      }}
                      onClick={() => handleSwitchBranch(b.name)}
                    >
                      <span>{b.current ? '● ' : '○ '}{b.name}</span>
                      <span style={styles.branchProject}>{b.project}</span>
                    </button>
                  ))}
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
                  </div>
                </div>
                {showPreview ? (
                  <div
                    style={styles.previewPane}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(prompt.content) }}
                  />
                ) : (
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
                  />
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

          {renderSection('globalPrompt', 'Общий промпт', globalPromptSummary, (
            <>
              <div style={styles.field}>
                <label style={styles.label}>{t('editor.globalContext')}</label>
                <textarea
                  ref={globalContextTextareaRef}
                  value={globalContext}
                  onChange={e => {
                    setGlobalContext(e.target.value);
                    vscode.postMessage({ type: 'saveGlobalContext', context: e.target.value });
                  }}
                  placeholder={t('editor.globalContextPlaceholder')}
                  rows={3}
                  style={{
                    ...styles.globalContextTextarea,
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
              <div style={styles.field}>
                <label style={styles.label}>{t('editor.aiModel')}</label>
                <select
                  value={prompt.model}
                  onChange={e => updateFieldAndSaveNow('model', e.target.value)}
                  style={styles.select}
                >
                  <option value="">{t('common.auto')}</option>
                  {sortedAvailableModels.map(m => (
                    <option key={m.id} value={m.id}>{`${m.name} (${m.id})`}</option>
                  ))}
                </select>
              </div>

              <div style={styles.field}>
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
                  placeholder={t('editor.reportPlaceholder')}
                  persistedHeight={reportHeight}
                  onHeightChange={setReportHeight}
                  canReset={Boolean((prompt.report || '').trim())}
                  onReset={() => updateField('report', '')}
                />
              </div>
            </>
          ))}

          {renderSection('time', 'Учёт времени', timeSummary, (
            <TimerDisplay
              timeWriting={prompt.timeSpentWriting}
              timeImplementing={prompt.timeSpentImplementing}
              timeUntracked={prompt.timeSpentUntracked || 0}
              onUntrackedChange={(ms) => updateField('timeSpentUntracked', ms)}
              hasChatSessions={prompt.chatSessionIds.length > 0}
              isRecalculating={isRecalculating}
              onRecalcImplementingTime={handleRecalcImplementingTime}
            />
          ))}
        </div>
      </div>

      {/* Action bar */}
      <ActionBar
        onSave={() => handleSave('manual')}
        onShowHistory={handleShowHistory}
        onStartChat={handleStartChat}
        onOpenChat={handleOpenChat}
        onMarkCompleted={() => handleSetStatus('completed')}
        onMarkStopped={() => handleSetStatus('stopped')}
        showStatusActions={prompt.status === 'in-progress'}
        hasChatSession={prompt.chatSessionIds.length > 0}
        isChatPanelOpen={isChatPanelOpen}
        isDirty={isDirty}
        isSaving={isSaving}
        isStartingChat={isStartingChat}
        hasContent={!!prompt.content}
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
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: '840px',
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
  body: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px 20px',
  },
  formGrid: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    maxWidth: '800px',
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
  fieldRow: {
    display: 'flex',
    gap: '8px',
    alignItems: 'flex-end',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  label: {
    fontSize: '12px',
    fontWeight: 500,
    color: 'var(--vscode-foreground)',
    marginBottom: '2px',
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
  linkBtnDisabled: {
    opacity: 0.6,
    cursor: 'not-allowed',
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
};
