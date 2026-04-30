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
}

interface FileRowActionHandlers {
	openingFileKey: string | null;
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
	warn?: boolean;
	opening?: boolean;
	onOpenPatch: () => void;
}

/** Stores one nested directory in the dashboard tree. */
interface DashboardFileTreeNode {
	name: string;
	path: string;
	directories: Map<string, DashboardFileTreeNode>;
	files: DashboardFileTreeEntry[];
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
	const openingFileTokenRef = useRef(0);
	const projects = snapshot?.projects.data.projects || [];
	const projectsCacheStatus = snapshot?.projects.cache.status || 'idle';
	const activityCacheStatus = snapshot?.activity.cache.status || 'idle';
	const statusCacheStatus = snapshot?.status.cache.status || 'idle';
	const runFileOpenAction = (fileKey: string, action: () => void) => {
		const startedAt = Date.now();
		const token = openingFileTokenRef.current + 1;
		openingFileTokenRef.current = token;
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
	}, [snapshot?.scopeKey]);

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
				{isChanged ? 'change' : 'current'}
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
	const addOption = (branch: string, label: string, available = true) => {
		const normalized = branch.trim();
		if (!normalized || options.has(normalized)) {
			return;
		}
		options.set(normalized, { branch: normalized, label, available });
	};

	addOption(project.currentBranch, `${project.currentBranch || 'n/a'} (current)`, true);
	for (const action of project.branchActions) {
		addOption(action.branch, `${action.branch} (${action.kind})`, action.available);
	}
	for (const branch of project.branches) {
		const marks = [branch.current ? 'current' : '', branch.kind === 'tracked' ? 'tracked' : '', branch.kind === 'prompt' ? 'prompt' : '']
			.filter(Boolean)
			.join(', ');
		addOption(branch.name, marks ? `${branch.name} (${marks})` : branch.name, branch.canSwitch || branch.current);
	}

	return Array.from(options.values());
}

