import React from 'react';
import { useT } from '../../shared/i18n';

interface Props {
  timeWriting: number;
  timeImplementing: number;
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

export const TimerDisplay: React.FC<Props> = ({ timeWriting, timeImplementing }) => {
  const t = useT();
  const totalTime = timeWriting + timeImplementing;

  return (
    <div style={styles.container}>
      <label style={styles.label}>{t('timer.title')}</label>
      <div style={styles.row}>
        <div style={styles.stat}>
          <span style={styles.statLabel}>{t('timer.writing')}</span>
          <span style={styles.statValue}>{formatDuration(timeWriting)}</span>
        </div>
        <div style={styles.stat}>
          <span style={styles.statLabel}>{t('timer.implementing')}</span>
          <span style={styles.statValue}>{formatDuration(timeImplementing)}</span>
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
    borderRadius: '6px',
    minWidth: '100px',
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
};
