import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
	collectGitOverlayActionableProjects,
	collectGitOverlayDefaultStepBranchMismatches,
	collectGitOverlayProjectsNeedingSync,
	collectGitOverlayStartChatBranchMismatches,
	buildGitOverlayReviewCliSetupCommand,
	buildGitOverlayReviewRequestTitle,
	buildGitOverlayGraph,
	canDeleteGitOverlayBranch,
	isGitOverlayDefaultStepBranchAllowed,
	isGitOverlayStartChatBranchAllowed,
	normalizeGitOverlayReviewRequestState,
	normalizeCommitMessageGenerationInstructions,
	parseGitOverlayRemoteUrl,
	resolveGitOverlayDoneStatus,
	resolveGitOverlayTrackedBranchOptions,
	resolveExistingGitOverlayTrackedBranches,
	resolveGitOverlayBranchNames,
} from '../src/utils/gitOverlay.js';
import {
	areGitOverlayProjectsOnTrackedOrPrompt,
	collectGitOverlayProjectsWithChangesOnTrackedBranches,
	collectGitOverlayProjectsWithChangesOutsideTrackedOrPrompt,
	formatChangeSize,
	GitOverlay,
	resolveChangeDiffStats,
	resolveGitOverlayPostCommitProjects,
} from '../src/webview/editor/components/GitOverlay.js';
import type { GitOverlayChangeFile, GitOverlayProjectSnapshot, GitOverlaySnapshot } from '../src/types/git.js';

type TestProjectOverrides = Omit<Partial<GitOverlayProjectSnapshot>, 'changeGroups' | 'review' | 'graph'> & {
	changeGroups?: Partial<GitOverlayProjectSnapshot['changeGroups']>;
	review?: Partial<GitOverlayProjectSnapshot['review']>;
	graph?: Partial<GitOverlayProjectSnapshot['graph']>;
};

function createTestChange(overrides: Partial<GitOverlayChangeFile> = {}): GitOverlayChangeFile {
	return {
		project: overrides.project || 'api',
		path: overrides.path || 'src/index.ts',
		previousPath: overrides.previousPath,
		status: overrides.status || 'M',
		group: overrides.group || 'staged',
		conflicted: overrides.conflicted || false,
		staged: overrides.staged ?? true,
		fileSizeBytes: overrides.fileSizeBytes ?? 100,
		additions: overrides.additions ?? 1,
		deletions: overrides.deletions ?? 0,
		isBinary: overrides.isBinary || false,
	};
}

function createTestProject(overrides: TestProjectOverrides = {}): GitOverlayProjectSnapshot {
	const base: GitOverlayProjectSnapshot = {
		project: 'api',
		repositoryPath: '/tmp/api',
		available: true,
		error: '',
		currentBranch: 'main',
		promptBranch: 'feature/task-42',
		dirty: false,
		hasConflicts: false,
		upstream: 'origin/main',
		ahead: 0,
		behind: 0,
		lastCommit: null,
		branches: [],
		cleanupBranches: [],
		changeGroups: {
			merge: [],
			staged: [],
			workingTree: [],
			untracked: [],
		},
		review: {
			remote: null,
			request: null,
			error: '',
			setupAction: null,
		},
		recentCommits: [],
		staleLocalBranches: [],
		graph: {
			nodes: [],
			edges: [],
		},
	};

	return {
		...base,
		...overrides,
		changeGroups: {
			...base.changeGroups,
			...(overrides.changeGroups || {}),
		},
		review: {
			...base.review,
			...(overrides.review || {}),
		},
		graph: {
			...base.graph,
			...(overrides.graph || {}),
		},
	};
}

function createTestSnapshot(overrides: Partial<GitOverlaySnapshot> = {}): GitOverlaySnapshot {
	return {
		generatedAt: '2026-04-02T00:00:00.000Z',
		promptBranch: 'feature/task-42',
		trackedBranches: ['main'],
		projects: [],
		...overrides,
	};
}

function renderGitOverlayMarkup(overrides: Partial<React.ComponentProps<typeof GitOverlay>> = {}): string {
	return renderToStaticMarkup(React.createElement(GitOverlay, {
		open: true,
		mode: 'default',
		snapshot: createTestSnapshot(),
		commitMessages: {},
		busyAction: null,
		completedActions: { push: false, 'review-request': false, merge: false },
		promptStatus: 'completed',
		promptTitle: '',
		promptTaskNumber: '',
		preferredTrackedBranch: 'main',
		onClose: () => { },
		onDone: () => { },
		onRefresh: () => { },
		onSwitchBranch: () => { },
		onEnsurePromptBranch: () => { },
		onPush: () => { },
		onCreateReviewRequest: () => { },
		onMergePromptBranch: () => { },
		onDiscardFile: () => { },
		onOpenFile: () => { },
		onOpenDiff: () => { },
		onOpenReviewRequest: () => { },
		onSetupReviewCli: () => { },
		onOpenMergeEditor: () => { },
		onGenerateCommitMessage: () => { },
		onCommitStaged: () => { },
		onCommitMessageChange: () => { },
		onTrackedBranchChange: () => { },
		onContinueStartChat: () => { },
		onContinueOpenChat: () => { },
		t: (key: string) => key,
		...overrides,
	}));
}

test('resolveGitOverlayBranchNames keeps tracked order and appends prompt/current branches once', () => {
	const branches = resolveGitOverlayBranchNames(['main', 'develop', 'main'], 'feature/task-42', 'feature/task-42');

	assert.deepEqual(branches, ['main', 'develop', 'feature/task-42']);
});

test('resolveExistingGitOverlayTrackedBranches keeps only configured branches that exist in projects', () => {
	const branches = resolveExistingGitOverlayTrackedBranches(
		['main', 'develop', 'release'],
		[
			{
				available: true,
				currentBranch: 'main',
				branches: [
					{ name: 'main', kind: 'tracked', exists: true },
					{ name: 'release', kind: 'tracked', exists: false },
				],
			},
			{
				available: true,
				currentBranch: 'develop',
				branches: [
					{ name: 'develop', kind: 'tracked', exists: true },
					{ name: 'feature/task-42', kind: 'prompt', exists: true },
				],
			},
		],
	);

	assert.deepEqual(branches, ['main', 'develop']);
});

test('resolveExistingGitOverlayTrackedBranches keeps configured current tracked branch when repository marks it as current', () => {
	const branches = resolveExistingGitOverlayTrackedBranches(
		['main', 'develop'],
		[
			{
				available: true,
				currentBranch: 'develop',
				branches: [
					{ name: 'develop', kind: 'current', exists: true },
					{ name: 'main', kind: 'tracked', exists: true },
				],
			},
		],
	);

	assert.deepEqual(branches, ['main', 'develop']);
});

test('resolveExistingGitOverlayTrackedBranches falls back to discovered existing tracked branches', () => {
	const branches = resolveExistingGitOverlayTrackedBranches(
		[],
		[
			{
				available: true,
				currentBranch: 'main',
				branches: [
					{ name: 'main', kind: 'tracked', exists: true },
					{ name: 'release', kind: 'tracked', exists: false },
				],
			},
			{
				available: true,
				currentBranch: 'develop',
				branches: [
					{ name: 'develop', kind: 'tracked', exists: true },
					{ name: 'main', kind: 'tracked', exists: true },
				],
			},
		],
	);

	assert.deepEqual(branches, ['main', 'develop']);
});

test('resolveGitOverlayTrackedBranchOptions falls back to current branches and preferred tracked branch', () => {
	assert.deepEqual(
		resolveGitOverlayTrackedBranchOptions(
			[],
			[
				{
					available: true,
					currentBranch: 'release',
					branches: [],
				},
				{
					available: true,
					currentBranch: 'feature/task-42',
					branches: [],
				},
			],
			'feature/task-42',
			'develop',
		),
		['develop', 'release'],
	);

	assert.deepEqual(
		resolveGitOverlayTrackedBranchOptions(
			['main', 'develop'],
			[
				{
					available: true,
					currentBranch: 'release',
					branches: [],
				},
			],
			'feature/task-42',
		),
		['main', 'develop'],
	);
});

test('isGitOverlayStartChatBranchAllowed accepts tracked and prompt branches only', () => {
	assert.equal(isGitOverlayStartChatBranchAllowed('main', 'feature/task-42', ['main', 'develop']), true);
	assert.equal(isGitOverlayStartChatBranchAllowed('feature/task-42', 'feature/task-42', ['main', 'develop']), true);
	assert.equal(isGitOverlayStartChatBranchAllowed('bugfix/legacy', 'feature/task-42', ['main', 'develop']), false);
});

test('collectGitOverlayStartChatBranchMismatches returns only available projects outside tracked and prompt branches', () => {
	const mismatches = collectGitOverlayStartChatBranchMismatches([
		{ project: 'api', available: true, currentBranch: 'feature/legacy' },
		{ project: 'web', available: true, currentBranch: 'main' },
		{ project: 'docs', available: true, currentBranch: 'feature/task-42' },
		{ project: 'infra', available: false, currentBranch: 'feature/legacy' },
	], 'feature/task-42', ['main', 'develop']);

	assert.deepEqual(mismatches, [
		{ project: 'api', available: true, currentBranch: 'feature/legacy' },
	]);
});

test('isGitOverlayDefaultStepBranchAllowed requires prompt branch and accepts tracked or prompt branches', () => {
	assert.equal(isGitOverlayDefaultStepBranchAllowed('main', '', ['main', 'develop']), false);
	assert.equal(isGitOverlayDefaultStepBranchAllowed('main', 'feature/task-42', ['main', 'develop']), true);
	assert.equal(isGitOverlayDefaultStepBranchAllowed('feature/task-42', 'feature/task-42', ['main', 'develop']), true);
	assert.equal(isGitOverlayDefaultStepBranchAllowed('bugfix/legacy', 'feature/task-42', ['main', 'develop']), false);
});

test('collectGitOverlayDefaultStepBranchMismatches blocks only branches outside tracked or prompt when prompt branch is set', () => {
	const mismatches = collectGitOverlayDefaultStepBranchMismatches([
		{ project: 'api', available: true, currentBranch: 'feature/legacy' },
		{ project: 'web', available: true, currentBranch: 'main' },
		{ project: 'docs', available: true, currentBranch: 'feature/task-42' },
	], 'feature/task-42', ['main', 'develop']);

	assert.deepEqual(mismatches, [
		{ project: 'api', available: true, currentBranch: 'feature/legacy' },
	]);
	assert.deepEqual(
		collectGitOverlayDefaultStepBranchMismatches([
			{ project: 'web', available: true, currentBranch: 'main' },
		], '', ['main', 'develop']),
		[
			{ project: 'web', available: true, currentBranch: 'main' },
		],
	);
});

test('collectGitOverlayProjectsNeedingSync returns only available projects behind upstream', () => {
	assert.deepEqual(
		collectGitOverlayProjectsNeedingSync([
			{ project: 'api', available: true, upstream: 'origin/main', behind: 2 },
			{ project: 'web', available: true, upstream: '', behind: 3 },
			{ project: 'docs', available: true, upstream: 'origin/develop', behind: 0 },
			{ project: 'infra', available: false, upstream: 'origin/main', behind: 1 },
		]),
		[
			{ project: 'api', available: true, upstream: 'origin/main', behind: 2 },
		],
	);
});

