import React, { useEffect, useRef, useState } from 'react';
import { PromptStatusText } from '../../shared/PromptStatusText';
import { getPromptStatusColor } from '../../shared/promptStatus';
import type { GitOverlayChangeFile } from '../../../types/git.js';
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
	onHydrateProjectsDetails: (projects: string[], reason?: 'details' | 'dirty-files') => void;
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
	hideUnknownLineStats?: boolean;
	showBranchPrefix?: boolean;
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

/** Stores a pending lazy-hydration request for one expanded dashboard block. */
interface DashboardHydrationRequest {
	projects: string[];
	reason: 'details' | 'dirty-files';
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

	// Drop stale branch drafts once refreshed project data confirms the branch is current again.
	useEffect(() => {
		setBranchDrafts(previous => reconcileBranchDrafts(projects, previous));
	}, [projects]);

	// Retry lazy details hydration for already-open blocks once the projects widget finishes refreshing.
	useEffect(() => {
		for (const [key, isExpanded] of Object.entries(expanded)) {
			if (!isExpanded) {
				continue;
			}
			maybeHydrateExpandedDetails(key, projects, projectsCacheStatus, onHydrateProjectsDetails);
		}
	}, [expanded, onHydrateProjectsDetails, projects, projectsCacheStatus]);

	if (mode !== 'full') {
		return null;
	}

	const toggleExpanded = (key: string) => {
		setExpanded(previous => ({ ...previous, [key]: !previous[key] }));
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
				<div style={styles.titleRow}>
					<PromptDashboardMark />
					<div style={styles.titleBlock}>
						<div style={styles.title}>Обзор</div>
						<div style={styles.subtitle}>{resolveCacheLabel(snapshot)}</div>
					</div>
				</div>
				<button type="button" style={{ ...styles.iconButton, ...(isRefreshBusy ? styles.busyButton : null) }} onClick={onRefresh} title="Обновить" aria-label="Обновить" disabled={isRefreshBusy}>
					{isRefreshBusy ? <span style={styles.buttonSpinner} aria-hidden="true" /> : '↻'}
				</button>
			</div>

			<div style={styles.widgetGrid}>
				{renderStatus(snapshot, statusCacheStatus)}
				{renderActivity(snapshot, onOpenPrompt, activityCacheStatus)}
				{renderProjectBranches(projects, expanded, branchDrafts, bulkBranchDraft, busyAction, projectsCacheStatus, fileHandlers, setBranchDrafts, toggleExpanded, applyBulkBranchDraft, applyBranchDrafts, applyBranchPreset, applyProjectBranch)}
				{renderProjectCommits(projects, expanded, toggleExpanded, fileHandlers, projectsCacheStatus)}
				{renderReviewRequests(projects, projectsCacheStatus)}
				{renderParallelBranchFiles(projects, expanded, toggleExpanded, fileHandlers, projectsCacheStatus)}
				{renderAnalysis(snapshot?.aiAnalysis.data || null, snapshot?.aiAnalysis.cache.status || 'idle')}
			</div>
		</aside>
	);
};

/** Renders the colored marketplace pm mark used in the dashboard heading. */
function PromptDashboardMark() {
	return (
		<svg viewBox="0 0 256 256" style={styles.titleIcon} aria-hidden="true" data-pm-dashboard-logo="true" focusable="false">
			<defs>
				<linearGradient id="pm-dashboard-logo-bg" x1="22" y1="18" x2="228" y2="238" gradientUnits="userSpaceOnUse">
					<stop offset="0" stopColor="#1B2A40" />
					<stop offset="0.58" stopColor="#101827" />
					<stop offset="1" stopColor="#080C13" />
				</linearGradient>
				<linearGradient id="pm-dashboard-logo-accent" x1="52" y1="180" x2="204" y2="198" gradientUnits="userSpaceOnUse">
					<stop offset="0" stopColor="#77EFFF" />
					<stop offset="1" stopColor="#309FFF" />
				</linearGradient>
			</defs>
			<rect x="16" y="16" width="224" height="224" rx="40" fill="url(#pm-dashboard-logo-bg)" />
			<rect x="16.75" y="16.75" width="222.5" height="222.5" rx="39.25" stroke="#31465F" strokeWidth="1.5" />
			<text x="128" y="167" textAnchor="middle" fill="#F6F8FC" stroke="url(#pm-dashboard-logo-bg)" strokeWidth="10" strokeLinejoin="round" paintOrder="stroke fill" fontFamily="'DejaVu Sans', 'Liberation Sans', sans-serif" fontSize="154" fontWeight="800" letterSpacing="-6">pm</text>
			<rect x="52" y="180" width="152" height="18" rx="9" fill="url(#pm-dashboard-logo-accent)" />
		</svg>
	);
}

/** Requests lazy project detail hydration only when the user opens an unloaded detail block. */
function maybeHydrateExpandedDetails(
	key: string,
	projects: PromptDashboardProjectSummary[],
	cacheStatus: PromptDashboardLoadStatus,
	onHydrateProjectsDetails: (projects: string[], reason?: 'details' | 'dirty-files') => void,
): void {
	if (cacheStatus === 'loading') {
		return;
	}

	const request = resolveExpandedDetailsHydrationRequest(key, projects);
	if (!request) {
		return;
	}

	onHydrateProjectsDetails(request.projects, request.reason);
}


