import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getVsCodeApi } from '../shared/vscodeApi';
import { useMessageListener } from '../shared/useMessageListener';
import { useT } from '../shared/i18n';
import {
  PROMPT_STATUS_ORDER,
  getNextPromptStatus,
  type Prompt,
  type PromptConfig,
  type PromptStatus,
} from '../../types/prompt';
import { applyPromptConfigSnapshotToPrompt, diffPromptConfigSyncFields } from '../../utils/promptExternalSync.js';
import { PromptDetailOverlay } from './components/PromptDetailOverlay';
import { trackerButtonStyles } from './trackerButtonStyles';

const STATUS_COLORS: Record<PromptStatus, string> = {
  draft: 'var(--vscode-descriptionForeground)',
  'in-progress': 'var(--vscode-editorInfo-foreground, #3794ff)',
  stopped: 'var(--vscode-editorWarning-foreground, #cca700)',
  cancelled: 'var(--vscode-errorForeground, #f44747)',
  completed: 'var(--vscode-testing-iconPassed, #73c991)',
  report: 'var(--vscode-textLink-foreground)',
  review: 'var(--vscode-editorWarning-foreground, #cca700)',
  closed: 'var(--vscode-disabledForeground)',
};

const STATUS_ICONS: Record<PromptStatus, string> = {
  draft: '📝',
  'in-progress': '🚀',
  stopped: '▣',
  cancelled: '❌',
  completed: '✅',
  report: '🧾',
  review: '🔎',
  closed: '🔒',
};

const statusTranslationKey = (status: PromptStatus): string => {
  if (status === 'in-progress') {
    return 'status.inProgress';
  }
  return `status.${status}`;
};

interface ColumnSelectAllCheckboxProps {
  checked: boolean;
  disabled: boolean;
  indeterminate: boolean;
  onChange: (checked: boolean) => void;
  title: string;
}

const ColumnSelectAllCheckbox: React.FC<ColumnSelectAllCheckboxProps> = ({
  checked,
  disabled,
  indeterminate,
  onChange,
  title,
}) => {
  const checkboxRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <input
      ref={checkboxRef}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={event => onChange(event.target.checked)}
      onClick={event => event.stopPropagation()}
      title={title}
      style={styles.columnHeaderCheckbox}
    />
  );
};

export function applyPromptStatusToPrompts(
  prompts: PromptConfig[],
  promptIds: string[],
  status: PromptStatus,
): PromptConfig[] {
  const promptIdSet = new Set(promptIds);
  if (!promptIdSet.size) {
    return prompts;
  }

  return prompts.map(prompt => (
    promptIdSet.has(prompt.id)
      ? { ...prompt, status }
      : prompt
  ));
}

export function getPromptIdsForStatus(prompts: PromptConfig[], status: PromptStatus): string[] {
  return prompts
    .filter(prompt => prompt.status === status)
    .map(prompt => prompt.id);
}

export function getSelectedPromptIdsForStatus(
  prompts: PromptConfig[],
  selectedPromptIds: string[],
  status: PromptStatus,
): string[] {
  const selectedIdSet = new Set(selectedPromptIds);
  return prompts
    .filter(prompt => prompt.status === status && selectedIdSet.has(prompt.id))
    .map(prompt => prompt.id);
}

export function toggleTrackerPromptSelection(selectedPromptIds: string[], promptId: string): string[] {
  const nextIds = new Set(selectedPromptIds);
  if (nextIds.has(promptId)) {
    nextIds.delete(promptId);
  } else {
    nextIds.add(promptId);
  }

  return Array.from(nextIds);
}

export function setTrackerPromptSelectionForStatus(
  selectedPromptIds: string[],
  prompts: PromptConfig[],
  status: PromptStatus,
  checked: boolean,
): string[] {
  const nextIds = new Set(selectedPromptIds);
  const columnPromptIds = getPromptIdsForStatus(prompts, status);

  for (const promptId of columnPromptIds) {
    if (checked) {
      nextIds.add(promptId);
    } else {
      nextIds.delete(promptId);
    }
  }

  return Array.from(nextIds);
}

