import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import Module from 'node:module';
import * as os from 'os';
import * as path from 'path';

const originalLoad = (Module as any)._load;

function createVsCodeMock() {
	return {
		Uri: {
			joinPath: (base: { fsPath: string }, ...pathsToJoin: string[]) => ({
				fsPath: path.join(base.fsPath, ...pathsToJoin),
			}),
		},
		workspace: {
			getConfiguration: () => ({
				get: <T>(_key: string, defaultValue?: T) => defaultValue,
			}),
		},
	};
}

async function importCodeMapDatabaseService() {
	(Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
		if (request === 'vscode') {
			return createVsCodeMock();
		}

		return originalLoad.call(this, request, parent, isMain);
	};

	try {
		return await import('../src/codemap/codeMapDatabaseService.js');
	} finally {
		(Module as any)._load = originalLoad;
	}
}

function createInstructionRecord(locale: string, content: string, generatedAt: string) {
	return {
		repository: 'prompt-manager',
		branchName: 'main',
		resolvedBranchName: 'main',
		baseBranchName: 'main',
		branchRole: 'tracked' as const,
		instructionKind: 'base' as const,
		locale,
		aiModel: 'gpt-5-mini',
		content,
		contentHash: '',
		generatedAt,
		sourceCommitSha: `commit-${locale}-${generatedAt}`,
		fileCount: 10,
		metadata: {
			sourceSnapshotToken: `snapshot-${locale}-${generatedAt}`,
			treeSha: `tree-${locale}-${generatedAt}`,
		},
	};
}

test('CodeMapDatabaseService keeps locale-specific instructions isolated', async () => {
	const { CodeMapDatabaseService } = await importCodeMapDatabaseService();
	const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-manager-codemap-db-'));
	const service = new CodeMapDatabaseService({ fsPath: process.cwd() } as any);

	try {
		await service.initialize(workspaceRoot);

		const ruRecord = createInstructionRecord('ru', '# RU instruction', '2026-04-11T01:00:00.000Z');
		ruRecord.contentHash = service.computeContentHash(ruRecord.content);
		const enRecord = createInstructionRecord('en', '# EN instruction', '2026-04-11T02:00:00.000Z');
		enRecord.contentHash = service.computeContentHash(enRecord.content);

		service.upsertInstruction(ruRecord, 3);
		service.upsertInstruction(enRecord, 3);

		const ruInstruction = service.getLatestInstruction('prompt-manager', 'main', 'base', 'ru');
		const enInstruction = service.getLatestInstruction('prompt-manager', 'main', 'base', 'en');

		assert.equal(ruInstruction?.locale, 'ru');
		assert.equal(ruInstruction?.content, '# RU instruction');
		assert.equal(enInstruction?.locale, 'en');
		assert.equal(enInstruction?.content, '# EN instruction');
	} finally {
		service.close();
		fs.rmSync(workspaceRoot, { recursive: true, force: true });
	}
});

test('CodeMapDatabaseService upsertInstruction updates only the matching locale record', async () => {
	const { CodeMapDatabaseService } = await importCodeMapDatabaseService();
	const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-manager-codemap-db-'));
	const service = new CodeMapDatabaseService({ fsPath: process.cwd() } as any);

	try {
		await service.initialize(workspaceRoot);

		const firstRuRecord = createInstructionRecord('ru', '# RU v1', '2026-04-11T01:00:00.000Z');
		firstRuRecord.contentHash = service.computeContentHash(firstRuRecord.content);
		const firstRu = service.upsertInstruction(firstRuRecord, 3);

		const enRecord = createInstructionRecord('en', '# EN v1', '2026-04-11T01:30:00.000Z');
		enRecord.contentHash = service.computeContentHash(enRecord.content);
		const firstEn = service.upsertInstruction(enRecord, 3);

		const secondRuRecord = createInstructionRecord('ru', '# RU v2', '2026-04-11T02:00:00.000Z');
		secondRuRecord.contentHash = service.computeContentHash(secondRuRecord.content);
		const secondRu = service.upsertInstruction(secondRuRecord, 3);

		const latestRu = service.getLatestInstruction('prompt-manager', 'main', 'base', 'ru');
		const latestEn = service.getLatestInstruction('prompt-manager', 'main', 'base', 'en');

		assert.equal(secondRu.id, firstRu.id);
		assert.equal(firstEn.id, latestEn?.id);
		assert.equal(latestRu?.content, '# RU v2');
		assert.equal(latestRu?.versionCount, 2);
		assert.equal(latestEn?.content, '# EN v1');
	} finally {
		service.close();
		fs.rmSync(workspaceRoot, { recursive: true, force: true });
	}
});