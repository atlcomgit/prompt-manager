import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PromptStatusText } from '../../shared/PromptStatusText';
import { getPromptStatusColor } from '../../shared/promptStatus';
import type { GitOverlayChangeFile } from '../../../types/git.js';
import type { GitOverlayParallelBranchSummary } from '../../../types/git.js';
import type {
	DockerComposeProjectActionKind,
	DockerComposeActionError,
	DockerComposeFileContainerGroup,
	DockerComposeFileReference,
	DockerContainerActionKind,
	DockerContainerLifecycleStatus,
	DockerContainerProjectGroup,
	DockerContainerResourceSample,
	DockerContainerStatusTone,
	DockerContainerSummary,
	DockerContainersData,
	DockerContainersStatusFilter,
	DockerContainersViewMode,
} from '../../../types/docker.js';
import type {
	PromptDashboardAnalysisState,
	PromptDashboardCollapsedSections,
	PromptDashboardLoadStatus,
	PromptDashboardProjectSummary,
	PromptDashboardRecentCommit,
	PromptDashboardSectionKey,
	PromptDashboardSectionOrder,
	PromptDashboardSnapshot,
	PromptDashboardWidgetKind,
} from '../../../types/promptDashboard.js';
import {
	PROMPT_DASHBOARD_SECTION_KEYS,
	createDefaultPromptDashboardCollapsedSections,
	createDefaultPromptDashboardSectionOrder,
	isPromptDashboardProjectsSectionLoaded,
	isPromptDashboardSectionCollapsed,
	normalizePromptDashboardCollapsedSections,
	normalizePromptDashboardSectionOrder,
} from '../../../types/promptDashboard.js';
import {
	buildPromptDashboardDockerComposeBusyAction,
	buildPromptDashboardDockerContainerBusyAction,
	compactPromptDashboardMiddleLabel,
	fitPromptDashboardPathPartsToWidth,
	formatPromptDashboardDuration,
	splitPromptDashboardPathParts,
} from '../../../utils/promptDashboard.js';

const DASHBOARD_LEFT_ACCENT_SHADOW = 'inset 3px 0 0 var(--vscode-widget-shadow, rgba(0, 0, 0, 0.35))';
const BRANCH_PROJECT_LABEL_MAX_LENGTH = 20;

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
	collapsedSections?: PromptDashboardCollapsedSections;
	sectionOrder?: PromptDashboardSectionOrder;
	mode: 'full' | 'compact';
	showGitFlowAction?: boolean;
	onRefresh: () => void;
	onRefreshWidget?: (section: PromptDashboardSectionKey, widget: PromptDashboardWidgetKind) => void;
	onToggleSectionCollapse?: (section: PromptDashboardSectionKey) => void;
	onReorderSections?: (order: PromptDashboardSectionOrder) => void;
	onHydrateProjectsDetails: (projects: string[], reason?: 'details' | 'dirty-files') => void;
	onOpenGitFlow: () => void;
	onOpenPrompt: (id: string, promptUuid?: string) => void;
	onSwitchBranch: (project: string, branch: string) => void;
	onSwitchBranches: (branchesByProject: Record<string, string>, source?: 'bulk' | 'prompt' | 'tracked') => void;
	onPullProject?: (project: string) => void;
	onOpenDiff: (project: string, filePath: string) => void;
	onOpenFilePatch: (request: PromptDashboardFilePatchRequest) => void;
	onDockerAction: (containerId: string, action: DockerContainerActionKind) => void;
	onDockerComposeAction: (projectPath: string, composeFilePath: string, action: DockerComposeProjectActionKind) => void;
	onOpenDockerComposeFile: (projectPath: string, composeFilePath: string) => void;
	onOpenDockerLogs: (containerId: string) => void;
	onOpenDockerTerminal: (containerId: string) => void;
	onDockerLiveMetricsVisibilityChange?: (visible: boolean) => void;
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

type DockerContainerSortBy = 'name' | 'status' | 'uptime' | 'cpu' | 'memory';

export interface DashboardDockerWidgetState {
	viewMode?: DockerContainersViewMode;
	expandedContainerIds: string[];
}

type DockerContainerIconKind = 'logs' | 'terminal' | 'start' | 'restart' | 'stop' | 'remove' | 'composeUp' | 'composeDown' | 'composeFile' | 'openFile';

interface DockerDeclaredServiceViewRow {
	key: string;
	project: DockerContainerProjectGroup;
	group: DockerComposeFileContainerGroup;
	serviceName: string;
}

type DockerTableViewRow =
	| { kind: 'compose'; key: string; project: DockerContainerProjectGroup; group: DockerComposeFileContainerGroup; label: string }
	| { kind: 'container'; key: string; project: DockerContainerProjectGroup; group?: DockerComposeFileContainerGroup; container: DockerContainerSummary; label: string }
	| { kind: 'service'; key: string; row: DockerDeclaredServiceViewRow; label: string };

const DOCKER_WIDGET_STATE_STORAGE_KEY = 'pm.promptDashboard.dockerWidgetState.v1';

/** Normalizes persisted Docker widget UI state from webview storage. */
export function normalizePromptDashboardDockerWidgetState(value: unknown): DashboardDockerWidgetState {
	if (!value || typeof value !== 'object') {
		return { expandedContainerIds: [] };
	}

	const input = value as Partial<DashboardDockerWidgetState>;
	const viewMode = isDockerViewMode(input.viewMode) ? input.viewMode : undefined;
	const expandedContainerIds = Array.isArray(input.expandedContainerIds)
		? Array.from(new Set(input.expandedContainerIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)))
		: [];
	return viewMode ? { viewMode, expandedContainerIds } : { expandedContainerIds };
}

/** Reads Docker widget UI state from local webview storage. */
function readPromptDashboardDockerWidgetState(): DashboardDockerWidgetState {
	const storage = getPromptDashboardLocalStorage();
	if (!storage) {
		return normalizePromptDashboardDockerWidgetState(null);
	}

	try {
		return normalizePromptDashboardDockerWidgetState(JSON.parse(storage.getItem(DOCKER_WIDGET_STATE_STORAGE_KEY) || 'null'));
	} catch {
		return normalizePromptDashboardDockerWidgetState(null);
	}
}

/** Writes a partial Docker widget UI state update without dropping saved fields. */
function writePromptDashboardDockerWidgetStatePatch(patch: Partial<DashboardDockerWidgetState>): void {
	const storage = getPromptDashboardLocalStorage();
	if (!storage) {
		return;
	}

	const nextState = normalizePromptDashboardDockerWidgetState({
		...readPromptDashboardDockerWidgetState(),
		...patch,
	});
	try {
		storage.setItem(DOCKER_WIDGET_STATE_STORAGE_KEY, JSON.stringify(nextState));
	} catch {
		// Ignore webview storage quota errors; the widget remains usable without persistence.
	}
}

/** Resolves browser localStorage only when the dashboard runs inside a webview. */
function getPromptDashboardLocalStorage(): Storage | null {
	try {
		return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
	} catch {
		return null;
	}
}

/** Checks whether an unknown value is one of the supported Docker view modes. */
function isDockerViewMode(value: unknown): value is DockerContainersViewMode {
	return value === 'tree' || value === 'cards' || value === 'table' || value === 'list';
}

/** Builds the shared expanded map entries for persisted Docker container IDs. */
function buildDockerExpandedState(containerIds: readonly string[]): ExpandedState {
	return containerIds.reduce<ExpandedState>((state, containerId) => {
		state[`docker:${containerId}`] = true;
		return state;
	}, {});
}

/** Checks whether an expanded key belongs to the Docker containers widget. */
function isDockerExpandedKey(key: string): boolean {
	return key.startsWith('docker:') && key.length > 'docker:'.length;
}

/** Extracts expanded Docker container IDs from the shared expanded map. */
function resolveExpandedDockerContainerIds(expanded: ExpandedState): string[] {
	return Object.entries(expanded)
		.filter(([key, isExpanded]) => isExpanded && isDockerExpandedKey(key))
		.map(([key]) => key.slice('docker:'.length));
}

/** Builds the persisted disclosure key for a Docker Compose project group. */
function buildDockerProjectExpandedKey(project: DockerContainerProjectGroup): string {
	return `docker:project:${project.projectPath || project.project}`;
}

/** Builds the persisted disclosure key for a Docker Compose file group. */
function buildDockerComposeFileExpandedKey(project: DockerContainerProjectGroup, composeFile: DockerComposeFileReference): string {
	return `docker:compose:${project.projectPath || project.project}:${composeFile.filePath}`;
}

/** Stores a leaf row for the compact dashboard file tree. */
interface DashboardFileTreeEntry {
	key: string;
	path: string;
	status: string;
	label: string;
	pathPrefix?: string;
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

type DragPlacement = 'before' | 'after';

interface DashboardDropIndicator {
	section: PromptDashboardSectionKey;
	placement: DragPlacement;
}

interface PromptDashboardSectionBounds {
	section: PromptDashboardSectionKey;
	top: number;
	bottom: number;
}

/** Right-side prompt dashboard visible only when the editor has enough horizontal space. */
export const PromptDashboard: React.FC<PromptDashboardProps> = ({
	snapshot,
	busyAction,
	collapsedSections = createDefaultPromptDashboardCollapsedSections(),
	sectionOrder = createDefaultPromptDashboardSectionOrder(),
	mode,
	showGitFlowAction = false,
	onRefresh,
	onRefreshWidget,
	onToggleSectionCollapse,
	onReorderSections,
	onHydrateProjectsDetails,
	onOpenGitFlow,
	onOpenPrompt,
	onSwitchBranch,
	onSwitchBranches,
	onPullProject,
	onOpenDiff,
	onOpenFilePatch,
	onDockerAction,
	onDockerComposeAction,
	onOpenDockerComposeFile,
	onOpenDockerLogs,
	onOpenDockerTerminal,
	onDockerLiveMetricsVisibilityChange,
}) => {
	const [initialDockerWidgetState] = useState(() => readPromptDashboardDockerWidgetState());
	const [hasSavedDockerViewMode, setHasSavedDockerViewMode] = useState(() => Boolean(initialDockerWidgetState.viewMode));
	const [expanded, setExpanded] = useState<ExpandedState>(() => buildDockerExpandedState(initialDockerWidgetState.expandedContainerIds));
	const [branchDrafts, setBranchDrafts] = useState<Record<string, string>>({});
	const [bulkBranchDraft, setBulkBranchDraft] = useState('');
	const [showAllBranchProjects, setShowAllBranchProjects] = useState(false);
	const [openingFileKey, setOpeningFileKey] = useState<string | null>(null);
	const [activeFileKey, setActiveFileKey] = useState<string | null>(null);
	const [viewedFileKeys, setViewedFileKeys] = useState<Record<string, boolean>>({});
	const [dockerViewMode, setDockerViewMode] = useState<DockerContainersViewMode>(initialDockerWidgetState.viewMode || 'tree');
	const [dockerStatusFilter, setDockerStatusFilter] = useState<DockerContainersStatusFilter>('all');
	const [dockerSearch, setDockerSearch] = useState('');
	const [dockerSortBy, setDockerSortBy] = useState<DockerContainerSortBy>('status');
	const [draggedSection, setDraggedSection] = useState<PromptDashboardSectionKey | null>(null);
	const [dropIndicator, setDropIndicator] = useState<DashboardDropIndicator | null>(null);
	const [isDockerSectionInView, setIsDockerSectionInView] = useState(false);
	const draggedSectionRef = useRef<PromptDashboardSectionKey | null>(null);
	const railRef = useRef<HTMLElement | null>(null);
	const normalizedCollapsedSections = useMemo(
		() => normalizePromptDashboardCollapsedSections(collapsedSections),
		[collapsedSections],
	);
	const normalizedSectionOrder = useMemo(
		() => normalizePromptDashboardSectionOrder(sectionOrder),
		[sectionOrder],
	);
	const openingFileTokenRef = useRef(0);
	const projectsData = snapshot?.projects.data;
	const allProjects = projectsData?.projects || [];
	const allBranchProjects = projectsData?.branchProjects || allProjects;
	const isProjectBranchesLoaded = isPromptDashboardProjectsSectionLoaded(projectsData, 'projectBranches');
	const isReviewRequestsLoaded = isPromptDashboardProjectsSectionLoaded(projectsData, 'reviewRequests');
	const isParallelBranchesLoaded = isPromptDashboardProjectsSectionLoaded(projectsData, 'parallelBranches');
	const isProjectCommitsLoaded = isPromptDashboardProjectsSectionLoaded(projectsData, 'projectCommits');
	const branchProjects = isProjectBranchesLoaded ? allProjects : [];
	const branchScopeProjects = isProjectBranchesLoaded ? allBranchProjects : [];
	const reviewProjects = isReviewRequestsLoaded ? allProjects : [];
	const parallelProjects = isParallelBranchesLoaded ? allProjects : [];
	const commitProjects = isProjectCommitsLoaded ? allProjects : [];
	const branchWidgetProjects = resolveBranchWidgetProjects(branchProjects, branchScopeProjects, showAllBranchProjects);
	const hydrationProjects = mergePromptDashboardHydrationProjects(allProjects, allBranchProjects);
	const canShowAllBranchProjects = branchScopeProjects.length > branchProjects.length;
	const projectsCacheStatus = snapshot?.projects.cache.status || 'idle';
	const hasVisibleProjectsPayload = allProjects.length > 0 || (projectsData?.branchProjects?.length || 0) > 0;
	const unloadedProjectsSectionCacheStatus = projectsCacheStatus === 'loading' && !hasVisibleProjectsPayload ? 'loading' : 'idle';
	const projectBranchesCacheStatus = isProjectBranchesLoaded ? projectsCacheStatus : unloadedProjectsSectionCacheStatus;
	const reviewRequestsCacheStatus = isReviewRequestsLoaded ? projectsCacheStatus : unloadedProjectsSectionCacheStatus;
	const parallelBranchesCacheStatus = isParallelBranchesLoaded ? projectsCacheStatus : unloadedProjectsSectionCacheStatus;
	const projectCommitsCacheStatus = isProjectCommitsLoaded ? projectsCacheStatus : unloadedProjectsSectionCacheStatus;
	const activityCacheStatus = snapshot?.activity.cache.status || 'idle';
	const statusCacheStatus = snapshot?.status.cache.status || 'idle';
	const dockerCacheStatus = snapshot?.docker.cache.status || 'idle';
	const logicalDockerLiveMetricsVisible = useMemo(
		() => resolvePromptDashboardDockerLiveMetricsVisible({
			data: snapshot?.docker.data,
			viewMode: dockerViewMode,
			statusFilter: dockerStatusFilter,
			search: dockerSearch,
			sortBy: dockerSortBy,
			expanded,
			collapsedSections: normalizedCollapsedSections,
			mode,
		}),
		[dockerSearch, dockerSortBy, dockerStatusFilter, dockerViewMode, expanded, mode, normalizedCollapsedSections, snapshot?.docker.data],
	);
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
		setShowAllBranchProjects(false);
		setActiveFileKey(null);
		setViewedFileKeys({});
		setDockerSearch('');
		setDockerStatusFilter('all');
		setDockerSortBy('status');
	}, [snapshot?.scopeKey]);

	// Apply the configured default mode only until the user saves their own Docker view preference.
	useEffect(() => {
		const defaultViewMode = snapshot?.docker.data.defaultViewMode;
		if (!hasSavedDockerViewMode && defaultViewMode && defaultViewMode !== dockerViewMode) {
			setDockerViewMode(defaultViewMode);
		}
	}, [dockerViewMode, hasSavedDockerViewMode, snapshot?.docker.data.defaultViewMode]);

	// Reveal the exact compose file branch when a hidden compose command fails.
	useEffect(() => {
		const actionError = snapshot?.docker.data.composeActionError;
		if (!actionError) {
			return;
		}
		const project = (snapshot?.docker.data.projects || [])
			.find(item => normalizeDashboardPath(item.projectPath) === normalizeDashboardPath(actionError.projectPath));
		const composeFile = project?.composeFiles
			.find(item => normalizeDashboardPath(item.filePath) === normalizeDashboardPath(actionError.composeFilePath));
		if (!project || !composeFile) {
			return;
		}
		const projectKey = buildDockerProjectExpandedKey(project);
		const composeFileKey = buildDockerComposeFileExpandedKey(project, composeFile);
		setExpanded(previous => {
			if (previous[projectKey] && previous[composeFileKey]) {
				return previous;
			}
			const next = { ...previous, [projectKey]: true, [composeFileKey]: true };
			writePromptDashboardDockerWidgetStatePatch({
				expandedContainerIds: resolveExpandedDockerContainerIds(next),
			});
			return next;
		});
	}, [snapshot?.docker.data.composeActionError?.createdAt, snapshot?.docker.data.projects]);

	// Drop stale branch drafts once refreshed project data confirms the branch is current again.
	useEffect(() => {
		setBranchDrafts(previous => reconcileBranchDrafts(branchProjects, previous));
	}, [branchProjects]);

	// Collapse the workspace-wide view automatically when the current snapshot no longer exposes extra projects.
	useEffect(() => {
		if (!canShowAllBranchProjects) {
			setShowAllBranchProjects(false);
		}
	}, [canShowAllBranchProjects]);

	// Reset transient drag UI when the dashboard scope switches to another prompt.
	useEffect(() => {
		setDraggedSection(null);
		setDropIndicator(null);
	}, [snapshot?.scopeKey]);

	// Track whether the Docker section is currently inside the dashboard viewport.
	useEffect(() => {
		if (mode !== 'full') {
			setIsDockerSectionInView(false);
			return;
		}
		const railElement = railRef.current;
		if (!railElement) {
			setIsDockerSectionInView(false);
			return;
		}
		const dockerSectionElement = railElement.querySelector<HTMLElement>('[data-pm-dashboard-section="dockerContainers"]');
		if (!dockerSectionElement) {
			setIsDockerSectionInView(false);
			return;
		}
		if (typeof IntersectionObserver === 'undefined') {
			setIsDockerSectionInView(true);
			return;
		}
		const observer = new IntersectionObserver(entries => {
			const entry = entries[0];
			setIsDockerSectionInView(Boolean(entry?.isIntersecting) && (entry?.intersectionRatio || 0) > 0.05);
		}, {
			root: railElement,
			threshold: [0, 0.05, 0.25],
		});
		observer.observe(dockerSectionElement);
		return () => observer.disconnect();
	}, [mode, normalizedCollapsedSections.dockerContainers, normalizedSectionOrder, snapshot?.scopeKey]);

	// Sync host-side Docker polling with the actual visibility of live resource blocks.
	useEffect(() => {
		onDockerLiveMetricsVisibilityChange?.(logicalDockerLiveMetricsVisible && isDockerSectionInView);
	}, [isDockerSectionInView, logicalDockerLiveMetricsVisible, onDockerLiveMetricsVisibilityChange]);

	// Retry lazy details hydration for already-open blocks once the projects widget finishes refreshing.
	useEffect(() => {
		for (const [key, isExpanded] of Object.entries(expanded)) {
			if (!isExpanded) {
				continue;
			}
			maybeHydrateExpandedDetails(
				key,
				hydrationProjects,
				projectsCacheStatus,
				onHydrateProjectsDetails,
				normalizedCollapsedSections,
			);
		}
	}, [expanded, hydrationProjects, normalizedCollapsedSections, onHydrateProjectsDetails, projectsCacheStatus]);

	if (mode !== 'full') {
		return null;
	}

	const toggleExpanded = (key: string, defaultExpanded = false) => {
		setExpanded(previous => {
			const next = { ...previous, [key]: !(previous[key] ?? defaultExpanded) };
			if (isDockerExpandedKey(key)) {
				writePromptDashboardDockerWidgetStatePatch({
					expandedContainerIds: resolveExpandedDockerContainerIds(next),
				});
			}
			return next;
		});
	};

	/** Changes and persists the Docker widget display mode. */
	const changeDockerViewMode = (mode: DockerContainersViewMode) => {
		setHasSavedDockerViewMode(true);
		setDockerViewMode(mode);
		writePromptDashboardDockerWidgetStatePatch({ viewMode: mode });
	};

	/** Toggles one shared top-level dashboard section from the section header. */
	const toggleSectionCollapse = (section: PromptDashboardSectionKey) => {
		onToggleSectionCollapse?.(section);
	};

	const applyBranchTargets = (branchesByProject: Record<string, string>, source: DashboardBranchApplySource = 'bulk') => {
		if (Object.keys(branchesByProject).length === 0) {
			return;
		}
		onSwitchBranches(branchesByProject, source);
	};

	const applyBranchDrafts = () => {
		applyBranchTargets(buildChangedBranchTargets(branchWidgetProjects, branchDrafts), 'bulk');
	};

	const applyBranchPreset = (kind: 'prompt' | 'tracked') => {
		applyBranchTargets(buildPresetBranchTargets(branchWidgetProjects, kind), kind);
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
		setBranchDrafts(previous => buildBulkBranchDrafts(branchWidgetProjects, previous, branch));
	};

	// Clear the temporary drag state once the current move operation finishes.
	const clearDragState = () => {
		draggedSectionRef.current = null;
		setDraggedSection(null);
		setDropIndicator(null);
	};

	const handleSectionDragStart = (
		event: React.DragEvent<HTMLButtonElement>,
		section: PromptDashboardSectionKey,
	) => {
		event.stopPropagation();
		event.dataTransfer.effectAllowed = 'move';
		event.dataTransfer.setData('text/plain', section);
		draggedSectionRef.current = section;
		setDraggedSection(section);
		setDropIndicator(null);
	};

	const handleSectionDragEnd = () => {
		clearDragState();
	};

	const resolveDropIndicator = (
		event: React.DragEvent<HTMLDivElement>,
		targetSection: PromptDashboardSectionKey,
	): DashboardDropIndicator | null => {
		const activeDraggedSection = draggedSectionRef.current;
		if (!activeDraggedSection || activeDraggedSection === targetSection) {
			return null;
		}
		const rect = event.currentTarget.getBoundingClientRect();
		const placement: DragPlacement = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
		return { section: targetSection, placement };
	};

	// Resolve the nearest insertion slot when the pointer is inside the column gap or below the last card.
	const resolveColumnDropIndicator = (
		event: React.DragEvent<HTMLDivElement>,
	): DashboardDropIndicator | null => {
		const activeDraggedSection = draggedSectionRef.current;
		if (!activeDraggedSection) {
			return null;
		}
		const sectionBounds = Array.from(
			event.currentTarget.querySelectorAll<HTMLElement>('[data-pm-dashboard-section]'),
		)
			.map((element) => {
				const section = element.dataset.pmDashboardSection;
				if (!isPromptDashboardSectionKeyValue(section)) {
					return null;
				}
				const rect = element.getBoundingClientRect();
				return {
					section,
					top: rect.top,
					bottom: rect.bottom,
				};
			})
			.filter((item): item is PromptDashboardSectionBounds => item !== null);
		return resolvePromptDashboardColumnDropIndicator(activeDraggedSection, event.clientY, sectionBounds);
	};

	// Persist the shared section order once the current drag operation has a valid destination.
	const applySectionDropIndicator = (
		activeDraggedSection: PromptDashboardSectionKey | null,
		indicator: DashboardDropIndicator | null,
	) => {
		clearDragState();
		if (!activeDraggedSection || !indicator) {
			return;
		}
		const nextOrder = reorderPromptDashboardSections(
			normalizedSectionOrder,
			activeDraggedSection,
			indicator.section,
			indicator.placement,
		);
		if (!arePromptDashboardSectionOrdersEqual(normalizedSectionOrder, nextOrder)) {
			onReorderSections?.(nextOrder);
		}
	};

	const handleSectionDragOver = (
		event: React.DragEvent<HTMLDivElement>,
		targetSection: PromptDashboardSectionKey,
	) => {
		const activeDraggedSection = draggedSectionRef.current;
		if (!activeDraggedSection || activeDraggedSection === targetSection) {
			return;
		}
		event.preventDefault();
		const nextIndicator = resolveDropIndicator(event, targetSection);
		setDropIndicator(previous => previous?.section === nextIndicator?.section && previous?.placement === nextIndicator?.placement
			? previous
			: nextIndicator);
	};

	// Keep reordering active when the pointer leaves one card and moves through the column gap.
	const handleSectionColumnDragOver = (event: React.DragEvent<HTMLDivElement>) => {
		if (!draggedSectionRef.current) {
			return;
		}
		event.preventDefault();
		const nextIndicator = resolveColumnDropIndicator(event);
		setDropIndicator(previous => previous?.section === nextIndicator?.section && previous?.placement === nextIndicator?.placement
			? previous
			: nextIndicator);
	};

	const handleSectionDragLeave = (
		event: React.DragEvent<HTMLDivElement>,
		targetSection: PromptDashboardSectionKey,
	) => {
		const relatedTarget = event.relatedTarget as Node | null;
		if (relatedTarget && event.currentTarget.contains(relatedTarget)) {
			return;
		}
		setDropIndicator(previous => previous?.section === targetSection ? null : previous);
	};

	// Drop the indicator only after the pointer leaves the whole column, not when it passes between cards.
	const handleSectionColumnDragLeave = (
		event: React.DragEvent<HTMLDivElement>,
		columnSections: readonly PromptDashboardSectionKey[],
	) => {
		const relatedTarget = event.relatedTarget as Node | null;
		if (relatedTarget && event.currentTarget.contains(relatedTarget)) {
			return;
		}
		setDropIndicator(previous => previous && columnSections.includes(previous.section) ? null : previous);
	};

	const handleSectionDrop = (
		event: React.DragEvent<HTMLDivElement>,
		targetSection: PromptDashboardSectionKey,
	) => {
		event.preventDefault();
		const activeDraggedSection = draggedSectionRef.current;
		if (!activeDraggedSection || activeDraggedSection === targetSection) {
			clearDragState();
			return;
		}
		applySectionDropIndicator(activeDraggedSection, resolveDropIndicator(event, targetSection));
	};

	// Accept drops on the full column so releasing in whitespace still commits the pending reorder.
	const handleSectionColumnDrop = (event: React.DragEvent<HTMLDivElement>) => {
		event.preventDefault();
		applySectionDropIndicator(draggedSectionRef.current, resolveColumnDropIndicator(event));
	};

	// Render one dedicated header handle so dragging does not interfere with collapse or refresh actions.
	const renderSectionDragHandle = (section: PromptDashboardSectionKey, title: string): React.ReactNode => (
		<button
			type="button"
			draggable
			style={{
				...styles.sectionDragHandle,
				...(draggedSection === section ? styles.sectionDragHandleDragging : null),
			}}
			onClick={(event) => event.stopPropagation()}
			onMouseDown={(event) => event.stopPropagation()}
			onDragStart={(event) => handleSectionDragStart(event, section)}
			onDragEnd={handleSectionDragEnd}
			title={`Перетащить виджет: ${title}`}
			aria-label={`Перетащить виджет: ${title}`}
		>
			<DragHandleIcon />
		</button>
	);

	// Build section nodes once and then place them through the shared persisted order.
	const sectionNodesByKey: Record<PromptDashboardSectionKey, React.ReactNode> = {
		status: renderStatus(snapshot, statusCacheStatus, busyAction, normalizedCollapsedSections, toggleSectionCollapse, onRefreshWidget, renderSectionDragHandle('status', 'Статус промпта')),
		activity: renderActivity(snapshot, onOpenPrompt, activityCacheStatus, busyAction, normalizedCollapsedSections, toggleSectionCollapse, onRefreshWidget, renderSectionDragHandle('activity', 'Активные промпты')),
		projectBranches: renderProjectBranches(branchWidgetProjects, showAllBranchProjects, canShowAllBranchProjects, expanded, branchDrafts, bulkBranchDraft, busyAction, projectBranchesCacheStatus, fileHandlers, setBranchDrafts, toggleExpanded, applyBulkBranchDraft, applyBranchDrafts, applyBranchPreset, applyProjectBranch, (project) => onPullProject?.(project.project), () => setShowAllBranchProjects(previous => !previous), showGitFlowAction, onOpenGitFlow, normalizedCollapsedSections, toggleSectionCollapse, onRefreshWidget, renderSectionDragHandle('projectBranches', 'Ветки проектов')),
		reviewRequests: renderReviewRequests(reviewProjects, reviewRequestsCacheStatus, busyAction, normalizedCollapsedSections, toggleSectionCollapse, onRefreshWidget, renderSectionDragHandle('reviewRequests', 'MR/PR')),
		parallelBranches: renderParallelBranchFiles(parallelProjects, expanded, toggleExpanded, fileHandlers, parallelBranchesCacheStatus, busyAction, normalizedCollapsedSections, toggleSectionCollapse, onRefreshWidget, renderSectionDragHandle('parallelBranches', 'Параллельные ветки')),
		projectCommits: renderProjectCommits(commitProjects, expanded, toggleExpanded, fileHandlers, projectCommitsCacheStatus, busyAction, normalizedCollapsedSections, toggleSectionCollapse, onRefreshWidget, renderSectionDragHandle('projectCommits', 'Коммиты проектов')),
		dockerContainers: renderDockerContainers(snapshot?.docker.data, dockerViewMode, dockerStatusFilter, dockerSearch, dockerSortBy, expanded, dockerCacheStatus, busyAction, changeDockerViewMode, setDockerStatusFilter, setDockerSearch, setDockerSortBy, toggleExpanded, onDockerAction, onDockerComposeAction, onOpenDockerComposeFile, onOpenDockerLogs, onOpenDockerTerminal, normalizedCollapsedSections, toggleSectionCollapse, onRefreshWidget, renderSectionDragHandle('dockerContainers', 'Docker контейнеры')),
		aiAnalysis: renderAnalysis(snapshot?.aiAnalysis.data || null, snapshot?.aiAnalysis.cache.status || 'idle', busyAction, normalizedCollapsedSections, toggleSectionCollapse, onRefreshWidget, renderSectionDragHandle('aiAnalysis', 'AI review')),
	};
	const widgetColumns = normalizedSectionOrder
		.map(column => column.reduce<Array<{ sectionKey: PromptDashboardSectionKey; node: React.ReactElement }>>((entries, sectionKey) => {
			const sectionNode = sectionNodesByKey[sectionKey];
			if (sectionNode === null || sectionNode === undefined || sectionNode === false) {
				return entries;
			}
			const showDropBefore = dropIndicator?.section === sectionKey && dropIndicator.placement === 'before';
			const showDropAfter = dropIndicator?.section === sectionKey && dropIndicator.placement === 'after';
			entries.push({
				sectionKey,
				node: (
					<div
						key={`dashboard-section:${sectionKey}`}
						style={{
							...styles.sectionDragWrapper,
							...(draggedSection === sectionKey ? styles.sectionDragWrapperDragging : null),
						}}
						onDragOver={(event) => handleSectionDragOver(event, sectionKey)}
						onDragLeave={(event) => handleSectionDragLeave(event, sectionKey)}
						onDrop={(event) => handleSectionDrop(event, sectionKey)}
						data-pm-dashboard-section={sectionKey}
					>
						{showDropBefore ? <div style={styles.sectionDropIndicator} aria-hidden="true" /> : null}
						{sectionNode}
						{showDropAfter ? <div style={styles.sectionDropIndicator} aria-hidden="true" /> : null}
					</div>
				),
			});
			return entries;
		}, []))
		.filter(column => column.length > 0);

	return (
		<aside ref={railRef} style={styles.rail} data-pm-prompt-dashboard="true">
			<div style={styles.toolbar}>
				<div style={styles.titleRow}>
					<PromptDashboardMark />
					<div style={styles.titleBlock}>
						<div style={styles.title}>Обзор</div>
						<div style={styles.subtitle}>{resolveCacheLabel(snapshot)}</div>
					</div>
				</div>
				<button type="button" style={{ ...styles.iconButton, ...(isRefreshBusy ? styles.busyButton : null) }} onClick={onRefresh} title="Обновить" aria-label="Обновить" disabled={isRefreshBusy}>
					{isRefreshBusy ? <span style={styles.buttonSpinner} aria-hidden="true" /> : <RefreshIcon />}
				</button>
			</div>

			<div style={styles.widgetGrid}>
				{widgetColumns.map((column, columnIndex) => (
					<div
						key={`widget-column:${columnIndex}`}
						style={styles.widgetColumn}
						onDragOver={handleSectionColumnDragOver}
						onDragLeave={(event) => handleSectionColumnDragLeave(event, column.map(item => item.sectionKey))}
						onDrop={handleSectionColumnDrop}
					>
						{column.map((section, sectionIndex) => (
							<React.Fragment key={`widget-column:${columnIndex}:section:${sectionIndex}`}>
								{section.node}
							</React.Fragment>
						))}
					</div>
				))}
			</div>
		</aside>
	);
};

