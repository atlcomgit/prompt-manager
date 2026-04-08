import React, { type CSSProperties } from 'react';
import type { PromptContextFileCard } from '../../../types/prompt.js';
import { useT } from '../../shared/i18n';

interface Props {
	file: PromptContextFileCard;
	onOpen: () => void;
	onRemove: () => void;
}

function formatModifiedAt(value?: string): string {
	if (!value) {
		return '—';
	}

	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}

	return date.toLocaleString();
}

function buildTooltip(file: PromptContextFileCard, t: (key: string) => string): string {
	const lines = [file.displayName, `${t('editor.contextFilePath')}: ${file.path}`];
	lines.push(`${t('editor.contextFileType')}: ${file.typeLabel}`);
	if (file.sizeLabel && file.sizeLabel !== '…') {
		lines.push(`${t('editor.contextFileSize')}: ${file.sizeLabel}`);
	}
	if (file.modifiedAt) {
		lines.push(`${t('editor.contextFileModified')}: ${formatModifiedAt(file.modifiedAt)}`);
	}
	if (!file.exists) {
		lines.push(t('editor.contextFileMissingHint'));
	}
	return lines.join('\n');
}

export const ContextFileCard: React.FC<Props> = ({ file, onOpen, onRemove }) => {
	const t = useT();
	const rootLabel = file.directoryLabel || t('editor.contextFileRoot');
	const tooltip = buildTooltip(file, t);
	const previewUnavailable = !file.previewUri || (file.kind !== 'image' && file.kind !== 'video');

	return (
		<div style={{ ...styles.card, ...(file.exists ? null : styles.cardMissing) }}>
			<button
				type="button"
				style={{ ...styles.cardAction, ...(file.exists ? null : styles.cardActionDisabled) }}
				onClick={onOpen}
				title={tooltip}
				disabled={!file.exists}
				aria-label={`${t('editor.openInEditor')} ${file.displayName}`}
			>
				<div style={styles.previewFrame}>
					{previewUnavailable ? (
						<div style={styles.tile}>
							<div style={styles.tileLabel}>{file.tileLabel}</div>
							<div style={styles.tileType}>{file.typeLabel}</div>
						</div>
					) : file.kind === 'image' ? (
						<img src={file.previewUri} alt={file.displayName} style={styles.imagePreview} />
					) : (
						<video src={file.previewUri} muted playsInline preload="metadata" style={styles.videoPreview} />
					)}
				</div>
				<div style={styles.content}>
					<div style={styles.headerRow}>
						<div style={styles.fileName}>{file.displayName}</div>
						{!file.exists ? <span style={styles.missingBadge}>{t('editor.contextFileMissing')}</span> : null}
					</div>
					<div style={styles.metaRow}>
						<span>{file.sizeLabel}</span>
						<span>{file.typeLabel}</span>
					</div>
					<div style={styles.pathRow}>{rootLabel}</div>
				</div>
			</button>
			<button
				type="button"
				style={styles.removeButton}
				onClick={onRemove}
				title={t('common.remove')}
				aria-label={t('common.remove')}
			>
				✕
			</button>
		</div>
	);
};

const styles: Record<string, CSSProperties> = {
	card: {
		position: 'relative',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '10px',
		background: 'var(--vscode-input-background)',
		overflow: 'hidden',
		minWidth: 0,
		boxShadow: '0 8px 20px rgba(0, 0, 0, 0.08)',
	},
	cardMissing: {
		opacity: 0.82,
	},
	cardAction: {
		display: 'flex',
		flexDirection: 'column',
		width: '100%',
		padding: 0,
		border: 'none',
		background: 'transparent',
		color: 'inherit',
		cursor: 'pointer',
		textAlign: 'left',
		transition: 'transform 120ms ease, box-shadow 120ms ease, background-color 120ms ease',
	},
	cardActionDisabled: {
		cursor: 'default',
	},
	previewFrame: {
		height: '112px',
		borderBottom: '1px solid var(--vscode-panel-border)',
		background: 'color-mix(in srgb, var(--vscode-editor-background) 72%, var(--vscode-input-background))',
		overflow: 'hidden',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
	},
	imagePreview: {
		display: 'block',
		width: '100%',
		height: '100%',
		objectFit: 'cover',
	},
	videoPreview: {
		display: 'block',
		width: '100%',
		height: '100%',
		objectFit: 'cover',
		background: 'var(--vscode-editor-background)',
	},
	tile: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		justifyContent: 'center',
		width: '100%',
		height: '100%',
		padding: '12px',
		gap: '8px',
		textAlign: 'center',
	},
	tileLabel: {
		fontSize: '24px',
		lineHeight: 1,
		fontWeight: 700,
		letterSpacing: '0.08em',
		color: 'var(--vscode-foreground)',
	},
	tileType: {
		fontSize: '11px',
		lineHeight: 1.35,
		color: 'var(--vscode-descriptionForeground)',
		textTransform: 'uppercase',
		letterSpacing: '0.08em',
	},
	content: {
		display: 'flex',
		flexDirection: 'column',
		gap: '6px',
		padding: '12px',
	},
	headerRow: {
		display: 'flex',
		alignItems: 'flex-start',
		gap: '8px',
	},
	fileName: {
		flex: 1,
		fontSize: '13px',
		lineHeight: 1.4,
		fontWeight: 600,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	},
	missingBadge: {
		padding: '2px 6px',
		borderRadius: '999px',
		fontSize: '10px',
		lineHeight: 1.2,
		fontWeight: 600,
		color: 'var(--vscode-errorForeground)',
		background: 'color-mix(in srgb, var(--vscode-errorForeground) 14%, transparent)',
		border: '1px solid color-mix(in srgb, var(--vscode-errorForeground) 32%, transparent)',
		flexShrink: 0,
	},
	metaRow: {
		display: 'flex',
		flexWrap: 'wrap',
		gap: '8px',
		fontSize: '11px',
		lineHeight: 1.4,
		color: 'var(--vscode-descriptionForeground)',
	},
	pathRow: {
		fontSize: '11px',
		lineHeight: 1.4,
		color: 'var(--vscode-descriptionForeground)',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	},
	removeButton: {
		position: 'absolute',
		top: '8px',
		right: '8px',
		width: '28px',
		height: '28px',
		borderRadius: '999px',
		border: '1px solid color-mix(in srgb, var(--vscode-panel-border) 85%, transparent)',
		background: 'color-mix(in srgb, var(--vscode-editor-background) 90%, transparent)',
		color: 'var(--vscode-errorForeground)',
		cursor: 'pointer',
		fontSize: '12px',
		lineHeight: 1,
		padding: 0,
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
	},
};