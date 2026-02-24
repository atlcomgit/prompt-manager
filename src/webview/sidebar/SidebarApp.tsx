/**
 * Sidebar App — Main component for the prompt list sidebar
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { getVsCodeApi } from '../shared/vscodeApi';
import { useMessageListener } from '../shared/useMessageListener';
import { useT } from '../shared/i18n';
import { SearchBar } from './components/SearchBar';
import { FilterBar } from './components/FilterBar';
import { PromptList } from './components/PromptList';
import { Toolbar } from './components/Toolbar';
import type { PromptConfig, SidebarState, FilterState, SortField, SortOrder, GroupBy, PromptStatus } from '../../types/prompt';

const vscode = getVsCodeApi();

export const SidebarApp: React.FC = () => {
  const t = useT();
  const [prompts, setPrompts] = useState<PromptConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<PromptStatus[]>([]);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [sortField, setSortField] = useState<SortField>('createdAt');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [showFilters, setShowFilters] = useState(false);
  const [hasHydratedState, setHasHydratedState] = useState(false);

  // Request initial data
  useEffect(() => {
    vscode.postMessage({ type: 'ready' });
  }, []);

  // Listen for messages from extension
  const handleMessage = useCallback((msg: any) => {
    switch (msg.type) {
      case 'prompts':
        setPrompts(msg.prompts);
        setIsLoading(false);
        break;
      case 'sidebarState': {
        const state: SidebarState = msg.state;
        if (state.selectedPromptId) { setSelectedId(state.selectedPromptId); }
        if (state.filters) {
          setSearch(state.filters.search || '');
          setStatusFilter(state.filters.status || []);
          setFavoritesOnly(state.filters.favorites || false);
        }
        setSortField(state.sortField || 'createdAt');
        setSortOrder(state.sortOrder || 'desc');
        setGroupBy(state.groupBy || 'none');
        setHasHydratedState(true);
        break;
      }
      case 'promptDeleted':
        if (selectedId === msg.id) { setSelectedId(null); }
        break;
    }
  }, [selectedId]);

  useMessageListener(handleMessage);

  // Save state when it changes
  useEffect(() => {
    if (!hasHydratedState) {
      return;
    }
    const state: SidebarState = {
      selectedPromptId: selectedId,
      filters: { search, status: statusFilter, projects: [], languages: [], frameworks: [], favorites: favoritesOnly },
      sortField,
      sortOrder,
      groupBy,
      panelWidth: 300,
    };
    vscode.postMessage({ type: 'saveSidebarState', state });
  }, [hasHydratedState, selectedId, search, statusFilter, favoritesOnly, sortField, sortOrder, groupBy]);

  // Filter & sort prompts
  const filteredPrompts = useMemo(() => {
    let result = [...prompts];

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

    return result;
  }, [prompts, search, statusFilter, favoritesOnly, sortField, sortOrder]);

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

    // Add favorites group at top
    const favoritePrompts = filteredPrompts.filter(p => p.favorite);
    if (favoritePrompts.length > 0) {
      groups[`⭐ ${t('filter.favoritesOnly')}`] = favoritePrompts;
    }

    return groups;
  }, [filteredPrompts, groupBy]);

  const handleOpenPrompt = (id: string) => {
    setSelectedId(id);
    vscode.postMessage({ type: 'openPrompt', id });
  };

  const handleCreate = () => {
    vscode.postMessage({ type: 'createPrompt' });
  };

  const handleDelete = (id: string) => {
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

  return (
    <div style={styles.container}>
      <Toolbar
        onCreateNew={handleCreate}
        onImport={handleImport}
        onToggleFilters={() => setShowFilters(!showFilters)}
        showFilters={showFilters}
      />
      <SearchBar value={search} onChange={setSearch} />
      {showFilters && (
        <FilterBar
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
          favoritesOnly={favoritesOnly}
          onFavoritesChange={setFavoritesOnly}
          sortField={sortField}
          onSortFieldChange={setSortField}
          sortOrder={sortOrder}
          onSortOrderChange={setSortOrder}
          groupBy={groupBy}
          onGroupByChange={setGroupBy}
        />
      )}
      <div style={styles.listContainer}>
        <PromptList
          groups={groupedPrompts}
          selectedId={selectedId}
          isLoading={isLoading}
          onOpen={handleOpenPrompt}
          onDelete={handleDelete}
          onDuplicate={handleDuplicate}
          onToggleFavorite={handleToggleFavorite}
          onExport={handleExport}
        />
      </div>
      <div style={styles.footer}>
        <span style={styles.count}>{filteredPrompts.length} / {prompts.length} {t('sidebar.promptCount')}</span>
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
  footer: {
    padding: '4px 8px',
    borderTop: '1px solid var(--vscode-panel-border)',
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    textAlign: 'center',
  },
  count: {},
};
