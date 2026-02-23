/**
 * Editor App — Main component for prompt configuration form
 */

import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { getVsCodeApi } from '../shared/vscodeApi';
import { useMessageListener } from '../shared/useMessageListener';
import { useT } from '../shared/i18n';
import { TextField } from './components/TextField';
import { TextArea } from './components/TextArea';
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

export const EditorApp: React.FC = () => {
  const t = useT();
  const [prompt, setPrompt] = useState<Prompt>(createDefaultPrompt());
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isStartingChat, setIsStartingChat] = useState(false);
  const [workspaceFolders, setWorkspaceFolders] = useState<string[]>([]);
  const [availableModels, setAvailableModels] = useState<SelectOption[]>([]);
  const [availableSkills, setAvailableSkills] = useState<SelectOption[]>([]);
  const [availableMcpTools, setAvailableMcpTools] = useState<SelectOption[]>([]);
  const [availableHooks, setAvailableHooks] = useState<SelectOption[]>([]);
  const [availableLanguages, setAvailableLanguages] = useState<SelectOption[]>([]);
  const [availableFrameworks, setAvailableFrameworks] = useState<SelectOption[]>([]);
  const [branches, setBranches] = useState<Array<{ name: string; current: boolean; project: string }>>([]);
  const [showBranches, setShowBranches] = useState(false);
  const [inlineSuggestion, setInlineSuggestion] = useState<string>('');
  const [inlineSuggestions, setInlineSuggestions] = useState<string[]>([]);
  const [autoCompleteEnabled, setAutoCompleteEnabled] = useState(true);
  const [showPreview, setShowPreview] = useState(false);
  const [templateVars, setTemplateVars] = useState<Record<string, string>>({});
  const [globalContext, setGlobalContext] = useState('');
  const startChatLockRef = useRef(false);

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

  const handleMessage = useCallback((msg: any) => {
    switch (msg.type) {
      case 'prompt':
        if (msg.prompt) {
          setPrompt(msg.prompt);
          setIsDirty(false);
          if ((msg.prompt.chatSessionIds || []).length > 0) {
            startChatLockRef.current = false;
            setIsStartingChat(false);
          }
        }
        break;
      case 'promptSaved':
        setIsSaving(false);
        setIsDirty(false);
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
        // Chat was opened — UI can show indicator if needed
        break;
      case 'generatedTitle':
        setPrompt(prev => ({ ...prev, title: msg.title }));
        setIsDirty(true);
        break;
      case 'generatedDescription':
        setPrompt(prev => ({ ...prev, description: msg.description }));
        setIsDirty(true);
        break;
      case 'generatedSlug':
        setPrompt(prev => ({ ...prev, id: msg.slug }));
        setIsDirty(true);
        break;
      case 'pickedFiles':
        if (msg.files && msg.files.length > 0) {
          setPrompt(prev => ({
            ...prev,
            contextFiles: [...prev.contextFiles, ...msg.files],
          }));
          setIsDirty(true);
        }
        break;
      case 'branches':
        setBranches(msg.branches);
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
        break;
      case 'info':
        // Could show inline info
        break;
    }
  }, []);

  useMessageListener(handleMessage);

  // Notify extension about dirty state changes
  useEffect(() => {
    vscode.postMessage({ type: 'markDirty', dirty: isDirty, prompt: isDirty ? prompt : undefined });
  }, [isDirty, prompt]);

  // Warn about unsaved changes when closing the tab
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  const updateField = <K extends keyof Prompt>(field: K, value: Prompt[K]) => {
    setPrompt(prev => ({ ...prev, [field]: value }));
    if (field !== 'timeSpentWriting' && field !== 'timeSpentImplementing') {
      setIsDirty(true);
    }
  };

  const handleSave = () => {
    // Track writing time
    const timeSpent = Date.now() - openedAtRef.current;
    const updatedPrompt = {
      ...prompt,
      timeSpentWriting: prompt.timeSpentWriting + timeSpent,
    };
    openedAtRef.current = Date.now();

    setIsSaving(true);
    vscode.postMessage({ type: 'savePrompt', prompt: updatedPrompt });
  };

  const handleStartChat = () => {
    if (startChatLockRef.current || isStartingChat || !prompt.content || prompt.chatSessionIds.length > 0) {
      return;
    }
    startChatLockRef.current = true;
    setIsStartingChat(true);
    vscode.postMessage({ type: 'startChat', id: prompt.id || '__new__', prompt });
  };

  const handleOpenChat = () => {
    if (prompt.id && prompt.chatSessionIds.length > 0) {
      vscode.postMessage({ type: 'openChat', id: prompt.id, sessionId: prompt.chatSessionIds[0] });
    }
  };

  const handleSetStatus = (status: PromptStatus) => {
    const updatedPrompt = {
      ...prompt,
      status,
    };
    setPrompt(updatedPrompt);
    setIsSaving(true);
    setIsDirty(false);
    vscode.postMessage({ type: 'savePrompt', prompt: updatedPrompt });
  };

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

  return (
    <div style={styles.container}>
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
          {/* Title  */}
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

          {/* Description */}
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

          {/* Status */}
          <StatusSelect
            value={prompt.status}
            onChange={v => updateField('status', v as PromptStatus)}
          />

          {/* Prompt content (markdown) with preview toggle */}
          <div style={styles.field}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label style={styles.label}>{t('editor.promptText')}</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button
                  style={{
                    ...styles.linkBtn,
                    fontWeight: showPreview ? 600 : 400,
                  }}
                  onClick={() => setShowPreview(!showPreview)}
                >
                  {showPreview ? `✏️ ${t('editor.edit')}` : `👁 ${t('editor.preview')}`}
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
                onRequestSuggestion={(textBefore) => {
                  vscode.postMessage({ type: 'requestSuggestion', textBefore });
                }}
                suggestion={inlineSuggestion}
                suggestions={inlineSuggestions}
              />
            )}
          </div>

          {/* Template variables (auto-detected) */}
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

          {/* Separator */}
          <div style={styles.separator} />

          {/* Task & Branch */}
          <div style={styles.twoCol}>
            <TextField
              label={t('editor.taskNumber')}
              value={prompt.taskNumber}
              onChange={v => updateField('taskNumber', v)}
              placeholder={t('editor.taskPlaceholder')}
            />
            <div>
              <TextField
                label={t('editor.gitBranch')}
                value={prompt.branch}
                onChange={v => updateField('branch', v)}
                placeholder={t('editor.gitBranchPlaceholder')}
              />
              <div style={{ display: 'flex', gap: '6px' }}>
                <button style={styles.linkBtn} onClick={handleShowBranches}>
                  {t('editor.showBranches')}
                </button>
                {prompt.branch.trim() && prompt.projects.length > 0 && (
                  <button style={styles.linkBtn} onClick={() => {
                    const branchName = prompt.branch.trim();
                    vscode.postMessage({ type: 'createBranch', branch: branchName, projects: prompt.projects });
                  }}>
                    {t('editor.createBranch')}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Branch picker */}
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

          {/* Separator */}
          <div style={styles.separator} />

          {/* Projects */}
          <MultiSelect
            label={t('editor.projects')}
            selected={prompt.projects}
            options={workspaceFolders.map(f => ({ id: f, name: f }))}
            onChange={v => updateField('projects', v)}
            placeholder={t('editor.projectsPlaceholder')}
          />

          {/* Languages */}
          <MultiSelect
            label={t('editor.languages')}
            selected={prompt.languages}
            options={availableLanguages}
            onChange={v => updateField('languages', v)}
            allowCustom
            placeholder={t('editor.langPlaceholder')}
          />

          {/* Frameworks */}
          <MultiSelect
            label={t('editor.frameworks')}
            selected={prompt.frameworks}
            options={availableFrameworks}
            onChange={v => updateField('frameworks', v)}
            allowCustom
            placeholder={t('editor.frameworksPlaceholder')}
          />

          {/* Separator */}
          <div style={styles.separator} />

          {/* Skills */}
          <MultiSelect
            label={t('editor.skills')}
            selected={prompt.skills}
            options={availableSkills}
            onChange={v => updateField('skills', v)}
            placeholder={t('editor.skillsPlaceholder')}
          />

          {/* MCP Tools */}
          <MultiSelect
            label={t('editor.mcpTools')}
            selected={prompt.mcpTools}
            options={availableMcpTools}
            onChange={v => updateField('mcpTools', v)}
            placeholder={t('editor.mcpPlaceholder')}
          />

          {/* Hooks */}
          <MultiSelect
            label={t('editor.hooks')}
            selected={prompt.hooks}
            options={availableHooks}
            onChange={v => updateField('hooks', v)}
            placeholder={t('editor.hooksPlaceholder')}
          />

          {/* Separator */}
          <div style={styles.separator} />

          {/* Model */}
          <div style={styles.field}>
            <label style={styles.label}>{t('editor.aiModel')}</label>
            <select
              value={prompt.model}
              onChange={e => updateField('model', e.target.value)}
              style={styles.select}
            >
              <option value="">{t('common.auto')}</option>
              {availableModels.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>

          {/* Context files */}
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
                      updateField('contextFiles', updated);
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
                            // Only accept file-like paths (must contain / or \ or have a file extension)
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

          {/* Separator */}
          <div style={styles.separator} />

          {/* Global agent context */}
          <div style={styles.field}>
            <label style={styles.label}>{t('editor.globalContext')}</label>
            <textarea
              value={globalContext}
              onChange={e => {
                setGlobalContext(e.target.value);
                vscode.postMessage({ type: 'saveGlobalContext', context: e.target.value });
              }}
              placeholder={t('editor.globalContextPlaceholder')}
              rows={3}
              style={styles.globalContextTextarea}
            />
            <span style={styles.varHint}>{t('editor.globalContextHint')}</span>
          </div>

          {/* Separator */}
          <div style={styles.separator} />

          {/* Time tracking */}
          <TimerDisplay
            timeWriting={prompt.timeSpentWriting}
            timeImplementing={prompt.timeSpentImplementing}
          />
        </div>
      </div>

      {/* Action bar */}
      <ActionBar
        onSave={handleSave}
        onStartChat={handleStartChat}
        onOpenChat={handleOpenChat}
        onMarkCompleted={() => handleSetStatus('completed')}
        onMarkStopped={() => handleSetStatus('stopped')}
        showStatusActions={prompt.status === 'in-progress'}
        hasChatSession={prompt.chatSessionIds.length > 0}
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
    borderRadius: '3px',
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
    borderRadius: '3px',
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
