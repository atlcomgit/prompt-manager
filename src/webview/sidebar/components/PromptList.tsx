import React from 'react';
import type { GroupBy, PromptConfig, PromptStatus, SidebarViewMode } from '../../../types/prompt';
import { makeSidebarGroupCollapseKey } from '../../../utils/sidebarGrouping.js';
import { PromptItem } from './PromptItem';
import { useT } from '../../shared/i18n';

interface Props {
  groups: Record<string, PromptConfig[]>;
  groupBy: GroupBy;
  viewMode: SidebarViewMode;
  collapsedGroups: Record<string, boolean>;
  selectedId: string | null;
  savingPromptIds?: string[];
  isLoading?: boolean;
  onToggleGroup: (name: string) => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onExport: (id: string) => void;
  onUpdateStatus: (id: string, status: PromptStatus) => void;
}

export const PromptList: React.FC<Props> = ({
  groups,
  groupBy,
  viewMode,
  collapsedGroups,
  selectedId,
  savingPromptIds = [],
  isLoading,
  onToggleGroup,
  onOpen,
  onDelete,
  onDuplicate,
  onToggleFavorite,
  onExport,
  onUpdateStatus,
}) => {
  const t = useT();
  const groupNames = Object.keys(groups);
  const hasGroups = !(groupNames.length === 1 && groupNames[0] === '');
  const getGroupDisplayName = (name: string): string => {
    if (groupBy !== 'status') {
      return name;
    }

    switch (name as PromptStatus) {
      case 'draft':
        return t('status.draft');
      case 'in-progress':
        return t('status.inProgress');
      case 'stopped':
        return t('status.stopped');
      case 'cancelled':
        return t('status.cancelled');
      case 'completed':
        return t('status.completed');
      case 'report':
        return t('status.report');
      case 'review':
        return t('status.review');
      case 'closed':
        return t('status.closed');
      default:
        return name;
    }
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
            viewMode={viewMode}
            isSelected={p.id === selectedId}
            isSaving={savingPromptIds.includes(p.id)}
            onOpen={onOpen}
            onDelete={onDelete}
            onDuplicate={onDuplicate}
            onToggleFavorite={onToggleFavorite}
            onExport={onExport}
            onUpdateStatus={onUpdateStatus}
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
            onClick={() => onToggleGroup(name)}
          >
            <span>{collapsedGroups[makeSidebarGroupCollapseKey(groupBy, name)] ? '▸' : '▾'}</span>
            <span style={styles.groupName}>{getGroupDisplayName(name)}</span>
            <span style={styles.groupCount}>{groups[name].length}</span>
          </button>
          {!collapsedGroups[makeSidebarGroupCollapseKey(groupBy, name)] && groups[name].map(p => (
            <PromptItem
              key={p.id}
              prompt={p}
              viewMode={viewMode}
              isSelected={p.id === selectedId}
              isSaving={savingPromptIds.includes(p.id)}
              onOpen={onOpen}
              onDelete={onDelete}
              onDuplicate={onDuplicate}
              onToggleFavorite={onToggleFavorite}
              onExport={onExport}
              onUpdateStatus={onUpdateStatus}
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