/** Splits dashboard widgets into stable independent columns so expanding one card does not create row gaps in the other column. */
export function buildWidgetGridColumns(sections: React.ReactNode[]): React.ReactNode[][] {
	const columns: React.ReactNode[][] = [[], []];
	sections.forEach((section, index) => {
		if (section === null || section === undefined || section === false) {
			return;
		}

		columns[index % 2].push(section);
	});

	return columns.filter(column => column.length > 0);
}

/** Keeps the branch widget scoped to selected projects by default, with an optional workspace-wide toggle. */
export function resolveBranchWidgetProjects(
	selectedProjects: PromptDashboardProjectSummary[],
	branchProjects: PromptDashboardProjectSummary[],
	showAll: boolean,
): PromptDashboardProjectSummary[] {
	if (showAll || branchProjects.length === 0) {
		return showAll ? branchProjects : selectedProjects;
	}

	const selectedNames = new Set(selectedProjects.map(project => project.project));
	return branchProjects.filter(project => selectedNames.has(project.project));
}

/** Reuses richer branch-widget dirty-file stats without losing commit/parallel hydration state. */
function mergePromptDashboardHydrationProjects(
	selectedProjects: PromptDashboardProjectSummary[],
	branchProjects: PromptDashboardProjectSummary[],
): PromptDashboardProjectSummary[] {
	const branchProjectsByName = new Map(branchProjects.map(project => [project.project, project] as const));
	const mergedSelectedProjects = selectedProjects.map(project => {
		const branchProject = branchProjectsByName.get(project.project);
		if (!branchProject || branchProject.uncommittedFiles === project.uncommittedFiles) {
			return project;
		}

		return {
			...project,
			uncommittedFiles: branchProject.uncommittedFiles,
		};
	});
	const selectedNames = new Set(selectedProjects.map(project => project.project));
	const extraBranchProjects = branchProjects.filter(project => !selectedNames.has(project.project));
	return [...mergedSelectedProjects, ...extraBranchProjects];
}

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
	collapsedSections: PromptDashboardCollapsedSections,
): void {
	if (cacheStatus === 'loading') {
		return;
	}
	const sectionKey = resolvePromptDashboardSectionKeyForExpandedKey(key);
	if (sectionKey && isPromptDashboardSectionCollapsed(collapsedSections, sectionKey)) {
		return;
	}

	const request = resolveExpandedDetailsHydrationRequest(key, projects);
	if (!request) {
		return;
	}

	onHydrateProjectsDetails(request.projects, request.reason);
}


/** Maps one expanded inner disclosure key back to its top-level dashboard card. */
function resolvePromptDashboardSectionKeyForExpandedKey(key: string): PromptDashboardSectionKey | null {
	const [kind] = key.split(':');
	if (kind === 'dirty' || kind === 'incoming') {
		return 'projectBranches';
	}
	if (kind === 'commit') {
		return 'projectCommits';
	}
	if (kind === 'parallel') {
		return 'parallelBranches';
	}

	return null;
}