export function filterExistingTrackerSelections(
  selectedPromptIds: string[],
  prompts: PromptConfig[],
): string[] {
  const existingIds = new Set(prompts.map(prompt => prompt.id));
  return selectedPromptIds.filter(promptId => existingIds.has(promptId));
}

export function getTrackerMoveAllState(status: PromptStatus, selectedCount: number) {
  const nextStatus = getNextPromptStatus(status) || PROMPT_STATUS_ORDER.find(item => item !== status) || null;
  return {
    nextStatus,
    disabled: selectedCount === 0 || !nextStatus,
  };
}

export function shouldRefreshTrackerSelectedPrompt(
  selectedPrompt: Prompt | null,
  selectedPromptConfig: PromptConfig | null,
): boolean {
  if (!selectedPrompt || !selectedPromptConfig || selectedPrompt.id !== selectedPromptConfig.id) {
    return false;
  }

  return selectedPrompt.updatedAt !== selectedPromptConfig.updatedAt
    || diffPromptConfigSyncFields(selectedPrompt, selectedPromptConfig).length > 0;
}

export const TrackerApp: React.FC = () => {
  const OPEN_PROMPT_DEBOUNCE_MS = 120;
  const vscode = getVsCodeApi();
  const t = useT();
  const [prompts, setPrompts] = useState<PromptConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverStatus, setDragOverStatus] = useState<PromptStatus | null>(null);
  const [selectedPromptIds, setSelectedPromptIds] = useState<string[]>([]);
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);
  const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
  const [isPromptLoading, setIsPromptLoading] = useState(false);
  const [moveDialogSourceStatus, setMoveDialogSourceStatus] = useState<PromptStatus | null>(null);
  const [moveDialogTargetStatus, setMoveDialogTargetStatus] = useState<PromptStatus | null>(null);
  const openPromptTimerRef = useRef<number | null>(null);
  const requestedPromptIdRef = useRef<string | null>(null);
  const suppressCardClickRef = useRef(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      vscode.postMessage({ type: 'ready' });
    }, 0);

    return () => {
      window.clearTimeout(timer);
      if (openPromptTimerRef.current !== null) {
        window.clearTimeout(openPromptTimerRef.current);
        openPromptTimerRef.current = null;
      }
    };
  }, []);

  const resetDragInteraction = useCallback(() => {
    setDraggingId(null);
    setDragOverStatus(null);
    suppressCardClickRef.current = false;
  }, []);

  const handleOpenPrompt = useCallback((promptId: string) => {
    if (openPromptTimerRef.current !== null) {
      window.clearTimeout(openPromptTimerRef.current);
    }

    openPromptTimerRef.current = window.setTimeout(() => {
      openPromptTimerRef.current = null;
      vscode.postMessage({ type: 'openPrompt', id: promptId });
    }, OPEN_PROMPT_DEBOUNCE_MS);
  }, []);

  const handleMessage = useCallback((msg: any) => {
    if (msg.type === 'prompts') {
      const nextPrompts = msg.prompts || [];
      setPrompts(nextPrompts);
      setSelectedPromptIds(prev => filterExistingTrackerSelections(prev, nextPrompts));
      setIsLoading(false);
      return;
    }

    if (msg.type === 'prompt' && msg.reason === 'open') {
      if (!requestedPromptIdRef.current || !selectedPromptId) {
        return;
      }

      if (msg.previousId && requestedPromptIdRef.current && msg.previousId !== requestedPromptIdRef.current) {
        return;
      }

      requestedPromptIdRef.current = null;
      setSelectedPrompt(msg.prompt || null);
      setIsPromptLoading(false);
      return;
    }

    if (msg.type === 'promptDeleted') {
      setPrompts(prev => prev.filter(p => p.id !== msg.id));
      setSelectedPromptIds(prev => prev.filter(promptId => promptId !== msg.id));
      setSelectedPrompt(current => (current?.id === msg.id ? null : current));
      setSelectedPromptId(current => (current === msg.id ? null : current));
    }

  }, [selectedPromptId]);

  useMessageListener(handleMessage);

  const updatePromptStatuses = useCallback((promptIds: string[], status: PromptStatus) => {
    if (!promptIds.length) {
      return;
    }

    setPrompts(prev => applyPromptStatusToPrompts(prev, promptIds, status));
    setSelectedPrompt(current => (
      current && promptIds.includes(current.id)
        ? { ...current, status }
        : current
    ));
  }, []);

  const movePrompt = useCallback((promptId: string, status: PromptStatus) => {
    updatePromptStatuses([promptId], status);
    vscode.postMessage({ type: 'updatePromptStatus', id: promptId, status });
  }, [updatePromptStatuses, vscode]);

  const closeMoveDialog = useCallback(() => {
    setMoveDialogSourceStatus(null);
    setMoveDialogTargetStatus(null);
  }, []);

  const openMoveDialog = useCallback((status: PromptStatus) => {
    const selectedIds = getSelectedPromptIdsForStatus(prompts, selectedPromptIds, status);
    const moveState = getTrackerMoveAllState(status, selectedIds.length);
    if (moveState.disabled) {
      return;
    }

    setMoveDialogSourceStatus(status);
    setMoveDialogTargetStatus(moveState.nextStatus);
  }, [prompts, selectedPromptIds]);

  const archivePromptIds = useCallback((promptIds: string[]) => {
    if (!promptIds.length) {
      return;
    }

    closeMoveDialog();
    vscode.postMessage({ type: 'archivePrompts', ids: promptIds });
  }, [closeMoveDialog, vscode]);

  const moveSelectedPromptsToStatus = useCallback(() => {
    if (!moveDialogSourceStatus || !moveDialogTargetStatus) {
      return;
    }

    const promptIds = getSelectedPromptIdsForStatus(prompts, selectedPromptIds, moveDialogSourceStatus)
      .filter(promptId => prompts.find(prompt => prompt.id === promptId)?.status !== moveDialogTargetStatus);

    if (!promptIds.length) {
      closeMoveDialog();
      return;
    }

    updatePromptStatuses(promptIds, moveDialogTargetStatus);
    setSelectedPromptIds(prev => prev.filter(promptId => !promptIds.includes(promptId)));
    vscode.postMessage({ type: 'moveSelectedPromptsToStatus', ids: promptIds, status: moveDialogTargetStatus });
    closeMoveDialog();
  }, [closeMoveDialog, moveDialogSourceStatus, moveDialogTargetStatus, prompts, selectedPromptIds, updatePromptStatuses, vscode]);

  const moveAllPromptsToNextStatus = useCallback((status: PromptStatus) => {
    openMoveDialog(status);
  }, [openMoveDialog]);

  const archiveClosedPrompts = useCallback(() => {
    const selectedClosedPromptIds = getSelectedPromptIdsForStatus(prompts, selectedPromptIds, 'closed');
    const promptIds = selectedClosedPromptIds;

    archivePromptIds(promptIds);
  }, [archivePromptIds, selectedPromptIds, prompts]);

  const selectedPromptConfig = useMemo(() => {
    if (!selectedPromptId) {
      return null;
    }

    return prompts.find(prompt => prompt.id === selectedPromptId) || null;
  }, [prompts, selectedPromptId]);

  useEffect(() => {
    if (!selectedPromptId) {
      requestedPromptIdRef.current = null;
      setSelectedPrompt(null);
      setIsPromptLoading(false);
      return;
    }

    requestedPromptIdRef.current = selectedPromptId;
    setSelectedPrompt(null);
    setIsPromptLoading(true);
    vscode.postMessage({ type: 'getPrompt', id: selectedPromptId });
  }, [selectedPromptId]);

  useEffect(() => {
    if (selectedPromptId && !selectedPromptConfig) {
      setSelectedPromptId(null);
      setSelectedPrompt(null);
      setIsPromptLoading(false);
    }
  }, [selectedPromptConfig, selectedPromptId]);

  useEffect(() => {
    if (!selectedPromptId || !selectedPromptConfig || !selectedPrompt) {
      return;
    }

    if (!shouldRefreshTrackerSelectedPrompt(selectedPrompt, selectedPromptConfig)) {
      return;
    }

    setSelectedPrompt(current => (
      current && current.id === selectedPromptConfig.id
        ? applyPromptConfigSnapshotToPrompt(current, selectedPromptConfig)
        : current
    ));
    requestedPromptIdRef.current = selectedPromptId;
    setIsPromptLoading(true);
    vscode.postMessage({ type: 'getPrompt', id: selectedPromptId });
  }, [selectedPrompt, selectedPromptConfig, selectedPromptId]);

  const openPromptOverlay = useCallback((promptId: string) => {
    if (suppressCardClickRef.current) {
      return;
    }

    setSelectedPromptId(promptId);
  }, []);

  const closePromptOverlay = useCallback(() => {
    requestedPromptIdRef.current = null;
    setSelectedPromptId(null);
    setSelectedPrompt(null);
    setIsPromptLoading(false);
  }, []);

  const handleOpenFromOverlay = useCallback(() => {
    if (!selectedPromptId) {
      return;
    }

    handleOpenPrompt(selectedPromptId);
    closePromptOverlay();
  }, [closePromptOverlay, handleOpenPrompt, selectedPromptId]);

  const handleStartChatFromOverlay = useCallback(() => {
    if (!selectedPromptId) {
      return;
    }

    vscode.postMessage({ type: 'startChat', id: selectedPromptId });
    closePromptOverlay();
  }, [closePromptOverlay, selectedPromptId]);

  const handleOpenChatFromOverlay = useCallback(() => {
    const promptForChat = selectedPrompt ?? selectedPromptConfig;
    const sessionId = promptForChat?.chatSessionIds?.[0];
    if (!selectedPromptId || !sessionId) {
      return;
    }

    vscode.postMessage({ type: 'openChat', id: selectedPromptId, sessionId });
    closePromptOverlay();
  }, [closePromptOverlay, selectedPrompt, selectedPromptConfig, selectedPromptId]);

  const columns = useMemo(() => {
    return PROMPT_STATUS_ORDER.map(status => {
      const items = prompts
        .filter(p => p.status === status)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return { status, items };
    });
  }, [prompts]);

  const onDropToColumn = (status: PromptStatus) => (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const promptId = event.dataTransfer.getData('text/prompt-id');
    resetDragInteraction();
    if (!promptId) {
      return;
    }

    const prompt = prompts.find(p => p.id === promptId);
    if (!prompt || prompt.status === status) {
      return;
    }

    movePrompt(promptId, status);
  };

  const moveDialogOptions = useMemo(() => {
    if (!moveDialogSourceStatus) {
      return [] as PromptStatus[];
    }

    return PROMPT_STATUS_ORDER.filter(status => status !== moveDialogSourceStatus);
  }, [moveDialogSourceStatus]);

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>🗂️ {t('tracker.title')}</h2>
        <button style={styles.createBtn} onClick={() => vscode.postMessage({ type: 'createPrompt' })}>
          {t('tracker.addPrompt')}
        </button>
      </div>

      {isLoading ? (
        <div style={styles.loading}>{t('tracker.loading')}</div>
      ) : (
        <div style={styles.boardViewport}>
          <div style={styles.board}>
            {columns.map(({ status, items }) => {
              const isOver = dragOverStatus === status;
              const selectedIds = getSelectedPromptIdsForStatus(prompts, selectedPromptIds, status);
              const moveAllState = getTrackerMoveAllState(status, selectedIds.length);
              const allSelected = items.length > 0 && selectedIds.length === items.length;
              const isPartiallySelected = selectedIds.length > 0 && selectedIds.length < items.length;
              return (
                <div
                  key={status}
                  style={{
                    ...styles.column,
                    ...(isOver ? styles.columnDragOver : {}),
                  }}
                  onDragOver={event => {
                    event.preventDefault();
                    setDragOverStatus(status);
                  }}
                  onDragLeave={() => setDragOverStatus(current => (current === status ? null : current))}
                  onDrop={onDropToColumn(status)}
                >
                  <div style={styles.columnHeader}>
                    <div style={styles.columnHeaderInfo}>
                      <ColumnSelectAllCheckbox
                        checked={allSelected}
                        disabled={items.length === 0}
                        indeterminate={isPartiallySelected}
                        onChange={checked => setSelectedPromptIds(prev => (
                          setTrackerPromptSelectionForStatus(prev, prompts, status, checked)
                        ))}
                        title={t('tracker.selectAllInColumn')}
                      />
                      <span style={{ ...styles.statusDot, background: STATUS_COLORS[status] }} />
                      <span>{STATUS_ICONS[status]} {t(statusTranslationKey(status))}</span>
                    </div>
                    <span style={styles.count}>{items.length}</span>
                  </div>

                  <div style={styles.columnBody}>
                    {items.map(prompt => {
                      const isDragging = draggingId === prompt.id;
                      const isSelected = selectedPromptIds.includes(prompt.id);
                      const statusLabel = t(statusTranslationKey(prompt.status));
                      return (
                        <div
                          key={prompt.id}
                          draggable
                          onDragStart={event => {
                            closePromptOverlay();
                            suppressCardClickRef.current = true;
                            setDraggingId(prompt.id);
                            event.dataTransfer.effectAllowed = 'move';
                            event.dataTransfer.setData('text/prompt-id', prompt.id);
                          }}
                          onDragEnd={() => {
                          resetDragInteraction();
                          }}
                          onClick={() => openPromptOverlay(prompt.id)}
                          style={{
                            ...styles.card,
                            ...(isSelected ? styles.cardSelected : {}),
                            ...(isDragging ? styles.cardDragging : {}),
                          }}
                        >
                          <div style={styles.cardHeaderRow}>
                            <div style={styles.cardHeaderMain}>
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => setSelectedPromptIds(prev => toggleTrackerPromptSelection(prev, prompt.id))}
                                onClick={event => event.stopPropagation()}
                                style={styles.cardCheckbox}
                                title={t('tracker.selectPrompt')}
                              />
                              <div style={styles.cardStatus}>{statusLabel}</div>
                            </div>
                            <div style={styles.cardHint}>{t('tracker.clickToOpen')}</div>
                          </div>
                          <div style={styles.cardTitle}>{prompt.title || prompt.id}</div>
                          <div style={styles.cardDescription}>{prompt.description || '—'}</div>
                          <div style={styles.metaRow}><strong>№</strong> {prompt.taskNumber || '—'}</div>
                          <div style={styles.metaRow}><strong>{t('tracker.projects')}</strong> {prompt.projects.length ? prompt.projects.join(', ') : '—'}</div>
                          <div style={styles.cardFooterRow}>
                            <span style={styles.cardMetaChip}>{prompt.favorite ? '★' : '☆'} {prompt.model || t('tracker.detail.empty')}</span>
                            <span style={styles.cardMetaChip}>{prompt.updatedAt ? new Date(prompt.updatedAt).toLocaleDateString('ru-RU') : '—'}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div style={styles.columnFooter}>
                    <div style={styles.columnFooterButtons}>
                      <button
                        style={{
                          ...styles.columnFooterButton,
                          ...(moveAllState.disabled ? styles.columnFooterButtonDisabled : {}),
                        }}
                        onClick={() => moveAllPromptsToNextStatus(status)}
                        disabled={moveAllState.disabled}
                        title={moveAllState.nextStatus
                          ? `${t('tracker.moveAllToNext')} -> ${t(statusTranslationKey(moveAllState.nextStatus))}`
                          : t('tracker.moveAllToNext')}
                      >
                        {t('tracker.moveAllToNext')}
                      </button>
                      {status === 'closed' && (
                        <button
                          style={{
                            ...styles.columnFooterButton,
                            ...styles.columnFooterButtonDanger,
                            ...(selectedIds.length === 0 ? styles.columnFooterButtonDisabled : {}),
                          }}
                          onClick={archiveClosedPrompts}
                          disabled={selectedIds.length === 0}
                          title={t('tracker.archive')}
                        >
                          {t('tracker.archive')}
                        </button>
                      )}
                    </div>
                    <div style={styles.columnFooterHint}>
                      {selectedIds.length > 0
                        ? `${t('tracker.selectedCount')}: ${selectedIds.length}`
                        : t('tracker.noSelection')}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {moveDialogSourceStatus && (
        <div style={styles.moveDialogBackdrop} onClick={closeMoveDialog}>
          <div style={styles.moveDialog} onClick={event => event.stopPropagation()}>
            <div style={styles.moveDialogHeader}>
              <h3 style={styles.moveDialogTitle}>{t('tracker.moveDialogTitle')}</h3>
              <button type="button" style={styles.moveDialogCloseButton} onClick={closeMoveDialog}>
                {t('common.close')}
              </button>
            </div>
            <div style={styles.moveDialogBody}>
              <div style={styles.moveDialogLabel}>{t('tracker.moveDialogCurrentColumn')}</div>
              <div style={styles.moveDialogCurrentValue}>{t(statusTranslationKey(moveDialogSourceStatus))}</div>
              <label style={styles.moveDialogLabel} htmlFor="tracker-move-target-select">
                {t('tracker.moveDialogTargetColumn')}
              </label>
              <select
                id="tracker-move-target-select"
                value={moveDialogTargetStatus || ''}
                onChange={event => setMoveDialogTargetStatus((event.target.value || null) as PromptStatus | null)}
                style={styles.moveDialogSelect}
              >
                <option value="">{t('tracker.moveDialogSelectPlaceholder')}</option>
                {moveDialogOptions.map(status => (
                  <option key={status} value={status}>
                    {t(statusTranslationKey(status))}
                  </option>
                ))}
              </select>
            </div>
            <div style={styles.moveDialogFooter}>
              <button type="button" style={styles.moveDialogSecondaryButton} onClick={closeMoveDialog}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                style={{
                  ...styles.moveDialogPrimaryButton,
                  ...(!moveDialogTargetStatus ? styles.columnFooterButtonDisabled : {}),
                }}
                onClick={moveSelectedPromptsToStatus}
                disabled={!moveDialogTargetStatus}
              >
                {t('tracker.moveDialogConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      <PromptDetailOverlay
        promptConfig={selectedPromptConfig}
        prompt={selectedPrompt}
        loading={isPromptLoading}
        onClose={closePromptOverlay}
        onOpenPrompt={handleOpenFromOverlay}
        onOpenChat={handleOpenChatFromOverlay}
        onStartChat={handleStartChatFromOverlay}
        t={t}
      />
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    color: 'var(--vscode-foreground)',
    fontFamily: 'var(--vscode-font-family)',
    background: 'var(--vscode-editor-background)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    padding: '12px 14px',
    borderBottom: '1px solid var(--vscode-panel-border)',
  },
  title: {
    margin: 0,
    fontSize: '16px',
    fontWeight: 600,
  },
  createBtn: {
    ...trackerButtonStyles.primary,
    padding: '6px 10px',
  },
  loading: {
    padding: '24px',
    color: 'var(--vscode-descriptionForeground)',
  },
  boardViewport: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    overflowX: 'auto',
    overflowY: 'hidden',
  },
  board: {
    height: '100%',
    width: '100%',
    minWidth: `${PROMPT_STATUS_ORDER.length * 100}px`,
    display: 'grid',
    gridTemplateColumns: `repeat(${PROMPT_STATUS_ORDER.length}, minmax(100px, 1fr))`,
    gap: '10px',
    padding: '10px',
    boxSizing: 'border-box',
  },
  column: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: '100px',
    minHeight: 0,
    height: '100%',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '8px',
    background: 'color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-sideBar-background))',
    transition: 'border-color 120ms ease, background 120ms ease',
  },
  columnDragOver: {
    borderColor: 'var(--vscode-focusBorder)',
    background: 'color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 20%, var(--vscode-editor-background))',
  },
  columnHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 10px',
    borderBottom: '1px solid var(--vscode-panel-border)',
    fontSize: '12px',
    fontWeight: 600,
  },
  columnHeaderInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    minWidth: 0,
  },
  columnHeaderCheckbox: {
    margin: 0,
    cursor: 'pointer',
    flexShrink: 0,
  },
  statusDot: {
    width: '8px',
    height: '8px',
    borderRadius: '999px',
    display: 'inline-block',
    flexShrink: 0,
  },
  count: {
    marginLeft: 'auto',
    background: 'var(--vscode-badge-background)',
    color: 'var(--vscode-badge-foreground)',
    borderRadius: '999px',
    fontSize: '10px',
    fontWeight: 700,
    padding: '2px 6px',
  },
  columnBody: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    gap: '8px',
    padding: '8px',
    overflowY: 'auto',
  },
  columnFooter: {
    padding: '8px',
    borderTop: '1px solid var(--vscode-panel-border)',
  },
  columnFooterButtons: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  columnFooterButton: {
    ...trackerButtonStyles.secondary,
    width: '100%',
  },
  columnFooterButtonDanger: {
    background: 'color-mix(in srgb, var(--vscode-errorForeground) 14%, var(--vscode-button-background))',
    color: 'var(--vscode-button-foreground)',
    WebkitTextFillColor: 'var(--vscode-button-foreground)',
  },
  columnFooterButtonDisabled: {
    opacity: 0.55,
    cursor: 'not-allowed',
  },
  columnFooterHint: {
    marginTop: '8px',
    fontSize: '10px',
    color: 'var(--vscode-descriptionForeground)',
  },
  card: {
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '8px',
    padding: '10px',
    background: 'var(--vscode-editorWidget-background, var(--vscode-sideBar-background))',
    cursor: 'pointer',
    transition: 'transform 100ms ease, border-color 120ms ease, background 120ms ease',
  },
  cardSelected: {
    borderColor: 'var(--vscode-focusBorder)',
    background: 'color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 12%, var(--vscode-editorWidget-background, var(--vscode-sideBar-background)))',
  },
  cardDragging: {
    transform: 'scale(0.995)',
    cursor: 'grabbing',
  },
  cardHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    marginBottom: '6px',
  },
  cardHeaderMain: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
  },
  cardCheckbox: {
    margin: 0,
    cursor: 'pointer',
    flexShrink: 0,
  },
  cardStatus: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
  },
  cardHint: {
    fontSize: '10px',
    color: 'var(--vscode-descriptionForeground)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  cardTitle: {
    fontSize: '13px',
    fontWeight: 700,
    marginBottom: '6px',
    wordBreak: 'break-word',
  },
  cardDescription: {
    fontSize: '12px',
    color: 'var(--vscode-descriptionForeground)',
    marginBottom: '8px',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  metaRow: {
    fontSize: '11px',
    marginBottom: '4px',
    color: 'var(--vscode-foreground)',
    wordBreak: 'break-word',
  },
  cardFooterRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
    marginTop: '8px',
  },
  cardMetaChip: {
    maxWidth: '100%',
    padding: '4px 8px',
    borderRadius: '2px',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground, var(--vscode-foreground))',
    fontSize: '11px',
    fontWeight: 600,
    wordBreak: 'break-word',
  },
  moveDialogBackdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.38)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '16px',
    zIndex: 40,
  },
  moveDialog: {
    width: 'min(420px, 100%)',
    borderRadius: '10px',
    border: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-editorWidget-background, var(--vscode-editor-background))',
    boxShadow: '0 18px 40px rgba(0, 0, 0, 0.28)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  moveDialogHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    padding: '14px 16px',
    borderBottom: '1px solid var(--vscode-panel-border)',
  },
  moveDialogTitle: {
    margin: 0,
    fontSize: '15px',
    fontWeight: 700,
  },
  moveDialogCloseButton: {
    ...trackerButtonStyles.secondary,
    padding: '6px 10px',
  },
  moveDialogBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '16px',
  },
  moveDialogLabel: {
    fontSize: '12px',
    fontWeight: 600,
    color: 'var(--vscode-descriptionForeground)',
  },
  moveDialogCurrentValue: {
    padding: '8px 10px',
    borderRadius: '6px',
    border: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground, var(--vscode-foreground))',
    fontSize: '13px',
    fontWeight: 600,
  },
  moveDialogSelect: {
    width: '100%',
    padding: '8px 10px',
    borderRadius: '6px',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground, var(--vscode-foreground))',
    fontSize: '13px',
  },
  moveDialogFooter: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
    padding: '14px 16px 16px',
    borderTop: '1px solid var(--vscode-panel-border)',
  },
  moveDialogPrimaryButton: {
    ...trackerButtonStyles.primary,
    padding: '6px 12px',
  },
  moveDialogSecondaryButton: {
    ...trackerButtonStyles.secondary,
    padding: '6px 12px',
  },
};
