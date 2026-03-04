import React from 'react';
import { useT } from '../../shared/i18n';

interface Props {
  timeWriting: number;
  timeImplementing: number;
  timeOnTask: number;
  timeUntracked: number;
  onUntrackedChange: (ms: number) => void;
  hasChatSessions: boolean;
  isRecalculating: boolean;
  onRecalcImplementingTime: () => void;
}

function formatDuration(ms: number): string {
  if (ms < 1000) { return '0с'; }
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}ч ${minutes}м ${seconds}с`;
  }
  if (minutes > 0) {
    return `${minutes}м ${seconds}с`;
  }
  return `${seconds}с`;
}

export const TimerDisplay: React.FC<Props> = ({ timeWriting, timeImplementing, timeOnTask, timeUntracked, onUntrackedChange, hasChatSessions, isRecalculating, onRecalcImplementingTime }) => {
  const t = useT();
  const totalTime = timeWriting + timeImplementing + timeUntracked;
  const untrackedHours = Number((((timeUntracked || 0) / 3600000)).toFixed(2));

  return (
    <div style={styles.container}>
      <label style={styles.label}>{t('timer.title')}</label>
      <div style={styles.row}>
        <div style={styles.stat}>
          <span style={styles.statLabel}>{t('timer.writing')}</span>
          <span style={styles.statValue}>{formatDuration(timeWriting)}</span>
        </div>
        <div style={styles.stat}>
          <div style={styles.statHeaderRow}>
            <span style={styles.statLabel}>{t('timer.implementing')}</span>
            {hasChatSessions && (
              <button
                type="button"
                onClick={onRecalcImplementingTime}
                disabled={isRecalculating}
                style={styles.recalcButton}
                title={t('timer.recalcTitle')}
              >
                {isRecalculating ? '⏳' : '🔄'}
              </button>
            )}
          </div>
          <span style={styles.statValue}>{formatDuration(timeImplementing)}</span>
        </div>
        <div style={styles.stat}>
          <span style={styles.statLabel}>{t('timer.taskWork')}</span>
          <span style={styles.statValue}>{formatDuration(timeOnTask)}</span>
        </div>
        <div style={styles.stat}>
          <span style={styles.statLabel}>{t('timer.untracked')}</span>
          <div style={styles.untrackedRow}>
            <input
              type="number"
              min={0}
              step={0.25}
              value={Number.isFinite(untrackedHours) ? untrackedHours : 0}
              onChange={e => {
                const hours = Math.max(0, Number.parseFloat(e.target.value || '0') || 0);
                onUntrackedChange(Math.round(hours * 3600000));
              }}
              style={styles.untrackedInput}
              placeholder={t('timer.untrackedPlaceholder')}
            />
            <span style={styles.untrackedSuffix}>ч</span>
          </div>
        </div>
        <div style={styles.stat}>
          <span style={styles.statLabel}>{t('timer.total')}</span>
          <span style={{ ...styles.statValue, ...styles.statTotal }}>{formatDuration(totalTime)}</span>
        </div>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  label: {
    fontSize: '12px',
    fontWeight: 500,
    color: 'var(--vscode-foreground)',
  },
  row: {
    display: 'flex',
    gap: '16px',
    flexWrap: 'wrap',
  },
  stat: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: '8px 12px',
    background: 'var(--vscode-input-background)',
    borderRadius: '4px',
    flex: '1 1 0',
    minWidth: '120px',
  },
  statLabel: {
    fontSize: '10px',
    color: 'var(--vscode-descriptionForeground)',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  statValue: {
    fontSize: '16px',
    fontWeight: 600,
    color: 'var(--vscode-foreground)',
  },
  statTotal: {
    color: 'var(--vscode-textLink-foreground)',
  },
  untrackedInput: {
    width: '80%',
    padding: '0',
    background: 'transparent',
    color: 'var(--vscode-foreground)',
    border: 'none',
    borderRadius: '0',
    fontSize: '16px',
    fontWeight: 600,
    fontFamily: 'var(--vscode-font-family)',
    lineHeight: 1.2,
    boxSizing: 'border-box',
    outline: 'none',
  },
  untrackedRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '4px',
  },
  untrackedSuffix: {
    fontSize: '16px',
    fontWeight: 600,
    color: 'var(--vscode-foreground)',
    lineHeight: 1.2,
  },
  recalcButton: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    fontSize: '12px',
    padding: '0 2px',
    lineHeight: 1,
    opacity: 0.7,
    transition: 'opacity 0.15s',
  },
  statHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '4px',
  },
};