test('collectGitOverlayProjectsWithChangesOutsideTrackedOrPrompt keeps only dirty projects outside tracked and prompt branches', () => {
	const projects = [
		createTestProject({
			project: 'tracked-dirty',
			currentBranch: 'main',
			changeGroups: { staged: [createTestChange({ project: 'tracked-dirty' })] },
		}),
		createTestProject({
			project: 'prompt-dirty',
			currentBranch: 'feature/task-42',
			changeGroups: { staged: [createTestChange({ project: 'prompt-dirty' })] },
		}),
		createTestProject({
			project: 'legacy-dirty',
			currentBranch: 'feature/legacy',
			changeGroups: { staged: [createTestChange({ project: 'legacy-dirty' })] },
		}),
		createTestProject({
			project: 'tracked-clean',
			currentBranch: 'main',
		}),
	];

	assert.deepEqual(
		collectGitOverlayProjectsWithChangesOutsideTrackedOrPrompt(projects, 'feature/task-42', ['main']).map(project => project.project),
		['legacy-dirty'],
	);
});

test('collectGitOverlayProjectsWithChangesOnTrackedBranches keeps only dirty tracked projects', () => {
	const projects = [
		createTestProject({
			project: 'tracked-dirty',
			currentBranch: 'main',
			changeGroups: { staged: [createTestChange({ project: 'tracked-dirty' })] },
		}),
		createTestProject({
			project: 'prompt-dirty',
			currentBranch: 'feature/task-42',
			changeGroups: { staged: [createTestChange({ project: 'prompt-dirty' })] },
		}),
		createTestProject({
			project: 'legacy-dirty',
			currentBranch: 'feature/legacy',
			changeGroups: { staged: [createTestChange({ project: 'legacy-dirty' })] },
		}),
	];

	assert.deepEqual(
		collectGitOverlayProjectsWithChangesOnTrackedBranches(projects, ['main']).map(project => project.project),
		['tracked-dirty'],
	);
});

test('areGitOverlayProjectsOnTrackedOrPrompt checks every project branch against tracked and prompt branches', () => {
	assert.equal(
		areGitOverlayProjectsOnTrackedOrPrompt([
			createTestProject({ project: 'tracked', currentBranch: 'main' }),
			createTestProject({ project: 'prompt', currentBranch: 'feature/task-42' }),
		], 'feature/task-42', ['main']),
		true,
	);

	assert.equal(
		areGitOverlayProjectsOnTrackedOrPrompt([
			createTestProject({ project: 'tracked', currentBranch: 'main' }),
			createTestProject({ project: 'legacy', currentBranch: 'feature/legacy' }),
		], 'feature/task-42', ['main']),
		false,
	);
});

test('collectGitOverlayActionableProjects hides clean tracked projects outside prompt branch', () => {
	assert.deepEqual(
		collectGitOverlayActionableProjects([
			{
				project: 'passive',
				available: true,
				currentBranch: 'main',
				changeGroups: {
					merge: [],
					staged: [],
					workingTree: [],
					untracked: [],
				},
			},
			{
				project: 'prompt-clean',
				available: true,
				currentBranch: 'feature/task-42',
				changeGroups: {
					merge: [],
					staged: [],
					workingTree: [],
					untracked: [],
				},
			},
			{
				project: 'tracked-dirty',
				available: true,
				currentBranch: 'main',
				changeGroups: {
					merge: [],
					staged: [{ path: 'a.ts' }],
					workingTree: [],
					untracked: [],
				},
			},
		], 'feature/task-42', ['main', 'develop']).map(project => project.project),
		['prompt-clean', 'tracked-dirty'],
	);
});

test('canDeleteGitOverlayBranch blocks current, prompt and tracked branches', () => {
	assert.equal(canDeleteGitOverlayBranch('feature/task-42', 'feature/task-42', ['main', 'develop'], 'feature/task-42'), false);
	assert.equal(canDeleteGitOverlayBranch('main', 'feature/task-42', ['main', 'develop'], 'feature/task-42'), false);
	assert.equal(canDeleteGitOverlayBranch('cleanup/old-branch', 'feature/task-42', ['main', 'develop'], 'feature/task-42'), true);
});

test('resolveGitOverlayDoneStatus changes prompt status only after completed git flow actions', () => {
	assert.equal(resolveGitOverlayDoneStatus({ push: false, 'review-request': false, merge: false }), null);
	assert.equal(resolveGitOverlayDoneStatus({ push: true, 'review-request': false, merge: false }), 'report');
	assert.equal(resolveGitOverlayDoneStatus({ push: true, 'review-request': true, merge: false }), 'review');
	assert.equal(resolveGitOverlayDoneStatus({ push: true, 'review-request': true, merge: true }), 'closed');
});

test('GitOverlay renders safely when mounted closed', () => {
	const markup = renderToStaticMarkup(React.createElement(GitOverlay, {
		open: false,
		mode: 'default',
		snapshot: null,
		commitMessages: {},
		busyAction: null,
		completedActions: { push: false, 'review-request': false, merge: false },
		promptStatus: 'draft',
		promptTitle: '',
		promptTaskNumber: '',
		preferredTrackedBranch: '',
		onClose: () => { },
		onDone: () => { },
		onRefresh: () => { },
		onSwitchBranch: () => { },
		onEnsurePromptBranch: () => { },
		onPush: () => { },
		onCreateReviewRequest: () => { },
		onMergePromptBranch: () => { },
		onDiscardFile: () => { },
		onOpenFile: () => { },
		onOpenDiff: () => { },
		onOpenReviewRequest: () => { },
		onSetupReviewCli: () => { },
		onOpenMergeEditor: () => { },
		onGenerateCommitMessage: () => { },
		onCommitStaged: () => { },
		onCommitMessageChange: () => { },
		onTrackedBranchChange: () => { },
		onContinueStartChat: () => { },
		onContinueOpenChat: () => { },
		t: (key: string) => key,
	}));

	assert.equal(markup, '');
});

test('GitOverlay shows switch-to-prompt action during start chat preflight when prompt branch is set', () => {
	const markup = renderToStaticMarkup(React.createElement(GitOverlay, {
		open: true,
		mode: 'start-chat-preflight',
		snapshot: {
			generatedAt: '2026-04-02T00:00:00.000Z',
			promptBranch: 'feature/task-42',
			trackedBranches: ['main'],
			projects: [
				{
					project: 'api',
					repositoryPath: '/tmp/api',
					available: true,
					error: '',
					currentBranch: 'main',
					promptBranch: 'feature/task-42',
					dirty: false,
					hasConflicts: false,
					upstream: 'origin/main',
					ahead: 0,
					behind: 0,
					lastCommit: null,
					branches: [],
					cleanupBranches: [],
					changeGroups: {
						merge: [],
						staged: [],
						workingTree: [],
						untracked: [],
					},
					review: {
						remote: null,
						request: null,
						error: '',
						setupAction: null,
					},
					recentCommits: [],
					staleLocalBranches: [],
					graph: {
						nodes: [],
						edges: [],
					},
				},
			],
		},
		commitMessages: {},
		busyAction: null,
		completedActions: { push: false, 'review-request': false, merge: false },
		promptStatus: 'draft',
		promptTitle: '',
		promptTaskNumber: '',
		preferredTrackedBranch: 'main',
		onClose: () => { },
		onDone: () => { },
		onRefresh: () => { },
		onSwitchBranch: () => { },
		onEnsurePromptBranch: () => { },
		onPush: () => { },
		onCreateReviewRequest: () => { },
		onMergePromptBranch: () => { },
		onDiscardFile: () => { },
		onOpenFile: () => { },
		onOpenDiff: () => { },
		onOpenReviewRequest: () => { },
		onSetupReviewCli: () => { },
		onOpenMergeEditor: () => { },
		onGenerateCommitMessage: () => { },
		onCommitStaged: () => { },
		onCommitMessageChange: () => { },
		onTrackedBranchChange: () => { },
		onContinueStartChat: () => { },
		onContinueOpenChat: () => { },
		t: (key: string) => key,
	}));

	assert.match(markup, /editor\.gitOverlaySwitchAll/);
});

test('GitOverlay renders tracked branch options separately for each project', () => {
	const markup = renderToStaticMarkup(React.createElement(GitOverlay, {
		open: true,
		mode: 'start-chat-preflight',
		snapshot: {
			generatedAt: '2026-04-02T00:00:00.000Z',
			promptBranch: 'feature/task-42',
			trackedBranches: ['master', 'main'],
			projects: [
				{
					project: 'api',
					repositoryPath: '/tmp/api',
					available: true,
					error: '',
					currentBranch: 'master',
					promptBranch: 'feature/task-42',
					dirty: false,
					hasConflicts: false,
					upstream: 'origin/master',
					ahead: 0,
					behind: 0,
					lastCommit: null,
					branches: [
						{
							name: 'master',
							current: true,
							exists: true,
							kind: 'tracked',
							upstream: 'origin/master',
							ahead: 0,
							behind: 0,
							lastCommit: null,
							canSwitch: true,
							canDelete: false,
							stale: false,
						},
					],
					cleanupBranches: [],
					changeGroups: {
						merge: [],
						staged: [],
						workingTree: [],
						untracked: [],
					},
					review: {
						remote: null,
						request: null,
						error: '',
						setupAction: null,
					},
					recentCommits: [],
					staleLocalBranches: [],
					graph: {
						nodes: [],
						edges: [],
					},
				},
				{
					project: 'web',
					repositoryPath: '/tmp/web',
					available: true,
					error: '',
					currentBranch: 'main',
					promptBranch: 'feature/task-42',
					dirty: false,
					hasConflicts: false,
					upstream: 'origin/main',
					ahead: 0,
					behind: 0,
					lastCommit: null,
					branches: [
						{
							name: 'main',
							current: true,
							exists: true,
							kind: 'tracked',
							upstream: 'origin/main',
							ahead: 0,
							behind: 0,
							lastCommit: null,
							canSwitch: true,
							canDelete: false,
							stale: false,
						},
					],
					cleanupBranches: [],
					changeGroups: {
						merge: [],
						staged: [],
						workingTree: [],
						untracked: [],
					},
					review: {
						remote: null,
						request: null,
						error: '',
						setupAction: null,
					},
					recentCommits: [],
					staleLocalBranches: [],
					graph: {
						nodes: [],
						edges: [],
					},
				},
			],
		},
		commitMessages: {},
		busyAction: null,
		completedActions: { push: false, 'review-request': false, merge: false },
		promptStatus: 'draft',
		promptTitle: '',
		promptTaskNumber: '',
		preferredTrackedBranch: '',
		onClose: () => { },
		onDone: () => { },
		onRefresh: () => { },
		onSwitchBranch: () => { },
		onEnsurePromptBranch: () => { },
		onPush: () => { },
		onCreateReviewRequest: () => { },
		onMergePromptBranch: () => { },
		onDiscardFile: () => { },
		onOpenFile: () => { },
		onOpenDiff: () => { },
		onOpenReviewRequest: () => { },
		onSetupReviewCli: () => { },
		onOpenMergeEditor: () => { },
		onGenerateCommitMessage: () => { },
		onCommitStaged: () => { },
		onCommitMessageChange: () => { },
		onTrackedBranchChange: () => { },
		onContinueStartChat: () => { },
		onContinueOpenChat: () => { },
		t: (key: string) => key,
	}));

	assert.equal(markup.match(/value="master"[^>]*>master<\/option>/g)?.length || 0, 1);
	assert.equal(markup.match(/value="main"[^>]*>main<\/option>/g)?.length || 0, 1);
});

