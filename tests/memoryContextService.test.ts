import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const originalLoad = (Module as any)._load;

function createVsCodeMock() {
	return {
		env: { language: 'en' },
	};
}

let memoryContextModulePromise: Promise<typeof import('../src/services/memoryContextService.js')> | null = null;

async function importMemoryContextService() {
	if (!memoryContextModulePromise) {
		(Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
			if (request === 'vscode') {
				return createVsCodeMock();
			}
			return originalLoad.call(this, request, parent, isMain);
		};
		memoryContextModulePromise = import('../src/services/memoryContextService.js');
	}

	try {
		return await memoryContextModulePromise;
	} finally {
		(Module as any)._load = originalLoad;
	}
}

function createCommit(overrides: Partial<{ sha: string; repository: string; message: string; branch: string }> = {}) {
	return {
		sha: overrides.sha || 'aaa1111',
		author: 'Alek',
		email: 'alek@example.com',
		date: '2026-04-20T10:00:00.000Z',
		branch: overrides.branch || 'main',
		repository: overrides.repository || 'repo-a',
		parentSha: 'parent',
		commitType: 'feat' as const,
		message: overrides.message || 'repo-a router change',
	};
}

function createAnalysis(commitSha: string, summary: string) {
	return {
		commitSha,
		summary,
		keyInsights: [],
		components: [],
		categories: [],
		keywords: [],
		architectureImpact: '',
		architectureImpactScore: 0,
		layers: [],
		businessDomains: [],
		isBreakingChange: false,
		createdAt: '2026-04-20T10:00:00.000Z',
	};
}

test('MemoryContextService filters long-term summaries and keyword results by selected projects', async () => {
	const { MemoryContextService } = await importMemoryContextService();
	const repoACommit = createCommit({ sha: 'aaa1111', repository: 'repo-a', message: 'repo-a router change' });
	const repoBCommit = createCommit({ sha: 'bbb2222', repository: 'repo-b', message: 'repo-b sidebar change' });
	const analyses = new Map([
		[repoACommit.sha, createAnalysis(repoACommit.sha, 'repo-a summary')],
		[repoBCommit.sha, createAnalysis(repoBCommit.sha, 'repo-b summary')],
	]);

	const db = {
		getSummaries: (_scope: string, repository: string) => repository === 'repo-a'
			? [{
				scope: 'project',
				period: 'repo-a',
				repository: 'repo-a',
				summary: 'repo-a architecture',
				commitCount: 3,
				createdAt: '2026-04-20T10:00:00.000Z',
				updatedAt: '2026-04-20T10:00:00.000Z',
			}]
			: repository === 'repo-b'
				? [{
					scope: 'project',
					period: 'repo-b',
					repository: 'repo-b',
					summary: 'repo-b architecture',
					commitCount: 4,
					createdAt: '2026-04-19T10:00:00.000Z',
					updatedAt: '2026-04-19T10:00:00.000Z',
				}]
				: [],
		searchByKeyword: (_query: string, _limit: number, repositories: string[] = []) => {
			const allowedRepositories = repositories.length > 0 ? repositories : ['repo-a', 'repo-b'];
			return [repoACommit, repoBCommit].filter(commit => allowedRepositories.includes(commit.repository));
		},
		getAnalysis: (commitSha: string) => analyses.get(commitSha) || null,
		getRepositories: () => ['repo-a', 'repo-b'],
		getAllEmbeddings: () => [],
		getCommits: () => ({ commits: [], total: 0 }),
		getCommit: () => null,
	} as any;
	const embedding = {
		isReady: () => false,
	} as any;
	const projectStructureMapService = {
		buildProjectStructureMap: async () => null,
	} as any;

	const service = new MemoryContextService(db, embedding, projectStructureMapService);
	const { context } = await service.getContextForChat('router', {
		projectNames: ['repo-a'],
		useSemantic: false,
		shortTermLimit: 10,
	});

	assert.match(context, /\*\*repo-a\*\*/);
	assert.doesNotMatch(context, /\*\*repo-b\*\*/);
	assert.match(context, /repo-a router change/);
	assert.doesNotMatch(context, /repo-b sidebar change/);
	assert.doesNotMatch(context, /repo-b architecture/);
});

test('MemoryContextService filters semantic results by selected projects', async () => {
	const { MemoryContextService } = await importMemoryContextService();
	const repoACommit = createCommit({ sha: 'aaa1111', repository: 'repo-a', message: 'repo-a semantic match' });
	const repoBCommit = createCommit({ sha: 'bbb2222', repository: 'repo-b', message: 'repo-b semantic match' });
	const analyses = new Map([
		[repoACommit.sha, createAnalysis(repoACommit.sha, 'repo-a semantic summary')],
		[repoBCommit.sha, createAnalysis(repoBCommit.sha, 'repo-b semantic summary')],
	]);

	const db = {
		getSummaries: () => [],
		searchByKeyword: () => [],
		getAnalysis: (commitSha: string) => analyses.get(commitSha) || null,
		getRepositories: () => ['repo-a', 'repo-b'],
		getAllEmbeddings: () => [
			{ commitSha: repoACommit.sha, vector: new Float32Array([1, 0]), text: 'repo-a semantic match' },
			{ commitSha: repoBCommit.sha, vector: new Float32Array([0, 1]), text: 'repo-b semantic match' },
		],
		getCommits: () => ({ commits: [], total: 0 }),
		getCommit: (commitSha: string) => commitSha === repoACommit.sha ? repoACommit : repoBCommit,
	} as any;
	const embedding = {
		isReady: () => true,
		generateEmbedding: async () => new Float32Array([1, 0]),
		semanticSearch: () => [
			{ commitSha: repoBCommit.sha, score: 0.99 },
			{ commitSha: repoACommit.sha, score: 0.95 },
		],
	} as any;
	const projectStructureMapService = {
		buildProjectStructureMap: async () => null,
	} as any;

	const service = new MemoryContextService(db, embedding, projectStructureMapService);
	const { context } = await service.getContextForChat('semantic', {
		projectNames: ['repo-a'],
		includeLongTerm: false,
		shortTermLimit: 10,
	});

	assert.match(context, /repo-a semantic match/);
	assert.doesNotMatch(context, /repo-b semantic match/);
});