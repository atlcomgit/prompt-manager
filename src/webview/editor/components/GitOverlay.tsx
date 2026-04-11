import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import type {
	GitOverlayActionKind,
	GitOverlayChangeFile,
	GitOverlayProjectCommitMessage,
	GitOverlayProjectReviewRequestInput,
	GitOverlayReviewCliSetupRequest,
	GitOverlayProjectSnapshot,
	GitOverlayReviewUnsupportedReason,
	GitOverlaySnapshot,
} from '../../../types/git';
import type { PromptStatus } from '../../../types/prompt';
import {
	buildGitOverlayReviewRequestTitle,
	collectGitOverlayActionableProjects,
	collectGitOverlayDefaultStepBranchMismatches,
	collectGitOverlayProjectsNeedingSync,
	collectGitOverlayStartChatBranchMismatches,
	isGitOverlayStartChatBranchAllowed,
	resolveGitOverlayTrackedBranchOptions,
	resolveGitOverlayDoneStatus,
} from '../../../utils/gitOverlay.js';
import { ProgressLine } from './ProgressLine';

type Props = {
	open: boolean;
	mode?: 'default' | 'start-chat-preflight' | 'open-chat-preflight';
	snapshot: GitOverlaySnapshot | null;
	commitMessages: Record<string, string>;
	busyAction: string | null;
	waitingForSnapshotAction?: string | null;
	processLabel?: string | null;
	completedActions: Record<GitOverlayActionKind, boolean>;
	promptStatus: PromptStatus;
	promptTitle: string;
	promptTaskNumber: string;
	selectedProjects?: string[];
	dockToSecondHalf?: boolean;
	preferredTrackedBranch?: string;
	preferredTrackedBranchesByProject?: Record<string, string>;
	onClose: () => void;
	onDone: (status: PromptStatus | null) => void;
	onMarkCompletedInPlace?: () => void;
	onRefresh: (mode?: 'local' | 'fetch' | 'sync') => void;
	onApplyBranchTargets?: (
		sourceBranchesByProject: Record<string, string>,
		targetBranchesByProject: Record<string, string>,
		project?: string,
	) => void;
	onSwitchBranch?: (trackedBranchesByProject: Record<string, string>) => void;
	onEnsurePromptBranch: (trackedBranchesByProject: Record<string, string>) => void;
	onPush: (branch?: string, projects?: string[]) => void;
	onCreateReviewRequest: (requests: GitOverlayProjectReviewRequestInput[]) => void;
	onMergePromptBranch: (trackedBranchesByProject: Record<string, string>, stayOnTrackedBranch: boolean, projects?: string[]) => void;
	onDiscardFile: (project: string, filePath: string, group: GitOverlayChangeFile['group'], previousPath?: string) => void;
	onDiscardProjectChanges?: (project: string, changes: GitOverlayChangeFile[]) => void;
	onOpenFile: (project: string, filePath: string) => void;
	onOpenDiff: (project: string, filePath: string) => void;
	onOpenReviewRequest: (url: string) => void;
	onSetupReviewCli: (request: GitOverlayReviewCliSetupRequest) => void;
	onAssignReviewProvider: (host: string, provider: 'github' | 'gitlab') => void;
	onOpenMergeEditor: (project: string, filePath: string) => void;
	onGenerateCommitMessage: (project?: string) => void;
	onCommitStaged: (messages: GitOverlayProjectCommitMessage[]) => void;
	onCommitMessageChange: (project: string, value: string) => void;
	onUpdateProjects?: (projects: string[]) => void;
	onTrackedBranchChange?: (trackedBranchesByProject: Record<string, string>) => void;
	onContinueStartChat?: () => void;
	onContinueOpenChat?: () => void;
	t: (key: string) => string;
};

type SectionKey = 'step1' | 'step2' | 'step3' | 'step4' | 'step5';

type ReviewDraft = {
	targetBranch: string;
	title: string;
	manualTitle: boolean;
	manualTargetBranch: boolean;
};

type ProjectValidation = {
	available: boolean;
	hasChanges: boolean;
	hasConflicts: boolean;
	branchMismatch: boolean;
	needsMessage: boolean;
	committable: boolean;
};

type RefreshProgressMode = 'idle' | 'loading' | 'auto' | 'sync' | 'fetch' | 'local';

export const GIT_OVERLAY_EXPECTED_BRANCH_CURRENT = '__pm_git_overlay_current__';
const GIT_OVERLAY_LEFT_ACCENT_SHADOW = 'inset 3px 0 0 var(--vscode-widget-shadow, rgba(0, 0, 0, 0.35))';

function countProjectChanges(project: GitOverlayProjectSnapshot): number {
	return project.changeGroups.merge.length
		+ project.changeGroups.staged.length
		+ project.changeGroups.workingTree.length
		+ project.changeGroups.untracked.length;
}

function countProjectLikeChanges(project: Pick<GitOverlayProjectSnapshot, 'changeGroups'>): number {
	return project.changeGroups.merge.length
		+ project.changeGroups.staged.length
		+ project.changeGroups.workingTree.length
		+ project.changeGroups.untracked.length;
}

function doesGitOverlayBranchExist(
	project: Pick<GitOverlayProjectSnapshot, 'branches'>,
	branchName: string,
): boolean {
	return Boolean(findGitOverlayBranchInfo(project, branchName)?.exists);
}

function shouldGitOverlayRequireSourceBranch(
	project: Pick<GitOverlayProjectSnapshot, 'branches'>,
	targetBranch: string,
): boolean {
	const normalizedTargetBranch = targetBranch.trim();
	if (!normalizedTargetBranch) {
		return false;
	}

	return !doesGitOverlayBranchExist(project, normalizedTargetBranch);
}

function isGitOverlayTrackedBranch(
	branchName: string,
	trackedBranches: string[],
): boolean {
	const normalizedBranchName = branchName.trim();
	if (!normalizedBranchName) {
		return false;
	}

	return trackedBranches
		.map(branch => branch.trim())
		.filter(Boolean)
		.includes(normalizedBranchName);
}

function resolveGitOverlayImplicitExpectedBranch(
	project: Pick<GitOverlayProjectSnapshot, 'currentBranch'>,
	promptBranch: string,
	trackedBranches: string[],
): string {
	const normalizedCurrentBranch = project.currentBranch.trim();
	if (!normalizedCurrentBranch) {
		return '';
	}

	const normalizedPromptBranch = promptBranch.trim();
	if (normalizedPromptBranch && normalizedCurrentBranch === normalizedPromptBranch) {
		return normalizedCurrentBranch;
	}

	if (!normalizedPromptBranch && isGitOverlayTrackedBranch(normalizedCurrentBranch, trackedBranches)) {
		return normalizedCurrentBranch;
	}

	return '';
}

export function isGitOverlayCurrentExpectedBranchSelection(branchName: string): boolean {
	return branchName.trim() === GIT_OVERLAY_EXPECTED_BRANCH_CURRENT;
}

export function resolveGitOverlayEffectiveExpectedBranch(
	project: Pick<GitOverlayProjectSnapshot, 'currentBranch'>,
	explicitTargetBranch: string,
	promptBranch: string,
	trackedBranches: string[],
): string {
	const normalizedExplicitTargetBranch = explicitTargetBranch.trim();
	if (isGitOverlayCurrentExpectedBranchSelection(normalizedExplicitTargetBranch)) {
		return project.currentBranch.trim();
	}

	return normalizedExplicitTargetBranch || resolveGitOverlayImplicitExpectedBranch(project, promptBranch, trackedBranches);
}

function isGitOverlayStep1ProjectActionable(
	project: Pick<GitOverlayProjectSnapshot, 'currentBranch' | 'changeGroups'>,
	promptBranch: string,
	trackedBranches: string[],
): boolean {
	return countProjectLikeChanges(project) > 0
		|| !isGitOverlayStartChatBranchAllowed(project.currentBranch, promptBranch, trackedBranches);
}

export function collectGitOverlayProjectsWithChangesOutsideTrackedOrPrompt<T extends Pick<GitOverlayProjectSnapshot, 'currentBranch' | 'changeGroups'>>(
	projects: T[],
	promptBranch: string,
	trackedBranches: string[],
): T[] {
	return projects.filter(project => countProjectLikeChanges(project) > 0
		&& !isGitOverlayStartChatBranchAllowed(project.currentBranch, promptBranch, trackedBranches));
}

export function collectGitOverlayProjectsWithChangesOnTrackedBranches<T extends Pick<GitOverlayProjectSnapshot, 'currentBranch' | 'changeGroups'>>(
	projects: T[],
	trackedBranches: string[],
): T[] {
	const trackedBranchSet = new Set(
		trackedBranches
			.map(branch => branch.trim())
			.filter(Boolean),
	);

	return projects.filter(project => countProjectLikeChanges(project) > 0
		&& trackedBranchSet.has(project.currentBranch.trim()));
}

export function areGitOverlayProjectsOnTrackedOrPrompt<T extends Pick<GitOverlayProjectSnapshot, 'currentBranch'>>(
	projects: T[],
	promptBranch: string,
	trackedBranches: string[],
): boolean {
	return projects.length > 0
		&& projects.every(project => isGitOverlayStartChatBranchAllowed(project.currentBranch, promptBranch, trackedBranches));
}

function collectProjectChanges(project: GitOverlayProjectSnapshot): GitOverlayChangeFile[] {
	return [
		...project.changeGroups.merge,
		...project.changeGroups.staged,
		...project.changeGroups.workingTree,
		...project.changeGroups.untracked,
	];
}

function buildGitOverlayChangeSelectionKey(
	projectName: string,
	change: Pick<GitOverlayChangeFile, 'group' | 'path' | 'status'>,
): string {
	return [projectName.trim(), change.group, change.path.trim(), change.status.trim()].join('::');
}

function findGitOverlayBranchInfo(
	project: Pick<GitOverlayProjectSnapshot, 'branches'>,
	branchName: string,
): GitOverlayProjectSnapshot['branches'][number] | null {
	const normalizedBranchName = branchName.trim();
	if (!normalizedBranchName) {
		return null;
	}

	return project.branches.find(branch => branch.name.trim() === normalizedBranchName) || null;
}

export function isGitOverlayPassivePromptProject<T extends Pick<GitOverlayProjectSnapshot, 'project' | 'available' | 'currentBranch' | 'branches'>>(
	project: T,
	promptBranch: string,
	trackedBranch: string,
): boolean {
	if (!project.available) {
		return false;
	}

	const normalizedPromptBranch = promptBranch.trim();
	if (!normalizedPromptBranch || project.currentBranch.trim() !== normalizedPromptBranch) {
		return false;
	}

	const normalizedTrackedBranch = trackedBranch.trim();
	if (!normalizedTrackedBranch) {
		return false;
	}

	/* Если tracked branch совпадает с prompt branch — сравнение SHA бессмысленно
	   (ветка всегда равна самой себе), проект считаем активным. */
	if (normalizedPromptBranch === normalizedTrackedBranch) {
		return false;
	}

	const promptBranchInfo = findGitOverlayBranchInfo(project, normalizedPromptBranch);
	const trackedBranchInfo = findGitOverlayBranchInfo(project, normalizedTrackedBranch);
 if (!promptBranchInfo?.lastCommit || !trackedBranchInfo?.lastCommit) {
		return false;
	}

	return promptBranchInfo.lastCommit.sha === trackedBranchInfo.lastCommit.sha;
}

export function resolveGitOverlayPostCommitProjects<T extends Pick<GitOverlayProjectSnapshot, 'project' | 'available' | 'currentBranch' | 'branches'>>(
	projects: T[],
	promptBranch: string,
	trackedBranchesByProject: Record<string, string>,
): T[] {
	return projects.filter(project => !isGitOverlayPassivePromptProject(
		project,
		promptBranch,
		trackedBranchesByProject[project.project] || '',
	));
}

function normalizeTrackedBranchesByProject(value: Record<string, string> | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [project, branch] of Object.entries(value || {})) {
		const normalizedProject = project.trim();
		const normalizedBranch = typeof branch === 'string' ? branch.trim() : '';
		if (!normalizedProject || !normalizedBranch) {
			continue;
		}
		result[normalizedProject] = normalizedBranch;
	}
	return result;
}

function normalizeGitOverlayProjectNames(value: string[] | undefined): string[] {
	const result: string[] = [];
	const seen = new Set<string>();

	for (const projectName of value || []) {
		const normalizedProjectName = projectName.trim();
		if (!normalizedProjectName || seen.has(normalizedProjectName)) {
			continue;
		}

		seen.add(normalizedProjectName);
		result.push(normalizedProjectName);
	}

	return result;
}

function buildProjectTrackedBranchOptions(
	project: GitOverlayProjectSnapshot,
	trackedBranchOptions: string[],
	preferredTrackedBranch = '',
): string[] {
	const result = new Set<string>();
	const normalizedTrackedBranchOptions = Array.from(new Set(
		trackedBranchOptions
			.map(branch => branch.trim())
			.filter(Boolean),
	));
	const trackedBranchOptionSet = new Set(normalizedTrackedBranchOptions);
	const normalizedPreferredTrackedBranch = preferredTrackedBranch.trim();
	const normalizedPromptBranch = project.promptBranch.trim();
	const normalizedCurrentBranch = project.currentBranch.trim();
	const trackedBranchNames = project.branches
		.filter((branch) => {
			if (!branch.exists) {
				return false;
			}

			const normalizedBranchName = branch.name.trim();
			if (!normalizedBranchName) {
				return false;
			}

			if (trackedBranchOptionSet.size > 0) {
				return trackedBranchOptionSet.has(normalizedBranchName);
			}

			return branch.kind === 'tracked' || branch.kind === 'current';
		})
		.map(branch => branch.name.trim())
		.filter(Boolean);

	if (
		normalizedPreferredTrackedBranch
		&& (
			trackedBranchNames.includes(normalizedPreferredTrackedBranch)
			|| (
				normalizedPreferredTrackedBranch === normalizedCurrentBranch
				&& normalizedCurrentBranch !== normalizedPromptBranch
				&& (trackedBranchOptionSet.size === 0 || trackedBranchOptionSet.has(normalizedCurrentBranch))
			)
		)
	) {
		result.add(normalizedPreferredTrackedBranch);
	}

	/* Текущую ветку добавляем в список tracked-опций только если она
	   не совпадает с prompt branch — prompt branch не является tracked. */
	if (normalizedCurrentBranch && normalizedCurrentBranch !== normalizedPromptBranch) {
		result.add(normalizedCurrentBranch);
	}

	for (const branch of trackedBranchNames) {
		result.add(branch);
	}

	return [...result];
}

