/**
 * CommitDetail — Shows full details of a selected commit:
 * message, metadata, file changes, AI analysis, and bug relations.
 */

import React from 'react';
import type { MemoryCommit, MemoryFileChange, MemoryAnalysis, MemoryBugRelation } from '../../../types/memory';
import { renderAsciiTreeLines } from '../../../utils/asciiTree.js';

const FILE_TREE_INTERACTION_STYLES = `
	.pm-memory-file-link {
		transition:
			transform 120ms ease,
			background-color 140ms ease,
			color 140ms ease,
			box-shadow 140ms ease;
		border-radius: 6px;
	}

	.pm-memory-file-link:hover {
		background: color-mix(in srgb, var(--vscode-list-hoverBackground) 72%, transparent);
		color: var(--vscode-textLink-foreground);
		transform: translateX(2px);
	}

	.pm-memory-file-link:active {
		transform: translateX(1px) scale(0.985);
		background: color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 32%, transparent);
	}

	.pm-memory-file-link:focus-visible {
		outline: 1px solid var(--vscode-focusBorder);
		outline-offset: 1px;
	}
`;

interface Props {
	commit: MemoryCommit;
	fileChanges: MemoryFileChange[];
	analysis?: MemoryAnalysis;
	bugRelations: MemoryBugRelation[];
	t: (key: string) => string;
	onOpenFile?: (repository: string, filePath: string) => void;
}

export const CommitDetail: React.FC<Props> = ({ commit, fileChanges, analysis, bugRelations, t, onOpenFile }) => {
	const fileTreeLines = renderAsciiTreeLines(fileChanges.map(fileChange => ({
		path: fileChange.filePath.replace(/\\/g, '/'),
		kind: 'file',
	})));
	const fileStatuses = new Map(
		fileChanges.map(fileChange => [fileChange.filePath.replace(/\\/g, '/'), getFileStatusLetter(fileChange.changeType)]),
	);

	return (
		<div style={styles.container}>
			<style>{FILE_TREE_INTERACTION_STYLES}</style>
			{/* Commit header */}
			<div style={styles.section}>
				<h3 style={styles.heading}>{commit.sha.substring(0, 7)} — {commit.commitType}</h3>
				<div style={styles.meta}>
					<span>{commit.author} &lt;{commit.email}&gt;</span>
					<span>{commit.date.substring(0, 19).replace('T', ' ')}</span>
				</div>
				<div style={styles.meta}>
					<span>{t('memory.branch')}: {commit.branch}</span>
					<span>{t('memory.repository')}: {commit.repository}</span>
				</div>
				<pre style={styles.message}>{commit.message}</pre>
			</div>

			{/* AI Analysis */}
			{analysis && (
				<div style={styles.section}>
					<h4 style={styles.subHeading}>{t('memory.analysis')}</h4>
					<p style={styles.summary}>{analysis.summary}</p>

					{analysis.keyInsights.length > 0 && (
						<div style={styles.block}>
							<span style={styles.label}>{t('memory.insights')}:</span>
							<ul style={styles.list}>
								{analysis.keyInsights.map((ins, i) => <li key={i}>{ins}</li>)}
							</ul>
						</div>
					)}

					<div style={styles.tags}>
						{analysis.categories.map(c => (
							<span key={c} style={styles.tag}>{c}</span>
						))}
						{analysis.layers.map(l => (
							<span key={l} style={{ ...styles.tag, ...styles.tagLayer }}>{l}</span>
						))}
					</div>

					{analysis.keywords.length > 0 && (
						<div style={styles.keywords}>
							{analysis.keywords.map(k => (
								<span key={k} style={styles.keyword}>{k}</span>
							))}
						</div>
					)}

					{analysis.architectureImpact && (
						<div style={styles.block}>
							<span style={styles.label}>
								{t('memory.architectureImpact')} ({analysis.architectureImpactScore}/10):
							</span>
							<p style={styles.text}>{analysis.architectureImpact}</p>
						</div>
					)}

					{analysis.businessDomains.length > 0 && (
						<div style={styles.block}>
							<span style={styles.label}>{t('memory.domains')}:</span>
							<span>{analysis.businessDomains.join(', ')}</span>
						</div>
					)}

					{analysis.isBreakingChange && (
						<div style={styles.warning}>⚠ {t('memory.breakingChange')}</div>
					)}
				</div>
			)}

			{/* File changes */}
			{fileChanges.length > 0 && (
				<div style={styles.section}>
					<h4 style={styles.subHeading}>
						{t('memory.fileChanges')} ({fileChanges.length})
					</h4>
					<div style={styles.fileTree}>
						{fileTreeLines.map((line) => {
							const status = line.kind === 'file' ? fileStatuses.get(line.path) : undefined;
							const isFile = line.kind === 'file';
							// prefix содержит отступы (│   /    ), connector — ├── /└── .
							// Рендерим как pre-текст моноширинным шрифтом — гарантированно ровное выравнивание.
							const prefixText = line.prefix + line.connector;
							return (
								<div key={`${line.path}-${line.depth}`} style={styles.fileTreeRow}>
									{prefixText && (
										<span style={styles.fileTreePrefix}>{prefixText}</span>
									)}
									{isFile ? (
										<button
											type="button"
											style={styles.fileTreeButton}
											className="pm-memory-file-link"
											onClick={() => onOpenFile?.(commit.repository, line.path)}
											title={line.path}
										>
											<span style={styles.fileTreeLabel}>{line.label}</span>
										</button>
									) : (
										<span style={styles.fileTreeLabel}>{line.label}</span>
									)}
									{status && <span style={getStatusBadgeStyle(status)}>{status}</span>}
								</div>
							);
						})}
					</div>
				</div>
			)}

			{/* Bug relations */}
			{bugRelations.length > 0 && (
				<div style={styles.section}>
					<h4 style={styles.subHeading}>{t('memory.bugRelations')}</h4>
					{bugRelations.map((br, i) => (
						<div key={i} style={styles.bugRelation}>
							<span style={styles.label}>
								{t('memory.fixes')}: {br.sourceCommitSha.substring(0, 7)}
							</span>
							<p style={styles.text}>{br.description}</p>
						</div>
					))}
				</div>
			)}
		</div>
	);
};

