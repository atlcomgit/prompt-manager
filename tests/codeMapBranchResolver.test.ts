import test from 'node:test';
import assert from 'node:assert/strict';

import { CodeMapBranchResolverService } from '../src/codemap/codeMapBranchResolverService.js';

class TestCodeMapBranchResolverService extends CodeMapBranchResolverService {
	constructor(
		private readonly headByRef: Map<string, string>,
		private readonly treeByRef: Map<string, string> = new Map(),
	) {
		super({} as never);
	}

	async getHeadSha(projectPath: string, ref: string): Promise<string> {
		return this.headByRef.get(`${projectPath}::${ref}`) || '';
	}

	async getTreeSha(projectPath: string, ref: string): Promise<string> {
		return this.treeByRef.get(`${projectPath}::${ref}`) || '';
	}
}

test('resolveTrackedBranchSnapshots skips tracked branches that do not exist in a repository', async () => {
	const service = new TestCodeMapBranchResolverService(new Map([
		['/repo-a::main', 'aaa111'],
		['/repo-a::develop', ''],
		['/repo-b::main', 'bbb222'],
		['/repo-b::develop', 'bbb333'],
	]), new Map([
		['/repo-a::main', 'tree-aaa111'],
		['/repo-b::main', 'tree-bbb222'],
		['/repo-b::develop', 'tree-bbb333'],
	]));

	const resolutions = await service.resolveTrackedBranchSnapshots(
		new Map([
			['repo-a', '/repo-a'],
			['repo-b', '/repo-b'],
		]),
		['main', 'develop'],
	);

	assert.deepEqual(
		resolutions.map(item => ({
			repository: item.repository,
				branch: item.resolvedBranchName,
				resolvedHeadSha: item.resolvedHeadSha,
				currentHeadSha: item.currentHeadSha,
				resolvedTreeSha: item.resolvedTreeSha,
				currentTreeSha: item.currentTreeSha,
				branchRole: item.branchRole,
			})),
		[
			{
				repository: 'repo-a',
					branch: 'main',
					resolvedHeadSha: 'aaa111',
					currentHeadSha: 'aaa111',
					resolvedTreeSha: 'tree-aaa111',
					currentTreeSha: 'tree-aaa111',
					branchRole: 'tracked',
				},
				{
					repository: 'repo-b',
					branch: 'main',
					resolvedHeadSha: 'bbb222',
					currentHeadSha: 'bbb222',
					resolvedTreeSha: 'tree-bbb222',
					currentTreeSha: 'tree-bbb222',
					branchRole: 'tracked',
				},
				{
					repository: 'repo-b',
					branch: 'develop',
					resolvedHeadSha: 'bbb333',
					currentHeadSha: 'bbb333',
					resolvedTreeSha: 'tree-bbb333',
					currentTreeSha: 'tree-bbb333',
					branchRole: 'tracked',
				},
		],
	);
});
