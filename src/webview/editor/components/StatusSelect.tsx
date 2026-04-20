import React from 'react';
import type { PromptStatus } from '../../../types/prompt';
import { useT } from '../../shared/i18n';
import { buildPromptStatusOptions } from '../../shared/promptStatus';

interface Props {
  value: PromptStatus;
  onChange: (value: PromptStatus) => void;
}

export const StatusSelect: React.FC<Props> = ({ value, onChange }) => {
  const t = useT();
  const statusOptions = buildPromptStatusOptions(t);

  return (
    <div style={styles.field}>
      <label style={styles.label}>{t('filter.status')}</label>
      <div style={styles.statusGroup}>
        {statusOptions.map(opt => (
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
    border: 'none',
    borderRadius: '4px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
    boxShadow: 'none',
    outline: 'none',
    transition: 'background 0.15s ease, color 0.15s ease',
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
