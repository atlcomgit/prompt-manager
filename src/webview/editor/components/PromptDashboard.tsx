import React, { useEffect, useRef, useState } from 'react';
import { PromptStatusText } from '../../shared/PromptStatusText';
import { getPromptStatusColor } from '../../shared/promptStatus';
import type { GitOverlayParallelBranchSummary } from '../../../types/git.js';
import type { PromptDashboardAnalysisState, PromptDashboardLoadStatus, PromptDashboardProjectSummary, PromptDashboardRecentCommit, PromptDashboardSnapshot } from '../../../types/promptDashboard.js';
import { formatPromptDashboardDuration } from '../../../utils/promptDashboard.js';

const DASHBOARD_LEFT_ACCENT_SHADOW = 'inset 3px 0 0 var(--vscode-widget-shadow, rgba(0, 0, 0, 0.35))';

/** Describes an exact dashboard file comparison request. */
export interface PromptDashboardFilePatchRequest {
	project: string;
	filePath: string;
	previousPath?: string;
	mode: 'commit' | 'branch';
	ref: string;
	baseRef?: string;
}

interface PromptDashboardProps {
	snapshot: PromptDashboardSnapshot | null;
	busyAction?: string | null;
	mode: 'full' | 'compact';
	onRefresh: () => void;
	onHydrateProjectsDetails: () => void;
	onOpenPrompt: (id: string, promptUuid?: string) => void;
	onSwitchBranch: (project: string, branch: string) => void;
	onSwitchBranches: (branchesByProject: Record<string, string>, source?: 'bulk' | 'prompt' | 'tracked') => void;
	onOpenDiff: (project: string, filePath: string) => void;
	onOpenFilePatch: (request: PromptDashboardFilePatchRequest) => void;
}

interface BranchOption {
	branch: string;
	label: string;
	available: boolean;
	roles: string[];
}

interface FileRowActionHandlers {
	openingFileKey: string | null;
	activeFileKey: string | null;
	viewedFileKeys: Record<string, boolean>;
	onOpenDiff: (project: string, filePath: string, fileKey: string) => void;
	onOpenFilePatch: (request: PromptDashboardFilePatchRequest, fileKey: string) => void;
}

type ExpandedState = Record<string, boolean>;

type DashboardBusyAction = string | null | undefined;

type DashboardBranchApplySource = 'bulk' | 'prompt' | 'tracked';

/** Stores a leaf row for the compact dashboard file tree. */
interface DashboardFileTreeEntry {
	key: string;
	path: string;
	status: string;
	label: string;
	secondaryLabel?: string;
	additions?: number | null;
	deletions?: number | null;
	isBinary?: boolean;
	warn?: boolean;
	opening?: boolean;
	active?: boolean;
	viewed?: boolean;
	onOpenPatch: () => void;
}

/** Stores user-facing added/changed/deleted counters for a dashboard file. */
interface DashboardLineStats {
	added: number;
	changed: number;
	deleted: number;
	kind: 'diff' | 'binary' | 'unknown';
}

/** Stores one nested directory in the dashboard tree. */
interface DashboardFileTreeNode {
	name: string;
	path: string;
	directories: Map<string, DashboardFileTreeNode>;
	files: DashboardFileTreeEntry[];
}

/** Stores branch-guide metadata for one rendered tree row. */
interface DashboardFileTreeRowContext {
	ancestorHasSibling: boolean[];
	isLast: boolean;
}

interface DashboardFileTone {
	label: string;
	accentColor: string;
	borderColor: string;
	background: string;
}

/** Right-side prompt dashboard visible only when the editor has enough horizontal space. */
export const PromptDashboard: React.FC<PromptDashboardProps> = ({
	snapshot,
	busyAction,
	mode,
	onRefresh,
	onHydrateProjectsDetails,
	onOpenPrompt,
	onSwitchBranch,
	onSwitchBranches,
	onOpenDiff,
	onOpenFilePatch,
}) => {
	const [expanded, setExpanded] = useState<ExpandedState>({});
	const [branchDrafts, setBranchDrafts] = useState<Record<string, string>>({});
	const [bulkBranchDraft, setBulkBranchDraft] = useState('');
	const [openingFileKey, setOpeningFileKey] = useState<string | null>(null);
	const [activeFileKey, setActiveFileKey] = useState<string | null>(null);
	const [viewedFileKeys, setViewedFileKeys] = useState<Record<string, boolean>>({});
	const openingFileTokenRef = useRef(0);
	const projects = snapshot?.projects.data.projects || [];
	const projectsCacheStatus = snapshot?.projects.cache.status || 'idle';
	const activityCacheStatus = snapshot?.activity.cache.status || 'idle';
	const statusCacheStatus = snapshot?.status.cache.status || 'idle';
	const runFileOpenAction = (fileKey: string, action: () => void) => {
		const startedAt = Date.now();
		const token = openingFileTokenRef.current + 1;
		openingFileTokenRef.current = token;
		setActiveFileKey(fileKey);
		setViewedFileKeys(current => current[fileKey] ? current : { ...current, [fileKey]: true });
		setOpeningFileKey(fileKey);
		try {
			action();
		} finally {
			const release = () => {
				if (openingFileTokenRef.current !== token) {
					return;
				}
				setOpeningFileKey(current => current === fileKey ? null : current);
			};
			const remainingMs = 450 - (Date.now() - startedAt);
			if (remainingMs > 0) {
				setTimeout(release, remainingMs);
				return;
			}
			release();
		}
	};
	const fileHandlers = {
		openingFileKey,
		activeFileKey,
		viewedFileKeys,
		onOpenDiff: (project: string, filePath: string, fileKey: string) => {
			runFileOpenAction(fileKey, () => onOpenDiff(project, filePath));
		},
		onOpenFilePatch: (request: PromptDashboardFilePatchRequest, fileKey: string) => {
			runFileOpenAction(fileKey, () => onOpenFilePatch(request));
		},
	};
	const isRefreshBusy = busyAction === 'refresh';

	// Reset local branch selectors only when the dashboard scope changes to another prompt context.
	useEffect(() => {
		setBranchDrafts({});
		setBulkBranchDraft('');
		setActiveFileKey(null);
		setViewedFileKeys({});
	}, [snapshot?.scopeKey]);

	if (mode !== 'full') {
		return null;
	}

	const toggleExpanded = (key: string) => {
		setExpanded(previous => {
			const nextExpanded = !previous[key];
			if (nextExpanded) {
				maybeHydrateExpandedDetails(key, projects, projectsCacheStatus, onHydrateProjectsDetails);
			}
			return { ...previous, [key]: nextExpanded };
		});
	};

	const applyBranchTargets = (branchesByProject: Record<string, string>, source: DashboardBranchApplySource = 'bulk') => {
		if (Object.keys(branchesByProject).length === 0) {
			return;
		}
		onSwitchBranches(branchesByProject, source);
	};

	const applyBranchDrafts = () => {
		applyBranchTargets(buildChangedBranchTargets(projects, branchDrafts), 'bulk');
	};

	const applyBranchPreset = (kind: 'prompt' | 'tracked') => {
		applyBranchTargets(buildPresetBranchTargets(projects, kind), kind);
	};

	const applyProjectBranch = (project: PromptDashboardProjectSummary) => {
		const selectedBranch = resolveBranchDraft(project, branchDrafts);
		if (!selectedBranch || selectedBranch === project.currentBranch) {
			return;
		}
		onSwitchBranch(project.project, selectedBranch);
	};

	const applyBulkBranchDraft = (branch: string) => {
		setBulkBranchDraft(branch);
		setBranchDrafts(previous => buildBulkBranchDrafts(projects, previous, branch));
	};

	return (
		<aside style={styles.rail} data-pm-prompt-dashboard="true">
			<div style={styles.toolbar}>
				<div>
					<div style={styles.title}>Обзор</div>
					<div style={styles.subtitle}>{resolveCacheLabel(snapshot)}</div>
				</div>
				<button type="button" style={{ ...styles.iconButton, ...(isRefreshBusy ? styles.busyButton : null) }} onClick={onRefresh} title="Обновить" aria-label="Обновить" disabled={isRefreshBusy}>
					{isRefreshBusy ? <span style={styles.buttonSpinner} aria-hidden="true" /> : '↻'}
				</button>
			</div>

			<div style={styles.widgetGrid}>
				{renderStatus(snapshot, statusCacheStatus)}
				{renderActivity(snapshot, onOpenPrompt, activityCacheStatus)}
				{renderProjectBranches(projects, branchDrafts, bulkBranchDraft, busyAction, projectsCacheStatus, setBranchDrafts, applyBulkBranchDraft, applyBranchDrafts, applyBranchPreset, applyProjectBranch)}
				{renderProjectCommits(projects, expanded, toggleExpanded, fileHandlers, projectsCacheStatus)}
				{renderReviewRequests(projects, projectsCacheStatus)}
				{renderParallelBranchFiles(projects, expanded, toggleExpanded, fileHandlers, projectsCacheStatus)}
				{renderAnalysis(snapshot?.aiAnalysis.data || null, snapshot?.aiAnalysis.cache.status || 'idle')}
			</div>
		</aside>
	);
};

/** Requests lazy project detail hydration only when the user opens an unloaded detail block. */
function maybeHydrateExpandedDetails(
	key: string,
	projects: PromptDashboardProjectSummary[],
	cacheStatus: PromptDashboardLoadStatus,
	onHydrateProjectsDetails: () => void,
): void {
	if (cacheStatus === 'loading') {
		return;
	}

	const [kind, projectName, ...rest] = key.split(':');
	if (!kind || !projectName || rest.length === 0) {
		return;
	}

	const project = projects.find(item => item.project === projectName);
	if (!project) {
		return;
	}

	if (kind === 'commit') {
		const commitSha = rest.join(':');
		if (project.recentCommits.some(commit => commit.sha === commitSha && commit.changedFilesHydrated === false)) {
			onHydrateProjectsDetails();
		}
		return;
	}

	if (kind === 'parallel') {
		const branchName = rest.join(':');
		if (project.parallelBranches.some(branch => branch.name === branchName && branch.detailsHydrated === false)) {
			onHydrateProjectsDetails();
		}
	}
}

