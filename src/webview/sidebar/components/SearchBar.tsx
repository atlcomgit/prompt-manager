import React from 'react';
import { useT } from '../../shared/i18n';

interface Props {
  value: string;
  onChange: (value: string) => void;
}

export const SearchBar: React.FC<Props> = ({ value, onChange }) => {
  const t = useT();
  return (
    <div style={styles.container}>
      <div style={styles.inputWrapper}>
        <span style={styles.icon} className="codicon codicon-search" />
        <input
          type="text"
          placeholder={t('sidebar.searchPlaceholder')}
          value={value}
          onChange={e => onChange(e.target.value)}
          style={styles.input}
        />
        {value && (
          <button style={styles.clearBtn} onClick={() => onChange('')} title={t('sidebar.clearTooltip')}>
            ✕
          </button>
        )}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '4px 8px',
  },
  inputWrapper: {
    display: 'flex',
    alignItems: 'center',
    background: 'var(--vscode-input-background)',
    border: '1px solid var(--vscode-input-border, transparent)',
    borderRadius: '4px',
    padding: '0 6px',
  },
  icon: {
    marginRight: '4px',
    opacity: 0.6,
    fontSize: '14px',
  },
  input: {
    flex: 1,
    border: 'none',
    outline: 'none',
    background: 'transparent',
    color: 'var(--vscode-input-foreground)',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
    padding: '4px 0',
  },
  clearBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    padding: '2px 4px',
    opacity: 0.6,
    fontSize: '12px',
  },
};
