import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCodeMapChatInstructions } from '../src/codemap/codeMapMaterializerService.js';
import type { CodeMapMaterializationTarget } from '../src/types/codemap.js';

function createTarget(overrides: Partial<CodeMapMaterializationTarget> = {}): CodeMapMaterializationTarget {
	return {
		resolution: {
			repository: 'prompt-manager',
			projectPath: '/workspace/prompt-manager',
			currentBranch: 'feature/test',
			resolvedBranchName: 'main',
			baseBranchName: 'main',
			branchRole: 'resolved-base',
			isTrackedBranch: false,
			hasUncommittedChanges: true,
			resolvedHeadSha: 'resolved-sha',
			currentHeadSha: 'current-sha',
		},
		baseInstruction: {
			id: 1,
			repository: 'prompt-manager',
			branchName: 'main',
			resolvedBranchName: 'main',
			baseBranchName: 'main',
			branchRole: 'tracked',
			instructionKind: 'base',
			locale: 'ru',
			aiModel: 'gpt-4o',
			content: '# Base instruction',
			contentHash: 'hash1',
			uncompressedSize: 10,
			compressedSize: 8,
			fileCount: 1,
			sourceCommitSha: 'resolved-sha',
			generatedAt: '2026-03-14T00:00:00.000Z',
			updatedAt: '2026-03-14T00:00:00.000Z',
			metadata: {},
			versionCount: 1,
		},
		currentInstruction: null,
		uncommittedSummary: '{"projects":[]}',
		queuedBaseRefresh: false,
		queuedCurrentRefresh: true,
		...overrides,
	};
}

test('buildCodeMapChatInstructions renders stored base instructions and queued current refresh state', () => {
	const output = buildCodeMapChatInstructions({
		generatedAt: '2026-03-14T00:00:00.000Z',
		locale: 'ru',
		targets: [createTarget()],
	});

	assert.match(output, /Code Map инструкции/);
	assert.match(output, /### Base instruction/);
	assert.match(output, /feature\/test: обновление поставлено в очередь/);
	assert.match(output, /Незакомиченные изменения/);
	assert.doesNotMatch(output, /applyTo:/);
});

test('buildCodeMapChatInstructions renders missing placeholder for absent instructions', () => {
	const output = buildCodeMapChatInstructions({
		generatedAt: '2026-03-14T00:00:00.000Z',
		locale: 'en',
		targets: [createTarget({ baseInstruction: null, queuedBaseRefresh: true, uncommittedSummary: '' })],
	});

	assert.match(output, /Instruction not ready yet/);
	assert.match(output, /refresh queued/);
	assert.doesNotMatch(output, /Uncommitted changes/);
	assert.doesNotMatch(output, /applyTo:/);
});

test('buildCodeMapChatInstructions includes focused usage rules in purpose section', () => {
	const output = buildCodeMapChatInstructions({
		generatedAt: '2026-03-14T00:00:00.000Z',
		locale: 'ru',
		targets: [createTarget()],
	});

	assert.match(output, /НЕ анализируй весь файл целиком\./);
	assert.match(output, /Используй только релевантные части\./);
	assert.match(output, /По возможности используй grep по файлу\./);
	assert.match(output, /Не зацикливайся на этом файле и обращайся к нему точечно\./);
	assert.match(output, /Не держи в памяти целиком данный файл\./);
	assert.doesNotMatch(output, /applyTo:/);
});

test('buildCodeMapChatInstructions rebases embedded headings under project and delta sections', () => {
	const output = buildCodeMapChatInstructions({
		generatedAt: '2026-03-14T00:00:00.000Z',
		locale: 'ru',
		targets: [createTarget({
			baseInstruction: {
				...createTarget().baseInstruction!,
				content: '# Base instruction\n\n## Overview\n\n### Details',
			},
			currentInstruction: {
				...createTarget().baseInstruction!,
				instructionKind: 'delta',
				branchName: 'feature/test',
				resolvedBranchName: 'main',
				baseBranchName: 'main',
				content: '# Delta instruction\n\n## Changes',
			},
			queuedCurrentRefresh: false,
			uncommittedSummary: '',
		})],
	});

	assert.match(output, /\n### Base instruction\n/);
	assert.match(output, /\n#### Overview\n/);
	assert.match(output, /\n##### Details\n/);
	assert.match(output, /\n### Delta текущей ветки относительно tracked-базы\n/);
	assert.match(output, /\n#### Delta instruction\n/);
	assert.match(output, /\n##### Changes$/);
	assert.doesNotMatch(output, /\n# Base instruction\n/);
	assert.doesNotMatch(output, /\n# Delta instruction\n/);
});