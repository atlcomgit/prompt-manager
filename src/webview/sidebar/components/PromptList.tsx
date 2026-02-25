import React, { useState } from 'react';
import type { PromptConfig } from '../../../types/prompt';
import { PromptItem } from './PromptItem';
import { useT } from '../../shared/i18n';

interface Props {
  groups: Record<string, PromptConfig[]>;
  selectedId: string | null;
  savingPromptIds?: string[];
  isLoading?: boolean;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onExport: (id: string) => void;
}

export const PromptList: React.FC<Props> = ({
  groups, selectedId, savingPromptIds = [], isLoading, onOpen, onDelete, onDuplicate, onToggleFavorite, onExport,
}) => {
  const t = useT();
  const groupNames = Object.keys(groups);
  const hasGroups = !(groupNames.length === 1 && groupNames[0] === '');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggleGroup = (name: string) => {
    setCollapsed(prev => ({ ...prev, [name]: !prev[name] }));
  };

  if (isLoading) {
    return (
      <div style={styles.empty}>
        <p>{t('sidebar.loading')}</p>
      </div>
    );
  }

  if (groupNames.length === 0 || (groupNames.length === 1 && groups['']?.length === 0)) {
    return (
      <div style={styles.empty}>
        <p>{t('sidebar.noPrompts')}</p>
        <p style={styles.emptyHint}>{t('sidebar.createFirst')}</p>
      </div>
    );
  }

  if (!hasGroups) {
    return (
      <div style={styles.list}>
        {groups[''].map(p => (
          <PromptItem
            key={p.id}
            prompt={p}
            isSelected={p.id === selectedId}
            isSaving={savingPromptIds.includes(p.id)}
            onOpen={onOpen}
            onDelete={onDelete}
            onDuplicate={onDuplicate}
            onToggleFavorite={onToggleFavorite}
            onExport={onExport}
          />
        ))}
      </div>
    );
  }

  return (
    <div style={styles.list}>
      {groupNames.map(name => (
        <div key={name}>
          <button
            style={styles.groupHeader}
            onClick={() => toggleGroup(name)}
          >
            <span>{collapsed[name] ? '▸' : '▾'}</span>
            <span style={styles.groupName}>{name}</span>
            <span style={styles.groupCount}>{groups[name].length}</span>
          </button>
          {!collapsed[name] && groups[name].map(p => (
            <PromptItem
              key={p.id}
              prompt={p}
              isSelected={p.id === selectedId}
              isSaving={savingPromptIds.includes(p.id)}
              onOpen={onOpen}
              onDelete={onDelete}
              onDuplicate={onDuplicate}
              onToggleFavorite={onToggleFavorite}
              onExport={onExport}
            />
          ))}
        </div>
      ))}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  list: {
    display: 'flex',
    flexDirection: 'column',
  },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '32px 16px',
    color: 'var(--vscode-descriptionForeground)',
    textAlign: 'center',
  },
  emptyHint: {
    fontSize: '12px',
    opacity: 0.7,
    marginTop: '4px',
  },
  groupHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    width: '100%',
    padding: '6px 8px',
    background: 'var(--vscode-sideBarSectionHeader-background)',
    border: 'none',
    borderBottom: '1px solid var(--vscode-panel-border)',
    color: 'var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground))',
    cursor: 'pointer',
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    fontFamily: 'var(--vscode-font-family)',
    textAlign: 'left',
  },
  groupName: {
    flex: 1,
  },
  groupCount: {
    background: 'var(--vscode-badge-background)',
    color: 'var(--vscode-badge-foreground)',
    borderRadius: '4px',
    padding: '0 6px',
    fontSize: '10px',
    fontWeight: 600,
    minWidth: '16px',
    textAlign: 'center',
  },
};