/** Resolves which expanded block still needs lazy details and which host route should hydrate it. */
export function resolveExpandedDetailsHydrationRequest(
	key: string,
	projects: PromptDashboardProjectSummary[],
): DashboardHydrationRequest | null {
	const [kind, projectName, ...rest] = key.split(':');
	if (!kind || !projectName) {
		return null;
	}

	const project = projects.find(item => item.project === projectName);
	if (!project) {
		return null;
	}

	if (kind === 'dirty') {
		return project.uncommittedFiles.some(file => file.group !== 'untracked' && file.isBinary !== true && (file.additions === null || file.deletions === null))
			? { projects: [project.project], reason: 'dirty-files' }
			: null;
	}

	if (rest.length === 0) {
		return null;
	}

	if (kind === 'commit') {
		const commitSha = rest.join(':');
		if (project.recentCommits.some(commit => commit.sha === commitSha && commit.changedFilesHydrated === false)) {
			return { projects: [project.project], reason: 'details' };
		}
		return null;
	}

	if (kind === 'parallel') {
		const branchName = rest.join(':');
		if (project.parallelBranches.some(branch => branch.name === branchName && branch.detailsHydrated === false)) {
			return { projects: [project.project], reason: 'details' };
		}
		return null;
	}

	return null;
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
	expanded: ExpandedState,
	branchDrafts: Record<string, string>,
	bulkBranchDraft: string,
	busyAction: DashboardBusyAction,
	cacheStatus: PromptDashboardLoadStatus,
	fileHandlers: FileRowActionHandlers,
	setBranchDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>,
	toggleExpanded: (key: string) => void,
	applyBulkBranchDraft: (branch: string) => void,
	applyBranchDrafts: () => void,
	applyBranchPreset: (kind: 'prompt' | 'tracked') => void,
	applyProjectBranch: (project: PromptDashboardProjectSummary) => void,
): React.ReactNode {
	const changedCount = Object.keys(buildChangedBranchTargets(projects, branchDrafts)).length;
	const sharedOptions = buildSharedBranchOptions(projects);
	const isSwitchBusy = isBranchSwitchBusy(busyAction);
	const hasPromptPresetBranch = projects.some(project => Boolean(project.promptBranch.trim()));
	const isPromptPresetBusy = busyAction === 'preset:prompt';
	const isTrackedPresetBusy = busyAction === 'preset:tracked';
	const isBulkSwitchBusy = busyAction === 'switch-all';
	const isPromptPresetDisabled = isSwitchBusy || !hasPromptPresetBranch;
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
					<button type="button" style={{ ...styles.secondaryButton, ...(isPromptPresetBusy ? styles.busyButton : null), ...(isPromptPresetDisabled && !isPromptPresetBusy ? styles.disabledButton : null) }} onClick={() => applyBranchPreset('prompt')} title={hasPromptPresetBranch ? 'Сразу переключить каждый проект на его ветку из поля prompt branch' : 'У промпта не задана ветка Git'} disabled={isPromptPresetDisabled}>
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
				) : projects.map((project, index) => renderBranchProject(project, index, expanded, branchDrafts, busyAction, fileHandlers, setBranchDrafts, toggleExpanded, applyProjectBranch))}
			</div>
		</section>
	);
}

function renderBranchProject(
	project: PromptDashboardProjectSummary,
	index: number,
	expanded: ExpandedState,
	branchDrafts: Record<string, string>,
	busyAction: DashboardBusyAction,
	fileHandlers: FileRowActionHandlers,
	setBranchDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>,
	toggleExpanded: (key: string) => void,
	applyProjectBranch: (project: PromptDashboardProjectSummary) => void,
): React.ReactNode {
	const branchOptions = buildBranchOptions(project);
	const selectedBranch = resolveBranchDraft(project, branchDrafts);
	const isChanged = selectedBranch && selectedBranch !== project.currentBranch;
	const isSwitchBusy = isBranchSwitchBusy(busyAction);
	const isProjectBusy = busyAction === `switch-project:${project.project}`;
	const selectedLabel = isChanged ? 'выбрана' : 'текущая';
	const dirtyFilesToggleKey = `dirty:${project.project}`;
	const hasUncommittedFiles = project.uncommittedFiles.length > 0;
	const uncommittedFilesExpanded = expanded[dirtyFilesToggleKey] === true;
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
			{project.branchSwitchError ? renderBranchProjectErrorBlock(project.branchSwitchError) : null}
			{hasUncommittedFiles ? renderBranchProjectUncommittedFiles(project, dirtyFilesToggleKey, uncommittedFilesExpanded, fileHandlers, toggleExpanded) : null}
			{project.error ? renderBranchProjectErrorBlock(project.error) : null}
		</div>
	);
}

/** Renders one outlined branch-switch error under the affected project row. */
function renderBranchProjectErrorBlock(message: string): React.ReactNode {
	return (
		<div style={styles.branchProjectErrorBlock}>
			<div style={styles.branchProjectErrorTitle}>Ошибка переключения ветки</div>
			<div style={styles.errorText}>{message}</div>
		</div>
	);
}

/** Renders a collapsible outlined notice about local uncommitted files under the branch selector row. */
function renderBranchProjectUncommittedFiles(
	project: PromptDashboardProjectSummary,
	toggleKey: string,
	expanded: boolean,
	fileHandlers: FileRowActionHandlers,
	toggleExpanded: (key: string) => void,
): React.ReactNode {
	const files = project.uncommittedFiles;
	return (
		<div style={styles.branchProjectNoticeBlock}>
			<button
				type="button"
				style={styles.branchProjectNoticeToggle}
				onClick={() => toggleExpanded(toggleKey)}
				title={expanded ? 'Скрыть список незакоммиченных файлов' : 'Показать список незакоммиченных файлов'}
			>
				<span style={styles.detailChevron}>{expanded ? '▾' : '▸'}</span>
				<span style={styles.branchProjectNoticeText}>Незакоммиченные файлы</span>
				<span style={{ ...styles.fileCount, ...styles.fileCountWarn }}>{files.length}</span>
			</button>
			{expanded ? (
				renderBranchProjectUncommittedFileList(project, files, fileHandlers)
			) : null}
		</div>
	);
}

/** Reuses the dashboard file-row renderer so dirty files open diffs with active-state highlighting. */
function renderBranchProjectUncommittedFileList(
	project: PromptDashboardProjectSummary,
	files: GitOverlayChangeFile[],
	fileHandlers: FileRowActionHandlers,
): React.ReactNode {
	const entries = [...files]
		.sort((left, right) => left.path.localeCompare(right.path, 'ru'))
		.map((file, index) => {
			const fileKey = `${project.project}:dirty:${file.group}:${file.previousPath || ''}:${file.path}`;
			return {
				key: `${file.group}:${file.status}:${file.previousPath || ''}:${file.path}:${index}`,
				path: file.path,
				status: file.status,
				label: file.previousPath ? `${file.previousPath} -> ${file.path}` : file.path,
				secondaryLabel: file.previousPath ? `было: ${file.previousPath}` : resolveBranchProjectSecondaryLabel(file),
				additions: file.additions,
				deletions: file.deletions,
				isBinary: file.isBinary,
				showBranchPrefix: false,
				warn: file.conflicted,
				opening: fileHandlers.openingFileKey === fileKey,
				active: fileHandlers.activeFileKey === fileKey,
				viewed: fileHandlers.viewedFileKeys[fileKey] === true,
				onOpenPatch: () => fileHandlers.onOpenDiff(project.project, file.path, fileKey),
			} satisfies DashboardFileTreeEntry;
		});

	return (
		<div style={styles.branchProjectNoticeList}>
			{entries.map((entry, index) => renderChangedFileRow(entry, { ancestorHasSibling: [], isLast: index === entries.length - 1 }))}
		</div>
	);
}

