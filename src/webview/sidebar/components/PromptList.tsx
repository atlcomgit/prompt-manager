import React, { useMemo } from 'react';
import type { GroupBy, PromptConfig, PromptCustomGroup, PromptStatus, SidebarViewMode } from '../../../types/prompt';
import { PROMPT_CUSTOM_GROUP_NONE_KEY } from '../../../types/prompt';
import { resolveReadableTextColor } from '../../../utils/colorContrast.js';
import { resolveSharedCompactTaskColumnTrack } from '../../../utils/sidebarCompactLayout.js';
import { isSidebarPromptActivityActive } from '../../../utils/sidebarPromptActivity.js';
import { makeSidebarGroupCollapseKey } from '../../../utils/sidebarGrouping.js';
import { PromptItem } from './PromptItem';
import { useT } from '../../shared/i18n';

interface Props {
  groups: Record<string, PromptConfig[]>;
  groupBy: GroupBy;
  viewMode: SidebarViewMode;
  collapsedGroups: Record<string, boolean>;
  selectedId: string | null;
  savingPromptKeys?: string[];
  aiEnrichmentPromptKeys?: string[];
  isLoading?: boolean;
  customGroups?: PromptCustomGroup[];
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
  savingPromptKeys = [],
  aiEnrichmentPromptKeys = [],
  isLoading,
  customGroups = [],
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
  const isPromptBusy = (prompt: PromptConfig): boolean => (
    isSidebarPromptActivityActive(prompt, savingPromptKeys)
    || isSidebarPromptActivityActive(prompt, aiEnrichmentPromptKeys)
  );
  const compactTaskColumnTrack = useMemo(() => {
    if (viewMode !== 'compact') {
      return undefined;
    }

    const visiblePrompts = hasGroups
      ? groupNames.flatMap(name => (
        collapsedGroups[makeSidebarGroupCollapseKey(groupBy, name)] ? [] : (groups[name] || [])
      ))
      : (groups[''] || []);

    return resolveSharedCompactTaskColumnTrack(visiblePrompts.map(prompt => prompt.taskNumber));
  }, [collapsedGroups, groupBy, groupNames, groups, hasGroups, viewMode]);

  const getGroupDisplayName = (name: string): string => {
    if (groupBy === 'custom') {
      if (name === PROMPT_CUSTOM_GROUP_NONE_KEY) {
        return t('filter.customGroupNone');
      }
      const customGroup = customGroups.find(group => group.id === name);
      if (customGroup) {
        return customGroup.name;
      }
      return t('filter.customGroupMissing');
    }

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

  // Для пользовательских групп красим только текст заголовка, не меняя badge и фон секции.
  const getGroupDisplayColor = (name: string): string | undefined => {
    if (groupBy !== 'custom' || name === PROMPT_CUSTOM_GROUP_NONE_KEY) {
      return undefined;
    }

    return customGroups.find(group => group.id === name)?.color || undefined;
  };

  // Для цветных пользовательских групп выбираем белый или чёрный текст по контрасту.
  const getGroupReadableTextColor = (name: string): string | undefined => {
    const backgroundColor = getGroupDisplayColor(name);
    if (!backgroundColor) {
      return undefined;
    }

    return resolveReadableTextColor(backgroundColor);
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
            compactTaskColumnTrack={compactTaskColumnTrack}
            isSelected={p.id === selectedId}
            isBusy={isPromptBusy(p)}
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
      {groupNames.map(name => {
        const groupBackgroundColor = getGroupDisplayColor(name);
        const groupTextColor = getGroupReadableTextColor(name);
        const groupHeaderStyle = {
          ...styles.groupHeader,
          ...(groupBackgroundColor ? { background: groupBackgroundColor } : {}),
          ...(groupTextColor ? { color: groupTextColor } : {}),
        };
        const groupCountStyle = {
          ...styles.groupCount,
          ...(groupTextColor ? {
            background: 'color-mix(in srgb, rgba(255, 255, 255, 0.2) 55%, transparent)',
            color: groupTextColor,
            border: `1px solid ${groupTextColor === '#000000' ? 'rgba(0, 0, 0, 0.18)' : 'rgba(255, 255, 255, 0.22)'}`,
          } : {}),
        };

        return (
          <div key={name}>
            <button
              style={groupHeaderStyle}
              onClick={() => onToggleGroup(name)}
            >
              <span>{collapsedGroups[makeSidebarGroupCollapseKey(groupBy, name)] ? '▸' : '▾'}</span>
              <span style={styles.groupName}>
                {getGroupDisplayName(name)}
              </span>
              <span style={groupCountStyle}>{groups[name].length}</span>
            </button>
            {!collapsedGroups[makeSidebarGroupCollapseKey(groupBy, name)] && groups[name].map(p => (
              <PromptItem
                key={p.id}
                prompt={p}
                viewMode={viewMode}
                compactTaskColumnTrack={compactTaskColumnTrack}
                isSelected={p.id === selectedId}
                isBusy={isPromptBusy(p)}
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
      })}
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
    background: 'color-mix(in srgb, var(--vscode-badge-background) 58%, var(--vscode-sideBarSectionHeader-background))',
    color: 'var(--vscode-badge-foreground)',
    border: '1px solid transparent',
    borderRadius: '4px',
    padding: '0 6px',
    fontSize: '12px',
    fontWeight: 600,
    minWidth: '18px',
    textAlign: 'center',
  },
};
