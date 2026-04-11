import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const originalLoad = (Module as any)._load;

function createVsCodeMock() {
	return {
		workspace: {
			getConfiguration: () => ({
				get: <T>(_key: string, defaultValue?: T) => defaultValue,
			}),
		},
	};
}

async function importCodeMapAdminService() {
	(Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
		if (request === 'vscode') {
			return createVsCodeMock();
		}

		return originalLoad.call(this, request, parent, isMain);
	};

	try {
		return await import('../src/codemap/codeMapAdminService.js');
	} finally {
		(Module as any)._load = originalLoad;
	}
}

function createInstructionDetail(branchName: string) {
	return {
		instruction: {
			id: 42,
			repository: 'prompt-manager',
			branchName,
			resolvedBranchName: 'main',
			baseBranchName: 'main',
			branchRole: 'current' as const,
			instructionKind: 'delta' as const,
			locale: 'ru',
			aiModel: 'gpt-5-mini',
			content: '# Delta instruction',
			contentHash: 'hash',
			generatedAt: '2026-04-11T01:00:00.000Z',
			updatedAt: '2026-04-11T01:00:00.000Z',
			uncompressedSize: 100,
			compressedSize: 80,
			fileCount: 5,
			sourceCommitSha: 'feature-head',
			metadata: {},
			versionCount: 1,
		},
		versions: [],
		recentJobs: [],
	};
}

test('CodeMapAdminService queueRefreshInstruction resolves delta refresh against the selected branch head', async () => {
	const { CodeMapAdminService } = await importCodeMapAdminService();
	const queueCalls: Array<{ resolution: any; instructionKind: string; trigger: string; priority: string }> = [];
	const service = new CodeMapAdminService(
		{
			getWorkspaceFolderPaths: () => new Map([['prompt-manager', '/workspace/prompt-manager']]),
		} as any,
		{
			getCurrentBranch: async () => 'feature/actual-current',
			hasUncommittedChanges: async () => ({ hasChanges: false }),
		} as any,
		{
			getInstructionDetail: () => createInstructionDetail('feature/selected-delta'),
		} as any,
		{
			getHeadSha: async (_projectPath: string, ref: string) => ({
				'feature/actual-current': 'sha-actual-current',
				'feature/selected-delta': 'sha-selected-delta',
				main: 'sha-main',
			}[ref] || ''),
			getTreeSha: async (_projectPath: string, ref: string) => ({
				'feature/actual-current': 'tree-actual-current',
				'feature/selected-delta': 'tree-selected-delta',
				main: 'tree-main',
			}[ref] || ''),
		} as any,
		{
			queueInstruction: (resolution: any, instructionKind: string, trigger: string, priority: string) => {
				queueCalls.push({ resolution, instructionKind, trigger, priority });
				return true;
			},
			getRuntimeState: () => ({
				pendingCount: 0,
				queuedCount: 0,
				runningCount: 0,
				isProcessing: false,
				queuedTasks: [],
				scheduledRealtimeRefreshes: [],
				recentEvents: [],
				cycle: { queuedTotal: 0, startedTotal: 0, completedTotal: 0, failedTotal: 0 },
			}),
		} as any,
	);

	const queued = await service.queueRefreshInstruction(42);

	assert.equal(queued, true);
	assert.equal(queueCalls.length, 1);
	assert.equal(queueCalls[0]?.resolution.currentBranch, 'feature/selected-delta');
	assert.equal(queueCalls[0]?.resolution.currentHeadSha, 'sha-selected-delta');
	assert.equal(queueCalls[0]?.resolution.currentTreeSha, 'tree-selected-delta');
	assert.equal(queueCalls[0]?.resolution.resolvedBranchName, 'main');
	assert.equal(queueCalls[0]?.resolution.resolvedHeadSha, 'sha-main');
	assert.equal(queueCalls[0]?.instructionKind, 'delta');
	assert.equal(queueCalls[0]?.trigger, 'manual');
});

test('CodeMapAdminService queueRefreshInstruction returns false when the selected delta branch no longer exists', async () => {
	const { CodeMapAdminService } = await importCodeMapAdminService();
	let queueCalled = false;
	const service = new CodeMapAdminService(
		{
			getWorkspaceFolderPaths: () => new Map([['prompt-manager', '/workspace/prompt-manager']]),
		} as any,
		{
			getCurrentBranch: async () => 'feature/actual-current',
			hasUncommittedChanges: async () => ({ hasChanges: false }),
		} as any,
		{
			getInstructionDetail: () => createInstructionDetail('feature/missing-delta'),
		} as any,
		{
			getHeadSha: async (_projectPath: string, ref: string) => ({
				'feature/actual-current': 'sha-actual-current',
				main: 'sha-main',
			}[ref] || ''),
			getTreeSha: async (_projectPath: string, ref: string) => ({
				'feature/actual-current': 'tree-actual-current',
				main: 'tree-main',
			}[ref] || ''),
		} as any,
		{
			queueInstruction: () => {
				queueCalled = true;
				return true;
			},
			getRuntimeState: () => ({
				pendingCount: 0,
				queuedCount: 0,
				runningCount: 0,
				isProcessing: false,
				queuedTasks: [],
				scheduledRealtimeRefreshes: [],
				recentEvents: [],
				cycle: { queuedTotal: 0, startedTotal: 0, completedTotal: 0, failedTotal: 0 },
			}),
		} as any,
	);

	const queued = await service.queueRefreshInstruction(42);

	assert.equal(queued, false);
	assert.equal(queueCalled, false);
});