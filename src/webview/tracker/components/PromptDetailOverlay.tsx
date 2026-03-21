import React, { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';

import type { Prompt, PromptConfig, PromptStatus } from '../../../types/prompt';
import { getVsCodeApi } from '../../shared/vscodeApi';
import { memoryButtonStyles } from '../../memory/components/buttonStyles';

interface Props {
	promptConfig: PromptConfig | null;
	prompt: Prompt | null;
	loading: boolean;
	onClose: () => void;
	onOpenPrompt: () => void;
	onOpenChat: () => void;
	onStartChat: () => void;
	t: (key: string) => string;
}

interface SectionProps {
	id: SectionId;
	title: string;
	open: boolean;
	onToggle: (id: SectionId) => void;
	children: React.ReactNode;
	t: (key: string) => string;
}

type SectionId = 'main' | 'context' | 'time' | 'content' | 'report';

const vscode = getVsCodeApi();
const TRACKER_OVERLAY_SECTIONS_STATE_KEY = 'trackerOverlaySections';

const STATUS_COLORS: Record<PromptStatus, string> = {
	draft: 'var(--vscode-descriptionForeground)',
	'in-progress': 'var(--vscode-editorInfo-foreground, #3794ff)',
	stopped: 'var(--vscode-editorWarning-foreground, #cca700)',
	cancelled: 'var(--vscode-errorForeground, #f44747)',
	completed: 'var(--vscode-testing-iconPassed, #73c991)',
	report: 'var(--vscode-textLink-foreground)',
	review: 'var(--vscode-editorWarning-foreground, #cca700)',
	closed: 'var(--vscode-disabledForeground)',
};

const STATUS_ICONS: Record<PromptStatus, string> = {
	draft: '📝',
	'in-progress': '🚀',
	stopped: '▣',
	cancelled: '❌',
	completed: '✅',
	report: '🧾',
	review: '🔎',
	closed: '🔒',
};

const createDefaultSections = (prompt: Prompt | null): Record<SectionId, boolean> => ({
	main: true,
	context: true,
	time: true,
	content: true,
	report: Boolean(prompt?.report?.trim()),
});

function readStoredSections(prompt: Prompt | null): Record<SectionId, boolean> {
	const state = vscode.getState() || {};
	const stored = state[TRACKER_OVERLAY_SECTIONS_STATE_KEY] as Record<SectionId, boolean> | undefined;
	if (!stored) {
		return createDefaultSections(prompt);
	}

	return {
		main: typeof stored.main === 'boolean' ? stored.main : true,
		context: typeof stored.context === 'boolean' ? stored.context : true,
		time: typeof stored.time === 'boolean' ? stored.time : true,
		content: typeof stored.content === 'boolean' ? stored.content : true,
		report: typeof stored.report === 'boolean' ? stored.report : Boolean(prompt?.report?.trim()),
	};
}

const statusTranslationKey = (status: PromptStatus): string => {
	if (status === 'in-progress') {
		return 'status.inProgress';
	}

	return `status.${status}`;
};

function formatDuration(ms: number): string {
	if (ms < 1000) {
		return '0с';
	}

	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}ч ${minutes}м ${seconds}с`;
	}

	if (minutes > 0) {
		return `${minutes}м ${seconds}с`;
	}

	return `${seconds}с`;
}

function formatDateTime(value: string): string {
	if (!value) {
		return '—';
	}

	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ru-RU');
}

function renderValue(value: string): string {
	return value.trim() || '—';
}

const Section: React.FC<SectionProps> = ({ id, title, open, onToggle, children, t }) => (
	<section style={styles.section}>
		<button
			type="button"
			style={styles.sectionToggle}
			onClick={() => onToggle(id)}
			title={open ? t('tracker.detail.collapse') : t('tracker.detail.expand')}
		>
			<div style={styles.sectionTitleWrap}>
				<span style={styles.sectionChevron}>{open ? '▾' : '▸'}</span>
				<span style={styles.sectionTitle}>{title}</span>
			</div>
		</button>
		{open ? <div style={styles.sectionBody}>{children}</div> : null}
	</section>
);

export const PromptDetailOverlay: React.FC<Props> = ({
	promptConfig,
	prompt,
	loading,
	onClose,
	onOpenPrompt,
	onOpenChat,
	onStartChat,
	t,
}) => {
	const [sections, setSections] = useState<Record<SectionId, boolean>>(() => readStoredSections(prompt));

	useEffect(() => {
		const state = vscode.getState() || {};
		vscode.setState({
			...state,
			[TRACKER_OVERLAY_SECTIONS_STATE_KEY]: sections,
		});
	}, [sections]);

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				onClose();
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [onClose]);

	const displayPrompt = prompt ?? promptConfig;
	const shouldShowOpenChat = Boolean(displayPrompt && displayPrompt.status !== 'draft' && displayPrompt.chatSessionIds.length > 0);
	const totalTime = useMemo(() => {
		if (!displayPrompt) {
			return 0;
		}

		return displayPrompt.timeSpentWriting
			+ displayPrompt.timeSpentImplementing
			+ displayPrompt.timeSpentOnTask
			+ displayPrompt.timeSpentUntracked;
	}, [displayPrompt]);

	if (!promptConfig) {
		return null;
	}

	const toggleSection = (id: SectionId) => {
		setSections(prev => ({ ...prev, [id]: !prev[id] }));
	};

	const statusColor = STATUS_COLORS[promptConfig.status];
	const statusLabel = `${STATUS_ICONS[promptConfig.status]} ${t(statusTranslationKey(promptConfig.status))}`;

	return (
		<div style={styles.backdrop} onClick={onClose}>
			<div style={styles.dialog} onClick={event => event.stopPropagation()}>
				<div style={styles.header}>
					<div style={styles.headerContent}>
						<div style={styles.headerBadges}>
							<span style={{ ...styles.statusBadge, background: `color-mix(in srgb, ${statusColor} 18%, transparent)`, color: statusColor, borderColor: `color-mix(in srgb, ${statusColor} 38%, transparent)` }}>
								{statusLabel}
							</span>
							<span style={styles.favoriteBadge}>{promptConfig.favorite ? `★ ${t('tracker.detail.favorite')}` : `☆ ${t('tracker.detail.notFavorite')}`}</span>
						</div>
						<h3 style={styles.title}>{renderValue(promptConfig.title || promptConfig.id)}</h3>
						<div style={styles.subtitle}>{t('tracker.detail.title')}</div>
					</div>
					<button type="button" style={styles.headerCloseButton} onClick={onClose}>
						{t('common.close')}
					</button>
				</div>

				<div style={styles.body}>
					<Section id="main" title={t('tracker.detail.main')} open={sections.main} onToggle={toggleSection} t={t}>
						<div style={styles.descriptionCard}>
							<div style={styles.descriptionLabel}>{t('tracker.detail.description')}</div>
							<div style={styles.descriptionText}>{renderValue(promptConfig.description)}</div>
						</div>
						<div style={styles.metaGrid}>
							<MetaItem label={t('tracker.detail.taskNumber')} value={renderValue(displayPrompt?.taskNumber || '')} />
							<MetaItem label={t('tracker.detail.branch')} value={renderValue(displayPrompt?.branch || '')} />
							<MetaItem label={t('tracker.detail.model')} value={renderValue(displayPrompt?.model || '')} />
							<MetaItem label={t('tracker.detail.chatMode')} value={displayPrompt?.chatMode === 'plan' ? t('editor.chatModePlan') : t('editor.chatModeAgent')} />
							<MetaItem label={t('tracker.detail.createdAt')} value={formatDateTime(displayPrompt?.createdAt || '')} />
							<MetaItem label={t('tracker.detail.updatedAt')} value={formatDateTime(displayPrompt?.updatedAt || '')} />
							<MetaItem label={t('tracker.detail.chatSessions')} value={String(displayPrompt?.chatSessionIds.length || 0)} />
							<MetaItem label={t('tracker.detail.promptUuid')} value={renderValue(displayPrompt?.promptUuid || '')} mono />
						</div>
					</Section>

					<Section id="context" title={t('tracker.detail.context')} open={sections.context} onToggle={toggleSection} t={t}>
						<div style={styles.contextGrid}>
							<TagGroup label={t('tracker.projects')} values={displayPrompt?.projects || []} t={t} />
							<TagGroup label={t('tracker.detail.languages')} values={displayPrompt?.languages || []} t={t} />
							<TagGroup label={t('tracker.detail.frameworks')} values={displayPrompt?.frameworks || []} t={t} />
							<TagGroup label={t('tracker.detail.skills')} values={displayPrompt?.skills || []} t={t} />
							<TagGroup label={t('tracker.detail.mcpTools')} values={displayPrompt?.mcpTools || []} t={t} />
							<TagGroup label={t('tracker.detail.hooks')} values={displayPrompt?.hooks || []} t={t} />
							<TagGroup label={t('tracker.detail.contextFiles')} values={displayPrompt?.contextFiles || []} mono t={t} />
							<MetaCard label={t('tracker.detail.httpExamples')} value={renderValue(displayPrompt?.httpExamples || '')} mono />
						</div>
					</Section>

					<Section id="time" title={t('tracker.detail.time')} open={sections.time} onToggle={toggleSection} t={t}>
						<div style={styles.timeGrid}>
							<TimeStat label={t('timer.writing')} value={formatDuration(displayPrompt?.timeSpentWriting || 0)} />
							<TimeStat label={t('timer.implementing')} value={formatDuration(displayPrompt?.timeSpentImplementing || 0)} />
							<TimeStat label={t('timer.taskWork')} value={formatDuration(displayPrompt?.timeSpentOnTask || 0)} />
							<TimeStat label={t('timer.untracked')} value={formatDuration(displayPrompt?.timeSpentUntracked || 0)} />
							<TimeStat label={t('timer.total')} value={formatDuration(totalTime)} accent />
						</div>
					</Section>

					<Section id="content" title={t('tracker.detail.content')} open={sections.content} onToggle={toggleSection} t={t}>
						<TextPanel
							loading={loading}
							loadingText={t('tracker.detail.loadingContent')}
							emptyText={t('tracker.detail.emptyContent')}
							value={prompt?.content || ''}
						/>
					</Section>

					<Section id="report" title={t('tracker.detail.report')} open={sections.report} onToggle={toggleSection} t={t}>
						<TextPanel
							loading={loading}
							loadingText={t('tracker.detail.loadingReport')}
							emptyText={t('tracker.detail.emptyReport')}
							value={prompt?.report || ''}
						/>
					</Section>
				</div>

				<div style={styles.footer}>
					<button type="button" style={styles.footerButton} onClick={onClose}>
						{t('common.close')}
					</button>
					<button type="button" style={styles.footerButton} onClick={onOpenPrompt}>
						{t('tracker.open')}
					</button>
					<button
						type="button"
						style={{ ...styles.footerButton, ...styles.footerChatButton }}
						onClick={shouldShowOpenChat ? onOpenChat : onStartChat}
					>
						{shouldShowOpenChat ? t('actions.openChat') : t('actions.startChat')}
					</button>
				</div>
			</div>
		</div>
	);
};

const MetaItem: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono = false }) => (
	<div style={styles.metaItem}>
		<div style={styles.metaLabel}>{label}</div>
		<div style={{ ...styles.metaValue, ...(mono ? styles.mono : {}) }}>{value || '—'}</div>
	</div>
);

const MetaCard: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono = false }) => (
	<div style={styles.tagGroup}>
		<div style={styles.groupLabel}>{label}</div>
		<div style={{ ...styles.metaValue, ...styles.tagGroupValue, ...(mono ? styles.mono : {}) }}>{value || '—'}</div>
	</div>
);

const TagGroup: React.FC<{ label: string; values: string[]; mono?: boolean; t: (key: string) => string }> = ({
	label,
	values,
	mono = false,
	t,
}) => (
	<div style={styles.tagGroup}>
		<div style={styles.groupLabel}>{label}</div>
		{values.length > 0 ? (
			<div style={styles.tagWrap}>
				{values.map(value => (
					<span key={`${label}-${value}`} style={{ ...styles.tag, ...(mono ? styles.monoTag : {}) }}>
						{value}
					</span>
				))}
			</div>
		) : (
			<div style={styles.emptyValue}>{t('tracker.detail.empty')}</div>
		)}
	</div>
);

const TimeStat: React.FC<{ label: string; value: string; accent?: boolean }> = ({ label, value, accent = false }) => (
	<div style={{ ...styles.timeStat, ...(accent ? styles.timeStatAccent : {}) }}>
		<div style={styles.timeLabel}>{label}</div>
		<div style={styles.timeValue}>{value}</div>
	</div>
);

const TextPanel: React.FC<{ loading: boolean; loadingText: string; emptyText: string; value: string }> = ({
	loading,
	loadingText,
	emptyText,
	value,
}) => {
	if (loading) {
		return <div style={styles.loadingPanel}>{loadingText}</div>;
	}

	if (!value.trim()) {
		return <div style={styles.emptyPanel}>{emptyText}</div>;
	}

	return <pre style={styles.textPanel}>{value}</pre>;
};

const styles: Record<string, CSSProperties> = {
	backdrop: {
		position: 'absolute',
		inset: 0,
		zIndex: 70,
		padding: '18px',
		background: 'color-mix(in srgb, rgba(0, 0, 0, 0.46) 78%, transparent)',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
	},
	dialog: {
		width: 'min(1120px, 100%)',
		height: 'min(90vh, 100%)',
		background: 'var(--vscode-editor-background)',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '14px',
		boxShadow: '0 28px 80px rgba(0, 0, 0, 0.38)',
		display: 'flex',
		flexDirection: 'column',
		overflow: 'hidden',
		boxSizing: 'border-box',
	},
	header: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'flex-start',
		gap: '12px',
		padding: '14px 16px 12px',
		borderBottom: '1px solid var(--vscode-panel-border)',
		background: 'linear-gradient(180deg, color-mix(in srgb, var(--vscode-sideBar-background) 82%, transparent), transparent)',
		flexShrink: 0,
	},
	headerContent: {
		display: 'flex',
		flexDirection: 'column',
		gap: '7px',
		minWidth: 0,
		flex: 1,
	},
	headerBadges: {
		display: 'flex',
		flexWrap: 'wrap',
		gap: '6px',
	},
	statusBadge: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '6px',
		padding: '4px 8px',
		borderRadius: '999px',
		border: '1px solid transparent',
		fontSize: '11px',
		fontWeight: 700,
	},
	favoriteBadge: {
		display: 'inline-flex',
		alignItems: 'center',
		padding: '4px 8px',
		borderRadius: '999px',
		background: 'color-mix(in srgb, var(--vscode-editorWidget-background, var(--vscode-sideBar-background)) 92%, transparent)',
		color: 'var(--vscode-foreground)',
		fontSize: '11px',
		fontWeight: 600,
	},
	title: {
		margin: 0,
		fontSize: '20px',
		lineHeight: 1.2,
		wordBreak: 'break-word',
		overflowWrap: 'anywhere',
	},
	subtitle: {
		fontSize: '11px',
		color: 'var(--vscode-descriptionForeground)',
	},
	headerCloseButton: {
		...memoryButtonStyles.secondary,
		padding: '5px 12px',
		fontSize: '12px',
		minHeight: '28px',
	},
	body: {
		flex: 1,
		minHeight: 0,
		overflow: 'auto',
		padding: '12px 16px 10px',
		display: 'flex',
		flexDirection: 'column',
		gap: '10px',
		boxSizing: 'border-box',
	},
	section: {
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '10px',
		background: 'color-mix(in srgb, var(--vscode-editorWidget-background, var(--vscode-sideBar-background)) 94%, transparent)',
		overflow: 'hidden',
		minWidth: 0,
		boxSizing: 'border-box',
	},
	sectionToggle: {
		width: '100%',
		border: 'none',
		background: 'transparent',
		padding: '10px 12px',
		cursor: 'pointer',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		color: 'var(--vscode-foreground)',
		textAlign: 'left',
	},
	sectionTitleWrap: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
	},
	sectionChevron: {
		fontSize: '11px',
		color: 'var(--vscode-descriptionForeground)',
	},
	sectionTitle: {
		fontSize: '13px',
		fontWeight: 700,
	},
	sectionBody: {
		padding: '0 12px 12px',
		display: 'flex',
		flexDirection: 'column',
		gap: '10px',
		minWidth: 0,
	},
	descriptionCard: {
		padding: '10px 12px',
		borderRadius: '8px',
		background: 'color-mix(in srgb, var(--vscode-sideBar-background) 84%, transparent)',
		border: '1px solid var(--vscode-panel-border)',
		boxSizing: 'border-box',
		overflow: 'hidden',
	},
	descriptionLabel: {
		fontSize: '10px',
		fontWeight: 700,
		textTransform: 'uppercase',
		letterSpacing: '0.08em',
		color: 'var(--vscode-descriptionForeground)',
		marginBottom: '6px',
	},
	descriptionText: {
		fontSize: '13px',
		lineHeight: 1.45,
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
		overflowWrap: 'anywhere',
	},
	metaGrid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
		gap: '8px',
		minWidth: 0,
	},
	metaItem: {
		padding: '8px 10px',
		borderRadius: '8px',
		background: 'var(--vscode-input-background)',
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
		minWidth: 0,
		boxSizing: 'border-box',
		overflow: 'hidden',
	},
	metaLabel: {
		fontSize: '10px',
		fontWeight: 700,
		textTransform: 'uppercase',
		letterSpacing: '0.08em',
		color: 'var(--vscode-descriptionForeground)',
	},
	metaValue: {
		fontSize: '12px',
		lineHeight: 1.35,
		wordBreak: 'break-word',
		overflowWrap: 'anywhere',
		minWidth: 0,
	},
	contextGrid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
		gap: '8px',
		minWidth: 0,
	},
	tagGroup: {
		padding: '8px 10px',
		borderRadius: '8px',
		background: 'var(--vscode-input-background)',
		display: 'flex',
		flexDirection: 'column',
		gap: '6px',
		minWidth: 0,
		boxSizing: 'border-box',
		overflow: 'hidden',
	},
	groupLabel: {
		fontSize: '10px',
		fontWeight: 700,
		textTransform: 'uppercase',
		letterSpacing: '0.08em',
		color: 'var(--vscode-descriptionForeground)',
	},
	tagWrap: {
		display: 'flex',
		flexWrap: 'wrap',
		gap: '6px',
		minWidth: 0,
	},
	tag: {
		padding: '4px 8px',
		borderRadius: '999px',
		background: 'color-mix(in srgb, var(--vscode-button-secondaryBackground) 90%, transparent)',
		color: 'var(--vscode-foreground)',
		fontSize: '11px',
		lineHeight: 1.3,
		wordBreak: 'break-word',
		overflowWrap: 'anywhere',
		maxWidth: '100%',
		boxSizing: 'border-box',
	},
	tagGroupValue: {
		padding: '6px 8px',
		borderRadius: '8px',
		background: 'color-mix(in srgb, var(--vscode-editor-background) 78%, transparent)',
		boxSizing: 'border-box',
		minWidth: 0,
	},
	emptyValue: {
		fontSize: '11px',
		color: 'var(--vscode-descriptionForeground)',
	},
	timeGrid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
		gap: '8px',
		minWidth: 0,
	},
	timeStat: {
		padding: '8px 10px',
		borderRadius: '8px',
		background: 'var(--vscode-input-background)',
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
		boxSizing: 'border-box',
		overflow: 'hidden',
	},
	timeStatAccent: {
		background: 'color-mix(in srgb, var(--vscode-button-background) 22%, var(--vscode-input-background))',
	},
	timeLabel: {
		fontSize: '10px',
		fontWeight: 700,
		textTransform: 'uppercase',
		letterSpacing: '0.08em',
		color: 'var(--vscode-descriptionForeground)',
	},
	timeValue: {
		fontSize: '15px',
		fontWeight: 700,
		lineHeight: 1.2,
		overflowWrap: 'anywhere',
	},
	textPanel: {
		margin: 0,
		padding: '10px 12px',
		borderRadius: '8px',
		background: 'var(--vscode-textCodeBlock-background, var(--vscode-input-background))',
		color: 'var(--vscode-foreground)',
		fontFamily: 'var(--vscode-editor-font-family, var(--vscode-font-family))',
		fontSize: '12px',
		lineHeight: 1.5,
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
		overflowWrap: 'anywhere',
		maxHeight: '320px',
		overflow: 'auto',
		boxSizing: 'border-box',
	},
	loadingPanel: {
		padding: '12px',
		borderRadius: '8px',
		background: 'var(--vscode-input-background)',
		color: 'var(--vscode-descriptionForeground)',
		fontSize: '11px',
		boxSizing: 'border-box',
	},
	emptyPanel: {
		padding: '12px',
		borderRadius: '8px',
		background: 'var(--vscode-input-background)',
		color: 'var(--vscode-descriptionForeground)',
		fontSize: '11px',
		boxSizing: 'border-box',
	},
	footer: {
		display: 'flex',
		flexWrap: 'wrap',
		justifyContent: 'flex-end',
		gap: '8px',
		padding: '10px 16px 14px',
		borderTop: '1px solid var(--vscode-panel-border)',
		background: 'color-mix(in srgb, var(--vscode-sideBar-background) 78%, transparent)',
		flexShrink: 0,
	},
	footerButton: {
		...memoryButtonStyles.secondary,
		padding: '6px 14px',
		fontSize: '13px',
		minHeight: '30px',
	},
	footerChatButton: {
		background: 'var(--vscode-button-secondaryBackground)',
		color: 'var(--vscode-button-secondaryForeground)',
	},
	mono: {
		fontFamily: 'var(--vscode-editor-font-family, var(--vscode-font-family))',
	},
	monoTag: {
		fontFamily: 'var(--vscode-editor-font-family, var(--vscode-font-family))',
		maxWidth: '100%',
	},
};