test('GitOverlay keeps current tracked branch in per-project options', () => {
	const markup = renderToStaticMarkup(React.createElement(GitOverlay, {
		open: true,
		mode: 'start-chat-preflight',
		snapshot: {
			generatedAt: '2026-04-02T00:00:00.000Z',
			promptBranch: 'feature/task-42',
			trackedBranches: ['master', 'develop'],
			projects: [
				{
					project: 'api',
					repositoryPath: '/tmp/api',
					available: true,
					error: '',
					currentBranch: 'develop',
					promptBranch: 'feature/task-42',
					dirty: false,
					hasConflicts: false,
					upstream: 'origin/develop',
					ahead: 0,
					behind: 0,
					lastCommit: null,
					branches: [
						{
							name: 'develop',
							current: true,
							exists: true,
							kind: 'current',
							upstream: 'origin/develop',
							ahead: 0,
							behind: 0,
							lastCommit: null,
							canSwitch: true,
							canDelete: false,
							stale: false,
						},
						{
							name: 'master',
							current: false,
							exists: true,
							kind: 'tracked',
							upstream: 'origin/master',
							ahead: 0,
							behind: 0,
							lastCommit: null,
							canSwitch: true,
							canDelete: false,
							stale: false,
						},
					],
					cleanupBranches: [],
					changeGroups: {
						merge: [],
						staged: [],
						workingTree: [],
						untracked: [],
					},
					review: {
						remote: null,
						request: null,
						error: '',
						setupAction: null,
					},
					recentCommits: [],
					staleLocalBranches: [],
					graph: {
						nodes: [],
						edges: [],
					},
				},
			],
		},
		commitMessages: {},
		busyAction: null,
		completedActions: { push: false, 'review-request': false, merge: false },
		promptStatus: 'draft',
		promptTitle: '',
		promptTaskNumber: '',
		preferredTrackedBranch: '',
		onClose: () => { },
		onDone: () => { },
		onRefresh: () => { },
		onSwitchBranch: () => { },
		onEnsurePromptBranch: () => { },
		onPush: () => { },
		onCreateReviewRequest: () => { },
		onMergePromptBranch: () => { },
		onDiscardFile: () => { },
		onOpenFile: () => { },
		onOpenDiff: () => { },
		onOpenReviewRequest: () => { },
		onSetupReviewCli: () => { },
		onOpenMergeEditor: () => { },
		onGenerateCommitMessage: () => { },
		onCommitStaged: () => { },
		onCommitMessageChange: () => { },
		onTrackedBranchChange: () => { },
		onContinueStartChat: () => { },
		onContinueOpenChat: () => { },
		t: (key: string) => key,
	}));

	assert.equal(markup.match(/value="master"[^>]*>master<\/option>/g)?.length || 0, 2);
	assert.equal(markup.match(/value="develop"[^>]*>develop<\/option>/g)?.length || 0, 1);
});

test('GitOverlay keeps current non-tracked branch only in source options and removes it from expected options', () => {
	const markup = renderToStaticMarkup(React.createElement(GitOverlay, {
		open: true,
		mode: 'default',
		snapshot: {
			generatedAt: '2026-04-02T00:00:00.000Z',
			promptBranch: 'feature/task-42',
			trackedBranches: ['main'],
			projects: [
				{
					project: 'api',
					repositoryPath: '/tmp/api',
					available: true,
					error: '',
					currentBranch: 'feature/local-work',
					promptBranch: 'feature/task-42',
					dirty: false,
					hasConflicts: false,
					upstream: '',
					ahead: 0,
					behind: 0,
					lastCommit: null,
					branches: [
						{
							name: 'feature/local-work',
							current: true,
							exists: true,
							kind: 'current',
							upstream: '',
							ahead: 0,
							behind: 0,
							lastCommit: null,
							canSwitch: true,
							canDelete: false,
							stale: false,
						},
						{
							name: 'main',
							current: false,
							exists: true,
							kind: 'tracked',
							upstream: 'origin/main',
							ahead: 0,
							behind: 0,
							lastCommit: null,
							canSwitch: true,
							canDelete: false,
							stale: false,
						},
					],
					cleanupBranches: [],
					changeGroups: {
						merge: [],
						staged: [],
						workingTree: [],
						untracked: [],
					},
					review: {
						remote: null,
						request: null,
						error: '',
						setupAction: null,
					},
					recentCommits: [],
					staleLocalBranches: [],
					graph: {
						nodes: [],
						edges: [],
					},
				},
			],
		},
		commitMessages: {},
		busyAction: null,
		completedActions: { push: false, 'review-request': false, merge: false },
		promptStatus: 'draft',
		promptTitle: '',
		promptTaskNumber: '',
		preferredTrackedBranch: 'main',
		onClose: () => { },
		onDone: () => { },
		onRefresh: () => { },
		onSwitchBranch: () => { },
		onEnsurePromptBranch: () => { },
		onPush: () => { },
		onCreateReviewRequest: () => { },
		onMergePromptBranch: () => { },
		onDiscardFile: () => { },
		onOpenFile: () => { },
		onOpenDiff: () => { },
		onOpenReviewRequest: () => { },
		onSetupReviewCli: () => { },
		onOpenMergeEditor: () => { },
		onGenerateCommitMessage: () => { },
		onCommitStaged: () => { },
		onCommitMessageChange: () => { },
		onTrackedBranchChange: () => { },
		onContinueStartChat: () => { },
		onContinueOpenChat: () => { },
		t: (key: string) => key,
	}));

	assert.equal(markup.match(/value="feature\/local-work"[^>]*>feature\/local-work<\/option>/g)?.length || 0, 1);
	assert.equal(markup.match(/value="main"[^>]*>main<\/option>/g)?.length || 0, 2);
	assert.equal(markup.match(/value="feature\/task-42"[^>]*>feature\/task-42<\/option>/g)?.length || 0, 1);
});

test('GitOverlay keeps passive tracked projects visible in step 1 and does not let them block merge', () => {
	const markup = renderToStaticMarkup(React.createElement(GitOverlay, {
		open: true,
		mode: 'default',
		snapshot: {
			generatedAt: '2026-04-02T00:00:00.000Z',
			promptBranch: 'feature/task-42',
			trackedBranches: ['main'],
			projects: [
				{
					project: 'passive-tracked-clean',
					repositoryPath: '/tmp/passive',
					available: true,
					error: '',
					currentBranch: 'main',
					promptBranch: 'feature/task-42',
					dirty: false,
					hasConflicts: false,
					upstream: 'origin/main',
					ahead: 0,
					behind: 0,
					lastCommit: null,
					branches: [],
					cleanupBranches: [],
					changeGroups: {
						merge: [],
						staged: [],
						workingTree: [],
						untracked: [],
					},
					review: {
						remote: null,
						request: null,
						error: '',
						setupAction: null,
					},
					recentCommits: [],
					staleLocalBranches: [],
					graph: {
						nodes: [],
						edges: [],
					},
				},
				{
					project: 'prompt-project',
					repositoryPath: '/tmp/prompt',
					available: true,
					error: '',
					currentBranch: 'feature/task-42',
					promptBranch: 'feature/task-42',
					dirty: false,
					hasConflicts: false,
					upstream: 'origin/feature/task-42',
					ahead: 0,
					behind: 0,
					lastCommit: null,
					branches: [],
					cleanupBranches: [],
					changeGroups: {
						merge: [],
						staged: [],
						workingTree: [],
						untracked: [],
					},
					review: {
						remote: null,
						request: null,
						error: '',
						setupAction: null,
					},
					recentCommits: [],
					staleLocalBranches: [],
					graph: {
						nodes: [],
						edges: [],
					},
				},
			],
		},
		commitMessages: {},
		busyAction: null,
		completedActions: { push: false, 'review-request': false, merge: false },
		promptStatus: 'report',
		promptTitle: '',
		promptTaskNumber: '',
		preferredTrackedBranch: 'main',
		onClose: () => { },
		onDone: () => { },
		onRefresh: () => { },
		onSwitchBranch: () => { },
		onEnsurePromptBranch: () => { },
		onPush: () => { },
		onCreateReviewRequest: () => { },
		onMergePromptBranch: () => { },
		onDiscardFile: () => { },
		onOpenFile: () => { },
		onOpenDiff: () => { },
		onOpenReviewRequest: () => { },
		onSetupReviewCli: () => { },
		onOpenMergeEditor: () => { },
		onGenerateCommitMessage: () => { },
		onCommitStaged: () => { },
		onCommitMessageChange: () => { },
		onTrackedBranchChange: () => { },
		onContinueStartChat: () => { },
		onContinueOpenChat: () => { },
		t: (key: string) => key,
	}));

	assert.match(markup, /passive-tracked-clean/);
	assert.match(markup, /prompt-project/);
	const mergeButtonMarkup = markup.match(/<button[^>]*><span[^>]*><span>editor\.gitOverlayMergeNow<\/span><\/span><\/button>/);
	assert.ok(mergeButtonMarkup);
	assert.doesNotMatch(markup, /editor\.gitOverlayMergeNeedsPromptCheckout/);
	assert.doesNotMatch(markup, /editor\.gitOverlayReviewRequestNeedsPromptCheckout/);
});

