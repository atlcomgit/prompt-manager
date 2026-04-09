/**
 * Sidebar App — Main component for the prompt list sidebar
 */

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { getVsCodeApi } from '../shared/vscodeApi';
import { useMessageListener } from '../shared/useMessageListener';
import { useT } from '../shared/i18n';
import { SearchBar } from './components/SearchBar';
import { FilterBar } from './components/FilterBar';
import { PromptList } from './components/PromptList';
import { Toolbar } from './components/Toolbar';
import { createDefaultPrompt, PROMPT_STATUS_ORDER } from '../../types/prompt';
import { matchesCreatedAtFilter } from '../../utils/sidebarDateFilter.js';
import { makeSidebarGroupCollapseKey, shouldAutoExpandSidebarGroups } from '../../utils/sidebarGrouping.js';
import { reconcileSidebarDeletionState, reconcileSidebarSelection } from '../../utils/sidebarSelection.js';
import type {
  PromptConfig,
  SidebarState,
  FilterState,
  SortField,
  SortOrder,
  GroupBy,
  PromptStatus,
  CreatedAtFilter,
  SidebarViewMode,
} from '../../types/prompt';

const vscode = getVsCodeApi();

export function getSidebarPromptSearchPool(
  prompts: PromptConfig[],
  archivedPrompts: PromptConfig[],
  search: string,
): PromptConfig[] {
  return search.trim() ? [...prompts, ...archivedPrompts] : [...prompts];
}