function resolveCacheLabel(snapshot: PromptDashboardSnapshot | null): string {
	if (!snapshot) {
		return 'Данные загружаются';
	}
	const updatedAt = [snapshot.status, snapshot.activity, snapshot.projects, snapshot.aiAnalysis]
		.map(widget => widget.cache.updatedAt || '')
		.filter(Boolean)
		.sort()
		.pop();
	if (!updatedAt) {
		return 'Кеш подготавливается';
	}
	return `Обновлено ${new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function renderStatus(snapshot: PromptDashboardSnapshot | null, cacheStatus: PromptDashboardLoadStatus): React.ReactNode {
	const data = snapshot?.status.data;
	const progress = Math.max(0, Math.min(100, data?.progress ?? 0));
	const statusAccent = data ? getPromptStatusColor(data.status) : 'var(--vscode-descriptionForeground)';
	const progressFillTone = progress >= 100
		? 'var(--vscode-charts-green, var(--vscode-terminal-ansiGreen, var(--vscode-testing-iconPassed, #2e7d32)))'
		: statusAccent;

	return (
		<section style={styles.section}>
			<div style={styles.sectionHeader}>
				<span style={styles.sectionTitle}>Статус промпта</span>
				{renderSectionMeta(formatPromptDashboardDuration(data?.totalTimeMs || 0), cacheStatus, 'обновляем')}
			</div>
			<div style={{ ...styles.sectionBody, ...styles.statusBody }}>
				<div style={styles.statusChipRow}>
					{data ? (
						<PromptStatusText
							status={data.status}
							variant="badge"
							style={{ ...styles.statusChip, color: statusAccent }}
						/>
					) : <span style={styles.muted}>Нет данных</span>}
				</div>
				{data?.status === 'in-progress' && typeof data.progress === 'number' ? (
					<div style={styles.statusProgressRow}>
						<div
							style={{ ...styles.progressBarContainer, borderColor: 'color-mix(in srgb, var(--vscode-editorInfo-foreground, #3794ff) 48%, var(--vscode-panel-border))' }}
							title={`${progress}%`}
							aria-label={`Прогресс ${progress}%`}
						>
							<div style={{ ...styles.progressBarFill, width: `${progress}%`, background: progressFillTone, opacity: progress >= 100 ? 0.96 : 0.72 }} />
							<ProgressValueLabel value={progress} fillTone="var(--vscode-button-foreground, #ffffff)" />
						</div>
					</div>
				) : null}
			</div>
		</section>
	);
}

function ProgressValueLabel({ value, fillTone }: { value: number; fillTone: string }) {
	const normalizedValue = Math.max(0, Math.min(value, 100));
	return (
		<>
			<span style={styles.progressBarText}>{value}%</span>
			<span
				aria-hidden="true"
				style={{
					...styles.progressBarTextOverlay,
					color: fillTone,
					clipPath: `inset(0 ${100 - normalizedValue}% 0 0)`,
				}}
			>
				{value}%
			</span>
		</>
	);
}

function renderActivity(snapshot: PromptDashboardSnapshot | null, onOpenPrompt: (id: string, promptUuid?: string) => void, cacheStatus: PromptDashboardLoadStatus): React.ReactNode {
	const data = snapshot?.activity.data;
	return (
		<section style={styles.section}>
			<div style={styles.sectionHeader}>
				<span style={styles.sectionTitle}>Активные промпты</span>
				{renderSectionMeta('5m+', cacheStatus, 'обновляем')}
			</div>
			<div style={styles.sectionBody}>
				{renderActivityGroup('Сегодня', data?.today || [], onOpenPrompt)}
				{renderActivityGroup(data?.yesterdayLabel || 'Вчера', data?.yesterday || [], onOpenPrompt)}
			</div>
		</section>
	);
}

function renderActivityGroup(
	title: string,
	items: NonNullable<PromptDashboardSnapshot['activity']['data']>['today'],
	onOpenPrompt: (id: string, promptUuid?: string) => void,
): React.ReactNode {
	return (
		<div style={styles.activityGroup}>
			<div style={styles.groupTitle}>{title}</div>
			{items.length === 0 ? (
				<div style={styles.emptyText}>Нет промптов дольше 5 минут</div>
			) : items.slice(0, 4).map(item => (
				<button
					key={`${item.day}-${item.id}`}
					type="button"
					style={styles.activityButton}
					onClick={() => onOpenPrompt(item.id, item.promptUuid)}
					title={item.title}
				>
					<span style={styles.taskBadge}>{item.taskNumber ? `№ ${item.taskNumber}` : '—'}</span>
					<span style={styles.itemTitle}>{item.title}</span>
					<span style={styles.statValue}>{formatPromptDashboardDuration(item.totalMs)}</span>
				</button>
			))}
		</div>
	);
}

function renderProjectBranches(
	projects: PromptDashboardProjectSummary[],
	branchDrafts: Record<string, string>,
	bulkBranchDraft: string,
	busyAction: DashboardBusyAction,
	cacheStatus: PromptDashboardLoadStatus,
	setBranchDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>,
	applyBulkBranchDraft: (branch: string) => void,
	applyBranchDrafts: () => void,
	applyBranchPreset: (kind: 'prompt' | 'tracked') => void,
	applyProjectBranch: (project: PromptDashboardProjectSummary) => void,
): React.ReactNode {
	const changedCount = Object.keys(buildChangedBranchTargets(projects, branchDrafts)).length;
	const sharedOptions = buildSharedBranchOptions(projects);
	const isSwitchBusy = isBranchSwitchBusy(busyAction);
	const isPromptPresetBusy = busyAction === 'preset:prompt';
	const isTrackedPresetBusy = busyAction === 'preset:tracked';
	const isBulkSwitchBusy = busyAction === 'switch-all';
	return (
		<section style={styles.section}>
			<div style={styles.sectionHeader}>
				<span style={styles.sectionTitle}>Ветки проектов</span>
				{renderSectionMeta(projects.length || '...', cacheStatus, 'обновляем')}
			</div>
			<div style={styles.sectionBody}>
				<label style={styles.bulkBranchRow}>
					<span style={styles.bulkBranchLabel}>Для всех</span>
					<select
						value={bulkBranchDraft}
						style={styles.branchSelect}
						disabled={isSwitchBusy || projects.length === 0 || sharedOptions.length === 0}
						onChange={event => applyBulkBranchDraft(event.target.value)}
					>
						<option value="">Не выбрано</option>
						{sharedOptions.map(option => (
							<option key={option.branch} value={option.branch}>{option.label}</option>
						))}
					</select>
				</label>
				<div style={styles.branchToolbar}>
					<button type="button" style={{ ...styles.secondaryButton, ...(isPromptPresetBusy ? styles.busyButton : null), ...(isSwitchBusy && !isPromptPresetBusy ? styles.disabledButton : null) }} onClick={() => applyBranchPreset('prompt')} title="Сразу переключить каждый проект на его ветку из поля prompt branch" disabled={isSwitchBusy}>
						{isPromptPresetBusy ? <span style={styles.inlineSpinnerLabel}><span style={styles.buttonSpinner} aria-hidden="true" /> Применяем</span> : 'Ветка промпта'}
					</button>
					<button type="button" style={{ ...styles.secondaryButton, ...(isTrackedPresetBusy ? styles.busyButton : null), ...(isSwitchBusy && !isTrackedPresetBusy ? styles.disabledButton : null) }} onClick={() => applyBranchPreset('tracked')} title="Сразу переключить каждый проект на его собственную tracked-ветку" disabled={isSwitchBusy}>
						{isTrackedPresetBusy ? <span style={styles.inlineSpinnerLabel}><span style={styles.buttonSpinner} aria-hidden="true" /> Применяем</span> : 'Tracked-ветка'}
					</button>
					<button type="button" style={{ ...styles.primaryButton, ...((changedCount === 0 || (isSwitchBusy && !isBulkSwitchBusy)) ? styles.disabledButton : null), ...(isBulkSwitchBusy ? styles.busyButton : null) }} disabled={changedCount === 0 || isSwitchBusy} onClick={applyBranchDrafts}>
						{isBulkSwitchBusy ? <span style={styles.inlineSpinnerLabel}><span style={styles.buttonSpinner} aria-hidden="true" /> Переключаем</span> : `Переключить ${changedCount || ''}`}
					</button>
				</div>
				<div style={styles.branchToolbarHint}>Пресеты применяются отдельно по каждому проекту.</div>
				{projects.length === 0 ? (
					cacheStatus === 'loading'
						? renderLoadingEmptyState('Git-данные загружаются')
						: <div style={styles.emptyText}>Нет Git-данных по проектам</div>
				) : projects.map((project, index) => renderBranchProject(project, index, branchDrafts, busyAction, setBranchDrafts, applyProjectBranch))}
			</div>
		</section>
	);
}

function renderBranchProject(
	project: PromptDashboardProjectSummary,
	index: number,
	branchDrafts: Record<string, string>,
	busyAction: DashboardBusyAction,
	setBranchDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>,
	applyProjectBranch: (project: PromptDashboardProjectSummary) => void,
): React.ReactNode {
	const branchOptions = buildBranchOptions(project);
	const selectedBranch = resolveBranchDraft(project, branchDrafts);
	const isChanged = selectedBranch && selectedBranch !== project.currentBranch;
	const isSwitchBusy = isBranchSwitchBusy(busyAction);
	const isProjectBusy = busyAction === `switch-project:${project.project}`;
	const selectedLabel = isChanged ? 'выбрана' : 'текущая';
	return (
		<div key={project.project} style={{ ...styles.branchProjectRow, ...(index === 0 ? styles.branchProjectRowFirst : null) }}>
			<div style={styles.projectName} title={`Текущая ветка: ${project.currentBranch || 'n/a'}`}>{project.project}</div>
			<label style={styles.branchSelectInlineLabel}>
				<select
					value={selectedBranch}
					style={styles.branchSelect}
					disabled={isSwitchBusy || !project.available || branchOptions.length === 0}
					onChange={event => {
						const branch = event.target.value;
						setBranchDrafts(previous => ({ ...previous, [project.project]: branch }));
					}}
				>
					{branchOptions.map(option => (
						<option key={`${project.project}-${option.branch}`} value={option.branch} disabled={!option.available && option.branch !== project.currentBranch}>
							{option.label}
						</option>
					))}
				</select>
			</label>
			<span style={{ ...styles.badge, ...(isChanged ? styles.badgeWarn : styles.badgeOk) }}>
				{selectedLabel}
			</span>
			<button
				type="button"
				style={{ ...styles.inlineButton, ...(!isChanged || (isSwitchBusy && !isProjectBusy) ? styles.disabledButton : null), ...(isProjectBusy ? styles.busyButton : null) }}
				disabled={!isChanged || isSwitchBusy}
				onClick={() => applyProjectBranch(project)}
				title={isChanged ? `Переключить ${project.project} на ${selectedBranch}` : 'Ветка уже активна'}
			>
				{isProjectBusy ? <span style={styles.inlineSpinnerLabel}><span style={styles.buttonSpinner} aria-hidden="true" /> Применяем</span> : 'Применить'}
			</button>
			{project.error ? <div style={{ ...styles.errorText, ...styles.branchProjectError }}>{project.error}</div> : null}
		</div>
	);
}

function renderReviewRequests(projects: PromptDashboardProjectSummary[], cacheStatus: PromptDashboardLoadStatus): React.ReactNode {
	return (
		<section style={styles.section}>
			<div style={styles.sectionHeader}>
				<span style={styles.sectionTitle}>MR/PR</span>
				{renderSectionMeta(projects.length || '...', cacheStatus, 'обновляем')}
			</div>
			<div style={styles.sectionBody}>
				{projects.length === 0 ? cacheStatus === 'loading' ? renderLoadingEmptyState('MR/PR-данные загружаются') : <div style={styles.emptyText}>MR/PR-данные недоступны</div> : projects.map(project => {
					const request = project.review.request;
					const reviewMessage = project.review.error || formatReviewUnsupportedReason(project.review.unsupportedReason) || 'Активный MR/PR не найден';
					const state = request?.state || (project.review.error ? 'недоступно' : project.review.unsupportedReason ? 'нет setup' : 'нет MR/PR');
					return (
						<div key={project.project} style={styles.compactProjectRow}>
							<div style={styles.projectHeader}>
								<div style={styles.projectName}>{project.project}</div>
								<span style={{ ...styles.badge, ...(request ? styles.badgeOk : styles.badgeNeutral) }}>{state}</span>
							</div>
							{request ? (
								<div style={styles.reviewDetails}>
									<div style={styles.itemTitle}>{request.title}</div>
									<div style={styles.statValue}>{`${request.sourceBranch} -> ${request.targetBranch}`}</div>
									<div style={styles.inlineMetricText}>Обновлено: {formatRelativeTime(request.updatedAt || request.createdAt)}</div>
								</div>
							) : <div style={styles.emptyText}>{reviewMessage}</div>}
						</div>
					);
				})}
			</div>
		</section>
	);
}

function formatReviewUnsupportedReason(reason: string | null | undefined): string {
	switch (reason) {
		case 'missing-remote': return 'Git remote не настроен';
		case 'unrecognized-remote': return 'Git remote не распознан';
		case 'unsupported-provider': return 'Провайдер MR/PR не поддержан';
		default: return '';
	}
}

function renderParallelBranchFiles(
	projects: PromptDashboardProjectSummary[],
	expanded: ExpandedState,
	toggleExpanded: (key: string) => void,
	fileHandlers: FileRowActionHandlers,
	cacheStatus: PromptDashboardLoadStatus,
): React.ReactNode {
	return (
		<section style={styles.section}>
			<div style={styles.sectionHeader}>
				<span style={styles.sectionTitle}>Параллельные ветки</span>
				{renderSectionMeta(projects.reduce((count, project) => count + project.parallelBranches.length, 0) || '...', cacheStatus, 'обновляем')}
			</div>
			<div style={styles.sectionBody}>
				{projects.length === 0 ? cacheStatus === 'loading' ? renderLoadingEmptyState('Данные по веткам загружаются') : <div style={styles.emptyText}>Нет данных по параллельным веткам</div> : projects.map(project => (
					<div key={project.project} style={styles.projectBlock}>
						<div style={styles.projectHeader}>
							<div style={styles.projectName}>{project.project}</div>
							<span style={styles.sectionMeta}>{project.parallelBranches.length}</span>
						</div>
						{renderParallelBranches(project, expanded, toggleExpanded, fileHandlers)}
						{renderConflictFiles(project, fileHandlers)}
					</div>
				))}
			</div>
		</section>
	);
}

function renderProjectCommits(
	projects: PromptDashboardProjectSummary[],
	expanded: ExpandedState,
	toggleExpanded: (key: string) => void,
	fileHandlers: FileRowActionHandlers,
	cacheStatus: PromptDashboardLoadStatus,
): React.ReactNode {
	return (
		<section style={styles.section}>
			<div style={styles.sectionHeader}>
				<span style={styles.sectionTitle}>Коммиты проектов</span>
				{renderSectionMeta(projects.length || '...', cacheStatus, 'обновляем')}
			</div>
			<div style={styles.sectionBody}>
				{projects.length === 0 ? (
					cacheStatus === 'loading' ? renderLoadingEmptyState('Коммиты загружаются') : <div style={styles.emptyText}>Коммиты пока недоступны</div>
				) : projects.map((project, index) => (
					<div key={project.project} style={{ ...styles.projectBlock, ...(index === 0 ? styles.projectBlockFirst : null) }}>
						<div style={styles.projectHeader}>
							<div style={styles.projectName}>{project.project}</div>
							<span style={styles.sectionMeta}>{project.currentBranch || 'n/a'}</span>
						</div>
						{renderCommitList(project, expanded, toggleExpanded, fileHandlers)}
					</div>
				))}
			</div>
		</section>
	);
}

function buildBranchOptions(project: PromptDashboardProjectSummary): BranchOption[] {
	const options = new Map<string, BranchOption>();
	const addOption = (branch: string, role: string, available = true) => {
		const normalized = branch.trim();
		if (!normalized) {
			return;
		}
		const existing = options.get(normalized);
		if (existing) {
			const roles = existing.roles.includes(role) ? existing.roles : [...existing.roles, role];
			options.set(normalized, {
				...existing,
				available: existing.available || available,
				roles,
				label: formatBranchOptionLabel(normalized, roles),
			});
			return;
		}
		options.set(normalized, {
			branch: normalized,
			label: formatBranchOptionLabel(normalized, [role]),
			available,
			roles: [role],
		});
	};

	addOption(project.currentBranch, 'текущая', true);
	addOption(project.promptBranch, 'промпт', isBranchSwitchAvailable(project, project.promptBranch));
	addOption(project.trackedBranch, 'tracked', isBranchSwitchAvailable(project, project.trackedBranch));
	for (const branch of project.branches) {
		const role = branch.current
			? 'текущая'
			: branch.kind === 'tracked'
				? 'tracked'
				: branch.kind === 'prompt'
					? 'промпт'
					: branch.kind === 'remote'
						? 'remote'
						: 'local';
		addOption(branch.name, role, branch.canSwitch || branch.current);
	}

	return Array.from(options.values());
}

function formatBranchOptionLabel(branch: string, roles: string[]): string {
	return roles.length > 0 ? `${branch} (${roles.join(', ')})` : branch;
}

function isBranchSwitchAvailable(project: PromptDashboardProjectSummary, branch: string): boolean {
	const normalizedBranch = branch.trim();
	if (!normalizedBranch) {
		return false;
	}
	if (normalizedBranch === project.currentBranch) {
		return true;
	}
	const branchInfo = project.branches.find(item => item.name === normalizedBranch);
	const action = project.branchActions.find(item => item.branch === normalizedBranch);
	return Boolean(branchInfo?.canSwitch || action?.available);
}

function resolveBranchDraft(project: PromptDashboardProjectSummary, branchDrafts: Record<string, string>): string {
	const draft = String(branchDrafts[project.project] || '').trim();
	if (draft) {
		return draft;
	}
	const options = buildBranchOptions(project);
	const preferredBranches = [project.currentBranch, project.promptBranch, project.trackedBranch]
		.map(branch => branch.trim())
		.filter(Boolean);
	for (const branch of preferredBranches) {
		if (options.some(option => option.branch === branch && option.available)) {
			return branch;
		}
	}
	return options.find(option => option.available)?.branch || options[0]?.branch || '';
}

function buildChangedBranchTargets(projects: PromptDashboardProjectSummary[], branchDrafts: Record<string, string>): Record<string, string> {
	return projects.reduce<Record<string, string>>((targets, project) => {
		const branch = resolveBranchDraft(project, branchDrafts).trim();
		if (branch && branch !== project.currentBranch && buildBranchOptions(project).some(option => option.branch === branch && option.available)) {
			targets[project.project] = branch;
		}
		return targets;
	}, {});
}

function buildPresetBranchTargets(
	projects: PromptDashboardProjectSummary[],
	kind: 'prompt' | 'tracked',
): Record<string, string> {
	return projects.reduce<Record<string, string>>((targets, project) => {
		const targetBranch = (kind === 'prompt' ? project.promptBranch : project.trackedBranch).trim();
		if (targetBranch && targetBranch !== project.currentBranch) {
			targets[project.project] = targetBranch;
		}
		return targets;
	}, {});
}

function buildSharedBranchOptions(projects: PromptDashboardProjectSummary[]): BranchOption[] {
	const branchCounts = new Map<string, number>();
	for (const project of projects) {
		for (const option of buildBranchOptions(project)) {
			if (option.available) {
				branchCounts.set(option.branch, (branchCounts.get(option.branch) || 0) + 1);
			}
		}
	}
	return Array.from(branchCounts.entries())
		.sort(([left], [right]) => left.localeCompare(right, 'ru'))
		.map(([branch, count]) => ({
			branch,
			label: `${branch} (${count}/${projects.length})`,
			available: count > 0,
			roles: ['shared'],
		}));
}

function buildBulkBranchDrafts(
	projects: PromptDashboardProjectSummary[],
	currentDrafts: Record<string, string>,
	branch: string,
): Record<string, string> {
	const normalizedBranch = branch.trim();
	if (!normalizedBranch) {
		return currentDrafts;
	}
	const nextDrafts = { ...currentDrafts };
	for (const project of projects) {
		if (buildBranchOptions(project).some(option => option.branch === normalizedBranch && option.available)) {
			nextDrafts[project.project] = normalizedBranch;
		}
	}
	return nextDrafts;
}

function renderCommitList(
	project: PromptDashboardProjectSummary,
	expanded: ExpandedState,
	toggleExpanded: (key: string) => void,
	fileHandlers: FileRowActionHandlers,
): React.ReactNode {
	if (project.recentCommits.length === 0) {
		return <div style={styles.emptyText}>Нет последних коммитов</div>;
	}
	return (
		<div style={styles.detailGroup}>
			{project.recentCommits.slice(0, 2).map(commit => renderCommit(project, commit, expanded, toggleExpanded, fileHandlers))}
		</div>
	);
}

function renderCommit(
	project: PromptDashboardProjectSummary,
	commit: PromptDashboardRecentCommit,
	expanded: ExpandedState,
	toggleExpanded: (key: string) => void,
	fileHandlers: FileRowActionHandlers,
): React.ReactNode {
	const expandKey = `commit:${project.project}:${commit.sha}`;
	const isExpanded = expanded[expandKey] === true;
	const changedFilesLabel = commit.changedFilesHydrated === false ? '...' : String(commit.changedFiles.length);
	return (
		<div key={commit.sha} style={styles.detailBlock}>
			<button type="button" style={styles.detailButton} onClick={() => toggleExpanded(expandKey)}>
				<span style={styles.detailChevron}>{isExpanded ? '▾' : '▸'}</span>
				<span style={styles.commitSha}>{commit.shortSha}</span>
				<span style={styles.commitSubject}>{commit.subject}</span>
				<span style={styles.fileCount}>{changedFilesLabel}</span>
			</button>
			{isExpanded ? renderCommitChangedFiles(project, commit, fileHandlers) : null}
		</div>
	);
}

function renderParallelBranches(
	project: PromptDashboardProjectSummary,
	expanded: ExpandedState,
	toggleExpanded: (key: string) => void,
	fileHandlers: FileRowActionHandlers,
): React.ReactNode {
	if (project.parallelBranches.length === 0) {
		return null;
	}
	return (
		<div style={styles.detailGroup}>
			{project.parallelBranches.map(branch => renderParallelBranch(project, branch, expanded, toggleExpanded, fileHandlers))}
		</div>
	);
}

function renderParallelBranch(
	project: PromptDashboardProjectSummary,
	branch: GitOverlayParallelBranchSummary,
	expanded: ExpandedState,
	toggleExpanded: (key: string) => void,
	fileHandlers: FileRowActionHandlers,
): React.ReactNode {
	const expandKey = `parallel:${project.project}:${branch.name}`;
	const isExpanded = expanded[expandKey] === true;
	const changedFilesLabel = branch.detailsHydrated === false ? '...' : String(branch.affectedFiles.length);
	const hasConflictWarning = branch.detailsHydrated !== false && branch.potentialConflicts.length > 0;
	return (
		<div key={branch.name} style={styles.detailBlock}>
			<button type="button" style={styles.detailButton} onClick={() => toggleExpanded(expandKey)}>
				<span style={styles.detailChevron}>{isExpanded ? '▾' : '▸'}</span>
				<span style={styles.branchName}>{branch.name}</span>
				<span style={styles.statValue}>+{branch.ahead} / -{branch.behind}</span>
				<span style={{ ...styles.fileCount, ...(hasConflictWarning ? styles.fileCountWarn : null) }}>{changedFilesLabel}</span>
			</button>
			{isExpanded ? renderParallelFiles(project, branch, fileHandlers) : null}
		</div>
	);
}

function renderCommitChangedFiles(project: PromptDashboardProjectSummary, commit: PromptDashboardRecentCommit, fileHandlers: FileRowActionHandlers): React.ReactNode {
	if (commit.changedFilesHydrated === false) {
		return <div style={styles.emptyDetails}>Файлы коммита загружаются...</div>;
	}
	if (commit.changedFiles.length === 0) {
		return <div style={styles.emptyDetails}>Файлы не найдены</div>;
	}
	return (
		renderFileTree(project.project, commit.changedFiles.map(file => {
			const fileKey = `${project.project}:commit:${commit.sha}:${file.path}`;
			return {
				key: `${file.status}-${file.previousPath || ''}-${file.path}`,
				path: file.path,
				status: file.status,
				label: file.previousPath ? `${file.previousPath} -> ${file.path}` : file.path,
				secondaryLabel: file.previousPath ? `было: ${file.previousPath}` : undefined,
				additions: file.additions,
				deletions: file.deletions,
				isBinary: file.isBinary,
				opening: fileHandlers.openingFileKey === fileKey,
				active: fileHandlers.activeFileKey === fileKey,
				viewed: fileHandlers.viewedFileKeys[fileKey] === true,
				onOpenPatch: () => fileHandlers.onOpenFilePatch({ project: project.project, filePath: file.path, previousPath: file.previousPath, mode: 'commit', ref: commit.sha }, fileKey),
			};
		}))
	);
}

function renderParallelFiles(project: PromptDashboardProjectSummary, branch: GitOverlayParallelBranchSummary, fileHandlers: FileRowActionHandlers): React.ReactNode {
	if (branch.detailsHydrated === false) {
		return <div style={styles.emptyDetails}>Файлы ветки загружаются...</div>;
	}
	if (branch.affectedFiles.length === 0) {
		return <div style={styles.emptyDetails}>{`Нет уникальных изменений относительно ${branch.baseBranch}`}</div>;
	}
	const conflictReasons = new Map(branch.potentialConflicts.map(file => [file.path, file.reason]));
	return (
		renderFileTree(project.project, branch.affectedFiles.map(file => {
			const fileKey = `${project.project}:branch:${branch.name}:${file.path}`;
			return {
				key: `${branch.name}-${file.status}-${file.previousPath || ''}-${file.path}`,
				path: file.path,
				status: conflictReasons.has(file.path) ? '!' : file.status,
				label: file.previousPath ? `${file.previousPath} -> ${file.path}` : file.path,
				secondaryLabel: file.previousPath ? `было: ${file.previousPath}` : undefined,
				additions: file.additions,
				deletions: file.deletions,
				isBinary: file.isBinary,
				warn: conflictReasons.has(file.path),
				opening: fileHandlers.openingFileKey === fileKey,
				active: fileHandlers.activeFileKey === fileKey,
				viewed: fileHandlers.viewedFileKeys[fileKey] === true,
				onOpenPatch: () => fileHandlers.onOpenFilePatch({ project: project.project, filePath: file.path, previousPath: file.previousPath, mode: 'branch', ref: branch.name, baseRef: branch.baseBranch }, fileKey),
			};
		}))
	);
}

function renderConflictFiles(project: PromptDashboardProjectSummary, fileHandlers: FileRowActionHandlers): React.ReactNode {
	if (project.conflictFiles.length === 0) {
		return null;
	}
	return (
		<div style={styles.detailGroup}>
			<div style={styles.detailGroupTitle}>Файлы с конфликтами</div>
			{renderFileTree(project.project, project.conflictFiles.map(file => {
				const fileKey = `${project.project}:diff:${file}`;
				return {
					key: `${project.project}-${file}`,
					path: file,
					status: '!',
					label: file,
					warn: true,
					opening: fileHandlers.openingFileKey === fileKey,
					active: fileHandlers.activeFileKey === fileKey,
					viewed: fileHandlers.viewedFileKeys[fileKey] === true,
					onOpenPatch: () => fileHandlers.onOpenDiff(project.project, file, fileKey),
				};
			}))}
		</div>
	);
}

/** Renders changed files as a compact branch-guided project tree. */
function renderFileTree(rootLabel: string, entries: DashboardFileTreeEntry[]): React.ReactNode {
	const root = buildFileTree(rootLabel, entries);
	return (
		<div style={styles.fileGraphTree}>
			{renderFileTreeNode(root, { ancestorHasSibling: [], isLast: true }, true)}
		</div>
	);
}

function buildFileTree(rootLabel: string, entries: DashboardFileTreeEntry[]): DashboardFileTreeNode {
	const root: DashboardFileTreeNode = {
		name: rootLabel,
		path: '',
		directories: new Map(),
		files: [],
	};
	for (const entry of entries) {
		const parts = entry.path.split('/').map(part => part.trim()).filter(Boolean);
		const fileName = parts.pop();
		let currentNode = root;
		let currentPath = '';
		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			const existing = currentNode.directories.get(part);
			if (existing) {
				currentNode = existing;
				continue;
			}
			const nextNode: DashboardFileTreeNode = {
				name: part,
				path: currentPath,
				directories: new Map(),
				files: [],
			};
			currentNode.directories.set(part, nextNode);
			currentNode = nextNode;
		}
		currentNode.files.push({ ...entry, path: entry.path, label: fileName || entry.label });
	}
	return root;
}

function resolveFileTone(status: string, warn = false): DashboardFileTone {
	if (warn) {
		return {
			label: '!',
			accentColor: 'var(--vscode-charts-yellow)',
			borderColor: 'color-mix(in srgb, var(--vscode-charts-yellow) 62%, var(--vscode-panel-border))',
			background: 'color-mix(in srgb, var(--vscode-charts-yellow) 10%, var(--vscode-editor-background))',
		};
	}

	switch ((status || '').trim().toUpperCase()) {
		case 'A':
			return {
				label: 'A',
				accentColor: 'var(--vscode-charts-green)',
				borderColor: 'color-mix(in srgb, var(--vscode-charts-green) 50%, var(--vscode-panel-border))',
				background: 'color-mix(in srgb, var(--vscode-charts-green) 9%, var(--vscode-editor-background))',
			};
		case 'D':
			return {
				label: 'D',
				accentColor: 'var(--vscode-charts-red)',
				borderColor: 'color-mix(in srgb, var(--vscode-charts-red) 48%, var(--vscode-panel-border))',
				background: 'color-mix(in srgb, var(--vscode-charts-red) 8%, var(--vscode-editor-background))',
			};
		case 'R':
			return {
				label: 'R',
				accentColor: 'var(--vscode-textLink-foreground)',
				borderColor: 'color-mix(in srgb, var(--vscode-textLink-foreground) 52%, var(--vscode-panel-border))',
				background: 'color-mix(in srgb, var(--vscode-textLink-foreground) 8%, var(--vscode-editor-background))',
			};
		default:
			return {
				label: 'M',
				accentColor: 'var(--vscode-charts-orange, var(--vscode-charts-yellow))',
				borderColor: 'color-mix(in srgb, var(--vscode-charts-orange, var(--vscode-charts-yellow)) 52%, var(--vscode-panel-border))',
				background: 'color-mix(in srgb, var(--vscode-charts-orange, var(--vscode-charts-yellow)) 9%, var(--vscode-editor-background))',
			};
	}
}

/** Renders directory groups with explicit branch guides and project root rows. */
function renderFileTreeNode(
	node: DashboardFileTreeNode,
	context: DashboardFileTreeRowContext,
	isRoot = false,
): React.ReactNode {
	const directories = Array.from(node.directories.values()).sort((left, right) => left.name.localeCompare(right.name, 'ru'));
	const files = [...node.files].sort((left, right) => left.path.localeCompare(right.path, 'ru'));
	const children = [
		...directories.map(directory => ({ kind: 'directory' as const, value: directory })),
		...files.map(file => ({ kind: 'file' as const, value: file })),
	];
	const nextAncestors = [...context.ancestorHasSibling, !context.isLast];
	return (
		<div key={node.path || `root:${node.name}`} style={styles.fileTreeNodeGroup}>
			{renderDirectoryTreeRow(node, context, isRoot)}
			<div style={styles.fileTreeChildren}>
				{children.map((child, index) => {
					const childContext: DashboardFileTreeRowContext = {
						ancestorHasSibling: nextAncestors,
						isLast: index === children.length - 1,
					};
					if (child.kind === 'directory') {
						return renderFileTreeNode(child.value, childContext);
					}
					return renderChangedFileRow(child.value, childContext);
				})}
			</div>
		</div>
	);
}

function renderDirectoryTreeRow(
	node: DashboardFileTreeNode,
	context: DashboardFileTreeRowContext,
	isRoot = false,
): React.ReactNode {
	return (
		<div key={`directory:${node.path || node.name}`} style={styles.fileTreeDirectoryRow}>
			<span style={styles.fileTreeBranchPrefix}>{buildTreeBranchPrefix(context, isRoot)}</span>
			<span style={styles.fileTreeDirectoryIcon}>🗁</span>
			<span style={styles.fileGraphDirectoryName}>{node.name}</span>
		</div>
	);
}

/** Renders one clickable file leaf in the dashboard tree. */
function renderChangedFileRow(input: DashboardFileTreeEntry, context: DashboardFileTreeRowContext): React.ReactNode {
	const fileName = input.path.split('/').pop() || input.label;
	const isOpening = input.opening === true;
	const tone = resolveFileTone(input.status, input.warn === true);
	const lineStats = resolveFileLineStats(input);
	const renameHint = cleanTreeSecondaryLabel(input.secondaryLabel);
	const isActive = input.active === true;
	const isViewed = input.viewed === true;
	return (
		<button
			key={`file:${input.key}`}
			type="button"
			style={{
				...styles.fileTreeFileRow,
				...(isViewed ? styles.fileTreeFileRowViewed : null),
				...(isActive ? styles.fileTreeFileRowActive : null),
			}}
			onClick={input.onOpenPatch}
			title={input.path}
		>
			<span style={styles.fileTreeBranchPrefix}>{buildTreeBranchPrefix(context)}</span>
			<span style={{ ...styles.fileTreeFileBullet, color: input.warn ? 'var(--vscode-charts-yellow)' : isActive ? 'var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground))' : tone.accentColor }}>🗋</span>
			<span style={styles.fileTreeFileMain}>
				<span style={{ ...styles.fileGraphFileName, ...(isViewed ? styles.fileGraphFileNameViewed : null), ...(isActive ? styles.fileGraphFileNameActive : null) }}>{fileName}</span>
				{renameHint ? <span style={styles.fileTreeRenameHint}>{`← ${renameHint}`}</span> : null}
				{isOpening ? <span style={styles.fileTreeOpeningHint}>opening…</span> : null}
				{isActive ? <span style={styles.fileTreeStateBadgeActive}>открыт</span> : null}
				{!isActive && isViewed ? <span style={styles.fileTreeStateBadgeViewed}>просмотрен</span> : null}
			</span>
			{renderLineStats(lineStats)}
		</button>
	);
}

/** Builds one ASCII-like branch prefix for the current tree row. */
function buildTreeBranchPrefix(context: DashboardFileTreeRowContext, isRoot = false): string {
	const indentation = context.ancestorHasSibling
		.map(hasSibling => hasSibling ? '│  ' : '   ')
		.join('');
	const branchMarker = isRoot || context.isLast ? '└─' : '├─';
	return `${indentation}${branchMarker}`;
}

/** Normalizes rename hints so they fit on the same line as the file name. */
function cleanTreeSecondaryLabel(label?: string): string {
	const normalized = (label || '').trim();
	if (!normalized) {
		return '';
	}
	return normalized.replace(/^было:\s*/i, '');
}

function resolveFileLineStats(entry: Pick<DashboardFileTreeEntry, 'additions' | 'deletions' | 'isBinary'>): DashboardLineStats {
	if (entry.isBinary === true) {
		return { added: 0, changed: 0, deleted: 0, kind: 'binary' };
	}
	if (typeof entry.additions !== 'number' || typeof entry.deletions !== 'number') {
		return { added: 0, changed: 0, deleted: 0, kind: 'unknown' };
	}
	const additions = Math.max(0, entry.additions);
	const deletions = Math.max(0, entry.deletions);
	const changed = Math.min(additions, deletions);
	return {
		added: Math.max(0, additions - changed),
		changed,
		deleted: Math.max(0, deletions - changed),
		kind: 'diff',
	};
}

function resolveFileTreeLineStats(node: DashboardFileTreeNode): DashboardLineStats {
	const totals: DashboardLineStats = { added: 0, changed: 0, deleted: 0, kind: 'diff' };
	let hasUnknown = false;
	let hasBinary = false;
	for (const file of node.files) {
		mergeLineStats(totals, resolveFileLineStats(file), (kind) => {
			hasUnknown ||= kind === 'unknown';
			hasBinary ||= kind === 'binary';
		});
	}
	for (const directory of node.directories.values()) {
		mergeLineStats(totals, resolveFileTreeLineStats(directory), (kind) => {
			hasUnknown ||= kind === 'unknown';
			hasBinary ||= kind === 'binary';
		});
	}
	if (totals.added === 0 && totals.changed === 0 && totals.deleted === 0) {
		return { ...totals, kind: hasBinary ? 'binary' : hasUnknown ? 'unknown' : 'diff' };
	}
	return totals;
}

function mergeLineStats(
	target: DashboardLineStats,
	stats: DashboardLineStats,
	rememberSpecialKind: (kind: DashboardLineStats['kind']) => void,
): void {
	if (stats.kind !== 'diff') {
		rememberSpecialKind(stats.kind);
		return;
	}
	target.added += stats.added;
	target.changed += stats.changed;
	target.deleted += stats.deleted;
}

function renderLineStats(stats: DashboardLineStats, compact = false): React.ReactNode {
	if (stats.kind === 'binary') {
		return <span style={styles.fileLineStatsSpecial}>(bin)</span>;
	}
	if (stats.kind === 'unknown') {
		return <span style={styles.fileLineStatsSpecial}>(—)</span>;
	}
	return (
		<span style={compact ? styles.fileLineStatsCompact : styles.fileLineStats}>
			<span style={styles.fileLineStatParen}>(</span>
			<span style={styles.fileLineStatAdded}>+{stats.added}</span>
			{stats.changed > 0 ? <span style={styles.fileLineStatChanged}>~{stats.changed}</span> : null}
			<span style={styles.fileLineStatDeleted}>-{stats.deleted}</span>
			<span style={styles.fileLineStatParen}>)</span>
		</span>
	);
}

function isBranchSwitchBusy(busyAction: DashboardBusyAction): boolean {
	return Boolean(busyAction && busyAction !== 'refresh');
}

function renderSectionMeta(value: string | number, cacheStatus: PromptDashboardLoadStatus, loadingLabel: string): React.ReactNode {
	if (cacheStatus === 'loading') {
		return (
			<span style={styles.sectionMetaLoading}>
				<span style={styles.buttonSpinner} aria-hidden="true" />
				<span>{loadingLabel}</span>
			</span>
		);
	}
	return <span style={styles.sectionMeta}>{value}</span>;
}

function renderLoadingEmptyState(label: string): React.ReactNode {
	return (
		<div style={styles.loadingEmptyState}>
			<span style={styles.buttonSpinner} aria-hidden="true" />
			<span>{label}</span>
		</div>
	);
}

function formatRelativeTime(value: string): string {
	return formatRelativeAge(parseIsoAgeMs(value));
}

function parseIsoAgeMs(value: string): number {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp) : 0;
}

function formatRelativeAge(ageMs: number): string {
	if (!Number.isFinite(ageMs) || ageMs <= 0) {
		return 'сейчас';
	}
	const minutes = Math.floor(ageMs / (60 * 1000));
	if (minutes < 60) {
		return `${Math.max(1, minutes)}m`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 48) {
		return `${hours}h`;
	}
	return `${Math.floor(hours / 24)}d`;
}

function renderAnalysis(analysis: PromptDashboardAnalysisState | null, cacheStatus: string): React.ReactNode {
	const isRunning = analysis?.status === 'running' || cacheStatus === 'loading';
	const sections = parseAnalysisSections(analysis?.content || '');
	const hasPreviewContent = isRunning && sections.length > 0;
	const stateLabel = isRunning
		? (hasPreviewContent ? 'предварительно' : 'проверяем')
		: analysis?.status === 'completed'
			? 'готово'
			: 'ожидание';
	return (
		<section style={styles.section}>
			<div style={styles.sectionHeader}>
				<span style={styles.sectionTitle}>AI review</span>
				<span style={styles.sectionMeta}>{stateLabel}</span>
			</div>
			<div style={styles.sectionBody}>
				<div style={styles.analysisIntro}>
					<span style={isRunning ? styles.analysisStateRunning : styles.analysisStateReady}>{stateLabel}</span>
					<span style={styles.analysisIntroText}>{resolveAnalysisIntroText(analysis, isRunning, hasPreviewContent)}</span>
				</div>
				{sections.length > 0 ? (
					<div style={styles.analysisSections}>
						{sections.map((section, index) => (
							<div key={`${section.title}-${index}`} style={styles.analysisSection}>
								<div style={styles.analysisTitle}>{section.title}</div>
								<div style={styles.analysisBody}>{renderAnalysisLines(section.lines)}</div>
							</div>
						))}
					</div>
				) : (
					/** Renders one aggregated directory row with file count and rolled-up line stats. */
					<div style={styles.emptyText}>{isRunning ? 'AI проверяет ветки и изменения...' : 'AI review появится после загрузки Git-данных.'}</div>
				)}
				{analysis?.error ? <div style={styles.errorText}>{analysis.error}</div> : null}
			</div>
		</section>
	);
}


function resolveAnalysisIntroText(analysis: PromptDashboardAnalysisState | null, isRunning: boolean, hasPreviewContent: boolean): string {
	if (isRunning) {
		if (hasPreviewContent) {
			return 'Показываем быстрый локальный вывод, пока AI уточняет рекомендации.';
		}
		return 'Собираем простой вывод по веткам, проверкам и возможным конфликтам.';
	}
	if (analysis?.status === 'completed') {
		return 'Краткий вывод ниже показывает, что уже можно делать и где нужна ручная проверка.';
	}
	if (analysis?.status === 'error') {
		return 'AI review сейчас недоступен, но остальные Git-виджеты можно проверить вручную.';
	}
	return 'Нужны загруженные Git-данные, чтобы показать понятную рекомендацию.';
}

function parseAnalysisSections(content: string): Array<{ title: string; lines: string[] }> {
	const sections: Array<{ title: string; lines: string[] }> = [];
	let currentSection: { title: string; lines: string[] } | null = null;
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		const heading = line.match(/^#{2,3}\s+(.+)$/);
		if (heading) {
			currentSection = { title: normalizeAnalysisSectionTitle(heading[1].trim()), lines: [] };
			sections.push(currentSection);
			continue;
		}
		if (!currentSection) {
			currentSection = { title: 'Итог', lines: [] };
			sections.push(currentSection);
		}
		if (line) {
			currentSection.lines.push(cleanAnalysisLine(line));
		}
	}
	return sections.filter(section => section.lines.length > 0);
}

function normalizeAnalysisSectionTitle(title: string): string {
	const normalized = title.trim().toLowerCase();
	if (normalized.includes('risk') || normalized.includes('риск')) {
		return 'На что обратить внимание';
	}
	if (normalized.includes('action') || normalized.includes('след') || normalized.includes('next')) {
		return 'Что сделать дальше';
	}
	if (normalized.includes('summary') || normalized.includes('итог')) {
		return 'Что происходит';
	}
	return title.trim() || 'Что важно';
}

function cleanAnalysisLine(line: string): string {
	return line
		.replace(/`([^`]+)`/g, '$1')
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/__([^_]+)__/g, '$1')
		.trim();
}

