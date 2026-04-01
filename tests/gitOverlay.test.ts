import test from 'node:test';
import assert from 'node:assert/strict';

import {
	buildGitOverlayGraph,
	canDeleteGitOverlayBranch,
	normalizeCommitMessageGenerationInstructions,
	resolveGitOverlayBranchNames,
} from '../src/utils/gitOverlay.js';

test('resolveGitOverlayBranchNames keeps tracked order and appends prompt/current branches once', () => {
	const branches = resolveGitOverlayBranchNames(['main', 'develop', 'main'], 'feature/task-42', 'feature/task-42');

	assert.deepEqual(branches, ['main', 'develop', 'feature/task-42']);
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