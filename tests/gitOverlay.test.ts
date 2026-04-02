import test from 'node:test';
import assert from 'node:assert/strict';

import {
	collectGitOverlayStartChatBranchMismatches,
	buildGitOverlayReviewCliSetupCommand,
	buildGitOverlayReviewRequestTitle,
	buildGitOverlayGraph,
	canDeleteGitOverlayBranch,
	isGitOverlayStartChatBranchAllowed,
	normalizeGitOverlayReviewRequestState,
	normalizeCommitMessageGenerationInstructions,
	parseGitOverlayRemoteUrl,
	resolveExistingGitOverlayTrackedBranches,
	resolveGitOverlayBranchNames,
} from '../src/utils/gitOverlay.js';

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
				branches: [
					{ name: 'main', kind: 'tracked', exists: true },
					{ name: 'release', kind: 'tracked', exists: false },
				],
			},
			{
				available: true,
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
				branches: [
					{ name: 'main', kind: 'tracked', exists: true },
					{ name: 'release', kind: 'tracked', exists: false },
				],
			},
			{
				available: true,
				branches: [
					{ name: 'develop', kind: 'tracked', exists: true },
					{ name: 'main', kind: 'tracked', exists: true },
				],
			},
		],
	);

	assert.deepEqual(branches, ['main', 'develop']);
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

test('canDeleteGitOverlayBranch blocks current, prompt and tracked branches', () => {
	assert.equal(canDeleteGitOverlayBranch('feature/task-42', 'feature/task-42', ['main', 'develop'], 'feature/task-42'), false);
	assert.equal(canDeleteGitOverlayBranch('main', 'feature/task-42', ['main', 'develop'], 'feature/task-42'), false);
	assert.equal(canDeleteGitOverlayBranch('cleanup/old-branch', 'feature/task-42', ['main', 'develop'], 'feature/task-42'), true);
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