function renderAnalysisLines(lines: string[]): React.ReactNode {
	return lines.map((line, index) => {
		const bullet = line.match(/^[-*]\s+(.+)$/);
		return (
			<div key={`${line}-${index}`} style={bullet ? styles.analysisBullet : styles.analysisLine}>
				{bullet ? <span style={styles.analysisBulletMarker}>•</span> : null}
				<span>{bullet ? bullet[1] : line}</span>
			</div>
		);
	});
}

const styles: Record<string, React.CSSProperties> = {
	rail: {
		flex: '1 1 360px',
		minWidth: '280px',
		height: '100vh',
		overflowY: 'auto',
		padding: '16px 20px 16px 0',
		boxSizing: 'border-box',
		background: 'transparent',
	},
	toolbar: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: '12px',
		marginBottom: '12px',
	},
	title: {
		fontSize: '14px',
		fontWeight: 700,
		color: 'var(--vscode-foreground)',
	},
	subtitle: {
		fontSize: '11px',
		color: 'var(--vscode-descriptionForeground)',
	},
	iconButton: {
		width: '28px',
		height: '28px',
		border: '1px solid var(--vscode-button-border, transparent)',
		borderRadius: '6px',
		background: 'var(--vscode-button-secondaryBackground)',
		color: 'var(--vscode-button-secondaryForeground)',
		cursor: 'pointer',
		fontFamily: 'var(--vscode-font-family)',
	},
	busyButton: {
		opacity: 0.9,
	},
	buttonSpinner: {
		display: 'inline-block',
		width: '12px',
		height: '12px',
		borderRadius: '999px',
		border: '2px solid color-mix(in srgb, currentColor 28%, transparent)',
		borderTopColor: 'currentColor',
		animation: 'pm-spin 0.8s linear infinite',
		verticalAlign: 'middle',
		flexShrink: 0,
	},
	inlineSpinnerLabel: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '6px',
		justifyContent: 'center',
	},
	widgetGrid: {
		columnWidth: '360px',
		columnCount: 2,
		columnGap: '12px',
	},
	section: {
		display: 'inline-block',
		width: '100%',
		marginBottom: '12px',
		breakInside: 'avoid',
		pageBreakInside: 'avoid',
		verticalAlign: 'top',
		minWidth: 0,
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '6px',
		background: 'var(--vscode-editor-background)',
		overflow: 'visible',
		boxShadow: DASHBOARD_LEFT_ACCENT_SHADOW,
	},
	sectionHeader: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: '10px',
		padding: '10px 12px',
		background: 'var(--vscode-sideBar-background)',
		boxShadow: DASHBOARD_LEFT_ACCENT_SHADOW,
		borderTopLeftRadius: '6px',
		borderTopRightRadius: '6px',
		borderBottom: '1px solid var(--vscode-panel-border)',
	},
	sectionTitle: {
		fontSize: '13px',
		fontWeight: 600,
		color: 'var(--vscode-foreground)',
		whiteSpace: 'nowrap',
	},
	sectionMeta: {
		fontSize: '11px',
		fontWeight: 600,
		color: 'var(--vscode-descriptionForeground)',
		whiteSpace: 'nowrap',
	},
	sectionMetaLoading: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '6px',
		fontSize: '11px',
		fontWeight: 600,
		color: 'var(--vscode-descriptionForeground)',
		whiteSpace: 'nowrap',
	},
	sectionBody: {
		display: 'flex',
		flexDirection: 'column',
		gap: '10px',
		padding: '12px',
	},
	statusBody: {
		minHeight: '72px',
		justifyContent: 'center',
	},
	statusChipRow: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: '12px',
	},
	statusChip: {
		fontSize: '13px',
		fontWeight: 700,
		padding: '5px 10px',
		lineHeight: 1.25,
	},
	statusProgressRow: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
	},
	progressBarContainer: {
		position: 'relative',
		display: 'inline-flex',
		alignItems: 'center',
		width: '100%',
		minWidth: '96px',
		height: '18px',
		borderRadius: '2px',
		background: 'color-mix(in srgb, var(--vscode-editorInfo-foreground, #3794ff) 10%, var(--vscode-sideBar-background, var(--vscode-editor-background)))',
		border: '1px solid var(--vscode-panel-border)',
		boxSizing: 'border-box',
		overflow: 'hidden',
		flexShrink: 0,
	},
	progressBarFill: {
		position: 'absolute',
		left: 0,
		top: 0,
		height: '100%',
		borderRadius: '2px',
		transition: 'width 0.3s ease',
	},
	progressBarText: {
		position: 'relative',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: '100%',
		height: '100%',
		fontSize: '10px',
		fontWeight: 700,
		lineHeight: 1,
		color: 'var(--vscode-sideBar-foreground, var(--vscode-foreground))',
		textShadow: '0 0 1px color-mix(in srgb, var(--vscode-sideBar-background, var(--vscode-editor-background)) 78%, transparent)',
		userSelect: 'none',
		zIndex: 1,
	},
	progressBarTextOverlay: {
		position: 'absolute',
		inset: 0,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: '100%',
		height: '100%',
		fontSize: '10px',
		fontWeight: 700,
		lineHeight: 1,
		textShadow: '0 0 1px color-mix(in srgb, var(--vscode-button-background, #0e639c) 68%, transparent)',
		userSelect: 'none',
		pointerEvents: 'none',
		zIndex: 2,
	},
	activityGroup: {
		display: 'flex',
		flexDirection: 'column',
		gap: '5px',
		minWidth: 0,
	},
	groupTitle: {
		fontSize: '11px',
		fontWeight: 700,
		color: 'var(--vscode-foreground)',
	},
	activityButton: {
		width: '100%',
		display: 'grid',
		gridTemplateColumns: 'auto minmax(0, 1fr) auto',
		alignItems: 'center',
		gap: '8px',
		padding: '5px 0',
		border: 'none',
		borderBottom: '1px solid color-mix(in srgb, var(--vscode-panel-border) 72%, transparent)',
		background: 'transparent',
		color: 'var(--vscode-foreground)',
		fontFamily: 'var(--vscode-font-family)',
		textAlign: 'left',
		cursor: 'pointer',
	},
	bulkBranchRow: {
		display: 'grid',
		gridTemplateColumns: '64px minmax(0, 1fr)',
		alignItems: 'center',
		gap: '8px',
		minWidth: 0,
	},
	bulkBranchLabel: {
		fontSize: '11px',
		fontWeight: 700,
		color: 'var(--vscode-descriptionForeground)',
		whiteSpace: 'nowrap',
	},
	taskBadge: {
		fontSize: '11px',
		fontWeight: 700,
		color: 'var(--vscode-textLink-foreground)',
		whiteSpace: 'nowrap',
	},
	itemTitle: {
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	},
	statValue: {
		fontSize: '11px',
		color: 'var(--vscode-descriptionForeground)',
		whiteSpace: 'nowrap',
	},
	inlineMetricText: {
		fontSize: '10px',
		color: 'var(--vscode-descriptionForeground)',
		lineHeight: 1.4,
	},
	metricNote: {
		fontSize: '10px',
		color: 'var(--vscode-descriptionForeground)',
		lineHeight: 1.4,
	},
	chartProjectRow: {
		display: 'flex',
		flexDirection: 'column',
		gap: '6px',
		paddingBottom: '8px',
		borderBottom: '1px solid color-mix(in srgb, var(--vscode-panel-border) 68%, transparent)',
	},
	chartProjectTitle: {
		fontSize: '11px',
		fontWeight: 700,
		color: 'var(--vscode-foreground)',
	},
	chartMiniList: {
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
	},
	metricRow: {
		display: 'grid',
		gridTemplateColumns: '52px minmax(0, 1fr) auto',
		alignItems: 'center',
		gap: '8px',
		minWidth: 0,
	},
	metricLabel: {
		fontSize: '10px',
		fontWeight: 700,
		color: 'var(--vscode-descriptionForeground)',
		textTransform: 'uppercase',
	},
	metricValue: {
		fontSize: '10px',
		color: 'var(--vscode-descriptionForeground)',
		whiteSpace: 'nowrap',
	},
	divergenceTrack: {
		position: 'relative',
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		alignItems: 'center',
		height: '10px',
		borderRadius: '999px',
		overflow: 'hidden',
		background: 'color-mix(in srgb, var(--vscode-panel-border) 42%, transparent)',
	},
	divergenceBehind: {
		justifySelf: 'end',
		height: '100%',
		background: 'color-mix(in srgb, var(--vscode-charts-red) 80%, transparent)',
	},
	divergenceAhead: {
		justifySelf: 'start',
		height: '100%',
		background: 'color-mix(in srgb, var(--vscode-charts-green) 82%, transparent)',
	},
	divergenceMidline: {
		position: 'absolute',
		left: '50%',
		top: 0,
		bottom: 0,
		width: '1px',
		background: 'color-mix(in srgb, var(--vscode-panel-border) 80%, transparent)',
		transform: 'translateX(-0.5px)',
	},
	stackedBar: {
		display: 'flex',
		alignItems: 'stretch',
		width: '100%',
		height: '14px',
		borderRadius: '999px',
		overflow: 'hidden',
		background: 'color-mix(in srgb, var(--vscode-panel-border) 42%, transparent)',
	},
	stackedBarSegment: {
		height: '100%',
		minWidth: '4px',
	},
	legendList: {
		display: 'grid',
		gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
		gap: '6px 12px',
	},
	legendItem: {
		display: 'grid',
		gridTemplateColumns: '10px minmax(0, 1fr) auto',
		alignItems: 'center',
		gap: '6px',
		minWidth: 0,
	},
	legendSwatch: {
		width: '10px',
		height: '10px',
		borderRadius: '999px',
	},
	ageBarTrack: {
		height: '8px',
		borderRadius: '999px',
		overflow: 'hidden',
		background: 'color-mix(in srgb, var(--vscode-panel-border) 42%, transparent)',
	},
	ageBarFill: {
		display: 'block',
		height: '100%',
		borderRadius: '999px',
		background: 'var(--vscode-charts-blue, var(--vscode-textLink-foreground))',
	},
	ageBarFillStale: {
		background: 'var(--vscode-charts-yellow)',
	},
	hotspotRow: {
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
	},
	hotspotHeader: {
		display: 'grid',
		gridTemplateColumns: 'minmax(0, 1fr) auto',
		alignItems: 'center',
		gap: '8px',
	},
	hotspotBarTrack: {
		height: '8px',
		borderRadius: '999px',
		overflow: 'hidden',
		background: 'color-mix(in srgb, var(--vscode-panel-border) 42%, transparent)',
	},
	hotspotBarFill: {
		display: 'block',
		height: '100%',
		borderRadius: '999px',
		background: 'color-mix(in srgb, var(--vscode-charts-yellow) 70%, var(--vscode-charts-red))',
	},
	emptyText: {
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
		lineHeight: 1.45,
	},
	loadingEmptyState: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '8px',
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
		lineHeight: 1.45,
	},
	branchToolbar: {
		display: 'grid',
		gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
		gap: '6px',
	},
	branchToolbarHint: {
		fontSize: '11px',
		lineHeight: 1.45,
		color: 'var(--vscode-descriptionForeground)',
	},
	primaryButton: {
		minWidth: 0,
		padding: '5px 8px',
		border: '1px solid var(--vscode-button-border, transparent)',
		borderRadius: '4px',
		background: 'var(--vscode-button-background)',
		color: 'var(--vscode-button-foreground)',
		fontFamily: 'var(--vscode-font-family)',
		fontSize: '11px',
		fontWeight: 600,
		cursor: 'pointer',
	},
	secondaryButton: {
		minWidth: 0,
		padding: '5px 8px',
		border: '1px solid var(--vscode-button-border, transparent)',
		borderRadius: '4px',
		background: 'var(--vscode-button-secondaryBackground)',
		color: 'var(--vscode-button-secondaryForeground)',
		fontFamily: 'var(--vscode-font-family)',
		fontSize: '11px',
		fontWeight: 600,
		cursor: 'pointer',
	},
	disabledButton: {
		opacity: 0.55,
		cursor: 'default',
	},
	projectBlock: {
		display: 'flex',
		flexDirection: 'column',
		gap: '10px',
		paddingTop: '12px',
		borderTop: '1px solid var(--vscode-panel-border)',
		minWidth: 0,
	},
	projectBlockFirst: {
		paddingTop: 0,
		borderTop: 'none',
	},
	branchProjectRow: {
		display: 'grid',
		gridTemplateColumns: 'minmax(86px, 0.78fr) minmax(0, 1.22fr) auto auto',
		alignItems: 'center',
		gap: '8px',
		padding: '6px 0',
		borderTop: '1px solid color-mix(in srgb, var(--vscode-panel-border) 68%, transparent)',
		minWidth: 0,
	},
	branchProjectRowFirst: {
		borderTop: 'none',
	},
	branchProjectError: {
		gridColumn: '1 / -1',
	},
	projectHeader: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: '8px',
	},
	projectName: {
		fontWeight: 700,
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	},
	badge: {
		fontSize: '10px',
		lineHeight: '14px',
		padding: '1px 6px',
		borderRadius: '4px',
		border: '1px solid transparent',
		textTransform: 'uppercase',
		whiteSpace: 'nowrap',
	},
	badgeOk: { color: 'var(--vscode-charts-green)', borderColor: 'var(--vscode-charts-green)' },
	badgeWarn: { color: 'var(--vscode-charts-yellow)', borderColor: 'var(--vscode-charts-yellow)' },
	badgeDanger: { color: 'var(--vscode-charts-red)', borderColor: 'var(--vscode-charts-red)' },
	badgeNeutral: { color: 'var(--vscode-descriptionForeground)', borderColor: 'var(--vscode-panel-border)' },
	compactProjectRow: {
		display: 'flex',
		flexDirection: 'column',
		gap: '6px',
		padding: '8px 0',
		borderBottom: '1px solid color-mix(in srgb, var(--vscode-panel-border) 68%, transparent)',
		minWidth: 0,
	},
	checkList: {
		display: 'flex',
		flexDirection: 'column',
		gap: '3px',
	},
	checkRow: {
		display: 'grid',
		gridTemplateColumns: 'minmax(0, 1fr) auto',
		alignItems: 'center',
		gap: '8px',
		fontSize: '11px',
	},
	reviewDetails: {
		display: 'flex',
		flexDirection: 'column',
		gap: '3px',
		minWidth: 0,
	},
	branchSelectLabel: {
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
		width: '100%',
		fontSize: '11px',
		minWidth: 0,
	},
	branchSelectInlineLabel: {
		display: 'block',
		minWidth: 0,
	},
	branchSelect: {
		width: '100%',
		minWidth: 0,
		padding: '5px 8px',
		border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
		borderRadius: '4px',
		background: 'var(--vscode-dropdown-background, var(--vscode-input-background))',
		color: 'var(--vscode-dropdown-foreground, var(--vscode-input-foreground))',
		fontFamily: 'var(--vscode-font-family)',
		fontSize: '12px',
	},
	metaGrid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))',
		gap: '8px 12px',
		fontSize: '11px',
	},
	metaValue: {
		display: 'block',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	},
	muted: {
		color: 'var(--vscode-descriptionForeground)',
	},
	detailGroup: {
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
		minWidth: 0,
	},
	detailGroupTitle: {
		fontSize: '11px',
		fontWeight: 700,
		color: 'var(--vscode-foreground)',
	},
	detailBlock: {
		minWidth: 0,
	},
	detailButton: {
		width: '100%',
		display: 'grid',
		gridTemplateColumns: '12px auto minmax(0, 1fr) auto',
		alignItems: 'center',
		gap: '7px',
		padding: '5px 0',
		border: 'none',
		borderBottom: '1px solid color-mix(in srgb, var(--vscode-panel-border) 68%, transparent)',
		background: 'transparent',
		color: 'var(--vscode-foreground)',
		fontFamily: 'var(--vscode-font-family)',
		fontSize: '11px',
		textAlign: 'left',
		cursor: 'pointer',
	},
	detailChevron: {
		color: 'var(--vscode-descriptionForeground)',
	},
	commitSha: {
		fontFamily: 'var(--vscode-editor-font-family)',
		color: 'var(--vscode-textLink-foreground)',
		whiteSpace: 'nowrap',
	},
	commitSubject: {
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	},
	branchName: {
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		fontFamily: 'var(--vscode-editor-font-family)',
	},
	fileCount: {
		minWidth: '22px',
		padding: '1px 5px',
		borderRadius: '4px',
		border: '1px solid var(--vscode-panel-border)',
		color: 'var(--vscode-descriptionForeground)',
		textAlign: 'center',
		fontSize: '10px',
	},
	fileCountWarn: {
		color: 'var(--vscode-charts-yellow)',
		borderColor: 'var(--vscode-charts-yellow)',
	},
	fileGraphTree: {
		display: 'flex',
		flexDirection: 'column',
		gap: '1px',
		paddingTop: '4px',
		minWidth: 0,
	},
	fileTreeNodeGroup: {
		display: 'flex',
		flexDirection: 'column',
		gap: '0',
		minWidth: 0,
	},
	fileTreeChildren: {
		display: 'flex',
		flexDirection: 'column',
		gap: '0',
		minWidth: 0,
	},
	fileTreeDirectoryRow: {
		display: 'grid',
		gridTemplateColumns: 'auto 18px minmax(0, 1fr)',
		alignItems: 'center',
		gap: '4px',
		minHeight: '20px',
		padding: '0',
		borderRadius: '3px',
		color: 'var(--vscode-descriptionForeground)',
		fontSize: '10px',
		minWidth: 0,
	},
	fileTreeBranchPrefix: {
		fontFamily: 'var(--vscode-editor-font-family)',
		fontSize: '11px',
		whiteSpace: 'pre',
		color: 'var(--vscode-descriptionForeground)',
	},
	fileTreeDirectoryIcon: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontSize: '12px',
		color: 'var(--vscode-textLink-foreground)',
	},
	fileGraphDirectoryName: {
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		fontFamily: 'var(--vscode-font-family)',
		fontWeight: 500,
		color: 'var(--vscode-foreground)',
	},
	fileTreeFileRow: {
		width: '100%',
		display: 'grid',
		gridTemplateColumns: 'auto 18px minmax(0, 1fr) auto',
		alignItems: 'center',
		gap: '4px',
		minHeight: '20px',
		padding: '0',
		border: 'none',
		borderRadius: '3px',
		background: 'transparent',
		color: 'var(--vscode-foreground)',
		fontFamily: 'var(--vscode-font-family)',
		fontSize: '10px',
		textAlign: 'left',
		cursor: 'pointer',
		minWidth: 0,
	},
	fileTreeFileRowViewed: {
		background: 'color-mix(in srgb, var(--vscode-textLink-foreground) 5%, transparent)',
	},
	fileTreeFileRowActive: {
		background: 'color-mix(in srgb, var(--vscode-textLink-foreground) 12%, transparent)',
		outline: '1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 38%, transparent)',
	},
	fileTreeFileBullet: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontSize: '12px',
		lineHeight: 1,
	},
	fileTreeFileMain: {
		display: 'inline-flex',
		alignItems: 'baseline',
		gap: '4px',
		minWidth: 0,
		whiteSpace: 'nowrap',
		overflow: 'hidden',
	},
	fileTreeRenameHint: {
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		fontSize: '9px',
		color: 'var(--vscode-descriptionForeground)',
	},
	fileTreeOpeningHint: {
		fontSize: '9px',
		color: 'var(--vscode-descriptionForeground)',
		whiteSpace: 'nowrap',
	},
	fileTreeStateBadgeActive: {
		padding: '1px 4px',
		borderRadius: '3px',
		background: 'color-mix(in srgb, var(--vscode-textLink-foreground) 14%, transparent)',
		color: 'var(--vscode-textLink-foreground)',
		fontSize: '9px',
		fontWeight: 600,
		whiteSpace: 'nowrap',
	},
	fileTreeStateBadgeViewed: {
		padding: '1px 4px',
		borderRadius: '3px',
		background: 'color-mix(in srgb, var(--vscode-descriptionForeground) 12%, transparent)',
		color: 'var(--vscode-descriptionForeground)',
		fontSize: '9px',
		fontWeight: 500,
		whiteSpace: 'nowrap',
	},
	fileGraphFileCopy: {
		display: 'flex',
		flexDirection: 'column',
		gap: '1px',
		minWidth: 0,
	},
	fileGraphFileName: {
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		fontFamily: 'var(--vscode-font-family)',
		fontWeight: 500,
		color: 'var(--vscode-foreground)',
	},
	fileGraphFileNameViewed: {
		color: 'color-mix(in srgb, var(--vscode-foreground) 82%, var(--vscode-descriptionForeground))',
	},
	fileGraphFileNameActive: {
		color: 'var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground))',
		fontWeight: 600,
	},
	fileGraphFilePath: {
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		fontSize: '10px',
		color: 'var(--vscode-descriptionForeground)',
	},
	fileGraphActions: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'flex-end',
		gap: '4px',
		whiteSpace: 'nowrap',
	},
	fileLineStats: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '3px',
		whiteSpace: 'nowrap',
		fontSize: '10px',
	},
	fileLineStatsCompact: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '3px',
		whiteSpace: 'nowrap',
		fontSize: '9px',
	},
	fileLineStatsSpecial: {
		fontSize: '9px',
		color: 'var(--vscode-descriptionForeground)',
		whiteSpace: 'nowrap',
	},
	fileLineStatAdded: {
		color: 'var(--vscode-charts-green)',
	},
	fileLineStatChanged: {
		color: 'var(--vscode-charts-yellow)',
	},
	fileLineStatDeleted: {
		color: 'var(--vscode-charts-red)',
	},
	fileLineStatParen: {
		color: 'var(--vscode-descriptionForeground)',
	},
	fileStatus: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		minWidth: '22px',
		height: '22px',
		padding: '0 6px',
		fontFamily: 'var(--vscode-editor-font-family)',
		fontWeight: 700,
		color: 'var(--vscode-descriptionForeground)',
		textAlign: 'center',
		border: '1px solid color-mix(in srgb, var(--vscode-panel-border) 82%, transparent)',
		borderRadius: '999px',
		lineHeight: 1,
		fontSize: '9px',
		textTransform: 'uppercase',
		letterSpacing: '0.04em',
	},
	fileStatusWarn: {
		color: 'var(--vscode-charts-yellow)',
		borderColor: 'var(--vscode-charts-yellow)',
	},
	fileOpenBadge: {
		padding: '2px 7px',
		borderRadius: '999px',
		background: 'color-mix(in srgb, var(--vscode-textLink-foreground) 12%, transparent)',
		color: 'var(--vscode-textLink-foreground)',
		fontSize: '9px',
		fontWeight: 700,
		textTransform: 'uppercase',
		whiteSpace: 'nowrap',
	},
	fileOpenBadgeBusy: {
		padding: '2px 7px',
		borderRadius: '999px',
		background: 'color-mix(in srgb, var(--vscode-charts-yellow) 12%, transparent)',
		color: 'var(--vscode-charts-yellow)',
		fontSize: '9px',
		fontWeight: 700,
		textTransform: 'uppercase',
		whiteSpace: 'nowrap',
	},
	fileWarnBadge: {
		padding: '3px 7px',
		borderRadius: '999px',
		border: '1px solid color-mix(in srgb, var(--vscode-charts-yellow) 34%, transparent)',
		background: 'color-mix(in srgb, var(--vscode-charts-yellow) 14%, transparent)',
		color: 'var(--vscode-charts-yellow)',
		fontSize: '9px',
		fontWeight: 700,
		textTransform: 'uppercase',
		whiteSpace: 'nowrap',
	},
	inlineButton: {
		padding: '1px 6px',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '4px',
		background: 'transparent',
		color: 'var(--vscode-textLink-foreground)',
		fontFamily: 'var(--vscode-font-family)',
		fontSize: '10px',
		cursor: 'pointer',
		whiteSpace: 'nowrap',
	},
	emptyDetails: {
		padding: '5px 0 2px 19px',
		fontSize: '11px',
		color: 'var(--vscode-descriptionForeground)',
	},
	analysisIntro: {
		display: 'grid',
		gridTemplateColumns: 'auto minmax(0, 1fr)',
		alignItems: 'start',
		gap: '8px',
		padding: '8px',
		border: '1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 28%, var(--vscode-panel-border))',
		borderRadius: '5px',
		background: 'color-mix(in srgb, var(--vscode-textLink-foreground) 7%, var(--vscode-editor-background))',
	},
	analysisIntroText: {
		fontSize: '12px',
		lineHeight: 1.45,
		color: 'var(--vscode-foreground)',
	},
	analysisStateRunning: {
		padding: '2px 6px',
		borderRadius: '4px',
		border: '1px solid var(--vscode-charts-yellow)',
		color: 'var(--vscode-charts-yellow)',
		fontSize: '10px',
		fontWeight: 700,
		whiteSpace: 'nowrap',
	},
	analysisStateReady: {
		padding: '2px 6px',
		borderRadius: '4px',
		border: '1px solid var(--vscode-textLink-foreground)',
		color: 'var(--vscode-textLink-foreground)',
		fontSize: '10px',
		fontWeight: 700,
		whiteSpace: 'nowrap',
	},
	analysisSections: {
		display: 'flex',
		flexDirection: 'column',
		gap: '8px',
	},
	analysisSection: {
		border: '1px solid color-mix(in srgb, var(--vscode-panel-border) 74%, transparent)',
		borderRadius: '5px',
		overflow: 'hidden',
	},
	analysisTitle: {
		padding: '6px 8px',
		background: 'var(--vscode-sideBar-background)',
		borderBottom: '1px solid color-mix(in srgb, var(--vscode-panel-border) 74%, transparent)',
		fontSize: '12px',
		fontWeight: 700,
		color: 'var(--vscode-foreground)',
	},
	analysisBody: {
		display: 'flex',
		flexDirection: 'column',
		gap: '5px',
		padding: '8px',
	},
	analysisLine: {
		fontSize: '12px',
		lineHeight: 1.45,
		color: 'var(--vscode-foreground)',
	},
	analysisBullet: {
		display: 'grid',
		gridTemplateColumns: '12px minmax(0, 1fr)',
		gap: '4px',
		fontSize: '12px',
		lineHeight: 1.45,
		color: 'var(--vscode-foreground)',
	},
	analysisBulletMarker: {
		color: 'var(--vscode-textLink-foreground)',
	},
	errorText: {
		fontSize: '12px',
		color: 'var(--vscode-errorForeground)',
		lineHeight: 1.4,
	},
};