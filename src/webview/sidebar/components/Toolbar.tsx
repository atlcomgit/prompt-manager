import React, { useCallback, useState } from 'react';
import { useT } from '../../shared/i18n';

const FilterIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={styles.icon}>
    <path
      d="M4 6h16l-6.6 7.2v4.9l-2.8 1.4v-6.3L4 6z"
      fill="currentColor"
    />
  </svg>
);

const ImportIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={styles.icon}>
    <path
      d="M11 4h2v8.17l2.59-2.58L17 11l-5 5-5-5 1.41-1.41L11 12.17V4zm-5 13h12v3H6v-3z"
      fill="currentColor"
    />
  </svg>
);

interface Props {
  onCreateNew: () => void;
  onImport: () => void;
  onToggleFilters: () => void;
  onToggleViewSettings: () => void;
  showFilters: boolean;
  showViewSettings: boolean;
}

/** Общий резолвер палитры для служебных кнопок sidebar toolbar. */
export function resolveToolbarUtilityButtonStyle(isActive: boolean): React.CSSProperties {
  return {
    ...styles.btnSec,
    ...(isActive ? styles.btnSecActive : styles.btnSecIdle),
  };
}

export const Toolbar: React.FC<Props> = ({
  onCreateNew,
  onImport,
  onToggleFilters,
  onToggleViewSettings,
  showFilters,
  showViewSettings,
}) => {
  const t = useT();
  const [isImportPressed, setIsImportPressed] = useState(false);

  /** Временное pressed-состояние импорта затемняется только на время взаимодействия. */
  const releaseImportPressedState = useCallback(() => {
    setIsImportPressed(false);
  }, []);

  /** Pointer/keyboard press переводит кнопку импорта в тёмную палитру. */
  const handleImportPressStart = useCallback(() => {
    setIsImportPressed(true);
  }, []);

  /** Сброс pressed-состояния перед открытием системного import flow. */
  const handleImportClick = useCallback(() => {
    setIsImportPressed(false);
    onImport();
  }, [onImport]);

  /** Клавиатурный запуск тоже должен давать краткий pressed-state. */
  const handleImportKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      setIsImportPressed(true);
    }
  }, []);

  /** Отпускание клавиши возвращает светлую палитру. */
  const handleImportKeyUp = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      setIsImportPressed(false);
    }
  }, []);

  return (
    <div style={styles.container}>
      <button style={styles.btn} onClick={onCreateNew} title={t('sidebar.newTooltip')}>
        {t('sidebar.new')}
      </button>
      <button
        style={resolveToolbarUtilityButtonStyle(isImportPressed)}
        onClick={handleImportClick}
        onPointerDown={handleImportPressStart}
        onPointerUp={releaseImportPressedState}
        onPointerCancel={releaseImportPressedState}
        onPointerLeave={releaseImportPressedState}
        onBlur={releaseImportPressedState}
        onKeyDown={handleImportKeyDown}
        onKeyUp={handleImportKeyUp}
        title={t('sidebar.importTooltip')}
      >
        <ImportIcon />
      </button>
      <button
        style={resolveToolbarUtilityButtonStyle(showFilters)}
        onClick={onToggleFilters}
        title={t('sidebar.filtersTooltip')}
      >
        <FilterIcon />
      </button>
      <button
        style={resolveToolbarUtilityButtonStyle(showViewSettings)}
        onClick={onToggleViewSettings}
        title={t('sidebar.viewSettingsTooltip')}
      >
        ▤
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
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '4px 8px',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '14px',
  },
  btnSecIdle: {
    background: 'var(--vscode-badge-background)',
    color: 'var(--vscode-badge-foreground)',
  },
  btnSecActive: {
    background: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
  },
  icon: {
    width: '14px',
    height: '14px',
    flexShrink: 0,
  },
};
