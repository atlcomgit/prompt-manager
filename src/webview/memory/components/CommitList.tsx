/**
 * CommitList — Displays a filterable, scrollable list of memory commits.
 */

import React, { useState } from 'react';
import type { MemoryCommit, MemoryFilter } from '../../../types/memory';
import { memoryButtonStyles } from './buttonStyles';

interface Props {
	commits: MemoryCommit[];
	total: number;
	filter: MemoryFilter;
	onFilterChange: (filter: MemoryFilter) => void;
	onSelectCommit: (sha: string) => void;
	onDeleteCommit: (sha: string) => void;
	selectedSha?: string;
	authors: string[];
	branches: string[];
	categories: string[];
	repositories: string[];
	/** Колбэк полнотекстового/семантического поиска. */
	onSearch?: (query: string) => void;
	t: (key: string) => string;
}

export const CommitList: React.FC<Props> = ({
	commits, total, filter, onFilterChange, onSelectCommit,
	onDeleteCommit, selectedSha, authors, branches, categories,
	repositories, onSearch, t,
}) => {
	const [showFilters, setShowFilters] = useState(false);
	const [searchInput, setSearchInput] = useState('');

	/** Update a single filter field */
	const updateFilter = (key: keyof MemoryFilter, value: any) => {
		onFilterChange({ ...filter, [key]: value || undefined });
	};

	/** Вызвать поиск по нажатию Enter или кнопке. */
	const handleSearch = () => {
		const q = searchInput.trim();
		if (q && onSearch) {
			onSearch(q);
		}
	};

	return (
		<div style={styles.container}>
			{/* Строка поиска — компактная, над заголовком */}
			{onSearch && (
				<div style={styles.searchRow}>
					<input
						type="text"
						style={styles.searchInput}
						placeholder={t('memory.searchPlaceholder')}
						value={searchInput}
						onChange={e => setSearchInput(e.target.value)}
						onKeyDown={e => { if (e.key === 'Enter') { handleSearch(); } }}
					/>
					<button style={memoryButtonStyles.primary} onClick={handleSearch}>
						{t('memory.search')}
					</button>
				</div>
			)}
			{/* Header with count and filter toggle */}
			<div style={styles.header}>
				<span style={styles.count}>
					{t('memory.commits')}: {total}
				</span>
				<button style={memoryButtonStyles.secondary} onClick={() => setShowFilters(!showFilters)}>
					{showFilters ? '▲' : '▼'} {t('memory.filters')}
				</button>
			</div>

			{/* Filter panel */}
			{showFilters && (
				<div style={styles.filters}>
					{/* Author filter */}
					<label style={styles.filterLabel}>{t('memory.author')}</label>
					<select
						style={styles.filterSelect}
						value={(filter.authors || [])[0] || ''}
						onChange={e => updateFilter('authors', e.target.value ? [e.target.value] : undefined)}
					>
						<option value="">{t('memory.all')}</option>
						{authors.map(a => <option key={a} value={a}>{a}</option>)}
					</select>

					{/* Branch filter */}
					<label style={styles.filterLabel}>{t('memory.branch')}</label>
					<select
						style={styles.filterSelect}
						value={(filter.branches || [])[0] || ''}
						onChange={e => updateFilter('branches', e.target.value ? [e.target.value] : undefined)}
					>
						<option value="">{t('memory.all')}</option>
						{branches.map(b => <option key={b} value={b}>{b}</option>)}
					</select>

					{/* Repository filter */}
					{repositories.length > 1 && (
						<>
							<label style={styles.filterLabel}>{t('memory.repository')}</label>
							<select
								style={styles.filterSelect}
								value={(filter.repositories || [])[0] || ''}
								onChange={e => updateFilter('repositories', e.target.value ? [e.target.value] : undefined)}
							>
								<option value="">{t('memory.all')}</option>
								{repositories.map(r => <option key={r} value={r}>{r}</option>)}
							</select>
						</>
					)}

					{/* Date range */}
					<label style={styles.filterLabel}>{t('memory.dateFrom')}</label>
					<input
						type="date"
						style={styles.filterInput}
						value={filter.dateFrom || ''}
						onChange={e => updateFilter('dateFrom', e.target.value || undefined)}
					/>
					<label style={styles.filterLabel}>{t('memory.dateTo')}</label>
					<input
						type="date"
						style={styles.filterInput}
						value={filter.dateTo || ''}
						onChange={e => updateFilter('dateTo', e.target.value || undefined)}
					/>

					{/* Reset */}
					<button
						style={{ ...memoryButtonStyles.secondary, alignSelf: 'flex-start' }}
						onClick={() => onFilterChange({})}
					>
						{t('memory.resetFilters')}
					</button>
				</div>
			)}

			{/* Commit list */}
			<div style={styles.list}>
				{commits.length === 0 ? (
					<div style={styles.empty}>{t('memory.noCommits')}</div>
				) : (
					commits.map(commit => (
						<div
							key={commit.sha}
							style={{
								...styles.item,
								...(selectedSha === commit.sha ? styles.itemSelected : {}),
							}}
							onClick={() => onSelectCommit(commit.sha)}
						>
							<div style={styles.itemHeader}>
								<span style={styles.sha}>{commit.sha.substring(0, 7)}</span>
								<span style={styles.commitType}>{commit.commitType}</span>
								<span style={styles.date}>{commit.date.substring(0, 10)}</span>
							</div>
							<div style={styles.message}>{commit.message.split('\n')[0]}</div>
							<div style={styles.meta}>
								{commit.author} · {commit.branch}
							</div>
							<button
								style={styles.deleteBtn}
								onClick={(e) => { e.stopPropagation(); onDeleteCommit(commit.sha); }}
								title={t('memory.delete')}
							>
								×
							</button>
						</div>
					))
				)}
			</div>
		</div>
	);
};

