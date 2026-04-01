import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import type {
	GitOverlayChangeFile,
	GitOverlayProjectCommitMessage,
	GitOverlayProjectSnapshot,
	GitOverlaySnapshot,
} from '../../../types/git';

type Props = {
	open: boolean;
	snapshot: GitOverlaySnapshot | null;
	commitMessages: Record<string, string>;
	busyAction: string | null;
	preferredTrackedBranch?: string;
	onClose: () => void;
	onRefresh: (mode?: 'local' | 'fetch' | 'sync') => void;
	onEnsurePromptBranch: (trackedBranch: string) => void;
	onPush: (branch?: string) => void;
	onMergePromptBranch: (trackedBranch: string, stayOnTrackedBranch: boolean) => void;
	onDiscardFile: (project: string, filePath: string, group: GitOverlayChangeFile['group'], previousPath?: string) => void;
	onOpenFile: (project: string, filePath: string) => void;
	onOpenDiff: (project: string, filePath: string) => void;
	onOpenMergeEditor: (project: string, filePath: string) => void;
	onGenerateCommitMessage: (project?: string) => void;
	onCommitStaged: (messages: GitOverlayProjectCommitMessage[]) => void;
	onCommitMessageChange: (project: string, value: string) => void;
	onTrackedBranchChange?: (trackedBranch: string) => void;
	t: (key: string) => string;
};

type SectionKey = 'step1' | 'step2' | 'step3' | 'step4';

type ProjectValidation = {
	available: boolean;
	hasChanges: boolean;
	hasConflicts: boolean;
	branchMismatch: boolean;
	needsMessage: boolean;
	committable: boolean;
};

function countProjectChanges(project: GitOverlayProjectSnapshot): number {
	return project.changeGroups.merge.length
		+ project.changeGroups.staged.length
		+ project.changeGroups.workingTree.length
		+ project.changeGroups.untracked.length;
}

function buildTrackedBranchOptions(snapshot: GitOverlaySnapshot | null): string[] {
	if (!snapshot) {
		return [];
	}

	if (snapshot.trackedBranches.length > 0) {
		return snapshot.trackedBranches;
	}

	return Array.from(new Set(
		snapshot.projects
			.flatMap(project => project.branches)
			.filter(branch => branch.kind === 'tracked')
			.map(branch => branch.name.trim())
			.filter(Boolean),
	));
}

function collectProjectChanges(project: GitOverlayProjectSnapshot): GitOverlayChangeFile[] {
	return [
		...project.changeGroups.merge,
		...project.changeGroups.staged,
		...project.changeGroups.workingTree,
		...project.changeGroups.untracked,
	];
}

function buildProjectChangesSummary(project: GitOverlayProjectSnapshot, t: (key: string) => string): string {
	const parts: string[] = [];

	if (project.changeGroups.merge.length > 0) {
		parts.push(`${t('editor.gitOverlayConflicts')}: ${project.changeGroups.merge.length}`);
	}
	if (project.changeGroups.staged.length > 0) {
		parts.push(`${t('editor.gitOverlayStaged')}: ${project.changeGroups.staged.length}`);
	}
	if (project.changeGroups.workingTree.length > 0) {
		parts.push(`${t('editor.gitOverlayWorkingTree')}: ${project.changeGroups.workingTree.length}`);
	}
	if (project.changeGroups.untracked.length > 0) {
		parts.push(`${t('editor.gitOverlayUntracked')}: ${project.changeGroups.untracked.length}`);
	}

	return parts.length > 0 ? parts.join(' • ') : t('editor.gitOverlayNoChanges');
}

function buildChangeGroupLabel(change: GitOverlayChangeFile, t: (key: string) => string): string {
	if (change.group === 'merge') {
		return t('editor.gitOverlayConflicts');
	}
	if (change.group === 'staged') {
		return t('editor.gitOverlayStaged');
	}
	if (change.group === 'working-tree') {
		return t('editor.gitOverlayWorkingTree');
	}
	return t('editor.gitOverlayUntracked');
}

function buildStatusLabel(status: string): string {
	const normalized = (status || '').trim().toUpperCase();
	if (normalized === 'A') {
		return 'A';
	}
	if (normalized === 'D') {
		return 'D';
	}
	if (normalized === 'R') {
		return 'R';
	}
	if (normalized === 'U') {
		return 'U';
	}
	if (normalized === 'C') {
		return 'C';
	}
	return 'M';
}

const ChevronIcon: React.FC<{ collapsed: boolean; disabled?: boolean }> = ({ collapsed, disabled = false }) => (
	<svg
		viewBox="0 0 16 16"
		aria-hidden="true"
		focusable="false"
		style={{
			...styles.sectionToggleIcon,
			...(collapsed ? styles.sectionToggleIconCollapsed : null),
			...(disabled ? styles.sectionToggleIconDisabled : null),
		}}
	>
		<path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
	</svg>
);

const RefreshIcon: React.FC = () => (
	<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={styles.headerIconSvg}>
		<path d="M13 4.5V1.5l-1.9 1.9A5.5 5.5 0 1 0 13.4 8h-1.8a3.7 3.7 0 1 1-1.05-2.6L8.9 7H13V4.5Z" fill="currentColor" />
	</svg>
);

const HintIcon: React.FC<{ tone: 'error' | 'info' }> = ({ tone }) => (
	<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={styles.inlineHintIconSvg}>
		{tone === 'error' ? (
			<path d="M8 1.4 15 14H1L8 1.4Zm0 4.1a.75.75 0 0 0-.75.75v3.2a.75.75 0 0 0 1.5 0v-3.2A.75.75 0 0 0 8 5.5Zm0 6.1a.95.95 0 1 0 0 1.9.95.95 0 0 0 0-1.9Z" fill="currentColor" />
		) : (
			<path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 2.2a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Zm1 8.1H7v-4h2v4Z" fill="currentColor" />
		)}
	</svg>
);

const HeaderIconButton: React.FC<{
	label: string;
	onClick: () => void;
	loading?: boolean;
}> = ({ label, onClick, loading = false }) => (
	<button
		type="button"
		onClick={onClick}
		disabled={loading}
		aria-busy={loading}
		title={label}
		aria-label={label}
		style={{
			...styles.headerIconButton,
			...(loading ? styles.headerIconButtonDisabled : null),
		}}
	>
		{loading ? <span style={styles.buttonSpinner} /> : <RefreshIcon />}
	</button>
);

