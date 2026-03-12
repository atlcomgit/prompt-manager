import React from 'react';
import type { CSSProperties } from 'react';

import type {
	MemoryAnalysis,
	MemoryBugRelation,
	MemoryCommit,
	MemoryFileChange,
} from '../../../types/memory';
import { CommitDetail } from './CommitDetail';
import { memoryButtonStyles } from './buttonStyles';

interface Props {
	open: boolean;
	title: string;
	loading: boolean;
	commit: MemoryCommit | null;
	fileChanges: MemoryFileChange[];
	analysis?: MemoryAnalysis;
	bugRelations: MemoryBugRelation[];
	onClose: () => void;
	onOpenFile?: (repository: string, filePath: string) => void;
	t: (key: string) => string;
}

export const CommitDetailDialog: React.FC<Props> = ({
	open,
	title,
	loading,
	commit,
	fileChanges,
	analysis,
	bugRelations,
	onClose,
	onOpenFile,
	t,
}) => {
	if (!open) {
		return null;
	}

	return (
		<div style={styles.backdrop}>
			<div style={styles.dialog}>
				<div style={styles.header}>
					<div>
						<h3 style={styles.title}>{title}</h3>
						<div style={styles.subtitle}>
							{commit ? `${commit.repository} · ${commit.sha.substring(0, 7)}` : t('memory.analysisDetailLoading')}
						</div>
					</div>
					<button style={memoryButtonStyles.secondary} onClick={onClose}>
						{t('common.close')}
					</button>
				</div>

				<div style={styles.body}>
					{loading || !commit ? (
						<div style={styles.loading}>{t('memory.analysisDetailLoading')}</div>
					) : (
						<CommitDetail
							commit={commit}
							fileChanges={fileChanges}
							analysis={analysis}
							bugRelations={bugRelations}
							onOpenFile={onOpenFile}
							t={t}
						/>
					)}
				</div>
			</div>
		</div>
	);
};

const styles: Record<string, CSSProperties> = {
	backdrop: {
		position: 'absolute',
		inset: 0,
		background: 'color-mix(in srgb, rgba(0, 0, 0, 0.42) 75%, transparent)',
		zIndex: 60,
		padding: '36px',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
	},
	dialog: {
		width: 'min(1000px, 100%)',
		height: 'min(88vh, 100%)',
		background: 'var(--vscode-editor-background)',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '10px',
		boxShadow: '0 24px 60px rgba(0, 0, 0, 0.34)',
		display: 'flex',
		flexDirection: 'column',
		overflow: 'hidden',
	},
	header: {
		display: 'flex',
		justifyContent: 'space-between',
		gap: '16px',
		alignItems: 'flex-start',
		padding: '16px 18px 12px',
		borderBottom: '1px solid var(--vscode-panel-border)',
		flexShrink: 0,
	},
	title: {
		margin: 0,
		fontSize: '16px',
	},
	subtitle: {
		marginTop: '6px',
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
	},
	body: {
		flex: 1,
		minHeight: 0,
		overflow: 'auto',
	},
	loading: {
		height: '100%',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		color: 'var(--vscode-descriptionForeground)',
		fontSize: '13px',
		padding: '24px',
	},
};