function resolveBranchDraft(project: PromptDashboardProjectSummary, branchDrafts: Record<string, string>): string {
	const draft = String(branchDrafts[project.project] || '').trim();
	if (draft) {
		return draft;
	}
	const options = buildBranchOptions(project);
	const preferredBranches = [project.promptBranch, project.currentBranch]
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
	return (
		<div key={commit.sha} style={styles.detailBlock}>
			<button type="button" style={styles.detailButton} onClick={() => toggleExpanded(expandKey)}>
				<span style={styles.detailChevron}>{isExpanded ? '▾' : '▸'}</span>
				<span style={styles.commitSha}>{commit.shortSha}</span>
				<span style={styles.commitSubject}>{commit.subject}</span>
				<span style={styles.fileCount}>{commit.changedFiles.length}</span>
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
	return (
		<div key={branch.name} style={styles.detailBlock}>
			<button type="button" style={styles.detailButton} onClick={() => toggleExpanded(expandKey)}>
				<span style={styles.detailChevron}>{isExpanded ? '▾' : '▸'}</span>
				<span style={styles.branchName}>{branch.name}</span>
				<span style={styles.statValue}>+{branch.ahead} / -{branch.behind}</span>
				<span style={{ ...styles.fileCount, ...(branch.potentialConflicts.length > 0 ? styles.fileCountWarn : null) }}>{branch.affectedFiles.length}</span>
			</button>
			{isExpanded ? renderParallelFiles(project, branch, fileHandlers) : null}
		</div>
	);
}

function renderCommitChangedFiles(project: PromptDashboardProjectSummary, commit: PromptDashboardRecentCommit, fileHandlers: FileRowActionHandlers): React.ReactNode {
	if (commit.changedFiles.length === 0) {
		return <div style={styles.emptyDetails}>Файлы не найдены</div>;
	}
	return (
		renderFileTree(commit.changedFiles.map(file => {
				const fileKey = `${project.project}:commit:${commit.sha}:${file.path}`;
				return {
					key: `${file.status}-${file.previousPath || ''}-${file.path}`,
				path: file.path,
				status: file.status,
				label: file.previousPath ? `${file.previousPath} -> ${file.path}` : file.path,
				secondaryLabel: file.previousPath ? `было: ${file.previousPath}` : undefined,
				opening: fileHandlers.openingFileKey === fileKey,
				onOpenPatch: () => fileHandlers.onOpenFilePatch({ project: project.project, filePath: file.path, previousPath: file.previousPath, mode: 'commit', ref: commit.sha }, fileKey),
				};
			}))
	);
}

function renderParallelFiles(project: PromptDashboardProjectSummary, branch: GitOverlayParallelBranchSummary, fileHandlers: FileRowActionHandlers): React.ReactNode {
	if (branch.affectedFiles.length === 0) {
		return <div style={styles.emptyDetails}>{`Нет уникальных изменений относительно ${branch.baseBranch}`}</div>;
	}
	const conflictReasons = new Map(branch.potentialConflicts.map(file => [file.path, file.reason]));
	return (
		renderFileTree(branch.affectedFiles.map(file => {
				const fileKey = `${project.project}:branch:${branch.name}:${file.path}`;
				return {
					key: `${branch.name}-${file.status}-${file.previousPath || ''}-${file.path}`,
				path: file.path,
				status: conflictReasons.has(file.path) ? '!' : file.status,
				label: file.previousPath ? `${file.previousPath} -> ${file.path}` : file.path,
				secondaryLabel: file.previousPath ? `было: ${file.previousPath}` : undefined,
				warn: conflictReasons.has(file.path),
				opening: fileHandlers.openingFileKey === fileKey,
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
			{renderFileTree(project.conflictFiles.map(file => {
					const fileKey = `${project.project}:diff:${file}`;
					return {
						key: `${project.project}-${file}`,
					path: file,
					status: '!',
					label: file,
					warn: true,
					opening: fileHandlers.openingFileKey === fileKey,
					onOpenPatch: () => fileHandlers.onOpenDiff(project.project, file, fileKey),
					};
				}))}
		</div>
	);
}

/** Renders changed files as a compact explorer-like tree. */
function renderFileTree(entries: DashboardFileTreeEntry[]): React.ReactNode {
	const root = buildFileTree(entries);
	return (
		<div style={styles.fileTree}>
			{renderFileTreeNode(root, 0)}
		</div>
	);
}

function buildFileTree(entries: DashboardFileTreeEntry[]): DashboardFileTreeNode {
	const root: DashboardFileTreeNode = {
		name: '',
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


function collapseFileTreeNode(node: DashboardFileTreeNode): DashboardFileTreeNode {
	let current = node;
	const segments = [node.name];
	while (current.files.length === 0 && current.directories.size === 1) {
		const nextNode = Array.from(current.directories.values())[0];
		segments.push(nextNode.name);
		current = nextNode;
	}
	return {
		...current,
		name: segments.filter(Boolean).join('/'),
	};
}

function countFileTreeEntries(node: DashboardFileTreeNode): number {
	const nestedCount = Array.from(node.directories.values()).reduce((count, directory) => count + countFileTreeEntries(directory), 0);
	return node.files.length + nestedCount;
}

function splitTreePath(pathValue: string): string[] {
	return pathValue
		.split('/')
		.map(segment => segment.trim())
		.filter(Boolean);
}

function resolveFileTone(status: string, warn = false): DashboardFileTone {
	if (warn) {
		return {
			label: 'risk',
			accentColor: 'var(--vscode-charts-yellow)',
			borderColor: 'color-mix(in srgb, var(--vscode-charts-yellow) 62%, var(--vscode-panel-border))',
			background: 'color-mix(in srgb, var(--vscode-charts-yellow) 10%, var(--vscode-editor-background))',
		};
	}

	switch ((status || '').trim().toUpperCase()) {
		case 'A':
			return {
				label: 'add',
				accentColor: 'var(--vscode-charts-green)',
				borderColor: 'color-mix(in srgb, var(--vscode-charts-green) 50%, var(--vscode-panel-border))',
				background: 'color-mix(in srgb, var(--vscode-charts-green) 9%, var(--vscode-editor-background))',
			};
		case 'D':
			return {
				label: 'del',
				accentColor: 'var(--vscode-charts-red)',
				borderColor: 'color-mix(in srgb, var(--vscode-charts-red) 48%, var(--vscode-panel-border))',
				background: 'color-mix(in srgb, var(--vscode-charts-red) 8%, var(--vscode-editor-background))',
			};
		case 'R':
			return {
				label: 'ren',
				accentColor: 'var(--vscode-textLink-foreground)',
				borderColor: 'color-mix(in srgb, var(--vscode-textLink-foreground) 52%, var(--vscode-panel-border))',
				background: 'color-mix(in srgb, var(--vscode-textLink-foreground) 8%, var(--vscode-editor-background))',
			};
		default:
			return {
				label: 'mod',
				accentColor: 'var(--vscode-charts-orange, var(--vscode-charts-yellow))',
				borderColor: 'color-mix(in srgb, var(--vscode-charts-orange, var(--vscode-charts-yellow)) 52%, var(--vscode-panel-border))',
				background: 'color-mix(in srgb, var(--vscode-charts-orange, var(--vscode-charts-yellow)) 9%, var(--vscode-editor-background))',
			};
	}
}

function resolveFileTypeLabel(filePath: string): string {
	const fileName = filePath.split('/').pop() || filePath;
	if (!fileName.includes('.')) {
		return 'file';
	}
	const extension = fileName.slice(fileName.lastIndexOf('.') + 1).trim().toLowerCase();
	return extension || 'file';
}

function renderPathChips(pathValue: string, tone: 'folder' | 'file' = 'file'): React.ReactNode {
	const segments = splitTreePath(pathValue);
	if (segments.length === 0) {
		return <span style={tone === 'folder' ? styles.treePathChipFolder : styles.treePathChip}>workspace</span>;
	}

	return (
		<>
			{segments.map((segment, index) => (
				<React.Fragment key={`${pathValue}-${segment}-${index}`}>
					{index > 0 ? <span style={styles.treePathDivider}>/</span> : null}
					<span style={tone === 'folder' ? styles.treePathChipFolder : styles.treePathChip}>{segment}</span>
				</React.Fragment>
			))}
		</>
	);
}


function renderFileTreeNode(node: DashboardFileTreeNode, depth: number): React.ReactNode {
	const collapsedNode = collapseFileTreeNode(node);
	const directories = Array.from(collapsedNode.directories.values()).sort((left, right) => left.name.localeCompare(right.name, 'ru'));
	const files = [...collapsedNode.files].sort((left, right) => left.path.localeCompare(right.path, 'ru'));
	const isRoot = depth === 0;
	const entryCount = countFileTreeEntries(collapsedNode);
	return (
		<div key={collapsedNode.path || '__root__'} style={isRoot ? undefined : styles.treeNode}>
			{isRoot ? null : (
				<div style={styles.treeDirectoryRow}>
					<div style={styles.treeDirectoryRail}>
						<span style={styles.treeDirectoryDot} />
					</div>
					<div style={styles.treeDirectoryPanel}>
						<div style={styles.treeDirectoryMetaRow}>
							<span style={styles.treeDirectoryBadge}>folder</span>
							<span style={styles.treeDirectoryCount}>{entryCount} files</span>
						</div>
						<div style={styles.treeDirectoryPath}>{renderPathChips(collapsedNode.name, 'folder')}</div>
					</div>
				</div>
			)}
			<div style={isRoot ? styles.treeRootChildren : styles.treeChildren}>
				{directories.map(directory => renderFileTreeNode(directory, depth + 1))}
				{files.map(file => renderChangedFileRow(file, depth))}
			</div>
		</div>
	);
}

/** Renders one clickable file leaf in the dashboard tree. */
function renderChangedFileRow(input: DashboardFileTreeEntry, depth: number): React.ReactNode {
	const fileName = input.path.split('/').pop() || input.label;
	const directory = input.path.includes('/') ? input.path.slice(0, input.path.lastIndexOf('/')) : '';
	const meta = input.secondaryLabel || (directory ? `folder: ${directory}` : 'workspace root');
	const fileType = resolveFileTypeLabel(input.path);
	const isOpening = input.opening === true;
	const tone = resolveFileTone(input.status, input.warn === true);
	return (
		<button
			key={input.key}
			type="button"
			style={{
				...styles.fileRow,
				marginLeft: `${Math.max(0, depth - 1) * 8}px`,
				borderColor: tone.borderColor,
				background: tone.background,
				boxShadow: `inset 3px 0 0 ${tone.accentColor}`,
			}}
			onClick={input.onOpenPatch}
			title={input.path}
		>
			<span style={{ ...styles.fileStatus, color: tone.accentColor, borderColor: tone.borderColor, background: `color-mix(in srgb, ${tone.accentColor} 14%, transparent)` }}>{tone.label}</span>
			<span style={styles.fileRowCopy}>
				<span style={styles.fileRowHeadline}>
					<span style={styles.fileRowName}>{fileName}</span>
					<span style={isOpening ? styles.fileOpenBadgeBusy : styles.fileOpenBadge}>{isOpening ? 'opening' : 'open diff'}</span>
				</span>
				<span style={styles.fileRowPath}>{renderPathChips(directory)}</span>
				<span style={styles.fileRowMeta}>{meta}</span>
			</span>
			<span style={styles.fileRowActions}>
				<span style={styles.fileTypeBadge}>{fileType}</span>
				{input.warn ? <span style={styles.fileWarnBadge}>conflict</span> : null}
			</span>
		</button>
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
	return (
		<section style={styles.section}>
			<div style={styles.sectionHeader}>
				<span style={styles.sectionTitle}>AI review</span>
				<span style={styles.sectionMeta}>{isRunning ? 'обновляется' : analysis?.status === 'completed' ? 'готово' : 'ожидание'}</span>
			</div>
			<div style={styles.sectionBody}>
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
					<div style={styles.emptyText}>{isRunning ? 'Анализ обновляется...' : 'Анализ появится после загрузки Git-данных.'}</div>
				)}
				{analysis?.error ? <div style={styles.errorText}>{analysis.error}</div> : null}
			</div>
		</section>
	);
}

function parseAnalysisSections(content: string): Array<{ title: string; lines: string[] }> {
	const sections: Array<{ title: string; lines: string[] }> = [];
	let currentSection: { title: string; lines: string[] } | null = null;
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		const heading = line.match(/^#{2,3}\s+(.+)$/);
		if (heading) {
			currentSection = { title: heading[1].trim(), lines: [] };
			sections.push(currentSection);
			continue;
		}
		if (!currentSection) {
			currentSection = { title: 'Итог', lines: [] };
			sections.push(currentSection);
		}
		if (line) {
			currentSection.lines.push(line);
		}
	}
	return sections.filter(section => section.lines.length > 0);
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
	fileTree: {
		display: 'flex',
		flexDirection: 'column',
		gap: '10px',
		paddingTop: '8px',
		minWidth: 0,
	},
	treeNode: {
		display: 'flex',
		flexDirection: 'column',
		gap: '8px',
		minWidth: 0,
	},
	treeDirectoryRow: {
		display: 'grid',
		gridTemplateColumns: '18px minmax(0, 1fr)',
		alignItems: 'stretch',
		gap: '8px',
		minWidth: 0,
	},
	treeDirectoryRail: {
		display: 'flex',
		alignItems: 'flex-start',
		justifyContent: 'center',
		paddingTop: '14px',
	},
	treeDirectoryDot: {
		display: 'block',
		width: '8px',
		height: '8px',
		borderRadius: '999px',
		background: 'var(--vscode-textLink-foreground)',
		boxShadow: '0 0 0 3px color-mix(in srgb, var(--vscode-textLink-foreground) 16%, transparent)',
	},
	treeDirectoryPanel: {
		display: 'flex',
		flexDirection: 'column',
		gap: '7px',
		padding: '10px 12px',
		borderRadius: '10px',
		border: '1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 26%, var(--vscode-panel-border))',
		background: 'linear-gradient(180deg, color-mix(in srgb, var(--vscode-sideBar-background) 86%, transparent), color-mix(in srgb, var(--vscode-editor-background) 94%, transparent))',
		minWidth: 0,
	},
	treeDirectoryMetaRow: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: '8px',
		minWidth: 0,
	},
	treeDirectoryBadge: {
		padding: '2px 8px',
		borderRadius: '999px',
		background: 'color-mix(in srgb, var(--vscode-textLink-foreground) 14%, transparent)',
		color: 'var(--vscode-textLink-foreground)',
		fontSize: '9px',
		fontWeight: 700,
		textTransform: 'uppercase',
	},
	treeDirectoryPath: {
		display: 'flex',
		alignItems: 'center',
		flexWrap: 'wrap',
		gap: '4px',
		minWidth: 0,
	},
	treePathChipFolder: {
		display: 'inline-flex',
		alignItems: 'center',
		padding: '3px 7px',
		borderRadius: '999px',
		border: '1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 26%, var(--vscode-panel-border))',
		background: 'color-mix(in srgb, var(--vscode-textLink-foreground) 10%, transparent)',
		color: 'var(--vscode-foreground)',
		minWidth: 0,
		fontFamily: 'var(--vscode-editor-font-family)',
		fontSize: '10px',
		fontWeight: 700,
	},
	treePathChip: {
		display: 'inline-flex',
		alignItems: 'center',
		padding: '2px 6px',
		borderRadius: '999px',
		border: '1px solid color-mix(in srgb, var(--vscode-panel-border) 82%, transparent)',
		background: 'color-mix(in srgb, var(--vscode-sideBar-background) 92%, transparent)',
		color: 'var(--vscode-descriptionForeground)',
		fontFamily: 'var(--vscode-editor-font-family)',
		fontSize: '10px',
		fontWeight: 600,
	},
	treePathDivider: {
		color: 'color-mix(in srgb, var(--vscode-descriptionForeground) 72%, transparent)',
		fontSize: '10px',
		fontWeight: 700,
	},
	treeDirectoryCount: {
		fontSize: '10px',
		color: 'var(--vscode-descriptionForeground)',
		whiteSpace: 'nowrap',
		textTransform: 'uppercase',
		letterSpacing: '0.04em',
	},
	treeRootChildren: {
		display: 'flex',
		flexDirection: 'column',
		gap: '10px',
		minWidth: 0,
	},
	treeChildren: {
		display: 'flex',
		flexDirection: 'column',
		gap: '8px',
		marginLeft: '9px',
		paddingLeft: '16px',
		borderLeft: '1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 18%, var(--vscode-panel-border))',
		minWidth: 0,
	},
	fileRow: {
		width: '100%',
		display: 'grid',
		gridTemplateColumns: '22px minmax(0, 1fr) auto',
		alignItems: 'center',
		gap: '10px',
		padding: '10px 10px 10px 12px',
		minHeight: '52px',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '10px',
		background: 'color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-sideBar-background))',
		color: 'var(--vscode-foreground)',
		fontFamily: 'var(--vscode-font-family)',
		textAlign: 'left',
		cursor: 'pointer',
		fontSize: '11px',
		minWidth: 0,
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
	fileRowCopy: {
		display: 'flex',
		flexDirection: 'column',
		gap: '5px',
		minWidth: 0,
	},
	fileRowHeadline: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		minWidth: 0,
	},
	fileRowName: {
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		color: 'var(--vscode-foreground)',
		fontFamily: 'var(--vscode-editor-font-family)',
		fontSize: '12px',
		fontWeight: 700,
	},
	fileRowPath: {
		display: 'flex',
		alignItems: 'center',
		flexWrap: 'wrap',
		gap: '4px',
		minWidth: 0,
	},
	fileRowMeta: {
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		color: 'var(--vscode-descriptionForeground)',
		fontSize: '10px',
		letterSpacing: '0.01em',
	},
	fileRowActions: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '6px',
		alignSelf: 'flex-start',
	},
	fileTypeBadge: {
		padding: '3px 7px',
		borderRadius: '999px',
		border: '1px solid color-mix(in srgb, var(--vscode-panel-border) 80%, transparent)',
		background: 'color-mix(in srgb, var(--vscode-button-secondaryBackground) 74%, transparent)',
		color: 'var(--vscode-foreground)',
		fontSize: '9px',
		fontWeight: 700,
		textTransform: 'uppercase',
		whiteSpace: 'nowrap',
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