test('resolveGitOverlayPostCommitProjects excludes passive prompt projects without branch work', () => {
	const projects = resolveGitOverlayPostCommitProjects([
		{
			project: 'clean-prompt',
			available: true,
			currentBranch: 'feature/task-42',
			branches: [
				{
					name: 'feature/task-42',
					current: true,
					exists: true,
					kind: 'prompt',
					upstream: '',
					ahead: 0,
					behind: 0,
					lastCommit: {
						sha: 'abc1234',
						shortSha: 'abc1234',
						subject: 'same commit',
						author: 'dev',
						committedAt: '2026-04-02T00:00:00.000Z',
						refNames: ['feature/task-42'],
					},
					canSwitch: true,
					canDelete: false,
					stale: false,
				},
				{
					name: 'main',
					current: false,
					exists: true,
					kind: 'tracked',
					upstream: 'origin/main',
					ahead: 0,
					behind: 0,
					lastCommit: {
						sha: 'abc1234',
						shortSha: 'abc1234',
						subject: 'same commit',
						author: 'dev',
						committedAt: '2026-04-02T00:00:00.000Z',
						refNames: ['main'],
					},
					canSwitch: true,
					canDelete: false,
					stale: false,
				},
			],
		},
		{
			project: 'active-prompt',
			available: true,
			currentBranch: 'feature/task-42',
			branches: [
				{
					name: 'feature/task-42',
					current: true,
					exists: true,
					kind: 'prompt',
					upstream: '',
					ahead: 0,
					behind: 0,
					lastCommit: {
						sha: 'def5678',
						shortSha: 'def5678',
						subject: 'new work',
						author: 'dev',
						committedAt: '2026-04-02T01:00:00.000Z',
						refNames: ['feature/task-42'],
					},
					canSwitch: true,
					canDelete: false,
					stale: false,
				},
				{
					name: 'main',
					current: false,
					exists: true,
					kind: 'tracked',
					upstream: 'origin/main',
					ahead: 0,
					behind: 0,
					lastCommit: {
						sha: 'abc1234',
						shortSha: 'abc1234',
						subject: 'base commit',
						author: 'dev',
						committedAt: '2026-04-02T00:00:00.000Z',
						refNames: ['main'],
					},
					canSwitch: true,
					canDelete: false,
					stale: false,
				},
			],
		},
	], 'feature/task-42', {
		'clean-prompt': 'main',
		'active-prompt': 'main',
	});

	assert.deepEqual(projects.map(project => project.project), ['active-prompt']);
});

test('GitOverlay shows needs-switch status for clean tracked projects on step 1 and keeps switch-all enabled', () => {
	const markup = renderToStaticMarkup(React.createElement(GitOverlay, {
		open: true,
		mode: 'default',
		snapshot: {
			generatedAt: '2026-04-02T00:00:00.000Z',
			promptBranch: 'feature/task-42',
			trackedBranches: ['main'],
			projects: [
				{
					project: 'api',
					repositoryPath: '/tmp/api',
					available: true,
					error: '',
					currentBranch: 'main',
					promptBranch: 'feature/task-42',
					dirty: false,
					hasConflicts: false,
					upstream: 'origin/main',
					ahead: 0,
					behind: 0,
					lastCommit: null,
					branches: [],
					cleanupBranches: [],
					changeGroups: {
						merge: [],
						staged: [],
						workingTree: [],
						untracked: [],
					},
					review: {
						remote: null,
						request: null,
						error: '',
						setupAction: null,
					},
					recentCommits: [],
					staleLocalBranches: [],
					graph: {
						nodes: [],
						edges: [],
					},
				},
				{
					project: 'worker',
					repositoryPath: '/tmp/worker',
					available: true,
					error: '',
					currentBranch: 'main',
					promptBranch: 'feature/task-42',
					dirty: false,
					hasConflicts: false,
					upstream: 'origin/main',
					ahead: 0,
					behind: 0,
					lastCommit: null,
					branches: [],
					cleanupBranches: [],
					changeGroups: {
						merge: [],
						staged: [],
						workingTree: [],
						untracked: [],
					},
					review: {
						remote: null,
						request: null,
						error: '',
						setupAction: null,
					},
					recentCommits: [],
					staleLocalBranches: [],
					graph: {
						nodes: [],
						edges: [],
					},
				},
			],
		},
		commitMessages: {},
		busyAction: null,
		completedActions: { push: false, 'review-request': false, merge: false },
		promptStatus: 'draft',
		promptTitle: '',
		promptTaskNumber: '',
		preferredTrackedBranch: 'main',
		onClose: () => { },
		onDone: () => { },
		onRefresh: () => { },
		onSwitchBranch: () => { },
		onEnsurePromptBranch: () => { },
		onPush: () => { },
		onCreateReviewRequest: () => { },
		onMergePromptBranch: () => { },
		onDiscardFile: () => { },
		onOpenFile: () => { },
		onOpenDiff: () => { },
		onOpenReviewRequest: () => { },
		onSetupReviewCli: () => { },
		onOpenMergeEditor: () => { },
		onGenerateCommitMessage: () => { },
		onCommitStaged: () => { },
		onCommitMessageChange: () => { },
		onTrackedBranchChange: () => { },
		onContinueStartChat: () => { },
		onContinueOpenChat: () => { },
		t: (key: string) => key,
	}));

	assert.match(markup, /editor\.gitOverlayStepSwitchNoChangesToCommit/);
	assert.doesNotMatch(markup, /editor\.gitOverlayStepSwitchNothingToDo/);
	assert.match(markup, /editor\.gitOverlayProjectSourceBranch/);
	assert.match(markup, /editor\.gitOverlayProjectExpectedBranch/);
	assert.match(markup, /editor\.gitOverlayStateNeedsSwitch/);
	assert.equal(markup.match(/<option value="">editor\.gitOverlaySelectPlaceholder<\/option>/g)?.length || 0, 4);
	assert.equal(markup.match(/value="main"[^>]*>main<\/option>/g)?.length || 0, 2);
	assert.equal(markup.match(/value="feature\/task-42"[^>]*>feature\/task-42<\/option>/g)?.length || 0, 2);
	assert.doesNotMatch(markup, /min-width:1060px/);
	assert.match(markup, /<span style="font-size:12px;font-weight:600;text-align:center;word-break:break-word;color:red">editor\.gitOverlayStateNeedsSwitch<\/span>/);
	assert.match(markup, /<button(?![^>]*disabled)[^>]*><span[^>]*><span>editor\.gitOverlaySwitchAll<\/span><\/span><\/button>/);
});

test('GitOverlay shows ready status as blue text without a background pill', () => {
	const markup = renderToStaticMarkup(React.createElement(GitOverlay, {
		open: true,
		mode: 'default',
		snapshot: {
			generatedAt: '2026-04-02T00:00:00.000Z',
			promptBranch: '',
			trackedBranches: ['main'],
			projects: [
				{
					project: 'api',
					repositoryPath: '/tmp/api',
					available: true,
					error: '',
					currentBranch: 'main',
					promptBranch: '',
					dirty: true,
					hasConflicts: false,
					upstream: 'origin/main',
					ahead: 0,
					behind: 0,
					lastCommit: null,
					branches: [],
					cleanupBranches: [],
					changeGroups: {
						merge: [],
						staged: [
							{
								project: 'api',
								path: 'src/index.ts',
								status: 'M',
								previousPath: '',
								group: 'staged',
								conflicted: false,
								staged: true,
								isBinary: false,
								additions: 1,
								deletions: 0,
								fileSizeBytes: 100,
							},
						],
						workingTree: [],
						untracked: [],
					},
					review: {
						remote: null,
						request: null,
						error: '',
						setupAction: null,
					},
					recentCommits: [],
					staleLocalBranches: [],
					graph: {
						nodes: [],
						edges: [],
					},
				},
			],
		},
		commitMessages: {},
		busyAction: null,
		completedActions: { push: false, 'review-request': false, merge: false },
		promptStatus: 'draft',
		promptTitle: '',
		promptTaskNumber: '',
		preferredTrackedBranch: 'main',
		onClose: () => { },
		onDone: () => { },
		onRefresh: () => { },
		onSwitchBranch: () => { },
		onEnsurePromptBranch: () => { },
		onPush: () => { },
		onCreateReviewRequest: () => { },
		onMergePromptBranch: () => { },
		onDiscardFile: () => { },
		onOpenFile: () => { },
		onOpenDiff: () => { },
		onOpenReviewRequest: () => { },
		onSetupReviewCli: () => { },
		onOpenMergeEditor: () => { },
		onGenerateCommitMessage: () => { },
		onCommitStaged: () => { },
		onCommitMessageChange: () => { },
		onTrackedBranchChange: () => { },
		onContinueStartChat: () => { },
		onContinueOpenChat: () => { },
		t: (key: string) => key,
	}));

	assert.match(markup, /<span style="font-size:12px;font-weight:600;text-align:center;word-break:break-word;color:blue">editor\.gitOverlayStateReady<\/span>/);
});

test('GitOverlay shows empty-step hint when default step 1 has no available projects', () => {
	const markup = renderToStaticMarkup(React.createElement(GitOverlay, {
		open: true,
		mode: 'default',
		snapshot: {
			generatedAt: '2026-04-02T00:00:00.000Z',
			promptBranch: 'feature/task-42',
			trackedBranches: ['main'],
			projects: [
				{
					project: 'api',
					repositoryPath: '/tmp/api',
					available: false,
					error: 'workspace unavailable',
					currentBranch: 'main',
					promptBranch: 'feature/task-42',
					dirty: false,
					hasConflicts: false,
					upstream: 'origin/main',
					ahead: 0,
					behind: 0,
					lastCommit: null,
					branches: [],
					cleanupBranches: [],
					changeGroups: {
						merge: [],
						staged: [],
						workingTree: [],
						untracked: [],
					},
					review: {
						remote: null,
						request: null,
						error: '',
						setupAction: null,
					},
					recentCommits: [],
					staleLocalBranches: [],
					graph: {
						nodes: [],
						edges: [],
					},
				},
			],
		},
		commitMessages: {},
		busyAction: null,
		completedActions: { push: false, 'review-request': false, merge: false },
		promptStatus: 'draft',
		promptTitle: '',
		promptTaskNumber: '',
		preferredTrackedBranch: 'main',
		onClose: () => { },
		onDone: () => { },
		onRefresh: () => { },
		onSwitchBranch: () => { },
		onEnsurePromptBranch: () => { },
		onPush: () => { },
		onCreateReviewRequest: () => { },
		onMergePromptBranch: () => { },
		onDiscardFile: () => { },
		onOpenFile: () => { },
		onOpenDiff: () => { },
		onOpenReviewRequest: () => { },
		onSetupReviewCli: () => { },
		onOpenMergeEditor: () => { },
		onGenerateCommitMessage: () => { },
		onCommitStaged: () => { },
		onCommitMessageChange: () => { },
		onTrackedBranchChange: () => { },
		onContinueStartChat: () => { },
		onContinueOpenChat: () => { },
		t: (key: string) => key,
	}));

	assert.match(markup, /editor\.gitOverlayStepSwitchNothingToDo/);
	assert.doesNotMatch(markup, /editor\.gitOverlaySwitchAll/);
	assert.doesNotMatch(markup, /editor\.gitOverlayProjectSourceBranch/);
	assert.doesNotMatch(markup, /editor\.gitOverlayProjectExpectedBranch/);
});