export const SidebarApp: React.FC = () => {
  const OPEN_PROMPT_DEBOUNCE_MS = 120;
  const t = useT();
  const [prompts, setPrompts] = useState<PromptConfig[]>([]);
  const [archivedPrompts, setArchivedPrompts] = useState<PromptConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedPromptUuid, setSelectedPromptUuid] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<PromptStatus[]>([]);
  const [createdAtFilter, setCreatedAtFilter] = useState<CreatedAtFilter>('all');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [sortField, setSortField] = useState<SortField>('createdAt');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [viewMode, setViewMode] = useState<SidebarViewMode>('detailed');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [showFilters, setShowFilters] = useState(false);
  const [showViewSettings, setShowViewSettings] = useState(false);
  const [hasHydratedState, setHasHydratedState] = useState(false);
  const [showOptimisticNewPrompt, setShowOptimisticNewPrompt] = useState(false);
  const [optimisticBaselineIds, setOptimisticBaselineIds] = useState<string[] | null>(null);
  const [savingPromptIds, setSavingPromptIds] = useState<string[]>([]);
  const openPromptTimerRef = useRef<number | null>(null);

  const optimisticPrompt = useMemo<PromptConfig>(() => {
    const draft = createDefaultPrompt('__new__');
    return {
      ...draft,
      title: 'Новый промпт…',
      description: 'Черновик (ещё не сохранён)',
    };
  }, []);

  const filterState = useMemo<FilterState>(() => ({
    search,
    status: statusFilter,
    projects: [],
    languages: [],
    frameworks: [],
    favorites: favoritesOnly,
    createdAt: createdAtFilter,
  }), [search, statusFilter, favoritesOnly, createdAtFilter]);

  const shouldAutoExpandGroups = useMemo(
    () => shouldAutoExpandSidebarGroups(groupBy, filterState),
    [groupBy, filterState],
  );

  const effectiveCollapsedGroups = useMemo(
    () => (shouldAutoExpandGroups ? {} : collapsedGroups),
    [shouldAutoExpandGroups, collapsedGroups],
  );

  const applyDeletedPromptState = useCallback((deletedId: string | null | undefined) => {
    const nextState = reconcileSidebarDeletionState({
      showOptimisticNewPrompt,
      optimisticBaselineIds,
      selectedId,
      selectedPromptUuid,
    }, deletedId);

    setShowOptimisticNewPrompt(nextState.showOptimisticNewPrompt);
    setOptimisticBaselineIds(nextState.optimisticBaselineIds);
    setSelectedId(nextState.selectedId);
    setSelectedPromptUuid(nextState.selectedPromptUuid);
  }, [showOptimisticNewPrompt, optimisticBaselineIds, selectedId, selectedPromptUuid]);

  // Request initial data after message listener is attached.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      vscode.postMessage({ type: 'ready' });
    }, 0);

    return () => {
      window.clearTimeout(timer);
      if (openPromptTimerRef.current !== null) {
        window.clearTimeout(openPromptTimerRef.current);
        openPromptTimerRef.current = null;
      }
    };
  }, []);

  // Listen for messages from extension
  const handleMessage = useCallback((msg: any) => {
    switch (msg.type) {
      case 'prompts':
        setPrompts(msg.prompts);
        setArchivedPrompts(msg.archivedPrompts || []);
        const nextArchivedPrompts = (msg.archivedPrompts as PromptConfig[] | undefined) || [];
        const combinedPrompts = [...(msg.prompts as PromptConfig[]), ...nextArchivedPrompts];
        let nextSelectedId = selectedId;
        let nextSelectedPromptUuid = selectedPromptUuid;
        if (showOptimisticNewPrompt && optimisticBaselineIds) {
          const baselineSet = new Set(optimisticBaselineIds);
          const newPrompt = (msg.prompts as PromptConfig[]).find(p => !baselineSet.has(p.id));
          if (newPrompt) {
            setShowOptimisticNewPrompt(false);
            setOptimisticBaselineIds(null);
            if (nextSelectedId === '__new__') {
              nextSelectedId = newPrompt.id;
              nextSelectedPromptUuid = newPrompt.promptUuid || null;
            }
          }
        }
        const reconciledSelection = reconcileSidebarSelection(combinedPrompts, {
          selectedId: nextSelectedId,
          selectedPromptUuid: nextSelectedPromptUuid,
        });
        setSelectedId(reconciledSelection.selectedId);
        setSelectedPromptUuid(reconciledSelection.selectedPromptUuid);
        setIsLoading(false);
        break;
      case 'sidebarState': {
        const state: SidebarState = msg.state;
        setSelectedId(state.selectedPromptId || null);
        setSelectedPromptUuid(state.selectedPromptUuid || null);
        if (state.filters) {
          setSearch(state.filters.search || '');
          setStatusFilter(state.filters.status || []);
          setFavoritesOnly(state.filters.favorites || false);
          setCreatedAtFilter(state.filters.createdAt || 'all');
        }
        setSortField(state.sortField || 'createdAt');
        setSortOrder(state.sortOrder || 'desc');
        setViewMode(state.viewMode || 'detailed');
        setGroupBy(state.groupBy || 'none');
        setCollapsedGroups(state.collapsedGroups || {});
        setHasHydratedState(true);
        break;
      }
      case 'sidebarSelectionChanged': {
        const nextSelectedId = msg.id || null;
        const matchingPrompt = nextSelectedId
          ? [...prompts, ...archivedPrompts].find(prompt => prompt.id === nextSelectedId)
          : null;
        setSelectedId(nextSelectedId);
        setSelectedPromptUuid(matchingPrompt?.promptUuid || null);
        break;
      }
      case 'promptDeleted':
        applyDeletedPromptState(String(msg.id || ''));
        break;
      case 'triggerCreatePrompt':
        handleCreate();
        break;
      case 'promptSaving': {
        const id = String(msg.id || '').trim();
        if (!id) {
          break;
        }
        setSavingPromptIds(prev => {
          if (msg.saving) {
            return prev.includes(id) ? prev : [...prev, id];
          }
          return prev.filter(existingId => existingId !== id);
        });
        break;
      }
    }
  }, [applyDeletedPromptState, selectedId, selectedPromptUuid, showOptimisticNewPrompt, optimisticBaselineIds, prompts, archivedPrompts]);

  useMessageListener(handleMessage);

  // Save state when it changes
  useEffect(() => {
    if (!hasHydratedState) {
      return;
    }
    const state: SidebarState = {
      selectedPromptId: selectedId,
      selectedPromptUuid,
      filters: filterState,
      sortField,
      sortOrder,
      viewMode,
      groupBy,
      collapsedGroups,
      panelWidth: 300,
    };
    vscode.postMessage({ type: 'saveSidebarState', state });
  }, [hasHydratedState, selectedId, selectedPromptUuid, filterState, sortField, sortOrder, viewMode, groupBy, collapsedGroups]);

  const filteredPrompts = useMemo(() => {
    let result = getSidebarPromptSearchPool(prompts, archivedPrompts, search);

    // Search across all fields
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(p =>
        (p.title || '').toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        (p.taskNumber || '').toLowerCase().includes(q) ||
        (p.branch || '').toLowerCase().includes(q) ||
        p.status.toLowerCase().includes(q) ||
        p.languages.some(l => l.toLowerCase().includes(q)) ||
        p.frameworks.some(f => f.toLowerCase().includes(q)) ||
        p.projects.some(pr => pr.toLowerCase().includes(q)) ||
        p.contextFiles.some(cf => cf.toLowerCase().includes(q))
      );
    }

    // Status filter
    if (statusFilter.length > 0) {
      result = result.filter(p => statusFilter.includes(p.status));
    }

    if (createdAtFilter !== 'all') {
      result = result.filter(p => matchesCreatedAtFilter(p.createdAt, createdAtFilter));
    }

    // Favorites
    if (favoritesOnly) {
      result = result.filter(p => p.favorite);
    }

    // Sort
    result.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'title':
          cmp = (a.title || a.id).localeCompare(b.title || b.id);
          break;
        case 'createdAt':
          cmp = a.createdAt.localeCompare(b.createdAt);
          break;
        case 'updatedAt':
          cmp = a.updatedAt.localeCompare(b.updatedAt);
          break;
        case 'status':
          cmp = a.status.localeCompare(b.status);
          break;
      }
      return sortOrder === 'asc' ? cmp : -cmp;
    });

    if (showOptimisticNewPrompt && !result.some(p => p.id === '__new__')) {
      result = [optimisticPrompt, ...result];
    }

    return result;
  }, [prompts, archivedPrompts, search, statusFilter, createdAtFilter, favoritesOnly, sortField, sortOrder, showOptimisticNewPrompt, optimisticPrompt]);

  // Group prompts
  const groupedPrompts = useMemo(() => {
    if (groupBy === 'none') {
      return { '': filteredPrompts };
    }

    const groups: Record<string, PromptConfig[]> = {};
    for (const p of filteredPrompts) {
      let keys: string[] = [];
      switch (groupBy) {
        case 'status':
          keys = [p.status];
          break;
        case 'project':
          keys = p.projects.length > 0 ? p.projects : [t('filter.noGroup')];
          break;
        case 'language':
          keys = p.languages.length > 0 ? p.languages : [t('filter.noGroup')];
          break;
        case 'framework':
          keys = p.frameworks.length > 0 ? p.frameworks : [t('filter.noGroup')];
          break;
      }
      for (const key of keys) {
        if (!groups[key]) { groups[key] = []; }
        groups[key].push(p);
      }
    }

    let orderedGroups = groups;
    if (groupBy === 'status') {
      orderedGroups = {};
      for (const status of PROMPT_STATUS_ORDER) {
        if (groups[status]) {
          orderedGroups[status] = groups[status];
        }
      }
      for (const [groupName, groupPrompts] of Object.entries(groups)) {
        if (!(groupName in orderedGroups)) {
          orderedGroups[groupName] = groupPrompts;
        }
      }
    }

    // Add favorites group
    const favoritePrompts = filteredPrompts.filter(p => p.favorite);
    if (favoritePrompts.length > 0) {
      orderedGroups[`⭐ ${t('filter.favoritesOnly')}`] = favoritePrompts;
    }

    return orderedGroups;
  }, [filteredPrompts, groupBy]);

  const handleOpenPrompt = (id: string) => {
    const matchingPrompt = [...prompts, ...archivedPrompts].find(prompt => prompt.id === id) || null;
    setSelectedId(id);
    setSelectedPromptUuid(matchingPrompt?.promptUuid || null);
    if (openPromptTimerRef.current !== null) {
      window.clearTimeout(openPromptTimerRef.current);
    }
    openPromptTimerRef.current = window.setTimeout(() => {
      openPromptTimerRef.current = null;
      vscode.postMessage({ type: 'openPrompt', id });
    }, OPEN_PROMPT_DEBOUNCE_MS);
  };

  const handleCreate = () => {
    if (openPromptTimerRef.current !== null) {
      window.clearTimeout(openPromptTimerRef.current);
      openPromptTimerRef.current = null;
    }
    setOptimisticBaselineIds(prompts.map(p => p.id));
    setShowOptimisticNewPrompt(true);
    setSelectedId('__new__');
    setSelectedPromptUuid(null);
    vscode.postMessage({ type: 'createPrompt' });
  };

  const handleDelete = (id: string) => {
    if (id === '__new__' && openPromptTimerRef.current !== null) {
      window.clearTimeout(openPromptTimerRef.current);
      openPromptTimerRef.current = null;
    }
    applyDeletedPromptState(id);
    vscode.postMessage({ type: 'deletePrompt', id });
  };

  const handleDuplicate = (id: string) => {
    vscode.postMessage({ type: 'duplicatePrompt', id });
  };

  const handleToggleFavorite = (id: string) => {
    vscode.postMessage({ type: 'toggleFavorite', id });
  };

  const handleImport = () => {
    vscode.postMessage({ type: 'importPrompt' });
  };

  const handleExport = (id: string) => {
    vscode.postMessage({ type: 'exportPrompt', id });
  };

  const handleToggleGroup = (name: string) => {
    if (shouldAutoExpandGroups) {
      return;
    }

    const collapseKey = makeSidebarGroupCollapseKey(groupBy, name);
    setCollapsedGroups(prev => ({ ...prev, [collapseKey]: !prev[collapseKey] }));
  };

  const totalPromptCount = useMemo(() => {
    const baseCount = search.trim()
      ? prompts.length + archivedPrompts.length
      : prompts.length;
    return baseCount + (showOptimisticNewPrompt ? 1 : 0);
  }, [search, prompts.length, archivedPrompts.length, showOptimisticNewPrompt]);

  return (
    <div style={styles.container}>
      <Toolbar
        onCreateNew={handleCreate}
        onImport={handleImport}
        onToggleFilters={() => setShowFilters(!showFilters)}
        onToggleViewSettings={() => setShowViewSettings(!showViewSettings)}
        showFilters={showFilters}
        showViewSettings={showViewSettings}
      />
      <SearchBar value={search} onChange={setSearch} />
      {(showFilters || showViewSettings) && (
        <div style={styles.controlsContainer}>
          {showFilters && (
            <FilterBar
              statusFilter={statusFilter}
              onStatusFilterChange={setStatusFilter}
              createdAtFilter={createdAtFilter}
              onCreatedAtFilterChange={setCreatedAtFilter}
              favoritesOnly={favoritesOnly}
              onFavoritesChange={setFavoritesOnly}
            />
          )}
          {showViewSettings && (
            <FilterBar
              mode="view-settings"
              sortField={sortField}
              onSortFieldChange={setSortField}
              sortOrder={sortOrder}
              onSortOrderChange={setSortOrder}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              groupBy={groupBy}
              onGroupByChange={setGroupBy}
            />
          )}
        </div>
      )}
      <div style={styles.listContainer}>
        <PromptList
          groups={groupedPrompts}
          groupBy={groupBy}
          viewMode={viewMode}
          collapsedGroups={effectiveCollapsedGroups}
          selectedId={selectedId}
          savingPromptIds={savingPromptIds}
          isLoading={isLoading}
          onToggleGroup={handleToggleGroup}
          onOpen={handleOpenPrompt}
          onDelete={handleDelete}
          onDuplicate={handleDuplicate}
          onToggleFavorite={handleToggleFavorite}
          onExport={handleExport}
        />
      </div>
      <div style={styles.footer}>
        <span style={styles.count}>{filteredPrompts.length} / {totalPromptCount} {t('sidebar.promptCount')}</span>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    overflow: 'hidden',
  },
  listContainer: {
    flex: 1,
    overflowY: 'auto',
    overflowX: 'hidden',
  },
  controlsContainer: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '0 8px 8px',
    borderBottom: '1px solid var(--vscode-panel-border)',
  },
  footer: {
    padding: '4px 8px',
    borderTop: '1px solid var(--vscode-panel-border)',
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    textAlign: 'center',
  },
  count: {},
};