const TextActionButton: React.FC<{
	label: string;
	onClick: () => void;
	tone?: 'default' | 'danger';
	disabled?: boolean;
	loading?: boolean;
}> = ({ label, onClick, tone = 'default', disabled = false, loading = false }) => (
	<button
		type="button"
		onClick={onClick}
		disabled={disabled || loading}
		aria-busy={loading}
		style={{
			...styles.changeActionLink,
			...(tone === 'danger' ? styles.changeActionLinkDanger : null),
			...((disabled || loading) ? styles.changeActionLinkDisabled : null),
		}}
	>
		<span style={styles.changeActionContent}>
			{loading ? <span style={styles.changeActionSpinner} /> : null}
			<span>{label}</span>
		</span>
	</button>
);

const ActionButton: React.FC<{
	label: string;
	onClick: () => void;
	disabled?: boolean;
	loading?: boolean;
	variant?: 'primary' | 'secondary';
	size?: 'default' | 'compact';
}> = ({ label, onClick, disabled = false, loading = false, variant = 'secondary', size = 'default' }) => (
	<button
		type="button"
		onClick={onClick}
		disabled={disabled || loading}
		aria-busy={loading}
		style={{
			...styles.actionButton,
			...(size === 'compact' ? styles.actionButtonCompact : null),
			...(variant === 'primary' ? styles.actionButtonPrimary : styles.actionButtonSecondary),
			...((disabled || loading) ? styles.actionButtonDisabled : null),
		}}
	>
		<span style={styles.actionButtonContent}>
			{loading ? <span style={styles.buttonSpinner} /> : null}
			<span>{label}</span>
		</span>
	</button>
);

const InlineHint: React.FC<{ message: string; tone?: 'error' | 'info' }> = ({ message, tone = 'info' }) => (
	<div style={{
		...styles.inlineHint,
		...(tone === 'error' ? styles.inlineHintError : styles.inlineHintInfo),
	}}>
		<span style={styles.inlineHintIconWrap}>
			<HintIcon tone={tone} />
		</span>
		<span style={styles.inlineHintText}>{message}</span>
	</div>
);