test('GitOverlay renders project discard action before the changes toggle in step 2', () => {
	const markup = renderToStaticMarkup(React.createElement(GitOverlay, {
		open: true,
		mode: 'default',
		snapshot: {
			generatedAt: '2026-04-02T00:00:00.000Z',
			promptBranch: 'feature/task-42',
			trackedBranches: ['main'],
			projects: [
				{
					project: 'tracked-dirty',
					repositoryPath: '/tmp/tracked',
					available: true,
					error: '',
					currentBranch: 'feature/task-42',
					promptBranch: 'feature/task-42',
					dirty: true,
					hasConflicts: false,
					upstream: 'origin/feature/task-42',
					ahead: 0,
					behind: 0,
					lastCommit: null,
					branches: [],
					cleanupBranches: [],
					changeGroups: {
						merge: [],
						staged: [
							{
								project: 'tracked-dirty',
								path: 'src/index.ts',
								status: 'M',
								previousPath: '',
								group: 'staged',
								conflicted: false,
								staged: true,
								isBinary: false,
								additions: 1,
								deletions: 0,
								fileSizeBytes: 100,
							},
						],
						workingTree: [],
						untracked: [],
					},
					review: {
						remote: null,
						request: null,
						error: '',
						setupAction: null,
					},
					recentCommits: [],
					staleLocalBranches: [],
					graph: {
						nodes: [],
						edges: [],
					},
				},
			],
		},
		commitMessages: {
			'tracked-dirty': 'tracked commit message',
		},
		busyAction: null,
		completedActions: { push: false, 'review-request': false, merge: false },
		promptStatus: 'completed',
		promptTitle: '',
		promptTaskNumber: '',
		preferredTrackedBranch: 'main',
		onClose: () => { },
		onDone: () => { },
		onRefresh: () => { },
		onSwitchBranch: () => { },
		onEnsurePromptBranch: () => { },
		onPush: () => { },
		onCreateReviewRequest: () => { },
		onMergePromptBranch: () => { },
		onDiscardFile: () => { },
		onDiscardProjectChanges: () => { },
		onOpenFile: () => { },
		onOpenDiff: () => { },
		onOpenReviewRequest: () => { },
		onSetupReviewCli: () => { },
		onOpenMergeEditor: () => { },
		onGenerateCommitMessage: () => { },
		onCommitStaged: () => { },
		onCommitMessageChange: () => { },
		onTrackedBranchChange: () => { },
		onContinueStartChat: () => { },
		onContinueOpenChat: () => { },
		t: (key: string) => key,
	}));

	assert.match(markup, /editor\.gitOverlayDiscardProjectChanges[\s\S]*editor\.gitOverlayShowChanges/);
});

test('GitOverlay shows specific review unsupported reasons per project', () => {
	const markup = renderToStaticMarkup(React.createElement(GitOverlay, {
		open: true,
		mode: 'default',
		snapshot: {
			generatedAt: '2026-04-02T00:00:00.000Z',
			promptBranch: 'feature/task-42',
			trackedBranches: ['main'],
			projects: [
				{
					project: 'missing-remote',
					repositoryPath: '/tmp/missing-remote',
					available: true,
					error: '',
					currentBranch: 'feature/task-42',
					promptBranch: 'feature/task-42',
					dirty: false,
					hasConflicts: false,
					upstream: 'origin/feature/task-42',
					ahead: 0,
					behind: 0,
					lastCommit: null,
					branches: [],
					cleanupBranches: [],
					changeGroups: { merge: [], staged: [], workingTree: [], untracked: [] },
					review: {
						remote: null,
						request: null,
						error: '',
						setupAction: null,
						unsupportedReason: 'missing-remote',
					},
					recentCommits: [],
					staleLocalBranches: [],
					graph: { nodes: [], edges: [] },
				},
				{
					project: 'unsupported-provider',
					repositoryPath: '/tmp/unsupported-provider',
					available: true,
					error: '',
					currentBranch: 'feature/task-42',
					promptBranch: 'feature/task-42',
					dirty: false,
					hasConflicts: false,
					upstream: 'origin/feature/task-42',
					ahead: 0,
					behind: 0,
					lastCommit: null,
					branches: [],
					cleanupBranches: [],
					changeGroups: { merge: [], staged: [], workingTree: [], untracked: [] },
					review: {
						remote: {
							provider: 'unknown',
							host: 'bitbucket.example.com',
							remoteName: 'origin',
							remoteUrl: 'https://bitbucket.example.com/acme/repo.git',
							repositoryPath: 'acme/repo',
							owner: 'acme',
							name: 'repo',
							supported: false,
							cliCommand: '',
							cliAvailable: false,
							actionLabel: 'Review request',
						},
						request: null,
						error: '',
						setupAction: null,
						unsupportedReason: 'unsupported-provider',
					},
					recentCommits: [],
					staleLocalBranches: [],
					graph: { nodes: [], edges: [] },
				},
			],
		},
		commitMessages: {},
		busyAction: null,
		completedActions: { push: true, 'review-request': false, merge: false },
		promptStatus: 'report',
		promptTitle: '',
		promptTaskNumber: '',
		preferredTrackedBranch: 'main',
		onClose: () => { },
		onDone: () => { },
		onRefresh: () => { },
		onSwitchBranch: () => { },
		onEnsurePromptBranch: () => { },
		onPush: () => { },
		onCreateReviewRequest: () => { },
		onMergePromptBranch: () => { },
		onDiscardFile: () => { },
		onOpenFile: () => { },
		onOpenDiff: () => { },
		onOpenReviewRequest: () => { },
		onSetupReviewCli: () => { },
		onOpenMergeEditor: () => { },
		onGenerateCommitMessage: () => { },
		onCommitStaged: () => { },
		onCommitMessageChange: () => { },
		onTrackedBranchChange: () => { },
		onContinueStartChat: () => { },
		onContinueOpenChat: () => { },
		t: (key: string) => key,
	}));

	assert.match(markup, /editor\.gitOverlayReviewRequestMissingRemoteProject/);
	assert.match(markup, /editor\.gitOverlayReviewRequestUnsupportedProject/);
});

test('formatChangeSize formats bytes into compact localized values', () => {
	assert.equal(formatChangeSize(5526, 'ru-RU'), '5,5КБ');
	assert.equal(formatChangeSize(512, 'ru-RU'), '512Б');
});

test('GitOverlay hides steps 2-5 for draft prompts in default mode', () => {
	const markup = renderToStaticMarkup(React.createElement(GitOverlay, {
		open: true,
		mode: 'default',
		snapshot: {
			generatedAt: '2026-04-02T00:00:00.000Z',
			promptBranch: 'feature/task-42',
			trackedBranches: ['main'],
			projects: [
				{
					project: 'prompt-project',
					repositoryPath: '/tmp/prompt',
					available: true,
					error: '',
					currentBranch: 'feature/task-42',
					promptBranch: 'feature/task-42',
					dirty: false,
					hasConflicts: false,
					upstream: 'origin/feature/task-42',
					ahead: 0,
					behind: 0,
					lastCommit: null,
					branches: [],
					cleanupBranches: [],
					changeGroups: {
						merge: [],
						staged: [],
						workingTree: [],
						untracked: [],
					},
					review: {
						remote: null,
						request: null,
						error: '',
						setupAction: null,
					},
					recentCommits: [],
					staleLocalBranches: [],
					graph: {
						nodes: [],
						edges: [],
					},
				},
			],
		},
		commitMessages: {},
		busyAction: null,
		completedActions: { push: false, 'review-request': false, merge: false },
		promptStatus: 'draft',
		promptTitle: '',
		promptTaskNumber: '',
		preferredTrackedBranch: 'main',
		onClose: () => { },
		onDone: () => { },
		onRefresh: () => { },
		onSwitchBranch: () => { },
		onEnsurePromptBranch: () => { },
		onPush: () => { },
		onCreateReviewRequest: () => { },
		onMergePromptBranch: () => { },
		onDiscardFile: () => { },
		onOpenFile: () => { },
		onOpenDiff: () => { },
		onOpenReviewRequest: () => { },
		onSetupReviewCli: () => { },
		onOpenMergeEditor: () => { },
		onGenerateCommitMessage: () => { },
		onCommitStaged: () => { },
		onCommitMessageChange: () => { },
		onTrackedBranchChange: () => { },
		onContinueStartChat: () => { },
		onContinueOpenChat: () => { },
		t: (key: string) => key,
	}));

	assert.match(markup, /editor\.gitOverlayStepSwitchTitle/);
	assert.doesNotMatch(markup, /editor\.gitOverlayStepCommitTitle/);
	assert.doesNotMatch(markup, /editor\.gitOverlayStepPushTitle/);
	assert.doesNotMatch(markup, /editor\.gitOverlayStepReviewRequestTitle/);
	assert.doesNotMatch(markup, /editor\.gitOverlayStepMergeTitle/);
});

test('GitOverlay shows blocking prompt-branch warning for non-draft prompts on tracked branches', () => {
	const markup = renderToStaticMarkup(React.createElement(GitOverlay, {
		open: true,
		mode: 'default',
		snapshot: {
			generatedAt: '2026-04-02T00:00:00.000Z',
			promptBranch: 'feature/task-42',
			trackedBranches: ['main'],
			projects: [
				{
					project: 'tracked-dirty',
					repositoryPath: '/tmp/tracked',
					available: true,
					error: '',
					currentBranch: 'main',
					promptBranch: 'feature/task-42',
					dirty: true,
					hasConflicts: false,
					upstream: 'origin/main',
					ahead: 0,
					behind: 0,
					lastCommit: null,
					branches: [],
					cleanupBranches: [],
					changeGroups: {
						merge: [],
						staged: [
							{
								project: 'tracked-dirty',
								path: 'src/index.ts',
								status: 'M',
								previousPath: '',
								group: 'staged',
								conflicted: false,
								staged: true,
								isBinary: false,
								additions: 1,
								deletions: 0,
								fileSizeBytes: 100,
							},
						],
						workingTree: [],
						untracked: [],
					},
					review: {
						remote: null,
						request: null,
						error: '',
						setupAction: null,
					},
					recentCommits: [],
					staleLocalBranches: [],
					graph: {
						nodes: [],
						edges: [],
					},
				},
			],
		},
		commitMessages: {},
		busyAction: null,
		completedActions: { push: false, 'review-request': false, merge: false },
		promptStatus: 'completed',
		promptTitle: '',
		promptTaskNumber: '',
		preferredTrackedBranch: 'main',
		onClose: () => { },
		onDone: () => { },
		onRefresh: () => { },
		onSwitchBranch: () => { },
		onEnsurePromptBranch: () => { },
		onPush: () => { },
		onCreateReviewRequest: () => { },
		onMergePromptBranch: () => { },
		onDiscardFile: () => { },
		onOpenFile: () => { },
		onOpenDiff: () => { },
		onOpenReviewRequest: () => { },
		onSetupReviewCli: () => { },
		onOpenMergeEditor: () => { },
		onGenerateCommitMessage: () => { },
		onCommitStaged: () => { },
		onCommitMessageChange: () => { },
		onTrackedBranchChange: () => { },
		onContinueStartChat: () => { },
		onContinueOpenChat: () => { },
		t: (key: string) => key,
	}));

	assert.match(markup, /editor\.gitOverlayTrackedBranchSwitchRequiredHint/);
	assert.doesNotMatch(markup, /editor\.gitOverlayTrackedBranchStepReadyHint/);
	assert.match(markup, /editor\.gitOverlayStepCommitTitle/);
});

