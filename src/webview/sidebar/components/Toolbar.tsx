import React from 'react';
import { useT } from '../../shared/i18n';

interface Props {
  onCreateNew: () => void;
  onImport: () => void;
  onToggleFilters: () => void;
  showFilters: boolean;
}

export const Toolbar: React.FC<Props> = ({ onCreateNew, onImport, onToggleFilters, showFilters }) => {
  const t = useT();
  return (
    <div style={styles.container}>
      <button style={styles.btn} onClick={onCreateNew} title={t('sidebar.newTooltip')}>
        {t('sidebar.new')}
      </button>
      <button style={styles.btnSec} onClick={onImport} title={t('sidebar.importTooltip')}>
        📥
      </button>
      <button
        style={{ ...styles.btnSec, ...(showFilters ? styles.btnActive : {}) }}
        onClick={onToggleFilters}
        title={t('sidebar.filtersTooltip')}
      >
        🔍
      </button>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    gap: '4px',
    padding: '6px 8px',
    borderBottom: '1px solid var(--vscode-panel-border)',
    alignItems: 'center',
  },
  btn: {
    flex: 1,
    padding: '4px 10px',
    background: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
    fontWeight: 500,
  },
  btnSec: {
    padding: '4px 8px',
    background: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '14px',
  },
  btnActive: {
    background: 'var(--vscode-badge-background)',
    color: 'var(--vscode-badge-foreground)',
  },
};
