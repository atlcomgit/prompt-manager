import React from 'react';
import { PROMPT_STATUS_ORDER, type PromptStatus } from '../../../types/prompt';
import { useT } from '../../shared/i18n';

interface Props {
  value: PromptStatus;
  onChange: (value: PromptStatus) => void;
}

export const StatusSelect: React.FC<Props> = ({ value, onChange }) => {
  const t = useT();

  const STATUS_OPTIONS: { value: PromptStatus; label: string; icon: string; color: string }[] = PROMPT_STATUS_ORDER.map(status => {
    switch (status) {
      case 'draft':
        return { value: status, label: t('status.draft'), icon: '📝', color: 'var(--vscode-descriptionForeground)' };
      case 'in-progress':
        return { value: status, label: t('status.inProgress'), icon: '🚀', color: 'var(--vscode-editorInfo-foreground, #3794ff)' };
      case 'stopped':
        return { value: status, label: t('status.stopped'), icon: '▣', color: 'var(--vscode-editorWarning-foreground, #cca700)' };
      case 'cancelled':
        return { value: status, label: t('status.cancelled'), icon: '❌', color: 'var(--vscode-errorForeground, #f44747)' };
      case 'completed':
        return { value: status, label: t('status.completed'), icon: '✅', color: 'var(--vscode-testing-iconPassed, #73c991)' };
      case 'report':
        return { value: status, label: t('status.report'), icon: '🧾', color: 'var(--vscode-textLink-foreground)' };
      case 'review':
        return { value: status, label: t('status.review'), icon: '🔎', color: 'var(--vscode-editorWarning-foreground, #cca700)' };
      case 'closed':
        return { value: status, label: t('status.closed'), icon: '🔒', color: 'var(--vscode-disabledForeground)' };
    }
  });

  return (
    <div style={styles.field}>
      <label style={styles.label}>{t('filter.status')}</label>
      <div style={styles.statusGroup}>
        {STATUS_OPTIONS.map(opt => (
          <button
            key={opt.value}
            style={{
              ...styles.statusBtn,
              ...(value === opt.value ? { ...styles.statusBtnActive, borderColor: opt.color } : {}),
            }}
            onClick={() => onChange(opt.value)}
            title={opt.label}
            aria-pressed={value === opt.value}
          >
            <span style={{ ...styles.statusIconWrap, color: opt.color }}>
              <span style={styles.statusIcon}>{opt.icon}</span>
            </span>
            <span style={styles.statusText}>{opt.label}</span>
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
    gap: '6px',
    padding: '5px 10px',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
    borderRadius: '4px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
    transition: 'border-color 0.15s ease, background 0.15s ease',
  },
  statusBtnActive: {
    background: 'var(--vscode-list-activeSelectionBackground)',
    color: 'var(--vscode-list-activeSelectionForeground)',
    fontWeight: 600,
  },
  statusIconWrap: {
    width: '16px',
    height: '16px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  statusIcon: {
    fontSize: '14px',
    lineHeight: 1,
    fontFamily: '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusText: {
    lineHeight: 1.2,
  },
};
