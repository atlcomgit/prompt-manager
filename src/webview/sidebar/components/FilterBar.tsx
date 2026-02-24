import React from 'react';
import type { PromptStatus, SortField, SortOrder, GroupBy } from '../../../types/prompt';
import { useT } from '../../shared/i18n';

interface Props {
  statusFilter: PromptStatus[];
  onStatusFilterChange: (f: PromptStatus[]) => void;
  favoritesOnly: boolean;
  onFavoritesChange: (v: boolean) => void;
  sortField: SortField;
  onSortFieldChange: (f: SortField) => void;
  sortOrder: SortOrder;
  onSortOrderChange: (o: SortOrder) => void;
  groupBy: GroupBy;
  onGroupByChange: (g: GroupBy) => void;
}

export const FilterBar: React.FC<Props> = ({
  statusFilter, onStatusFilterChange,
  favoritesOnly, onFavoritesChange,
  sortField, onSortFieldChange,
  sortOrder, onSortOrderChange,
  groupBy, onGroupByChange,
}) => {
  const t = useT();

  const STATUS_OPTIONS: { value: PromptStatus; label: string }[] = [
    { value: 'draft', label: `📝 ${t('status.draft')}` },
    { value: 'in-progress', label: `🚀 ${t('status.inProgress')}` },
    { value: 'stopped', label: `▣ ${t('status.stopped')}` },
    { value: 'cancelled', label: `❌ ${t('status.cancelled')}` },
    { value: 'completed', label: `✅ ${t('status.completed')}` },
    { value: 'report', label: `🧾 ${t('status.report')}` },
    { value: 'review', label: `🔎 ${t('status.review')}` },
    { value: 'closed', label: `🔒 ${t('status.closed')}` },
  ];

  const SORT_OPTIONS: { value: SortField; label: string }[] = [
    { value: 'title', label: t('filter.sortTitle') },
    { value: 'createdAt', label: t('filter.sortCreated') },
    { value: 'updatedAt', label: t('filter.sortUpdated') },
    { value: 'status', label: t('filter.sortStatus') },
  ];

  const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
    { value: 'none', label: t('filter.noGroup') },
    { value: 'status', label: t('filter.byStatus') },
    { value: 'project', label: t('filter.byProject') },
    { value: 'language', label: t('filter.byLanguage') },
    { value: 'framework', label: t('filter.byFramework') },
  ];

  const toggleStatus = (status: PromptStatus) => {
    if (statusFilter.includes(status)) {
      onStatusFilterChange(statusFilter.filter(s => s !== status));
    } else {
      onStatusFilterChange([...statusFilter, status]);
    }
  };

  return (
    <div style={styles.container}>
      {/* Status filter */}
      <div style={styles.section}>
        <label style={styles.label}>{t('filter.status')}</label>
        <div style={styles.chips}>
          {STATUS_OPTIONS.map(opt => (
            <button
              key={opt.value}
              style={{
                ...styles.chip,
                ...(statusFilter.includes(opt.value) ? styles.chipActive : {}),
              }}
              onClick={() => toggleStatus(opt.value)}
              title={opt.label}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Favorites toggle */}
      <div style={styles.section}>
        <label style={styles.checkboxLabel}>
          <input
            type="checkbox"
            checked={favoritesOnly}
            onChange={e => onFavoritesChange(e.target.checked)}
          />
          ⭐ {t('filter.favoritesOnly')}
        </label>
      </div>

      {/* Sort */}
      <div style={styles.section}>
        <label style={styles.label}>{t('filter.sort')}</label>
        <div style={styles.row}>
          <select
            value={sortField}
            onChange={e => onSortFieldChange(e.target.value as SortField)}
            style={styles.select}
          >
            {SORT_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <button
            style={styles.sortBtn}
            onClick={() => onSortOrderChange(sortOrder === 'asc' ? 'desc' : 'asc')}
            title={sortOrder === 'asc' ? t('filter.sortAsc') : t('filter.sortDesc')}
          >
            {sortOrder === 'asc' ? '↑' : '↓'}
          </button>
        </div>
      </div>

      {/* Group by */}
      <div style={styles.section}>
        <label style={styles.label}>{t('filter.groupBy')}</label>
        <select
          value={groupBy}
          onChange={e => onGroupByChange(e.target.value as GroupBy)}
          style={styles.select}
        >
          {GROUP_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '8px',
    borderBottom: '1px solid var(--vscode-panel-border)',
    fontSize: '12px',
  },
  section: {
    marginBottom: '8px',
  },
  label: {
    display: 'block',
    marginBottom: '4px',
    color: 'var(--vscode-descriptionForeground)',
    fontSize: '11px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  chips: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px',
  },
  chip: {
    padding: '2px 8px',
    borderRadius: '4px',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
    background: 'transparent',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    fontSize: '11px',
    whiteSpace: 'nowrap' as const,
  },
  chipActive: {
    background: 'var(--vscode-badge-background)',
    color: 'var(--vscode-badge-foreground)',
    borderColor: 'var(--vscode-badge-background)',
  },
  checkboxLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    cursor: 'pointer',
    color: 'var(--vscode-foreground)',
  },
  row: {
    display: 'flex',
    gap: '4px',
    alignItems: 'center',
  },
  select: {
    flex: 1,
    padding: '3px 6px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border, transparent)',
    borderRadius: '4px',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
  },
  sortBtn: {
    padding: '3px 8px',
    background: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '14px',
  },
};
