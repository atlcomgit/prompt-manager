/**
 * SearchPanel — Full-text and semantic search across memory commits.
 */

import React, { useState, useCallback } from 'react';
import type { MemorySearchResult } from '../../../types/memory';
import { memoryButtonStyles } from './buttonStyles';

interface Props {
	results: MemorySearchResult[];
	query: string;
	onSearch: (query: string) => void;
	onSelectCommit: (sha: string) => void;
	t: (key: string) => string;
}

export const SearchPanel: React.FC<Props> = ({ results, query, onSearch, onSelectCommit, t }) => {
	const [input, setInput] = useState(query);

	const handleSubmit = useCallback((e: React.FormEvent) => {
		e.preventDefault();
		if (input.trim()) {
			onSearch(input.trim());
		}
	}, [input, onSearch]);

	return (
		<div style={styles.container}>
			{/* Search form */}
			<form onSubmit={handleSubmit} style={styles.form}>
				<input
					type="text"
					style={styles.input}
					value={input}
					onChange={e => setInput(e.target.value)}
					placeholder={t('memory.searchPlaceholder')}
				/>
				<button type="submit" style={memoryButtonStyles.primary}>
					{t('memory.search')}
				</button>
			</form>

			{/* Results */}
			<div style={styles.results}>
				{query && (
					<div style={styles.resultHeader}>
						{t('memory.searchResults')}: {results.length}
						{query && <span style={styles.queryTag}>"{query}"</span>}
					</div>
				)}

				{results.length === 0 && query && (
					<div style={styles.empty}>{t('memory.noResults')}</div>
				)}

				{results.map(result => (
					<div
						key={result.commit.sha}
						style={styles.resultItem}
						onClick={() => onSelectCommit(result.commit.sha)}
					>
						<div style={styles.resultHeader2}>
							<span style={styles.sha}>{result.commit.sha.substring(0, 7)}</span>
							<span style={styles.score}>{(result.score * 100).toFixed(0)}%</span>
							<span style={styles.date}>{result.commit.date.substring(0, 10)}</span>
						</div>
						<div style={styles.message}>
							{result.commit.message.split('\n')[0]}
						</div>
						{result.analysis?.summary && (
							<div style={styles.summary}>{result.analysis.summary}</div>
						)}
						<div style={styles.meta}>
							{result.commit.author} · {result.commit.branch}
							{result.analysis?.categories && (
								<span style={styles.cats}>
									{result.analysis.categories.join(', ')}
								</span>
							)}
						</div>
					</div>
				))}
			</div>
		</div>
	);
};

const styles: Record<string, React.CSSProperties> = {
	container: { display: 'flex', flexDirection: 'column', height: '100%', padding: '16px' },
	form: { display: 'flex', gap: '8px', marginBottom: '12px', flexShrink: 0 },
	input: {
		flex: 1, padding: '6px 10px',
		background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
		border: '1px solid var(--vscode-input-border)', borderRadius: '4px', fontSize: '13px',
	},
	results: { flex: 1, overflow: 'auto' },
	resultHeader: {
		fontSize: '12px', color: 'var(--vscode-descriptionForeground)',
		marginBottom: '8px', display: 'flex', gap: '8px', alignItems: 'center',
	},
	queryTag: {
		padding: '2px 6px', borderRadius: '3px',
		background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)',
		fontSize: '11px',
	},
	empty: { textAlign: 'center' as const, color: 'var(--vscode-descriptionForeground)', padding: '24px' },
	resultItem: {
		padding: '10px 12px', marginBottom: '4px',
		background: 'var(--vscode-editor-background)',
		border: '1px solid var(--vscode-panel-border)', borderRadius: '4px',
		cursor: 'pointer',
	},
	resultHeader2: {
		display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '4px',
	},
	sha: {
		fontFamily: 'var(--vscode-editor-font-family)', fontSize: '12px',
		color: 'var(--vscode-textLink-foreground)',
	},
	score: {
		fontSize: '10px', padding: '1px 4px', borderRadius: '3px',
		background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)',
	},
	date: { fontSize: '11px', color: 'var(--vscode-descriptionForeground)', marginLeft: 'auto' },
	message: { fontSize: '13px', marginBottom: '4px' },
	summary: { fontSize: '12px', color: 'var(--vscode-descriptionForeground)', marginBottom: '4px' },
	meta: {
		fontSize: '11px', color: 'var(--vscode-descriptionForeground)',
		display: 'flex', gap: '8px', alignItems: 'center',
	},
	cats: { fontSize: '10px', fontStyle: 'italic' as const },
};
