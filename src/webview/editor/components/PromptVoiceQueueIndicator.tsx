import React from 'react';
import type { PromptVoiceQueueItem } from '../voice/usePromptVoiceController';

type Props = {
  items: PromptVoiceQueueItem[];
  onDismiss: (sessionId: string) => void;
  t: (key: string) => string;
};


const QUEUE_VISIBLE_ITEMS = 3;

const isBusyStatus = (status: PromptVoiceQueueItem['status']): boolean => (
  status === 'queued'
  || status === 'preparing-model'
  || status === 'processing'
  || status === 'correcting'
);

const getStatusLabel = (item: PromptVoiceQueueItem, t: Props['t']): string => {
  if (item.message) {
    return item.message;
  }

  switch (item.status) {
    case 'queued':
      return t('editor.voiceQueueQueued');
    case 'preparing-model':
      return t('editor.voiceQueuePreparing');
    case 'processing':
      return t('editor.voiceQueueProcessing');
    case 'correcting':
      return t('editor.voiceQueueCorrecting');
    case 'completed':
      return t('editor.voiceQueueCompleted');
    case 'error':
      return item.errorBadge || t('editor.voiceQueueError');
  }
};

const VoiceQueueSpinner: React.FC = () => (
  <span style={styles.spinner} aria-hidden="true" />
);

const VoiceQueueProgress: React.FC<{ item: PromptVoiceQueueItem }> = ({ item }) => {
  const width = typeof item.progressPercent === 'number'
    ? `${Math.round(item.progressPercent)}%`
    : (isBusyStatus(item.status) ? '38%' : '100%');
  return (
    <span style={styles.progressTrack} aria-hidden="true">
      <span
        style={{
          ...styles.progressBar,
          width,
          ...(typeof item.progressPercent === 'number' ? null : styles.progressBarIndeterminate),
          ...(item.status === 'error' ? styles.progressBarError : null),
          ...(item.status === 'completed' ? styles.progressBarDone : null),
        }}
      />
    </span>
  );
};

export const PromptVoiceQueueIndicator: React.FC<Props> = ({ items, onDismiss, t }) => {
  if (items.length === 0) {
    return null;
  }

  const visibleItems = items.slice(0, QUEUE_VISIBLE_ITEMS);
  const hiddenCount = Math.max(0, items.length - visibleItems.length);

  return (
    <div style={styles.container} data-pm-prompt-voice-queue="true" aria-live="polite">
      {visibleItems.map(item => {
        const isBusy = isBusyStatus(item.status);
        const label = getStatusLabel(item, t);
        return (
          <div
            key={item.sessionId}
            style={{
              ...styles.item,
              ...(item.status === 'error' ? styles.itemError : null),
              ...(item.status === 'completed' ? styles.itemDone : null),
            }}
            title={item.errorHint || label}
          >
            <span style={styles.itemMain}>
              {isBusy && <VoiceQueueSpinner />}
              {!isBusy && <span style={styles.statusDot} aria-hidden="true" />}
              <span style={styles.label}>{label}</span>
              <span style={styles.duration}>{item.elapsedLabel}</span>
            </span>
            <VoiceQueueProgress item={item} />
            {item.status === 'error' && (
              <button
                type="button"
                style={styles.dismissButton}
                onClick={() => onDismiss(item.sessionId)}
                title={t('editor.voiceQueueDismiss')}
                aria-label={t('editor.voiceQueueDismiss')}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      {hiddenCount > 0 && (
        <span style={styles.moreBadge}>{`+${hiddenCount}`}</span>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    maxWidth: '100%',
    overflow: 'hidden',
  },
  item: {
    position: 'relative',
    minWidth: '148px',
    maxWidth: '240px',
    minHeight: '30px',
    padding: '5px 30px 7px 9px',
    borderRadius: '8px',
    border: '1px solid color-mix(in srgb, var(--vscode-focusBorder) 42%, transparent)',
    background: 'color-mix(in srgb, var(--vscode-editor-background) 88%, transparent)',
    boxShadow: '0 4px 14px color-mix(in srgb, var(--vscode-widget-shadow, rgba(0,0,0,0.28)) 45%, transparent)',
    color: 'var(--vscode-foreground)',
    overflow: 'hidden',
  },
  itemError: {
    borderColor: 'color-mix(in srgb, var(--vscode-errorForeground) 45%, transparent)',
  },
  itemDone: {
    borderColor: 'color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 45%, transparent)',
  },
  itemMain: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
  },
  spinner: {
    width: '12px',
    height: '12px',
    border: '2px solid color-mix(in srgb, var(--vscode-focusBorder) 28%, transparent)',
    borderTopColor: 'var(--vscode-focusBorder)',
    borderRadius: '50%',
    animation: 'pm-spin 0.8s linear infinite',
    flexShrink: 0,
  },
  statusDot: {
    width: '8px',
    height: '8px',
    borderRadius: '999px',
    background: 'var(--vscode-testing-iconPassed, #73c991)',
    flexShrink: 0,
  },
  label: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '11px',
    fontWeight: 600,
  },
  duration: {
    marginLeft: 'auto',
    fontSize: '10px',
    color: 'var(--vscode-descriptionForeground)',
    whiteSpace: 'nowrap',
  },
  progressTrack: {
    position: 'absolute',
    left: '8px',
    right: '8px',
    bottom: '4px',
    height: '2px',
    borderRadius: '999px',
    background: 'color-mix(in srgb, var(--vscode-descriptionForeground) 18%, transparent)',
    overflow: 'hidden',
  },
  progressBar: {
    display: 'block',
    height: '100%',
    minWidth: '12px',
    borderRadius: '999px',
    background: 'var(--vscode-focusBorder)',
    transition: 'width 0.18s ease-out',
  },
  progressBarIndeterminate: {
    animation: 'pm-voice-pulse 1.1s ease-in-out infinite',
  },
  progressBarError: {
    background: 'var(--vscode-errorForeground)',
  },
  progressBarDone: {
    background: 'var(--vscode-testing-iconPassed, #73c991)',
  },
  dismissButton: {
    position: 'absolute',
    top: '3px',
    right: '6px',
    width: '18px',
    height: '18px',
    border: 'none',
    borderRadius: '999px',
    background: 'transparent',
    color: 'var(--vscode-errorForeground)',
    cursor: 'pointer',
    fontSize: '14px',
    lineHeight: '18px',
    padding: 0,
  },
  moreBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '28px',
    height: '28px',
    borderRadius: '999px',
    border: '1px solid color-mix(in srgb, var(--vscode-focusBorder) 32%, transparent)',
    background: 'color-mix(in srgb, var(--vscode-editor-background) 86%, transparent)',
    color: 'var(--vscode-descriptionForeground)',
    fontSize: '11px',
    fontWeight: 700,
    flexShrink: 0,
  },
};