export const GitOverlay: React.FC<Props> = ({
	open,
	snapshot,
	commitMessages,
	busyAction,
	preferredTrackedBranch,
	onClose,
	onRefresh,
	onEnsurePromptBranch,
	onPush,
	onMergePromptBranch,
	onDiscardFile,
	onOpenFile,
	onOpenDiff,
	onOpenMergeEditor,
	onGenerateCommitMessage,
	onCommitStaged,
	onCommitMessageChange,
	onTrackedBranchChange,
	t,
}) => {
	const [selectedTrackedBranch, setSelectedTrackedBranch] = useState('');
	const [stayOnTrackedBranch, setStayOnTrackedBranch] = useState(true);
	const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
	const [collapsedSections, setCollapsedSections] = useState<Partial<Record<SectionKey, boolean>>>({});
	const userSelectedTrackedBranchRef = useRef(false);

	const trackedBranchOptions = useMemo(() => buildTrackedBranchOptions(snapshot), [snapshot]);
	const promptBranch = (snapshot?.promptBranch || '').trim();
	const availableProjects = useMemo(
		() => (snapshot?.projects || []).filter(project => project.available),
		[snapshot],
	);
	const projectsWithChanges = useMemo(
		() => (snapshot?.projects || []).filter(project => project.available && countProjectChanges(project) > 0),
		[snapshot],
	);
	const totalChangedFiles = useMemo(
		() => projectsWithChanges.reduce((sum, project) => sum + countProjectChanges(project), 0),
		[projectsWithChanges],
	);
	const projectsOffPromptBranch = useMemo(
		() => availableProjects.filter(project => !promptBranch || project.currentBranch !== promptBranch),
		[availableProjects, promptBranch],
	);
	const hasConflicts = useMemo(
		() => projectsWithChanges.some(project => project.changeGroups.merge.length > 0),
		[projectsWithChanges],
	);
	const allProjectsOnPromptBranch = Boolean(promptBranch) && availableProjects.length > 0 && projectsOffPromptBranch.length === 0;
	const promptBranchProjects = useMemo(
		() => availableProjects.filter(project => project.currentBranch === promptBranch),
		[availableProjects, promptBranch],
	);
	const projectsNeedingPush = useMemo(
		() => promptBranchProjects.filter(project => !project.upstream || project.ahead > 0),
		[promptBranchProjects],
	);

	const projectValidations = useMemo(() => {
		const result = new Map<string, ProjectValidation>();
		for (const project of snapshot?.projects || []) {
			const hasChanges = countProjectChanges(project) > 0;
			const hasConflictsForProject = project.changeGroups.merge.length > 0;
			const branchMismatch = project.available && (!promptBranch || project.currentBranch !== promptBranch);
			const message = (commitMessages[project.project] || '').trim();
			const needsMessage = project.available && hasChanges && !hasConflictsForProject && !branchMismatch && !message;
			result.set(project.project, {
				available: project.available,
				hasChanges,
				hasConflicts: hasConflictsForProject,
				branchMismatch,
				needsMessage,
				committable: project.available && hasChanges && !hasConflictsForProject && !branchMismatch && Boolean(message),
			});
		}
		return result;
	}, [snapshot, commitMessages, promptBranch]);

	const projectsReadyForGenerate = useMemo(
		() => projectsWithChanges.filter(project => {
			const validation = projectValidations.get(project.project);
			return Boolean(validation?.available && !validation.hasConflicts && !validation.branchMismatch);
		}),
		[projectValidations, projectsWithChanges],
	);
	const projectsReadyForCommit = useMemo(
		() => projectsWithChanges.filter(project => Boolean(projectValidations.get(project.project)?.committable)),
		[projectValidations, projectsWithChanges],
	);
	const allChangedProjectsReadyForCommit = projectsWithChanges.length > 0 && projectsReadyForCommit.length === projectsWithChanges.length;
	const canPreparePromptBranch = Boolean(promptBranch) && Boolean(selectedTrackedBranch);
	const canGenerateAllCommitMessages = projectsReadyForGenerate.length > 0;
	const canCommitAllProjects = allChangedProjectsReadyForCommit;
	const canAttemptPush = Boolean(promptBranch)
		&& projectsOffPromptBranch.length === 0
		&& !hasConflicts
		&& projectsWithChanges.length === 0;
	const pushRequired = canAttemptPush && projectsNeedingPush.length > 0;
	const canPush = pushRequired;
	const canMerge = Boolean(promptBranch)
		&& Boolean(selectedTrackedBranch)
		&& projectsOffPromptBranch.length === 0
		&& !hasConflicts
		&& projectsWithChanges.length === 0;
	const step1Pending = !promptBranch || projectsOffPromptBranch.length > 0;
	const step2Pending = !step1Pending && projectsWithChanges.length > 0;
	const step3Pending = !step1Pending && !step2Pending && pushRequired;
	const stepAvailability: Record<SectionKey, boolean> = {
		step1: true,
		step2: !step1Pending,
		step3: !step1Pending && !step2Pending,
		step4: !step1Pending && !step2Pending && !step3Pending,
	};
	const firstPendingStep = step1Pending ? 1 : step2Pending ? 2 : step3Pending ? 3 : null;
	const autoCollapsedSections = useMemo<Record<SectionKey, boolean>>(
		() => ({
			step1: false,
			step2: firstPendingStep !== null && 2 > firstPendingStep,
			step3: firstPendingStep !== null && 3 > firstPendingStep,
			step4: firstPendingStep !== null && 4 > firstPendingStep,
		}),
		[firstPendingStep],
	);

	useEffect(() => {
		if (!open) {
			return;
		}

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				onClose();
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [open, onClose]);

	useEffect(() => {
		if (!open) {
			userSelectedTrackedBranchRef.current = false;
		}
	}, [open]);

	const handleTrackedBranchSelection = useCallback((trackedBranch: string) => {
		userSelectedTrackedBranchRef.current = true;
		setSelectedTrackedBranch(trackedBranch);
		onTrackedBranchChange?.(trackedBranch);
	}, [onTrackedBranchChange]);

	useEffect(() => {
		if (trackedBranchOptions.length === 0) {
			setSelectedTrackedBranch('');
			return;
		}

		const normalizedPreferredTrackedBranch = (preferredTrackedBranch || '').trim();
		const preferredSelection = normalizedPreferredTrackedBranch && trackedBranchOptions.includes(normalizedPreferredTrackedBranch)
			? normalizedPreferredTrackedBranch
			: '';
		const currentTrackedBranch = availableProjects.find(project => trackedBranchOptions.includes(project.currentBranch))?.currentBranch;
		const nextSelection = preferredSelection || currentTrackedBranch || trackedBranchOptions[0];
		const hasValidSelection = trackedBranchOptions.includes(selectedTrackedBranch);
		const shouldApplyPreferredSelection = Boolean(preferredSelection)
			&& !userSelectedTrackedBranchRef.current
			&& selectedTrackedBranch !== preferredSelection;

		if (!hasValidSelection || shouldApplyPreferredSelection) {
			setSelectedTrackedBranch(nextSelection);
		}
	}, [availableProjects, preferredTrackedBranch, selectedTrackedBranch, trackedBranchOptions]);

	useEffect(() => {
		if (!snapshot) {
			setExpandedProjects({});
			setCollapsedSections({});
			return;
		}

		setExpandedProjects((prev) => {
			const next: Record<string, boolean> = {};
			for (const project of snapshot.projects) {
				const validation = projectValidations.get(project.project);
				const defaultOpen = Boolean(
					validation?.hasChanges
					&& (
						validation.branchMismatch
						|| validation.hasConflicts
						|| validation.needsMessage
						|| projectsWithChanges.length === 1
					)
				);
				next[project.project] = prev[project.project] ?? defaultOpen;
			}
			return next;
		});
	}, [projectValidations, projectsWithChanges.length, snapshot]);

	if (!open) {
		return null;
	}

	const isLoadingOverlay = busyAction === 'overlay:loading' && !snapshot;
	const isRefreshing = busyAction === 'refresh:local';
	const isEnsuringPromptBranch = busyAction === 'ensurePromptBranch';
	const isPushing = busyAction === 'pushPromptBranch';
	const isMerging = busyAction === 'mergePromptBranch';
	const isGeneratingAll = busyAction === 'generateCommitMessage:all';
	const isCommittingAll = busyAction === 'commitStaged:all';
	const stayOnTrackedBranchLabel = t('editor.gitOverlayStayOnTrackedBranchNamed').replace('{branch}', selectedTrackedBranch || t('editor.gitOverlayTrackedBranchMissing'));
	const isSectionCollapsed = (section: SectionKey): boolean => collapsedSections[section] ?? autoCollapsedSections[section];
	const isSectionAutoCollapsed = (section: SectionKey): boolean => collapsedSections[section] === undefined && autoCollapsedSections[section];

	const commitAllMessages = projectsWithChanges
		.map((project) => ({
			project: project.project,
			message: (commitMessages[project.project] || '').trim(),
		}))
		.filter(item => Boolean(item.message));

	const toggleProject = (projectName: string) => {
		setExpandedProjects((prev) => ({
			...prev,
			[projectName]: !prev[projectName],
		}));
	};

	const toggleSectionCollapse = (section: SectionKey) => {
		setCollapsedSections((prev) => ({
			...prev,
			[section]: !(prev[section] ?? autoCollapsedSections[section]),
		}));
	};

	return (
		<div style={styles.backdrop} onClick={onClose}>
			<div style={styles.dialog} onClick={(event) => event.stopPropagation()}>
				<div style={styles.header}>
					<div style={styles.headerInfo}>
						<h2 style={styles.headerTitle}>{t('editor.gitOverlayTitle')}</h2>
						<div style={styles.headerSubtitle}>{t('editor.gitOverlaySubtitle')}</div>
					</div>
					<div style={styles.headerActions}>
						<HeaderIconButton label={t('editor.gitOverlayRefresh')} onClick={() => onRefresh('local')} loading={isRefreshing} />
						<ActionButton label={t('common.close')} onClick={onClose} />
					</div>
				</div>

				{!snapshot ? (
					<div style={styles.loadingWrap}>
						<div style={styles.loadingCard}>
							{isLoadingOverlay ? <span style={styles.largeSpinner} /> : null}
							<div style={styles.loadingText}>{isLoadingOverlay ? t('editor.gitOverlayLoading') : t('editor.gitOverlayEmpty')}</div>
						</div>
					</div>
				) : (
					<div style={styles.body}>
						<div style={styles.summaryRow}>
							<div style={styles.summaryChip}>{`${t('editor.gitOverlayProjects')}: ${snapshot.projects.length}`}</div>
							<div style={styles.summaryChip}>{`${t('editor.gitOverlayProjectsWithChanges')}: ${projectsWithChanges.length}`}</div>
							<div style={styles.summaryChip}>{`${t('editor.gitOverlayProjectChanges')}: ${totalChangedFiles}`}</div>
							<div style={styles.summaryChip}>{`${t('editor.gitOverlayConflicts')}: ${projectsWithChanges.filter(project => project.changeGroups.merge.length > 0).length}`}</div>
						</div>

						<section style={styles.sectionCard}>
							<div style={styles.sectionHeader}>
								<div style={styles.sectionHeaderLeft}>
									<div style={{ ...styles.sectionNumber, ...(stepAvailability.step1 ? null : styles.sectionNumberDisabled) }}>1</div>
									<div>
										<div style={styles.sectionTitle}>{t('editor.gitOverlayStepSwitchTitle')}</div>
										<div style={styles.sectionSubtitle}>{t('editor.gitOverlayStepSwitchHint')}</div>
									</div>
								</div>
								<button
									type="button"
									onClick={() => toggleSectionCollapse('step1')}
									style={styles.sectionToggleButton}
									title={isSectionCollapsed('step1') ? t('editor.gitOverlayExpandSection') : t('editor.gitOverlayCollapseSection')}
									aria-label={isSectionCollapsed('step1') ? t('editor.gitOverlayExpandSection') : t('editor.gitOverlayCollapseSection')}
								>
									<ChevronIcon collapsed={isSectionCollapsed('step1')} disabled={!stepAvailability.step1} />
								</button>
							</div>
							{isSectionCollapsed('step1') ? (
								isSectionAutoCollapsed('step1') ? <div style={styles.collapsedSectionHint}>{t('editor.gitOverlayWaitingPreviousStep')}</div> : null
							) : (
							<div style={styles.sectionBody}>
								<div style={styles.twoColGrid}>
									<div style={styles.fieldBlock}>
										<label style={styles.label}>{t('editor.gitOverlayTrackedBranch')}</label>
										<select
											style={{
												...styles.select,
												...(!selectedTrackedBranch ? styles.errorField : null),
											}}
											value={selectedTrackedBranch}
											onChange={(event) => handleTrackedBranchSelection(event.target.value)}
										>
											<option value="">{t('editor.gitOverlayTrackedBranchMissing')}</option>
											{trackedBranchOptions.map(branch => (
												<option key={branch} value={branch}>{branch}</option>
											))}
										</select>
										{!selectedTrackedBranch ? <div style={styles.errorText}>{t('editor.gitOverlaySelectNeedsValue')}</div> : null}
									</div>

									<div style={styles.fieldBlock}>
										<label style={styles.label}>{t('editor.gitOverlayPromptBranch')}</label>
										<div style={{
											...styles.readonlyField,
											...(!promptBranch ? styles.errorField : null),
										}}>
											{promptBranch || t('editor.gitOverlayPromptBranchMissing')}
										</div>
										{!promptBranch ? <div style={styles.errorText}>{t('editor.gitOverlayFieldNeedsValue')}</div> : null}
									</div>
								</div>

								{trackedBranchOptions.length === 0 ? <InlineHint message={t('editor.gitOverlayNoTrackedBranches')} tone="error" /> : null}
								{projectsOffPromptBranch.length > 0 ? <InlineHint message={t('editor.gitOverlayProjectNeedsSwitch')} tone="error" /> : null}

								<div style={styles.projectTable}>
									<div style={styles.projectTableHeader}>
										<span>{t('editor.gitOverlayProjectName')}</span>
										<span>{t('editor.gitOverlayProjectCurrentBranch')}</span>
										<span>{t('editor.gitOverlayProjectTargetBranch')}</span>
										<span>{t('editor.gitOverlayProjectChanges')}</span>
										<span>{t('editor.gitOverlayProjectState')}</span>
									</div>
									{snapshot.projects.map((project) => {
										const validation = projectValidations.get(project.project);
										const rowHasError = !project.available || Boolean(validation?.branchMismatch);
										return (
											<div key={project.project} style={{
												...styles.projectTableRow,
												...(rowHasError ? styles.projectTableRowError : null),
											}}>
												<span style={styles.projectName}>{project.project}</span>
												<span style={{
													...styles.branchValue,
													...(validation?.branchMismatch ? styles.branchValueError : null),
												}}>
													{project.currentBranch || '—'}
												</span>
												<span style={styles.branchValue}>{promptBranch || '—'}</span>
												<span style={styles.projectMeta}>{buildProjectChangesSummary(project, t)}</span>
												<span style={{
													...styles.statePill,
													...(!project.available ? styles.statePillMuted : validation?.branchMismatch ? styles.statePillError : styles.statePillOk),
												}}>
													{!project.available
														? t('editor.gitOverlayStateUnavailable')
														: validation?.branchMismatch
															? t('editor.gitOverlayStateNeedsSwitch')
															: t('editor.gitOverlayStateReady')}
												</span>
											</div>
										);
									})}
								</div>

								<div style={styles.actionRowEnd}>
									{allProjectsOnPromptBranch ? <span style={styles.successText}>{t('editor.gitOverlayAllProjectsOnPrompt')}</span> : null}
									<ActionButton
										label={t('editor.gitOverlaySwitchAllToPrompt')}
										onClick={() => onEnsurePromptBranch(selectedTrackedBranch)}
										disabled={!canPreparePromptBranch}
										loading={isEnsuringPromptBranch}
										variant="primary"
									/>
								</div>
							</div>
							)}
						</section>

						<section style={styles.sectionCard}>
							<div style={styles.sectionHeader}>
								<div style={styles.sectionHeaderLeft}>
									<div style={{ ...styles.sectionNumber, ...(stepAvailability.step2 ? null : styles.sectionNumberDisabled) }}>2</div>
									<div>
										<div style={styles.sectionTitle}>{t('editor.gitOverlayStepCommitTitle')}</div>
										<div style={styles.sectionSubtitle}>{t('editor.gitOverlayStepCommitHint')}</div>
									</div>
								</div>
								<button
									type="button"
									onClick={() => toggleSectionCollapse('step2')}
									style={styles.sectionToggleButton}
									title={isSectionCollapsed('step2') ? t('editor.gitOverlayExpandSection') : t('editor.gitOverlayCollapseSection')}
									aria-label={isSectionCollapsed('step2') ? t('editor.gitOverlayExpandSection') : t('editor.gitOverlayCollapseSection')}
								>
									<ChevronIcon collapsed={isSectionCollapsed('step2')} disabled={!stepAvailability.step2} />
								</button>
							</div>
							{isSectionCollapsed('step2') ? (
								isSectionAutoCollapsed('step2') ? <div style={styles.collapsedSectionHint}>{t('editor.gitOverlayWaitingPreviousStep')}</div> : null
							) : (
							<div style={styles.sectionBody}>
								{projectsWithChanges.length === 0 ? <div style={styles.emptyStateInline}>{t('editor.gitOverlayNoProjectsWithChanges')}</div> : null}
								{projectsWithChanges.length > 0 && !allChangedProjectsReadyForCommit ? <InlineHint message={t('editor.gitOverlayAllProjectsMustBeReady')} tone="error" /> : null}

								<div style={styles.projectCards}>
									{projectsWithChanges.map((project) => {
										const validation = projectValidations.get(project.project);
										const projectCommitMessage = commitMessages[project.project] || '';
										const projectChanges = collectProjectChanges(project);
										const isGeneratingProject = busyAction === `generateCommitMessage:${project.project}`;
										const isCommittingProject = busyAction === `commitStaged:${project.project}`;
										const expanded = Boolean(expandedProjects[project.project]);
										return (
											<div key={project.project} style={styles.projectCard}>
												<div style={styles.projectCardHeader}>
													<div style={styles.projectCardTitleWrap}>
														<div style={styles.projectCardTitle}>{project.project}</div>
														<div style={styles.projectCardSummary}>{buildProjectChangesSummary(project, t)}</div>
													</div>
													<div style={styles.projectCardHeaderActions}>
														<button type="button" onClick={() => toggleProject(project.project)} style={styles.linkButton}>
															{expanded ? t('editor.gitOverlayHideChanges') : t('editor.gitOverlayShowChanges')}
														</button>
													</div>
												</div>

												{expanded ? (
													<div style={styles.projectChangesWrap}>
														<div style={styles.projectChangesTitle}>{t('editor.gitOverlayChangedFiles')}</div>
														<div style={styles.changeList}>
															{projectChanges.map((change, index) => {
																const isDiscarding = busyAction === `discardFile:${project.project}:${change.group}:${change.path}`;

																return (
																	<div
																		key={`${project.project}-${change.group}-${change.path}-${change.status}`}
																		style={{
																			...styles.changeRow,
																			...(index > 0 ? styles.changeRowBorderTop : null),
																		}}
																	>
																		<div style={styles.changeInfo} title={change.previousPath ? `${change.previousPath} -> ${change.path}` : change.path}>
																			<div style={styles.changeBadges}>
																				<span style={styles.changeStatusBadge}>{buildStatusLabel(change.status)}</span>
																				<span style={styles.changeGroupBadge}>{buildChangeGroupLabel(change, t)}</span>
																			</div>
																			<div style={styles.changePathGroup}>
																				<div style={styles.changePath}>{change.path}</div>
																				{change.previousPath ? <div style={styles.changePreviousPath}>{`← ${change.previousPath}`}</div> : null}
																			</div>
																		</div>
																		<div style={styles.changeActions}>
																			<TextActionButton
																				label={t('editor.gitOverlayDiscardFile')}
																				onClick={() => onDiscardFile(project.project, change.path, change.group, change.previousPath)}
																				tone="danger"
																				loading={isDiscarding}
																			/>
																			<TextActionButton label={t('editor.gitOverlayOpenFile')} onClick={() => onOpenFile(project.project, change.path)} disabled={isDiscarding} />
																			<TextActionButton label={t('editor.gitOverlayOpenDiff')} onClick={() => onOpenDiff(project.project, change.path)} disabled={isDiscarding} />
																			{change.conflicted ? <TextActionButton label={t('editor.gitOverlayOpenMergeEditor')} onClick={() => onOpenMergeEditor(project.project, change.path)} disabled={isDiscarding} /> : null}
																		</div>
																	</div>
																);
															})}
														</div>
													</div>
												) : null}

												{!validation?.available ? <InlineHint message={t('editor.gitOverlayProjectUnavailableHint')} tone="error" /> : null}
												{validation?.branchMismatch ? <InlineHint message={t('editor.gitOverlayProjectNeedsSwitch')} tone="error" /> : null}
												{validation?.hasConflicts ? <InlineHint message={t('editor.gitOverlayProjectHasConflicts')} tone="error" /> : null}
												{validation?.needsMessage ? <InlineHint message={t('editor.gitOverlayCommitMessageRequired')} tone="error" /> : null}

												<div style={styles.fieldBlock}>
													<label style={styles.label}>{t('editor.gitOverlayCommit')}</label>
													<textarea
														style={{
															...styles.textArea,
															...(validation?.needsMessage ? styles.errorField : null),
														}}
														value={projectCommitMessage}
														onChange={(event) => onCommitMessageChange(project.project, event.target.value)}
														placeholder={t('editor.gitOverlayCommitPlaceholder')}
														rows={3}
													/>
												</div>

												<div style={styles.projectCardFooter}>
													<ActionButton
														label={t('editor.gitOverlayGenerateCommitMessage')}
														onClick={() => onGenerateCommitMessage(project.project)}
														disabled={!validation?.available || validation.branchMismatch || validation.hasConflicts}
														loading={isGeneratingProject}
													/>
													<ActionButton
														label={t('editor.gitOverlayCommitProject')}
														onClick={() => onCommitStaged([{ project: project.project, message: projectCommitMessage.trim() }])}
														disabled={!validation?.committable}
														loading={isCommittingProject}
														variant="primary"
													/>
												</div>
											</div>
										);
									})}
								</div>

								<div style={styles.actionRowEnd}>
									<ActionButton
										label={t('editor.gitOverlayGenerateAllCommitMessages')}
										onClick={() => onGenerateCommitMessage()}
										disabled={!canGenerateAllCommitMessages}
										loading={isGeneratingAll}
									/>
									<ActionButton
										label={t('editor.gitOverlayCommitAll')}
										onClick={() => onCommitStaged(commitAllMessages)}
										disabled={!canCommitAllProjects}
										loading={isCommittingAll}
										variant="primary"
									/>
								</div>
							</div>
							)}
						</section>

						<section style={styles.sectionCard}>
							<div style={styles.sectionHeader}>
								<div style={styles.sectionHeaderLeft}>
									<div style={{ ...styles.sectionNumber, ...(stepAvailability.step3 ? null : styles.sectionNumberDisabled) }}>3</div>
									<div>
										<div style={styles.sectionTitle}>{t('editor.gitOverlayStepPushTitle')}</div>
										<div style={styles.sectionSubtitle}>{t('editor.gitOverlayStepPushHint')}</div>
									</div>
								</div>
								<button
									type="button"
									onClick={() => toggleSectionCollapse('step3')}
									style={styles.sectionToggleButton}
									title={isSectionCollapsed('step3') ? t('editor.gitOverlayExpandSection') : t('editor.gitOverlayCollapseSection')}
									aria-label={isSectionCollapsed('step3') ? t('editor.gitOverlayExpandSection') : t('editor.gitOverlayCollapseSection')}
								>
									<ChevronIcon collapsed={isSectionCollapsed('step3')} disabled={!stepAvailability.step3} />
								</button>
							</div>
							{isSectionCollapsed('step3') ? (
								isSectionAutoCollapsed('step3') ? <div style={styles.collapsedSectionHint}>{t('editor.gitOverlayWaitingPreviousStep')}</div> : null
							) : (
							<div style={styles.sectionBody}>
								{!promptBranch ? <InlineHint message={t('editor.gitOverlayPushNeedsPromptBranch')} tone="error" /> : null}
								{projectsOffPromptBranch.length > 0 ? <InlineHint message={t('editor.gitOverlayPushNeedsPromptCheckout')} tone="error" /> : null}
								{projectsWithChanges.length > 0 ? <InlineHint message={t('editor.gitOverlayPushNeedsCleanState')} tone="error" /> : null}
								{hasConflicts ? <InlineHint message={t('editor.gitOverlayMergeBlocked')} tone="error" /> : null}

								<div style={styles.mergeHint}>{t('editor.gitOverlayPushHintDetail')}</div>
								{canAttemptPush && !pushRequired ? <div style={styles.successText}>{t('editor.gitOverlayPushAlreadyPublished')}</div> : null}

								<div style={styles.actionRowEnd}>
									<ActionButton
										label={t('editor.gitOverlayPushPromptBranch')}
										onClick={() => onPush(promptBranch)}
										disabled={!canPush}
										loading={isPushing}
										variant="primary"
									/>
								</div>
							</div>
							)}
						</section>

						<section style={styles.sectionCard}>
							<div style={styles.sectionHeader}>
								<div style={styles.sectionHeaderLeft}>
									<div style={{ ...styles.sectionNumber, ...(stepAvailability.step4 ? null : styles.sectionNumberDisabled) }}>4</div>
									<div>
										<div style={styles.sectionTitle}>{t('editor.gitOverlayStepMergeTitle')}</div>
										<div style={styles.sectionSubtitle}>{t('editor.gitOverlayStepMergeHint')}</div>
									</div>
								</div>
								<button
									type="button"
									onClick={() => toggleSectionCollapse('step4')}
									style={styles.sectionToggleButton}
									title={isSectionCollapsed('step4') ? t('editor.gitOverlayExpandSection') : t('editor.gitOverlayCollapseSection')}
									aria-label={isSectionCollapsed('step4') ? t('editor.gitOverlayExpandSection') : t('editor.gitOverlayCollapseSection')}
								>
									<ChevronIcon collapsed={isSectionCollapsed('step4')} disabled={!stepAvailability.step4} />
								</button>
							</div>
							{isSectionCollapsed('step4') ? (
								isSectionAutoCollapsed('step4') ? <div style={styles.collapsedSectionHint}>{t('editor.gitOverlayWaitingPreviousStep')}</div> : null
							) : (
							<div style={styles.sectionBody}>
								<label style={styles.checkboxRow}>
									<input
										type="checkbox"
										checked={stayOnTrackedBranch}
										onChange={(event) => setStayOnTrackedBranch(event.target.checked)}
									/>
									<span>{stayOnTrackedBranchLabel}</span>
								</label>

								{!promptBranch ? <InlineHint message={t('editor.gitOverlayMergeNeedsPromptBranch')} tone="error" /> : null}
								{!selectedTrackedBranch ? <InlineHint message={t('editor.gitOverlayMergeNeedsTrackedBranch')} tone="error" /> : null}
								{projectsOffPromptBranch.length > 0 ? <InlineHint message={t('editor.gitOverlayMergeNeedsPromptCheckout')} tone="error" /> : null}
								{projectsWithChanges.length > 0 ? <InlineHint message={t('editor.gitOverlayMergeNeedsCleanState')} tone="error" /> : null}
								{hasConflicts ? <InlineHint message={t('editor.gitOverlayMergeBlocked')} tone="error" /> : null}

								<div style={styles.mergeHint}>
									{stayOnTrackedBranch ? t('editor.gitOverlayStayOnTrackedBranchHint') : t('editor.gitOverlayReturnToPromptBranchHint')}
								</div>

								<div style={styles.actionRowEnd}>
									<ActionButton
										label={t('editor.gitOverlayMergeNow')}
										onClick={() => onMergePromptBranch(selectedTrackedBranch, stayOnTrackedBranch)}
										disabled={!canMerge}
										loading={isMerging}
										variant="primary"
									/>
								</div>
							</div>
							)}
						</section>
					</div>
				)}
			</div>
		</div>
	);
};

const styles: Record<string, CSSProperties> = {
	backdrop: {
		position: 'absolute',
		top: 0,
		bottom: 0,
		left: 0,
		width: '840px',
		maxWidth: '100%',
		zIndex: 1000,
		padding: '20px 16px',
		boxSizing: 'border-box',
		background: 'rgba(0, 0, 0, 0.38)',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
	},
	dialog: {
		width: 'min(1040px, 100%)',
		height: 'min(92vh, 100%)',
		background: 'var(--vscode-editor-background)',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '6px',
		boxShadow: '0 20px 60px rgba(0, 0, 0, 0.35)',
		display: 'flex',
		flexDirection: 'column',
		overflow: 'hidden',
	},
	header: {
		display: 'flex',
		alignItems: 'flex-start',
		justifyContent: 'space-between',
		gap: '12px',
		padding: '12px 16px',
		borderBottom: '1px solid var(--vscode-panel-border)',
		background: 'var(--vscode-editor-background)',
	},
	headerInfo: {
		minWidth: 0,
		flex: 1,
	},
	headerTitle: {
		margin: 0,
		fontSize: '16px',
		fontWeight: 600,
	},
	headerSubtitle: {
		marginTop: '4px',
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
		lineHeight: 1.5,
	},
	headerActions: {
		display: 'flex',
		gap: '8px',
		alignItems: 'center',
		flexWrap: 'wrap',
	},
	headerIconButton: {
		width: '32px',
		height: '32px',
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		background: 'var(--vscode-button-secondaryBackground)',
		color: 'var(--vscode-button-secondaryForeground)',
		border: '1px solid var(--vscode-button-border, transparent)',
		borderRadius: '4px',
		cursor: 'pointer',
		padding: 0,
	},
	headerIconButtonDisabled: {
		opacity: 0.7,
		cursor: 'progress',
	},
	headerIconSvg: {
		width: '16px',
		height: '16px',
		display: 'block',
	},
	loadingWrap: {
		flex: 1,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '20px',
	},
	loadingCard: {
		minWidth: '280px',
		padding: '24px',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '6px',
		background: 'var(--vscode-editor-background)',
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		gap: '12px',
	},
	largeSpinner: {
		width: '26px',
		height: '26px',
		border: '3px solid var(--vscode-button-background)',
		borderRightColor: 'transparent',
		borderRadius: '50%',
		opacity: 0.75,
		animation: 'pm-spin 0.8s linear infinite',
	},
	loadingText: {
		fontSize: '13px',
		color: 'var(--vscode-descriptionForeground)',
	},
	body: {
		flex: 1,
		minHeight: 0,
		overflowY: 'auto',
		padding: '16px',
		display: 'flex',
		flexDirection: 'column',
		gap: '12px',
	},
	summaryRow: {
		display: 'flex',
		gap: '8px',
		flexWrap: 'wrap',
	},
	summaryChip: {
		fontSize: '11px',
		color: 'var(--vscode-foreground)',
		background: 'var(--vscode-badge-background)',
		borderRadius: '4px',
		padding: '2px 8px',
	},
	sectionCard: {
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '6px',
		background: 'var(--vscode-editor-background)',
		overflow: 'hidden',
	},
	sectionHeader: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
		gap: '10px',
		padding: '10px 12px',
		background: 'var(--vscode-sideBar-background)',
		borderBottom: '1px solid var(--vscode-panel-border)',
	},
	sectionHeaderLeft: {
		display: 'flex',
		alignItems: 'flex-start',
		gap: '8px',
		minWidth: 0,
	},
	sectionNumber: {
		width: '20px',
		height: '20px',
		borderRadius: '50%',
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		background: 'var(--vscode-button-background)',
		color: 'var(--vscode-button-foreground)',
		fontSize: '11px',
		fontWeight: 700,
		flexShrink: 0,
	},
	sectionNumberDisabled: {
		background: 'var(--vscode-badge-background)',
		color: 'var(--vscode-descriptionForeground)',
	},
	sectionTitle: {
		fontSize: '13px',
		fontWeight: 600,
	},
	sectionSubtitle: {
		marginTop: '4px',
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
		lineHeight: 1.5,
	},
	sectionBody: {
		display: 'flex',
		flexDirection: 'column',
		gap: '12px',
		padding: '12px',
	},
	sectionToggleButton: {
		width: '28px',
		height: '28px',
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		background: 'transparent',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '4px',
		color: 'var(--vscode-foreground)',
		cursor: 'pointer',
		padding: 0,
		flexShrink: 0,
	},
	sectionToggleIcon: {
		width: '16px',
		height: '16px',
		transition: 'transform 140ms ease, opacity 140ms ease',
	},
	sectionToggleIconCollapsed: {
		transform: 'rotate(-90deg)',
	},
	sectionToggleIconDisabled: {
		opacity: 0.5,
	},
	collapsedSectionHint: {
		padding: '10px 12px',
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
		fontStyle: 'italic',
	},
	twoColGrid: {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '12px',
	},
	fieldBlock: {
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
	},
	label: {
		fontSize: '12px',
		fontWeight: 500,
		color: 'var(--vscode-foreground)',
	},
	readonlyField: {
		padding: '6px 8px',
		background: 'var(--vscode-input-background)',
		color: 'var(--vscode-input-foreground)',
		border: '1px solid var(--vscode-input-border, transparent)',
		borderRadius: '4px',
		fontSize: '13px',
		fontFamily: 'var(--vscode-font-family)',
		minHeight: '32px',
		boxSizing: 'border-box',
		display: 'flex',
		alignItems: 'center',
	},
	select: {
		padding: '6px 8px',
		background: 'var(--vscode-input-background)',
		color: 'var(--vscode-input-foreground)',
		border: '1px solid var(--vscode-input-border, transparent)',
		borderRadius: '4px',
		fontSize: '13px',
		fontFamily: 'var(--vscode-font-family)',
		minHeight: '32px',
	},
	textArea: {
		width: '100%',
		padding: '8px',
		background: 'var(--vscode-input-background)',
		color: 'var(--vscode-input-foreground)',
		border: '1px solid var(--vscode-input-border, transparent)',
		borderRadius: '4px',
		fontSize: '13px',
		fontFamily: 'var(--vscode-font-family)',
		lineHeight: 1.5,
		resize: 'vertical',
		boxSizing: 'border-box',
	},
	errorField: {
		borderColor: 'var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground))',
		background: 'var(--vscode-inputValidation-errorBackground, var(--vscode-input-background))',
	},
	errorText: {
		fontSize: '11px',
		color: 'var(--vscode-errorForeground)',
	},
	actionRow: {
		display: 'flex',
		gap: '8px',
		flexWrap: 'wrap',
		alignItems: 'center',
	},
	actionRowEnd: {
		display: 'flex',
		gap: '8px',
		flexWrap: 'wrap',
		alignItems: 'center',
		justifyContent: 'flex-end',
	},
	actionButton: {
		minHeight: '32px',
		padding: '0 10px',
		borderRadius: '4px',
		cursor: 'pointer',
		fontSize: '12px',
		fontFamily: 'var(--vscode-font-family)',
		whiteSpace: 'nowrap',
		border: '1px solid var(--vscode-button-border, transparent)',
	},
	actionButtonCompact: {
		minHeight: '24px',
		padding: '0 8px',
		fontSize: '11px',
	},
	actionButtonPrimary: {
		background: 'var(--vscode-button-background)',
		color: 'var(--vscode-button-foreground)',
	},
	actionButtonSecondary: {
		background: 'var(--vscode-button-secondaryBackground)',
		color: 'var(--vscode-button-secondaryForeground)',
	},
	actionButtonDisabled: {
		opacity: 0.6,
		cursor: 'not-allowed',
	},
	actionButtonContent: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '6px',
	},
	buttonSpinner: {
		width: '12px',
		height: '12px',
		border: '2px solid currentColor',
		borderRightColor: 'transparent',
		borderRadius: '50%',
		opacity: 0.75,
		animation: 'pm-spin 0.8s linear infinite',
	},
	inlineHint: {
		display: 'flex',
		alignItems: 'flex-start',
		gap: '8px',
		padding: '8px 10px',
		borderRadius: '4px',
		fontSize: '12px',
		lineHeight: 1.5,
		border: '1px solid transparent',
	},
	inlineHintIconWrap: {
		width: '14px',
		height: '14px',
		marginTop: '1px',
		flexShrink: 0,
	},
	inlineHintIconSvg: {
		width: '14px',
		height: '14px',
		display: 'block',
	},
	inlineHintText: {
		flex: 1,
		minWidth: 0,
	},
	inlineHintError: {
		background: 'var(--vscode-inputValidation-errorBackground)',
		color: 'var(--vscode-errorForeground)',
		borderColor: 'var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground))',
	},
	inlineHintInfo: {
		background: 'var(--vscode-inputValidation-infoBackground)',
		color: 'var(--vscode-foreground)',
		borderColor: 'var(--vscode-inputValidation-infoBorder, var(--vscode-panel-border))',
	},
	successText: {
		fontSize: '12px',
		color: 'var(--vscode-testing-iconPassed)',
	},
	projectTable: {
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '4px',
		overflow: 'hidden',
	},
	projectTableHeader: {
		display: 'grid',
		gridTemplateColumns: 'minmax(120px, 1fr) minmax(120px, 0.9fr) minmax(120px, 0.9fr) minmax(220px, 1.3fr) minmax(120px, 0.8fr)',
		gap: '8px',
		padding: '8px 10px',
		fontSize: '11px',
		fontWeight: 600,
		background: 'var(--vscode-sideBar-background)',
		color: 'var(--vscode-descriptionForeground)',
	},
	projectTableRow: {
		display: 'grid',
		gridTemplateColumns: 'minmax(120px, 1fr) minmax(120px, 0.9fr) minmax(120px, 0.9fr) minmax(220px, 1.3fr) minmax(120px, 0.8fr)',
		gap: '8px',
		padding: '10px',
		alignItems: 'center',
		borderTop: '1px solid var(--vscode-panel-border)',
	},
	projectTableRowError: {
		background: 'color-mix(in srgb, var(--vscode-inputValidation-errorBackground) 50%, transparent)',
	},
	projectName: {
		fontSize: '13px',
		fontWeight: 600,
		wordBreak: 'break-word',
	},
	branchValue: {
		fontSize: '12px',
		color: 'var(--vscode-foreground)',
		wordBreak: 'break-word',
	},
	branchValueError: {
		color: 'var(--vscode-errorForeground)',
		fontWeight: 600,
	},
	projectMeta: {
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
		wordBreak: 'break-word',
	},
	statePill: {
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '2px 8px',
		borderRadius: '999px',
		fontSize: '11px',
		fontWeight: 600,
		width: 'fit-content',
	},
	statePillOk: {
		background: 'var(--vscode-inputValidation-infoBackground)',
		color: 'var(--vscode-testing-iconPassed)',
	},
	statePillError: {
		background: 'var(--vscode-inputValidation-errorBackground)',
		color: 'var(--vscode-errorForeground)',
	},
	statePillMuted: {
		background: 'var(--vscode-badge-background)',
		color: 'var(--vscode-descriptionForeground)',
	},
	emptyStateInline: {
		padding: '10px',
		border: '1px dashed var(--vscode-panel-border)',
		borderRadius: '4px',
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
	},
	projectCards: {
		display: 'flex',
		flexDirection: 'column',
		gap: '12px',
	},
	projectCard: {
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '6px',
		padding: '12px',
		display: 'flex',
		flexDirection: 'column',
		gap: '10px',
	},
	projectCardHeader: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'flex-start',
		gap: '12px',
		flexWrap: 'wrap',
	},
	projectCardTitleWrap: {
		minWidth: 0,
		flex: 1,
	},
	projectCardTitle: {
		fontSize: '13px',
		fontWeight: 600,
	},
	projectCardSummary: {
		marginTop: '4px',
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
		lineHeight: 1.5,
	},
	projectCardActions: {
		display: 'flex',
		gap: '8px',
		alignItems: 'center',
		flexWrap: 'wrap',
		justifyContent: 'flex-end',
	},
	projectCardHeaderActions: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'flex-end',
		flexShrink: 0,
	},
	linkButton: {
		background: 'none',
		border: 'none',
		color: 'var(--vscode-textLink-foreground)',
		cursor: 'pointer',
		fontSize: '12px',
		padding: '4px 0',
		fontFamily: 'var(--vscode-font-family)',
	},
	projectStatusRow: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		flexWrap: 'wrap',
	},
	projectStatusText: {
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
	},
	projectChangesWrap: {
		display: 'flex',
		flexDirection: 'column',
		gap: '6px',
	},
	projectChangesTitle: {
		fontSize: '12px',
		fontWeight: 600,
	},
	projectCardFooter: {
		display: 'flex',
		gap: '8px',
		justifyContent: 'flex-start',
		flexWrap: 'wrap',
	},
	changeList: {
		display: 'flex',
		flexDirection: 'column',
		gap: 0,
		borderRadius: '4px',
		overflow: 'hidden',
		background: 'var(--vscode-input-background)',
		border: '1px solid var(--vscode-panel-border)',
	},
	changeRow: {
		display: 'grid',
		gridTemplateColumns: 'minmax(0, 1fr) auto',
		justifyContent: 'space-between',
		alignItems: 'center',
		gap: '8px',
		padding: '7px 8px',
		background: 'transparent',
	},
	changeRowBorderTop: {
		borderTop: '1px solid var(--vscode-panel-border)',
	},
	changeInfo: {
		minWidth: 0,
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
	},
	changeBadges: {
		display: 'inline-flex',
		gap: '4px',
		flexWrap: 'nowrap',
		marginBottom: 0,
		flexShrink: 0,
	},
	changeStatusBadge: {
		padding: '2px 6px',
		borderRadius: '4px',
		background: 'var(--vscode-badge-background)',
		fontSize: '11px',
		fontWeight: 600,
	},
	changeGroupBadge: {
		padding: '2px 6px',
		borderRadius: '4px',
		background: 'var(--vscode-inputValidation-infoBackground)',
		fontSize: '11px',
	},
	changePathGroup: {
		minWidth: 0,
		display: 'flex',
		alignItems: 'center',
		gap: '6px',
		overflow: 'hidden',
	},
	changePath: {
		fontSize: '12px',
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	},
	changePreviousPath: {
		fontSize: '11px',
		color: 'var(--vscode-descriptionForeground)',
		minWidth: 0,
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	},
	changeActions: {
		display: 'inline-flex',
		gap: '10px',
		alignItems: 'center',
		flexWrap: 'nowrap',
		justifyContent: 'flex-end',
		flexShrink: 0,
	},
	changeActionLink: {
		background: 'none',
		border: 'none',
		padding: 0,
		color: 'var(--vscode-textLink-foreground)',
		cursor: 'pointer',
		fontSize: '12px',
		fontFamily: 'var(--vscode-font-family)',
		whiteSpace: 'nowrap',
	},
	changeActionLinkDanger: {
		color: 'var(--vscode-errorForeground)',
	},
	changeActionLinkDisabled: {
		opacity: 0.6,
		cursor: 'not-allowed',
	},
	changeActionContent: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '5px',
	},
	changeActionSpinner: {
		width: '10px',
		height: '10px',
		border: '2px solid currentColor',
		borderRightColor: 'transparent',
		borderRadius: '50%',
		opacity: 0.75,
		animation: 'pm-spin 0.8s linear infinite',
	},
	checkboxRow: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '8px',
		fontSize: '12px',
	},
	mergeHint: {
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
		lineHeight: 1.5,
	},
};