import { execFile } from 'child_process';
import { promisify } from 'util';
import { GitService } from '../services/gitService.js';
import type { CodeMapBranchResolution } from '../types/codemap.js';
import { getCodeMapSettings } from './codeMapConfig.js';
import { applyPriorityToExecFilePromise } from '../utils/backgroundTaskPriority.js';

const execFileAsync = promisify(execFile);

export class CodeMapBranchResolverService {
	constructor(private readonly gitService: GitService) { }

	async resolveTrackedBranchSnapshots(
		projectPaths: Map<string, string>,
		trackedBranches: string[],
	): Promise<CodeMapBranchResolution[]> {
		const resolutions: CodeMapBranchResolution[] = [];

		for (const [repository, projectPath] of projectPaths.entries()) {
			for (const branchName of trackedBranches) {
				const headSha = await this.getHeadSha(projectPath, branchName);
				if (!headSha) {
					continue;
				}
				const treeSha = await this.getTreeSha(projectPath, branchName);

				resolutions.push({
					repository,
					projectPath,
					currentBranch: branchName,
					resolvedBranchName: branchName,
					baseBranchName: branchName,
					branchRole: 'tracked',
					isTrackedBranch: true,
					hasUncommittedChanges: false,
					resolvedHeadSha: headSha,
					currentHeadSha: headSha,
					resolvedTreeSha: treeSha || headSha,
					currentTreeSha: treeSha || headSha,
				});
			}
		}

		return resolutions;
	}

	async resolveProjects(
		projectPaths: Map<string, string>,
		projectNames: string[],
		trackedBranches: string[],
	): Promise<CodeMapBranchResolution[]> {
		const effectiveProjects = projectNames.length > 0
			? projectNames
			: Array.from(projectPaths.keys());
		const resolutions: CodeMapBranchResolution[] = [];

		for (const repository of effectiveProjects) {
			const projectPath = projectPaths.get(repository);
			if (!projectPath) {
				continue;
			}

			const currentBranch = await this.gitService.getCurrentBranch(projectPath);
			if (!currentBranch) {
				continue;
			}

			const hasUncommittedChanges = (await this.gitService.hasUncommittedChanges(projectPath)).hasChanges;
			const currentHeadSha = await this.getHeadSha(projectPath, currentBranch);
			const currentTreeSha = await this.getTreeSha(projectPath, currentBranch);

			if (trackedBranches.includes(currentBranch)) {
				resolutions.push({
					repository,
					projectPath,
					currentBranch,
					resolvedBranchName: currentBranch,
					baseBranchName: currentBranch,
					branchRole: 'tracked',
					isTrackedBranch: true,
					hasUncommittedChanges,
					resolvedHeadSha: currentHeadSha,
					currentHeadSha,
					resolvedTreeSha: currentTreeSha || currentHeadSha,
					currentTreeSha: currentTreeSha || currentHeadSha,
				});
				continue;
			}

			const baseBranchName = await this.findNearestTrackedBranch(projectPath, currentBranch, trackedBranches);
			const resolvedBranchName = baseBranchName || currentBranch;
			const resolvedHeadSha = await this.getHeadSha(projectPath, resolvedBranchName);
			const resolvedTreeSha = await this.getTreeSha(projectPath, resolvedBranchName);

			resolutions.push({
				repository,
				projectPath,
				currentBranch,
				resolvedBranchName,
				baseBranchName: resolvedBranchName,
				branchRole: baseBranchName ? 'resolved-base' : 'current',
				isTrackedBranch: false,
				hasUncommittedChanges,
				resolvedHeadSha,
				currentHeadSha,
				resolvedTreeSha: resolvedTreeSha || resolvedHeadSha,
				currentTreeSha: currentTreeSha || currentHeadSha,
			});
		}

		return resolutions;
	}

	async getHeadSha(projectPath: string, ref: string): Promise<string> {
		try {
			const task = execFileAsync('git', ['rev-parse', ref], { cwd: projectPath });
			const { stdout } = await applyPriorityToExecFilePromise(task, getCodeMapSettings().updatePriority);
			return stdout.trim();
		} catch {
			return '';
		}
	}

	async getTreeSha(projectPath: string, ref: string): Promise<string> {
		try {
			const task = execFileAsync('git', ['rev-parse', `${ref}^{tree}`], { cwd: projectPath });
			const { stdout } = await applyPriorityToExecFilePromise(task, getCodeMapSettings().updatePriority);
			return stdout.trim();
		} catch {
			return '';
		}
	}

	async findNearestTrackedBranch(projectPath: string, currentBranch: string, trackedBranches: string[]): Promise<string> {
		return this.findNearestReusableTrackedBranch(projectPath, currentBranch, trackedBranches);
	}

	async findNearestReusableTrackedBranch(
		projectPath: string,
		currentBranch: string,
		trackedBranches: string[],
		excludeBranch = '',
	): Promise<string> {
		const candidates: Array<{ branch: string; distance: number; totalDistance: number }> = [];

		for (const branch of trackedBranches) {
			if (!branch || branch === currentBranch || (excludeBranch && branch === excludeBranch)) {
				continue;
			}

			const exists = await this.branchExists(projectPath, branch);
			if (!exists) {
				continue;
			}

			const mergeBase = await this.getMergeBase(projectPath, currentBranch, branch);
			if (!mergeBase) {
				continue;
			}

			const distance = await this.getRevisionCount(projectPath, `${mergeBase}..${currentBranch}`);
			const totalDistance = distance + await this.getRevisionCount(projectPath, `${mergeBase}..${branch}`);

			candidates.push({ branch, distance, totalDistance });
		}

		candidates.sort((left, right) => {
			if (left.distance !== right.distance) {
				return left.distance - right.distance;
			}

			return left.totalDistance - right.totalDistance;
		});

		return candidates[0]?.branch || '';
	}

	private async branchExists(projectPath: string, branch: string): Promise<boolean> {
		try {
			const task = execFileAsync('git', ['rev-parse', '--verify', branch], { cwd: projectPath });
			await applyPriorityToExecFilePromise(task, getCodeMapSettings().updatePriority);
			return true;
		} catch {
			return false;
		}
	}

	private async getMergeBase(projectPath: string, left: string, right: string): Promise<string> {
		return this.gitService.getMergeBase(projectPath, left, right);
	}

	private async getRevisionCount(projectPath: string, revisionRange: string): Promise<number> {
		return this.gitService.getRevisionCount(projectPath, revisionRange);
	}
}