// Стили списка коммитов — плоский дизайн, разделители вместо рамок, акцент на выделенном.
const styles: Record<string, React.CSSProperties> = {
	container: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
	},
	// Компактная строка поиска над списком.
	searchRow: {
		display: 'flex',
		gap: '6px',
		padding: '10px 14px',
		borderBottom: '1px solid color-mix(in srgb, var(--vscode-foreground) 6%, transparent)',
		background: 'color-mix(in srgb, var(--vscode-foreground) 2%, transparent)',
	},
	searchInput: {
		flex: 1,
		minWidth: 0,
		background: 'var(--vscode-input-background)',
		color: 'var(--vscode-input-foreground)',
		border: '1px solid color-mix(in srgb, var(--vscode-foreground) 10%, transparent)',
		borderRadius: '8px',
		padding: '7px 12px',
		fontSize: '12px',
		transition: 'border-color 160ms ease',
	},
	// Заголовок со счётчиком и кнопкой фильтров.
	header: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
		padding: '16px 20px',
		borderBottom: '1px solid color-mix(in srgb, var(--vscode-foreground) 6%, transparent)',
	},
	count: {
		fontSize: '11px',
		fontWeight: 700,
		color: 'var(--vscode-descriptionForeground)',
		letterSpacing: '0.04em',
		textTransform: 'uppercase',
	},
	// Блок фильтров — мягкий фон, компактные отступы.
	filters: {
		padding: '16px 20px',
		borderBottom: '1px solid color-mix(in srgb, var(--vscode-foreground) 6%, transparent)',
		display: 'flex',
		flexDirection: 'column',
		gap: '8px',
		background: 'color-mix(in srgb, var(--vscode-foreground) 2%, transparent)',
	},
	filterLabel: {
		fontSize: '10px',
		fontWeight: 700,
		color: 'var(--vscode-descriptionForeground)',
		textTransform: 'uppercase',
		letterSpacing: '0.06em',
		marginTop: '4px',
	},
	// Select-фильтр — плоский, тонкая рамка.
	filterSelect: {
		background: 'var(--vscode-input-background)',
		color: 'var(--vscode-input-foreground)',
		border: '1px solid color-mix(in srgb, var(--vscode-foreground) 10%, transparent)',
		borderRadius: '8px',
		padding: '7px 12px',
		fontSize: '12px',
		transition: 'border-color 160ms ease',
	},
	// Инпут даты — аналогичный стиль.
	filterInput: {
		background: 'var(--vscode-input-background)',
		color: 'var(--vscode-input-foreground)',
		border: '1px solid color-mix(in srgb, var(--vscode-foreground) 10%, transparent)',
		borderRadius: '8px',
		padding: '7px 12px',
		fontSize: '12px',
		transition: 'border-color 160ms ease',
	},
	// Скроллируемый список коммитов.
	list: {
		flex: 1,
		overflow: 'auto',
		padding: '8px 12px',
		display: 'flex',
		flexDirection: 'column',
		gap: '2px',
	},
	empty: {
		padding: '40px 20px',
		textAlign: 'center' as const,
		color: 'var(--vscode-descriptionForeground)',
		fontSize: '12px',
		lineHeight: 1.6,
	},
	// Элемент коммита — без рамки, чистый hover.
	item: {
		padding: '12px 14px',
		cursor: 'pointer',
		position: 'relative' as const,
		borderRadius: '8px',
		border: 'none',
		background: 'transparent',
		transition: 'background-color 160ms ease',
	},
	// Выделенный коммит — левый акцентный бордер, мягкий фон.
	itemSelected: {
		background: 'color-mix(in srgb, var(--vscode-button-background) 8%, transparent)',
		borderLeft: '3px solid var(--vscode-button-background)',
		paddingLeft: '11px',
	},
	itemHeader: {
		display: 'flex',
		gap: '8px',
		alignItems: 'center',
		marginBottom: '4px',
	},
	sha: {
		fontFamily: 'var(--vscode-editor-font-family)',
		fontSize: '11px',
		fontWeight: 600,
		color: 'var(--vscode-textLink-foreground)',
	},
	// Бейдж типа коммита — плоский прямоугольник с мягким фоном.
	commitType: {
		fontSize: '10px',
		padding: '2px 7px',
		borderRadius: '6px',
		background: 'color-mix(in srgb, var(--vscode-button-background) 10%, transparent)',
		color: 'var(--vscode-foreground)',
		fontWeight: 700,
		textTransform: 'uppercase',
		letterSpacing: '0.04em',
	},
	date: {
		fontSize: '10px',
		color: 'var(--vscode-descriptionForeground)',
		marginLeft: 'auto',
		fontVariantNumeric: 'tabular-nums',
	},
	message: {
		fontSize: '12px',
		fontWeight: 600,
		lineHeight: 1.45,
		whiteSpace: 'nowrap' as const,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	},
	meta: {
		fontSize: '11px',
		color: 'var(--vscode-descriptionForeground)',
		marginTop: '3px',
		lineHeight: 1.45,
	},
	// Кнопка удаления — компактная, скрытая по-умолчанию.
	deleteBtn: {
		position: 'absolute' as const,
		top: '10px',
		right: '10px',
		background: 'none',
		border: 'none',
		color: 'var(--vscode-errorForeground)',
		cursor: 'pointer',
		fontSize: '14px',
		padding: '2px 6px',
		opacity: 0.4,
		borderRadius: '6px',
		transition: 'opacity 160ms ease',
	},
};