function buildProjectTargetBranchOptions(
	project: GitOverlayProjectSnapshot,
	trackedBranchOptions: string[],
	preferredTrackedBranch = '',
): string[] {
	const result = new Set<string>(buildProjectTrackedBranchOptions(project, trackedBranchOptions, preferredTrackedBranch));

	if (project.review.request?.targetBranch) {
		result.add(project.review.request.targetBranch.trim());
	}

	return [...result];
}

function buildProjectExpectedBranchOptions(
	project: GitOverlayProjectSnapshot,
	trackedBranchOptions: string[],
	preferredTrackedBranch = '',
): string[] {
	const result = new Set<string>(buildProjectTrackedBranchOptions(project, trackedBranchOptions, preferredTrackedBranch));
	const normalizedPromptBranch = project.promptBranch.trim();
	const normalizedCurrentBranch = project.currentBranch.trim();
	if (normalizedPromptBranch) {
		result.add(normalizedPromptBranch);
	}
	if (normalizedCurrentBranch) {
		result.delete(normalizedCurrentBranch);
	}
	return [...result];
}

function resolveTrackedBranchesByProject(
	projects: GitOverlayProjectSnapshot[],
	trackedBranchOptions: string[],
	explicitTrackedBranchesByProject: Record<string, string>,
	persistedTrackedBranchesByProject: Record<string, string>,
	preferredTrackedBranch = '',
): Record<string, string> {
	const normalizedExplicitTrackedBranchesByProject = normalizeTrackedBranchesByProject(explicitTrackedBranchesByProject);
	const normalizedPersistedTrackedBranchesByProject = normalizeTrackedBranchesByProject(persistedTrackedBranchesByProject);
	const normalizedPreferredTrackedBranch = preferredTrackedBranch.trim();
	const result: Record<string, string> = {};

	for (const project of projects) {
		const options = buildProjectTrackedBranchOptions(project, trackedBranchOptions, normalizedPreferredTrackedBranch);
		const explicitTrackedBranch = (normalizedExplicitTrackedBranchesByProject[project.project] || '').trim();
		if (explicitTrackedBranch && options.includes(explicitTrackedBranch)) {
			result[project.project] = explicitTrackedBranch;
			continue;
		}

		const persistedTrackedBranch = (normalizedPersistedTrackedBranchesByProject[project.project] || '').trim();
		if (persistedTrackedBranch && options.includes(persistedTrackedBranch)) {
			result[project.project] = persistedTrackedBranch;
			continue;
		}

		if (normalizedPreferredTrackedBranch && options.includes(normalizedPreferredTrackedBranch)) {
			result[project.project] = normalizedPreferredTrackedBranch;
			continue;
		}

		const currentBranch = project.currentBranch.trim();
		const projectPromptBranch = (project.promptBranch || '').trim();
		/* Не выбираем текущую ветку как tracked, если она совпадает с prompt branch. */
		if (currentBranch && currentBranch !== projectPromptBranch && options.includes(currentBranch)) {
			result[project.project] = currentBranch;
			continue;
		}

		if (options[0]) {
			result[project.project] = options[0];
		}
	}

	return result;
}

