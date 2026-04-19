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

// Стили панели поиска — плоский дизайн, чистые инпуты, минималистичные результаты.
const styles: Record<string, React.CSSProperties> = {
	container: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		padding: '24px',
	},
	form: {
		display: 'flex',
		gap: '8px',
		marginBottom: '20px',
		flexShrink: 0,
	},
	// Поле ввода поиска — плоское, тонкая рамка.
	input: {
		flex: 1,
		padding: '10px 14px',
		background: 'var(--vscode-input-background)',
		color: 'var(--vscode-input-foreground)',
		border: '1px solid color-mix(in srgb, var(--vscode-foreground) 10%, transparent)',
		borderRadius: '8px',
		fontSize: '13px',
		fontFamily: 'var(--vscode-font-family)',
		transition: 'border-color 160ms ease',
	},
	results: {
		flex: 1,
		overflow: 'auto',
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
	},
	resultHeader: {
		fontSize: '11px',
		fontWeight: 700,
		color: 'var(--vscode-descriptionForeground)',
		marginBottom: '8px',
		display: 'flex',
		gap: '8px',
		alignItems: 'center',
		letterSpacing: '0.04em',
		textTransform: 'uppercase',
	},
	// Тег запроса — плоский бейдж.
	queryTag: {
		padding: '2px 8px',
		borderRadius: '6px',
		background: 'color-mix(in srgb, var(--vscode-button-background) 10%, transparent)',
		color: 'var(--vscode-foreground)',
		fontSize: '11px',
		fontWeight: 600,
		textTransform: 'none',
		letterSpacing: 'normal',
	},
	empty: {
		textAlign: 'center' as const,
		color: 'var(--vscode-descriptionForeground)',
		padding: '40px 20px',
		fontSize: '12px',
		lineHeight: 1.6,
	},
	// Карточка результата — без рамки, только нижний разделитель.
	resultItem: {
		padding: '14px 16px',
		background: 'transparent',
		borderBottom: '1px solid color-mix(in srgb, var(--vscode-foreground) 6%, transparent)',
		borderRadius: '0',
		cursor: 'pointer',
		transition: 'background-color 160ms ease',
	},
	resultHeader2: {
		display: 'flex',
		gap: '8px',
		alignItems: 'center',
		marginBottom: '6px',
	},
	sha: {
		fontFamily: 'var(--vscode-editor-font-family)',
		fontSize: '11px',
		fontWeight: 600,
		color: 'var(--vscode-textLink-foreground)',
	},
	// Бейдж релевантности — плоский, мягкий зелёный.
	score: {
		fontSize: '10px',
		padding: '2px 7px',
		borderRadius: '6px',
		background: 'color-mix(in srgb, var(--vscode-testing-iconPassed) 12%, transparent)',
		color: 'var(--vscode-foreground)',
		fontWeight: 700,
		fontVariantNumeric: 'tabular-nums',
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
		marginBottom: '4px',
	},
	summary: {
		fontSize: '12px',
		lineHeight: 1.55,
		color: 'var(--vscode-descriptionForeground)',
		marginBottom: '4px',
	},
	meta: {
		fontSize: '11px',
		color: 'var(--vscode-descriptionForeground)',
		display: 'flex',
		gap: '8px',
		alignItems: 'center',
		lineHeight: 1.45,
	},
	cats: {
		fontSize: '10px',
		fontStyle: 'italic' as const,
		opacity: 0.7,
	},
};
