import React from 'react';
import type { PromptStatus } from '../../../types/prompt';
import { useT } from '../../shared/i18n';

interface Props {
  value: PromptStatus;
  onChange: (value: PromptStatus) => void;
}

export const StatusSelect: React.FC<Props> = ({ value, onChange }) => {
  const t = useT();

  const STATUS_OPTIONS: { value: PromptStatus; label: string; icon: string; color: string }[] = [
    { value: 'draft', label: t('status.draft'), icon: '📝', color: 'var(--vscode-descriptionForeground)' },
    { value: 'in-progress', label: t('status.inProgress'), icon: '🚀', color: 'var(--vscode-editorInfo-foreground, #3794ff)' },
    { value: 'completed', label: t('status.completed'), icon: '✅', color: 'var(--vscode-testing-iconPassed, #73c991)' },
    { value: 'stopped', label: t('status.stopped'), icon: '⏹', color: 'var(--vscode-editorWarning-foreground, #cca700)' },
    { value: 'cancelled', label: t('status.cancelled'), icon: '❌', color: 'var(--vscode-errorForeground, #f44747)' },
  ];

  return (
    <div style={styles.field}>
      <label style={styles.label}>{t('filter.status')}</label>
      <div style={styles.statusGroup}>
        {STATUS_OPTIONS.map(opt => (
          <button
            key={opt.value}
            style={{
              ...styles.statusBtn,
              ...(value === opt.value ? { ...styles.statusBtnActive, borderColor: opt.color, color: opt.color } : {}),
            }}
            onClick={() => onChange(opt.value)}
            title={opt.label}
          >
            <span>{opt.icon}</span>
            <span>{opt.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  label: {
    fontSize: '12px',
    fontWeight: 500,
    color: 'var(--vscode-foreground)',
  },
  statusGroup: {
    display: 'flex',
    gap: '6px',
    flexWrap: 'wrap',
  },
  statusBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '5px 12px',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
    borderRadius: '16px',
    background: 'transparent',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
    transition: 'all 0.15s ease',
  },
  statusBtnActive: {
    background: 'var(--vscode-input-background)',
    fontWeight: 600,
  },
};