function getFileStatusLetter(changeType: MemoryFileChange['changeType']): string {
	switch (changeType) {
		case 'added':
			return 'A';
		case 'deleted':
			return 'D';
		case 'renamed':
			return 'R';
		case 'copied':
			return 'C';
		case 'modified':
		default:
			return 'M';
	}
}

function getStatusBadgeStyle(status: string): React.CSSProperties {
	const backgroundByStatus: Record<string, string> = {
		A: 'var(--vscode-testing-iconPassed)',
		M: 'var(--vscode-gitDecoration-modifiedResourceForeground)',
		D: 'var(--vscode-gitDecoration-deletedResourceForeground)',
		R: 'var(--vscode-gitDecoration-renamedResourceForeground)',
		C: 'var(--vscode-gitDecoration-addedResourceForeground)',
	};

	return {
		...styles.fileStatusBadge,
		borderColor: backgroundByStatus[status] || 'var(--vscode-panel-border)',
		color: backgroundByStatus[status] || 'var(--vscode-foreground)',
	};
}

const styles: Record<string, React.CSSProperties> = {
	container: { padding: '16px', overflow: 'auto' },
	section: {
		marginBottom: '16px', padding: '12px',
		background: 'var(--vscode-editor-background)',
		border: '1px solid var(--vscode-panel-border)', borderRadius: '4px',
	},
	heading: { margin: '0 0 8px 0', fontSize: '14px' },
	subHeading: { margin: '0 0 8px 0', fontSize: '13px', color: 'var(--vscode-foreground)' },
	meta: {
		display: 'flex', justifyContent: 'space-between',
		fontSize: '12px', color: 'var(--vscode-descriptionForeground)', marginBottom: '4px',
	},
	message: {
		margin: '8px 0 0 0', padding: '8px',
		background: 'var(--vscode-textCodeBlock-background)', borderRadius: '3px',
		fontSize: '12px', fontFamily: 'var(--vscode-editor-font-family)',
		whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const,
	},
	summary: { margin: '0 0 8px 0', fontSize: '13px' },
	block: { marginTop: '8px' },
	label: { fontSize: '12px', fontWeight: 600, color: 'var(--vscode-descriptionForeground)' },
	text: { margin: '4px 0', fontSize: '12px' },
	list: { margin: '4px 0', paddingLeft: '20px', fontSize: '12px' },
	tags: { display: 'flex', flexWrap: 'wrap' as const, gap: '4px', marginTop: '8px' },
	tag: {
		fontSize: '10px', padding: '2px 6px', borderRadius: '3px',
		background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)',
	},
	tagLayer: {
		background: 'var(--vscode-editorInfo-background)',
	},
	keywords: { display: 'flex', flexWrap: 'wrap' as const, gap: '4px', marginTop: '8px' },
	keyword: {
		fontSize: '10px', padding: '1px 4px', borderRadius: '2px',
		background: 'var(--vscode-textCodeBlock-background)', color: 'var(--vscode-foreground)',
	},
	warning: {
		marginTop: '8px', padding: '6px 10px', borderRadius: '3px',
		background: 'var(--vscode-inputValidation-warningBackground)',
		color: 'var(--vscode-inputValidation-warningForeground)',
		fontSize: '12px',
	},
	fileTree: {
		margin: 0,
		padding: '10px 12px',
		background: 'var(--vscode-textCodeBlock-background)',
		borderRadius: '4px',
		border: '1px solid var(--vscode-panel-border)',
		display: 'flex',
		flexDirection: 'column' as const,
		// Явно указываем моноширинные шрифты с поддержкой Unicode box-drawing символов,
		// чтобы │, ─, ├, └ выглядели ровно вне зависимости от системного шрифта.
		fontFamily: '"JetBrains Mono", "DejaVu Sans Mono", "Fira Code", monospace',
	},
	fileTreeRow: {
		display: 'flex',
		alignItems: 'baseline',
		minHeight: '20px',
	},
	// Префикс (отступы + коннектор) в режиме pre — символы моноширинные и выровнены строго.
	fileTreePrefix: {
		fontSize: '12px',
		lineHeight: 1.6,
		whiteSpace: 'pre' as const,
		color: 'var(--vscode-descriptionForeground)',
		flexShrink: 0,
	},
	fileTreeLabel: {
		fontSize: '12px',
		lineHeight: 1.6,
		wordBreak: 'break-word' as const,
	},
	fileTreeButton: {
		padding: 0,
		margin: 0,
		border: 'none',
		background: 'transparent',
		color: 'inherit',
		font: 'inherit',
		textAlign: 'left' as const,
		cursor: 'pointer',
		minWidth: 0,
		flex: 1,
	},
	fileStatusBadge: {
		marginLeft: 'auto',
		padding: '1px 7px',
		borderRadius: '999px',
		border: '1px solid var(--vscode-panel-border)',
		fontSize: '10px',
		fontWeight: 700,
		fontFamily: 'var(--vscode-editor-font-family)',
		background: 'color-mix(in srgb, var(--vscode-editor-background) 82%, transparent)',
		flexShrink: 0,
	},
	bugRelation: {
		padding: '6px', marginBottom: '4px',
		background: 'var(--vscode-textCodeBlock-background)', borderRadius: '3px',
	},
};
