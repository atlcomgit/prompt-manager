import React from 'react';
import type {
  PromptStatus,
  SortField,
  SortOrder,
  GroupBy,
  CreatedAtFilter,
  SidebarViewMode,
} from '../../../types/prompt';
import { useT } from '../../shared/i18n';

type FilterControlsProps = {
  mode?: 'filters';
  statusFilter: PromptStatus[];
  onStatusFilterChange: (f: PromptStatus[]) => void;
  createdAtFilter: CreatedAtFilter;
  onCreatedAtFilterChange: (f: CreatedAtFilter) => void;
  favoritesOnly: boolean;
  onFavoritesChange: (v: boolean) => void;
};

type ViewSettingsProps = {
  mode: 'view-settings';
  sortField: SortField;
  onSortFieldChange: (f: SortField) => void;
  sortOrder: SortOrder;
  onSortOrderChange: (o: SortOrder) => void;
  viewMode: SidebarViewMode;
  onViewModeChange: (mode: SidebarViewMode) => void;
  groupBy: GroupBy;
  onGroupByChange: (g: GroupBy) => void;
};

type Props = FilterControlsProps | ViewSettingsProps;

export const FilterBar: React.FC<Props> = (props) => {
  const t = useT();
  const isViewSettings = props.mode === 'view-settings';

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
    { value: 'custom', label: t('filter.byCustom') },
  ];

  const VIEW_MODE_OPTIONS: { value: SidebarViewMode; label: string }[] = [
    { value: 'compact', label: t('filter.viewModeCompact') },
    { value: 'detailed', label: t('filter.viewModeDetailed') },
  ];

  const CREATED_AT_OPTIONS: { value: CreatedAtFilter; label: string }[] = [
    { value: 'all', label: t('filter.periodAll') },
    { value: 'last-1-day', label: t('filter.periodLast1Day') },
    { value: 'last-7-days', label: t('filter.periodLast7Days') },
    { value: 'last-14-days', label: t('filter.periodLast14Days') },
    { value: 'last-30-days', label: t('filter.periodLast30Days') },
    { value: 'last-1-year', label: t('filter.periodLast1Year') },
    { value: 'current-week', label: t('filter.periodCurrentWeek') },
    { value: 'previous-week', label: t('filter.periodPreviousWeek') },
    { value: 'current-month', label: t('filter.periodCurrentMonth') },
    { value: 'previous-month', label: t('filter.periodPreviousMonth') },
    { value: 'current-year', label: t('filter.periodCurrentYear') },
    { value: 'previous-year', label: t('filter.periodPreviousYear') },
  ];

  const toggleStatus = (status: PromptStatus) => {
    if (isViewSettings) {
      return;
    }

    const { statusFilter, onStatusFilterChange } = props;
    if (statusFilter.includes(status)) {
      onStatusFilterChange(statusFilter.filter(s => s !== status));
    } else {
      onStatusFilterChange([...statusFilter, status]);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.headerRow}>
          <span style={styles.headerTitle}>
            {isViewSettings ? t('filter.viewSettingsTitle') : t('filter.filtersTitle')}
          </span>
        </div>
        {isViewSettings ? (
          <div style={styles.settingsGrid}>
            <div style={styles.fieldWide}>
              <label style={styles.label}>{t('filter.sort')}</label>
              <div style={styles.row}>
                <select
                  value={props.sortField}
                  onChange={e => props.onSortFieldChange(e.target.value as SortField)}
                  style={styles.select}
                >
                  {SORT_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <button
                  style={styles.sortBtn}
                  onClick={() => props.onSortOrderChange(props.sortOrder === 'asc' ? 'desc' : 'asc')}
                  title={props.sortOrder === 'asc' ? t('filter.sortAsc') : t('filter.sortDesc')}
                >
                  {props.sortOrder === 'asc' ? '↑' : '↓'}
                </button>
              </div>
            </div>

            <div style={styles.section}>
              <label style={styles.label}>{t('filter.groupBy')}</label>
              <select
                value={props.groupBy}
                onChange={e => props.onGroupByChange(e.target.value as GroupBy)}
                style={styles.select}
              >
                {GROUP_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            <div style={styles.section}>
              <label style={styles.label}>{t('filter.viewMode')}</label>
              <select
                value={props.viewMode}
                onChange={e => props.onViewModeChange(e.target.value as SidebarViewMode)}
                style={styles.select}
              >
                {VIEW_MODE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>
        ) : (
          <>
            <div style={styles.section}>
              <label style={styles.label}>{t('filter.status')}</label>
              <div style={styles.chips}>
                {STATUS_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    style={{
                      ...styles.chip,
                      ...(props.statusFilter.includes(opt.value) ? styles.chipActive : {}),
                    }}
                    onClick={() => toggleStatus(opt.value)}
                    title={opt.label}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div style={styles.filtersGrid}>
              <div style={styles.section}>
                <label style={styles.label}>{t('filter.showRecent')}</label>
                <select
                  value={props.createdAtFilter}
                  onChange={e => props.onCreatedAtFilterChange(e.target.value as CreatedAtFilter)}
                  style={styles.select}
                >
                  {CREATED_AT_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              <div style={{ ...styles.section, ...styles.favoriteSection }}>
                <label style={styles.label}>{t('filter.quickOptions')}</label>
                <label style={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={props.favoritesOnly}
                    onChange={e => props.onFavoritesChange(e.target.checked)}
                  />
                  ⭐ {t('filter.favoritesOnly')}
                </label>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    fontSize: '12px',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '10px',
    background: 'color-mix(in srgb, var(--vscode-input-background) 84%, transparent)',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '8px',
  },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitle: {
    fontSize: '11px',
    fontWeight: 700,
    color: 'var(--vscode-descriptionForeground)',
    textTransform: 'uppercase',
    letterSpacing: '0.6px',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  fieldWide: {
    gridColumn: '1 / -1',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  label: {
    display: 'block',
    color: 'var(--vscode-descriptionForeground)',
    fontSize: '11px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  filtersGrid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.45fr) minmax(0, 1fr)',
    gap: '10px',
    alignItems: 'stretch',
  },
  settingsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: '10px',
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
    minHeight: '32px',
  },
  favoriteSection: {
    justifyContent: 'space-between',
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
