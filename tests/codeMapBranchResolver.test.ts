import test from 'node:test';
import assert from 'node:assert/strict';

import { CodeMapBranchResolverService } from '../src/codemap/codeMapBranchResolverService.js';

class TestCodeMapBranchResolverService extends CodeMapBranchResolverService {
	constructor(private readonly headByRef: Map<string, string>) {
		super({} as never);
	}

	async getHeadSha(projectPath: string, ref: string): Promise<string> {
		return this.headByRef.get(`${projectPath}::${ref}`) || '';
	}
}

test('resolveTrackedBranchSnapshots skips tracked branches that do not exist in a repository', async () => {
	const service = new TestCodeMapBranchResolverService(new Map([
		['/repo-a::main', 'aaa111'],
		['/repo-a::develop', ''],
		['/repo-b::main', 'bbb222'],
		['/repo-b::develop', 'bbb333'],
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
			branchRole: item.branchRole,
		})),
		[
			{
				repository: 'repo-a',
				branch: 'main',
				resolvedHeadSha: 'aaa111',
				currentHeadSha: 'aaa111',
				branchRole: 'tracked',
			},
			{
				repository: 'repo-b',
				branch: 'main',
				resolvedHeadSha: 'bbb222',
				currentHeadSha: 'bbb222',
				branchRole: 'tracked',
			},
			{
				repository: 'repo-b',
				branch: 'develop',
				resolvedHeadSha: 'bbb333',
				currentHeadSha: 'bbb333',
				branchRole: 'tracked',
			},
		],
	);
});