/** Adds a short readable hint instead of opaque group shorthands like "work". */
function resolveBranchProjectSecondaryLabel(file: GitOverlayChangeFile): string | undefined {
	switch (file.group) {
		case 'merge': return 'конфликт при merge';
		case 'staged': return 'подготовлено к коммиту';
		case 'working-tree': return 'локальные изменения';
		case 'untracked': return 'новый файл';
		default: return undefined;
	}
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

/** Removes only drafts that already became the refreshed current branch or are no longer valid. */
export function reconcileBranchDrafts(
	projects: PromptDashboardProjectSummary[],
	branchDrafts: Record<string, string>,
): Record<string, string> {
	const entries = Object.entries(branchDrafts);
	if (entries.length === 0) {
		return branchDrafts;
	}

	const projectsByName = new Map(projects.map(project => [project.project, project] as const));
	let changed = false;
	const nextDrafts: Record<string, string> = {};

	for (const [projectName, rawDraft] of entries) {
		const draft = String(rawDraft || '').trim();
		const project = projectsByName.get(projectName);
		if (!draft || !project) {
			changed = true;
			continue;
		}

		const isAvailable = buildBranchOptions(project).some(option => option.branch === draft && option.available);
		if (!isAvailable || draft === String(project.currentBranch || '').trim()) {
			changed = true;
			continue;
		}

		nextDrafts[projectName] = draft;
		changed = changed || draft !== rawDraft;
	}

	return changed ? nextDrafts : branchDrafts;
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
			borderColor: 'color-mix(in srgb, var(--vscode-charts-yellow) 74%, var(--vscode-panel-border))',
			background: 'color-mix(in srgb, var(--vscode-charts-yellow) 18%, var(--vscode-editor-background))',
		};
	}

	switch ((status || '').trim().toUpperCase()) {
		case 'A':
			return {
				label: '+',
				accentColor: 'var(--vscode-charts-green)',
				borderColor: 'color-mix(in srgb, var(--vscode-charts-green) 68%, var(--vscode-panel-border))',
				background: 'color-mix(in srgb, var(--vscode-charts-green) 16%, var(--vscode-editor-background))',
			};
		case 'D':
			return {
				label: '-',
				accentColor: 'var(--vscode-charts-red)',
				borderColor: 'color-mix(in srgb, var(--vscode-charts-red) 66%, var(--vscode-panel-border))',
				background: 'color-mix(in srgb, var(--vscode-charts-red) 16%, var(--vscode-editor-background))',
			};
		case 'R':
			return {
				label: '↺',
				accentColor: 'var(--vscode-textLink-foreground)',
				borderColor: 'color-mix(in srgb, var(--vscode-textLink-foreground) 66%, var(--vscode-panel-border))',
				background: 'color-mix(in srgb, var(--vscode-textLink-foreground) 16%, var(--vscode-editor-background))',
			};
		case '??':
		case '?':
			return {
				label: '+',
				accentColor: 'var(--vscode-charts-green)',
				borderColor: 'color-mix(in srgb, var(--vscode-charts-green) 68%, var(--vscode-panel-border))',
				background: 'color-mix(in srgb, var(--vscode-charts-green) 16%, var(--vscode-editor-background))',
			};
		case 'U':
		case 'UU':
			return {
				label: '!',
				accentColor: 'var(--vscode-charts-yellow)',
				borderColor: 'color-mix(in srgb, var(--vscode-charts-yellow) 74%, var(--vscode-panel-border))',
				background: 'color-mix(in srgb, var(--vscode-charts-yellow) 18%, var(--vscode-editor-background))',
			};
		default:
			return {
				label: '~',
				accentColor: 'var(--vscode-charts-orange, var(--vscode-charts-yellow))',
				borderColor: 'color-mix(in srgb, var(--vscode-charts-orange, var(--vscode-charts-yellow)) 70%, var(--vscode-panel-border))',
				background: 'color-mix(in srgb, var(--vscode-charts-orange, var(--vscode-charts-yellow)) 18%, var(--vscode-editor-background))',
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
	const showBranchPrefix = input.showBranchPrefix !== false;
	const fileLead = showBranchPrefix
		? <span style={{ ...styles.fileTreeFileBullet, color: input.warn ? 'var(--vscode-charts-yellow)' : isActive ? 'var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground))' : tone.accentColor }}>🗋</span>
		: (
			<span
				style={{
					...styles.fileStatus,
					...(input.warn ? styles.fileStatusWarn : null),
					color: isActive ? 'var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground))' : tone.accentColor,
					borderColor: isActive ? 'color-mix(in srgb, var(--vscode-textLink-foreground) 58%, var(--vscode-panel-border))' : tone.borderColor,
					background: isActive ? 'color-mix(in srgb, var(--vscode-textLink-foreground) 16%, transparent)' : tone.background,
				}}
			>
				{tone.label}
			</span>
		);
	return (
		<button
			key={`file:${input.key}`}
			type="button"
			style={{
				...styles.fileTreeFileRow,
				...(showBranchPrefix ? null : styles.fileTreeFileRowFlat),
				...(isViewed ? styles.fileTreeFileRowViewed : null),
				...(isActive ? styles.fileTreeFileRowActive : null),
			}}
			onClick={input.onOpenPatch}
			title={input.path}
		>
			{showBranchPrefix ? <span style={styles.fileTreeBranchPrefix}>{buildTreeBranchPrefix(context)}</span> : null}
			{fileLead}
			<span style={styles.fileTreeFileMain}>
				<span style={{ ...styles.fileGraphFileName, ...(isViewed ? styles.fileGraphFileNameViewed : null), ...(isActive ? styles.fileGraphFileNameActive : null) }}>{fileName}</span>
				{renameHint ? <span style={styles.fileTreeRenameHint}>{`← ${renameHint}`}</span> : null}
				{isOpening ? <span style={styles.fileTreeOpeningHint}>opening…</span> : null}
				{isActive ? <span style={styles.fileTreeStateBadgeActive}>открыт</span> : null}
				{!isActive && isViewed ? <span style={styles.fileTreeStateBadgeViewed}>просмотрен</span> : null}
			</span>
			{renderLineStats(lineStats, false, { hideUnknown: input.hideUnknownLineStats === true })}
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

function renderLineStats(
	stats: DashboardLineStats,
	compact = false,
	options?: { hideUnknown?: boolean },
): React.ReactNode {
	if (stats.kind === 'binary') {
		return <span style={styles.fileLineStatsSpecial}>(bin)</span>;
	}
	if (stats.kind === 'unknown') {
		if (options?.hideUnknown) {
			return null;
		}
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

/** Groups inline dashboard styles by layout, widget cards, branch controls, shared trees, and analysis blocks. */
const styles: Record<string, React.CSSProperties> = {
	// Rail layout, toolbar chrome, and the shared dashboard header.
	// Корневая правая колонка дашборда с вертикальной прокруткой.
	rail: {
		flex: '1 1 360px',
		minWidth: '280px',
		height: '100vh',
		overflowY: 'auto',
		padding: '12px 20px 16px 0',
		boxSizing: 'border-box',
		background: 'transparent',
	},
	// Верхняя строка с заголовком и кнопкой ручного обновления.
	toolbar: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: '12px',
		marginBottom: '12px',
	},
	// Ряд с логотипом и текстовым блоком заголовка.
	titleRow: {
		display: 'flex',
		alignItems: 'center',
		gap: '10px',
		minWidth: 0,
	},
	// Колонка из основного заголовка и подписи времени кеша.
	titleBlock: {
		display: 'flex',
		flexDirection: 'column',
		gap: '2px',
		minWidth: 0,
	},
	// Размер бренд-иконки возле заголовка обзора.
	titleIcon: {
		width: '32px',
		height: '32px',
		flexShrink: 0,
	},
	// Основной текст заголовка панели обзора.
	title: {
		fontSize: '14px',
		fontWeight: 700,
		color: 'var(--vscode-foreground)',
	},
	// Вторая строка под заголовком с меткой обновления.
	subtitle: {
		fontSize: '11px',
		color: 'var(--vscode-descriptionForeground)',
	},
	// Базовый вид круглой кнопки в тулбаре.
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
	// Небольшое затемнение кнопки во время фонового действия.
	busyButton: {
		opacity: 0.9,
	},
	// Общий маленький спиннер для загрузки и busy-кнопок.
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
	// Ряд, который выравнивает спиннер и текст на кнопке.
	inlineSpinnerLabel: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '6px',
		justifyContent: 'center',
	},
	// Masonry-сетка карточек внутри правой панели.
	widgetGrid: {
		columnWidth: '360px',
		columnCount: 2,
		columnGap: '12px',
	},
	// Общая карточка любого виджета дашборда.
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
	// Шапка карточки с названием и правой мета-информацией.
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
	// Текст названия виджета в шапке карточки.
	sectionTitle: {
		fontSize: '13px',
		fontWeight: 600,
		color: 'var(--vscode-foreground)',
		whiteSpace: 'nowrap',
	},
	// Правая компактная метка со счетчиком или статусом секции.
	sectionMeta: {
		fontSize: '11px',
		fontWeight: 600,
		color: 'var(--vscode-descriptionForeground)',
		whiteSpace: 'nowrap',
	},
	// Метка секции в состоянии загрузки со спиннером.
	sectionMetaLoading: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '6px',
		fontSize: '11px',
		fontWeight: 600,
		color: 'var(--vscode-descriptionForeground)',
		whiteSpace: 'nowrap',
	},
	// Основное содержимое карточки с вертикальным стеком элементов.
	sectionBody: {
		display: 'flex',
		flexDirection: 'column',
		gap: '10px',
		padding: '12px',
	},
	// Вертикальное центрирование контента карточки статуса.
	statusBody: {
		minHeight: '72px',
		justifyContent: 'center',
	},
	// Ряд с badge статуса и вторичными значениями.
	statusChipRow: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: '12px',
	},
	// Визуальный badge статуса промпта.
	statusChip: {
		fontSize: '13px',
		fontWeight: 700,
		padding: '5px 10px',
		lineHeight: 1.25,
	},
	// Ряд, в котором лежит прогресс-бар статуса.
	statusProgressRow: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
	},
	// Контейнер полосы прогресса с рамкой и фоном.
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
	// Цветная заливка внутри полосы прогресса.
	progressBarFill: {
		position: 'absolute',
		left: 0,
		top: 0,
		height: '100%',
		borderRadius: '2px',
		transition: 'width 0.3s ease',
	},
	// Основной текст процента поверх прогресс-бара.
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
	// Дублирующий текст процента поверх закрашенной части.
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
	// Колонка одной группы активных промптов по дню.
	activityGroup: {
		display: 'flex',
		flexDirection: 'column',
		gap: '5px',
		minWidth: 0,
	},
	// Подзаголовок группы внутри карточки активности.
	groupTitle: {
		fontSize: '11px',
		fontWeight: 700,
		color: 'var(--vscode-foreground)',
	},
	// Кликабельная строка одного активного промпта.
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
	// Ряд массового выбора ветки для всех проектов.
	bulkBranchRow: {
		display: 'grid',
		gridTemplateColumns: '64px minmax(0, 1fr)',
		alignItems: 'center',
		gap: '8px',
		minWidth: 0,
	},
	// Короткая подпись слева от общего селекта ветки.
	bulkBranchLabel: {
		fontSize: '11px',
		fontWeight: 700,
		color: 'var(--vscode-descriptionForeground)',
		whiteSpace: 'nowrap',
	},
	// Небольшой badge с номером задачи в списке активности.
	taskBadge: {
		fontSize: '11px',
		fontWeight: 700,
		color: 'var(--vscode-textLink-foreground)',
		whiteSpace: 'nowrap',
	},
	// Основной текст элемента списка с обрезкой длинных строк.
	itemTitle: {
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	},
	// Небольшое числовое значение справа в строке.
	statValue: {
		fontSize: '11px',
		color: 'var(--vscode-descriptionForeground)',
		whiteSpace: 'nowrap',
	},
	// Короткая подпись для компактных числовых метрик.
	inlineMetricText: {
		fontSize: '10px',
		color: 'var(--vscode-descriptionForeground)',
		lineHeight: 1.4,
	},
	// Вторичная поясняющая строка под метрикой.
	metricNote: {
		fontSize: '10px',
		color: 'var(--vscode-descriptionForeground)',
		lineHeight: 1.4,
	},
	// Вертикальный блок проекта внутри мини-графика.
	chartProjectRow: {
		display: 'flex',
		flexDirection: 'column',
		gap: '6px',
		paddingBottom: '8px',
		borderBottom: '1px solid color-mix(in srgb, var(--vscode-panel-border) 68%, transparent)',
	},
	// Название проекта над мини-графиком или метриками.
	chartProjectTitle: {
		fontSize: '11px',
		fontWeight: 700,
		color: 'var(--vscode-foreground)',
	},
	// Вертикальный список мини-метрик внутри блока проекта.
	chartMiniList: {
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
	},
	// Сетка одной метрики с label, треком и значением.
	metricRow: {
		display: 'grid',
		gridTemplateColumns: '52px minmax(0, 1fr) auto',
		alignItems: 'center',
		gap: '8px',
		minWidth: 0,
	},
	// Подпись метрики в верхнем регистре.
	metricLabel: {
		fontSize: '10px',
		fontWeight: 700,
		color: 'var(--vscode-descriptionForeground)',
		textTransform: 'uppercase',
	},
	// Текстовое значение метрики справа.
	metricValue: {
		fontSize: '10px',
		color: 'var(--vscode-descriptionForeground)',
		whiteSpace: 'nowrap',
	},
	// Общий трек сравнения ahead и behind.
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
	// Левая красная часть трека для behind.
	divergenceBehind: {
		justifySelf: 'end',
		height: '100%',
		background: 'color-mix(in srgb, var(--vscode-charts-red) 80%, transparent)',
	},
	// Правая зеленая часть трека для ahead.
	divergenceAhead: {
		justifySelf: 'start',
		height: '100%',
		background: 'color-mix(in srgb, var(--vscode-charts-green) 82%, transparent)',
	},
	// Центральная разделительная линия в divergence-треке.
	divergenceMidline: {
		position: 'absolute',
		left: '50%',
		top: 0,
		bottom: 0,
		width: '1px',
		background: 'color-mix(in srgb, var(--vscode-panel-border) 80%, transparent)',
		transform: 'translateX(-0.5px)',
	},
	// Горизонтальный stacked bar для составных метрик.
	stackedBar: {
		display: 'flex',
		alignItems: 'stretch',
		width: '100%',
		height: '14px',
		borderRadius: '999px',
		overflow: 'hidden',
		background: 'color-mix(in srgb, var(--vscode-panel-border) 42%, transparent)',
	},
	// Один цветной сегмент внутри stacked bar.
	stackedBarSegment: {
		height: '100%',
		minWidth: '4px',
	},
	// Двухколоночный список легенды для мини-графиков.
	legendList: {
		display: 'grid',
		gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
		gap: '6px 12px',
	},
	// Одна строка легенды со swatch, подписью и числом.
	legendItem: {
		display: 'grid',
		gridTemplateColumns: '10px minmax(0, 1fr) auto',
		alignItems: 'center',
		gap: '6px',
		minWidth: 0,
	},
	// Маленькая цветная точка в легенде.
	legendSwatch: {
		width: '10px',
		height: '10px',
		borderRadius: '999px',
	},
	// Серый трек индикатора возраста или давности.
	ageBarTrack: {
		height: '8px',
		borderRadius: '999px',
		overflow: 'hidden',
		background: 'color-mix(in srgb, var(--vscode-panel-border) 42%, transparent)',
	},
	// Стандартная синяя заливка age bar.
	ageBarFill: {
		display: 'block',
		height: '100%',
		borderRadius: '999px',
		background: 'var(--vscode-charts-blue, var(--vscode-textLink-foreground))',
	},
	// Желтая заливка age bar для устаревших значений.
	ageBarFillStale: {
		background: 'var(--vscode-charts-yellow)',
	},
	// Вертикальный блок для горячего файла или hotspot-метрики.
	hotspotRow: {
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
	},
	// Верхняя строка hotspot с названием и значением.
	hotspotHeader: {
		display: 'grid',
		gridTemplateColumns: 'minmax(0, 1fr) auto',
		alignItems: 'center',
		gap: '8px',
	},
	// Серый трек под полосой hotspot.
	hotspotBarTrack: {
		height: '8px',
		borderRadius: '999px',
		overflow: 'hidden',
		background: 'color-mix(in srgb, var(--vscode-panel-border) 42%, transparent)',
	},
	// Градиентная заливка hotspot-полосы.
	hotspotBarFill: {
		display: 'block',
		height: '100%',
		borderRadius: '999px',
		background: 'color-mix(in srgb, var(--vscode-charts-yellow) 70%, var(--vscode-charts-red))',
	},
	// Универсальный текст для пустого состояния карточки.
	emptyText: {
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
		lineHeight: 1.45,
	},
	// Пустое состояние со спиннером во время загрузки.
	loadingEmptyState: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '8px',
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
		lineHeight: 1.45,
	},
	// Branch widget controls, presets, and per-project action rows.
	// Сетка из трех управляющих кнопок над списком проектов.
	branchToolbar: {
		display: 'grid',
		gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
		gap: '6px',
	},
	// Короткая подсказка под тулбаром пресетов веток.
	branchToolbarHint: {
		fontSize: '11px',
		lineHeight: 1.45,
		color: 'var(--vscode-descriptionForeground)',
	},
	// Основная цветная кнопка действия внутри виджета.
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
	// Вторичная спокойная кнопка для вспомогательных действий.
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
	// Снижение контраста и блокировка у неактивного элемента.
	disabledButton: {
		opacity: 0.55,
		cursor: 'default',
	},
	// Блок одного проекта внутри commit/review/parallel карточек.
	projectBlock: {
		display: 'flex',
		flexDirection: 'column',
		gap: '10px',
		paddingTop: '12px',
		borderTop: '1px solid var(--vscode-panel-border)',
		minWidth: 0,
	},
	// Убирает верхний разделитель у первого блока проекта.
	projectBlockFirst: {
		paddingTop: 0,
		borderTop: 'none',
	},
	// Сетка строки проекта в виджете переключения веток.
	branchProjectRow: {
		display: 'grid',
		gridTemplateColumns: 'minmax(86px, 0.78fr) minmax(0, 1.22fr) auto auto',
		alignItems: 'center',
		gap: '8px',
		padding: '6px 0',
		borderTop: '1px solid color-mix(in srgb, var(--vscode-panel-border) 68%, transparent)',
		minWidth: 0,
	},
	// Первый проект в списке веток без верхней границы.
	branchProjectRowFirst: {
		borderTop: 'none',
	},
	// Растягивает ошибку переключения на всю ширину строки.
	branchProjectError: {
		gridColumn: '1 / -1',
	},
	// Карточка ошибки переключения ветки под проектом.
	branchProjectErrorBlock: {
		gridColumn: '1 / -1',
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
		padding: '8px 10px',
		borderRadius: '6px',
		border: '1px solid color-mix(in srgb, var(--vscode-errorForeground) 52%, var(--vscode-panel-border))',
		background: 'color-mix(in srgb, var(--vscode-errorForeground) 10%, var(--vscode-editor-background))',
	},
	// Заголовок внутри карточки ошибки переключения.
	branchProjectErrorTitle: {
		fontSize: '11px',
		fontWeight: 700,
		color: 'var(--vscode-errorForeground)',
	},
	// Контейнер предупреждения о незакоммиченных файлах.
	branchProjectNoticeBlock: {
		gridColumn: '1 / -1',
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
		padding: '7px 9px',
		borderRadius: '6px',
		border: '1px solid color-mix(in srgb, var(--vscode-charts-yellow) 48%, var(--vscode-panel-border))',
		background: 'color-mix(in srgb, var(--vscode-charts-yellow) 8%, var(--vscode-editor-background))',
	},
	// Project-level warnings and dirty-file disclosures that sit below the branch selector.
	// Кнопка раскрытия списка незакоммиченных файлов.
	branchProjectNoticeToggle: {
		display: 'grid',
		gridTemplateColumns: '12px minmax(0, 1fr) auto',
		alignItems: 'center',
		gap: '5px',
		padding: 0,
		border: 'none',
		background: 'transparent',
		color: 'var(--vscode-foreground)',
		fontFamily: 'var(--vscode-font-family)',
		fontSize: '11px',
		textAlign: 'left',
		cursor: 'pointer',
		minWidth: 0,
	},
	// Текст заголовка предупреждения о dirty-файлах.
	branchProjectNoticeText: {
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		fontWeight: 700,
		color: 'var(--vscode-charts-yellow)',
	},
	// Вертикальный список dirty-файлов под предупреждением.
	branchProjectNoticeList: {
		display: 'flex',
		flexDirection: 'column',
		gap: '1px',
		paddingTop: '4px',
		borderTop: '1px solid color-mix(in srgb, var(--vscode-charts-yellow) 26%, transparent)',
		minWidth: 0,
	},
	// Верхняя строка блока проекта с названием и badge.
	projectHeader: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: '8px',
	},
	// Основное название проекта в любой карточке.
	projectName: {
		fontWeight: 700,
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	},
	// Базовый маленький badge для статусов и ролей.
	badge: {
		fontSize: '10px',
		lineHeight: '14px',
		padding: '1px 6px',
		borderRadius: '4px',
		border: '1px solid transparent',
		textTransform: 'uppercase',
		whiteSpace: 'nowrap',
	},
	// Зеленый вариант badge для успешного состояния.
	badgeOk: { color: 'var(--vscode-charts-green)', borderColor: 'var(--vscode-charts-green)' },
	// Желтый вариант badge для предупреждений.
	badgeWarn: { color: 'var(--vscode-charts-yellow)', borderColor: 'var(--vscode-charts-yellow)' },
	// Красный вариант badge для ошибок и риска.
	badgeDanger: { color: 'var(--vscode-charts-red)', borderColor: 'var(--vscode-charts-red)' },
	// Нейтральный badge для вторичных состояний.
	badgeNeutral: { color: 'var(--vscode-descriptionForeground)', borderColor: 'var(--vscode-panel-border)' },
	// Компактный вертикальный блок проекта без крупной шапки.
	compactProjectRow: {
		display: 'flex',
		flexDirection: 'column',
		gap: '6px',
		padding: '8px 0',
		borderBottom: '1px solid color-mix(in srgb, var(--vscode-panel-border) 68%, transparent)',
		minWidth: 0,
	},
	// Вертикальный список коротких чеков или статусов.
	checkList: {
		display: 'flex',
		flexDirection: 'column',
		gap: '3px',
	},
	// Одна строка чек-листа с подписью и значением.
	checkRow: {
		display: 'grid',
		gridTemplateColumns: 'minmax(0, 1fr) auto',
		alignItems: 'center',
		gap: '8px',
		fontSize: '11px',
	},
	// Вертикальный стек деталей по MR или PR.
	reviewDetails: {
		display: 'flex',
		flexDirection: 'column',
		gap: '3px',
		minWidth: 0,
	},
	// Подпись над селектом ветки в полном вертикальном варианте.
	branchSelectLabel: {
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
		width: '100%',
		fontSize: '11px',
		minWidth: 0,
	},
	// Обертка инлайнового селекта ветки в строке проекта.
	branchSelectInlineLabel: {
		display: 'block',
		minWidth: 0,
	},
	// Базовый select со списком доступных веток.
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
	// Адаптивная сетка мелких метаданных по проекту.
	metaGrid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))',
		gap: '8px 12px',
		fontSize: '11px',
	},
	// Значение метаданных с обрезкой длинного текста.
	metaValue: {
		display: 'block',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	},
	// Универсальный приглушенный цвет для вторичного текста.
	muted: {
		color: 'var(--vscode-descriptionForeground)',
	},
	// Expandable commit and parallel-branch blocks rendered inside each project card.
	// Вертикальная группа раскрываемых элементов внутри проекта.
	detailGroup: {
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
		minWidth: 0,
	},
	// Заголовок отдельной detail-группы внутри проекта.
	detailGroupTitle: {
		fontSize: '11px',
		fontWeight: 700,
		color: 'var(--vscode-foreground)',
	},
	// Обертка одного раскрываемого detail-элемента.
	detailBlock: {
		minWidth: 0,
	},
	// Кнопка строки коммита или параллельной ветки.
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
	// Маленькая стрелка раскрытия рядом с detail-строкой.
	detailChevron: {
		color: 'var(--vscode-descriptionForeground)',
	},
	// Короткий SHA коммита с моноширинным акцентом.
	commitSha: {
		fontFamily: 'var(--vscode-editor-font-family)',
		color: 'var(--vscode-textLink-foreground)',
		whiteSpace: 'nowrap',
	},
	// Тема коммита с обрезкой длинного текста.
	commitSubject: {
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	},
	// Название параллельной ветки в detail-строке.
	branchName: {
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		fontFamily: 'var(--vscode-editor-font-family)',
	},
	// Маленький счетчик файлов справа в раскрываемой строке.
	fileCount: {
		minWidth: '22px',
		padding: '1px 5px',
		borderRadius: '4px',
		border: '1px solid var(--vscode-panel-border)',
		color: 'var(--vscode-descriptionForeground)',
		textAlign: 'center',
		fontSize: '10px',
	},
	// Предупреждающий вариант счетчика файлов.
	fileCountWarn: {
		color: 'var(--vscode-charts-yellow)',
		borderColor: 'var(--vscode-charts-yellow)',
	},
	// Shared file-tree primitives reused by commits, parallel branches, conflicts, and dirty files.
	// Корневой контейнер общего дерева файлов.
	fileGraphTree: {
		display: 'flex',
		flexDirection: 'column',
		gap: 0,
		paddingTop: '1px',
		minWidth: 0,
	},
	// Обертка одной группы узла дерева.
	fileTreeNodeGroup: {
		display: 'flex',
		flexDirection: 'column',
		gap: '0',
		minWidth: 0,
	},
	// Контейнер для дочерних строк текущего узла.
	fileTreeChildren: {
		display: 'flex',
		flexDirection: 'column',
		gap: '0',
		minWidth: 0,
	},
	// Строка каталога с branch-guide и иконкой папки.
	fileTreeDirectoryRow: {
		display: 'grid',
		gridTemplateColumns: 'auto 18px minmax(0, 1fr)',
		alignItems: 'center',
		gap: '3px',
		minHeight: '18px',
		lineHeight: '15px',
		padding: '0',
		borderRadius: '3px',
		color: 'var(--vscode-descriptionForeground)',
		fontSize: '12px',
		minWidth: 0,
	},
	// Текстовый префикс ветвления дерева вроде ├─ и └─.
	fileTreeBranchPrefix: {
		fontFamily: 'var(--vscode-editor-font-family)',
		fontSize: '9px',
		whiteSpace: 'pre',
		color: 'var(--vscode-descriptionForeground)',
	},
	// Иконка папки в строке дерева.
	fileTreeDirectoryIcon: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontSize: '14px',
		lineHeight: 1,
		color: 'var(--vscode-textLink-foreground)',
	},
	// Название папки в дереве файлов.
	fileGraphDirectoryName: {
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		fontFamily: 'var(--vscode-font-family)',
		fontSize: '12px',
		lineHeight: '15px',
		fontWeight: 400,
		color: 'color-mix(in srgb, var(--vscode-foreground) 35%, var(--vscode-descriptionForeground))',
	},
	// Базовая кликабельная строка файла в общем дереве.
	fileTreeFileRow: {
		width: '100%',
		display: 'grid',
		gridTemplateColumns: 'auto 18px minmax(0, 1fr) auto',
		alignItems: 'center',
		gap: '3px',
		minHeight: '18px',
		padding: '0',
		border: 'none',
		borderRadius: '3px',
		background: 'transparent',
		color: 'var(--vscode-foreground)',
		fontFamily: 'var(--vscode-font-family)',
		fontSize: '12px',
		textAlign: 'left',
		cursor: 'pointer',
		minWidth: 0,
	},
	// Упрощенная сетка плоской строки без branch prefix.
	fileTreeFileRowFlat: {
		gridTemplateColumns: 'auto minmax(0, 1fr) auto',
	},
	// Слабый фон для уже просмотренного файла.
	fileTreeFileRowViewed: {
		background: 'color-mix(in srgb, var(--vscode-textLink-foreground) 5%, transparent)',
	},
	// Более заметный фон и контур для открытого файла.
	fileTreeFileRowActive: {
		background: 'color-mix(in srgb, var(--vscode-textLink-foreground) 12%, transparent)',
		outline: '1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 38%, transparent)',
	},
	// Иконка файла перед названием в дереве.
	fileTreeFileBullet: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		fontSize: '14px',
		lineHeight: 1,
	},
	// Основная inline-область имени файла и его меток.
	fileTreeFileMain: {
		display: 'inline-flex',
		alignItems: 'baseline',
		gap: '2px',
		minWidth: 0,
		whiteSpace: 'nowrap',
		overflow: 'hidden',
	},
	// Подсказка о rename рядом с текущим именем файла.
	fileTreeRenameHint: {
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		fontSize: '10px',
		fontWeight: 500,
		color: 'color-mix(in srgb, var(--vscode-foreground) 30%, var(--vscode-descriptionForeground))',
	},
	// Текстовый маркер, что файл сейчас открывается.
	fileTreeOpeningHint: {
		fontSize: '10px',
		color: 'color-mix(in srgb, var(--vscode-foreground) 30%, var(--vscode-descriptionForeground))',
		whiteSpace: 'nowrap',
	},
	// Badge для файла, который сейчас открыт в редакторе.
	fileTreeStateBadgeActive: {
		padding: '1px 4px',
		borderRadius: '3px',
		background: 'color-mix(in srgb, var(--vscode-textLink-foreground) 14%, transparent)',
		color: 'var(--vscode-textLink-foreground)',
		fontSize: '10px',
		fontWeight: 600,
		whiteSpace: 'nowrap',
	},
	// Badge для файла, который уже открывали ранее.
	fileTreeStateBadgeViewed: {
		padding: '1px 4px',
		borderRadius: '3px',
		background: 'color-mix(in srgb, var(--vscode-descriptionForeground) 12%, transparent)',
		color: 'var(--vscode-descriptionForeground)',
		fontSize: '10px',
		fontWeight: 500,
		whiteSpace: 'nowrap',
	},
	// Вертикальный стек имени файла и вспомогательного пути.
	fileGraphFileCopy: {
		display: 'flex',
		flexDirection: 'column',
		gap: '1px',
		minWidth: 0,
	},
	// Основное имя файла в строке дерева.
	fileGraphFileName: {
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		fontFamily: 'var(--vscode-font-family)',
		fontSize: '12px',
		fontWeight: 500,
		color: 'var(--vscode-foreground)',
	},
	// Цвет имени файла после того, как его уже смотрели.
	fileGraphFileNameViewed: {
		color: 'color-mix(in srgb, var(--vscode-foreground) 82%, var(--vscode-descriptionForeground))',
	},
	// Акцентный цвет имени активного открытого файла.
	fileGraphFileNameActive: {
		color: 'var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground))',
		fontWeight: 600,
	},
	// Дополнительный путь или подпись под именем файла.
	fileGraphFilePath: {
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		fontSize: '11px',
		color: 'var(--vscode-descriptionForeground)',
	},
	// Правая inline-зона для счетчиков и action badges.
	fileGraphActions: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'flex-end',
		gap: '4px',
		whiteSpace: 'nowrap',
	},
	// Compact diff counters and status badges for flat dirty-file rows.
	// Полный набор счетчиков + / ~ / - у файла.
	fileLineStats: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '3px',
		whiteSpace: 'nowrap',
		fontSize: '11px',
		fontWeight: 600,
	},
	// Компактная версия тех же счетчиков для узких мест.
	fileLineStatsCompact: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '3px',
		whiteSpace: 'nowrap',
		fontSize: '10px',
		fontWeight: 600,
	},
	// Специальная подпись для bin или неизвестных diff-данных.
	fileLineStatsSpecial: {
		fontSize: '10px',
		color: 'var(--vscode-descriptionForeground)',
		whiteSpace: 'nowrap',
	},
	// Зеленый счетчик добавленных строк.
	fileLineStatAdded: {
		color: 'var(--vscode-charts-green)',
	},
	// Желтый счетчик измененных строк.
	fileLineStatChanged: {
		color: 'var(--vscode-charts-yellow)',
	},
	// Красный счетчик удаленных строк.
	fileLineStatDeleted: {
		color: 'var(--vscode-charts-red)',
	},
	// Серые скобки вокруг блока line stats.
	fileLineStatParen: {
		color: 'var(--vscode-descriptionForeground)',
	},
	// Квадратный badge статуса файла для плоских строк.
	fileStatus: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		minWidth: '18px',
		width: '18px',
		height: '18px',
		padding: 0,
		fontFamily: 'var(--vscode-editor-font-family)',
		fontWeight: 800,
		color: 'var(--vscode-descriptionForeground)',
		textAlign: 'center',
		border: '1px solid color-mix(in srgb, var(--vscode-panel-border) 82%, transparent)',
		borderRadius: '6px',
		lineHeight: 1,
		fontSize: '11px',
		textTransform: 'none',
		letterSpacing: 0,
	},
	// Предупреждающий вид status-badge для конфликтов.
	fileStatusWarn: {
		color: 'var(--vscode-charts-yellow)',
		borderColor: 'var(--vscode-charts-yellow)',
	},
	// Capsule badge для уже открытого файла.
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
	// Capsule badge для файла в процессе открытия.
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
	// Желтый badge для конфликтного или рискованного файла.
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
	// Небольшая текстовая кнопка действия внутри строки проекта.
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
	// Текст под раскрытой строкой, пока список файлов пуст или грузится.
	emptyDetails: {
		padding: '5px 0 2px 19px',
		fontSize: '11px',
		color: 'var(--vscode-descriptionForeground)',
	},
	// AI review summary cards and lightweight instructional copy.
	// Вводный блок статуса AI review над основными секциями.
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
	// Основной текст пояснения рядом с AI state badge.
	analysisIntroText: {
		fontSize: '12px',
		lineHeight: 1.45,
		color: 'var(--vscode-foreground)',
	},
	// Badge состояния, когда AI еще обрабатывает данные.
	analysisStateRunning: {
		padding: '2px 6px',
		borderRadius: '4px',
		border: '1px solid var(--vscode-charts-yellow)',
		color: 'var(--vscode-charts-yellow)',
		fontSize: '10px',
		fontWeight: 700,
		whiteSpace: 'nowrap',
	},
	// Badge состояния, когда AI уже отдал результат.
	analysisStateReady: {
		padding: '2px 6px',
		borderRadius: '4px',
		border: '1px solid var(--vscode-textLink-foreground)',
		color: 'var(--vscode-textLink-foreground)',
		fontSize: '10px',
		fontWeight: 700,
		whiteSpace: 'nowrap',
	},
	// Вертикальный список секций AI review.
	analysisSections: {
		display: 'flex',
		flexDirection: 'column',
		gap: '8px',
	},
	// Карточка одной секции AI summary.
	analysisSection: {
		border: '1px solid color-mix(in srgb, var(--vscode-panel-border) 74%, transparent)',
		borderRadius: '5px',
		overflow: 'hidden',
	},
	// Шапка отдельной секции AI review.
	analysisTitle: {
		padding: '6px 8px',
		background: 'var(--vscode-sideBar-background)',
		borderBottom: '1px solid color-mix(in srgb, var(--vscode-panel-border) 74%, transparent)',
		fontSize: '12px',
		fontWeight: 700,
		color: 'var(--vscode-foreground)',
	},
	// Тело секции AI review со списком строк.
	analysisBody: {
		display: 'flex',
		flexDirection: 'column',
		gap: '5px',
		padding: '8px',
	},
	// Обычная строка текста внутри секции AI review.
	analysisLine: {
		fontSize: '12px',
		lineHeight: 1.45,
		color: 'var(--vscode-foreground)',
	},
	// Строка списка с bullet-маркером в AI summary.
	analysisBullet: {
		display: 'grid',
		gridTemplateColumns: '12px minmax(0, 1fr)',
		gap: '4px',
		fontSize: '12px',
		lineHeight: 1.45,
		color: 'var(--vscode-foreground)',
	},
	// Цветной маркер bullet внутри AI review.
	analysisBulletMarker: {
		color: 'var(--vscode-textLink-foreground)',
	},
	// Общий красный текст для ошибок внутри виджета.
	errorText: {
		fontSize: '12px',
		color: 'var(--vscode-errorForeground)',
		lineHeight: 1.4,
	},
};