function resolveTargetBranchesByProject(
	projects: GitOverlayProjectSnapshot[],
	trackedBranchOptions: string[],
	explicitTargetBranchesByProject: Record<string, string>,
	trackedBranchesByProject: Record<string, string>,
	promptBranch: string,
): Record<string, string> {
	const normalizedExplicitTargetBranchesByProject = normalizeTrackedBranchesByProject(explicitTargetBranchesByProject);
	const normalizedPromptBranch = promptBranch.trim();
	const result: Record<string, string> = {};

	for (const project of projects) {
		const sourceBranch = (trackedBranchesByProject[project.project] || '').trim();
		const options = buildProjectExpectedBranchOptions(project, trackedBranchOptions, sourceBranch);
		const explicitTargetBranch = (normalizedExplicitTargetBranchesByProject[project.project] || '').trim();
		if (isGitOverlayCurrentExpectedBranchSelection(explicitTargetBranch)) {
			result[project.project] = explicitTargetBranch;
			continue;
		}
		if (explicitTargetBranch && options.includes(explicitTargetBranch)) {
			result[project.project] = explicitTargetBranch;
			continue;
		}

		const currentBranch = project.currentBranch.trim();
		const implicitExpectedBranch = resolveGitOverlayImplicitExpectedBranch(project, normalizedPromptBranch, trackedBranchOptions);
		if (implicitExpectedBranch) {
			continue;
		}

		if (normalizedPromptBranch && options.includes(normalizedPromptBranch)) {
			result[project.project] = normalizedPromptBranch;
			continue;
		}

		if (sourceBranch && options.includes(sourceBranch)) {
			result[project.project] = sourceBranch;
			continue;
		}

		if (options[0]) {
			result[project.project] = options[0];
		}
	}

	return result;
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

function resolveChangeMetricsLocale(): string {
	if (typeof navigator !== 'undefined' && navigator.language) {
		return navigator.language;
	}

	return 'en-US';
}

export function formatChangeSize(size: number, locale = resolveChangeMetricsLocale()): string {
	const normalizedSize = Math.max(0, size || 0);
	const units = locale.startsWith('ru')
		? ['Б', 'КБ', 'МБ', 'ГБ']
		: ['B', 'KB', 'MB', 'GB'];

	if (normalizedSize < 1024) {
		return `${new Intl.NumberFormat(locale).format(normalizedSize)}${units[0]}`;
	}

	let value = normalizedSize;
	let unitIndex = 0;
	while (value >= 1000 && unitIndex < units.length - 1) {
		value /= 1000;
		unitIndex += 1;
	}

	const showFraction = value < 10 && unitIndex > 0;
	return `${new Intl.NumberFormat(locale, {
		minimumFractionDigits: showFraction ? 1 : 0,
		maximumFractionDigits: showFraction ? 1 : 0,
	}).format(value)}${units[unitIndex]}`;
}

export function resolveChangeDiffStats(change: Pick<GitOverlayChangeFile, 'conflicted' | 'isBinary' | 'additions' | 'deletions'>): {
	kind: 'diff' | 'special';
	additions: number;
	deletions: number;
	specialLabel: 'conflict' | 'binary' | null;
} {
	if (change.conflicted) {
		return {
			kind: 'special',
			additions: 0,
			deletions: 0,
			specialLabel: 'conflict',
		};
	}

	if (change.isBinary || change.additions === null || change.deletions === null) {
		return {
			kind: 'special',
			additions: 0,
			deletions: 0,
			specialLabel: 'binary',
		};
	}

	return {
		kind: 'diff',
		additions: Math.max(0, change.additions || 0),
		deletions: Math.max(0, change.deletions || 0),
		specialLabel: null,
	};
}

function renderChangeMetrics(change: GitOverlayChangeFile, t: (key: string) => string): React.ReactNode {
	const diffStats = resolveChangeDiffStats(change);

	return (
		<>
			<span style={styles.changeMetricsSize}>{formatChangeSize(change.fileSizeBytes)}</span>
			{diffStats.kind === 'special' ? (
				<span style={styles.changeMetricsInfo}>
					{diffStats.specialLabel === 'conflict'
						? t('editor.gitOverlayChangeConflict')
						: t('editor.gitOverlayChangeBinary')}
				</span>
			) : (
				<>
					{diffStats.deletions > 0 ? <span style={styles.changeMetricsDeleted}>{`-${diffStats.deletions}`}</span> : null}
					{diffStats.additions > 0 ? <span style={styles.changeMetricsAdded}>{`+${diffStats.additions}`}</span> : null}
				</>
			)}
		</>
	);
}

function resolveReviewRequestStateLabel(project: GitOverlayProjectSnapshot, t: (key: string) => string): string {
	if (!project.review.request) {
		return t('editor.gitOverlayReviewRequestMissing');
	}
	if (project.review.request.state === 'accepted') {
		return t('editor.gitOverlayReviewRequestAccepted');
	}
	if (project.review.request.state === 'closed') {
		return t('editor.gitOverlayReviewRequestClosed');
	}
	return t('editor.gitOverlayReviewRequestOpen');
}

function resolveReviewUnsupportedProjectMessage(
	unsupportedReason: GitOverlayReviewUnsupportedReason | null | undefined,
	t: (key: string) => string,
): string {
	if (unsupportedReason === 'missing-remote') {
		return t('editor.gitOverlayReviewRequestMissingRemoteProject');
	}
	if (unsupportedReason === 'unrecognized-remote') {
		return t('editor.gitOverlayReviewRequestUnknownRemoteProject');
	}
	return t('editor.gitOverlayReviewRequestUnsupportedProject');
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
	hidden?: boolean;
}> = ({ label, onClick, tone = 'default', disabled = false, loading = false, hidden = false }) => {
	if (hidden) {
		return null;
	}

	return (
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
};

const ActionButton: React.FC<{
	label: string;
	onClick: () => void;
	disabled?: boolean;
	loading?: boolean;
	variant?: 'primary' | 'secondary' | 'success' | 'danger';
	size?: 'default' | 'compact';
	hidden?: boolean;
}> = ({ label, onClick, disabled = false, loading = false, variant = 'secondary', size = 'default', hidden = false }) => {
	if (hidden) {
		return null;
	}

	return (
	<button
		type="button"
		onClick={onClick}
		disabled={disabled || loading}
		aria-busy={loading}
		style={{
			...styles.actionButton,
			...(size === 'compact' ? styles.actionButtonCompact : null),
			...(variant === 'primary'
				? styles.actionButtonPrimary
				: variant === 'success'
					? styles.actionButtonSuccess
					: variant === 'danger'
						? styles.actionButtonDanger
						: styles.actionButtonSecondary),
			...((disabled || loading) ? styles.actionButtonDisabled : null),
		}}
	>
		<span style={styles.actionButtonContent}>
			{loading ? <span style={styles.buttonSpinner} /> : null}
			<span>{label}</span>
		</span>
	</button>
);
};

const InlineHint: React.FC<{
	message: string;
	tone?: 'error' | 'info';
	actionLabel?: string;
	onAction?: () => void;
	actionDisabled?: boolean;
}> = ({ message, tone = 'info', actionLabel, onAction, actionDisabled = false }) => (
	<div style={{
		...styles.inlineHint,
		...(tone === 'error' ? styles.inlineHintError : styles.inlineHintInfo),
	}}>
		<span style={styles.inlineHintIconWrap}>
			<HintIcon tone={tone} />
		</span>
		<span style={styles.inlineHintText}>{message}</span>
		{actionLabel && onAction ? (
			<button
				type="button"
				onClick={onAction}
				disabled={actionDisabled}
				style={{
					...styles.inlineHintActionButton,
					...(actionDisabled ? styles.inlineHintActionButtonDisabled : null),
				}}
			>
				{actionLabel}
			</button>
		) : null}
	</div>
);

export const GitOverlay: React.FC<Props> = ({
	open,
	mode = 'default',
	snapshot,
	commitMessages,
	busyAction,
	waitingForSnapshotAction = null,
	processLabel = null,
	completedActions,
	promptStatus,
	promptTitle,
	promptTaskNumber,
	selectedProjects,
	dockToSecondHalf = false,
	preferredTrackedBranch,
	preferredTrackedBranchesByProject = {},
	onClose,
	onDone,
	onMarkCompletedInPlace,
	onRefresh,
	onApplyBranchTargets,
	onSwitchBranch,
	onEnsurePromptBranch,
	onPush,
	onCreateReviewRequest,
	onMergePromptBranch,
	onDiscardFile,
	onDiscardProjectChanges,
	onOpenFile,
	onOpenDiff,
	onOpenReviewRequest,
	onSetupReviewCli,
	onAssignReviewProvider,
	onOpenMergeEditor,
	onGenerateCommitMessage,
	onCommitStaged,
	onCommitMessageChange,
	onUpdateProjects,
	onTrackedBranchChange,
	onContinueStartChat,
	onContinueOpenChat,
	t,
}) => {
	const [selectedTrackedBranchesByProject, setSelectedTrackedBranchesByProject] = useState<Record<string, string>>({});
	const [selectedTargetBranchesByProject, setSelectedTargetBranchesByProject] = useState<Record<string, string>>({});
	const [selectedChangeKey, setSelectedChangeKey] = useState('');
	const [stayOnTrackedBranch, setStayOnTrackedBranch] = useState(true);
	const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
	const [collapsedSections, setCollapsedSections] = useState<Partial<Record<SectionKey, boolean>>>({});
	const [reviewDrafts, setReviewDrafts] = useState<Record<string, ReviewDraft>>({});
	const lastSyncedTrackedBranchesRef = useRef<Record<string, string>>({});

	const isStartChatPreflightMode = mode === 'start-chat-preflight';
	const isOpenChatPreflightMode = mode === 'open-chat-preflight';
	const isChatPreflightMode = isStartChatPreflightMode || isOpenChatPreflightMode;
	const isDraftPrompt = promptStatus === 'draft';
	const isReadOnlyFlow = !isChatPreflightMode && promptStatus === 'in-progress';
	const isWaitingForSnapshot = Boolean(waitingForSnapshotAction);
	const shouldHideActionWhileWaiting = (actionName: string): boolean => isWaitingForSnapshot && waitingForSnapshotAction === actionName;
	const shouldHideCommitActionWhileWaiting = (projectName?: string): boolean => {
		if (shouldHideActionWhileWaiting('commitStaged:all')) {
			return true;
		}

		return Boolean(projectName) && shouldHideActionWhileWaiting(`commitStaged:${projectName}`);
	};
	const promptBranch = (snapshot?.promptBranch || '').trim();
	const allProjects = snapshot?.projects || [];
	const normalizedSelectedProjects = useMemo(
		() => normalizeGitOverlayProjectNames(selectedProjects),
		[selectedProjects],
	);
	const effectiveSelectedProjectNames = useMemo(
		() => normalizedSelectedProjects.length > 0
			? normalizedSelectedProjects
			: allProjects.map(project => project.project),
		[allProjects, normalizedSelectedProjects],
	);
	const selectedProjectNameSet = useMemo(
		() => new Set(effectiveSelectedProjectNames),
		[effectiveSelectedProjectNames],
	);
	const selectedSnapshotProjects = useMemo(
		() => allProjects.filter(project => selectedProjectNameSet.has(project.project)),
		[allProjects, selectedProjectNameSet],
	);
	const trackedBranchOptions = useMemo(
		() => resolveGitOverlayTrackedBranchOptions(
			snapshot?.trackedBranches || [],
			selectedSnapshotProjects,
			promptBranch,
			preferredTrackedBranch,
		),
		[preferredTrackedBranch, promptBranch, selectedSnapshotProjects, snapshot?.trackedBranches],
	);
	const normalizedPreferredTrackedBranchesByProject = useMemo(
		() => normalizeTrackedBranchesByProject(preferredTrackedBranchesByProject),
		[preferredTrackedBranchesByProject],
	);
	const resolvedTrackedBranchesByProject = useMemo(
		() => resolveTrackedBranchesByProject(
			selectedSnapshotProjects,
			trackedBranchOptions,
			selectedTrackedBranchesByProject,
			normalizedPreferredTrackedBranchesByProject,
			preferredTrackedBranch,
		),
			[normalizedPreferredTrackedBranchesByProject, preferredTrackedBranch, selectedSnapshotProjects, selectedTrackedBranchesByProject, trackedBranchOptions],
	);
	const resolvedTargetBranchesByProject = useMemo(
		() => resolveTargetBranchesByProject(
			selectedSnapshotProjects,
			trackedBranchOptions,
			selectedTargetBranchesByProject,
			resolvedTrackedBranchesByProject,
			promptBranch,
		),
		[selectedSnapshotProjects, selectedTargetBranchesByProject, resolvedTrackedBranchesByProject, trackedBranchOptions, promptBranch],
	);
	const availableProjects = useMemo(
		() => selectedSnapshotProjects.filter(project => project.available),
		[selectedSnapshotProjects],
	);
	const defaultFlowAvailableProjects = useMemo(
		() => collectGitOverlayActionableProjects(availableProjects, promptBranch, trackedBranchOptions),
		[availableProjects, promptBranch, trackedBranchOptions],
	);
	const flowAvailableProjects = useMemo(
		() => isChatPreflightMode ? availableProjects : defaultFlowAvailableProjects,
		[availableProjects, defaultFlowAvailableProjects, isChatPreflightMode],
	);
	const step1AvailableProjects = useMemo(
		() => availableProjects,
		[availableProjects],
	);
	const step1Projects = useMemo(
		() => isChatPreflightMode
			? selectedSnapshotProjects
			: step1AvailableProjects,
		[isChatPreflightMode, selectedSnapshotProjects, step1AvailableProjects],
	);
	const otherChangedProjects = useMemo(
		() => allProjects.filter(project => !selectedProjectNameSet.has(project.project) && countProjectChanges(project) > 0),
		[allProjects, selectedProjectNameSet],
	);
	const startChatBranchMismatches = useMemo(
		() => collectGitOverlayStartChatBranchMismatches(availableProjects, promptBranch, trackedBranchOptions),
		[availableProjects, promptBranch, trackedBranchOptions],
	);
	const projectsWithChanges = useMemo(
		() => flowAvailableProjects.filter(project => countProjectChanges(project) > 0),
		[flowAvailableProjects],
	);
	const projectsWithChangesOutsideTrackedOrPrompt = useMemo(
		() => collectGitOverlayProjectsWithChangesOutsideTrackedOrPrompt(flowAvailableProjects, promptBranch, trackedBranchOptions),
		[flowAvailableProjects, promptBranch, trackedBranchOptions],
	);
	const projectsWithChangesOnTrackedBranches = useMemo(
		() => collectGitOverlayProjectsWithChangesOnTrackedBranches(flowAvailableProjects, trackedBranchOptions),
		[flowAvailableProjects, trackedBranchOptions],
	);
	const allowDirtyTrackedProjectsWithoutPromptBranch = !isChatPreflightMode
		&& !promptBranch
		&& projectsWithChanges.length > 0;
	const defaultStep1BranchMismatches = useMemo(
		() => allowDirtyTrackedProjectsWithoutPromptBranch
			? collectGitOverlayStartChatBranchMismatches(projectsWithChanges, '', trackedBranchOptions)
			: collectGitOverlayDefaultStepBranchMismatches(step1AvailableProjects, promptBranch, trackedBranchOptions),
		[
			allowDirtyTrackedProjectsWithoutPromptBranch,
			projectsWithChanges,
			promptBranch,
			step1AvailableProjects,
			trackedBranchOptions,
		],
	);
	const totalChangedFiles = useMemo(
		() => projectsWithChanges.reduce((sum, project) => sum + countProjectChanges(project), 0),
		[projectsWithChanges],
	);
	const flowPostCommitProjects = useMemo(
		() => resolveGitOverlayPostCommitProjects(flowAvailableProjects, promptBranch, resolvedTrackedBranchesByProject),
		[flowAvailableProjects, promptBranch, resolvedTrackedBranchesByProject],
	);
	const step1ProjectsOffPromptBranch = useMemo(
		() => step1AvailableProjects.filter(project => !promptBranch || project.currentBranch !== promptBranch),
		[step1AvailableProjects, promptBranch],
	);
	const flowProjectsOffPromptBranch = useMemo(
		() => flowPostCommitProjects.filter(project => !promptBranch || project.currentBranch !== promptBranch),
		[flowPostCommitProjects, promptBranch],
	);
	const hasConflicts = useMemo(
		() => projectsWithChanges.some(project => project.changeGroups.merge.length > 0),
		[projectsWithChanges],
	);
	const allProjectsOnPromptBranch = Boolean(promptBranch) && step1AvailableProjects.length > 0 && step1ProjectsOffPromptBranch.length === 0;
	const promptBranchProjects = useMemo(
		() => flowPostCommitProjects.filter(project => project.currentBranch === promptBranch),
		[flowPostCommitProjects, promptBranch],
	);
	const projectsNeedingSync = useMemo(
		() => collectGitOverlayProjectsNeedingSync(step1AvailableProjects),
		[step1AvailableProjects],
	);
	const step1MissingTrackedBranchProjects = useMemo(
		() => step1AvailableProjects.filter(project => !(resolvedTrackedBranchesByProject[project.project] || '').trim()),
		[resolvedTrackedBranchesByProject, step1AvailableProjects],
	);
	const flowMissingTrackedBranchProjects = useMemo(
		() => flowPostCommitProjects.filter(project => !(resolvedTrackedBranchesByProject[project.project] || '').trim()),
		[flowPostCommitProjects, resolvedTrackedBranchesByProject],
	);
	const step1ProjectsOffSelectedTrackedBranch = useMemo(
		() => step1AvailableProjects.filter(project => {
			const selectedTrackedBranch = (resolvedTrackedBranchesByProject[project.project] || '').trim();
			return !selectedTrackedBranch || project.currentBranch !== selectedTrackedBranch;
		}),
		[resolvedTrackedBranchesByProject, step1AvailableProjects],
	);
	const step1ProjectsMissingTargetBranch = useMemo(
		() => step1AvailableProjects.filter(project => !(resolvedTargetBranchesByProject[project.project] || '').trim()),
		[resolvedTargetBranchesByProject, step1AvailableProjects],
	);
	const step1ProjectsBlockedForApply = useMemo(
		() => step1AvailableProjects.filter((project) => {
			const sourceBranch = (resolvedTrackedBranchesByProject[project.project] || '').trim();
			const selectedTargetBranch = (resolvedTargetBranchesByProject[project.project] || '').trim();
			if (isGitOverlayCurrentExpectedBranchSelection(selectedTargetBranch)) {
				return false;
			}
			const targetBranch = resolveGitOverlayEffectiveExpectedBranch(project, selectedTargetBranch, promptBranch, trackedBranchOptions);
			const needsTargetSwitch = Boolean(targetBranch) && project.currentBranch.trim() !== targetBranch;
			if (!needsTargetSwitch && !isGitOverlayStep1ProjectActionable(project, promptBranch, trackedBranchOptions)) {
				return false;
			}

			const needsSync = Boolean(project.upstream.trim()) && project.behind > 0;
			const targetRequiresSource = shouldGitOverlayRequireSourceBranch(project, targetBranch);

			if (needsSync || !targetBranch) {
				return true;
			}

			if (targetRequiresSource) {
				return !sourceBranch;
			}

			return false;
		}),
		[promptBranch, resolvedTargetBranchesByProject, resolvedTrackedBranchesByProject, step1AvailableProjects, trackedBranchOptions],
	);
	const step1ProjectsReadyForApply = useMemo(
		() => step1AvailableProjects.filter((project) => {
			const sourceBranch = (resolvedTrackedBranchesByProject[project.project] || '').trim();
			const selectedTargetBranch = (resolvedTargetBranchesByProject[project.project] || '').trim();
			if (isGitOverlayCurrentExpectedBranchSelection(selectedTargetBranch)) {
				return false;
			}
			const targetBranch = resolveGitOverlayEffectiveExpectedBranch(project, selectedTargetBranch, promptBranch, trackedBranchOptions);
			const needsTargetSwitch = Boolean(targetBranch) && project.currentBranch.trim() !== targetBranch;
			if (!needsTargetSwitch && !isGitOverlayStep1ProjectActionable(project, promptBranch, trackedBranchOptions)) {
				return false;
			}

			const needsSync = Boolean(project.upstream.trim()) && project.behind > 0;
			const targetRequiresSource = shouldGitOverlayRequireSourceBranch(project, targetBranch);
			if (needsSync || !targetBranch) {
				return false;
			}
			if (targetRequiresSource && !sourceBranch) {
				return false;
			}
			return needsTargetSwitch;
		}),
		[promptBranch, resolvedTargetBranchesByProject, resolvedTrackedBranchesByProject, step1AvailableProjects, trackedBranchOptions],
	);
	const step1ApplySourceBranches = useMemo(() => {
		const result: Record<string, string> = {};
		for (const project of step1ProjectsReadyForApply) {
			const sourceBranch = (resolvedTrackedBranchesByProject[project.project] || '').trim();
			if (!sourceBranch) {
				continue;
			}
			result[project.project] = sourceBranch;
		}
		return result;
	}, [resolvedTrackedBranchesByProject, step1ProjectsReadyForApply]);
	const step1ApplyTargetBranches = useMemo(() => {
		const result: Record<string, string> = {};
		for (const project of step1ProjectsReadyForApply) {
			const targetBranch = (resolvedTargetBranchesByProject[project.project] || '').trim();
			if (!targetBranch) {
				continue;
			}
			result[project.project] = targetBranch;
		}
		return result;
	}, [resolvedTargetBranchesByProject, step1ProjectsReadyForApply]);
	const reviewProjects = useMemo(
		() => promptBranchProjects,
		[promptBranchProjects],
	);
	const reviewProjectsWithCli = useMemo(
		() => reviewProjects.filter(project => Boolean(project.review.remote?.supported) && Boolean(project.review.remote?.cliAvailable)),
		[reviewProjects],
	);
	const reviewProjectsMissingRequest = useMemo(
		() => reviewProjectsWithCli.filter(project => !project.review.request),
		[reviewProjectsWithCli],
	);
	const reviewRequestLinks = useMemo(
		() => reviewProjects
			.map(project => (project.review.request?.url || '').trim())
			.filter((url): url is string => Boolean(url)),
		[reviewProjects],
	);
	const reviewRequestLinksText = useMemo(
		() => reviewRequestLinks.join('\n'),
		[reviewRequestLinks],
	);
	const bulkReviewRequests = useMemo<GitOverlayProjectReviewRequestInput[]>(() => {
		const result: GitOverlayProjectReviewRequestInput[] = [];

		for (const project of reviewProjectsMissingRequest) {
			const draft = reviewDrafts[project.project];
			const targetBranch = (draft?.targetBranch || '').trim();
			const title = (draft?.title || '').trim();
			const canCreateReviewRequest = Boolean(project.review.remote?.supported)
				&& Boolean(project.review.remote?.cliAvailable)
				&& !project.review.setupAction
				&& Boolean(promptBranch)
				&& project.currentBranch === promptBranch
				&& Boolean(targetBranch)
				&& Boolean(title);

			if (!canCreateReviewRequest) {
				continue;
			}

			result.push({
				project: project.project,
				targetBranch,
				title,
				draft: true,
				removeSourceBranch: false,
			});
		}

		return result;
	}, [promptBranch, reviewDrafts, reviewProjectsMissingRequest]);
	const canCreateAllReviewRequests = reviewProjectsMissingRequest.length > 0
		&& bulkReviewRequests.length === reviewProjectsMissingRequest.length;
	const canCopyAllReviewRequestLinks = typeof navigator !== 'undefined'
		&& typeof navigator.clipboard?.writeText === 'function'
		&& reviewRequestLinks.length > 0;

	const projectValidations = useMemo(() => {
		const result = new Map<string, ProjectValidation>();
		for (const project of selectedSnapshotProjects) {
			const hasChanges = countProjectChanges(project) > 0;
			const hasConflictsForProject = project.changeGroups.merge.length > 0;
			const branchMismatch = project.available && (
				promptBranch
					? project.currentBranch !== promptBranch
					: hasChanges && !isGitOverlayStartChatBranchAllowed(project.currentBranch, '', trackedBranchOptions)
			);
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
	}, [selectedSnapshotProjects, commitMessages, promptBranch, trackedBranchOptions]);

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
	const canUpdatePromptProjects = Boolean(onUpdateProjects);
	const canPreparePromptBranch = Boolean(promptBranch) && step1AvailableProjects.length > 0 && step1MissingTrackedBranchProjects.length === 0;
	const canSwitchToTrackedBranch = step1MissingTrackedBranchProjects.length === 0
		&& (isChatPreflightMode ? startChatBranchMismatches.length > 0 : step1ProjectsOffSelectedTrackedBranch.length > 0);
	const startChatBranchCheckDone = availableProjects.length > 0 && startChatBranchMismatches.length === 0;
	const syncRequired = projectsNeedingSync.length > 0;
	const defaultStep1ReadyOnTrackedBranches = !isChatPreflightMode
		&& Boolean(promptBranch)
		&& step1AvailableProjects.length > 0
		&& step1ProjectsOffPromptBranch.length > 0
		&& defaultStep1BranchMismatches.length === 0
		&& step1AvailableProjects.every(project => trackedBranchOptions.includes(project.currentBranch));
	const defaultStep1ReadyOnTrackedBranchesWithoutPrompt = !isChatPreflightMode
		&& !promptBranch
		&& projectsWithChanges.length > 0
		&& defaultStep1BranchMismatches.length === 0;
	const allStep1ProjectsOnTrackedBranches = useMemo(
		() => areGitOverlayProjectsOnTrackedOrPrompt(step1AvailableProjects, '', trackedBranchOptions),
		[step1AvailableProjects, trackedBranchOptions],
	);
	const showPromptBranchFallbackInfo = !isChatPreflightMode
		&& !promptBranch
		&& projectsWithChanges.length > 0
		&& projectsWithChangesOutsideTrackedOrPrompt.length === 0;
	const showPromptBranchMissingError = !promptBranch
		&& !showPromptBranchFallbackInfo
		&& !allStep1ProjectsOnTrackedBranches;
	const showProjectNeedsTrackedOrPromptSwitchHint = defaultStep1BranchMismatches.length > 0
		&& !(!promptBranch && allStep1ProjectsOnTrackedBranches);
	const step1Pending = isChatPreflightMode
		? !startChatBranchCheckDone || syncRequired
		: (allowDirtyTrackedProjectsWithoutPromptBranch
			? defaultStep1BranchMismatches.length > 0 || syncRequired
			: showPromptBranchMissingError || showProjectNeedsTrackedOrPromptSwitchHint || syncRequired);
	const shouldShowStep1Success = !step1Pending
		&& (
			isChatPreflightMode
				? startChatBranchCheckDone
				: (allProjectsOnPromptBranch || defaultStep1ReadyOnTrackedBranches || defaultStep1ReadyOnTrackedBranchesWithoutPrompt)
		);
	const step1ResolvedSuccessMessage = isChatPreflightMode || defaultStep1ReadyOnTrackedBranches || defaultStep1ReadyOnTrackedBranchesWithoutPrompt
		? t('editor.gitOverlayStartChatBranchCheckReady')
		: t('editor.gitOverlayAllProjectsOnPrompt');
	const showDefaultFlowFollowUpSteps = !isChatPreflightMode && !isDraftPrompt;
	const shouldShowSwitchToPromptButton = Boolean(promptBranch)
		&& !allProjectsOnPromptBranch
		&& (!isChatPreflightMode || isStartChatPreflightMode);
	const showNoChangesToCommitHint = !isChatPreflightMode
		&& step1AvailableProjects.length > 0
		&& projectsWithChanges.length === 0
		&& step1ProjectsOffPromptBranch.length > 0
		&& defaultStep1BranchMismatches.length === 0
		&& !syncRequired;
	const showStep1NoProjectChangesHint = !isChatPreflightMode
		&& step1Projects.length > 0
		&& projectsWithChanges.length === 0
		&& trackedBranchOptions.length > 0
		&& !showPromptBranchFallbackInfo
		&& !showPromptBranchMissingError
		&& !defaultStep1ReadyOnTrackedBranches
		&& !showProjectNeedsTrackedOrPromptSwitchHint
		&& !showNoChangesToCommitHint
		&& !syncRequired
		&& !shouldShowStep1Success;
	const canApplyAllBranchTargets = step1ProjectsReadyForApply.length > 0 && step1ProjectsBlockedForApply.length === 0;
	const canGenerateAllCommitMessages = projectsReadyForGenerate.length > 0;
	const canCommitAllProjects = allChangedProjectsReadyForCommit;
	const canPushTrackedBranchesWithoutPromptBranch = !promptBranch && allStep1ProjectsOnTrackedBranches;
	const allFlowProjectsOnTrackedOrPrompt = useMemo(
		() => areGitOverlayProjectsOnTrackedOrPrompt(flowAvailableProjects, promptBranch, trackedBranchOptions),
		[flowAvailableProjects, promptBranch, trackedBranchOptions],
	);
	const pushTargetProjects = useMemo(
		() => promptBranch
			? promptBranchProjects
			: (canPushTrackedBranchesWithoutPromptBranch ? step1AvailableProjects : []),
		[canPushTrackedBranchesWithoutPromptBranch, promptBranch, promptBranchProjects, step1AvailableProjects],
	);
	const showPushNeedsPromptBranchHint = !promptBranch && !canPushTrackedBranchesWithoutPromptBranch;
	const canAttemptPush = pushTargetProjects.length > 0
		&& !step1Pending
		&& (!promptBranch || flowProjectsOffPromptBranch.length === 0)
		&& !hasConflicts
		&& projectsWithChanges.length === 0;
	const projectsNeedingPush = useMemo(
		() => pushTargetProjects.filter(project => !project.upstream || project.ahead > 0),
		[pushTargetProjects],
	);
	const pushRequired = canAttemptPush && projectsNeedingPush.length > 0;
	const canPush = pushRequired;
	const step2Pending = !step1Pending && projectsWithChanges.length > 0;
	const step3Pending = !step1Pending && !step2Pending && pushRequired;
	const step4Pending = !step1Pending
		&& !step2Pending
		&& !step3Pending
		&& reviewProjectsWithCli.length > 0
		&& reviewProjectsMissingRequest.length > 0;
	const uniqueTrackedBranches = useMemo(
		() => Array.from(new Set(
			Object.values(resolvedTrackedBranchesByProject)
				.map(branch => branch.trim())
				.filter(Boolean),
		)),
		[resolvedTrackedBranchesByProject],
	);
	const canMerge = Boolean(promptBranch)
		&& flowPostCommitProjects.length > 0
		&& flowMissingTrackedBranchProjects.length === 0
		&& flowProjectsOffPromptBranch.length === 0
		&& !hasConflicts
		&& projectsWithChanges.length === 0
		&& !step4Pending;
	const showEmptyStep1Hint = !isChatPreflightMode && step1Projects.length === 0;
	const canProceedToReviewAndMerge = Boolean(promptBranch);
	const stepAvailability: Record<SectionKey, boolean> = {
		step1: true,
		step2: !step1Pending,
		step3: !step1Pending && !step2Pending,
		step4: canProceedToReviewAndMerge && !step1Pending && !step2Pending && !step3Pending,
		step5: canProceedToReviewAndMerge && !step1Pending && !step2Pending && !step3Pending && !step4Pending,
	};
	const firstPendingStep = step1Pending ? 1 : step2Pending ? 2 : step3Pending ? 3 : step4Pending ? 4 : null;
	const autoCollapsedSections = useMemo<Record<SectionKey, boolean>>(
		() => ({
			step1: false,
			step2: firstPendingStep !== null && 2 > firstPendingStep,
			step3: firstPendingStep !== null && 3 > firstPendingStep,
			step4: firstPendingStep !== null && 4 > firstPendingStep,
			step5: firstPendingStep !== null && 5 > firstPendingStep,
		}),
		[firstPendingStep],
	);
	const doneStatus = resolveGitOverlayDoneStatus(completedActions);
	const doneStatusLabel = doneStatus === 'closed'
		? t('status.closed')
		: doneStatus === 'review'
			? t('status.review')
			: doneStatus === 'report'
				? t('status.report')
				: '';
	const isSwitchingTrackedBranch = busyAction === 'switchBranch:tracked';
	const isApplyingAllBranchTargets = busyAction === 'applyBranchTargets:all';
	const step1Title = isStartChatPreflightMode
		? t('editor.gitOverlayStartChatCheckTitle')
		: isOpenChatPreflightMode
			? t('editor.gitOverlayOpenChatCheckTitle')
			: t('editor.gitOverlayStepSwitchTitle');
	const step1Hint = isStartChatPreflightMode
		? t('editor.gitOverlayStartChatCheckHint')
		: isOpenChatPreflightMode
			? t('editor.gitOverlayOpenChatCheckHint')
			: t('editor.gitOverlayStepSwitchHint');
	const step1SuccessMessage = isChatPreflightMode ? t('editor.gitOverlayStartChatBranchCheckReady') : t('editor.gitOverlayAllProjectsOnPrompt');
	const dialogFooterHint = isStartChatPreflightMode
		? (startChatBranchCheckDone ? t('editor.gitOverlayStartChatReadyHint') : t('editor.gitOverlayStartChatBlockedHint'))
		: isOpenChatPreflightMode
			? (startChatBranchCheckDone ? t('editor.gitOverlayOpenChatReadyHint') : t('editor.gitOverlayOpenChatBlockedHint'))
		: (doneStatus ? t('editor.gitOverlayDoneStatusHint').replace('{status}', doneStatusLabel) : t('editor.gitOverlayDoneNoStatusHint'));

	useEffect(() => {
		if (!snapshot) {
			setReviewDrafts({});
			lastSyncedTrackedBranchesRef.current = {};
			return;
		}

		const totalProjects = snapshot.projects.length;
		const previousTrackedBranches = lastSyncedTrackedBranchesRef.current;
		setReviewDrafts((prev) => {
			const next: Record<string, ReviewDraft> = {};
			for (const project of snapshot.projects) {
				const previousDraft = prev[project.project];
				const selectedTrackedBranch = (resolvedTrackedBranchesByProject[project.project] || '').trim();
				const options = buildProjectTargetBranchOptions(project, trackedBranchOptions, selectedTrackedBranch || preferredTrackedBranch);
				const preferredTargetBranch = (project.review.request?.targetBranch || '').trim()
					|| selectedTrackedBranch
					|| options[0]
					|| '';
				const previousTrackedBranch = (previousTrackedBranches[project.project] || '').trim();
				const canSyncTargetBranch = !previousDraft
					|| !previousDraft.manualTargetBranch
					|| !previousDraft.targetBranch
					|| previousDraft.targetBranch === previousTrackedBranch;
				const targetBranch = canSyncTargetBranch
					? (options.includes(preferredTargetBranch) ? preferredTargetBranch : options[0] || preferredTargetBranch)
					: (options.includes(previousDraft.targetBranch) ? previousDraft.targetBranch : preferredTargetBranch);
				next[project.project] = {
					targetBranch,
					title: previousDraft?.manualTitle
						? previousDraft.title
						: (project.review.request?.title || buildGitOverlayReviewRequestTitle({
							promptTitle,
							taskNumber: promptTaskNumber,
								titlePrefix: project.review.titlePrefix,
							projectName: project.project,
							projectCount: totalProjects,
						})),
					manualTitle: Boolean(previousDraft?.manualTitle),
					manualTargetBranch: Boolean(previousDraft?.manualTargetBranch),
				};
			}
			return next;
		});
		lastSyncedTrackedBranchesRef.current = resolvedTrackedBranchesByProject;
	}, [preferredTrackedBranch, promptTaskNumber, promptTitle, resolvedTrackedBranchesByProject, snapshot, trackedBranchOptions]);

	useEffect(() => {
		if (!open) {
			setSelectedTrackedBranchesByProject({});
			setSelectedTargetBranchesByProject({});
			setSelectedChangeKey('');
			lastSyncedTrackedBranchesRef.current = {};
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
		if (!snapshot) {
			setSelectedChangeKey('');
			return;
		}

		if (!selectedChangeKey) {
			return;
		}

		const hasSelectedChange = snapshot.projects.some(project => collectProjectChanges(project).some(
			change => buildGitOverlayChangeSelectionKey(project.project, change) === selectedChangeKey,
		));

		if (!hasSelectedChange) {
			setSelectedChangeKey('');
		}
	}, [selectedChangeKey, snapshot]);

	const handleTrackedBranchSelection = useCallback((projectName: string, trackedBranch: string) => {
		const normalizedTrackedBranch = trackedBranch.trim();
		const nextSelections = {
			...selectedTrackedBranchesByProject,
			[projectName]: normalizedTrackedBranch,
		};
		if (!normalizedTrackedBranch) {
			delete nextSelections[projectName];
		}

		setSelectedTrackedBranchesByProject(nextSelections);
		onTrackedBranchChange?.(
			resolveTrackedBranchesByProject(
				selectedSnapshotProjects,
				trackedBranchOptions,
				nextSelections,
				normalizedPreferredTrackedBranchesByProject,
				preferredTrackedBranch,
			),
		);
	}, [normalizedPreferredTrackedBranchesByProject, onTrackedBranchChange, preferredTrackedBranch, selectedSnapshotProjects, selectedTrackedBranchesByProject, trackedBranchOptions]);

	const handleTargetBranchSelection = useCallback((projectName: string, targetBranch: string) => {
		const normalizedTargetBranch = targetBranch.trim();
		setSelectedTargetBranchesByProject((prev) => {
			const nextSelections = {
				...prev,
				[projectName]: normalizedTargetBranch,
			};
			if (!normalizedTargetBranch) {
				delete nextSelections[projectName];
			}
			return nextSelections;
		});
	}, []);

	const handleSelectProjectChange = useCallback((projectName: string, change: GitOverlayChangeFile) => {
		setSelectedChangeKey(buildGitOverlayChangeSelectionKey(projectName, change));
	}, []);

	const handleOpenProjectFile = useCallback((projectName: string, change: GitOverlayChangeFile) => {
		handleSelectProjectChange(projectName, change);
		onOpenFile(projectName, change.path);
	}, [handleSelectProjectChange, onOpenFile]);

	const handleOpenProjectDiff = useCallback((projectName: string, change: GitOverlayChangeFile) => {
		handleSelectProjectChange(projectName, change);
		onOpenDiff(projectName, change.path);
	}, [handleSelectProjectChange, onOpenDiff]);

	const handleOpenProjectMergeEditor = useCallback((projectName: string, change: GitOverlayChangeFile) => {
		handleSelectProjectChange(projectName, change);
		onOpenMergeEditor(projectName, change.path);
	}, [handleSelectProjectChange, onOpenMergeEditor]);

	const handleApplyProjectBranchTargets = useCallback((projectName: string) => {
		const sourceBranch = (resolvedTrackedBranchesByProject[projectName] || '').trim();
		const project = selectedSnapshotProjects.find(item => item.project === projectName);
		if (!project) {
			return;
		}
		const selectedTargetBranch = (resolvedTargetBranchesByProject[projectName] || '').trim();
		if (isGitOverlayCurrentExpectedBranchSelection(selectedTargetBranch)) {
			return;
		}
		const targetBranch = resolveGitOverlayEffectiveExpectedBranch(project, selectedTargetBranch, promptBranch, trackedBranchOptions);
		if (!targetBranch || targetBranch === project.currentBranch.trim()) {
			return;
		}
		onApplyBranchTargets?.(
			sourceBranch ? { [projectName]: sourceBranch } : {},
			{ [projectName]: targetBranch },
			projectName,
		);
	}, [onApplyBranchTargets, promptBranch, resolvedTargetBranchesByProject, resolvedTrackedBranchesByProject, selectedSnapshotProjects, trackedBranchOptions]);

	const handleAddProjectToPrompt = useCallback((projectName: string) => {
		if (!onUpdateProjects) {
			return;
		}

		const nextProjectNames = normalizeGitOverlayProjectNames([
			...effectiveSelectedProjectNames,
			projectName,
		]);
		onUpdateProjects(nextProjectNames);
	}, [effectiveSelectedProjectNames, onUpdateProjects]);

	const handleExcludeProjectFromPrompt = useCallback((projectName: string) => {
		if (!onUpdateProjects) {
			return;
		}

		const nextProjectNames = effectiveSelectedProjectNames.filter(name => name !== projectName);
		onUpdateProjects(nextProjectNames);
	}, [effectiveSelectedProjectNames, onUpdateProjects]);

	useEffect(() => {
		if (!snapshot) {
			setExpandedProjects({});
			setCollapsedSections({});
			return;
		}

		setExpandedProjects((prev) => {
			const next: Record<string, boolean> = {};
			for (const project of allProjects) {
				const validation = projectValidations.get(project.project);
				const defaultOpen = Boolean(
					(validation?.hasChanges
						&& (
							validation.branchMismatch
							|| validation.hasConflicts
							|| validation.needsMessage
							|| projectsWithChanges.length === 1
						))
					|| (!selectedProjectNameSet.has(project.project)
						&& countProjectChanges(project) > 0
						&& otherChangedProjects.length === 1)
				);
				next[project.project] = prev[project.project] ?? defaultOpen;
			}
			return next;
		});
	}, [allProjects, otherChangedProjects.length, projectValidations, projectsWithChanges.length, selectedProjectNameSet, snapshot]);

	const updateReviewDraftTargetBranch = useCallback((projectName: string, targetBranch: string) => {
		setReviewDrafts((prev) => ({
			...prev,
			[projectName]: {
				...(prev[projectName] || { title: '', targetBranch: '', manualTitle: false, manualTargetBranch: false }),
				targetBranch,
				manualTargetBranch: true,
			},
		}));
	}, []);

	const updateReviewDraftTitle = useCallback((projectName: string, title: string) => {
		setReviewDrafts((prev) => ({
			...prev,
			[projectName]: {
				...(prev[projectName] || { title: '', targetBranch: '', manualTitle: false, manualTargetBranch: false }),
				title,
				manualTitle: true,
			},
		}));
	}, []);

	const regenerateReviewDraftTitle = useCallback((projectName: string) => {
		const totalProjects = selectedSnapshotProjects.length;
		const project = selectedSnapshotProjects.find(item => item.project === projectName);
		setReviewDrafts((prev) => ({
			...prev,
			[projectName]: {
				...(prev[projectName] || { title: '', targetBranch: '', manualTitle: false, manualTargetBranch: false }),
				title: buildGitOverlayReviewRequestTitle({
					promptTitle,
					taskNumber: promptTaskNumber,
					titlePrefix: project?.review.titlePrefix,
					projectName,
					projectCount: totalProjects,
				}),
				manualTitle: false,
			},
		}));
	}, [promptTaskNumber, promptTitle, selectedSnapshotProjects]);

	const handleCreateReviewRequest = useCallback((project: GitOverlayProjectSnapshot) => {
		const draft = reviewDrafts[project.project];
		if (!draft) {
			return;
		}

		onCreateReviewRequest([{
			project: project.project,
			targetBranch: draft.targetBranch.trim(),
			title: draft.title.trim(),
			draft: true,
			removeSourceBranch: false,
		}]);
	}, [onCreateReviewRequest, reviewDrafts]);

	const handleCreateAllReviewRequests = useCallback(() => {
		if (bulkReviewRequests.length === 0) {
			return;
		}

		onCreateReviewRequest(bulkReviewRequests);
	}, [bulkReviewRequests, onCreateReviewRequest]);

	const handleCopyAllReviewRequestLinks = useCallback(() => {
		if (!reviewRequestLinksText || typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') {
			return;
		}

		navigator.clipboard.writeText(reviewRequestLinksText).catch(() => undefined);
	}, [reviewRequestLinksText]);

	const handleSetupReviewCli = useCallback((project: GitOverlayProjectSnapshot) => {
		const remote = project.review.remote;
		const setupAction = project.review.setupAction;
		if (!remote?.cliCommand || !setupAction) {
			return;
		}

		onSetupReviewCli({
			project: project.project,
			cliCommand: remote.cliCommand,
			host: remote.host,
			action: setupAction,
		});
	}, [onSetupReviewCli]);

	const isLoadingOverlay = busyAction === 'overlay:loading' && !snapshot;
	const isRefreshing = busyAction === 'refresh:local';
	const isFetching = busyAction === 'refresh:fetch';
	const isSyncing = busyAction === 'refresh:sync';
	const isAutoRefreshing = busyAction === 'refresh:auto';
	const isEnsuringPromptBranch = busyAction === 'ensurePromptBranch';
	const isPushing = busyAction === 'pushPromptBranch';
	const isMerging = busyAction === 'mergePromptBranch';
	const isGeneratingAll = busyAction === 'generateCommitMessage:all';
	const isCommittingAll = busyAction === 'commitStaged:all';
	const isCreatingAllReviewRequests = busyAction === 'createReviewRequest:all';

	const refreshProgressMode: RefreshProgressMode = isLoadingOverlay
		? 'loading'
		: isAutoRefreshing
			? 'auto'
			: isSyncing
				? 'sync'
				: isFetching
					? 'fetch'
					: isRefreshing
						? 'local'
						: 'idle';
	const stayOnTrackedBranchLabel = uniqueTrackedBranches.length === 1
		? t('editor.gitOverlayStayOnTrackedBranchNamed').replace('{branch}', uniqueTrackedBranches[0])
		: t('editor.gitOverlayStayOnTrackedBranch');
	const headerSubtitle = processLabel
		? `${t('editor.gitOverlayProcessPrefix')} ${processLabel}`
		: t('editor.gitOverlaySubtitle');
	const isProcessSubtitleActive = Boolean(processLabel && busyAction);
	const isSectionCollapsed = (section: SectionKey): boolean => collapsedSections[section] ?? autoCollapsedSections[section];
	const isSectionAutoCollapsed = (section: SectionKey): boolean => collapsedSections[section] === undefined && autoCollapsedSections[section];

		if (!open) {
			return null;
		}

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

	const getSectionHeaderStyle = (section: SectionKey): CSSProperties => ({
		...styles.sectionHeader,
		...(isSectionCollapsed(section) && !isSectionAutoCollapsed(section)
			? styles.sectionHeaderCollapsed
			: styles.sectionHeaderExpanded),
	});

	return (
		<div style={styles.backdrop} onClick={onClose}>
			<div
				style={{
					...styles.panelViewport,
					...(dockToSecondHalf ? styles.panelViewportSecondHalf : null),
				}}
			>
			<div style={styles.dialog} onClick={(event) => event.stopPropagation()}>
				<div style={styles.header}>
					<div style={styles.headerInfo}>
						<h2 style={styles.headerTitle}>{t('editor.gitOverlayTitle')}</h2>
						<div
							style={{
								...styles.headerSubtitle,
								...(isProcessSubtitleActive ? styles.headerSubtitleActive : null),
							}}
						>
							{headerSubtitle}
						</div>
					</div>
					<div style={styles.headerActions}>
						<HeaderIconButton label={t('editor.gitOverlayRefresh')} onClick={() => onRefresh('local')} loading={isRefreshing} />
						<ActionButton label={t('common.close')} onClick={onClose} />
					</div>
				</div>

				<ProgressLine
					mode={refreshProgressMode}
					modeAttributeName="data-pm-git-overlay-progress"
					phaseAttributeName="data-pm-git-overlay-progress-phase"
				/>

				{!snapshot ? (
					<div style={styles.loadingWrap}>
						<div style={styles.loadingCard}>
							{isLoadingOverlay ? <span style={styles.largeSpinner} /> : null}
							<div style={styles.loadingText}>{isLoadingOverlay ? t('editor.gitOverlayLoading') : t('editor.gitOverlayEmpty')}</div>
						</div>
					</div>
				) : (
					<>
					<div style={styles.body}>
						<div style={styles.summaryRow}>
							<div style={styles.summaryChip}>{`${t('editor.gitOverlayProjects')}: ${step1Projects.length}`}</div>
							<div style={styles.summaryChip}>{`${t('editor.gitOverlayProjectsWithChanges')}: ${projectsWithChanges.length}`}</div>
							<div style={styles.summaryChip}>{`${t('editor.gitOverlayProjectChanges')}: ${totalChangedFiles}`}</div>
							<div style={styles.summaryChip}>{`${t('editor.gitOverlayConflicts')}: ${projectsWithChanges.filter(project => project.changeGroups.merge.length > 0).length}`}</div>
							{!isChatPreflightMode && otherChangedProjects.length > 0 ? (
								<div style={styles.summaryChip}>{`${t('editor.gitOverlayOtherProjectsTitle')}: ${otherChangedProjects.length}`}</div>
							) : null}
						</div>

						<section style={styles.sectionCard}>
							<div style={getSectionHeaderStyle('step1')}>
								<div style={styles.sectionHeaderLeft}>
									<div style={{ ...styles.sectionNumber, ...(stepAvailability.step1 ? null : styles.sectionNumberDisabled) }}>1</div>
									<div>
										<div style={styles.sectionTitle}>{step1Title}</div>
										<div style={styles.sectionSubtitle}>{step1Hint}</div>
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
								{isReadOnlyFlow ? <InlineHint message={t('editor.gitOverlayReadOnlyModeHint')} tone="error" /> : null}
								{isReadOnlyFlow && onMarkCompletedInPlace ? (
									<div style={styles.inlineActionRow}>
										<ActionButton
											label={t('editor.gitOverlayMarkCompletedInPlace')}
											onClick={onMarkCompletedInPlace}
											variant="success"
										/>
									</div>
								) : null}
								<div style={styles.fieldBlock}>
									<label style={styles.label}>{t('editor.gitOverlayPromptBranch')}</label>
									<div style={{
										...styles.readonlyField,
										...(showPromptBranchMissingError ? styles.errorField : null),
									}}>
										{promptBranch || (showPromptBranchMissingError ? t('editor.gitOverlayPromptBranchMissing') : '—')}
									</div>
								</div>

								{trackedBranchOptions.length === 0 ? <InlineHint message={t('editor.gitOverlayNoTrackedBranches')} tone="error" /> : null}
								{showPromptBranchFallbackInfo ? <InlineHint message={t('editor.gitOverlayPromptBranchFallbackInfo')} tone="info" /> : null}
								{isChatPreflightMode
									? (syncRequired
										? <InlineHint message={t('editor.gitOverlayPullChangesRequired')} tone="error" />
										: startChatBranchMismatches.length > 0
											? <InlineHint message={t(isOpenChatPreflightMode ? 'editor.gitOverlayOpenChatProjectNeedsSwitch' : 'editor.gitOverlayStartChatProjectNeedsSwitch')} tone="error" />
											: null)
									: (defaultStep1ReadyOnTrackedBranches
										? (syncRequired
											? <InlineHint message={t('editor.gitOverlayPullChangesRequired')} tone="error" />
											: <InlineHint
												message={t(
													isDraftPrompt
														? 'editor.gitOverlayTrackedBranchStepReadyHint'
														: 'editor.gitOverlayTrackedBranchSwitchRequiredHint'
												)}
												tone={isDraftPrompt ? 'info' : 'error'}
											/>)
									: showProjectNeedsTrackedOrPromptSwitchHint
											? <InlineHint message={t('editor.gitOverlayProjectNeedsTrackedOrPromptSwitch')} tone="error" />
											: syncRequired
												? <InlineHint message={t('editor.gitOverlayPullChangesRequired')} tone="error" />
											: null)}

								{syncRequired ? (
									<div style={styles.inlineActionRow}>
										<ActionButton
											label={t('editor.gitOverlayPullAllChanges')}
											onClick={() => onRefresh('sync')}
											disabled={isReadOnlyFlow}
											loading={isSyncing}
											variant="primary"
										/>
									</div>
								) : null}

									{showEmptyStep1Hint ? <InlineHint message={t('editor.gitOverlayStepSwitchNothingToDo')} tone="info" /> : null}
									{showNoChangesToCommitHint ? <InlineHint message={t('editor.gitOverlayStepSwitchNoChangesToCommit')} tone="info" /> : null}
									{showStep1NoProjectChangesHint ? <InlineHint message={t('editor.gitOverlayStepNoProjectChanges')} tone="info" /> : null}

									{!isChatPreflightMode && otherChangedProjects.length > 0 ? (
										<div style={styles.fieldBlock}>
											<div style={styles.otherProjectsHeader}>
												<div style={styles.otherProjectsTitle}>{t('editor.gitOverlayOtherProjectsTitle')}</div>
												<div style={styles.otherProjectsHint}>{t('editor.gitOverlayOtherProjectsHint')}</div>
											</div>
											<div style={styles.projectCards}>
												{otherChangedProjects.map((project) => {
													const projectChanges = collectProjectChanges(project);
													const expanded = Boolean(expandedProjects[project.project]);
													return (
														<div key={project.project} style={styles.projectCard}>
															<div style={styles.projectCardHeader}>
																<div style={styles.projectCardTitleWrap}>
																	<div style={styles.projectCardTitleLine}>
																		<div style={styles.projectCardTitle}>{project.project}</div>
																		<div style={styles.projectCardSummary}>{buildProjectChangesSummary(project, t)}</div>
																	</div>
																</div>
																<div style={styles.projectCardHeaderActions}>
																	<ActionButton
																		label={t('editor.gitOverlayAddProject')}
																		onClick={() => handleAddProjectToPrompt(project.project)}
																		disabled={isReadOnlyFlow || !canUpdatePromptProjects}
																		variant="success"
																		size="compact"
																	/>
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
																			const changeSelectionKey = buildGitOverlayChangeSelectionKey(project.project, change);
																			const isSelectedChange = changeSelectionKey === selectedChangeKey;

																			return (
																				<div
																					key={`${project.project}-${change.group}-${change.path}-${change.status}`}
																					data-selected={isSelectedChange ? 'true' : undefined}
																					style={{
																						...styles.changeRow,
																						...(index > 0 ? styles.changeRowBorderTop : null),
																						...(isSelectedChange ? styles.changeRowSelected : null),
																					}}
																				>
																					<div style={styles.changeInfo} title={change.previousPath ? `${change.previousPath} -> ${change.path}` : change.path}>
																						<div style={styles.changeBadges}>
																							<span style={styles.changeStatusBadge}>{buildStatusLabel(change.status)}</span>
																							<span style={styles.changeGroupBadge}>{buildChangeGroupLabel(change, t)}</span>
																						</div>
																						<button
																							type="button"
																							onClick={() => handleOpenProjectDiff(project.project, change)}
																							style={{
																								...styles.changeInfoButton,
																								...(isSelectedChange ? styles.changeInfoButtonSelected : null),
																							}}
																						>
																							<div style={styles.changePathGroup}>
																								<div style={styles.changePath}>{change.path}</div>
																								{change.previousPath ? <div style={styles.changePreviousPath}>{`← ${change.previousPath}`}</div> : null}
																							</div>
																							<div style={styles.changeMetrics}>{renderChangeMetrics(change, t)}</div>
																						</button>
																					</div>
																					<div style={styles.changeActions}>
																						<TextActionButton label={t('editor.gitOverlayOpenFile')} onClick={() => handleOpenProjectFile(project.project, change)} />
																						<TextActionButton label={t('editor.gitOverlayOpenDiff')} onClick={() => handleOpenProjectDiff(project.project, change)} />
																						{change.conflicted ? <TextActionButton label={t('editor.gitOverlayOpenMergeEditor')} onClick={() => handleOpenProjectMergeEditor(project.project, change)} /> : null}
																					</div>
																				</div>
																			);
																		})}
																	</div>
																</div>
															) : null}
														</div>
													);
												})}
											</div>
										</div>
									) : null}

								{step1Projects.length > 0 ? (
									<div style={styles.projectTable}>
									<div style={styles.projectTableHeader}>
										<span>{t('editor.gitOverlayProjectName')}</span>
										<span style={styles.projectTableHeaderCentered}>{t('editor.gitOverlayProjectCurrentBranch')}</span>
											<span>{t('editor.gitOverlayProjectSourceBranch')}</span>
											<span>{t('editor.gitOverlayProjectExpectedBranch')}</span>
										<span style={styles.projectTableHeaderCentered}>{t('editor.gitOverlayProjectChanges')}</span>
										<span style={styles.projectTableHeaderCentered}>{t('editor.gitOverlayProjectState')}</span>
											<span>{t('editor.gitOverlayProjectAction')}</span>
									</div>
									{step1Projects.map((project) => {
											const currentBranch = project.currentBranch.trim();
											const projectHasChanges = countProjectChanges(project) > 0;
											const selectedTrackedBranch = (resolvedTrackedBranchesByProject[project.project] || '').trim();
											const selectedTargetBranch = (resolvedTargetBranchesByProject[project.project] || '').trim();
											const projectTrackedBranchOptions = buildProjectTrackedBranchOptions(project, trackedBranchOptions, selectedTrackedBranch || preferredTrackedBranch);
											const projectExpectedBranchOptions = buildProjectExpectedBranchOptions(project, trackedBranchOptions, selectedTrackedBranch || preferredTrackedBranch);
											const projectNeedsSync = project.available && Boolean(project.upstream.trim()) && project.behind > 0;
											const currentTargetSelected = isGitOverlayCurrentExpectedBranchSelection(selectedTargetBranch);
											const effectiveTargetBranch = resolveGitOverlayEffectiveExpectedBranch(project, selectedTargetBranch, promptBranch, trackedBranchOptions);
											const projectNeedsTargetSwitch = Boolean(effectiveTargetBranch) && currentBranch !== effectiveTargetBranch;
											const projectActionableForApply = currentTargetSelected
												? false
												: projectNeedsTargetSwitch
												|| isGitOverlayStep1ProjectActionable(project, promptBranch, trackedBranchOptions);
											const targetRequiresSource = shouldGitOverlayRequireSourceBranch(project, effectiveTargetBranch);
											const hideSourceBranchField = projectTrackedBranchOptions.length === 0
												|| currentTargetSelected
												|| (Boolean(effectiveTargetBranch) && !targetRequiresSource);
											const hideExpectedBranchField = projectExpectedBranchOptions.length === 0
												&& (!currentBranch || (!selectedTargetBranch && !projectActionableForApply));
											const rowOnPrompt = Boolean(promptBranch) && currentBranch === promptBranch && effectiveTargetBranch === promptBranch;
											const rowCanApply = project.available
												&& projectActionableForApply
												&& !projectNeedsSync
												&& Boolean(effectiveTargetBranch)
												&& (!targetRequiresSource || Boolean(selectedTrackedBranch))
												&& projectNeedsTargetSwitch;
											const rowNeedsDecision = project.available
												&& projectActionableForApply
												&& !rowOnPrompt
												&& ((targetRequiresSource && !selectedTrackedBranch) || !effectiveTargetBranch || projectNeedsSync || projectNeedsTargetSwitch);
											const rowStatusLabel = !project.available
												? t('editor.gitOverlayStateUnavailable')
												: currentTargetSelected
													? t('editor.gitOverlayStateCurrentSelected')
												: !projectActionableForApply
													? t('editor.gitOverlayStateNoChanges')
												: projectNeedsSync
													? t('editor.gitOverlayStateNeedsSync')
														: (targetRequiresSource && !selectedTrackedBranch)
														? t('editor.gitOverlayStateNeedsSource')
														: !effectiveTargetBranch
															? t('editor.gitOverlayStateNeedsTarget')
															: rowOnPrompt
																? t('editor.gitOverlayStateOnPrompt')
																: currentBranch === effectiveTargetBranch
																	? t('editor.gitOverlayStateReady')
																	: t('editor.gitOverlayStateNeedsSwitch');
											const rowActionLoading = busyAction === `applyBranchTargets:${project.project}` || isApplyingAllBranchTargets;
														const showExcludeProjectAction = !isChatPreflightMode
															&& project.available
															&& !projectHasChanges
															&& !rowCanApply
															&& canUpdatePromptProjects;
											const rowStyle = rowOnPrompt
												? styles.projectTableRowSuccess
												: (!project.available ? styles.projectTableRowMuted : rowNeedsDecision ? styles.projectTableRowDecision : null);
											const rowStatusStyle = !project.available
												? styles.projectStatusTextMuted
												: !projectActionableForApply
													? styles.projectStatusTextMuted
												: rowOnPrompt
													? styles.projectStatusTextOk
												: rowNeedsDecision
													? styles.projectStatusTextError
													: styles.projectStatusTextInfo;
										return (
											<div key={project.project} style={{
												...styles.projectTableRow,
													...(rowStyle || null),
											}}>
												<span style={styles.projectName}>{project.project}</span>
												<span style={styles.projectTableCellCentered}>
														{currentBranch || '—'}
													</span>
													<span style={styles.branchValue}>
													{hideSourceBranchField ? (
														<span style={styles.projectTableCellCentered}>—</span>
													) : (
														<select
															style={{
																...styles.select,
																paddingTop: 6,
																paddingBottom: 6,
																minWidth: 0,
																...((targetRequiresSource && !selectedTrackedBranch) ? styles.errorField : null),
															}}
															value={selectedTrackedBranch}
															onChange={(event) => handleTrackedBranchSelection(project.project, event.target.value)}
															disabled={isReadOnlyFlow || projectTrackedBranchOptions.length === 0}
														>
															<option value="">{t('editor.gitOverlaySelectPlaceholder')}</option>
															{projectTrackedBranchOptions.map(branch => (
																<option key={`${project.project}-${branch}`} value={branch}>{branch}</option>
															))}
														</select>
													)}
												</span>
													<span style={styles.branchValue}>
														{hideExpectedBranchField ? (
															<span style={styles.projectTableCellCentered}>—</span>
														) : (
															<select
																style={{
																	...styles.select,
																	paddingTop: 6,
																	paddingBottom: 6,
																	minWidth: 0,
																	...(!effectiveTargetBranch ? styles.errorField : null),
																}}
																value={selectedTargetBranch}
																onChange={(event) => handleTargetBranchSelection(project.project, event.target.value)}
																disabled={isReadOnlyFlow}
															>
																<option value="">{t('editor.gitOverlaySelectPlaceholder')}</option>
																<option value={GIT_OVERLAY_EXPECTED_BRANCH_CURRENT}>{t('editor.gitOverlayProjectExpectedCurrentBranch')}</option>
																{projectExpectedBranchOptions.map(branch => (
																	<option key={`${project.project}-target-${branch}`} value={branch}>{branch}</option>
																))}
															</select>
														)}
													</span>
													<span style={styles.projectMetaCentered} title={buildProjectChangesSummary(project, t)}>{countProjectChanges(project)}</span>
												<span style={styles.projectStateCell}>
													<span style={{
														...styles.projectStatusText,
														...rowStatusStyle,
													}}>
														{rowStatusLabel}
														</span>
													</span>
													<span style={styles.projectRowActionCell}>
														{showExcludeProjectAction ? (
															<ActionButton
																label={t('editor.gitOverlayExcludeProject')}
																onClick={() => handleExcludeProjectFromPrompt(project.project)}
																disabled={isReadOnlyFlow}
																variant="danger"
																size="compact"
															/>
														) : (
															<ActionButton
																label={t('editor.gitOverlaySwitch')}
																onClick={() => handleApplyProjectBranchTargets(project.project)}
																disabled={isReadOnlyFlow || !rowCanApply}
																loading={rowActionLoading}
																hidden={shouldHideActionWhileWaiting(`applyBranchTargets:${project.project}`)}
																variant="primary"
																size="compact"
															/>
														)}
													</span>
											</div>
										);
									})}
								</div>
								) : null}

								<div style={styles.actionRowEnd}>
									{shouldShowStep1Success ? <span style={styles.successText}>{step1ResolvedSuccessMessage}</span> : null}
										{!showEmptyStep1Hint ? (
										<ActionButton
												label={t('editor.gitOverlaySwitchAll')}
												onClick={() => onApplyBranchTargets?.(step1ApplySourceBranches, step1ApplyTargetBranches)}
												disabled={isReadOnlyFlow || !canApplyAllBranchTargets}
												loading={isApplyingAllBranchTargets}
											hidden={shouldHideActionWhileWaiting('applyBranchTargets:all')}
											variant="primary"
										/>
									) : null}
								</div>
							</div>
							)}
						</section>

						{showDefaultFlowFollowUpSteps ? (
						<section style={styles.sectionCard}>
							<div style={getSectionHeaderStyle('step2')}>
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
											const isDiscardingProject = busyAction === `discardProject:${project.project}`;
										const expanded = Boolean(expandedProjects[project.project]);
										return (
											<div key={project.project} style={styles.projectCard}>
												<div style={styles.projectCardHeader}>
													<div style={styles.projectCardTitleWrap}>
															<div style={styles.projectCardTitleLine}>
																<div style={styles.projectCardTitle}>{project.project}</div>
																<div style={styles.projectCardSummary}>{buildProjectChangesSummary(project, t)}</div>
															</div>
													</div>
													<div style={styles.projectCardHeaderActions}>
															<TextActionButton
																label={t('editor.gitOverlayDiscardProjectChanges')}
																onClick={() => onDiscardProjectChanges?.(project.project, projectChanges)}
																tone="danger"
																disabled={isReadOnlyFlow || projectChanges.length === 0 || !onDiscardProjectChanges}
																loading={isDiscardingProject}
																hidden={shouldHideActionWhileWaiting(`discardProject:${project.project}`)}
															/>
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
																const changeSelectionKey = buildGitOverlayChangeSelectionKey(project.project, change);
																const isSelectedChange = changeSelectionKey === selectedChangeKey;

																return (
																	<div
																		key={`${project.project}-${change.group}-${change.path}-${change.status}`}
																		data-selected={isSelectedChange ? 'true' : undefined}
																		style={{
																			...styles.changeRow,
																			...(index > 0 ? styles.changeRowBorderTop : null),
																			...(isSelectedChange ? styles.changeRowSelected : null),
																		}}
																	>
																		<div style={styles.changeInfo} title={change.previousPath ? `${change.previousPath} -> ${change.path}` : change.path}>
																			<div style={styles.changeBadges}>
																				<span style={styles.changeStatusBadge}>{buildStatusLabel(change.status)}</span>
																				<span style={styles.changeGroupBadge}>{buildChangeGroupLabel(change, t)}</span>
																			</div>
																			<button
																				type="button"
																				onClick={() => handleOpenProjectDiff(project.project, change)}
																				style={{
																					...styles.changeInfoButton,
																					...(isSelectedChange ? styles.changeInfoButtonSelected : null),
																				}}
																				disabled={isDiscarding}
																			>
																				<div style={styles.changePathGroup}>
																					<div style={styles.changePath}>{change.path}</div>
																					{change.previousPath ? <div style={styles.changePreviousPath}>{`← ${change.previousPath}`}</div> : null}
																				</div>
																				<div style={styles.changeMetrics}>{renderChangeMetrics(change, t)}</div>
																			</button>
																		</div>
																		<div style={styles.changeActions}>
																			<TextActionButton
																				label={t('editor.gitOverlayDiscardFile')}
																				onClick={() => onDiscardFile(project.project, change.path, change.group, change.previousPath)}
																				tone="danger"
																				disabled={isReadOnlyFlow}
																				loading={isDiscarding}
																				hidden={shouldHideActionWhileWaiting(`discardFile:${project.project}:${change.group}:${change.path}`)}
																			/>
																				<TextActionButton label={t('editor.gitOverlayOpenFile')} onClick={() => handleOpenProjectFile(project.project, change)} disabled={isDiscarding} />
																				<TextActionButton label={t('editor.gitOverlayOpenDiff')} onClick={() => handleOpenProjectDiff(project.project, change)} disabled={isDiscarding} />
																				{change.conflicted ? <TextActionButton label={t('editor.gitOverlayOpenMergeEditor')} onClick={() => handleOpenProjectMergeEditor(project.project, change)} disabled={isDiscarding} /> : null}
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
														disabled={isReadOnlyFlow || !validation?.available || validation.branchMismatch || validation.hasConflicts}
														style={{
															...styles.textArea,
															...((isReadOnlyFlow || !validation?.available || validation.branchMismatch || validation.hasConflicts) ? styles.textAreaDisabled : null),
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
														disabled={isReadOnlyFlow || !validation?.available || validation.branchMismatch || validation.hasConflicts}
														loading={isGeneratingProject}
														hidden={shouldHideActionWhileWaiting(`generateCommitMessage:${project.project}`)}
													/>
													<ActionButton
														label={t('editor.gitOverlayCommitProject')}
														onClick={() => onCommitStaged([{ project: project.project, message: projectCommitMessage.trim() }])}
														disabled={isReadOnlyFlow || !validation?.committable}
														loading={isCommittingProject}
														hidden={shouldHideCommitActionWhileWaiting(project.project)}
														variant="primary"
													/>
												</div>
											</div>
										);
									})}
								</div>

								<div style={styles.actionRowEnd}>
									{projectsReadyForGenerate.length > 0 ? (
										<ActionButton
											label={t('editor.gitOverlayGenerateAllCommitMessages')}
											onClick={() => onGenerateCommitMessage()}
											disabled={isReadOnlyFlow || !canGenerateAllCommitMessages}
											loading={isGeneratingAll}
											hidden={shouldHideActionWhileWaiting('generateCommitMessage:all')}
										/>
									) : null}
									{projectsWithChanges.length > 0 ? (
										<ActionButton
											label={t('editor.gitOverlayCommitAll')}
											onClick={() => onCommitStaged(commitAllMessages)}
											disabled={isReadOnlyFlow || !canCommitAllProjects}
											loading={isCommittingAll}
											hidden={shouldHideCommitActionWhileWaiting()}
											variant="primary"
										/>
									) : null}
								</div>
							</div>
							)}
						</section>
						) : null}

						{showDefaultFlowFollowUpSteps ? (
						<section style={styles.sectionCard}>
							<div style={getSectionHeaderStyle('step3')}>
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
								{showPushNeedsPromptBranchHint ? <InlineHint message={t('editor.gitOverlayPushNeedsPromptBranch')} tone="error" /> : null}
								{projectsWithChangesOutsideTrackedOrPrompt.length > 0 ? <InlineHint message={t('editor.gitOverlayPushNeedsTrackedOrPromptBranch')} tone="error" /> : null}
								{projectsWithChangesOnTrackedBranches.map(project => (
									<InlineHint
										key={`push-tracked-${project.project}`}
										message={t('editor.gitOverlayPushTrackedBranchInfo')
											.replace('{project}', project.project)
											.replace('{branch}', project.currentBranch.trim() || '—')}
										tone="info"
									/>
								))}
								{projectsWithChanges.length > 0 ? <InlineHint message={t('editor.gitOverlayPushNeedsCleanState')} tone="error" /> : null}
								{hasConflicts ? <InlineHint message={t('editor.gitOverlayMergeBlocked')} tone="error" /> : null}

								<div style={styles.mergeHint}>{t('editor.gitOverlayPushHintDetail')}</div>
								{canAttemptPush && !pushRequired ? <div style={styles.successText}>{t('editor.gitOverlayPushAlreadyPublished')}</div> : null}

								<div style={styles.actionRowEnd}>
									{pushRequired ? (
										<ActionButton
											label={t('editor.gitOverlayPushPromptBranch')}
														onClick={() => onPush(promptBranch || undefined, projectsNeedingPush.map(project => project.project))}
											disabled={isReadOnlyFlow || !canPush}
											loading={isPushing}
											variant="primary"
										/>
									) : null}
								</div>
							</div>
							)}
						</section>
						) : null}

						{showDefaultFlowFollowUpSteps ? (
						<section style={styles.sectionCard}>
							<div style={getSectionHeaderStyle('step4')}>
								<div style={styles.sectionHeaderLeft}>
									<div style={{ ...styles.sectionNumber, ...(stepAvailability.step4 ? null : styles.sectionNumberDisabled) }}>4</div>
									<div>
										<div style={styles.sectionTitle}>{t('editor.gitOverlayStepReviewRequestTitle')}</div>
										<div style={styles.sectionSubtitle}>{t('editor.gitOverlayStepReviewRequestHint')}</div>
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
								{!promptBranch ? <InlineHint message={t('editor.gitOverlayReviewRequestNeedsPromptBranch')} tone="error" /> : null}
								{flowProjectsOffPromptBranch.length > 0 ? <InlineHint message={t('editor.gitOverlayReviewRequestNeedsPromptCheckout')} tone="error" /> : null}
								{projectsWithChanges.length > 0 ? <InlineHint message={t('editor.gitOverlayReviewRequestNeedsCleanState')} tone="error" /> : null}
								{reviewProjects.length === 0 ? <div style={styles.emptyStateInline}>{t('editor.gitOverlayReviewRequestUnsupported')}</div> : null}

								<div style={styles.projectCards}>
									{reviewProjects.map((project) => {
										const actionLabel = project.review.remote?.actionLabel || t('editor.gitOverlayReviewRequest');
										const selectedTrackedBranch = (resolvedTrackedBranchesByProject[project.project] || '').trim();
										const targetBranchOptions = buildProjectTargetBranchOptions(project, trackedBranchOptions, selectedTrackedBranch || preferredTrackedBranch);
										const draft = reviewDrafts[project.project] || {
											targetBranch: project.review.request?.targetBranch || selectedTrackedBranch,
											title: buildGitOverlayReviewRequestTitle({
												promptTitle,
												taskNumber: promptTaskNumber,
												titlePrefix: project.review.titlePrefix,
												projectName: project.project,
												projectCount: snapshot.projects.length,
											}),
											manualTitle: false,
											manualTargetBranch: false,
										};
										const hasRequest = Boolean(project.review.request);
										const hasSetupAction = Boolean(project.review.setupAction);
											const unsupportedReviewMessage = (!project.review.remote?.supported || project.review.unsupportedReason)
												? resolveReviewUnsupportedProjectMessage(project.review.unsupportedReason, t)
												: '';
										const isCreatingReviewRequest = busyAction === `createReviewRequest:${project.project}` || busyAction === 'createReviewRequest:all';
										const canCreateReviewRequest = Boolean(project.review.remote?.supported)
											&& Boolean(project.review.remote?.cliAvailable)
											&& !hasSetupAction
											&& Boolean(promptBranch)
											&& project.currentBranch === promptBranch
											&& Boolean(draft.targetBranch.trim())
											&& Boolean(draft.title.trim())
											&& !hasRequest;

										return (
											<div key={project.project} style={styles.projectCard}>
												<div style={styles.projectCardHeader}>
													<div style={styles.projectCardTitleWrap}>
														<div style={styles.projectCardTitle}>{project.project}</div>
														<div style={styles.projectCardSummary}>{`${actionLabel} • ${project.review.remote?.host || t('editor.gitOverlayUnavailable')}`}</div>
													</div>
													{hasRequest ? (
														<span style={{
															...styles.statePill,
															...(project.review.request?.state === 'accepted'
																? styles.statePillOk
																: project.review.request?.state === 'closed'
																	? styles.statePillMuted
																	: styles.statePillInfo),
														}}>
															{resolveReviewRequestStateLabel(project, t)}
														</span>
													) : null}
												</div>

												{unsupportedReviewMessage && project.review.unsupportedReason === 'unsupported-provider' && project.review.remote?.host ? (
													<>
														<InlineHint
															message={t('editor.gitOverlayReviewRequestChooseProvider').replace('{host}', project.review.remote.host)}
															tone="info"
														/>
														<div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
															<ActionButton
																label={t('editor.gitOverlayReviewRequestChooseGitHub')}
																onClick={() => onAssignReviewProvider(project.review.remote!.host, 'github')}
																size="compact"
																disabled={isReadOnlyFlow}
															/>
															<ActionButton
																label={t('editor.gitOverlayReviewRequestChooseGitLab')}
																onClick={() => onAssignReviewProvider(project.review.remote!.host, 'gitlab')}
																size="compact"
																disabled={isReadOnlyFlow}
															/>
														</div>
													</>
												) : unsupportedReviewMessage ? <InlineHint message={unsupportedReviewMessage} tone="info" /> : null}
												{project.review.setupAction === 'install-and-auth' ? (
													<InlineHint
														message={t('editor.gitOverlayReviewRequestMissingCli').replace('{cli}', project.review.remote?.cliCommand || 'CLI')}
														tone="info"
														actionLabel={t('editor.gitOverlayReviewRequestSetupCli').replace('{cli}', project.review.remote?.cliCommand || 'CLI')}
														onAction={() => handleSetupReviewCli(project)}
														actionDisabled={isReadOnlyFlow}
													/>
												) : null}
												{project.review.setupAction === 'auth' ? (
													<InlineHint
														message={t('editor.gitOverlayReviewRequestMissingAuth')
															.replace('{cli}', project.review.remote?.cliCommand || 'CLI')
															.replace('{host}', project.review.remote?.host || '')}
														tone="info"
														actionLabel={t('editor.gitOverlayReviewRequestAuthCli').replace('{cli}', project.review.remote?.cliCommand || 'CLI')}
														onAction={() => handleSetupReviewCli(project)}
															actionDisabled={isReadOnlyFlow}
													/>
												) : null}
												{project.review.error && !project.review.setupAction ? <InlineHint message={project.review.error} tone="error" /> : null}
												{project.currentBranch !== promptBranch ? <InlineHint message={t('editor.gitOverlayReviewRequestNeedsPromptCheckout')} tone="error" /> : null}

												<div style={styles.twoColGrid}>
													<div style={styles.fieldBlock}>
														<label style={styles.label}>{t('editor.gitOverlayCurrentBranch')}</label>
														<div style={styles.readonlyField}>{project.currentBranch || '—'}</div>
													</div>
													<div style={styles.fieldBlock}>
														<label style={styles.label}>{t('editor.gitOverlayReviewRequestTargetBranch')}</label>
														<select
															style={styles.select}
															value={draft.targetBranch}
															onChange={(event) => updateReviewDraftTargetBranch(project.project, event.target.value)}
															disabled={isReadOnlyFlow || hasRequest || !project.review.remote?.cliAvailable}
														>
															<option value="">{t('editor.gitOverlayTrackedBranchMissing')}</option>
															{targetBranchOptions.map(branch => (
																<option key={`${project.project}-${branch}`} value={branch}>{branch}</option>
															))}
														</select>
													</div>
												</div>

												<div style={styles.fieldBlock}>
													<label style={styles.label}>{t('editor.gitOverlayReviewRequestTitle')}</label>
													<input
														type="text"
														style={styles.textInput}
														value={draft.title}
														onChange={(event) => updateReviewDraftTitle(project.project, event.target.value)}
														disabled={isReadOnlyFlow || hasRequest || !project.review.remote?.cliAvailable}
														placeholder={t('editor.gitOverlayReviewRequestTitlePlaceholder')}
													/>
												</div>

												{hasRequest ? (
													<div style={styles.reviewRequestSummaryWrap}>
														<div style={styles.reviewRequestSummaryRow}>
															<div style={styles.reviewRequestTitle}>{project.review.request?.title}</div>
															{project.review.request?.url ? (
																<ActionButton
																	label={t('editor.gitOverlayOpenReviewRequest').replace('{label}', actionLabel)}
																	onClick={() => onOpenReviewRequest(project.review.request?.url || '')}
																	size="compact"
																/>
															) : null}
														</div>
														<div style={styles.reviewRequestMeta}>{`${project.review.request?.sourceBranch || promptBranch} → ${project.review.request?.targetBranch || '—'}`}</div>
														{project.review.request?.comments.length ? (
															<div style={styles.reviewCommentsList}>
																{project.review.request.comments.map((comment) => (
																	<div key={comment.id} style={styles.reviewCommentCard}>
																		<div style={styles.reviewCommentMeta}>{`${comment.author} • ${comment.createdAt || t('editor.gitOverlayNoDate')}`}</div>
																		<div style={styles.reviewCommentBody}>{comment.body}</div>
																	</div>
																))}
															</div>
														) : (
															<div style={styles.reviewRequestMeta}>{t('editor.gitOverlayReviewRequestNoComments')}</div>
														)}
													</div>
												) : null}

												<div style={styles.projectCardFooter}>
													{!hasRequest ? (
														<ActionButton
															label={t('editor.gitOverlayGenerateReviewRequestTitle')}
															onClick={() => regenerateReviewDraftTitle(project.project)}
															disabled={isReadOnlyFlow || !project.review.remote?.cliAvailable}
														/>
													) : null}
													{!hasRequest ? (
														<ActionButton
															label={t('editor.gitOverlayCreateReviewRequest').replace('{label}', actionLabel)}
															onClick={() => handleCreateReviewRequest(project)}
															disabled={isReadOnlyFlow || !canCreateReviewRequest}
															loading={isCreatingReviewRequest}
															hidden={shouldHideActionWhileWaiting(`createReviewRequest:${project.project}`) || shouldHideActionWhileWaiting('createReviewRequest:all')}
															variant="primary"
														/>
													) : null}
												</div>
											</div>
										);
									})}
								</div>

										{reviewProjectsMissingRequest.length > 0 || reviewRequestLinks.length > 0 ? (
											<div style={styles.actionRowEnd}>
												{reviewRequestLinks.length > 0 ? (
													<ActionButton
														label={t('editor.gitOverlayCopyAllReviewRequestLinks')}
														onClick={handleCopyAllReviewRequestLinks}
														disabled={isReadOnlyFlow || !canCopyAllReviewRequestLinks}
													/>
												) : null}
												{reviewProjectsMissingRequest.length > 0 ? (
													<ActionButton
														label={t('editor.gitOverlayCreateAllReviewRequests')}
														onClick={handleCreateAllReviewRequests}
														disabled={isReadOnlyFlow || !canCreateAllReviewRequests}
														loading={isCreatingAllReviewRequests}
														hidden={shouldHideActionWhileWaiting('createReviewRequest:all')}
														variant="primary"
													/>
												) : null}
											</div>
										) : null}
							</div>
							)}
						</section>
						) : null}

						{showDefaultFlowFollowUpSteps ? (
						<section style={styles.sectionCard}>
							<div style={getSectionHeaderStyle('step5')}>
								<div style={styles.sectionHeaderLeft}>
									<div style={{ ...styles.sectionNumber, ...(stepAvailability.step5 ? null : styles.sectionNumberDisabled) }}>5</div>
									<div>
										<div style={styles.sectionTitle}>{t('editor.gitOverlayStepMergeTitle')}</div>
										<div style={styles.sectionSubtitle}>{t('editor.gitOverlayStepMergeHint')}</div>
									</div>
								</div>
								<button
									type="button"
									onClick={() => toggleSectionCollapse('step5')}
									style={styles.sectionToggleButton}
									title={isSectionCollapsed('step5') ? t('editor.gitOverlayExpandSection') : t('editor.gitOverlayCollapseSection')}
									aria-label={isSectionCollapsed('step5') ? t('editor.gitOverlayExpandSection') : t('editor.gitOverlayCollapseSection')}
								>
									<ChevronIcon collapsed={isSectionCollapsed('step5')} disabled={!stepAvailability.step5} />
								</button>
							</div>
							{isSectionCollapsed('step5') ? (
								isSectionAutoCollapsed('step5') ? <div style={styles.collapsedSectionHint}>{t('editor.gitOverlayWaitingPreviousStep')}</div> : null
							) : (
							<div style={styles.sectionBody}>
								<label style={styles.checkboxRow}>
									<input
										type="checkbox"
										checked={stayOnTrackedBranch}
										disabled={isReadOnlyFlow}
										onChange={(event) => setStayOnTrackedBranch(event.target.checked)}
									/>
									<span>{stayOnTrackedBranchLabel}</span>
								</label>

								{!promptBranch ? <InlineHint message={t('editor.gitOverlayMergeNeedsPromptBranch')} tone="error" /> : null}
								{flowMissingTrackedBranchProjects.length > 0 ? <InlineHint message={t('editor.gitOverlayMergeNeedsTrackedBranch')} tone="error" /> : null}
								{flowProjectsOffPromptBranch.length > 0 ? <InlineHint message={t('editor.gitOverlayMergeNeedsPromptCheckout')} tone="error" /> : null}
								{projectsWithChanges.length > 0 ? <InlineHint message={t('editor.gitOverlayMergeNeedsCleanState')} tone="error" /> : null}
								{hasConflicts ? <InlineHint message={t('editor.gitOverlayMergeBlocked')} tone="error" /> : null}
								{step4Pending ? <InlineHint message={t('editor.gitOverlayMergeNeedsReviewRequest')} tone="error" /> : null}

								<div style={styles.mergeHint}>
									{stayOnTrackedBranch ? t('editor.gitOverlayStayOnTrackedBranchHint') : t('editor.gitOverlayReturnToPromptBranchHint')}
								</div>

								<div style={styles.actionRowEnd}>
									{!completedActions.merge ? (
										<ActionButton
											label={t('editor.gitOverlayMergeNow')}
												onClick={() => onMergePromptBranch(
													resolvedTrackedBranchesByProject,
													stayOnTrackedBranch,
													promptBranchProjects.map(project => project.project),
												)}
											disabled={isReadOnlyFlow || !canMerge}
											loading={isMerging}
											hidden={shouldHideActionWhileWaiting('mergePromptBranch')}
											variant="primary"
										/>
									) : null}
								</div>
							</div>
							)}
						</section>
						) : null}
					</div>
					<div style={styles.dialogFooter}>
						<div style={styles.dialogFooterHint}>{dialogFooterHint}</div>
						<div style={styles.dialogFooterActions}>
							{isStartChatPreflightMode ? (
								<ActionButton
									label={t('editor.gitOverlayStart')}
									onClick={() => onContinueStartChat?.()}
									disabled={!startChatBranchCheckDone}
									variant="primary"
								/>
							) : isOpenChatPreflightMode ? (
								<ActionButton
									label={t('actions.openChat')}
									onClick={() => onContinueOpenChat?.()}
									disabled={!startChatBranchCheckDone}
									variant="primary"
								/>
							) : (
								<ActionButton
									label={t('editor.gitOverlayDone')}
									onClick={() => onDone(doneStatus)}
									disabled={isReadOnlyFlow}
									variant="primary"
								/>
							)}
						</div>
					</div>
					</>
				)}
			</div>
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
		right: 0,
		width: '100%',
		maxWidth: '100%',
		zIndex: 1000,
		background: 'rgba(0, 0, 0, 0.38)',
	},
	panelViewport: {
		position: 'absolute',
		top: 0,
		bottom: 0,
		left: 0,
		width: '840px',
		maxWidth: '100%',
		padding: '20px 16px',
		boxSizing: 'border-box',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
	},
	panelViewportSecondHalf: {
		left: '840px',
		width: 'calc(100% - 840px)',
		maxWidth: 'calc(100% - 840px)',
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
	headerSubtitleActive: {
		color: 'var(--vscode-editor-foreground, var(--vscode-foreground, #000000))',
		fontWeight: 600,
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
		boxShadow: GIT_OVERLAY_LEFT_ACCENT_SHADOW,
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
		overflow: 'visible',
		boxShadow: GIT_OVERLAY_LEFT_ACCENT_SHADOW,
	},
	sectionHeader: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
		gap: '10px',
		padding: '10px 12px',
		background: 'var(--vscode-sideBar-background)',
		borderBottom: '1px solid var(--vscode-panel-border)',
		boxShadow: GIT_OVERLAY_LEFT_ACCENT_SHADOW,
		borderTopLeftRadius: '6px',
		borderTopRightRadius: '6px',
	},
	sectionHeaderExpanded: {
		borderBottomLeftRadius: 0,
		borderBottomRightRadius: 0,
	},
	sectionHeaderCollapsed: {
		borderBottomLeftRadius: '6px',
		borderBottomRightRadius: '6px',
		borderBottom: 'none',
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
	otherProjectsHeader: {
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
		marginBottom: '10px',
	},
	otherProjectsTitle: {
		fontSize: '12px',
		fontWeight: 600,
		color: 'var(--vscode-foreground)',
	},
	otherProjectsHint: {
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
		boxSizing: 'border-box',
		width: '100%',
	},
	textInput: {
		padding: '6px 8px',
		background: 'var(--vscode-input-background)',
		color: 'var(--vscode-input-foreground)',
		border: '1px solid var(--vscode-input-border, transparent)',
		borderRadius: '4px',
		fontSize: '13px',
		fontFamily: 'var(--vscode-font-family)',
		minHeight: '32px',
		boxSizing: 'border-box',
		width: '100%',
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
	textAreaDisabled: {
		opacity: 0.6,
		cursor: 'not-allowed',
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
	actionButtonSuccess: {
		background: 'var(--vscode-charts-green, #2e7d32)',
		color: 'var(--vscode-button-foreground, #ffffff)',
		borderColor: 'var(--vscode-charts-green, #2e7d32)',
	},
	actionButtonDanger: {
		background: 'var(--vscode-testing-iconFailed, var(--vscode-errorForeground, #f14c4c))',
		color: 'var(--vscode-button-foreground, #ffffff)',
		borderColor: 'var(--vscode-testing-iconFailed, var(--vscode-errorForeground, #f14c4c))',
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
	inlineActionRow: {
		display: 'flex',
		justifyContent: 'flex-end',
	},
	inlineHintActionButton: {
		background: 'transparent',
		border: '1px solid currentColor',
		borderRadius: '4px',
		padding: '4px 8px',
		fontSize: '11px',
		lineHeight: 1.4,
		color: 'inherit',
		cursor: 'pointer',
		fontFamily: 'var(--vscode-font-family)',
		flexShrink: 0,
	},
	inlineHintActionButtonDisabled: {
		opacity: 0.6,
		cursor: 'not-allowed',
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
		width: '100%',
		maxWidth: '100%',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '4px',
		overflowX: 'auto',
		overflowY: 'hidden',
	},
	projectTableHeader: {
		display: 'grid',
		gridTemplateColumns: 'minmax(104px, 1.1fr) minmax(72px, 0.75fr) minmax(98px, 1fr) minmax(98px, 1fr) minmax(64px, 0.45fr) minmax(108px, 0.8fr) minmax(88px, 0.65fr)',
		gap: '6px',
		padding: '8px 10px',
		fontSize: '11px',
		fontWeight: 600,
		background: 'var(--vscode-sideBar-background)',
		color: 'var(--vscode-descriptionForeground)',
		width: '100%',
		minWidth: '680px',
		boxSizing: 'border-box',
	},
	projectTableHeaderCentered: {
		textAlign: 'center',
	},
	projectTableRow: {
		display: 'grid',
		gridTemplateColumns: 'minmax(104px, 1.1fr) minmax(72px, 0.75fr) minmax(98px, 1fr) minmax(98px, 1fr) minmax(64px, 0.45fr) minmax(108px, 0.8fr) minmax(88px, 0.65fr)',
		gap: '6px',
		padding: '8px 10px',
		alignItems: 'center',
		borderTop: '1px solid var(--vscode-panel-border)',
		width: '100%',
		minWidth: '680px',
		boxSizing: 'border-box',
	},
	projectTableRowError: {
		background: 'color-mix(in srgb, var(--vscode-inputValidation-errorBackground) 50%, transparent)',
	},
	projectTableRowDecision: {
		background: 'color-mix(in srgb, var(--vscode-inputValidation-errorBackground) 58%, transparent)',
	},
	projectTableRowSuccess: {
		background: 'color-mix(in srgb, var(--vscode-testing-iconPassed) 10%, transparent)',
	},
	projectTableRowMuted: {
		opacity: 0.82,
	},
	projectName: {
		fontSize: '13px',
		fontWeight: 600,
		minWidth: 0,
		wordBreak: 'break-word',
	},
	branchValue: {
		fontSize: '12px',
		color: 'var(--vscode-foreground)',
		minWidth: 0,
		wordBreak: 'break-word',
	},
	projectTableCellCentered: {
		display: 'flex',
		justifyContent: 'center',
		alignItems: 'center',
		textAlign: 'center',
		fontSize: '12px',
		color: 'var(--vscode-foreground)',
		minWidth: 0,
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
	projectMetaCentered: {
		display: 'flex',
		justifyContent: 'center',
		alignItems: 'center',
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
		textAlign: 'center',
	},
	projectStateCell: {
		display: 'flex',
		justifyContent: 'center',
		alignItems: 'center',
		minWidth: 0,
	},
	projectRowActionCell: {
		display: 'flex',
		justifyContent: 'flex-end',
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
		maxWidth: '100%',
		minWidth: 0,
		textAlign: 'center',
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
	statePillInfo: {
		background: 'var(--vscode-inputValidation-infoBackground)',
		color: 'var(--vscode-textLink-foreground)',
	},
	emptyStateInline: {
		padding: '10px',
		border: '1px dashed var(--vscode-panel-border)',
		borderRadius: '4px',
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
		boxShadow: GIT_OVERLAY_LEFT_ACCENT_SHADOW,
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
		boxShadow: GIT_OVERLAY_LEFT_ACCENT_SHADOW,
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
	projectCardTitleLine: {
		display: 'flex',
		alignItems: 'baseline',
		gap: '8px',
		flexWrap: 'wrap',
		minWidth: 0,
	},
	projectCardTitle: {
		fontSize: '13px',
		fontWeight: 600,
	},
	projectCardSummary: {
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
		gap: '12px',
		flexWrap: 'wrap',
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
		fontWeight: 600,
		textAlign: 'center',
		wordBreak: 'break-word',
	},
	projectStatusTextOk: {
		color: 'green',
	},
	projectStatusTextError: {
		color: 'red',
	},
	projectStatusTextMuted: {
		color: 'black',
	},
	projectStatusTextInfo: {
		color: 'blue',
	},
	projectChangesWrap: {
		display: 'flex',
		flexDirection: 'column',
		gap: '6px',
		minWidth: 0,
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
		alignItems: 'center',
	},
	changeList: {
		display: 'flex',
		flexDirection: 'column',
		gap: 0,
		borderRadius: '4px',
		overflowX: 'auto',
		overflowY: 'hidden',
		background: 'var(--vscode-input-background)',
		border: '1px solid var(--vscode-panel-border)',
	},
	changeRow: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: '12px',
		padding: '7px 8px',
		background: 'transparent',
		borderRadius: '4px',
	},
	changeRowSelected: {
		background: 'color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 34%, transparent)',
		boxShadow: 'inset 0 0 0 1px var(--vscode-focusBorder)',
	},
	changeRowBorderTop: {
		borderTop: '1px solid var(--vscode-panel-border)',
	},
	changeInfo: {
		minWidth: 0,
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		flex: '1 1 auto',
	},
	changeInfoButton: {
		background: 'none',
		border: 'none',
		padding: 0,
		margin: 0,
		minWidth: 0,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: '12px',
		flex: '1 1 auto',
		color: 'inherit',
		cursor: 'pointer',
		textAlign: 'left',
		fontFamily: 'var(--vscode-font-family)',
	},
	changeInfoButtonSelected: {
		color: 'var(--vscode-foreground)',
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
		flexWrap: 'nowrap',
		flex: '1 1 auto',
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
	changeMetrics: {
		display: 'inline-flex',
		alignItems: 'center',
		gap: '8px',
		fontSize: '11px',
		color: 'var(--vscode-descriptionForeground)',
		lineHeight: 1.4,
		whiteSpace: 'nowrap',
		flexShrink: 0,
	},
	changeMetricsSize: {
		color: 'var(--vscode-descriptionForeground)',
	},
	changeMetricsInfo: {
		color: 'var(--vscode-descriptionForeground)',
	},
	changeMetricsDeleted: {
		color: 'var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-errorForeground))',
		fontWeight: 600,
	},
	changeMetricsAdded: {
		color: 'var(--vscode-gitDecoration-addedResourceForeground, #2ea043)',
		fontWeight: 600,
	},
	changeActions: {
		display: 'inline-flex',
		gap: '10px',
		alignItems: 'center',
		flexWrap: 'nowrap',
		justifyContent: 'flex-end',
		width: 'auto',
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
	reviewRequestSummaryWrap: {
		display: 'flex',
		flexDirection: 'column',
		gap: '8px',
		padding: '10px',
		border: '1px solid var(--vscode-panel-border)',
		borderRadius: '4px',
		background: 'var(--vscode-sideBar-background)',
		boxShadow: GIT_OVERLAY_LEFT_ACCENT_SHADOW,
	},
	reviewRequestSummaryRow: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
		gap: '8px',
		flexWrap: 'wrap',
	},
	reviewRequestTitle: {
		fontSize: '12px',
		fontWeight: 600,
		color: 'var(--vscode-foreground)',
	},
	reviewRequestMeta: {
		fontSize: '11px',
		color: 'var(--vscode-descriptionForeground)',
		lineHeight: 1.5,
	},
	reviewCommentsList: {
		display: 'flex',
		flexDirection: 'column',
		gap: '8px',
		maxHeight: '220px',
		overflowY: 'auto',
	},
	reviewCommentCard: {
		padding: '8px 10px',
		borderRadius: '4px',
		background: 'var(--vscode-editor-background)',
		border: '1px solid var(--vscode-panel-border)',
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
		boxShadow: GIT_OVERLAY_LEFT_ACCENT_SHADOW,
	},
	reviewCommentMeta: {
		fontSize: '11px',
		color: 'var(--vscode-descriptionForeground)',
	},
	reviewCommentBody: {
		fontSize: '12px',
		lineHeight: 1.5,
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
	},
	dialogFooter: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
		gap: '12px',
		padding: '12px 16px',
		borderTop: '1px solid var(--vscode-panel-border)',
		background: 'var(--vscode-sideBar-background)',
		flexWrap: 'wrap',
	},
	dialogFooterHint: {
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
		lineHeight: 1.5,
		flex: 1,
		minWidth: 0,
	},
	dialogFooterActions: {
		display: 'flex',
		gap: '8px',
		alignItems: 'center',
		justifyContent: 'flex-end',
	},
};