test('GitOverlay allows commit step when prompt branch is empty but dirty project is already on tracked branch', () => {
	const markup = renderToStaticMarkup(React.createElement(GitOverlay, {
		open: true,
		mode: 'default',
		snapshot: {
			generatedAt: '2026-04-02T00:00:00.000Z',
			promptBranch: '',
			trackedBranches: ['main'],
			projects: [
				{
					project: 'tracked-dirty',
					repositoryPath: '/tmp/tracked',
					available: true,
					error: '',
					currentBranch: 'main',
					promptBranch: '',
					dirty: true,
					hasConflicts: false,
					upstream: 'origin/main',
					ahead: 0,
					behind: 0,
					lastCommit: null,
					branches: [],
					cleanupBranches: [],
					changeGroups: {
						merge: [],
						staged: [
							{
								project: 'tracked-dirty',
								path: 'src/index.ts',
								status: 'M',
								previousPath: '',
								group: 'staged',
								conflicted: false,
								staged: true,
								isBinary: false,
								additions: 1,
								deletions: 0,
								fileSizeBytes: 100,
							},
						],
						workingTree: [],
						untracked: [],
					},
					review: {
						remote: null,
						request: null,
						error: '',
						setupAction: null,
					},
					recentCommits: [],
					staleLocalBranches: [],
					graph: {
						nodes: [],
						edges: [],
					},
				},
			],
		},
		commitMessages: {
			'tracked-dirty': 'tracked commit message',
		},
		busyAction: null,
		completedActions: { push: false, 'review-request': false, merge: false },
		promptStatus: 'completed',
		promptTitle: '',
		promptTaskNumber: '',
		preferredTrackedBranch: 'main',
		onClose: () => { },
		onDone: () => { },
		onRefresh: () => { },
		onSwitchBranch: () => { },
		onEnsurePromptBranch: () => { },
		onPush: () => { },
		onCreateReviewRequest: () => { },
		onMergePromptBranch: () => { },
		onDiscardFile: () => { },
		onOpenFile: () => { },
		onOpenDiff: () => { },
		onOpenReviewRequest: () => { },
		onSetupReviewCli: () => { },
		onOpenMergeEditor: () => { },
		onGenerateCommitMessage: () => { },
		onCommitStaged: () => { },
		onCommitMessageChange: () => { },
		onTrackedBranchChange: () => { },
		onContinueStartChat: () => { },
		onContinueOpenChat: () => { },
		t: (key: string) => key,
	}));

	assert.match(markup, /editor\.gitOverlayStepCommitTitle/);
	assert.match(markup, /tracked commit message/);
	assert.doesNotMatch(markup, /editor\.gitOverlayProjectNeedsSwitch/);
	assert.match(markup, /<button(?![^>]*disabled)[^>]*><span[^>]*><span>editor\.gitOverlayCommitProject<\/span><\/span><\/button>/);
});

test('GitOverlay shows prompt-branch fallback info without red prompt-branch validation when dirty projects stay on tracked branches', () => {
	const markup = renderGitOverlayMarkup({
		snapshot: createTestSnapshot({
			promptBranch: '',
			trackedBranches: ['main'],
			projects: [
				createTestProject({
					project: 'tracked-dirty',
					currentBranch: 'main',
					promptBranch: '',
					dirty: true,
					changeGroups: {
						staged: [createTestChange({ project: 'tracked-dirty' })],
					},
				}),
			],
		}),
		commitMessages: {
			'tracked-dirty': 'tracked commit message',
		},
	});

	assert.match(markup, /editor\.gitOverlayPromptBranchFallbackInfo/);
	assert.doesNotMatch(markup, /editor\.gitOverlayPromptBranchMissing/);
	assert.doesNotMatch(markup, /editor\.gitOverlayFieldNeedsValue/);
	assert.doesNotMatch(markup, /editor\.gitOverlayProjectNeedsTrackedOrPromptSwitch/);
	assert.match(markup, /editor\.gitOverlayStateReady/);
	assert.doesNotMatch(markup, /editor\.gitOverlayStateNeedsTarget/);
});

test('GitOverlay hides prompt-branch warning when prompt branch is empty and the current branch is tracked', () => {
	const markup = renderGitOverlayMarkup({
		snapshot: createTestSnapshot({
			promptBranch: '',
			trackedBranches: ['main'],
			projects: [
				createTestProject({
					project: 'tracked-clean',
					currentBranch: 'main',
					promptBranch: '',
					branches: [
						{
							name: 'main',
							current: true,
							exists: true,
							kind: 'current',
							upstream: 'origin/main',
							ahead: 0,
							behind: 0,
							lastCommit: null,
							canSwitch: true,
							canDelete: false,
							stale: false,
						},
					],
				}),
			],
		}),
	});

	assert.doesNotMatch(markup, /editor\.gitOverlayPromptBranchMissing/);
	assert.doesNotMatch(markup, /editor\.gitOverlayPromptBranchFallbackInfo/);
	assert.doesNotMatch(markup, /editor\.gitOverlayProjectNeedsTrackedOrPromptSwitch/);
	assert.match(markup, /editor\.gitOverlayStepNoProjectChanges/);
	assert.equal(markup.match(/<select/g)?.length || 0, 0);
});

test('GitOverlay does not show generic no-project-changes hint when another step 1 info already applies', () => {
	const markup = renderGitOverlayMarkup({
		snapshot: createTestSnapshot({
			promptBranch: 'feature/task-42',
			trackedBranches: ['main'],
			projects: [
				createTestProject({
					project: 'tracked-clean',
					currentBranch: 'main',
					promptBranch: 'feature/task-42',
				}),
			],
		}),
	});

	assert.match(markup, /editor\.gitOverlayTrackedBranchSwitchRequiredHint/);
	assert.doesNotMatch(markup, /editor\.gitOverlayStepNoProjectChanges/);
});

test('GitOverlay excludes the current branch from expected branch options', () => {
	const markup = renderGitOverlayMarkup({
		snapshot: createTestSnapshot({
			promptBranch: '',
			trackedBranches: ['main', 'develop'],
			projects: [
				createTestProject({
					project: 'tracked-clean',
					currentBranch: 'main',
					promptBranch: '',
					branches: [
						{
							name: 'main',
							current: true,
							exists: true,
							kind: 'current',
							upstream: 'origin/main',
							ahead: 0,
							behind: 0,
							lastCommit: null,
							canSwitch: true,
							canDelete: false,
							stale: false,
						},
						{
							name: 'develop',
							current: false,
							exists: true,
							kind: 'tracked',
							upstream: 'origin/develop',
							ahead: 0,
							behind: 0,
							lastCommit: null,
							canSwitch: true,
							canDelete: false,
							stale: false,
						},
					],
				}),
			],
		}),
	});

	assert.equal((markup.match(/>main<\/option>/g) || []).length, 0);
	assert.equal((markup.match(/>develop<\/option>/g) || []).length, 1);
	assert.equal(markup.match(/<select/g)?.length || 0, 1);
});

test('GitOverlay enables step 1 switching for clean projects outside tracked and prompt branches', () => {
	const markup = renderGitOverlayMarkup({
		snapshot: createTestSnapshot({
			promptBranch: 'feature/task-42',
			trackedBranches: ['main'],
			projects: [
				createTestProject({
					project: 'legacy-clean',
					currentBranch: 'feature/legacy',
					branches: [
						{
							name: 'feature/legacy',
							current: true,
							exists: true,
							kind: 'current',
							upstream: '',
							ahead: 0,
							behind: 0,
							lastCommit: null,
							canSwitch: true,
							canDelete: false,
							stale: false,
						},
						{
							name: 'main',
							current: false,
							exists: true,
							kind: 'tracked',
							upstream: 'origin/main',
							ahead: 0,
							behind: 0,
							lastCommit: null,
							canSwitch: true,
							canDelete: false,
							stale: false,
						},
					],
				}),
			],
		}),
	});

	assert.match(markup, /editor\.gitOverlayStateNeedsSwitch/);
	assert.doesNotMatch(markup, /editor\.gitOverlayStateNoChanges/);
	assert.match(markup, /<button(?![^>]*disabled)[^>]*><span[^>]*><span>editor\.gitOverlaySwitch<\/span><\/span><\/button>/);
	assert.match(markup, /<button(?![^>]*disabled)[^>]*><span[^>]*><span>editor\.gitOverlaySwitchAll<\/span><\/span><\/button>/);
});

test('GitOverlay enables step 1 switching from tracked to prompt branch without uncommitted changes', () => {
	const markup = renderGitOverlayMarkup({
		snapshot: createTestSnapshot({
			promptBranch: 'feature/task-42',
			trackedBranches: ['main'],
			projects: [
				createTestProject({
					project: 'tracked-clean',
					currentBranch: 'main',
					branches: [
						{
							name: 'main',
							current: true,
							exists: true,
							kind: 'current',
							upstream: 'origin/main',
							ahead: 0,
							behind: 0,
							lastCommit: null,
							canSwitch: true,
							canDelete: false,
							stale: false,
						},
					],
				}),
			],
		}),
	});

	assert.match(markup, /editor\.gitOverlayStateNeedsSwitch/);
	assert.doesNotMatch(markup, /editor\.gitOverlayStateNoChanges/);
	assert.equal(markup.match(/<select/g)?.length || 0, 2);
	assert.match(markup, /<button(?![^>]*disabled)[^>]*><span[^>]*><span>editor\.gitOverlaySwitch<\/span><\/span><\/button>/);
	assert.match(markup, /<button(?![^>]*disabled)[^>]*><span[^>]*><span>editor\.gitOverlaySwitchAll<\/span><\/span><\/button>/);
});

test('GitOverlay hides source select when expected branch already exists for the project', () => {
	const markup = renderGitOverlayMarkup({
		snapshot: createTestSnapshot({
			promptBranch: 'feature/task-42',
			trackedBranches: ['main'],
			projects: [
				createTestProject({
					project: 'legacy-clean',
					currentBranch: 'feature/legacy',
					branches: [
						{
							name: 'feature/legacy',
							current: true,
							exists: true,
							kind: 'current',
							upstream: '',
							ahead: 0,
							behind: 0,
							lastCommit: null,
							canSwitch: true,
							canDelete: false,
							stale: false,
						},
						{
							name: 'main',
							current: false,
							exists: true,
							kind: 'tracked',
							upstream: 'origin/main',
							ahead: 0,
							behind: 0,
							lastCommit: null,
							canSwitch: true,
							canDelete: false,
							stale: false,
						},
						{
							name: 'feature/task-42',
							current: false,
							exists: true,
							kind: 'prompt',
							upstream: 'origin/feature/task-42',
							ahead: 0,
							behind: 0,
							lastCommit: null,
							canSwitch: true,
							canDelete: false,
							stale: false,
						},
					],
				}),
			],
		}),
	});

	assert.equal(markup.match(/<select/g)?.length || 0, 1);
	assert.match(markup, /editor\.gitOverlayProjectSourceBranch/);
	assert.match(markup, /editor\.gitOverlayProjectExpectedBranch/);
});

