/**
 * CommitDetail — Shows full details of a selected commit:
 * message, metadata, file changes, AI analysis, and bug relations.
 */

import React from 'react';
import type { MemoryCommit, MemoryFileChange, MemoryAnalysis, MemoryBugRelation } from '../../../types/memory';

interface Props {
	commit: MemoryCommit;
	fileChanges: MemoryFileChange[];
	analysis?: MemoryAnalysis;
	bugRelations: MemoryBugRelation[];
	t: (key: string) => string;
}

export const CommitDetail: React.FC<Props> = ({ commit, fileChanges, analysis, bugRelations, t }) => {
	return (
		<div style={styles.container}>
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
					<div style={styles.fileList}>
						{fileChanges.map((f, i) => (
							<div key={i} style={styles.fileItem}>
								<span style={styles.fileStatus}>{f.changeType[0].toUpperCase()}</span>
								<span style={styles.filePath}>{f.filePath}</span>
							</div>
						))}
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
	fileList: { display: 'flex', flexDirection: 'column' as const, gap: '2px' },
	fileItem: { display: 'flex', gap: '8px', fontSize: '12px', padding: '2px 0' },
	fileStatus: {
		width: '16px', textAlign: 'center' as const, fontWeight: 600,
		color: 'var(--vscode-gitDecoration-modifiedResourceForeground)',
	},
	filePath: { fontFamily: 'var(--vscode-editor-font-family)', fontSize: '12px' },
	bugRelation: {
		padding: '6px', marginBottom: '4px',
		background: 'var(--vscode-textCodeBlock-background)', borderRadius: '3px',
	},
};
