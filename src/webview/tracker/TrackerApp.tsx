import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getVsCodeApi } from '../shared/vscodeApi';
import { useMessageListener } from '../shared/useMessageListener';
import { useT } from '../shared/i18n';
import type { PromptConfig, PromptStatus } from '../../types/prompt';

const vscode = getVsCodeApi();

const STATUS_ORDER: PromptStatus[] = [
  'draft',
  'in-progress',
  'stopped',
  'cancelled',
  'completed',
  'report',
  'review',
  'closed',
];

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

export const TrackerApp: React.FC = () => {
  const OPEN_PROMPT_DEBOUNCE_MS = 120;
  const t = useT();
  const [prompts, setPrompts] = useState<PromptConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverStatus, setDragOverStatus] = useState<PromptStatus | null>(null);
  const openPromptTimerRef = useRef<number | null>(null);

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
      setPrompts(msg.prompts || []);
      setIsLoading(false);
      return;
    }

    if (msg.type === 'promptDeleted') {
      setPrompts(prev => prev.filter(p => p.id !== msg.id));
    }
  }, []);

  useMessageListener(handleMessage);

  const movePrompt = useCallback((promptId: string, status: PromptStatus) => {
    setPrompts(prev => prev.map(p => (p.id === promptId ? { ...p, status } : p)));
    vscode.postMessage({ type: 'updatePromptStatus', id: promptId, status });
  }, []);

  const columns = useMemo(() => {
    return STATUS_ORDER.map(status => {
      const items = prompts
        .filter(p => p.status === status)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return { status, items };
    });
  }, [prompts]);

  const onDropToColumn = (status: PromptStatus) => (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const promptId = event.dataTransfer.getData('text/prompt-id');
    setDragOverStatus(null);
    setDraggingId(null);
    if (!promptId) {
      return;
    }

    const prompt = prompts.find(p => p.id === promptId);
    if (!prompt || prompt.status === status) {
      return;
    }

    movePrompt(promptId, status);
  };

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
                    <span style={{ ...styles.statusDot, background: STATUS_COLORS[status] }} />
                    <span>{STATUS_ICONS[status]} {t(statusTranslationKey(status))}</span>
                    <span style={styles.count}>{items.length}</span>
                  </div>

                  <div style={styles.columnBody}>
                    {items.map(prompt => {
                      const isDragging = draggingId === prompt.id;
                      const statusLabel = t(statusTranslationKey(prompt.status));
                      return (
                        <div
                          key={prompt.id}
                          draggable
                          onDragStart={event => {
                            setDraggingId(prompt.id);
                            event.dataTransfer.effectAllowed = 'move';
                            event.dataTransfer.setData('text/prompt-id', prompt.id);
                          }}
                          onDragEnd={() => {
                            setDraggingId(null);
                            setDragOverStatus(null);
                          }}
                          style={{
                            ...styles.card,
                            ...(isDragging ? styles.cardDragging : {}),
                          }}
                        >
                          <div style={styles.cardStatus}>{statusLabel}</div>
                          <div style={styles.cardTitle}>{prompt.title || prompt.id}</div>
                          <div style={styles.cardDescription}>{prompt.description || '—'}</div>
                          <div style={styles.metaRow}><strong>№</strong> {prompt.taskNumber || '—'}</div>
                          <div style={styles.metaRow}><strong>{t('tracker.projects')}</strong> {prompt.projects.length ? prompt.projects.join(', ') : '—'}</div>
                          <div style={styles.actionsRow}>
                            <button style={styles.actionBtn} onClick={() => handleOpenPrompt(prompt.id)}>
                              {t('tracker.open')}
                            </button>
                            <button style={styles.actionBtnPrimary} onClick={() => vscode.postMessage({ type: 'startChat', id: prompt.id })}>
                              {t('tracker.startChat')}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
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
    padding: '6px 10px',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    background: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
    fontSize: '12px',
    fontWeight: 600,
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
    minWidth: `${STATUS_ORDER.length * 100}px`,
    display: 'grid',
    gridTemplateColumns: `repeat(${STATUS_ORDER.length}, minmax(100px, 1fr))`,
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
  card: {
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '8px',
    padding: '8px',
    background: 'var(--vscode-editorWidget-background, var(--vscode-sideBar-background))',
    cursor: 'grab',
    transition: 'transform 100ms ease',
  },
  cardDragging: {
    transform: 'scale(0.995)',
    cursor: 'grabbing',
  },
  cardStatus: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    marginBottom: '4px',
  },
  cardTitle: {
    fontSize: '13px',
    fontWeight: 700,
    marginBottom: '4px',
    wordBreak: 'break-word',
  },
  cardDescription: {
    fontSize: '12px',
    color: 'var(--vscode-descriptionForeground)',
    marginBottom: '6px',
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
  actionsRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
    marginTop: '8px',
  },
  actionBtn: {
    flex: '1 1 88px',
    minWidth: 0,
    padding: '5px 8px',
    border: '1px solid var(--vscode-button-border, var(--vscode-panel-border))',
    borderRadius: '5px',
    background: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
    cursor: 'pointer',
    fontSize: '11px',
    fontWeight: 600,
  },
  actionBtnPrimary: {
    flex: '1 1 108px',
    minWidth: 0,
    padding: '5px 8px',
    border: 'none',
    borderRadius: '5px',
    background: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
    cursor: 'pointer',
    fontSize: '11px',
    fontWeight: 600,
  },
};
