import React from 'react';
import { useT } from '../../shared/i18n';

const SearchIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={styles.icon}>
    <path
      d="M10.5 4a6.5 6.5 0 0 1 5.17 10.44l4.44 4.45-1.41 1.41-4.45-4.44A6.5 6.5 0 1 1 10.5 4zm0 2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z"
      fill="currentColor"
    />
  </svg>
);

interface Props {
  value: string;
  onChange: (value: string) => void;
}

export const SearchBar: React.FC<Props> = ({ value, onChange }) => {
  const t = useT();
  return (
    <div style={styles.container}>
      <div style={styles.inputWrapper}>
        <SearchIcon />
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
	width: '14px',
	height: '14px',
	flexShrink: 0,
    marginRight: '4px',
    opacity: 0.6,
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
