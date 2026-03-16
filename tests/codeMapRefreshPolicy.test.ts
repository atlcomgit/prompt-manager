import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCodeMapGenerationFingerprint, getStoredInstructionSnapshotToken, isInstructionFreshForResolution, resolveInstructionSnapshotToken } from '../src/codemap/codeMapRefreshPolicy.js';

test('resolveInstructionSnapshotToken prefers tree sha and falls back to commit sha', () => {
	assert.equal(resolveInstructionSnapshotToken({
		resolvedSourceSnapshotToken: '',
		currentSourceSnapshotToken: '',
		resolvedTreeSha: 'tree-base',
		currentTreeSha: 'tree-current',
		resolvedHeadSha: 'head-base',
		currentHeadSha: 'head-current',
	}, 'base'), 'tree-base');
	assert.equal(resolveInstructionSnapshotToken({
		resolvedTreeSha: '',
		currentTreeSha: '',
		resolvedHeadSha: 'head-base',
		currentHeadSha: 'head-current',
	}, 'delta'), 'head-current');
});

test('resolveInstructionSnapshotToken prefers source snapshot token over tree sha', () => {
	assert.equal(resolveInstructionSnapshotToken({
		resolvedSourceSnapshotToken: 'filtered-base',
		currentSourceSnapshotToken: 'filtered-current',
		resolvedTreeSha: 'tree-base',
		currentTreeSha: 'tree-current',
		resolvedHeadSha: 'head-base',
		currentHeadSha: 'head-current',
	}, 'base'), 'filtered-base');
	assert.equal(resolveInstructionSnapshotToken({
		resolvedSourceSnapshotToken: 'filtered-base',
		currentSourceSnapshotToken: 'filtered-current',
		resolvedTreeSha: 'tree-base',
		currentTreeSha: 'tree-current',
		resolvedHeadSha: 'head-base',
		currentHeadSha: 'head-current',
	}, 'delta'), 'filtered-current');
});

test('getStoredInstructionSnapshotToken prefers metadata snapshot token', () => {
	assert.equal(getStoredInstructionSnapshotToken({
		sourceCommitSha: 'head-123',
		metadata: { sourceSnapshotToken: 'tree-123' },
	} as never), 'tree-123');
	assert.equal(getStoredInstructionSnapshotToken({
		sourceCommitSha: 'head-123',
		metadata: {},
	} as never), 'head-123');
});

test('isInstructionFreshForResolution detects stale snapshot token', () => {
	const fresh = isInstructionFreshForResolution({
		instruction: {
			sourceCommitSha: 'head-123',
			metadata: {
				sourceSnapshotToken: 'tree-123',
				generationFingerprint: buildCodeMapGenerationFingerprint({
					blockDescriptionMode: 'medium',
					blockMaxChars: 2000,
				}),
			},
		} as never,
		resolution: {
			resolvedTreeSha: 'tree-123',
			currentTreeSha: 'tree-123',
			resolvedHeadSha: 'head-123',
			currentHeadSha: 'head-123',
		},
		instructionKind: 'base',
		settings: {
			blockDescriptionMode: 'medium',
			blockMaxChars: 2000,
		},
	});
	const stale = isInstructionFreshForResolution({
		instruction: {
			sourceCommitSha: 'head-123',
			metadata: {
				sourceSnapshotToken: 'tree-old',
				generationFingerprint: buildCodeMapGenerationFingerprint({
					blockDescriptionMode: 'medium',
					blockMaxChars: 2000,
				}),
			},
		} as never,
		resolution: {
			resolvedTreeSha: 'tree-new',
			currentTreeSha: 'tree-new',
			resolvedHeadSha: 'head-123',
			currentHeadSha: 'head-123',
		},
		instructionKind: 'base',
		settings: {
			blockDescriptionMode: 'medium',
			blockMaxChars: 2000,
		},
	});

	assert.equal(fresh, true);
	assert.equal(stale, false);
});

test('isInstructionFreshForResolution detects generation fingerprint mismatch when metadata is available', () => {
	const fresh = isInstructionFreshForResolution({
		instruction: {
			sourceCommitSha: 'head-123',
			metadata: {
				sourceSnapshotToken: 'tree-123',
				generationFingerprint: buildCodeMapGenerationFingerprint({
					blockDescriptionMode: 'medium',
					blockMaxChars: 2000,
				}),
			},
		} as never,
		resolution: {
			resolvedTreeSha: 'tree-123',
			currentTreeSha: 'tree-123',
			resolvedHeadSha: 'head-123',
			currentHeadSha: 'head-123',
		},
		instructionKind: 'base',
		settings: {
			blockDescriptionMode: 'medium',
			blockMaxChars: 2000,
		},
	});
	const stale = isInstructionFreshForResolution({
		instruction: {
			sourceCommitSha: 'head-123',
			metadata: {
				sourceSnapshotToken: 'tree-123',
				generationFingerprint: buildCodeMapGenerationFingerprint({
					blockDescriptionMode: 'short',
					blockMaxChars: 1200,
				}),
			},
		} as never,
		resolution: {
			resolvedTreeSha: 'tree-123',
			currentTreeSha: 'tree-123',
			resolvedHeadSha: 'head-123',
			currentHeadSha: 'head-123',
		},
		instructionKind: 'base',
		settings: {
			blockDescriptionMode: 'medium',
			blockMaxChars: 2000,
		},
	});

	assert.equal(fresh, true);
	assert.equal(stale, false);
});

test('isInstructionFreshForResolution keeps legacy instructions fresh when head still matches and fingerprint is missing', () => {
	const fresh = isInstructionFreshForResolution({
		instruction: {
			sourceCommitSha: 'head-123',
			metadata: {},
		} as never,
		resolution: {
			resolvedTreeSha: 'tree-123',
			currentTreeSha: 'tree-123',
			resolvedHeadSha: 'head-123',
			currentHeadSha: 'head-123',
		},
		instructionKind: 'base',
		settings: {
			blockDescriptionMode: 'medium',
			blockMaxChars: 2000,
		},
	});

	assert.equal(fresh, true);
});