test('GitOverlay keeps prompt-branch warning, hides field-needs-value text, and hides source for existing tracked target when prompt branch is empty', () => {
	const markup = renderGitOverlayMarkup({
		snapshot: createTestSnapshot({
			promptBranch: '',
			trackedBranches: ['main'],
			projects: [
				createTestProject({
					project: 'legacy-clean',
					currentBranch: 'feature/legacy',
					promptBranch: '',
					branches: [
						{
							name: 'feature/legacy',
							current: true,
							exists: true,
							kind: 'current',
							upstream: '',
							ahead: 0,
							behind: 0,
							lastCommit: null,
							canSwitch: true,
							canDelete: false,
							stale: false,
						},
						{
							name: 'main',
							current: false,
							exists: true,
							kind: 'tracked',
							upstream: 'origin/main',
							ahead: 0,
							behind: 0,
							lastCommit: null,
							canSwitch: true,
							canDelete: false,
							stale: false,
						},
					],
				}),
			],
		}),
	});

	assert.match(markup, /editor\.gitOverlayPromptBranchMissing/);
	assert.doesNotMatch(markup, /editor\.gitOverlayFieldNeedsValue/);
	assert.match(markup, /editor\.gitOverlayStateNeedsSwitch/);
	assert.match(markup, /<button(?![^>]*disabled)[^>]*><span[^>]*><span>editor\.gitOverlaySwitch<\/span><\/span><\/button>/);
	assert.match(markup, /<button(?![^>]*disabled)[^>]*><span[^>]*><span>editor\.gitOverlaySwitchAll<\/span><\/span><\/button>/);
	assert.equal(markup.match(/<select/g)?.length || 0, 1);
});

test('GitOverlay keeps prompt rows on prompt even when the current prompt branch is hidden from expected options', () => {
	const markup = renderGitOverlayMarkup({
		snapshot: createTestSnapshot({
			promptBranch: 'feature/task-42',
			trackedBranches: ['main'],
			projects: [
				createTestProject({
					project: 'prompt-dirty',
					currentBranch: 'feature/task-42',
					dirty: true,
					changeGroups: {
						staged: [createTestChange({ project: 'prompt-dirty' })],
					},
					branches: [
						{
							name: 'feature/task-42',
							current: true,
							exists: true,
							kind: 'prompt',
							upstream: 'origin/feature/task-42',
							ahead: 0,
							behind: 0,
							lastCommit: null,
							canSwitch: true,
							canDelete: false,
							stale: false,
						},
						{
							name: 'main',
							current: false,
							exists: true,
							kind: 'tracked',
							upstream: 'origin/main',
							ahead: 0,
							behind: 0,
							lastCommit: null,
							canSwitch: true,
							canDelete: false,
							stale: false,
						},
					],
				}),
			],
		}),
	});

	assert.match(markup, /editor\.gitOverlayStateOnPrompt/);
	assert.doesNotMatch(markup, /editor\.gitOverlayStateNeedsTarget/);
	assert.equal(markup.match(/<select/g)?.length || 0, 1);
});

test('GitOverlay step 3 keeps tracked projects without prompt-checkout warnings when the section is visible', () => {
	const markup = renderGitOverlayMarkup({
		snapshot: createTestSnapshot({
			promptBranch: 'feature/task-42',
			trackedBranches: ['main'],
			projects: [
				createTestProject({
					project: 'tracked-clean',
					currentBranch: 'main',
					promptBranch: 'feature/task-42',
				}),
			],
		}),
	});

	assert.match(markup, /editor\.gitOverlayStepPushTitle/);
	assert.doesNotMatch(markup, /editor\.gitOverlayPushNeedsPromptCheckout/);
	assert.doesNotMatch(markup, /editor\.gitOverlayPushNeedsTrackedOrPromptBranch/);
});

test('GitOverlay allows push on tracked branches without prompt branch after commit, keeps steps 2 and 3 active, and grays out steps 4 and 5', () => {
	const markup = renderGitOverlayMarkup({
		snapshot: createTestSnapshot({
			promptBranch: '',
			trackedBranches: ['main'],
			projects: [
				createTestProject({
					project: 'tracked-clean',
					currentBranch: 'main',
					promptBranch: '',
					ahead: 1,
					upstream: 'origin/main',
					branches: [
						{
							name: 'main',
							current: true,
							exists: true,
							kind: 'current',
							upstream: 'origin/main',
							ahead: 1,
							behind: 0,
							lastCommit: null,
							canSwitch: true,
							canDelete: false,
							stale: false,
						},
					],
				}),
			],
		}),
	});

	assert.doesNotMatch(markup, /editor\.gitOverlayPushNeedsPromptBranch/);
	assert.match(markup, /<button(?![^>]*disabled)[^>]*><span[^>]*><span>editor\.gitOverlayPushPromptBranch<\/span><\/span><\/button>/);
	assert.match(markup, /<div style="[^"]*background:var\(--vscode-button-background\);color:var\(--vscode-button-foreground\)[^"]*">2<\/div>/);
	assert.match(markup, /<div style="[^"]*background:var\(--vscode-button-background\);color:var\(--vscode-button-foreground\)[^"]*">3<\/div>/);
	assert.match(markup, /<div style="[^"]*background:var\(--vscode-badge-background\);color:var\(--vscode-descriptionForeground\)[^"]*">4<\/div>/);
	assert.match(markup, /<div style="[^"]*background:var\(--vscode-badge-background\);color:var\(--vscode-descriptionForeground\)[^"]*">5<\/div>/);
	assert.doesNotMatch(markup, /<div style="[^"]*background:var\(--vscode-badge-background\);color:var\(--vscode-descriptionForeground\)[^"]*">2<\/div>/);
	assert.doesNotMatch(markup, /<div style="[^"]*background:var\(--vscode-badge-background\);color:var\(--vscode-descriptionForeground\)[^"]*">3<\/div>/);
	assert.doesNotMatch(markup, /<div style="[^"]*background:var\(--vscode-button-background\);color:var\(--vscode-button-foreground\)[^"]*">4<\/div>/);
	assert.doesNotMatch(markup, /<div style="[^"]*background:var\(--vscode-button-background\);color:var\(--vscode-button-foreground\)[^"]*">5<\/div>/);
});

test('GitOverlay disables commit textarea with the same gating as commit message generation', () => {
	const markup = renderToStaticMarkup(React.createElement(GitOverlay, {
		open: true,
		mode: 'default',
		snapshot: {
			generatedAt: '2026-04-02T00:00:00.000Z',
			promptBranch: 'feature/task-42',
			trackedBranches: ['main'],
			projects: [
				{
					project: 'tracked-dirty',
					repositoryPath: '/tmp/tracked',
					available: true,
					error: '',
					currentBranch: 'main',
					promptBranch: 'feature/task-42',
					dirty: true,
					hasConflicts: false,
					upstream: 'origin/main',
					ahead: 0,
					behind: 0,
					lastCommit: null,
					branches: [],
					cleanupBranches: [],
					changeGroups: {
						merge: [],
						staged: [
							{
								project: 'tracked-dirty',
								path: 'src/index.ts',
								status: 'M',
								previousPath: '',
								group: 'staged',
								conflicted: false,
								staged: true,
								isBinary: false,
								additions: 1,
								deletions: 0,
								fileSizeBytes: 100,
							},
						],
						workingTree: [],
						untracked: [],
					},
					review: {
						remote: null,
						request: null,
						error: '',
						setupAction: null,
					},
					recentCommits: [],
					staleLocalBranches: [],
					graph: {
						nodes: [],
						edges: [],
					},
				},
			],
		},
		commitMessages: {
			'tracked-dirty': '',
		},
		busyAction: null,
		completedActions: { push: false, 'review-request': false, merge: false },
		promptStatus: 'completed',
		promptTitle: '',
		promptTaskNumber: '',
		preferredTrackedBranch: 'main',
		onClose: () => { },
		onDone: () => { },
		onRefresh: () => { },
		onSwitchBranch: () => { },
		onEnsurePromptBranch: () => { },
		onPush: () => { },
		onCreateReviewRequest: () => { },
		onMergePromptBranch: () => { },
		onDiscardFile: () => { },
		onOpenFile: () => { },
		onOpenDiff: () => { },
		onOpenReviewRequest: () => { },
		onSetupReviewCli: () => { },
		onOpenMergeEditor: () => { },
		onGenerateCommitMessage: () => { },
		onCommitStaged: () => { },
		onCommitMessageChange: () => { },
		onTrackedBranchChange: () => { },
		onContinueStartChat: () => { },
		onContinueOpenChat: () => { },
		t: (key: string) => key === 'editor.gitOverlayCommitPlaceholder' ? 'Сообщение коммита...' : key,
	}));

	assert.match(markup, /<textarea[^>]*disabled[^>]*placeholder="Сообщение коммита\.\.\."/);
});

test('GitOverlay shows progress line during automatic refresh', () => {
	const markup = renderGitOverlayMarkup({
		busyAction: 'refresh:auto',
	});

	assert.match(markup, /data-pm-git-overlay-progress="auto"/);
});

test('GitOverlay shows progress line during initial overlay loading', () => {
	const markup = renderGitOverlayMarkup({
		busyAction: 'overlay:loading',
		snapshot: null,
	});

	assert.match(markup, /data-pm-git-overlay-progress="loading"/);
	assert.match(markup, /editor\.gitOverlayLoading/);
});

test('GitOverlay keeps progress track mounted while idle to avoid layout jumps', () => {
	const markup = renderGitOverlayMarkup({
		busyAction: null,
	});

	assert.match(markup, /data-pm-git-overlay-progress="idle"/);
});

test('GitOverlay renders default mode as read-only for prompts in progress', () => {
	const markup = renderGitOverlayMarkup({
		promptStatus: 'in-progress',
		snapshot: createTestSnapshot({
			projects: [
				createTestProject({
					project: 'api',
					currentBranch: 'feature/task-42',
					upstream: 'origin/feature/task-42',
					branches: [
						{
							name: 'feature/task-42',
							current: true,
							exists: true,
							kind: 'current',
							upstream: 'origin/feature/task-42',
							ahead: 0,
							behind: 0,
							lastCommit: null,
							canSwitch: true,
							canDelete: false,
							stale: false,
						},
						{
							name: 'main',
							current: false,
							exists: true,
							kind: 'tracked',
							upstream: 'origin/main',
							ahead: 0,
							behind: 0,
							lastCommit: null,
							canSwitch: true,
							canDelete: false,
							stale: false,
						},
					],
					changeGroups: {
						staged: [createTestChange({ project: 'api' })],
					},
				}),
			],
		}),
		commitMessages: {
			api: 'feat: keep current progress',
		},
	});

	assert.match(markup, /editor\.gitOverlayStepCommitTitle/);
	assert.match(markup, /<select[^>]*disabled/);
	assert.match(markup, /<textarea[^>]*disabled[^>]*placeholder="editor\.gitOverlayCommitPlaceholder"/);
	assert.match(markup, /<button[^>]*disabled=""[^>]*><span[^>]*><span>editor\.gitOverlayCommitProject<\/span><\/span><\/button>/);
	assert.match(markup, /<button[^>]*disabled=""[^>]*><span[^>]*><span>editor\.gitOverlayDone<\/span><\/span><\/button>/);
	assert.match(markup, /<button[^>]*disabled=""[^>]*><span[^>]*><span>editor\.gitOverlaySwitchAll<\/span><\/span><\/button>/);
});

