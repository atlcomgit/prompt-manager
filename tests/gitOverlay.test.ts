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
import { formatChangeSize, GitOverlay, resolveChangeDiffStats } from '../src/webview/editor/components/GitOverlay.js';

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

	assert.match(markup, /editor\.gitOverlaySwitchAllToPrompt/);
});

test('GitOverlay hides passive tracked projects from default flow steps and does not let them block merge', () => {
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

	assert.doesNotMatch(markup, /passive-tracked-clean/);
	assert.match(markup, /prompt-project/);
	const mergeButtonMarkup = markup.match(/<button[^>]*><span[^>]*><span>editor\.gitOverlayMergeNow<\/span><\/span><\/button>/);
	assert.ok(mergeButtonMarkup);
	assert.doesNotMatch(markup, /editor\.gitOverlayMergeNeedsPromptCheckout/);
	assert.doesNotMatch(markup, /editor\.gitOverlayReviewRequestNeedsPromptCheckout/);
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