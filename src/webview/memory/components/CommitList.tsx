/**
 * CommitList — Displays a filterable, scrollable list of memory commits.
 */

import React, { useState } from 'react';
import type { MemoryCommit, MemoryFilter } from '../../../types/memory';

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
	t: (key: string) => string;
}

export const CommitList: React.FC<Props> = ({
	commits, total, filter, onFilterChange, onSelectCommit,
	onDeleteCommit, selectedSha, authors, branches, categories,
	repositories, t,
}) => {
	const [showFilters, setShowFilters] = useState(false);

	/** Update a single filter field */
	const updateFilter = (key: keyof MemoryFilter, value: any) => {
		onFilterChange({ ...filter, [key]: value || undefined });
	};

	return (
		<div style={styles.container}>
			{/* Header with count and filter toggle */}
			<div style={styles.header}>
				<span style={styles.count}>
					{t('memory.commits')}: {total}
				</span>
				<button style={styles.filterBtn} onClick={() => setShowFilters(!showFilters)}>
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
						style={styles.resetBtn}
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

const styles: Record<string, React.CSSProperties> = {
	container: { display: 'flex', flexDirection: 'column', height: '100%' },
	header: {
		display: 'flex', justifyContent: 'space-between', alignItems: 'center',
		padding: '8px 12px', borderBottom: '1px solid var(--vscode-panel-border)',
	},
	count: { fontSize: '12px', color: 'var(--vscode-descriptionForeground)' },
	filterBtn: {
		background: 'none', border: 'none', color: 'var(--vscode-textLink-foreground)',
		cursor: 'pointer', fontSize: '12px',
	},
	filters: {
		padding: '8px 12px', borderBottom: '1px solid var(--vscode-panel-border)',
		display: 'flex', flexDirection: 'column', gap: '4px',
	},
	filterLabel: { fontSize: '11px', color: 'var(--vscode-descriptionForeground)', marginTop: '4px' },
	filterSelect: {
		background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
		border: '1px solid var(--vscode-input-border)', borderRadius: '3px',
		padding: '3px 6px', fontSize: '12px',
	},
	filterInput: {
		background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
		border: '1px solid var(--vscode-input-border)', borderRadius: '3px',
		padding: '3px 6px', fontSize: '12px',
	},
	resetBtn: {
		background: 'var(--vscode-button-secondaryBackground)',
		color: 'var(--vscode-button-secondaryForeground)',
		border: 'none', borderRadius: '3px', padding: '4px 8px',
		cursor: 'pointer', fontSize: '12px', marginTop: '6px', alignSelf: 'flex-start',
	},
	list: { flex: 1, overflow: 'auto' },
	empty: {
		padding: '24px', textAlign: 'center' as const,
		color: 'var(--vscode-descriptionForeground)',
	},
	item: {
		padding: '8px 12px', cursor: 'pointer', position: 'relative' as const,
		borderBottom: '1px solid var(--vscode-panel-border)',
	},
	itemSelected: { background: 'var(--vscode-list-activeSelectionBackground)' },
	itemHeader: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '2px' },
	sha: {
		fontFamily: 'var(--vscode-editor-font-family)', fontSize: '12px',
		color: 'var(--vscode-textLink-foreground)',
	},
	commitType: {
		fontSize: '10px', padding: '1px 4px', borderRadius: '3px',
		background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)',
	},
	date: { fontSize: '11px', color: 'var(--vscode-descriptionForeground)', marginLeft: 'auto' },
	message: { fontSize: '13px', whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' },
	meta: { fontSize: '11px', color: 'var(--vscode-descriptionForeground)', marginTop: '2px' },
	deleteBtn: {
		position: 'absolute' as const, top: '8px', right: '8px',
		background: 'none', border: 'none', color: 'var(--vscode-errorForeground)',
		cursor: 'pointer', fontSize: '16px', padding: '0 4px', opacity: 0.6,
	},
};