/** Renders the compact chevron used by dashboard section collapse toggles. */
function SectionChevronIcon({ collapsed }: { collapsed: boolean }): React.ReactNode {
	return (
		<svg
			viewBox="0 0 16 16"
			aria-hidden="true"
			focusable="false"
			style={{
				...styles.sectionCollapseIcon,
				...(collapsed ? styles.sectionCollapseIconCollapsed : null),
			}}
		>
			<path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

/** Renders the lightweight refresh icon used by dashboard toolbar and widget actions. */
function RefreshIcon(): React.ReactNode {
	return (
		<svg
			viewBox="0 0 16 16"
			aria-hidden="true"
			focusable="false"
			style={styles.refreshIcon}
		>
			<path d="M12.5 7.25A4.75 4.75 0 1 0 8 12.75c1.67 0 3.17-.88 4.01-2.27" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
			<path d="M9.75 2.75h3v3" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

/** Renders the compact grab-handle glyph shown in every draggable section header. */
function DragHandleIcon(): React.ReactNode {
	return (
		<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={styles.sectionDragHandleIcon}>
			<circle cx="5" cy="4" r="1" fill="currentColor" />
			<circle cx="5" cy="8" r="1" fill="currentColor" />
			<circle cx="5" cy="12" r="1" fill="currentColor" />
			<circle cx="11" cy="4" r="1" fill="currentColor" />
			<circle cx="11" cy="8" r="1" fill="currentColor" />
			<circle cx="11" cy="12" r="1" fill="currentColor" />
		</svg>
	);
}

/** Stops header-toggle bubbling when one of the explicit section action buttons is clicked. */
function handleSectionHeaderActionClick(event: React.MouseEvent<HTMLButtonElement>, action: () => void): void {
	event.stopPropagation();
	action();
}

/** Renders one dashboard section header that toggles collapse when the title row is clicked. */
function renderSectionHeader(
	title: string,
	metaNode: React.ReactNode,
	options?: {
		collapsed?: boolean;
		onToggleCollapse?: () => void;
		dragHandle?: React.ReactNode;
	},
): React.ReactNode {
	const interactive = Boolean(options?.onToggleCollapse);
	const toggleCollapse = () => options?.onToggleCollapse?.();
	return (
		<div
			style={{
				...styles.sectionHeader,
				...(interactive ? styles.sectionHeaderInteractive : null),
			}}
			onClick={interactive ? toggleCollapse : undefined}
			onKeyDown={interactive ? (event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					toggleCollapse();
				}
			} : undefined}
			role={interactive ? 'button' : undefined}
			tabIndex={interactive ? 0 : undefined}
			aria-expanded={interactive ? !options?.collapsed : undefined}
		>
			<span style={styles.sectionTitleRow}>
				{options?.dragHandle}
				<span style={styles.sectionTitle}>{title}</span>
			</span>
			{metaNode}
		</div>
	);
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
	const updatedAt = [snapshot.status, snapshot.activity, snapshot.projects, snapshot.docker, snapshot.aiAnalysis]
		.map(widget => widget.cache.updatedAt || '')
		.filter(Boolean)
		.sort()
		.pop();
	if (!updatedAt) {
		return 'Кеш подготавливается';
	}
	return `Обновлено ${new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function renderStatus(
	snapshot: PromptDashboardSnapshot | null,
	cacheStatus: PromptDashboardLoadStatus,
	busyAction: DashboardBusyAction,
	collapsedSections: PromptDashboardCollapsedSections,
	onToggleSectionCollapse: (section: PromptDashboardSectionKey) => void,
	onRefreshWidget?: (section: PromptDashboardSectionKey, widget: PromptDashboardWidgetKind) => void,
	dragHandle?: React.ReactNode,
): React.ReactNode {
	const data = snapshot?.status.data;
	const collapsed = isPromptDashboardSectionCollapsed(collapsedSections, 'status');
	const sectionCacheStatus = resolveSectionCacheStatus(cacheStatus, busyAction, 'status', 'status');
	const progress = Math.max(0, Math.min(100, data?.progress ?? 0));
	const statusAccent = data ? getPromptStatusColor(data.status) : 'var(--vscode-descriptionForeground)';
	const progressFillTone = progress >= 100
		? 'var(--vscode-charts-green, var(--vscode-terminal-ansiGreen, var(--vscode-testing-iconPassed, #2e7d32)))'
		: statusAccent;

	return (
		<section style={styles.section}>
			{renderSectionHeader('Статус промпта', renderSectionMeta(formatPromptDashboardDuration(data?.totalTimeMs || 0), sectionCacheStatus, 'обновляем', {
					section: 'status',
					collapsed,
					widget: 'status',
					title: 'Статус промпта',
					busyAction,
					onToggleCollapse: () => onToggleSectionCollapse('status'),
					onRefreshWidget,
				}), { collapsed, onToggleCollapse: () => onToggleSectionCollapse('status'), dragHandle })}
			{collapsed ? null : <div style={{ ...styles.sectionBody, ...styles.statusBody }}>
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
			</div>}
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

function renderActivity(
	snapshot: PromptDashboardSnapshot | null,
	onOpenPrompt: (id: string, promptUuid?: string) => void,
	cacheStatus: PromptDashboardLoadStatus,
	busyAction: DashboardBusyAction,
	collapsedSections: PromptDashboardCollapsedSections,
	onToggleSectionCollapse: (section: PromptDashboardSectionKey) => void,
	onRefreshWidget?: (section: PromptDashboardSectionKey, widget: PromptDashboardWidgetKind) => void,
	dragHandle?: React.ReactNode,
): React.ReactNode {
	const data = snapshot?.activity.data;
	const collapsed = isPromptDashboardSectionCollapsed(collapsedSections, 'activity');
	const sectionCacheStatus = resolveSectionCacheStatus(cacheStatus, busyAction, 'activity', 'activity');
	return (
		<section style={styles.section}>
			{renderSectionHeader('Активные промпты', renderSectionMeta('5m+', sectionCacheStatus, 'обновляем', {
					section: 'activity',
					collapsed,
					widget: 'activity',
					title: 'Активные промпты',
					busyAction,
					onToggleCollapse: () => onToggleSectionCollapse('activity'),
					onRefreshWidget,
				}), { collapsed, onToggleCollapse: () => onToggleSectionCollapse('activity'), dragHandle })}
			{collapsed ? null : <div style={styles.sectionBody}>
				{renderActivityGroup('Сегодня', data?.today || [], onOpenPrompt)}
				{renderActivityGroup(data?.yesterdayLabel || 'Вчера', data?.yesterday || [], onOpenPrompt)}
			</div>}
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
			) : items.map(item => (
				// Keep every active prompt visible instead of trimming the widget to a fixed row count.
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
	showAllBranchProjects: boolean,
	canShowAllBranchProjects: boolean,
	expanded: ExpandedState,
	branchDrafts: Record<string, string>,
	bulkBranchDraft: string,
	busyAction: DashboardBusyAction,
	cacheStatus: PromptDashboardLoadStatus,
	fileHandlers: FileRowActionHandlers,
	setBranchDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>,
	toggleExpanded: (key: string, defaultExpanded?: boolean) => void,
	applyBulkBranchDraft: (branch: string) => void,
	applyBranchDrafts: () => void,
	applyBranchPreset: (kind: 'prompt' | 'tracked') => void,
	applyProjectBranch: (project: PromptDashboardProjectSummary) => void,
	pullProject: (project: PromptDashboardProjectSummary) => void,
	toggleShowAllBranchProjects: () => void,
	showGitFlowAction: boolean,
	onOpenGitFlow: () => void,
	collapsedSections: PromptDashboardCollapsedSections,
	onToggleSectionCollapse: (section: PromptDashboardSectionKey) => void,
	onRefreshWidget?: (section: PromptDashboardSectionKey, widget: PromptDashboardWidgetKind) => void,
	dragHandle?: React.ReactNode,
): React.ReactNode {
	const collapsed = isPromptDashboardSectionCollapsed(collapsedSections, 'projectBranches');
	const sectionCacheStatus = resolveSectionCacheStatus(cacheStatus, busyAction, 'projectBranches', 'projects');
	const changedCount = Object.keys(buildChangedBranchTargets(projects, branchDrafts)).length;
	const sharedOptions = buildSharedBranchOptions(projects);
	const isSwitchBusy = isPromptDashboardBranchActionBusy(busyAction);
	const hasPromptPresetBranch = projects.some(project => Boolean(project.promptBranch.trim()));
	const isPromptPresetBusy = busyAction === 'preset:prompt';
	const isTrackedPresetBusy = busyAction === 'preset:tracked';
	const isBulkSwitchBusy = busyAction === 'switch-all';
	const isPromptPresetDisabled = isSwitchBusy || !hasPromptPresetBranch;
	return (
		<section style={styles.section}>
			{renderSectionHeader('Ветки проектов', renderSectionMeta(projects.length || '...', sectionCacheStatus, 'обновляем', {
					section: 'projectBranches',
					collapsed,
					widget: 'projects',
					title: 'Ветки проектов',
					busyAction,
					onToggleCollapse: () => onToggleSectionCollapse('projectBranches'),
					onRefreshWidget,
				}), { collapsed, onToggleCollapse: () => onToggleSectionCollapse('projectBranches'), dragHandle })}
			{collapsed ? null : <div style={styles.sectionBody}>
				<label style={styles.bulkBranchRow}>
					<span style={styles.bulkBranchLabel}>Для всех</span>
					<span style={styles.bulkBranchControls}>
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
						<button
							type="button"
							style={{
								...styles.secondaryButton,
								...((!canShowAllBranchProjects && !showAllBranchProjects) ? styles.disabledButton : null),
							}}
							disabled={!canShowAllBranchProjects && !showAllBranchProjects}
							onClick={toggleShowAllBranchProjects}
							title={showAllBranchProjects ? 'Вернуть только проекты из промпта' : 'Показать все проекты рабочей области'}
						>
							{showAllBranchProjects ? 'Только выбранные' : 'Показать все'}
						</button>
					</span>
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
				) : projects.map((project, index) => renderBranchProject(project, index, expanded, branchDrafts, busyAction, fileHandlers, setBranchDrafts, toggleExpanded, applyProjectBranch, pullProject))}
				{showGitFlowAction ? (
					<div style={styles.branchFooterActions}>
						<button type="button" style={styles.secondaryButton} onClick={onOpenGitFlow} title="Открыть Git flow">
							Git flow
						</button>
					</div>
				) : null}
			</div>}
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
	toggleExpanded: (key: string, defaultExpanded?: boolean) => void,
	applyProjectBranch: (project: PromptDashboardProjectSummary) => void,
	pullProject: (project: PromptDashboardProjectSummary) => void,
): React.ReactNode {
	const branchOptions = buildBranchOptions(project);
	const selectedBranch = resolveBranchDraft(project, branchDrafts);
	const selectedBranchInfo = project.branches.find(branch => branch.name === selectedBranch);
	const projectLabel = compactPromptDashboardMiddleLabel(project.project, BRANCH_PROJECT_LABEL_MAX_LENGTH);
	const isChanged = selectedBranch && selectedBranch !== project.currentBranch;
	const isSwitchBusy = isPromptDashboardBranchActionBusy(busyAction);
	const isProjectBusy = busyAction === `switch-project:${project.project}` || busyAction === `pull-project:${project.project}`;
	const canPullSelectedCurrentBranch = !isChanged
		&& selectedBranchInfo?.current === true
		&& Math.max(selectedBranchInfo?.behind ?? 0, project.behind) > 0;
	const hasRowAction = isChanged || canPullSelectedCurrentBranch;
	const actionLabel = canPullSelectedCurrentBranch ? 'Получить' : 'Применить';
	const actionBusyLabel = canPullSelectedCurrentBranch ? 'Получаем' : 'Применяем';
	const actionTitle = canPullSelectedCurrentBranch
		? `Получить входящие изменения для ${project.project}`
		: isChanged
			? `Переключить ${project.project} на ${selectedBranch}`
			: 'Ветка уже активна';
	const selectedLabel = isChanged ? 'выбрана' : 'текущая';
	const incomingFilesToggleKey = `incoming:${project.project}`;
	const dirtyFilesToggleKey = `dirty:${project.project}`;
	const hasIncomingFiles = canPullSelectedCurrentBranch && project.incomingFiles.length > 0;
	const incomingFilesExpanded = expanded[incomingFilesToggleKey] === true;
	const hasUncommittedFiles = project.uncommittedFiles.length > 0;
	const uncommittedFilesExpanded = expanded[dirtyFilesToggleKey] === true;
	const branchSelectStyle = {
		...styles.branchSelect,
		...(project.hasPromptBranchMismatch ? styles.branchSelectMismatch : null),
	};
	return (
		<div key={project.project} style={{ ...styles.branchProjectRow, ...(index === 0 ? styles.branchProjectRowFirst : null) }}>
			<div style={styles.projectName} title={`${project.project}\nТекущая ветка: ${project.currentBranch || 'n/a'}`}>{projectLabel}</div>
			<label style={styles.branchSelectInlineLabel}>
				<select
					value={selectedBranch}
					style={branchSelectStyle}
					aria-invalid={project.hasPromptBranchMismatch || undefined}
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
				style={{
					...styles.inlineButton,
					...(canPullSelectedCurrentBranch ? styles.inlineButtonSuccess : null),
					...(!hasRowAction || (isSwitchBusy && !isProjectBusy) ? styles.inlineButtonDisabled : null),
					...(isProjectBusy ? styles.busyButton : null),
				}}
				disabled={!hasRowAction || isSwitchBusy}
				onClick={() => {
					if (canPullSelectedCurrentBranch) {
						pullProject(project);
						return;
					}
					applyProjectBranch(project);
				}}
				title={actionTitle}
			>
				{isProjectBusy ? <span style={styles.inlineSpinnerLabel}><span style={styles.buttonSpinner} aria-hidden="true" /> {actionBusyLabel}</span> : actionLabel}
			</button>
			{project.branchSwitchError ? renderBranchProjectErrorBlock('Ошибка переключения ветки', project.branchSwitchError) : null}
			{project.pullError ? renderBranchProjectErrorBlock('Ошибка получения опережающих файлов', project.pullError) : null}
			{hasIncomingFiles ? renderBranchProjectIncomingFiles(project, selectedBranchInfo?.upstream || '@{upstream}', incomingFilesToggleKey, incomingFilesExpanded, fileHandlers, toggleExpanded) : null}
			{hasUncommittedFiles ? renderBranchProjectUncommittedFiles(project, dirtyFilesToggleKey, uncommittedFilesExpanded, fileHandlers, toggleExpanded) : null}
			{project.error ? renderBranchProjectErrorBlock('Ошибка проекта', project.error) : null}
		</div>
	);
}

/** Renders one outlined error block under the affected project row. */
function renderBranchProjectErrorBlock(title: string, message: string): React.ReactNode {
	return (
		<div style={styles.branchProjectErrorBlock}>
			<div style={styles.branchProjectErrorTitle}>{title}</div>
			<div style={styles.errorText}>{message}</div>
		</div>
	);
}

/** Renders a collapsible outlined notice about local uncommitted files under the branch selector row. */
function renderBranchProjectIncomingFiles(
	project: PromptDashboardProjectSummary,
	upstreamRef: string,
	toggleKey: string,
	expanded: boolean,
	fileHandlers: FileRowActionHandlers,
	toggleExpanded: (key: string, defaultExpanded?: boolean) => void,
): React.ReactNode {
	const files = project.incomingFiles;
	const incomingAuthorsLabel = (project.incomingAuthors || []).map(author => author.trim()).filter(Boolean).join(', ');
	const disclosureTitle = incomingAuthorsLabel
		? `Опережающие файлы (${incomingAuthorsLabel})`
		: 'Опережающие файлы';
	return (
		<div style={{ ...styles.branchProjectNoticeBlock, ...styles.branchProjectNoticeBlockSuccess }}>
			<button
				type="button"
				style={styles.branchProjectNoticeToggle}
				onClick={() => toggleExpanded(toggleKey)}
				title={expanded ? 'Скрыть список входящих файлов' : 'Показать список входящих файлов'}
			>
				<span style={styles.detailChevron}>{expanded ? '▾' : '▸'}</span>
				<span style={{ ...styles.branchProjectNoticeText, ...styles.branchProjectNoticeTextSuccess }}>{disclosureTitle}</span>
				<span style={{ ...styles.fileCount, ...styles.fileCountOk }}>{files.length}</span>
			</button>
			{expanded ? (
				renderBranchProjectIncomingFileList(project, upstreamRef, files, fileHandlers)
			) : null}
		</div>
	);
}

/** Renders incoming upstream changes through the same exact patch viewer used by branch comparisons. */
function renderBranchProjectIncomingFileList(
	project: PromptDashboardProjectSummary,
	upstreamRef: string,
	files: PromptDashboardProjectSummary['incomingFiles'],
	fileHandlers: FileRowActionHandlers,
): React.ReactNode {
	const entries = [...files]
		.sort((left, right) => left.path.localeCompare(right.path, 'ru'))
		.map((file, index) => {
			const pathParts = splitPromptDashboardPathParts(file.path);
			const fileKey = `${project.project}:incoming:${upstreamRef}:${file.previousPath || ''}:${file.path}`;
			return {
				key: `incoming:${file.status}:${file.previousPath || ''}:${file.path}:${index}`,
				path: file.path,
				status: file.status,
				label: pathParts.fileName || file.path,
				pathPrefix: pathParts.directoryPath ? `${pathParts.directoryPath}/` : undefined,
				secondaryLabel: file.previousPath ? `было: ${file.previousPath}` : undefined,
				additions: file.additions,
				deletions: file.deletions,
				isBinary: file.isBinary,
				showBranchPrefix: false,
				opening: fileHandlers.openingFileKey === fileKey,
				active: fileHandlers.activeFileKey === fileKey,
				viewed: fileHandlers.viewedFileKeys[fileKey] === true,
				onOpenPatch: () => fileHandlers.onOpenFilePatch({
					project: project.project,
					filePath: file.path,
					previousPath: file.previousPath,
					mode: 'branch',
					ref: upstreamRef,
					baseRef: 'HEAD',
				}, fileKey),
			} satisfies DashboardFileTreeEntry;
		});

	return (
		<div style={{ ...styles.branchProjectNoticeList, ...styles.branchProjectNoticeListSuccess }}>
			{entries.map((entry, index) => renderChangedFileRow(entry, { ancestorHasSibling: [], isLast: index === entries.length - 1 }))}
		</div>
	);
}

/** Renders a collapsible outlined notice about local uncommitted files under the branch selector row. */
function renderBranchProjectUncommittedFiles(
	project: PromptDashboardProjectSummary,
	toggleKey: string,
	expanded: boolean,
	fileHandlers: FileRowActionHandlers,
	toggleExpanded: (key: string, defaultExpanded?: boolean) => void,
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
			const pathParts = splitPromptDashboardPathParts(file.path);
			const fileKey = `${project.project}:dirty:${file.group}:${file.previousPath || ''}:${file.path}`;
			return {
				key: `${file.group}:${file.status}:${file.previousPath || ''}:${file.path}:${index}`,
				path: file.path,
				status: file.status,
				label: pathParts.fileName || file.path,
				pathPrefix: pathParts.directoryPath ? `${pathParts.directoryPath}/` : undefined,
				secondaryLabel: file.previousPath ? `было: ${file.previousPath}` : undefined,
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

function renderReviewRequests(
	projects: PromptDashboardProjectSummary[],
	cacheStatus: PromptDashboardLoadStatus,
	busyAction: DashboardBusyAction,
	collapsedSections: PromptDashboardCollapsedSections,
	onToggleSectionCollapse: (section: PromptDashboardSectionKey) => void,
	onRefreshWidget?: (section: PromptDashboardSectionKey, widget: PromptDashboardWidgetKind) => void,
	dragHandle?: React.ReactNode,
): React.ReactNode {
	const collapsed = isPromptDashboardSectionCollapsed(collapsedSections, 'reviewRequests');
	const sectionCacheStatus = resolveSectionCacheStatus(cacheStatus, busyAction, 'reviewRequests', 'projects');
	const visibleProjects = projects.filter(project => Boolean(
		project.review.request
		|| project.review.error
		|| project.review.unsupportedReason,
	));
	return (
		<section style={styles.section}>
			{renderSectionHeader('MR/PR', renderSectionMeta(visibleProjects.length || '...', sectionCacheStatus, 'обновляем', {
					section: 'reviewRequests',
					collapsed,
					widget: 'projects',
					title: 'MR/PR',
					busyAction,
					onToggleCollapse: () => onToggleSectionCollapse('reviewRequests'),
					onRefreshWidget,
				}), { collapsed, onToggleCollapse: () => onToggleSectionCollapse('reviewRequests'), dragHandle })}
			{collapsed ? null : <div style={styles.sectionBody}>
				{visibleProjects.length === 0 ? sectionCacheStatus === 'loading' ? renderLoadingEmptyState('MR/PR-данные загружаются') : <div style={styles.emptyText}>Нет активных MR/PR</div> : visibleProjects.map(project => {
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
			</div>}
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
	toggleExpanded: (key: string, defaultExpanded?: boolean) => void,
	fileHandlers: FileRowActionHandlers,
	cacheStatus: PromptDashboardLoadStatus,
	busyAction: DashboardBusyAction,
	collapsedSections: PromptDashboardCollapsedSections,
	onToggleSectionCollapse: (section: PromptDashboardSectionKey) => void,
	onRefreshWidget?: (section: PromptDashboardSectionKey, widget: PromptDashboardWidgetKind) => void,
	dragHandle?: React.ReactNode,
): React.ReactNode {
	const collapsed = isPromptDashboardSectionCollapsed(collapsedSections, 'parallelBranches');
	const sectionCacheStatus = resolveSectionCacheStatus(cacheStatus, busyAction, 'parallelBranches', 'projects');
	const projectGroups = projects
		.map(project => ({ project, branches: resolveVisibleParallelBranches(project.parallelBranches) }))
		.filter(item => item.branches.length > 0 || item.project.conflictFiles.length > 0);
	const totalVisibleBranches = projectGroups.reduce((count, item) => count + item.branches.length, 0);
	return (
		<section style={styles.section}>
			{renderSectionHeader('Параллельные ветки', renderSectionMeta(totalVisibleBranches || '...', sectionCacheStatus, 'обновляем', {
					section: 'parallelBranches',
					collapsed,
					widget: 'projects',
					title: 'Параллельные ветки',
					busyAction,
					onToggleCollapse: () => onToggleSectionCollapse('parallelBranches'),
					onRefreshWidget,
				}), { collapsed, onToggleCollapse: () => onToggleSectionCollapse('parallelBranches'), dragHandle })}
			{collapsed ? null : <div style={styles.sectionBody}>
				{projectGroups.length === 0 ? sectionCacheStatus === 'loading' ? renderLoadingEmptyState('Данные по веткам загружаются') : <div style={styles.emptyText}>Нет данных по параллельным веткам</div> : projectGroups.map(({ project, branches }) => (
					<div key={project.project} style={styles.projectBlock}>
						<div style={styles.projectHeader}>
							<div style={styles.projectName}>{project.project}</div>
							<span style={styles.sectionMeta}>{branches.length}</span>
						</div>
						{renderParallelBranchGraph(project, branches)}
						{renderParallelBranches(project, branches, expanded, toggleExpanded, fileHandlers)}
						{renderConflictFiles(project, fileHandlers)}
					</div>
				))}
			</div>}
		</section>
	);
}

/** Hides parallel branches once lightweight or hydrated data proves they have no unique files. */
export function resolveVisibleParallelBranches(branches: GitOverlayParallelBranchSummary[]): GitOverlayParallelBranchSummary[] {
	return branches.filter((branch) => {
		if (branch.detailsMissing === true) {
			return true;
		}

		if (typeof branch.affectedFileCount === 'number') {
			return branch.affectedFileCount > 0 || branch.potentialConflicts.length > 0;
		}

		return branch.detailsHydrated === false || branch.affectedFiles.length > 0 || branch.potentialConflicts.length > 0;
	});
}

function renderProjectCommits(
	projects: PromptDashboardProjectSummary[],
	expanded: ExpandedState,
	toggleExpanded: (key: string) => void,
	fileHandlers: FileRowActionHandlers,
	cacheStatus: PromptDashboardLoadStatus,
	busyAction: DashboardBusyAction,
	collapsedSections: PromptDashboardCollapsedSections,
	onToggleSectionCollapse: (section: PromptDashboardSectionKey) => void,
	onRefreshWidget?: (section: PromptDashboardSectionKey, widget: PromptDashboardWidgetKind) => void,
	dragHandle?: React.ReactNode,
): React.ReactNode {
	const collapsed = isPromptDashboardSectionCollapsed(collapsedSections, 'projectCommits');
	const sectionCacheStatus = resolveSectionCacheStatus(cacheStatus, busyAction, 'projectCommits', 'projects');
	return (
		<section style={styles.section}>
			{renderSectionHeader('Коммиты проектов', renderSectionMeta(projects.length || '...', sectionCacheStatus, 'обновляем', {
					section: 'projectCommits',
					collapsed,
					widget: 'projects',
					title: 'Коммиты проектов',
					busyAction,
					onToggleCollapse: () => onToggleSectionCollapse('projectCommits'),
					onRefreshWidget,
				}), { collapsed, onToggleCollapse: () => onToggleSectionCollapse('projectCommits'), dragHandle })}
			{collapsed ? null : <div style={styles.sectionBody}>
				{projects.length === 0 ? (
					sectionCacheStatus === 'loading' ? renderLoadingEmptyState('Коммиты загружаются') : <div style={styles.emptyText}>Коммиты пока недоступны</div>
				) : projects.map((project, index) => (
					<div key={project.project} style={{ ...styles.projectBlock, ...(index === 0 ? styles.projectBlockFirst : null) }}>
						<div style={styles.projectHeader}>
							<div style={styles.projectName}>{project.project}</div>
							<span style={styles.sectionMeta}>{project.currentBranch || 'n/a'}</span>
						</div>
						{renderCommitList(project, expanded, toggleExpanded, fileHandlers)}
					</div>
				))}
			</div>}
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
	const changedFilesLabel = resolveCommitChangedFilesLabel(commit);
	return (
		<div key={commit.sha} style={styles.detailBlock}>
			<button type="button" style={{ ...styles.detailButton, ...styles.commitDetailButton }} onClick={() => toggleExpanded(expandKey)}>
				<span style={styles.detailChevron}>{isExpanded ? '▾' : '▸'}</span>
				<span style={styles.commitContent}>
					<span style={styles.commitMetaRow}>
						<span style={styles.commitSha}>{commit.shortSha}</span>
						{commit.author ? <span style={styles.commitAuthor}>{commit.author}</span> : null}
					</span>
					<span style={styles.commitSubject}>{commit.subject}</span>
				</span>
				<span style={{ ...styles.fileCount, ...styles.commitFileCount }}>{changedFilesLabel}</span>
			</button>
			{isExpanded ? renderCommitChangedFiles(project, commit, fileHandlers) : null}
		</div>
	);
}

/** Prefers lightweight file-count summaries before the full commit file list hydrates. */
function resolveCommitChangedFilesLabel(commit: PromptDashboardRecentCommit): string {
	if (typeof commit.changedFileCount === 'number') {
		return String(commit.changedFileCount);
	}

	return commit.changedFilesHydrated === false ? '...' : String(commit.changedFiles.length);
}

function renderParallelBranches(
	project: PromptDashboardProjectSummary,
	branches: GitOverlayParallelBranchSummary[],
	expanded: ExpandedState,
	toggleExpanded: (key: string) => void,
	fileHandlers: FileRowActionHandlers,
): React.ReactNode {
	if (branches.length === 0) {
		return null;
	}
	const branchGraphScale = buildParallelBranchGraphScale(branches);
	return (
		<div style={styles.parallelGraphRows}>
			{branches.map((branch, index) => renderParallelBranch(
				project,
				branch,
				index,
				branches.length,
				branchGraphScale,
				expanded,
				toggleExpanded,
				fileHandlers,
			))}
		</div>
	);
}

/** Keeps long SVG labels readable inside the narrow dashboard rail. */
function truncateParallelGraphLabel(value: string, maxLength: number): string {
	const normalizedValue = String(value || '').trim();
	if (!normalizedValue || normalizedValue.length <= maxLength) {
		return normalizedValue;
	}

	return `${normalizedValue.slice(0, Math.max(0, maxLength - 3))}...`;
}

/** Keeps lane color stable by branch kind while conflicts use separate row indicators. */
function resolveParallelGraphBranchColor(branch: GitOverlayParallelBranchSummary): string {
	return branch.kind === 'remote'
		? 'var(--vscode-charts-orange, #d19a66)'
		: 'var(--vscode-charts-green, #89d185)';
}

interface ParallelBranchGraphScale {
	maxAhead: number;
	maxBehind: number;
}

/** Normalizes lane scaling so every row shows comparable ahead and behind spans. */
function buildParallelBranchGraphScale(branches: GitOverlayParallelBranchSummary[]): ParallelBranchGraphScale {
	const maxAhead = branches.reduce((value, branch) => Math.max(value, branch.ahead), 0);
	const maxBehind = branches.reduce((value, branch) => Math.max(value, branch.behind), 0);
	return {
		maxAhead: Math.max(1, maxAhead),
		maxBehind: Math.max(1, maxBehind),
	};
}

/** Keeps visible graph segments readable even when one branch has only a small delta. */
function resolveParallelGraphSegmentWidth(value: number, maxValue: number, maxWidth: number, minWidth: number): number {
	if (value <= 0 || maxWidth <= 0) {
		return 0;
	}

	if (maxValue <= 0) {
		return minWidth;
	}

	return Math.min(maxWidth, Math.max(minWidth, Math.round((value / maxValue) * maxWidth)));
}

/** Builds the compact secondary label shown under each branch lane in the SVG graph. */
function resolveParallelGraphMeta(branch: GitOverlayParallelBranchSummary): string {
	const parts = [
		branch.kind === 'remote' ? 'remote' : 'local',
		branch.lastCommit?.author || '',
		`+${branch.ahead} / -${branch.behind}`,
	].filter(Boolean);
	return truncateParallelGraphLabel(parts.join(' | '), 34);
}

/** Renders a compact horizontal branch map above the parallel branch list. */
function renderParallelBranchGraph(
	project: PromptDashboardProjectSummary,
	branches: GitOverlayParallelBranchSummary[],
): React.ReactNode {
	if (branches.length === 0) {
		return null;
	}

	const baseBranch = truncateParallelGraphLabel(
		branches[0]?.baseBranch || project.currentBranch || project.promptBranch || project.trackedBranch,
		26,
	);

	return (
		<div style={styles.parallelGraphCard} data-pm-parallel-graph={project.project}>
			<div style={styles.parallelGraphLegend}>
				<span style={styles.parallelGraphLegendLabel}>База</span>
				<span style={styles.parallelGraphBaseChip}>{baseBranch || 'n/a'}</span>
				<span style={styles.parallelGraphLegendNote}>красное слева, свои коммиты справа</span>
			</div>
		</div>
	);
}

/** Renders one horizontal lane with ahead and behind spans for a parallel branch row. */
function renderParallelBranchLane(
	branch: GitOverlayParallelBranchSummary,
	branchIndex: number,
	branchCount: number,
	branchGraphScale: ParallelBranchGraphScale,
): React.ReactNode {
	const graphWidth = 118;
	const graphHeight = 28;
	const centerY = 14;
	const trunkX = 12;
	const midX = 58;
	const maxBehindWidth = 18;
	const maxAheadWidth = 42;
	const laneColor = resolveParallelGraphBranchColor(branch);
	const behindWidth = resolveParallelGraphSegmentWidth(branch.behind, branchGraphScale.maxBehind, maxBehindWidth, 8);
	const aheadWidth = resolveParallelGraphSegmentWidth(branch.ahead, branchGraphScale.maxAhead, maxAheadWidth, 10);
	const behindStartX = midX - behindWidth;
	const headX = midX + aheadWidth;
	const trunkStartY = branchIndex === 0 ? centerY : 0;
	const trunkEndY = branchIndex === branchCount - 1 ? centerY : graphHeight;
	const connectorEndX = Math.max(trunkX + 8, behindStartX);

	return (
		<svg
			viewBox={`0 0 ${graphWidth} ${graphHeight}`}
			style={styles.parallelGraphLane}
			aria-hidden="true"
			focusable="false"
			data-pm-parallel-graph-row={branch.name}
			data-pm-parallel-graph-kind={branch.kind || 'local'}
			data-pm-parallel-graph-ahead={String(branch.ahead)}
			data-pm-parallel-graph-behind={String(branch.behind)}
			data-pm-parallel-graph-ahead-width={String(aheadWidth)}
			data-pm-parallel-graph-behind-width={String(behindWidth)}
		>
			{branchCount > 1 ? (
				<line
					x1={trunkX}
					y1={trunkStartY}
					x2={trunkX}
					y2={trunkEndY}
					stroke="var(--vscode-textLink-foreground)"
					strokeWidth="2"
					strokeLinecap="round"
					opacity="0.75"
				/>
			) : null}
			<line
				x1={trunkX}
				y1={centerY}
				x2={connectorEndX}
				y2={centerY}
				stroke={laneColor}
				strokeWidth="2"
				strokeLinecap="round"
				opacity="0.45"
			/>
			<line
				x1={midX}
				y1={centerY - 7}
				x2={midX}
				y2={centerY + 7}
				stroke="color-mix(in srgb, var(--vscode-panel-border) 88%, transparent)"
				strokeWidth="1"
			/>
			{behindWidth > 0 ? (
				<line
					x1={behindStartX}
					y1={centerY}
					x2={midX}
					y2={centerY}
					stroke="var(--vscode-charts-red)"
					strokeWidth="2.4"
					strokeLinecap="round"
					strokeDasharray="4 2"
					opacity="0.95"
				/>
			) : null}
			{aheadWidth > 0 ? (
				<line
					x1={midX}
					y1={centerY}
					x2={headX}
					y2={centerY}
					stroke={laneColor}
					strokeWidth="2.8"
					strokeLinecap="round"
					opacity="0.95"
				/>
			) : null}
			<circle cx={trunkX} cy={centerY} r={2.8} fill="var(--vscode-textLink-foreground)" opacity="0.95" />
			<circle cx={headX} cy={centerY} r={4.2} fill={laneColor} />
		</svg>
	);
}

/** Prefers lightweight file-count summaries before the full parallel-branch diff list hydrates. */
function resolveParallelBranchChangedFilesLabel(branch: GitOverlayParallelBranchSummary): string {
	if (typeof branch.affectedFileCount === 'number') {
		return String(branch.affectedFileCount);
	}

	return branch.detailsHydrated === false ? '...' : String(branch.affectedFiles.length);
}

function renderParallelBranch(
	project: PromptDashboardProjectSummary,
	branch: GitOverlayParallelBranchSummary,
	branchIndex: number,
	branchCount: number,
	branchGraphScale: ParallelBranchGraphScale,
	expanded: ExpandedState,
	toggleExpanded: (key: string) => void,
	fileHandlers: FileRowActionHandlers,
): React.ReactNode {
	const expandKey = `parallel:${project.project}:${branch.name}`;
	const isExpanded = expanded[expandKey] === true;
	const changedFilesLabel = resolveParallelBranchChangedFilesLabel(branch);
	const hasConflictWarning = branch.detailsHydrated !== false && branch.potentialConflicts.length > 0;
	return (
		<div key={branch.name} style={styles.detailBlock}>
			<button
				type="button"
				style={{ ...styles.detailButton, ...styles.parallelDetailButton }}
				onClick={() => toggleExpanded(expandKey)}
				title={`${branch.ref || branch.name}\n${resolveParallelGraphMeta(branch)}`}
			>
				<span style={styles.detailChevron}>{isExpanded ? '▾' : '▸'}</span>
				{renderParallelBranchLane(branch, branchIndex, branchCount, branchGraphScale)}
				<span style={styles.parallelBranchContent}>
					<span style={styles.branchLabelRow}>
						<span style={styles.branchName}>{branch.name}</span>
						{branch.lastCommit?.author ? <span style={styles.branchAuthor}>{branch.lastCommit.author}</span> : null}
					</span>
					<span style={styles.parallelBranchMeta}>{`${branch.kind === 'remote' ? 'remote' : 'local'} • база ${branch.baseBranch}`}</span>
				</span>
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
	if (branch.detailsMissing === true) {
		const hasKnownPositiveCount = typeof branch.affectedFileCount === 'number' && branch.affectedFileCount > 0;
		return <div style={styles.emptyDetails}>{hasKnownPositiveCount
			? `Не удалось догрузить diff ветки относительно ${branch.baseBranch}`
			: `Нет уникальных изменений относительно ${branch.baseBranch}`}</div>;
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
					onOpenPatch: () => fileHandlers.onOpenFilePatch({ project: project.project, filePath: file.path, previousPath: file.previousPath, mode: 'branch', ref: branch.ref || branch.name, baseRef: branch.baseBranch }, fileKey),
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
			borderColor: 'color-mix(in srgb, var(--vscode-charts-yellow) 99%, var(--vscode-panel-border))',
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
				borderColor: 'color-mix(in srgb, var(--vscode-charts-yellow) 99%, var(--vscode-panel-border))',
				background: 'color-mix(in srgb, var(--vscode-charts-yellow) 18%, var(--vscode-editor-background))',
			};
		default:
			return {
				label: '~',
				accentColor: 'var(--vscode-charts-orange, var(--vscode-charts-yellow))',
				borderColor: 'color-mix(in srgb, var(--vscode-charts-orange, var(--vscode-charts-yellow)) 99%, var(--vscode-panel-border))',
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

/** Measures flat branch-widget rows and shortens only the overflowing directory prefix. */
const PromptDashboardMeasuredFlatFileRow: React.FC<{ input: DashboardFileTreeEntry }> = ({ input }) => {
	const tone = resolveFileTone(input.status, input.warn === true);
	const lineStats = resolveFileLineStats(input);
	const renameHint = cleanTreeSecondaryLabel(input.secondaryLabel);
	const isActive = input.active === true;
	const isViewed = input.viewed === true;
	const isOpening = input.opening === true;
	const baseParts = splitPromptDashboardPathParts(input.path);
	const [pathPrefix, setPathPrefix] = useState(input.pathPrefix || '');
	const fileMainRef = useRef<HTMLSpanElement | null>(null);
	const pathPrefixRef = useRef<HTMLSpanElement | null>(null);

	// Reset the visible prefix whenever the underlying file path changes.
	useEffect(() => {
		setPathPrefix(input.pathPrefix || '');
	}, [input.path, input.pathPrefix]);

	// Refit the directory prefix to the actual rendered width of this one flat row.
	useEffect(() => {
		if (!baseParts.directoryPath || typeof window === 'undefined') {
			return;
		}

		const measureAndFit = () => {
			const fileMain = fileMainRef.current;
			if (!fileMain || fileMain.clientWidth <= 0) {
				return;
			}

			const children = Array.from(fileMain.children) as HTMLElement[];
			const prefixElement = pathPrefixRef.current;
			const gapPx = resolvePromptDashboardElementGapPx(fileMain);
			const reservedWidth = children
				.filter(child => child !== prefixElement)
				.reduce((total, child) => total + child.getBoundingClientRect().width, 0);
			const totalGapWidth = gapPx * Math.max(0, children.length - 1);
			const availableWidth = Math.max(0, fileMain.clientWidth - reservedWidth - totalGapWidth);
			const measureText = createPromptDashboardTextMeasure(prefixElement || fileMain);
			const fittedPath = fitPromptDashboardPathPartsToWidth(input.path, {
				availableWidth,
				measureText,
			});
			const nextPrefix = fittedPath.directoryPath ? `${fittedPath.directoryPath}/` : '';
			setPathPrefix(current => current === nextPrefix ? current : nextPrefix);
		};

		measureAndFit();

		if (typeof ResizeObserver !== 'undefined') {
			const observer = new ResizeObserver(() => {
				measureAndFit();
			});

			if (fileMainRef.current) {
				observer.observe(fileMainRef.current);
			}

			return () => observer.disconnect();
		}

		window.addEventListener('resize', measureAndFit);
		return () => window.removeEventListener('resize', measureAndFit);
	}, [baseParts.directoryPath, input.path, isActive, isOpening, isViewed, renameHint]);

	return (
		<button
			type="button"
			style={{
				...styles.fileTreeFileRow,
				...styles.fileTreeFileRowFlat,
				...(isViewed ? styles.fileTreeFileRowViewed : null),
				...(isActive ? styles.fileTreeFileRowActive : null),
			}}
			onClick={input.onOpenPatch}
			title={input.path}
		>
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
			<span ref={fileMainRef} style={styles.fileTreeFileMain}>
				{pathPrefix ? <span ref={pathPrefixRef} style={styles.fileTreePathPrefix}>{pathPrefix}</span> : null}
				<span style={{ ...styles.fileGraphFileName, ...(isViewed ? styles.fileGraphFileNameViewed : null), ...(isActive ? styles.fileGraphFileNameActive : null), flexShrink: 0 }}>{baseParts.fileName}</span>
				{renameHint ? <span style={styles.fileTreeRenameHint}>{`← ${renameHint}`}</span> : null}
				{isOpening ? <span style={styles.fileTreeOpeningHint}>opening…</span> : null}
				{isActive ? <span style={styles.fileTreeStateBadgeActive}>открыт</span> : null}
				{!isActive && isViewed ? <span style={styles.fileTreeStateBadgeViewed}>просмотрен</span> : null}
			</span>
			{renderLineStats(lineStats, false, { hideUnknown: input.hideUnknownLineStats === true })}
		</button>
	);
};

/** Renders one clickable file leaf in the dashboard tree. */
function renderChangedFileRow(input: DashboardFileTreeEntry, context: DashboardFileTreeRowContext): React.ReactNode {
	if (input.showBranchPrefix === false) {
		return <PromptDashboardMeasuredFlatFileRow key={`file:${input.key}`} input={input} />;
	}

	const fileName = input.label || input.path.split('/').pop() || input.path;
	const pathPrefix = input.pathPrefix || '';
	const isOpening = input.opening === true;
	const tone = resolveFileTone(input.status, input.warn === true);
	const lineStats = resolveFileLineStats(input);
	const renameHint = cleanTreeSecondaryLabel(input.secondaryLabel);
	const isActive = input.active === true;
	const isViewed = input.viewed === true;
	const showBranchPrefix = true;
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
				{pathPrefix ? <span style={styles.fileTreePathPrefix}>{pathPrefix}</span> : null}
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

/** Reads the inline flex gap in pixels so the width budget matches the rendered row. */
function resolvePromptDashboardElementGapPx(element: HTMLElement): number {
	if (typeof window === 'undefined') {
		return 0;
	}
	const computedStyle = window.getComputedStyle(element);
	return Number.parseFloat(computedStyle.columnGap || computedStyle.gap || '0') || 0;
}

/** Creates a text measurer that mirrors the rendered font of the path-prefix span. */
function createPromptDashboardTextMeasure(element: HTMLElement): (value: string) => number {
	if (typeof document === 'undefined' || typeof window === 'undefined') {
		return value => value.length;
	}

	const canvas = document.createElement('canvas');
	const context = canvas.getContext('2d');
	if (!context) {
		return value => value.length;
	}

	const computedStyle = window.getComputedStyle(element);
	context.font = computedStyle.font || `${computedStyle.fontWeight} ${computedStyle.fontSize} ${computedStyle.fontFamily}`;
	return value => context.measureText(value).width;
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
	const visibleParts = resolveVisibleLineStatsParts(stats, options);
	if (visibleParts === 'binary') {
		return <span style={styles.fileLineStatsSpecial}>(bin)</span>;
	}
	if (visibleParts === 'unknown') {
		return <span style={styles.fileLineStatsSpecial}>(—)</span>;
	}
	if (!visibleParts || visibleParts.length === 0) {
		return null;
	}
	return (
		<span style={compact ? styles.fileLineStatsCompact : styles.fileLineStats}>
			<span style={styles.fileLineStatParen}>(</span>
			{visibleParts.map(part => part.startsWith('+')
				? <span key={part} style={styles.fileLineStatAdded}>{part}</span>
				: part.startsWith('~')
					? <span key={part} style={styles.fileLineStatChanged}>{part}</span>
					: <span key={part} style={styles.fileLineStatDeleted}>{part}</span>)}
			<span style={styles.fileLineStatParen}>)</span>
		</span>
	);
}

/** Removes zero-valued +0 and -0 counters while keeping binary and unknown states explicit. */
export function resolveVisibleLineStatsParts(
	stats: { added: number; changed: number; deleted: number; kind: 'diff' | 'binary' | 'unknown' },
	options?: { hideUnknown?: boolean },
): string[] | 'binary' | 'unknown' | null {
	if (stats.kind === 'binary') {
		return 'binary';
	}
	if (stats.kind === 'unknown') {
		return options?.hideUnknown ? null : 'unknown';
	}
	const parts: string[] = [];
	if (stats.added > 0) {
		parts.push(`+${stats.added}`);
	}
	if (stats.changed > 0) {
		parts.push(`~${stats.changed}`);
	}
	if (stats.deleted > 0) {
		parts.push(`-${stats.deleted}`);
	}
	return parts.length > 0 ? parts : null;
}

/** Returns true only for branch-widget mutations that should lock branch controls. */
export function isPromptDashboardBranchActionBusy(busyAction: DashboardBusyAction): boolean {
	return busyAction === 'switch-all'
		|| busyAction === 'preset:prompt'
		|| busyAction === 'preset:tracked'
		|| Boolean(busyAction?.startsWith('switch-project:'))
		|| Boolean(busyAction?.startsWith('pull-project:'));
}

/** Builds one section-scoped busy-action key for widget refresh indicators. */
function buildSectionRefreshBusyAction(section: PromptDashboardSectionKey): string {
	return `refresh-section:${section}`;
}

/** Validates a DOM dataset section key before it participates in reorder calculations. */
function isPromptDashboardSectionKeyValue(value: string | undefined): value is PromptDashboardSectionKey {
	return typeof value === 'string'
		&& PROMPT_DASHBOARD_SECTION_KEYS.includes(value as PromptDashboardSectionKey);
}

/** Resolves the nearest visible drop slot inside one dashboard column. */
export function resolvePromptDashboardColumnDropIndicator(
	activeDraggedSection: PromptDashboardSectionKey | null,
	clientY: number,
	sectionBounds: readonly PromptDashboardSectionBounds[],
): { section: PromptDashboardSectionKey; placement: 'before' | 'after' } | null {
	if (!activeDraggedSection) {
		return null;
	}

	const orderedBounds = sectionBounds
		.filter((item) => item.section !== activeDraggedSection)
		.filter((item) => Number.isFinite(item.top) && Number.isFinite(item.bottom))
		.sort((left, right) => left.top - right.top);
	if (orderedBounds.length === 0) {
		return null;
	}

	const nextTarget = orderedBounds.find((item) => clientY <= item.top + ((item.bottom - item.top) / 2));
	if (nextTarget) {
		return { section: nextTarget.section, placement: 'before' };
	}

	const lastTarget = orderedBounds[orderedBounds.length - 1];
	return { section: lastTarget.section, placement: 'after' };
}

function arePromptDashboardSectionOrdersEqual(
	left: PromptDashboardSectionOrder,
	right: PromptDashboardSectionOrder,
): boolean {
	const normalizedLeft = normalizePromptDashboardSectionOrder(left);
	const normalizedRight = normalizePromptDashboardSectionOrder(right);
	if (normalizedLeft.length !== normalizedRight.length) {
		return false;
	}

	return normalizedLeft.every((column, columnIndex) => {
		const rightColumn = normalizedRight[columnIndex] || [];
		return column.length === rightColumn.length
			&& column.every((section, rowIndex) => section === rightColumn[rowIndex]);
	});
}

/** Moves one section around the shared ordered dashboard list and keeps missing keys normalized. */
export function reorderPromptDashboardSections(
	order: PromptDashboardSectionOrder,
	draggedSection: PromptDashboardSectionKey,
	targetSection: PromptDashboardSectionKey,
	placement: DragPlacement,
): PromptDashboardSectionOrder {
	const normalizedOrder = normalizePromptDashboardSectionOrder(order);
	if (draggedSection === targetSection) {
		return normalizedOrder;
	}

	let sourceColumnIndex = -1;
	let sourceRowIndex = -1;
	let targetColumnIndex = -1;
	let targetRowIndex = -1;
	for (let columnIndex = 0; columnIndex < normalizedOrder.length; columnIndex += 1) {
		for (let rowIndex = 0; rowIndex < normalizedOrder[columnIndex].length; rowIndex += 1) {
			const section = normalizedOrder[columnIndex][rowIndex];
			if (section === draggedSection) {
				sourceColumnIndex = columnIndex;
				sourceRowIndex = rowIndex;
			}
			if (section === targetSection) {
				targetColumnIndex = columnIndex;
				targetRowIndex = rowIndex;
			}
		}
	}

	if (sourceColumnIndex < 0 || sourceRowIndex < 0 || targetColumnIndex < 0 || targetRowIndex < 0) {
		return normalizedOrder;
	}

	const nextOrder = normalizedOrder.map(column => [...column]);
	nextOrder[sourceColumnIndex].splice(sourceRowIndex, 1);
	let insertionIndex = placement === 'before' ? targetRowIndex : targetRowIndex + 1;
	if (sourceColumnIndex === targetColumnIndex && sourceRowIndex < insertionIndex) {
		insertionIndex -= 1;
	}
	nextOrder[targetColumnIndex].splice(insertionIndex, 0, draggedSection);
	return normalizePromptDashboardSectionOrder(nextOrder);
}

/** Resolves whether a specific section should show its own refresh spinner. */
function isSectionRefreshBusy(busyAction: DashboardBusyAction, section: PromptDashboardSectionKey): boolean {
	return busyAction === 'refresh' || busyAction === buildSectionRefreshBusyAction(section);
}

/** Masks shared loading status so only the actively refreshed section shows the refresh transition. */
function resolveSectionCacheStatus(
	cacheStatus: PromptDashboardLoadStatus,
	busyAction: DashboardBusyAction,
	section: PromptDashboardSectionKey,
	widget: PromptDashboardWidgetKind,
): PromptDashboardLoadStatus {
	if (busyAction === buildSectionRefreshBusyAction(section)) {
		return 'loading';
	}
	if (cacheStatus !== 'loading' || busyAction === 'refresh') {
		return cacheStatus;
	}
	if (widget === 'projects' && busyAction?.startsWith('refresh-section:')) {
		return 'fresh';
	}
	return cacheStatus;
}


function renderSectionMeta(
	value: string | number,
	cacheStatus: PromptDashboardLoadStatus,
	loadingLabel: string,
	options?: {
		section: PromptDashboardSectionKey;
		collapsed?: boolean;
		widget: PromptDashboardWidgetKind;
		title: string;
		busyAction: DashboardBusyAction;
		onToggleCollapse?: () => void;
		onRefreshWidget?: (section: PromptDashboardSectionKey, widget: PromptDashboardWidgetKind) => void;
	},
): React.ReactNode {
	const isBusy = options ? isSectionRefreshBusy(options.busyAction, options.section) : false;
	const collapseButton = options?.onToggleCollapse ? (
		<button
			type="button"
			style={{ ...styles.iconButton, ...styles.sectionCollapseButton }}
			onClick={(event) => handleSectionHeaderActionClick(event, () => options.onToggleCollapse?.())}
			title={`${options?.collapsed ? 'Развернуть' : 'Свернуть'} виджет: ${options.title}`}
			aria-label={`${options?.collapsed ? 'Развернуть' : 'Свернуть'} виджет: ${options.title}`}
		>
			<SectionChevronIcon collapsed={Boolean(options?.collapsed)} />
		</button>
	) : null;
	const metaNode = cacheStatus === 'loading' && options?.onRefreshWidget
		? null
		: cacheStatus === 'loading'
		? (
			<span style={styles.sectionMetaLoading}>
				<span style={styles.buttonSpinner} aria-hidden="true" />
				<span>{loadingLabel}</span>
			</span>
		)
		: <span style={styles.sectionMeta}>{value}</span>;

	if (!options?.onRefreshWidget) {
		return (
			<span style={styles.sectionHeaderActions}>
				{metaNode}
				{collapseButton}
			</span>
		);
	}

	return (
		<span style={styles.sectionHeaderActions}>
			{metaNode}
			{options?.collapsed ? null : <button
				type="button"
				style={{ ...styles.iconButton, ...styles.sectionRefreshButton, ...(isBusy ? styles.busyButton : null) }}
				onClick={(event) => handleSectionHeaderActionClick(event, () => options.onRefreshWidget?.(options.section, options.widget))}
				title={`Обновить виджет «${options.title}»`}
				aria-label={`Обновить виджет: ${options.title}`}
				disabled={isBusy}
			>
				{isBusy ? <span style={styles.buttonSpinner} aria-hidden="true" /> : <RefreshIcon />}
			</button>}
			{collapseButton}
		</span>
	);
}

/** Renders the Docker containers widget shell with summary, controls and container rows. */
function renderDockerContainers(
	data: DockerContainersData | undefined,
	viewMode: DockerContainersViewMode,
	statusFilter: DockerContainersStatusFilter,
	search: string,
	sortBy: DockerContainerSortBy,
	expanded: ExpandedState,
	cacheStatus: PromptDashboardLoadStatus,
	busyAction: DashboardBusyAction,
	setViewMode: (mode: DockerContainersViewMode) => void,
	setStatusFilter: (filter: DockerContainersStatusFilter) => void,
	setSearch: (search: string) => void,
	setSortBy: (sortBy: DockerContainerSortBy) => void,
	toggleExpanded: (key: string, defaultExpanded?: boolean) => void,
	onDockerAction: (containerId: string, action: DockerContainerActionKind) => void,
	onDockerComposeAction: (projectPath: string, composeFilePath: string, action: DockerComposeProjectActionKind) => void,
	onOpenDockerComposeFile: (projectPath: string, composeFilePath: string) => void,
	onOpenDockerLogs: (containerId: string) => void,
	onOpenDockerTerminal: (containerId: string) => void,
	collapsedSections: PromptDashboardCollapsedSections,
	onToggleSectionCollapse: (section: PromptDashboardSectionKey) => void,
	onRefreshWidget?: (section: PromptDashboardSectionKey, widget: PromptDashboardWidgetKind) => void,
	dragHandle?: React.ReactNode,
): React.ReactNode {
	const collapsed = isPromptDashboardSectionCollapsed(collapsedSections, 'dockerContainers');
	const sectionCacheStatus = resolveSectionCacheStatus(cacheStatus, busyAction, 'dockerContainers', 'docker');
	const projects = resolveFilteredDockerProjects(data, statusFilter, search, sortBy);
	const containers = sortDockerContainers(projects.flatMap(project => project.containers), sortBy);
	const metaValue = data?.available === false
		? sectionCacheStatus === 'loading'
			? '...'
			: 'нет связи'
		: data?.totalContainers
			? `${data.runningContainers}/${data.totalContainers}`
			: sectionCacheStatus === 'loading'
				? '...'
				: '0';

	return (
		<section style={styles.section}>
			{renderSectionHeader('Docker контейнеры', renderSectionMeta(metaValue, sectionCacheStatus, 'обновляем', {
					section: 'dockerContainers',
					collapsed,
					widget: 'docker',
					title: 'Docker контейнеры',
					busyAction,
					onToggleCollapse: () => onToggleSectionCollapse('dockerContainers'),
					onRefreshWidget,
				}), { collapsed, onToggleCollapse: () => onToggleSectionCollapse('dockerContainers'), dragHandle })}
			{collapsed ? null : <div style={styles.sectionBody}>
				{renderDockerSummary(data, sectionCacheStatus)}
				{renderDockerControls(viewMode, statusFilter, search, sortBy, setViewMode, setStatusFilter, setSearch, setSortBy)}
				{renderDockerContainerContent(data, projects, containers, viewMode, sectionCacheStatus, busyAction, expanded, toggleExpanded, onDockerAction, onDockerComposeAction, onOpenDockerComposeFile, onOpenDockerLogs, onOpenDockerTerminal)}
			</div>}
		</section>
	);
}

/** Renders Docker daemon availability and aggregate lifecycle counters. */
function renderDockerSummary(data: DockerContainersData | undefined, cacheStatus: PromptDashboardLoadStatus): React.ReactNode {
	if ((cacheStatus === 'loading' || !data) && !data?.totalContainers) {
		return renderLoadingEmptyState('Docker-контейнеры загружаются');
	}
	if (!data?.enabled) {
		return <div style={styles.emptyText}>Docker-виджет отключён в настройках.</div>;
	}
	if (data.available === false) {
		return <div style={styles.errorText}>{data.error || 'Docker Engine API недоступен.'}</div>;
	}

	return (
		<div style={styles.dockerSummaryGrid}>
			{renderDockerSummaryMetric('Всего', data.totalContainers)}
			{renderDockerSummaryMetric('Запущено', data.runningContainers, 'ok')}
			{renderDockerSummaryMetric('Остановлено', data.stoppedContainers, 'neutral')}
			{renderDockerSummaryMetric('Проблемы', data.warningContainers + data.errorContainers, data.errorContainers > 0 ? 'error' : 'warning')}
		</div>
	);
}

/** Renders one compact Docker counter tile. */
function renderDockerSummaryMetric(label: string, value: number, tone: DockerContainerStatusTone = 'neutral'): React.ReactNode {
	return (
		<div style={styles.dockerSummaryMetric}>
			<span style={styles.dockerSummaryLabel}>{label}</span>
			<span style={{ ...styles.dockerSummaryValue, color: resolveDockerToneColor(tone) }}>{value}</span>
		</div>
	);
}

/** Renders Docker view, filter, sort and search controls. */
function renderDockerControls(
	viewMode: DockerContainersViewMode,
	statusFilter: DockerContainersStatusFilter,
	search: string,
	sortBy: DockerContainerSortBy,
	setViewMode: (mode: DockerContainersViewMode) => void,
	setStatusFilter: (filter: DockerContainersStatusFilter) => void,
	setSearch: (search: string) => void,
	setSortBy: (sortBy: DockerContainerSortBy) => void,
): React.ReactNode {
	return (
		<div style={styles.dockerControls}>
			<div style={styles.dockerSegmentedControl}>
				{(['tree', 'cards', 'table', 'list'] as const).map(mode => (
					<button
						key={mode}
						type="button"
						style={{ ...styles.dockerSegmentButton, ...(viewMode === mode ? styles.dockerSegmentButtonActive : null) }}
						onClick={() => setViewMode(mode)}
						title={resolveDockerViewModeLabel(mode)}
					>
						{resolveDockerViewModeShortLabel(mode)}
					</button>
				))}
			</div>
			<div style={styles.dockerControlRow}>
				<select value={statusFilter} style={styles.dockerSelect} onChange={event => setStatusFilter(event.target.value as DockerContainersStatusFilter)} title="Фильтр статуса">
					<option value="all">Все</option>
					<option value="running">Запущены</option>
					<option value="stopped">Остановлены</option>
				</select>
				<select value={sortBy} style={styles.dockerSelect} onChange={event => setSortBy(event.target.value as DockerContainerSortBy)} title="Сортировка">
					<option value="status">Статус</option>
					<option value="name">Имя</option>
					<option value="uptime">Время</option>
					<option value="cpu">CPU</option>
					<option value="memory">RAM</option>
				</select>
			</div>
			<input
				value={search}
				style={styles.dockerSearchInput}
				onChange={event => setSearch(event.target.value)}
				placeholder="Поиск"
				title="Поиск по контейнерам"
			/>
		</div>
	);
}

/** Renders Docker containers in the selected tree, card, table or list mode. */
function renderDockerContainerContent(
	data: DockerContainersData | undefined,
	projects: DockerContainerProjectGroup[],
	containers: DockerContainerSummary[],
	viewMode: DockerContainersViewMode,
	cacheStatus: PromptDashboardLoadStatus,
	busyAction: DashboardBusyAction,
	expanded: ExpandedState,
	toggleExpanded: (key: string, defaultExpanded?: boolean) => void,
	onDockerAction: (containerId: string, action: DockerContainerActionKind) => void,
	onDockerComposeAction: (projectPath: string, composeFilePath: string, action: DockerComposeProjectActionKind) => void,
	onOpenDockerComposeFile: (projectPath: string, composeFilePath: string) => void,
	onOpenDockerLogs: (containerId: string) => void,
	onOpenDockerTerminal: (containerId: string) => void,
): React.ReactNode {
	if ((cacheStatus === 'loading' || !data) && !data?.totalContainers) {
		return renderLoadingEmptyState('Контейнеры загружаются');
	}
	if (!data?.available || !data.enabled) {
		return null;
	}
	if (data.projects.length === 0) {
		return <div style={styles.emptyText}>Compose-файлы рабочей области не найдены.</div>;
	}
	const visibleProjects = projects.filter(project => project.containers.length > 0 || project.composeFileGroups.length > 0 || project.composeFiles.length > 0);
	if (visibleProjects.length === 0) {
		return <div style={styles.emptyText}>По текущему фильтру контейнеров нет.</div>;
	}

	if (viewMode === 'cards') {
		return renderDockerProjectGroupedCards(visibleProjects, busyAction, data.composeActionError, expanded, toggleExpanded, onDockerAction, onDockerComposeAction, onOpenDockerComposeFile, onOpenDockerLogs, onOpenDockerTerminal);
	}
	if (viewMode === 'table') {
		return renderDockerFlatTable(visibleProjects, busyAction, data.composeActionError, expanded, toggleExpanded, onDockerAction, onDockerComposeAction, onOpenDockerComposeFile, onOpenDockerLogs, onOpenDockerTerminal);
	}
	if (viewMode === 'list') {
		return renderDockerProjectGroupedList(visibleProjects, busyAction, data.composeActionError, expanded, toggleExpanded, onDockerAction, onDockerComposeAction, onOpenDockerComposeFile, onOpenDockerLogs, onOpenDockerTerminal);
	}

	return (
		<div style={styles.dockerTree}>
			{visibleProjects.map((project, index) => renderDockerProjectGroup(
				project,
				busyAction,
				data?.composeActionError,
				expanded,
				toggleExpanded,
				onDockerAction,
				onDockerComposeAction,
				onOpenDockerComposeFile,
				onOpenDockerLogs,
				onOpenDockerTerminal,
				{ ancestorHasSibling: [], isLast: index === visibleProjects.length - 1 },
			))}
		</div>
	);
}

/** Renders Docker cards grouped by workspace project. */
function renderDockerProjectGroupedCards(
	projects: DockerContainerProjectGroup[],
	busyAction: DashboardBusyAction,
	actionError: DockerComposeActionError | undefined,
	expanded: ExpandedState,
	toggleExpanded: (key: string, defaultExpanded?: boolean) => void,
	onDockerAction: (containerId: string, action: DockerContainerActionKind) => void,
	onDockerComposeAction: (projectPath: string, composeFilePath: string, action: DockerComposeProjectActionKind) => void,
	onOpenDockerComposeFile: (projectPath: string, composeFilePath: string) => void,
	onOpenDockerLogs: (containerId: string) => void,
	onOpenDockerTerminal: (containerId: string) => void,
): React.ReactNode {
	return <div style={styles.dockerGroupedProjects}>{projects.map(project => {
		const declaredServices = resolveDockerDeclaredServiceRows(project);
		const hasRows = project.composeFileGroups.length > 0 || project.containers.length > 0 || declaredServices.length > 0;
		return (
			<div key={project.projectPath || project.project} style={styles.dockerProjectGroupBlock}>
				{renderDockerProjectStaticHeader(project)}
				{hasRows
					? <div style={styles.dockerCardGrid}>
						{project.composeFileGroups.map(group => renderDockerComposeFileCard(project, group, busyAction, actionError, onDockerComposeAction, onOpenDockerComposeFile))}
						{project.containers.map(container => renderDockerContainerCard(container, busyAction, expanded, toggleExpanded, onDockerAction, onOpenDockerLogs, onOpenDockerTerminal, { showComposeContext: true }))}
						{declaredServices.map(row => renderDockerDeclaredServiceCard(row, busyAction, onDockerComposeAction, onOpenDockerComposeFile))}
					</div>
					: renderDockerProjectEmpty(project)}
			</div>
		);
	})}</div>;
}

/** Renders Docker list rows grouped by workspace project. */
function renderDockerProjectGroupedList(
	projects: DockerContainerProjectGroup[],
	busyAction: DashboardBusyAction,
	actionError: DockerComposeActionError | undefined,
	expanded: ExpandedState,
	toggleExpanded: (key: string, defaultExpanded?: boolean) => void,
	onDockerAction: (containerId: string, action: DockerContainerActionKind) => void,
	onDockerComposeAction: (projectPath: string, composeFilePath: string, action: DockerComposeProjectActionKind) => void,
	onOpenDockerComposeFile: (projectPath: string, composeFilePath: string) => void,
	onOpenDockerLogs: (containerId: string) => void,
	onOpenDockerTerminal: (containerId: string) => void,
): React.ReactNode {
	return <div style={styles.dockerGroupedProjects}>{projects.map(project => {
		const standaloneContainers = resolveDockerStandaloneContainers(project);
		const hasRows = project.composeFileGroups.length > 0 || standaloneContainers.length > 0;
		return (
			<div key={project.projectPath || project.project} style={styles.dockerProjectGroupBlock}>
				{renderDockerProjectStaticHeader(project)}
				{hasRows
					? <div style={styles.dockerList}>
						{project.composeFileGroups.map(group => renderDockerComposeFileListRow(project, group, busyAction, actionError, expanded, toggleExpanded, onDockerAction, onDockerComposeAction, onOpenDockerComposeFile, onOpenDockerLogs, onOpenDockerTerminal))}
						{standaloneContainers.map(container => renderDockerContainerListRow(container, busyAction, expanded, toggleExpanded, onDockerAction, onOpenDockerLogs, onOpenDockerTerminal, { showComposeContext: true }))}
					</div>
					: renderDockerProjectEmpty(project)}
			</div>
		);
	})}</div>;
}

/** Keeps list mode rows grouped under their compose file instead of flattening project containers. */
function resolveDockerStandaloneContainers(project: DockerContainerProjectGroup): DockerContainerSummary[] {
	const groupedContainerIds = new Set(project.composeFileGroups.flatMap(group => group.containers.map(container => container.id)));
	return project.containers.filter(container => !groupedContainerIds.has(container.id));
}

/** Renders Docker rows in one flat table sorted by project, compose file and container/service. */
function renderDockerFlatTable(
	projects: DockerContainerProjectGroup[],
	busyAction: DashboardBusyAction,
	actionError: DockerComposeActionError | undefined,
	expanded: ExpandedState,
	toggleExpanded: (key: string, defaultExpanded?: boolean) => void,
	onDockerAction: (containerId: string, action: DockerContainerActionKind) => void,
	onDockerComposeAction: (projectPath: string, composeFilePath: string, action: DockerComposeProjectActionKind) => void,
	onOpenDockerComposeFile: (projectPath: string, composeFilePath: string) => void,
	onOpenDockerLogs: (containerId: string) => void,
	onOpenDockerTerminal: (containerId: string) => void,
): React.ReactNode {
	const rows = buildDockerTableRows(projects);
	return (
		<div style={styles.dockerTable}>
			<div style={{ ...styles.dockerTableRow, ...styles.dockerTableHeader }}>
				<span>Проект/Compose/Контейнер</span>
				<span style={styles.dockerTableHeaderCenteredCell}>Статус</span>
				<span style={styles.dockerTableHeaderMetricCell}>CPU</span>
				<span style={styles.dockerTableHeaderMetricCell}>RAM</span>
				<span style={styles.dockerTableHeaderActionsCell}>Действия</span>
			</div>
			{rows.map(row => renderDockerTableRow(row, busyAction, actionError, expanded, toggleExpanded, onDockerAction, onDockerComposeAction, onOpenDockerComposeFile, onOpenDockerLogs, onOpenDockerTerminal))}
		</div>
	);
}

/** Renders a non-collapsible Docker project header for grouped non-tree modes. */
function renderDockerProjectStaticHeader(project: DockerContainerProjectGroup): React.ReactNode {
	return (
		<div style={styles.dockerProjectStaticHeader}>
			<span style={styles.projectName} title={project.projectPath || project.project}>{project.project}</span>
			<span style={styles.sectionMeta}>{project.runningCount}/{project.containers.length}</span>
		</div>
	);
}

/** Renders an empty project body while keeping compose actions reachable in tree mode. */
function renderDockerProjectEmpty(project: DockerContainerProjectGroup): React.ReactNode {
	return <div style={styles.emptyText}>{project.composeFiles.length > 0 ? 'Сервисы не найдены.' : 'Compose-файлы не найдены.'}</div>;
}

/** Renders one top-level Docker project tree group. */
function renderDockerProjectGroup(
	project: DockerContainerProjectGroup,
	busyAction: DashboardBusyAction,
	actionError: DockerComposeActionError | undefined,
	expanded: ExpandedState,
	toggleExpanded: (key: string, defaultExpanded?: boolean) => void,
	onDockerAction: (containerId: string, action: DockerContainerActionKind) => void,
	onDockerComposeAction: (projectPath: string, composeFilePath: string, action: DockerComposeProjectActionKind) => void,
	onOpenDockerComposeFile: (projectPath: string, composeFilePath: string) => void,
	onOpenDockerLogs: (containerId: string) => void,
	onOpenDockerTerminal: (containerId: string) => void,
	context: DashboardFileTreeRowContext,
): React.ReactNode {
	const projectKey = buildDockerProjectExpandedKey(project);
	const isExpanded = expanded[projectKey] === true;
	const composeAncestorHasSibling = [...context.ancestorHasSibling, !context.isLast];
	return (
		<div key={project.projectPath || project.project} style={styles.dockerProjectBlock}>
			<div style={styles.dockerProjectHeader}>
				<span style={styles.fileTreeBranchPrefix}>{buildTreeBranchPrefix(context)}</span>
				<button type="button" style={styles.dockerExpandButton} onClick={() => toggleExpanded(projectKey)} title={isExpanded ? 'Свернуть проект' : 'Раскрыть проект'} aria-label={isExpanded ? 'Свернуть Docker-проект' : 'Раскрыть Docker-проект'}>{isExpanded ? '▾' : '▸'}</button>
				<span style={styles.projectName} title={project.projectPath || project.project}>{project.project}</span>
				<span style={styles.sectionMeta}>{project.runningCount}/{project.containers.length}</span>
			</div>
			{isExpanded ? project.composeFileGroups.map((group, index) => renderDockerComposeFileGroup(
				project,
				group,
				busyAction,
				actionError,
				expanded,
				toggleExpanded,
				onDockerAction,
				onDockerComposeAction,
				onOpenDockerComposeFile,
				onOpenDockerLogs,
				onOpenDockerTerminal,
				{ ancestorHasSibling: composeAncestorHasSibling, isLast: index === project.composeFileGroups.length - 1 },
			)) : null}
		</div>
	);
}

/** Renders one compose file group with file-scoped orchestration actions. */
function renderDockerComposeFileGroup(
	project: DockerContainerProjectGroup,
	group: DockerComposeFileContainerGroup,
	busyAction: DashboardBusyAction,
	actionError: DockerComposeActionError | undefined,
	expanded: ExpandedState,
	toggleExpanded: (key: string, defaultExpanded?: boolean) => void,
	onDockerAction: (containerId: string, action: DockerContainerActionKind) => void,
	onDockerComposeAction: (projectPath: string, composeFilePath: string, action: DockerComposeProjectActionKind) => void,
	onOpenDockerComposeFile: (projectPath: string, composeFilePath: string) => void,
	onOpenDockerLogs: (containerId: string) => void,
	onOpenDockerTerminal: (containerId: string) => void,
	context: DashboardFileTreeRowContext,
): React.ReactNode {
	const label = formatDockerComposeFileLabel(group.composeFile);
	const composeFileKey = buildDockerComposeFileExpandedKey(project, group.composeFile);
	const isExpanded = expanded[composeFileKey] === true;
	const declaredServices = resolveDockerDeclaredServiceRowsForGroup(project, group);
	const childRows = [
		...group.containers.map(container => ({ kind: 'container' as const, container })),
		...declaredServices.map(row => ({ kind: 'service' as const, row })),
	];
	const childAncestorHasSibling = [...context.ancestorHasSibling, !context.isLast];
	const groupActionError = resolveDockerComposeActionError(actionError, project, group);
	return (
		<div key={group.composeFile.filePath} style={styles.dockerComposeFileBlock}>
			<div style={styles.dockerComposeFileHeader}>
				<span style={styles.fileTreeBranchPrefix}>{buildTreeBranchPrefix(context)}</span>
				<button type="button" style={styles.dockerExpandButton} onClick={() => toggleExpanded(composeFileKey)} title={isExpanded ? 'Свернуть compose-файл' : 'Раскрыть compose-файл'} aria-label={isExpanded ? 'Свернуть compose-файл' : 'Раскрыть compose-файл'}>{isExpanded ? '▾' : '▸'}</button>
				<span style={styles.dockerComposeFileName} title={group.composeFile.filePath}>{label}</span>
				{renderDockerComposeStatusBadge(group)}
				<div style={styles.dockerProjectActions}>{renderDockerComposeActionButtons(project, group, busyAction, onDockerComposeAction, onOpenDockerComposeFile)}</div>
				<span style={styles.sectionMeta}>{group.runningCount}/{group.containers.length}</span>
			</div>
			{isExpanded ? <div style={styles.dockerList}>
				{groupActionError ? renderDockerComposeActionError(groupActionError) : null}
				{childRows.length > 0
					? childRows.map((row, index) => {
						const childContext = { ancestorHasSibling: childAncestorHasSibling, isLast: index === childRows.length - 1 };
						return row.kind === 'container'
							? renderDockerContainerListRow(row.container, busyAction, expanded, toggleExpanded, onDockerAction, onOpenDockerLogs, onOpenDockerTerminal, { showResourceSummary: false, includeResourcesInDetails: true, tree: true, treeContext: childContext, composeFile: group.composeFile })
							: renderDockerDeclaredServiceListRow(row.row, busyAction, onDockerComposeAction, onOpenDockerComposeFile, { tree: true, treeContext: childContext });
					})
					: renderDockerComposeDeclaredServices(group)}
			</div> : null}
		</div>
	);
}

/** Renders the aggregate lifecycle badge for one Docker Compose file. */
function renderDockerComposeStatusBadge(group: DockerComposeFileContainerGroup): React.ReactNode {
	const status = group.status || (group.runningCount > 0 ? 'running' : 'stopped');
	const tone = group.statusTone || (group.errorCount > 0 ? 'error' : group.runningCount > 0 ? 'ok' : 'neutral');
	return (
		<span style={{ ...styles.badge, ...resolveDockerBadgeStyle(tone) }} title={group.statusText || resolveDockerStatusLabel(status)}>
			{resolveDockerStatusLabel(status)}
		</span>
	);
}

/** Renders services declared in compose when Docker has no container rows for the file. */
function renderDockerComposeDeclaredServices(group: DockerComposeFileContainerGroup): React.ReactNode {
	const serviceNames = group.serviceNames || [];
	if (serviceNames.length === 0) {
		return <div style={styles.emptyText}>Сервисы не найдены.</div>;
	}
	return (
		<div style={styles.dockerComposeServiceList}>
			{serviceNames.map(serviceName => (
				<div key={serviceName} style={styles.dockerComposeServiceRow}>
					<span style={styles.dockerServiceName}>{serviceName}</span>
					<span style={{ ...styles.badge, ...styles.badgeNeutral }} title="Контейнер не создан или остановлен">остановлен</span>
				</div>
			))}
		</div>
	);
}

/** Renders a compose file as a card in non-tree card mode. */
function renderDockerComposeFileCard(
	project: DockerContainerProjectGroup,
	group: DockerComposeFileContainerGroup,
	busyAction: DashboardBusyAction,
	actionError: DockerComposeActionError | undefined,
	onDockerComposeAction: (projectPath: string, composeFilePath: string, action: DockerComposeProjectActionKind) => void,
	onOpenDockerComposeFile: (projectPath: string, composeFilePath: string) => void,
): React.ReactNode {
	const label = formatDockerComposeFileLabel(group.composeFile);
	const groupActionError = resolveDockerComposeActionError(actionError, project, group);
	return (
		<div key={`compose-card:${group.composeFile.filePath}`} style={styles.dockerCard}>
			<div style={styles.dockerComposeSummaryHeader}>
				<span style={styles.dockerNameButton} title={group.composeFile.filePath}>
					<span style={styles.dockerServiceName}>{label}</span>
					<span style={styles.dockerImageName}>{project.project} · {group.runningCount}/{group.containers.length}</span>
				</span>
				<div style={styles.dockerHeaderActions}>
					{renderDockerComposeStatusBadge(group)}
					{renderDockerComposeActionButtons(project, group, busyAction, onDockerComposeAction, onOpenDockerComposeFile)}
				</div>
			</div>
			{renderDockerComposeRuntimeSummary(group)}
			{groupActionError ? renderDockerComposeActionError(groupActionError) : null}
		</div>
	);
}

/** Renders compact runtime totals for a compose card when its containers are running. */
function renderDockerComposeRuntimeSummary(group: DockerComposeFileContainerGroup): React.ReactNode {
	const runtimeTotals = summarizeDockerComposeRuntime(group);
	if (!runtimeTotals) {
		return null;
	}
	return (
		<div style={styles.dockerComposeRuntimeMetrics}>
			<div style={styles.dockerComposeRuntimeMetricCard}>
				<span style={styles.metricLabel}>CPU</span>
				<span style={styles.dockerComposeRuntimeMetricValue}>{formatPercent(runtimeTotals.cpuPercent)}</span>
			</div>
			<div style={styles.dockerComposeRuntimeMetricCard}>
				<span style={styles.metricLabel}>RAM</span>
				<span style={styles.dockerComposeRuntimeMetricValue}>{formatDockerMemoryMegabytes(runtimeTotals.memoryUsageBytes)}</span>
			</div>
		</div>
	);
}

/** Sums running-container CPU and memory usage for one compose card summary. */
function summarizeDockerComposeRuntime(group: DockerComposeFileContainerGroup): { cpuPercent: number; memoryUsageBytes: number } | null {
	const runtimeContainers = group.containers.filter(hasDockerRuntimeStats);
	if (runtimeContainers.length === 0) {
		return null;
	}
	return {
		cpuPercent: runtimeContainers.reduce((total, container) => total + (container.stats?.cpuPercent || 0), 0),
		memoryUsageBytes: runtimeContainers.reduce((total, container) => total + (container.stats?.memoryUsageBytes || 0), 0),
	};
}

/** Renders a compose file as a row in non-tree list mode. */
function renderDockerComposeFileListRow(
	project: DockerContainerProjectGroup,
	group: DockerComposeFileContainerGroup,
	busyAction: DashboardBusyAction,
	actionError: DockerComposeActionError | undefined,
	expanded: ExpandedState,
	toggleExpanded: (key: string, defaultExpanded?: boolean) => void,
	onDockerAction: (containerId: string, action: DockerContainerActionKind) => void,
	onDockerComposeAction: (projectPath: string, composeFilePath: string, action: DockerComposeProjectActionKind) => void,
	onOpenDockerComposeFile: (projectPath: string, composeFilePath: string) => void,
	onOpenDockerLogs: (containerId: string) => void,
	onOpenDockerTerminal: (containerId: string) => void,
): React.ReactNode {
	const label = formatDockerComposeFileLabel(group.composeFile);
	const groupActionError = resolveDockerComposeActionError(actionError, project, group);
	const declaredServices = resolveDockerDeclaredServiceRowsForGroup(project, group);
	const nestedRows = [
		...group.containers.map(container => ({ kind: 'container' as const, container })),
		...declaredServices.map(row => ({ kind: 'service' as const, row })),
	];
	return (
		<div key={`compose-list:${group.composeFile.filePath}`} style={styles.dockerListComposeGroup}>
			<div style={styles.dockerListSummaryHeader}>
				<span style={styles.dockerNameButton} title={group.composeFile.filePath}>
					<span style={styles.dockerServiceName}>{label}</span>
					<span style={styles.dockerImageName}>{project.project} · {group.runningCount}/{group.containers.length}</span>
				</span>
				<div style={styles.dockerHeaderActions}>
					{renderDockerComposeStatusBadge(group)}
					{renderDockerComposeActionButtons(project, group, busyAction, onDockerComposeAction, onOpenDockerComposeFile)}
				</div>
			</div>
			{groupActionError ? renderDockerComposeActionError(groupActionError) : null}
			{nestedRows.length > 0 ? <div style={styles.dockerListNestedRows}>
				{nestedRows.map(row => row.kind === 'container'
					? renderDockerContainerListRow(row.container, busyAction, expanded, toggleExpanded, onDockerAction, onOpenDockerLogs, onOpenDockerTerminal, {
						composeFile: group.composeFile,
						listNested: true,
					})
					: renderDockerDeclaredServiceListRow(row.row, busyAction, onDockerComposeAction, onOpenDockerComposeFile, { listNested: true }))}
			</div> : null}
		</div>
	);
}

/** Renders compose lifecycle controls with one start/restart slot and one stop slot. */
function renderDockerComposeActionButtons(
	project: DockerContainerProjectGroup,
	group: DockerComposeFileContainerGroup,
	busyAction: DashboardBusyAction,
	onDockerComposeAction: (projectPath: string, composeFilePath: string, action: DockerComposeProjectActionKind) => void,
	onOpenDockerComposeFile: (projectPath: string, composeFilePath: string) => void,
): React.ReactNode {
	const disabled = !project.projectPath || !group.composeFile.filePath;
	const hasRunningContainers = group.runningCount > 0;
	const primaryAction: DockerComposeProjectActionKind = hasRunningContainers ? 'restart' : 'up';
	const label = formatDockerComposeFileLabel(group.composeFile);
	return (
		<div style={styles.dockerActionIcons}>
			{renderDockerOpenComposeFileButton(project, group, onOpenDockerComposeFile)}
			{renderDockerComposeActionButton(
				project,
				group,
				primaryAction,
				primaryAction === 'restart' ? `Перезапустить compose-файл ${label}` : `Запустить compose-файл ${label}`,
				busyAction,
				disabled,
				onDockerComposeAction,
			)}
			{renderDockerComposeActionButton(
				project,
				group,
				'down',
				`Остановить compose-файл ${label}`,
				busyAction,
				disabled || !hasRunningContainers,
				onDockerComposeAction,
			)}
		</div>
	);
}

/** Opens the compose file itself for quick editing. */
function renderDockerOpenComposeFileButton(
	project: DockerContainerProjectGroup,
	group: DockerComposeFileContainerGroup,
	onOpenDockerComposeFile: (projectPath: string, composeFilePath: string) => void,
): React.ReactNode {
	const label = formatDockerComposeFileLabel(group.composeFile);
	return renderDockerIconButton(
		'openFile',
		`Открыть compose-файл ${label}`,
		() => onOpenDockerComposeFile(project.projectPath, group.composeFile.filePath),
		!project.projectPath || !group.composeFile.filePath,
	);
}

/** Returns the compose command error that belongs to one visible compose row. */
function resolveDockerComposeActionError(
	actionError: DockerComposeActionError | undefined,
	project: DockerContainerProjectGroup,
	group: DockerComposeFileContainerGroup,
): DockerComposeActionError | undefined {
	return actionError && normalizeDashboardPath(actionError.projectPath) === normalizeDashboardPath(project.projectPath)
		&& normalizeDashboardPath(actionError.composeFilePath) === normalizeDashboardPath(group.composeFile.filePath)
		? actionError
		: undefined;
}

/** Renders one compose action button with exact button-level loading state. */
function renderDockerComposeActionButton(
	project: DockerContainerProjectGroup,
	group: DockerComposeFileContainerGroup,
	action: DockerComposeProjectActionKind,
	label: string,
	busyAction: DashboardBusyAction,
	disabled: boolean,
	onDockerComposeAction: (projectPath: string, composeFilePath: string, action: DockerComposeProjectActionKind) => void,
): React.ReactNode {
	const actionBusy = busyAction === buildPromptDashboardDockerComposeBusyAction({
		projectPath: project.projectPath,
		composeFilePath: group.composeFile.filePath,
		action,
	});
	const icon = action === 'up' ? 'composeUp' : action === 'down' ? 'composeDown' : 'restart';
	return renderDockerIconButton(
		icon,
		label,
		() => onDockerComposeAction(project.projectPath, group.composeFile.filePath, action),
		disabled || actionBusy,
		false,
		actionBusy,
	);
}

/** Renders the hidden compose command error directly under its compose file row. */
function renderDockerComposeActionError(error: DockerComposeActionError): React.ReactNode {
	return (
		<div style={styles.dockerComposeErrorBlock}>
			<div style={styles.metricLabel}>Ошибка docker compose {error.action}</div>
			<div style={styles.errorText}>{error.message}</div>
		</div>
	);
}

/** Renders one Docker container in card mode. */
function renderDockerContainerCard(
	container: DockerContainerSummary,
	busyAction: DashboardBusyAction,
	expanded: ExpandedState,
	toggleExpanded: (key: string, defaultExpanded?: boolean) => void,
	onDockerAction: (containerId: string, action: DockerContainerActionKind) => void,
	onOpenDockerLogs: (containerId: string) => void,
	onOpenDockerTerminal: (containerId: string) => void,
	options: { showComposeContext?: boolean; composeFile?: DockerComposeFileReference } = {},
): React.ReactNode {
	const expandKey = `docker:${container.id}`;
	const isExpanded = expanded[expandKey] === true;
	return (
		<div key={`${container.id}:${options.composeFile?.filePath || ''}`} style={styles.dockerCard}>
			{renderDockerContainerHeader(container, 'card', isExpanded, toggleExpanded, busyAction, onDockerAction, onOpenDockerLogs, onOpenDockerTerminal, options)}
			{renderDockerResourceSummary(container)}
			{isExpanded ? renderDockerContainerDetails(container) : null}
		</div>
	);
}

/** Renders one declared compose service as a card when no Docker container exists yet. */
function renderDockerDeclaredServiceCard(
	row: DockerDeclaredServiceViewRow,
	busyAction: DashboardBusyAction,
	onDockerComposeAction: (projectPath: string, composeFilePath: string, action: DockerComposeProjectActionKind) => void,
	onOpenDockerComposeFile: (projectPath: string, composeFilePath: string) => void,
): React.ReactNode {
	return (
		<div key={row.key} style={styles.dockerCard}>
			{renderDockerDeclaredServiceHeader(row, busyAction, onDockerComposeAction, onOpenDockerComposeFile)}
		</div>
	);
}

/** Renders one Docker container in list or project tree mode. */
function renderDockerContainerListRow(
	container: DockerContainerSummary,
	busyAction: DashboardBusyAction,
	expanded: ExpandedState,
	toggleExpanded: (key: string, defaultExpanded?: boolean) => void,
	onDockerAction: (containerId: string, action: DockerContainerActionKind) => void,
	onOpenDockerLogs: (containerId: string) => void,
	onOpenDockerTerminal: (containerId: string) => void,
	options: {
		showResourceSummary?: boolean;
		includeResourcesInDetails?: boolean;
		tree?: boolean;
		treeContext?: DashboardFileTreeRowContext;
		listNested?: boolean;
		showComposeContext?: boolean;
		composeFile?: DockerComposeFileReference;
	} = {},
): React.ReactNode {
	const expandKey = `docker:${container.id}`;
	const isExpanded = expanded[expandKey] === true;
	const showResourceSummary = options.showResourceSummary !== false;
	const rowStyle = options.tree
		? { ...styles.dockerListRow, ...styles.dockerTreeContainerRow }
		: options.listNested
			? { ...styles.dockerListRow, ...styles.dockerNestedListRow }
			: styles.dockerListRow;
	return (
		<div key={`${container.id}:${options.composeFile?.filePath || ''}`} style={rowStyle}>
			{renderDockerContainerHeader(container, options.tree ? 'tree' : 'list', isExpanded, toggleExpanded, busyAction, onDockerAction, onOpenDockerLogs, onOpenDockerTerminal, options)}
			{showResourceSummary ? renderDockerResourceSummary(container) : null}
			{isExpanded ? renderDockerContainerDetails(container, { includeResources: options.includeResourcesInDetails === true }) : null}
		</div>
	);
}

/** Renders one declared compose service in list or tree mode. */
function renderDockerDeclaredServiceListRow(
	row: DockerDeclaredServiceViewRow,
	busyAction: DashboardBusyAction,
	onDockerComposeAction: (projectPath: string, composeFilePath: string, action: DockerComposeProjectActionKind) => void,
	onOpenDockerComposeFile: (projectPath: string, composeFilePath: string) => void,
	options: { tree?: boolean; treeContext?: DashboardFileTreeRowContext; listNested?: boolean } = {},
): React.ReactNode {
	const rowStyle = options.tree
		? { ...styles.dockerListRow, ...styles.dockerTreeContainerRow }
		: options.listNested
			? { ...styles.dockerListRow, ...styles.dockerNestedListRow }
			: styles.dockerListRow;
	return (
		<div key={row.key} style={rowStyle}>
			{renderDockerDeclaredServiceHeader(row, busyAction, onDockerComposeAction, onOpenDockerComposeFile, options.treeContext)}
		</div>
	);
}

/** Renders one row in the flat Docker table. */
function renderDockerTableRow(
	row: DockerTableViewRow,
	busyAction: DashboardBusyAction,
	actionError: DockerComposeActionError | undefined,
	expanded: ExpandedState,
	toggleExpanded: (key: string, defaultExpanded?: boolean) => void,
	onDockerAction: (containerId: string, action: DockerContainerActionKind) => void,
	onDockerComposeAction: (projectPath: string, composeFilePath: string, action: DockerComposeProjectActionKind) => void,
	onOpenDockerComposeFile: (projectPath: string, composeFilePath: string) => void,
	onOpenDockerLogs: (containerId: string) => void,
	onOpenDockerTerminal: (containerId: string) => void,
): React.ReactNode {
	if (row.kind === 'compose') {
		const groupActionError = resolveDockerComposeActionError(actionError, row.project, row.group);
		return (
			<div key={row.key} style={styles.dockerTableBlock}>
				<div style={styles.dockerTableRow}>
					{renderDockerProjectComposeCell(row.label, formatDockerComposeFileLabel(row.group.composeFile))}
					{renderDockerStatusIcon(row.group.status || (row.group.runningCount > 0 ? 'running' : 'stopped'), row.group.statusTone || (row.group.runningCount > 0 ? 'ok' : 'neutral'), row.group.statusText)}
					{renderDockerTableMetricCell('—')}
					{renderDockerTableMetricCell('—')}
					<div style={styles.dockerTableActions}>{renderDockerComposeActionButtons(row.project, row.group, busyAction, onDockerComposeAction, onOpenDockerComposeFile)}</div>
				</div>
				{groupActionError ? renderDockerComposeActionError(groupActionError) : null}
			</div>
		);
	}
	if (row.kind === 'service') {
		return (
			<div key={row.key} style={styles.dockerTableBlock}>
				<div style={styles.dockerTableRow}>
					{renderDockerProjectComposeCell(row.label, row.row.serviceName)}
					{renderDockerStatusIcon('stopped', 'neutral', 'Контейнер не создан или остановлен')}
					{renderDockerTableMetricCell('—')}
					{renderDockerTableMetricCell('—')}
					<div style={styles.dockerTableActions}>{renderDockerDeclaredServiceActionButtons(row.row, busyAction, onDockerComposeAction, onOpenDockerComposeFile)}</div>
				</div>
			</div>
		);
	}

	const container = row.container;
	const expandKey = `docker:${container.id}`;
	const isExpanded = expanded[expandKey] === true;
	return (
		<div key={row.key} style={styles.dockerTableBlock}>
			<div style={styles.dockerTableRow}>
				{renderDockerProjectComposeCell(row.label, resolveDockerContainerDisplayName(container))}
				{renderDockerStatusIcon(container.status, container.statusTone, container.statusText)}
				{renderDockerTableMetricCell(formatDockerTableMetric(container, container.stats?.cpuPercent))}
				{renderDockerTableMetricCell(hasDockerRuntimeStats(container) ? formatDockerMemoryMegabytes(container.stats?.memoryUsageBytes) : '—')}
				<div style={styles.dockerTableActions}>
					<button type="button" style={styles.dockerIconButton} onClick={() => toggleExpanded(expandKey)} title={isExpanded ? 'Скрыть детали' : 'Показать детали'} aria-label={isExpanded ? 'Скрыть детали контейнера' : 'Показать детали контейнера'}>{isExpanded ? '▾' : '▸'}</button>
					{renderDockerContainerActionButtons(container, busyAction, onDockerAction, onOpenDockerLogs, onOpenDockerTerminal)}
				</div>
			</div>
			{isExpanded ? <div style={styles.dockerTableDetails}>{renderDockerContainerDetails(container)}</div> : null}
		</div>
	);
}

/** Keeps numeric Docker table values aligned even when the row has missing stats. */
function renderDockerTableMetricCell(value: string): React.ReactNode {
	return <span style={styles.dockerTableMetricCell}>{value}</span>;
}

/** Renders the shared Docker container title row and status badge. */
function renderDockerContainerHeader(
	container: DockerContainerSummary,
	variant: 'card' | 'list' | 'tree',
	isExpanded: boolean,
	toggleExpanded: (key: string, defaultExpanded?: boolean) => void,
	busyAction: DashboardBusyAction,
	onDockerAction: (containerId: string, action: DockerContainerActionKind) => void,
	onOpenDockerLogs: (containerId: string) => void,
	onOpenDockerTerminal: (containerId: string) => void,
	options: { showComposeContext?: boolean; composeFile?: DockerComposeFileReference; treeContext?: DashboardFileTreeRowContext } = {},
): React.ReactNode {
	const expandKey = `docker:${container.id}`;
	const secondaryLabel = formatDockerContainerSecondaryLabel(container, options.composeFile, options.showComposeContext === true);
	const displayName = resolveDockerContainerDisplayName(container);
	const expandButtonStyle = variant === 'tree'
		? { ...styles.dockerExpandButton, ...styles.dockerTreeExpandButton }
		: styles.dockerExpandButton;
	const headerActionsStyle = {
		...styles.dockerHeaderActions,
		...(variant === 'card' ? styles.dockerCardHeaderActions : null),
		...(variant === 'tree' ? styles.dockerTreeHeaderActions : null),
	};
	const statusIndicator = variant === 'tree'
		? renderDockerLifecycleIndicator(container.status, container.statusTone, container.statusText)
		: renderDockerStatusBadge(container);
	return (
		<div style={variant === 'card' ? styles.dockerCardHeader : variant === 'tree' ? styles.dockerTreeListHeader : styles.dockerListHeader}>
			{options.treeContext ? <span style={styles.fileTreeBranchPrefix}>{buildTreeBranchPrefix(options.treeContext)}</span> : null}
			<button type="button" style={expandButtonStyle} onClick={() => toggleExpanded(expandKey)} title={isExpanded ? 'Скрыть детали' : 'Показать детали'} aria-label={isExpanded ? 'Скрыть детали контейнера' : 'Показать детали контейнера'}>{isExpanded ? '▾' : '▸'}</button>
			<button type="button" style={styles.dockerNameButton} onClick={() => onOpenDockerLogs(container.id)} title={`${displayName}\n${container.image}`}>
				<span style={styles.dockerServiceName}>{displayName}</span>
				{secondaryLabel ? <span style={styles.dockerImageName}>{secondaryLabel}</span> : null}
			</button>
			<div style={headerActionsStyle}>
				{statusIndicator}
				{renderDockerContainerActionButtons(container, busyAction, onDockerAction, onOpenDockerLogs, onOpenDockerTerminal)}
			</div>
		</div>
	);
}

/** Renders the title row for a declared compose service without a Docker container row. */
function renderDockerDeclaredServiceHeader(
	row: DockerDeclaredServiceViewRow,
	busyAction: DashboardBusyAction,
	onDockerComposeAction: (projectPath: string, composeFilePath: string, action: DockerComposeProjectActionKind) => void,
	onOpenDockerComposeFile: (projectPath: string, composeFilePath: string) => void,
	treeContext?: DashboardFileTreeRowContext,
): React.ReactNode {
	const statusIndicator = treeContext
		? renderDockerLifecycleIndicator('stopped', 'neutral', 'Контейнер не создан или остановлен')
		: <span style={{ ...styles.badge, ...styles.badgeNeutral }} title="Контейнер не создан или остановлен">остановлен</span>;
	const headerActionsStyle = treeContext
		? { ...styles.dockerHeaderActions, ...styles.dockerTreeHeaderActions }
		: styles.dockerHeaderActions;
	return (
		<div style={treeContext ? styles.dockerTreeDeclaredServiceHeader : styles.dockerListDeclaredServiceHeader}>
			{treeContext ? <span style={styles.fileTreeBranchPrefix}>{buildTreeBranchPrefix(treeContext)}</span> : null}
			{treeContext ? <span style={{ ...styles.dockerExpandPlaceholder, ...styles.dockerTreeExpandPlaceholder }} aria-hidden="true" /> : null}
			<span style={styles.dockerNameButton} title={`${row.serviceName}\n${row.group.composeFile.filePath}`}>
				<span style={styles.dockerServiceName}>{row.serviceName}</span>
				<span style={styles.dockerImageName}>{formatDockerProjectComposeLabel(row.project, row.group.composeFile)}</span>
			</span>
			<div style={headerActionsStyle}>
				{statusIndicator}
				{renderDockerDeclaredServiceActionButtons(row, busyAction, onDockerComposeAction, onOpenDockerComposeFile)}
			</div>
		</div>
	);
}

/** Renders actions available for a declared service before Docker creates its container. */
function renderDockerDeclaredServiceActionButtons(
	row: DockerDeclaredServiceViewRow,
	busyAction: DashboardBusyAction,
	onDockerComposeAction: (projectPath: string, composeFilePath: string, action: DockerComposeProjectActionKind) => void,
	onOpenDockerComposeFile: (projectPath: string, composeFilePath: string) => void,
): React.ReactNode {
	return renderDockerComposeActionButtons(row.project, row.group, busyAction, onDockerComposeAction, onOpenDockerComposeFile);
}

/** Renders a compact project/compose/container table cell with a compose icon. */
function renderDockerProjectComposeCell(label: string, primaryLabel?: string): React.ReactNode {
	return (
		<span style={styles.dockerProjectComposeCell} title={label}>
			<DockerContainerActionIcon icon="composeFile" />
			<span style={styles.dockerProjectComposeLabelBlock}>
				<span style={styles.dockerServiceName}>{primaryLabel || label}</span>
				<span style={styles.dockerProjectComposeLabel}>{label}</span>
			</span>
		</span>
	);
}

/** Renders a lifecycle badge with Docker's raw status in the tooltip. */
function renderDockerStatusBadge(container: DockerContainerSummary): React.ReactNode {
	return (
		<span style={{ ...styles.badge, ...resolveDockerBadgeStyle(container.statusTone) }} title={container.statusText}>
			{resolveDockerStatusLabel(container.status)}
		</span>
	);
}

/** Renders Docker lifecycle as a compact icon for the dense table status column. */
function renderDockerStatusIcon(
	status: DockerContainerLifecycleStatus,
	tone: DockerContainerStatusTone,
	statusText: string | undefined,
): React.ReactNode {
	return renderDockerLifecycleIndicator(status, tone, statusText, { compact: true });
}

/** Renders an outlined lifecycle indicator for dense tree and table rows. */
function renderDockerLifecycleIndicator(
	status: DockerContainerLifecycleStatus,
	tone: DockerContainerStatusTone,
	statusText: string | undefined,
	options: { compact?: boolean } = {},
): React.ReactNode {
	const label = statusText || resolveDockerStatusLabel(status);
	const color = resolveDockerToneColor(tone);
	const icon = resolveDockerLifecycleIndicatorIcon(status);
	return (
		<span
			style={{
				...styles.dockerStatusIcon,
				...(options.compact ? styles.dockerStatusIconCompact : null),
				color,
				borderColor: color,
			}}
			title={label}
			aria-label={label}
		>
			{icon === 'pause'
				? <span style={styles.dockerStatusPauseGlyph}>Ⅱ</span>
				: <DockerContainerActionIcon icon={icon} />}
		</span>
	);
}

/** Maps Docker lifecycle states to the outlined indicator glyphs. */
function resolveDockerLifecycleIndicatorIcon(status: DockerContainerLifecycleStatus): 'start' | 'stop' | 'restart' | 'pause' {
	if (status === 'running' || status === 'starting') {
		return 'start';
	}
	if (status === 'restarting') {
		return 'restart';
	}
	if (status === 'paused') {
		return 'pause';
	}
	return 'stop';
}

/** Renders CPU, memory and network usage for one container. */
function renderDockerResourceSummary(container: DockerContainerSummary): React.ReactNode {
	if (!hasDockerRuntimeStats(container)) {
		return null;
	}
	const cpu = container.stats?.cpuPercent || 0;
	const memoryPercent = container.stats?.memoryPercent || 0;
	const memoryUsageBytes = container.stats?.memoryUsageBytes || 0;
	const rxRate = container.stats?.networkRxRateBytesPerSecond || 0;
	const txRate = container.stats?.networkTxRateBytesPerSecond || 0;
	return (
		<div style={styles.dockerResourceBlock}>
			{renderDockerMetricBar('CPU', cpu, formatPercent(cpu), 'var(--vscode-charts-blue, var(--vscode-textLink-foreground))')}
			{renderDockerMetricBar('RAM', memoryPercent, formatDockerMemoryMegabytes(memoryUsageBytes), 'var(--vscode-charts-green)')}
			<div style={styles.dockerNetworkRow}>
				<span style={styles.metricLabel}>СЕТЬ</span>
				<span style={styles.statValue}>{formatByteRate(rxRate)} ↓</span>
				<span style={styles.statValue}>{formatByteRate(txRate)} ↑</span>
			</div>
			{renderDockerSparkline(container.samples)}
		</div>
	);
}

/** Returns true when runtime resource stats should be visible for a container. */
function hasDockerRuntimeStats(container: DockerContainerSummary): boolean {
	return container.status === 'running' && Boolean(container.stats);
}

/** Formats table metrics with a dash for stopped containers instead of fake zeroes. */
function formatDockerTableMetric(container: DockerContainerSummary, value: number | undefined): string {
	return hasDockerRuntimeStats(container) ? formatPercent(value) : '—';
}

/** Formats Docker memory usage in MiB or GiB for compact dashboard labels. */
function formatDockerMemoryMegabytes(valueBytes: number | undefined): string {
	const valueMiB = Math.max(0, valueBytes || 0) / (1024 * 1024);
	if (valueMiB <= 0) {
		return '0 МБ';
	}
	if (valueMiB > 1000) {
		return `${(valueMiB / 1000).toFixed(2)} ГБ`;
	}
	if (valueMiB < 10) {
		return `${Math.round(valueMiB * 10) / 10} МБ`;
	}
	return `${Math.round(valueMiB)} МБ`;
}

/** Keeps the Docker resource chart aligned to the last five minutes of stats. */
const DOCKER_SPARKLINE_WINDOW_MS = 5 * 60 * 1000;

/** Caps visible chart points so expanded Docker cards stay cheap to render. */
const DOCKER_SPARKLINE_MAX_POINTS = 60;

/** Reserves a small top gutter for the chart time-range label. */
const DOCKER_SPARKLINE_TOP_PADDING = 12;

/** Leaves a tiny bottom gutter so flat lines do not blend into the border. */
const DOCKER_SPARKLINE_BOTTOM_PADDING = 3;

/** Prevents tiny CPU values from collapsing into an invisible flat line. */
const MIN_DOCKER_SPARKLINE_CPU_PERCENT = 1;

/** Prevents tiny memory values from collapsing into an invisible flat line. */
const MIN_DOCKER_SPARKLINE_MEMORY_BYTES = 64 * 1024 * 1024;

/** Prevents tiny network rates from collapsing into an invisible flat line. */
const MIN_DOCKER_SPARKLINE_NETWORK_BYTES_PER_SECOND = 1024;

/** Normalized chart sample used only for the compact Docker resource history graph. */
interface DockerSparklineSamplePoint {
	readAtMs: number;
	cpuPercent: number;
	memoryUsageBytes: number;
	networkRateBytesPerSecond: number;
}

/** Renders one percentage metric bar. */
function renderDockerMetricBar(label: string, value: number, displayValue: string, color: string): React.ReactNode {
	const percent = Math.max(0, Math.min(100, value));
	return (
		<div style={styles.metricRow}>
			<span style={styles.metricLabel}>{label}</span>
			<span style={styles.dockerMetricTrack}><span style={{ ...styles.dockerMetricFill, width: `${percent}%`, background: color }} /></span>
			<span style={styles.metricValue}>{displayValue}</span>
		</div>
	);
}

/** Renders a lightweight CPU/RAM sparkline from recent resource samples. */
function renderDockerSparkline(samples: DockerContainerResourceSample[]): React.ReactNode {
	const visibleSamples = buildDockerSparklineVisibleSamples(samples);
	if (visibleSamples.length < 2) {
		return <div style={styles.metricNote}>Недостаточно замеров</div>;
	}
	const width = 148;
	const height = 40;
	const cpuSegments = buildDockerSparklinePolylines(
		visibleSamples,
		width,
		height,
		sample => sample.cpuPercent,
		resolveDockerSparklineMax(visibleSamples, sample => sample.cpuPercent, MIN_DOCKER_SPARKLINE_CPU_PERCENT),
	);
	const memorySegments = buildDockerSparklinePolylines(
		visibleSamples,
		width,
		height,
		sample => sample.memoryUsageBytes,
		resolveDockerSparklineMax(visibleSamples, sample => sample.memoryUsageBytes, MIN_DOCKER_SPARKLINE_MEMORY_BYTES),
	);
	const networkSegments = buildDockerSparklinePolylines(
		visibleSamples,
		width,
		height,
		sample => sample.networkRateBytesPerSecond,
		resolveDockerSparklineMax(visibleSamples, sample => sample.networkRateBytesPerSecond, MIN_DOCKER_SPARKLINE_NETWORK_BYTES_PER_SECOND),
	);
	if (cpuSegments.length === 0 && memorySegments.length === 0 && networkSegments.length === 0) {
		return <div style={styles.metricNote}>Недостаточно замеров</div>;
	}
	const drawableHeight = height - DOCKER_SPARKLINE_TOP_PADDING - DOCKER_SPARKLINE_BOTTOM_PADDING;
	const gridLineYs = [0, 0.5, 1].map(ratio => DOCKER_SPARKLINE_TOP_PADDING + Math.round(drawableHeight * ratio));
	return (
		<svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={styles.dockerSparkline} aria-hidden="true" focusable="false">
			{gridLineYs.map(y => <line key={y} x1="0" y1={y} x2={width} y2={y} stroke="var(--vscode-panel-border)" opacity="0.24" vectorEffect="non-scaling-stroke" />)}
			<text x={width - 4} y="9" textAnchor="end" fill="var(--vscode-descriptionForeground)" fontSize="8">5 мин</text>
			{memorySegments.map((points, index) => (
				<polyline key={`memory:${index}:${points}`} points={points} fill="none" stroke="var(--vscode-charts-green)" strokeWidth="1.4" opacity="0.84" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
			))}
			{cpuSegments.map((points, index) => (
				<polyline key={`cpu:${index}:${points}`} points={points} fill="none" stroke="var(--vscode-charts-blue, var(--vscode-textLink-foreground))" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
			))}
			{networkSegments.map((points, index) => (
				<polyline key={`network:${index}:${points}`} points={points} fill="none" stroke="#f97316" strokeWidth="1.55" opacity="1" strokeDasharray="3 2.25" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
			))}
		</svg>
	);
}

/** Returns a five-minute sample window and averages it down to a cheap render budget. */
export function buildDockerSparklineVisibleSamples(samples: DockerContainerResourceSample[]): DockerSparklineSamplePoint[] {
	const normalizedSamples = samples
		.map(sample => {
			const readAtMs = Date.parse(sample.readAt);
			if (!Number.isFinite(readAtMs)) {
				return null;
			}
			return {
				readAtMs,
				cpuPercent: sample.cpuPercent,
				memoryUsageBytes: sample.memoryUsageBytes,
				networkRateBytesPerSecond: sample.networkRxRateBytesPerSecond + sample.networkTxRateBytesPerSecond,
			};
		})
		.filter((sample): sample is DockerSparklineSamplePoint => Boolean(sample))
		.sort((left, right) => left.readAtMs - right.readAtMs);
	if (normalizedSamples.length === 0) {
		return [];
	}
	const latestReadAtMs = normalizedSamples[normalizedSamples.length - 1].readAtMs;
	const windowStartMs = latestReadAtMs - DOCKER_SPARKLINE_WINDOW_MS;
	const windowSamples = normalizedSamples.filter(sample => sample.readAtMs >= windowStartMs);
	if (windowSamples.length <= DOCKER_SPARKLINE_MAX_POINTS) {
		return windowSamples;
	}
	const bucketSizeMs = Math.max(1000, Math.ceil(DOCKER_SPARKLINE_WINDOW_MS / DOCKER_SPARKLINE_MAX_POINTS));
	const buckets = new Map<number, {
		bucketStartMs: number;
		cpuPercentTotal: number;
		memoryUsageBytesTotal: number;
		networkRateTotal: number;
		count: number;
	}>();
	windowSamples.forEach(sample => {
		const bucketStartMs = Math.floor(sample.readAtMs / bucketSizeMs) * bucketSizeMs;
		const bucket = buckets.get(bucketStartMs);
		if (bucket) {
			bucket.cpuPercentTotal += sample.cpuPercent;
			bucket.memoryUsageBytesTotal += sample.memoryUsageBytes;
			bucket.networkRateTotal += sample.networkRateBytesPerSecond;
			bucket.count += 1;
			return;
		}
		buckets.set(bucketStartMs, {
			bucketStartMs,
			cpuPercentTotal: sample.cpuPercent,
			memoryUsageBytesTotal: sample.memoryUsageBytes,
			networkRateTotal: sample.networkRateBytesPerSecond,
			count: 1,
		});
	});
	return Array.from(buckets.entries())
		.sort((left, right) => left[0] - right[0])
		.map(([, bucket]) => ({
			readAtMs: Math.max(windowStartMs, bucket.bucketStartMs + (bucketSizeMs / 2)),
			cpuPercent: bucket.cpuPercentTotal / bucket.count,
			memoryUsageBytes: bucket.memoryUsageBytesTotal / bucket.count,
			networkRateBytesPerSecond: bucket.networkRateTotal / bucket.count,
		}));
}

/** Resolves a stable domain maximum so low-activity charts stay visible. */
function resolveDockerSparklineMax(
	samples: DockerSparklineSamplePoint[],
	getValue: (sample: DockerSparklineSamplePoint) => number,
	minimumValue: number,
): number {
	const peakValue = samples.reduce((maxValue, sample) => Math.max(maxValue, getValue(sample)), 0);
	if (peakValue <= 0) {
		return minimumValue;
	}
	return Math.max(minimumValue, peakValue * 1.12);
}

/** Splits sparse Docker chart series into time-aligned SVG polylines without bridging long sampling gaps. */
function buildDockerSparklinePolylines(
	samples: DockerSparklineSamplePoint[],
	width: number,
	height: number,
	getValue: (sample: DockerSparklineSamplePoint) => number,
	maxValue: number,
): string[] {
	const drawableHeight = height - DOCKER_SPARKLINE_TOP_PADDING - DOCKER_SPARKLINE_BOTTOM_PADDING;
	const latestReadAtMs = samples[samples.length - 1]?.readAtMs || 0;
	const windowStartMs = latestReadAtMs - DOCKER_SPARKLINE_WINDOW_MS;
	const windowDurationMs = Math.max(1, latestReadAtMs - windowStartMs);
	const gapThresholdMs = resolveDockerSparklineGapThreshold(samples);
	const segments: string[] = [];
	let currentPoints: string[] = [];
	const flushSegment = () => {
		if (currentPoints.length > 1) {
			segments.push(currentPoints.join(' '));
		}
		currentPoints = [];
	};

	samples.forEach((sample, index) => {
		if (index > 0 && (sample.readAtMs - samples[index - 1].readAtMs) > gapThresholdMs) {
			flushSegment();
		}
		const ratio = maxValue > 0 ? Math.max(0, Math.min(1, getValue(sample) / maxValue)) : 0;
		const xRatio = Math.max(0, Math.min(1, (sample.readAtMs - windowStartMs) / windowDurationMs));
		const x = xRatio * width;
		const y = DOCKER_SPARKLINE_TOP_PADDING + (drawableHeight - (ratio * drawableHeight));
		currentPoints.push(`${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`);
	});
	flushSegment();
	return segments;
}

/** Break one sparkline when the sampling gap is much larger than the recent steady cadence. */
function resolveDockerSparklineGapThreshold(samples: DockerSparklineSamplePoint[]): number {
	if (samples.length < 2) {
		return Number.POSITIVE_INFINITY;
	}
	const gaps = samples
		.slice(1)
		.map((sample, index) => Math.max(0, sample.readAtMs - samples[index].readAtMs))
		.filter(gap => gap > 0)
		.sort((left, right) => left - right);
	if (gaps.length === 0) {
		return Number.POSITIVE_INFINITY;
	}
	const medianGapMs = gaps[Math.floor(gaps.length / 2)] || 0;
	return Math.max(15000, medianGapMs * 3);
}

/** Renders compact icon-only container commands inside the container title row. */
function renderDockerContainerActionButtons(
	container: DockerContainerSummary,
	busyAction: DashboardBusyAction,
	onDockerAction: (containerId: string, action: DockerContainerActionKind) => void,
	onOpenDockerLogs: (containerId: string) => void,
	onOpenDockerTerminal: (containerId: string) => void,
): React.ReactNode {
	const running = container.status === 'running';
	const stopped = container.status === 'stopped';
	const primaryAction: DockerContainerActionKind = running ? 'restart' : 'start';
	const primaryBusy = busyAction === buildPromptDashboardDockerContainerBusyAction({ containerId: container.id, action: primaryAction });
	const stopBusy = busyAction === buildPromptDashboardDockerContainerBusyAction({ containerId: container.id, action: 'stop' });
	const removeBusy = busyAction === buildPromptDashboardDockerContainerBusyAction({ containerId: container.id, action: 'remove' });
	return (
		<div style={styles.dockerActionIcons}>
			{renderDockerIconButton('logs', 'Открыть логи контейнера', () => onOpenDockerLogs(container.id))}
			{renderDockerIconButton('terminal', 'Открыть терминал в контейнере', () => onOpenDockerTerminal(container.id), !running)}
			{running
				? renderDockerIconButton('restart', 'Перезапустить контейнер', () => onDockerAction(container.id, 'restart'), primaryBusy, false, primaryBusy)
				: renderDockerIconButton('start', 'Запустить контейнер', () => onDockerAction(container.id, 'start'), !stopped || primaryBusy, false, primaryBusy)}
			{renderDockerIconButton('stop', 'Остановить контейнер', () => onDockerAction(container.id, 'stop'), !running || stopBusy, false, stopBusy)}
			{renderDockerIconButton('remove', 'Удалить остановленный контейнер', () => onDockerAction(container.id, 'remove'), !stopped || removeBusy, true, removeBusy)}
		</div>
	);
}

/** Renders one Docker icon button with an accessible label. */
function renderDockerIconButton(
	icon: DockerContainerIconKind,
	label: string,
	onClick: () => void,
	disabled = false,
	danger = false,
	loading = false,
): React.ReactNode {
	return (
		<button
			type="button"
			style={{
				...styles.dockerIconButton,
				...(danger ? styles.dockerIconButtonDanger : null),
				...(disabled ? styles.dockerIconButtonDisabled : null),
			}}
			onClick={onClick}
			title={label}
			aria-label={label}
			disabled={disabled || loading}
		>
			{loading ? <span style={styles.buttonSpinner} aria-hidden="true" /> : <DockerContainerActionIcon icon={icon} />}
		</button>
	);
}

/** Renders Docker action glyphs as compact inline SVG icons. */
function DockerContainerActionIcon({ icon }: { icon: DockerContainerIconKind }): React.ReactNode {
	const common = {
		fill: 'none',
		stroke: 'currentColor',
		strokeWidth: 1.55,
		strokeLinecap: 'round' as const,
		strokeLinejoin: 'round' as const,
	};
	if (icon === 'logs') {
		return <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={styles.dockerActionIcon}><path d="M4 2.75h6.2L12 4.55v8.7H4z" {...common} /><path d="M10.1 2.9v2h1.9M6 7h4M6 9.5h4M6 12h2.5" {...common} /></svg>;
	}
	if (icon === 'terminal') {
		return <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={styles.dockerActionIcon}><path d="M2.75 4.25h10.5v7.5H2.75z" {...common} /><path d="M5 6.5l1.7 1.5L5 9.5M8 9.6h3" {...common} /></svg>;
	}
	if (icon === 'restart') {
		return <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={styles.dockerActionIcon}><path d="M12.5 7.2A4.5 4.5 0 1 0 8 12.5c1.7 0 3.17-.95 3.93-2.35" {...common} /><path d="M9.7 2.8h2.95v2.95" {...common} /></svg>;
	}
	if (icon === 'start' || icon === 'composeUp') {
		return <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={styles.dockerActionIcon}><path d="M5.25 3.75v8.5l7-4.25z" fill="currentColor" stroke="none" /></svg>;
	}
	if (icon === 'composeDown') {
		return <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={styles.dockerActionIcon}><rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1" fill="currentColor" stroke="none" /></svg>;
	}
	if (icon === 'composeFile') {
		return <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={styles.dockerActionIcon}><path d="M3.5 3.25h3.25l1 1.35h4.75v8.15h-9z" {...common} /><path d="M5.4 7h5.2M5.4 9.25h5.2" {...common} /></svg>;
	}
	if (icon === 'openFile') {
		return <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={styles.dockerActionIcon}><path d="M3.75 3.25h5.1l2.4 2.4v7.1h-7.5z" {...common} /><path d="M8.75 3.4v2.4h2.35M6 9.65l3.6-3.6M7.2 6.05h2.4v2.4" {...common} /></svg>;
	}
	if (icon === 'stop') {
		return <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={styles.dockerActionIcon}><rect x="4.5" y="4.5" width="7" height="7" rx="1" {...common} /></svg>;
	}
	return <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={styles.dockerActionIcon}><path d="M5.25 5.6v6.65h5.5V5.6M4.2 5.6h7.6M6.4 5.5V3.75h3.2V5.5M7 7.4v2.95M9 7.4v2.95" {...common} /></svg>;
}

/** Renders Docker inspect details that are useful without opening another view. */
function renderDockerContainerDetails(
	container: DockerContainerSummary,
	options: { includeResources?: boolean } = {},
): React.ReactNode {
	return (
		<div style={styles.dockerDetails}>
			{options.includeResources ? renderDockerResourceSummary(container) : null}
			<div style={styles.metaGrid}>
				{renderDockerMeta('ID', container.shortId)}
				{renderDockerMeta('Время', container.uptimeMs > 0 ? formatPromptDashboardDuration(container.uptimeMs) : 'нет')}
				{renderDockerMeta('Порты', container.ports.map(port => port.label).join(', ') || 'нет')}
				{renderDockerMeta('Compose', container.composeFilePaths.map(filePath => filePath.split('/').pop() || filePath).join(', ') || 'нет')}
			</div>
			{container.mounts.length > 0 ? <div style={styles.dockerDetailsLine}>Тома: {container.mounts.slice(0, 3).map(mount => `${mount.source || mount.type} -> ${mount.destination}`).join('; ')}</div> : null}
			{container.error ? <div style={styles.errorText}>{container.error}</div> : null}
		</div>
	);
}

/** Renders one small metadata label/value pair. */
function renderDockerMeta(label: string, value: string): React.ReactNode {
	return (
		<div>
			<div style={styles.metricLabel}>{label}</div>
			<span style={styles.metaValue} title={value}>{value}</span>
		</div>
	);
}

/** Resolves declared compose services that do not have a visible Docker container row. */
function resolveDockerDeclaredServiceRows(project: DockerContainerProjectGroup): DockerDeclaredServiceViewRow[] {
	return (project.composeFileGroups || []).flatMap(group => resolveDockerDeclaredServiceRowsForGroup(project, group));
}

/** Resolves missing declared services for one compose file group. */
function resolveDockerDeclaredServiceRowsForGroup(
	project: DockerContainerProjectGroup,
	group: DockerComposeFileContainerGroup,
): DockerDeclaredServiceViewRow[] {
	const visibleServices = new Set(group.containers.flatMap(container => [container.service, container.name].map(value => value.trim()).filter(Boolean)));
	return (group.serviceNames || [])
		.map(serviceName => serviceName.trim())
		.filter(Boolean)
		.filter(serviceName => !visibleServices.has(serviceName))
		.sort((left, right) => left.localeCompare(right, 'ru'))
		.map(serviceName => ({
			key: `declared:${group.composeFile.filePath}:${serviceName}`,
			project,
			group,
			serviceName,
		}));
}

/** Builds flat table rows sorted by project, compose file and container/service label. */
export function buildDockerTableRows(projects: DockerContainerProjectGroup[]): DockerTableViewRow[] {
	const rows: DockerTableViewRow[] = [];
	for (const project of projects) {
		const groupedContainerIds = new Set<string>();
		for (const group of project.composeFileGroups || []) {
			const composeLabel = formatDockerProjectComposeLabel(project, group.composeFile);
			const declaredServices = resolveDockerDeclaredServiceRowsForGroup(project, group);
			for (const container of group.containers) {
				groupedContainerIds.add(container.id);
				const containerName = resolveDockerContainerDisplayName(container);
				rows.push({
					kind: 'container',
					key: `container:${group.composeFile.filePath}:${container.id}`,
					project,
					group,
					container,
					label: `${composeLabel}/${containerName}`,
				});
			}
			for (const service of declaredServices) {
				rows.push({
					kind: 'service',
					key: service.key,
					row: service,
					label: `${composeLabel}/${service.serviceName}`,
				});
			}
			if (group.containers.length === 0 && declaredServices.length === 0) {
				rows.push({
					kind: 'compose',
					key: `compose:${project.projectPath}:${group.composeFile.filePath}`,
					project,
					group,
					label: composeLabel,
				});
			}
		}
		for (const container of project.containers.filter(container => !groupedContainerIds.has(container.id))) {
			const containerName = resolveDockerContainerDisplayName(container);
			rows.push({
				kind: 'container',
				key: `container:${project.projectPath}:${container.id}`,
				project,
				container,
				label: `${project.project}/${containerName}`,
			});
		}
	}
	return rows;
}

/** Returns a non-empty name for compact Docker rows. */
function resolveDockerContainerDisplayName(container: DockerContainerSummary): string {
	return container.name.trim()
		|| container.service.trim()
		|| container.project.trim()
		|| container.shortId.trim()
		|| container.id.slice(0, 12)
		|| 'container';
}

/** Formats the project/compose label requested for dense Docker rows. */
function formatDockerProjectComposeLabel(project: DockerContainerProjectGroup, composeFile: DockerComposeFileReference): string {
	return `${project.project}/${formatDockerComposeFileLabel(composeFile)}`;
}

/** Formats all compose files associated with a container inside one project. */
function formatDockerContainerProjectComposeLabel(project: DockerContainerProjectGroup, container: DockerContainerSummary): string {
	const labels = resolveDockerContainerComposeFiles(project, container).map(composeFile => formatDockerComposeFileLabel(composeFile));
	if (labels.length === 0) {
		return project.project;
	}
	return `${project.project}/${labels.join(', ')}`;
}

/** Finds discovered compose files matching a container's Docker Compose labels. */
function resolveDockerContainerComposeFiles(project: DockerContainerProjectGroup, container: DockerContainerSummary): DockerComposeFileReference[] {
	const composePaths = new Set(container.composeFilePaths.map(filePath => normalizeDashboardPath(filePath)));
	return project.composeFiles.filter(composeFile => composePaths.has(normalizeDashboardPath(composeFile.filePath)));
}

/** Builds the secondary Docker title line without hiding the actual container name. */
function formatDockerContainerSecondaryLabel(
	container: DockerContainerSummary,
	composeFile: DockerComposeFileReference | undefined,
	showComposeContext: boolean,
): string {
	const displayName = resolveDockerContainerDisplayName(container);
	const parts = [
		container.service && container.service !== displayName ? container.service : '',
		composeFile ? formatDockerComposeFileLabel(composeFile) : showComposeContext ? container.composeFilePaths.map(filePath => filePath.split(/[\\/]/).pop()).filter(Boolean).join(', ') : '',
		container.image,
	].filter(Boolean);
	return parts.join(' · ');
}

/** Filters Docker project groups while preserving project boundaries for tree mode. */
export function resolveFilteredDockerProjects(
	data: DockerContainersData | undefined,
	statusFilter: DockerContainersStatusFilter,
	search: string,
	sortBy: DockerContainerSortBy,
): DockerContainerProjectGroup[] {
	const normalizedSearch = search.trim().toLowerCase();
	return (data?.projects || []).map(project => {
		const containers = sortDockerContainers(project.containers.filter(container => {
			if (!matchesDockerContainerStatusFilter(container.status, statusFilter)) {
				return false;
			}
			if (!normalizedSearch) {
				return true;
			}
			return [container.name, container.service, container.image, container.project]
				.some(value => value.toLowerCase().includes(normalizedSearch));
		}), sortBy);
		const visibleContainerIds = new Set(containers.map(container => container.id));
		const sourceGroups = (project.composeFileGroups || []).length > 0
			? project.composeFileGroups
			: buildDockerComposeFileGroupsForView(project.composeFiles, project.containers, sortBy);
		const composeFileGroups = sourceGroups.flatMap(sourceGroup => {
			const groupContainers = sortDockerContainers(sourceGroup.containers.filter(container => visibleContainerIds.has(container.id)), sortBy);
			const group = buildDockerComposeFileGroupForView(sourceGroup, groupContainers);
			if (group.containers.length > 0) {
				return [group];
			}
			if (statusFilter === 'running') {
				return [];
			}
			if (statusFilter === 'stopped' && matchesDockerContainerStatusFilter(sourceGroup.status || 'unknown', 'running')) {
				return [];
			}
			if (!normalizedSearch) {
				return [group];
			}
			return doesDockerComposeGroupMatchSearch(project, group, normalizedSearch) ? [group] : [];
		});
		const composeFiles = statusFilter === 'all' && !normalizedSearch
			? project.composeFiles
			: composeFileGroups.map(group => group.composeFile);
		return {
			...project,
			containers,
			composeFiles,
			composeFileGroups,
			runningCount: containers.filter(container => container.status === 'running').length,
			stoppedCount: containers.filter(container => container.status === 'stopped').length,
			warningCount: containers.filter(container => container.statusTone === 'warning').length,
			errorCount: containers.filter(container => container.statusTone === 'error').length,
		};
	});
}

/** Resolves whether Docker CPU/RAM/network blocks are actually visible and worth live polling. */
export function resolvePromptDashboardDockerLiveMetricsVisible(input: {
	data: DockerContainersData | undefined;
	viewMode: DockerContainersViewMode;
	statusFilter: DockerContainersStatusFilter;
	search: string;
	sortBy: DockerContainerSortBy;
	expanded: ExpandedState;
	collapsedSections?: PromptDashboardCollapsedSections;
	mode: 'full' | 'compact';
}): boolean {
	if (input.mode !== 'full') {
		return false;
	}
	const collapsedSections = normalizePromptDashboardCollapsedSections(input.collapsedSections);
	if (collapsedSections.dockerContainers === true || !input.data?.enabled || !input.data.available || input.data.runningContainers <= 0) {
		return false;
	}
	const visibleProjects = resolveFilteredDockerProjects(input.data, input.statusFilter, input.search, input.sortBy)
		.filter(project => project.containers.length > 0 || project.composeFileGroups.length > 0 || project.composeFiles.length > 0);
	if (visibleProjects.length === 0) {
		return false;
	}
	if (input.viewMode === 'cards' || input.viewMode === 'list' || input.viewMode === 'table') {
		return visibleProjects.some(project => project.containers.some(hasDockerRuntimeStats));
	}
	if (input.viewMode !== 'tree') {
		return false;
	}
	return visibleProjects.some(project => {
		if (input.expanded[buildDockerProjectExpandedKey(project)] !== true) {
			return false;
		}
		return project.composeFileGroups.some(group => {
			if (input.expanded[buildDockerComposeFileExpandedKey(project, group.composeFile)] !== true) {
				return false;
			}
			return group.containers.some(container => input.expanded[`docker:${container.id}`] === true && hasDockerRuntimeStats(container));
		});
	});
}

/** Groups active lifecycle states under the running filter and everything else under stopped. */
export function matchesDockerContainerStatusFilter(
	status: DockerContainerSummary['status'],
	statusFilter: DockerContainersStatusFilter,
): boolean {
	if (statusFilter === 'all') {
		return true;
	}
	const isActive = status === 'running' || status === 'starting' || status === 'restarting' || status === 'paused';
	return statusFilter === 'running' ? isActive : !isActive;
}

/** Checks search text against compose metadata and declared service names. */
function doesDockerComposeGroupMatchSearch(
	project: DockerContainerProjectGroup,
	group: DockerComposeFileContainerGroup,
	normalizedSearch: string,
): boolean {
	return [
		project.project,
		group.composeFile.relativePath,
		group.composeFile.filePath,
		...(group.serviceNames || []),
	].some(value => value.toLowerCase().includes(normalizedSearch));
}

/** Builds compose file groups for older or test payloads without host-side grouping. */
function buildDockerComposeFileGroupsForView(
	composeFiles: DockerComposeFileReference[],
	containers: DockerContainerSummary[],
	sortBy: DockerContainerSortBy,
): DockerComposeFileContainerGroup[] {
	return composeFiles.map(composeFile => {
		const composeFilePath = normalizeDashboardPath(composeFile.filePath);
		const groupContainers = sortDockerContainers(containers.filter(container => container.composeFilePaths.some(filePath => normalizeDashboardPath(filePath) === composeFilePath)), sortBy);
		return buildDockerComposeFileGroupForView({ composeFile, containers: groupContainers, runningCount: 0, stoppedCount: 0, warningCount: 0, errorCount: 0 }, groupContainers);
	});
}

/** Creates a UI compose file group and recalculates its visible counters. */
function buildDockerComposeFileGroupForView(
	group: DockerComposeFileContainerGroup,
	containers: DockerContainerSummary[],
): DockerComposeFileContainerGroup {
	const status = resolveDockerComposeGroupStatus(containers, group.serviceNames || []);
	return {
		...group,
		containers,
		status: status.status,
		statusTone: status.statusTone,
		statusText: status.statusText,
		runningCount: containers.filter(container => container.status === 'running').length,
		stoppedCount: containers.filter(container => container.status === 'stopped').length,
		warningCount: containers.filter(container => container.statusTone === 'warning').length,
		errorCount: containers.filter(container => container.statusTone === 'error').length,
	};
}

/** Resolves a compose file status from the visible containers and declared services. */
function resolveDockerComposeGroupStatus(
	containers: DockerContainerSummary[],
	serviceNames: string[],
): { status: DockerContainerLifecycleStatus; statusTone: DockerContainerStatusTone; statusText: string } {
	const runningCount = containers.filter(container => container.status === 'running').length;
	const errorCount = containers.filter(container => container.statusTone === 'error').length;
	if (errorCount > 0) {
		return { status: 'error', statusTone: 'error', statusText: `Ошибки: ${errorCount}` };
	}
	if (runningCount > 0) {
		return { status: 'running', statusTone: 'ok', statusText: `Запущено ${runningCount}/${containers.length}` };
	}
	if (containers.length > 0 || serviceNames.length > 0) {
		return { status: 'stopped', statusTone: 'neutral', statusText: 'Остановлен' };
	}
	return { status: 'unknown', statusTone: 'neutral', statusText: 'Сервисы не найдены' };
}

/** Formats a compact compose file label for nested Docker tree rows. */
function formatDockerComposeFileLabel(composeFile: DockerComposeFileReference): string {
	return composeFile.relativePath || composeFile.filePath.split(/[\\/]/).pop() || composeFile.filePath;
}

/** Normalizes paths for comparing Docker labels inside browser-rendered payloads. */
function normalizeDashboardPath(value: string): string {
	return value.split('\\').join('/');
}

/** Sorts containers by the selected dashboard sort key. */
function sortDockerContainers(containers: DockerContainerSummary[], sortBy: DockerContainerSortBy): DockerContainerSummary[] {
	const statusPriority = (container: DockerContainerSummary): number => container.status === 'running' ? 0 : container.status === 'stopped' ? 2 : 1;
	return [...containers].sort((left, right) => {
		if (sortBy === 'cpu') {
			return (right.stats?.cpuPercent || 0) - (left.stats?.cpuPercent || 0);
		}
		if (sortBy === 'memory') {
			return (right.stats?.memoryPercent || 0) - (left.stats?.memoryPercent || 0);
		}
		if (sortBy === 'uptime') {
			return right.uptimeMs - left.uptimeMs;
		}
		if (sortBy === 'status') {
			const byStatus = statusPriority(left) - statusPriority(right);
			if (byStatus !== 0) {
				return byStatus;
			}
		}
		return `${left.project}:${left.service}:${left.name}`.localeCompare(`${right.project}:${right.service}:${right.name}`, 'ru');
	});
}

/** Maps Docker status tones to existing dashboard badge styles. */
function resolveDockerBadgeStyle(tone: DockerContainerStatusTone): React.CSSProperties {
	if (tone === 'ok') {
		return styles.badgeOk;
	}
	if (tone === 'warning' || tone === 'progress') {
		return styles.badgeWarn;
	}
	if (tone === 'error') {
		return styles.badgeDanger;
	}
	return styles.badgeNeutral;
}

/** Maps Docker status tones to VS Code theme colors. */
function resolveDockerToneColor(tone: DockerContainerStatusTone): string {
	if (tone === 'ok') {
		return 'var(--vscode-charts-green)';
	}
	if (tone === 'warning' || tone === 'progress') {
		return 'var(--vscode-charts-yellow)';
	}
	if (tone === 'error') {
		return 'var(--vscode-charts-red)';
	}
	return 'var(--vscode-descriptionForeground)';
}

/** Resolves a short localized lifecycle label for status badges. */
function resolveDockerStatusLabel(status: DockerContainerLifecycleStatus): string {
	switch (status) {
		case 'running': return 'запущен';
		case 'stopped': return 'остановлен';
		case 'paused': return 'пауза';
		case 'restarting': return 'рестарт';
		case 'starting': return 'старт';
		case 'error': return 'ошибка';
		default: return 'неизвестно';
	}
}

/** Resolves full view-mode labels for segmented-control tooltips. */
function resolveDockerViewModeLabel(mode: DockerContainersViewMode): string {
	switch (mode) {
		case 'tree': return 'Дерево проектов';
		case 'cards': return 'Карточки контейнеров';
		case 'table': return 'Таблица контейнеров';
		case 'list': return 'Компактный список';
		default: return mode;
	}
}

/** Resolves compact view-mode labels that fit the narrow dashboard rail. */
function resolveDockerViewModeShortLabel(mode: DockerContainersViewMode): string {
	switch (mode) {
		case 'tree': return 'Дер.';
		case 'cards': return 'Карт.';
		case 'table': return 'Табл.';
		case 'list': return 'Спис.';
		default: return mode;
	}
}

/** Formats percentages with one decimal at most. */
function formatPercent(value: number | undefined): string {
	if (!Number.isFinite(value)) {
		return '0%';
	}
	return `${Math.round((value || 0) * 10) / 10}%`;
}

/** Formats network throughput per second. */
function formatByteRate(value: number): string {
	return `${formatBytes(value)}/s`;
}

/** Formats byte counts with compact binary units. */
function formatBytes(value: number): string {
	const bytes = Math.max(0, value || 0);
	if (bytes < 1024) {
		return `${Math.round(bytes)} B`;
	}
	const kib = bytes / 1024;
	if (kib < 1024) {
		return `${Math.round(kib)} KB`;
	}
	const mib = kib / 1024;
	if (mib < 1024) {
		return `${Math.round(mib * 10) / 10} MB`;
	}
	return `${Math.round((mib / 1024) * 10) / 10} GB`;
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

function renderAnalysis(
	analysis: PromptDashboardAnalysisState | null,
	cacheStatus: PromptDashboardLoadStatus,
	busyAction: DashboardBusyAction,
	collapsedSections: PromptDashboardCollapsedSections,
	onToggleSectionCollapse: (section: PromptDashboardSectionKey) => void,
	onRefreshWidget?: (section: PromptDashboardSectionKey, widget: PromptDashboardWidgetKind) => void,
	dragHandle?: React.ReactNode,
): React.ReactNode {
	const collapsed = isPromptDashboardSectionCollapsed(collapsedSections, 'aiAnalysis');
	const sectionCacheStatus = resolveSectionCacheStatus(cacheStatus, busyAction, 'aiAnalysis', 'aiAnalysis');
	const isRunning = analysis?.status === 'running' || sectionCacheStatus === 'loading';
	const sections = parseAnalysisSections(analysis?.content || '');
	const hasPreviewContent = isRunning && sections.length > 0;
	const stateLabel = isRunning
		? (hasPreviewContent ? 'предварительно' : 'проверяем')
		: analysis?.status === 'completed'
			? 'готово'
			: 'ожидание';
	return (
		<section style={styles.section}>
			{renderSectionHeader('AI review', renderSectionMeta(stateLabel, isRunning ? 'loading' : 'fresh', 'обновляем', {
					section: 'aiAnalysis',
					collapsed,
					widget: 'aiAnalysis',
					title: 'AI review',
					busyAction,
					onToggleCollapse: () => onToggleSectionCollapse('aiAnalysis'),
					onRefreshWidget,
				}), { collapsed, onToggleCollapse: () => onToggleSectionCollapse('aiAnalysis'), dragHandle })}
			{collapsed ? null : <div style={styles.sectionBody}>
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
					<div style={styles.emptyText}>{isRunning ? 'AI проверяет ветки и изменения...' : 'AI review появится после загрузки Git-данных.'}</div>
				)}
				{analysis?.error ? <div style={styles.errorText}>{analysis.error}</div> : null}
			</div>}
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
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: '24px',
		height: '24px',
		padding: 0,
		border: 'none',
		borderRadius: '4px',
		background: 'transparent',
		color: 'color-mix(in srgb, var(--vscode-foreground) 74%, var(--vscode-descriptionForeground))',
		cursor: 'pointer',
		fontFamily: 'var(--vscode-font-family)',
		lineHeight: 1,
		flexShrink: 0,
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
	// Two stable dashboard columns that avoid row-height gaps while keeping widgets in fixed columns.
	widgetGrid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,360px),1fr))',
		gap: '12px',
		alignItems: 'start',
	},
	// Vertical stack inside each stable dashboard column.
	widgetColumn: {
		display: 'flex',
		flexDirection: 'column',
		gap: '12px',
		minWidth: 0,
		alignSelf: 'start',
	},
	// Wrapper that owns drag-over highlighting around one dashboard card.
	sectionDragWrapper: {
		display: 'flex',
		flexDirection: 'column',
		gap: '8px',
		minWidth: 0,
		transition: 'opacity 0.18s ease, transform 0.18s ease',
	},
	sectionDragWrapperDragging: {
		opacity: 0.5,
		transform: 'scale(0.985)',
	},
	// Visible insertion rail shown above or below the current drop target.
	sectionDropIndicator: {
		height: '4px',
		borderRadius: '999px',
		background: 'linear-gradient(90deg, var(--vscode-focusBorder, #3794ff), color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 40%, transparent))',
		boxShadow: '0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 24%, transparent)',
	},
	// Общая карточка любого виджета дашборда.
	section: {
		width: '100%',
		verticalAlign: 'top',
		alignSelf: 'start',
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
	sectionHeaderInteractive: {
		cursor: 'pointer',
		userSelect: 'none',
	},
	// Left title cluster that keeps the drag handle aligned with the section title.
	sectionTitleRow: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '8px',
		minWidth: 0,
	},
	// Compact drag handle used to start section reordering from the header only.
	sectionDragHandle: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: '20px',
		height: '20px',
		padding: 0,
		border: 'none',
		borderRadius: '4px',
		background: 'transparent',
		color: 'color-mix(in srgb, var(--vscode-foreground) 86%, var(--vscode-descriptionForeground))',
		cursor: 'grab',
		flexShrink: 0,
	},
	sectionDragHandleDragging: {
		cursor: 'grabbing',
		color: 'var(--vscode-focusBorder, #3794ff)',
		background: 'transparent',
	},
	// Dot-grid glyph inside the section drag handle button.
	sectionDragHandleIcon: {
		width: '14px',
		height: '14px',
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
	sectionHeaderActions: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '6px',
		minWidth: 0,
	},
	sectionRefreshButton: {
		width: '18px',
		height: '18px',
	},
	sectionCollapseButton: {
		width: '18px',
		height: '18px',
	},
	refreshIcon: {
		width: '13px',
		height: '13px',
	},
	sectionCollapseIcon: {
		width: '13px',
		height: '13px',
		transition: 'transform 0.18s ease',
	},
	sectionCollapseIconCollapsed: {
		transform: 'rotate(-90deg)',
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
	// Сетка селекта и toggle-кнопки в правой части общего branch-строка.
	bulkBranchControls: {
		display: 'grid',
		gridTemplateColumns: 'minmax(0, 1fr) auto',
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
	branchFooterActions: {
		display: 'flex',
		justifyContent: 'flex-end',
		marginTop: '2px',
	},
	// Основная цветная кнопка действия внутри виджета.
	primaryButton: {
		minWidth: 0,
		minHeight: '28px',
		padding: '5px 8px',
		border: '1px solid var(--vscode-button-border, transparent)',
		borderRadius: '4px',
		background: 'var(--vscode-button-background)',
		color: 'var(--vscode-button-foreground)',
		fontFamily: 'var(--vscode-font-family)',
		fontSize: '11px',
		fontWeight: 600,
		lineHeight: '16px',
		boxSizing: 'border-box',
		appearance: 'none',
		cursor: 'pointer',
	},
	// Вторичная спокойная кнопка для вспомогательных действий.
	secondaryButton: {
		minWidth: 0,
		minHeight: '28px',
		padding: '5px 8px',
		border: '1px solid var(--vscode-button-border, transparent)',
		borderRadius: '4px',
		background: 'var(--vscode-button-secondaryBackground)',
		color: 'var(--vscode-button-secondaryForeground)',
		fontFamily: 'var(--vscode-font-family)',
		fontSize: '11px',
		fontWeight: 600,
		lineHeight: '16px',
		boxSizing: 'border-box',
		appearance: 'none',
		cursor: 'pointer',
	},
	// Снижение контраста и блокировка у неактивного элемента.
	disabledButton: {
		opacity: 1,
		cursor: 'default',
		borderColor: 'color-mix(in srgb, var(--vscode-panel-border) 78%, var(--vscode-descriptionForeground))',
		background: 'color-mix(in srgb, var(--vscode-button-secondaryBackground) 58%, var(--vscode-editor-background))',
		color: 'color-mix(in srgb, var(--vscode-descriptionForeground) 92%, var(--vscode-foreground) 8%)',
	},
	inlineButtonDisabled: {
		color: 'var(--vscode-descriptionForeground)',
		opacity: 0.95,
		background: 'transparent',
		border: 'none',
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
		border: '1px solid var(--vscode-charts-yellow)',
		background: 'color-mix(in srgb, var(--vscode-charts-yellow) 8%, var(--vscode-editor-background))',
	},
	branchProjectNoticeBlockSuccess: {
		border: '1px solid var(--vscode-charts-green)',
		background: 'color-mix(in srgb, var(--vscode-charts-green) 8%, var(--vscode-editor-background))',
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
		fontWeight: 600,
		color: 'color-mix(in srgb, var(--vscode-charts-yellow) 70%, var(--vscode-foreground))',
	},
	branchProjectNoticeTextSuccess: {
		color: 'color-mix(in srgb, var(--vscode-charts-green) 70%, var(--vscode-foreground))',
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
	branchProjectNoticeListSuccess: {
		borderTop: '1px solid color-mix(in srgb, var(--vscode-charts-green) 26%, transparent)',
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
	// Highlights branch selects whose current branch does not match the prompt branch.
	branchSelectMismatch: {
		border: '1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground))',
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
	commitDetailButton: {
		gridTemplateColumns: '12px minmax(0, 1fr) auto',
		alignItems: 'start',
	},
	// Маленькая стрелка раскрытия рядом с detail-строкой.
	detailChevron: {
		color: 'var(--vscode-descriptionForeground)',
	},
	commitContent: {
		display: 'flex',
		flexDirection: 'column',
		gap: '3px',
		minWidth: 0,
	},
	commitMetaRow: {
		display: 'flex',
		alignItems: 'center',
		gap: '6px',
		minWidth: 0,
		flexWrap: 'wrap',
	},
	// Короткий SHA коммита с моноширинным акцентом.
	commitSha: {
		fontFamily: 'var(--vscode-editor-font-family)',
		color: 'var(--vscode-textLink-foreground)',
		whiteSpace: 'nowrap',
	},
	commitAuthor: {
		fontSize: '10px',
		fontWeight: 500,
		color: 'var(--vscode-descriptionForeground)',
		whiteSpace: 'nowrap',
	},
	// Тема коммита под мета-строкой без усечения по длине.
	commitSubject: {
		minWidth: 0,
		whiteSpace: 'normal',
		lineHeight: 1.35,
	},
	// Название параллельной ветки в detail-строке.
	branchName: {
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		fontFamily: 'var(--vscode-editor-font-family)',
	},
	// Inline branch label row that keeps the branch name and author in one flexible grid cell.
	branchLabelRow: {
		display: 'flex',
		alignItems: 'center',
		gap: '6px',
		minWidth: 0,
		overflow: 'hidden',
	},
	// Secondary author label shown after the parallel branch name.
	branchAuthor: {
		flexShrink: 0,
		maxWidth: '40%',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		fontFamily: 'var(--vscode-font-family)',
		fontSize: '10px',
		fontWeight: 500,
		color: 'var(--vscode-descriptionForeground)',
	},
	// Compact horizontal branch map rendered above the parallel branch list.
	parallelGraphCard: {
		display: 'flex',
		flexDirection: 'column',
		gap: '8px',
		padding: '2px 0 6px',
		minWidth: 0,
	},
	parallelGraphLegend: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		minWidth: 0,
	},
	parallelGraphLegendLabel: {
		fontSize: '10px',
		fontWeight: 600,
		color: 'var(--vscode-descriptionForeground)',
		textTransform: 'uppercase',
		letterSpacing: '0.04em',
	},
	parallelGraphLegendNote: {
		fontSize: '10px',
		color: 'var(--vscode-descriptionForeground)',
		whiteSpace: 'nowrap',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	},
	parallelGraphBaseChip: {
		display: 'inline-flex',
		alignItems: 'center',
		maxWidth: '100%',
		padding: '2px 8px',
		borderRadius: '999px',
		border: '1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 62%, var(--vscode-panel-border))',
		background: 'color-mix(in srgb, var(--vscode-textLink-foreground) 12%, var(--vscode-editor-background))',
		color: 'var(--vscode-foreground)',
		fontFamily: 'var(--vscode-editor-font-family)',
		fontSize: '10px',
		whiteSpace: 'nowrap',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
	},
	parallelGraphRows: {
		display: 'flex',
		flexDirection: 'column',
		gap: '0',
		minWidth: 0,
	},
	parallelGraphLane: {
		width: '118px',
		height: '28px',
		display: 'block',
		overflow: 'visible',
		flexShrink: 0,
	},
	parallelGraphSvg: {
		width: '100%',
		height: 'auto',
		display: 'block',
		overflow: 'visible',
		borderRadius: '8px',
		background: 'linear-gradient(135deg, color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-textLink-foreground) 8%), color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-panel-border) 4%))',
	},
	parallelDetailButton: {
		gridTemplateColumns: '12px 118px minmax(0, 1fr) auto auto',
		alignItems: 'center',
		gap: '8px',
		padding: '6px 0',
	},
	parallelBranchContent: {
		display: 'flex',
		flexDirection: 'column',
		gap: '2px',
		minWidth: 0,
	},
	parallelBranchMeta: {
		fontSize: '10px',
		color: 'var(--vscode-descriptionForeground)',
		whiteSpace: 'nowrap',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
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
	commitFileCount: {
		alignSelf: 'flex-start',
		marginTop: '1px',
	},
	// Предупреждающий вариант счетчика файлов.
	fileCountWarn: {
		fontWeight: 500,
		color: 'color-mix(in srgb, var(--vscode-charts-yellow) 70%, var(--vscode-foreground))',
		borderColor: 'var(--vscode-charts-yellow)',
	},
	fileCountOk: {
		fontWeight: 500,
		color: 'color-mix(in srgb, var(--vscode-charts-green) 70%, var(--vscode-foreground))',
		borderColor: 'var(--vscode-charts-green)',
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
	// Compact relative directory path that stays before the file name in flat dirty rows.
	// Компактный относительный путь, который стоит перед именем файла в плоских строках.
	fileTreePathPrefix: {
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		fontSize: '11px',
		fontWeight: 400,
		// color: 'var(--vscode-descriptionForeground)',
		// color: 'color-mix(in srgb, var(--vscode--foreground) 3%, transparent)',
		color: 'var(--vscode--foreground)',
		opacity: 0.6,
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
		padding: '3px 6px',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '4px',
		// border: '1px solid var(--vscode-button-border, transparent)',
		// borderRadius: '4px',
		// background: 'var(--vscode-button-background)',
		// color: 'var(--vscode-button-foreground)',
		// background: 'transparent',
		background: 'var(--vscode-textLink-foreground)',
		color: 'var(--vscode-button-foreground)',
		fontFamily: 'var(--vscode-font-family)',
		fontSize: '10px',
		cursor: 'pointer',
		whiteSpace: 'nowrap',
	},
	// Зеленый вариант inline-кнопки для положительных действий. Получить
	inlineButtonSuccess: {
		color: 'var(--vscode-button-foreground)',
		borderColor: 'var(--vscode-foreground)',
		background: 'var(--vscode-charts-green)',
	},
	// Compact Docker widget controls, rows, metrics, and resource sparklines.
	dockerSummaryGrid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
		gap: '6px',
	},
	dockerSummaryMetric: {
		display: 'flex',
		flexDirection: 'column',
		gap: '2px',
		padding: '6px 8px',
		border: '1px solid color-mix(in srgb, var(--vscode-panel-border) 72%, transparent)',
		borderRadius: '5px',
		background: 'color-mix(in srgb, var(--vscode-sideBar-background) 68%, transparent)',
		minWidth: 0,
	},
	dockerSummaryLabel: {
		fontSize: '10px',
		fontWeight: 700,
		color: 'var(--vscode-descriptionForeground)',
		textTransform: 'uppercase',
	},
	dockerSummaryValue: {
		fontSize: '15px',
		fontWeight: 800,
		lineHeight: 1.1,
	},
	dockerControls: {
		display: 'grid',
		gridTemplateColumns: 'auto minmax(0, 1fr)',
		gap: '8px',
		alignItems: 'center',
		minWidth: 0,
	},
	dockerSegmentedControl: {
		display: 'inline-grid',
		gridTemplateColumns: 'repeat(4, auto)',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '5px',
		overflow: 'hidden',
		minWidth: 0,
	},
	dockerSegmentButton: {
		minWidth: '42px',
		padding: '4px 7px',
		border: 'none',
		borderRight: '1px solid var(--vscode-panel-border)',
		background: 'var(--vscode-button-secondaryBackground)',
		color: 'var(--vscode-button-secondaryForeground)',
		fontFamily: 'var(--vscode-font-family)',
		fontSize: '10px',
		fontWeight: 700,
		cursor: 'pointer',
	},
	dockerSegmentButtonActive: {
		background: 'var(--vscode-button-background)',
		color: 'var(--vscode-button-foreground)',
	},
	dockerControlRow: {
		display: 'grid',
		gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
		gap: '6px',
		minWidth: 0,
	},
	dockerSelect: {
		width: '100%',
		minWidth: 0,
		padding: '5px 6px',
		border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
		borderRadius: '4px',
		background: 'var(--vscode-dropdown-background, var(--vscode-input-background))',
		color: 'var(--vscode-dropdown-foreground, var(--vscode-input-foreground))',
		fontFamily: 'var(--vscode-font-family)',
		fontSize: '11px',
	},
	dockerSearchInput: {
		gridColumn: '1 / -1',
		width: '100%',
		minWidth: 0,
		padding: '6px 8px',
		border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
		borderRadius: '4px',
		background: 'var(--vscode-input-background)',
		color: 'var(--vscode-input-foreground)',
		fontFamily: 'var(--vscode-font-family)',
		fontSize: '12px',
		boxSizing: 'border-box',
	},
	dockerTree: {
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
		minWidth: 0,
	},
	dockerProjectBlock: {
		display: 'flex',
		flexDirection: 'column',
		gap: '3px',
		paddingTop: 0,
		borderTop: 'none',
		minWidth: 0,
	},
	dockerGroupedProjects: {
		display: 'flex',
		flexDirection: 'column',
		gap: '10px',
		minWidth: 0,
	},
	dockerProjectGroupBlock: {
		display: 'flex',
		flexDirection: 'column',
		gap: '7px',
		minWidth: 0,
	},
	dockerProjectHeader: {
		display: 'grid',
		gridTemplateColumns: 'auto 18px minmax(0, 1fr) auto',
		alignItems: 'center',
		gap: '4px',
		minWidth: 0,
	},
	dockerProjectStaticHeader: {
		display: 'grid',
		gridTemplateColumns: 'minmax(0, 1fr) auto',
		alignItems: 'center',
		gap: '8px',
		minWidth: 0,
	},
	dockerComposeFileBlock: {
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
		paddingLeft: 0,
		borderLeft: 'none',
		minWidth: 0,
	},
	dockerComposeFileHeader: {
		display: 'grid',
		gridTemplateColumns: 'auto 18px minmax(0, 1fr) auto auto auto',
		alignItems: 'center',
		gap: '4px',
		minWidth: 0,
	},
	dockerComposeFileName: {
		maxWidth: '100%',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		fontSize: '11px',
		fontWeight: 650,
		color: 'color-mix(in srgb, var(--vscode-foreground) 88%, var(--vscode-descriptionForeground))',
	},
	dockerProjectActions: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'flex-end',
		gap: '2px',
		minWidth: 0,
	},
	dockerCardGrid: {
		display: 'grid',
		gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
		gap: '8px',
		minWidth: 0,
	},
	dockerCard: {
		display: 'flex',
		flexDirection: 'column',
		gap: '8px',
		padding: '8px',
		border: '1px solid color-mix(in srgb, var(--vscode-panel-border) 74%, transparent)',
		borderRadius: '6px',
		background: 'color-mix(in srgb, var(--vscode-sideBar-background) 52%, transparent)',
		minWidth: 0,
	},
	dockerList: {
		display: 'flex',
		flexDirection: 'column',
		gap: '6px',
		minWidth: 0,
	},
	dockerListComposeGroup: {
		display: 'flex',
		flexDirection: 'column',
		gap: '8px',
		padding: '8px',
		border: '1px solid color-mix(in srgb, var(--vscode-panel-border) 74%, transparent)',
		borderRadius: '6px',
		background: 'color-mix(in srgb, var(--vscode-sideBar-background) 52%, transparent)',
		minWidth: 0,
	},
	dockerListNestedRows: {
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
		paddingLeft: '12px',
		marginLeft: '6px',
		borderLeft: '1px solid color-mix(in srgb, var(--vscode-panel-border) 68%, transparent)',
		minWidth: 0,
	},
	dockerListRow: {
		display: 'flex',
		flexDirection: 'column',
		gap: '7px',
		padding: '8px 0',
		borderTop: '1px solid color-mix(in srgb, var(--vscode-panel-border) 68%, transparent)',
		minWidth: 0,
	},
	dockerTreeContainerRow: {
		padding: '1px 0',
		borderTop: 'none',
		gap: '5px',
	},
	dockerNestedListRow: {
		padding: '4px 0 0',
		borderTop: 'none',
		gap: '6px',
	},
	dockerComposeErrorBlock: {
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
		padding: '6px 8px',
		border: '1px solid color-mix(in srgb, var(--vscode-errorForeground) 35%, var(--vscode-panel-border))',
		borderRadius: '5px',
		background: 'color-mix(in srgb, var(--vscode-errorForeground) 8%, transparent)',
		minWidth: 0,
	},
	dockerComposeServiceList: {
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
		paddingLeft: 0,
		minWidth: 0,
	},
	dockerComposeServiceRow: {
		display: 'grid',
		gridTemplateColumns: 'minmax(0, 1fr) auto',
		alignItems: 'center',
		gap: '8px',
		minWidth: 0,
	},
	dockerCardHeader: {
		display: 'grid',
		gridTemplateColumns: '18px minmax(0, 1fr)',
		alignItems: 'center',
		gap: '6px',
		minWidth: 0,
	},
	dockerListHeader: {
		display: 'grid',
		gridTemplateColumns: '18px minmax(0, 1fr) auto',
		alignItems: 'center',
		gap: '6px',
		minWidth: 0,
	},
	dockerTreeListHeader: {
		display: 'grid',
		gridTemplateColumns: 'auto 18px minmax(0, 1fr) auto',
		alignItems: 'start',
		gap: '4px',
		minWidth: 0,
	},
	dockerDeclaredServiceHeader: {
		display: 'grid',
		gridTemplateColumns: 'minmax(0, 1fr)',
		alignItems: 'center',
		gap: '6px',
		minWidth: 0,
	},
	dockerComposeSummaryHeader: {
		display: 'grid',
		gridTemplateColumns: 'minmax(0, 1fr)',
		alignItems: 'center',
		gap: '6px',
		minWidth: 0,
	},
	// Compact runtime tiles for running compose cards.
	dockerComposeRuntimeMetrics: {
		display: 'grid',
		gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
		gap: '8px',
		minWidth: 0,
	},
	dockerComposeRuntimeMetricCard: {
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
		padding: '8px 10px',
		borderRadius: '8px',
		border: '1px solid color-mix(in srgb, var(--vscode-panel-border) 72%, transparent)',
		background: 'color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-panel-border) 12%)',
		minWidth: 0,
	},
	// Emphasized numeric value inside a compose runtime tile.
	dockerComposeRuntimeMetricValue: {
		fontSize: '13px',
		fontWeight: 700,
		color: 'var(--vscode-foreground)',
		whiteSpace: 'nowrap',
	},
	dockerListSummaryHeader: {
		display: 'grid',
		gridTemplateColumns: 'minmax(0, 1fr) auto',
		alignItems: 'center',
		gap: '8px',
		minWidth: 0,
	},
	dockerTreeDeclaredServiceHeader: {
		display: 'grid',
		gridTemplateColumns: 'auto 18px minmax(0, 1fr) auto',
		alignItems: 'start',
		gap: '4px',
		minWidth: 0,
	},
	dockerExpandPlaceholder: {
		width: '18px',
		height: '22px',
		flex: '0 0 auto',
	},
	dockerTreeExpandPlaceholder: {
		height: '18px',
		alignSelf: 'start',
		marginTop: '1px',
	},
	dockerListDeclaredServiceHeader: {
		display: 'grid',
		gridTemplateColumns: 'minmax(0, 1fr) auto',
		alignItems: 'center',
		gap: '8px',
		minWidth: 0,
	},
	dockerExpandButton: {
		width: '18px',
		height: '22px',
		padding: 0,
		border: 'none',
		background: 'transparent',
		color: 'var(--vscode-descriptionForeground)',
		fontFamily: 'var(--vscode-font-family)',
		cursor: 'pointer',
	},
	dockerTreeExpandButton: {
		height: '18px',
		alignSelf: 'start',
		marginTop: '1px',
	},
	dockerNameButton: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'flex-start',
		gap: '2px',
		minWidth: 0,
		padding: 0,
		border: 'none',
		background: 'transparent',
		color: 'var(--vscode-foreground)',
		fontFamily: 'var(--vscode-font-family)',
		textAlign: 'left',
		cursor: 'pointer',
	},
	dockerServiceName: {
		maxWidth: '100%',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		fontWeight: 700,
	},
	dockerImageName: {
		maxWidth: '100%',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		fontSize: '10px',
		color: 'var(--vscode-descriptionForeground)',
	},
	dockerHeaderActions: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'flex-end',
		flexWrap: 'wrap',
		gap: '5px',
		minWidth: 0,
	},
	dockerCardHeaderActions: {
		gridColumn: '1 / -1',
		justifyContent: 'flex-start',
	},
	dockerTreeHeaderActions: {
		alignSelf: 'start',
		paddingTop: '1px',
	},
	dockerActionIcons: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'flex-end',
		gap: '3px',
		minWidth: 0,
	},
	dockerIconButton: {
		width: '24px',
		height: '24px',
		padding: 0,
		border: 'none',
		borderRadius: '4px',
		background: 'transparent',
		color: 'var(--vscode-icon-foreground, var(--vscode-foreground))',
		fontFamily: 'var(--vscode-font-family)',
		fontSize: '12px',
		lineHeight: '22px',
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		boxSizing: 'border-box',
		appearance: 'none',
		cursor: 'pointer',
	},
	dockerIconButtonDanger: {
		color: 'var(--vscode-errorForeground, var(--vscode-charts-red))',
	},
	dockerIconButtonDisabled: {
		background: 'transparent',
		border: 'none',
		color: 'var(--vscode-disabledForeground, var(--vscode-descriptionForeground))',
		opacity: 0.72,
		cursor: 'default',
	},
	dockerActionIcon: {
		width: '14px',
		height: '14px',
		display: 'block',
		flex: '0 0 auto',
	},
	dockerResourceBlock: {
		display: 'flex',
		flexDirection: 'column',
		gap: '5px',
		minWidth: 0,
	},
	dockerMetricTrack: {
		display: 'block',
		height: '8px',
		borderRadius: '999px',
		overflow: 'hidden',
		background: 'color-mix(in srgb, var(--vscode-panel-border) 44%, transparent)',
	},
	dockerMetricFill: {
		display: 'block',
		height: '100%',
		borderRadius: '999px',
		transition: 'width 0.2s ease',
	},
	dockerNetworkRow: {
		display: 'grid',
		gridTemplateColumns: '52px minmax(0, 1fr) minmax(0, 1fr)',
		alignItems: 'center',
		gap: '8px',
		minWidth: 0,
	},
	dockerSparkline: {
		width: '100%',
		height: '40px',
		display: 'block',
		borderRadius: '4px',
		background: 'color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-panel-border) 12%)',
	},
	dockerDetails: {
		display: 'flex',
		flexDirection: 'column',
		gap: '8px',
		padding: '8px',
		border: '1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent)',
		borderRadius: '5px',
		background: 'color-mix(in srgb, var(--vscode-editor-background) 86%, var(--vscode-sideBar-background) 14%)',
		minWidth: 0,
	},
	dockerDetailsLine: {
		fontSize: '11px',
		lineHeight: 1.45,
		color: 'var(--vscode-descriptionForeground)',
		wordBreak: 'break-word',
	},
	dockerTable: {
		display: 'flex',
		flexDirection: 'column',
		gap: '2px',
		minWidth: 0,
	},
	dockerTableBlock: {
		display: 'flex',
		flexDirection: 'column',
		gap: '6px',
		minWidth: 0,
	},
	dockerTableRow: {
		display: 'grid',
		gridTemplateColumns: 'minmax(0, 1fr) 32px 46px 46px 162px',
		alignItems: 'center',
		gap: '8px',
		padding: '5px 0',
		borderBottom: '1px solid color-mix(in srgb, var(--vscode-panel-border) 60%, transparent)',
		minWidth: 0,
	},
	dockerTableHeader: {
		fontSize: '10px',
		fontWeight: 700,
		color: 'var(--vscode-descriptionForeground)',
		textTransform: 'uppercase',
	},
	dockerTableHeaderCenteredCell: {
		justifySelf: 'center',
	},
	dockerTableHeaderMetricCell: {
		justifySelf: 'end',
	},
	dockerTableHeaderActionsCell: {
		justifySelf: 'start',
	},
	dockerTableActions: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'flex-start',
		flexWrap: 'nowrap',
		gap: '3px',
		width: '162px',
		minWidth: '162px',
	},
	dockerTableMetricCell: {
		justifySelf: 'end',
		fontVariantNumeric: 'tabular-nums',
		whiteSpace: 'nowrap',
	},
	dockerProjectComposeCell: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '4px',
		minWidth: 0,
		color: 'var(--vscode-descriptionForeground)',
	},
	dockerProjectComposeLabelBlock: {
		display: 'flex',
		flexDirection: 'column',
		gap: '1px',
		minWidth: 0,
	},
	dockerProjectComposeLabel: {
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
		fontSize: '11px',
	},
	dockerStatusIcon: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		width: '18px',
		height: '18px',
		border: '1px solid currentColor',
		borderRadius: '4px',
		boxSizing: 'border-box',
		lineHeight: 1,
		background: 'transparent',
		flex: '0 0 auto',
	},
	dockerStatusIconCompact: {
		width: '18px',
		height: '18px',
	},
	dockerStatusPauseGlyph: {
		fontSize: '10px',
		fontWeight: 700,
	},
	dockerTableDetails: {
		display: 'flex',
		flexDirection: 'column',
		gap: '8px',
		paddingBottom: '8px',
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