test('GitOverlay keeps commit warning without applying error textarea styling', () => {
	const markup = renderToStaticMarkup(React.createElement(GitOverlay, {
		open: true,
		mode: 'default',
		snapshot: {
			generatedAt: '2026-04-02T00:00:00.000Z',
			promptBranch: 'feature/task-42',
			trackedBranches: ['main'],
			projects: [
				{
					project: 'tracked-dirty',
					repositoryPath: '/tmp/tracked',
					available: true,
					error: '',
					currentBranch: 'feature/task-42',
					promptBranch: 'feature/task-42',
					dirty: true,
					hasConflicts: false,
					upstream: 'origin/feature/task-42',
					ahead: 0,
					behind: 0,
					lastCommit: null,
					branches: [],
					cleanupBranches: [],
					changeGroups: {
						merge: [],
						staged: [
							{
								project: 'tracked-dirty',
								path: 'src/index.ts',
								status: 'M',
								previousPath: '',
								group: 'staged',
								conflicted: false,
								staged: true,
								isBinary: false,
								additions: 1,
								deletions: 0,
								fileSizeBytes: 100,
							},
						],
						workingTree: [],
						untracked: [],
					},
					review: {
						remote: null,
						request: null,
						error: '',
						setupAction: null,
					},
					recentCommits: [],
					staleLocalBranches: [],
					graph: {
						nodes: [],
						edges: [],
					},
				},
			],
		},
		commitMessages: {
			'tracked-dirty': '',
		},
		busyAction: null,
		completedActions: { push: false, 'review-request': false, merge: false },
		promptStatus: 'completed',
		promptTitle: '',
		promptTaskNumber: '',
		preferredTrackedBranch: 'main',
		onClose: () => { },
		onDone: () => { },
		onRefresh: () => { },
		onSwitchBranch: () => { },
		onEnsurePromptBranch: () => { },
		onPush: () => { },
		onCreateReviewRequest: () => { },
		onMergePromptBranch: () => { },
		onDiscardFile: () => { },
		onOpenFile: () => { },
		onOpenDiff: () => { },
		onOpenReviewRequest: () => { },
		onSetupReviewCli: () => { },
		onOpenMergeEditor: () => { },
		onGenerateCommitMessage: () => { },
		onCommitStaged: () => { },
		onCommitMessageChange: () => { },
		onTrackedBranchChange: () => { },
		onContinueStartChat: () => { },
		onContinueOpenChat: () => { },
		t: (key: string) => key,
	}));

	assert.match(markup, /editor\.gitOverlayCommitMessageRequired/);
	assert.doesNotMatch(markup, /<textarea[^>]*style="[^"]*var\(--vscode-inputValidation-errorBackground/);
	assert.doesNotMatch(markup, /<textarea[^>]*style="[^"]*var\(--vscode-inputValidation-errorBorder/);
});

test('resolveChangeDiffStats hides zero additions and deletions and preserves special states', () => {
	assert.deepEqual(
		resolveChangeDiffStats({ conflicted: false, isBinary: false, additions: 0, deletions: 1 }),
		{ kind: 'diff', additions: 0, deletions: 1, specialLabel: null },
	);
	assert.deepEqual(
		resolveChangeDiffStats({ conflicted: false, isBinary: false, additions: 3, deletions: 0 }),
		{ kind: 'diff', additions: 3, deletions: 0, specialLabel: null },
	);
	assert.deepEqual(
		resolveChangeDiffStats({ conflicted: true, isBinary: false, additions: 3, deletions: 1 }),
		{ kind: 'special', additions: 0, deletions: 0, specialLabel: 'conflict' },
	);
	assert.deepEqual(
		resolveChangeDiffStats({ conflicted: false, isBinary: true, additions: 3, deletions: 1 }),
		{ kind: 'special', additions: 0, deletions: 0, specialLabel: 'binary' },
	);
});

test('normalizeCommitMessageGenerationInstructions supports strings, arrays and invalid values', () => {
	assert.equal(normalizeCommitMessageGenerationInstructions('  imperative mood  '), 'imperative mood');
	assert.equal(
		normalizeCommitMessageGenerationInstructions([' keep subject short ', '', 'mention ticket when useful']),
		'keep subject short\nmention ticket when useful',
	);
	assert.equal(normalizeCommitMessageGenerationInstructions({ custom: true }), '');
});

test('buildGitOverlayGraph creates prompt, tracked and upstream relationships without duplicate nodes', () => {
	const graph = buildGitOverlayGraph({
		branchNames: ['main', 'develop', 'feature/task-42', 'feature/task-42'],
		trackedBranches: ['main', 'develop'],
		promptBranch: 'feature/task-42',
		currentBranch: 'feature/task-42',
		currentUpstream: 'origin/feature/task-42',
	});

	const nodeIds = graph.nodes.map(node => `${node.id}:${node.kind}:${node.current ? 'current' : 'idle'}`);
	const edgeIds = graph.edges.map(edge => `${edge.from}->${edge.to}:${edge.kind}`);

	assert.deepEqual(nodeIds, [
		'main:tracked:idle',
		'develop:tracked:idle',
		'feature/task-42:current:current',
		'origin/feature/task-42:remote:idle',
	]);
	assert.deepEqual(edgeIds, [
		'feature/task-42->main:prompt-base',
		'main->feature/task-42:tracked',
		'feature/task-42->develop:prompt-base',
		'develop->feature/task-42:tracked',
		'feature/task-42->origin/feature/task-42:current-upstream',
	]);
});

test('parseGitOverlayRemoteUrl detects GitHub and GitLab remotes', () => {
	assert.deepEqual(parseGitOverlayRemoteUrl('https://github.com/acme/toolbox.git'), {
		provider: 'github',
		host: 'github.com',
		repositoryPath: 'acme/toolbox',
		owner: 'acme',
		name: 'toolbox',
		supported: true,
		cliCommand: 'gh',
		actionLabel: 'Pull request',
	});
	assert.deepEqual(parseGitOverlayRemoteUrl('git@gitlab.example.com:group/subgroup/toolbox.git'), {
		provider: 'gitlab',
		host: 'gitlab.example.com',
		repositoryPath: 'group/subgroup/toolbox',
		owner: 'group',
		name: 'toolbox',
		supported: true,
		cliCommand: 'glab',
		actionLabel: 'Merge request',
	});
});

test('normalizeGitOverlayReviewRequestState maps open, closed and merged states', () => {
	assert.equal(normalizeGitOverlayReviewRequestState({ state: 'OPEN' }), 'open');
	assert.equal(normalizeGitOverlayReviewRequestState({ state: 'closed' }), 'closed');
	assert.equal(normalizeGitOverlayReviewRequestState({ state: 'merged' }), 'accepted');
	assert.equal(normalizeGitOverlayReviewRequestState({ state: 'closed', mergedAt: '2026-04-02T00:00:00.000Z' }), 'accepted');
});

test('buildGitOverlayReviewRequestTitle includes task number and project name when needed', () => {
	assert.equal(buildGitOverlayReviewRequestTitle({
		promptTitle: 'Размер файла и количество изменений',
		taskNumber: '53',
		projectName: 'prompt-manager',
		projectCount: 2,
	}), '53 Размер файла и количество изменений [prompt-manager]');
	assert.equal(buildGitOverlayReviewRequestTitle({
		promptTitle: '',
		projectName: 'prompt-manager',
		projectCount: 1,
	}), 'prompt-manager');
	const truncatedTitle = buildGitOverlayReviewRequestTitle({
		promptTitle: 'A'.repeat(250),
		taskNumber: '53',
	});
	assert.equal(truncatedTitle.startsWith('53'), true);
	assert.equal(truncatedTitle.endsWith('…'), true);
	assert.equal(truncatedTitle.length <= 180, true);
});

test('buildGitOverlayReviewCliSetupCommand prepares Linux gh install and auth flow', () => {
	const command = buildGitOverlayReviewCliSetupCommand({
		platform: 'linux',
		cliCommand: 'gh',
		host: 'github.com',
		action: 'install-and-auth',
	});

	assert.equal(command.terminalName, 'Prompt Manager gh');
	assert.equal(command.manualUrl, 'https://cli.github.com/');
	assert.match(command.command, /apt-get install -y gh/);
	assert.match(command.command, /gh auth login --hostname 'github\.com' --web/);
	assert.doesNotMatch(command.command, /\t/);
});

test('buildGitOverlayReviewCliSetupCommand prepares auth-only flow for GitLab', () => {
	const command = buildGitOverlayReviewCliSetupCommand({
		platform: 'linux',
		cliCommand: 'glab',
		host: 'gitlab.example.com',
		action: 'auth',
	});

	assert.equal(command.manualUrl, 'https://docs.gitlab.com/cli/');
	assert.doesNotMatch(command.command, /Installing glab/);
	assert.match(command.command, /glab auth login --hostname 'gitlab\.example\.com'/);
});

test('buildGitOverlayReviewCliSetupCommand prepares Windows winget flow', () => {
	const command = buildGitOverlayReviewCliSetupCommand({
		platform: 'win32',
		cliCommand: 'glab',
		host: 'gitlab.com',
		action: 'install-and-auth',
	});

	assert.match(command.command, /winget install -e --id GLab\.GLab/);
	assert.match(command.command, /glab auth login --hostname 'gitlab\.com'/);
	assert.doesNotMatch(command.command, /\t/);
});

test('GitOverlay shows changed projects outside selected prompt projects in a separate step 1 block', () => {
	const markup = renderGitOverlayMarkup({
		selectedProjects: ['selected-clean'],
		onUpdateProjects: () => { },
		snapshot: createTestSnapshot({
			promptBranch: 'feature/task-42',
			trackedBranches: ['main'],
			projects: [
				createTestProject({
					project: 'selected-clean',
					currentBranch: 'feature/task-42',
				}),
				createTestProject({
					project: 'docs-dirty',
					currentBranch: 'feature/task-42',
					dirty: true,
					changeGroups: {
						staged: [createTestChange({ project: 'docs-dirty', path: 'README.md' })],
					},
				}),
			],
		}),
	});

	assert.match(markup, /editor\.gitOverlayProjects: 1/);
	assert.match(markup, /editor\.gitOverlayOtherProjectsTitle/);
	assert.match(markup, /docs-dirty/);
	assert.match(markup, /editor\.gitOverlayAddProject/);
	assert.match(markup, /editor\.gitOverlayShowChanges/);
});

test('GitOverlay shows exclude action instead of inactive switch for clean selected projects without step 1 work', () => {
	const markup = renderGitOverlayMarkup({
		selectedProjects: ['selected-clean'],
		onUpdateProjects: () => { },
		snapshot: createTestSnapshot({
			promptBranch: 'feature/task-42',
			trackedBranches: ['main'],
			projects: [
				createTestProject({
					project: 'selected-clean',
					currentBranch: 'feature/task-42',
				}),
			],
		}),
	});

	assert.match(markup, /editor\.gitOverlayExcludeProject/);
	assert.doesNotMatch(markup, /<button[^>]*disabled[^>]*><span[^>]*><span>editor\.gitOverlaySwitch<\/span><\/span><\/button>/);
});