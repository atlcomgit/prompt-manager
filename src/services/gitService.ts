/**
 * Git service — branch management and status checks
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import type { CodeMapRefDiffEntry } from '../types/codemap.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface BranchInfo {
	name: string;
	current: boolean;
	project: string;
}

export interface StagedFileChange {
	status: string;
	path: string;
	previousPath?: string;
}

export interface PreparedCommitProjectData {
	project: string;
	projectPath: string;
	branch: string;
	changeSource: 'staged' | 'working-tree';
	stagedFiles: StagedFileChange[];
	stat: string;
	diff: string;
}

export interface UncommittedProjectData {
	project: string;
	projectPath: string;
	branch: string;
	stagedFiles: StagedFileChange[];
	unstagedFiles: StagedFileChange[];
	untrackedFiles: StagedFileChange[];
	stagedStat: string;
	unstagedStat: string;
	stagedDiff: string;
	unstagedDiff: string;
	untrackedDiff: string;
}

export class GitService {
	private static readonly DIFF_MAX_BUFFER = 8 * 1024 * 1024;

	private parseStagedNameStatus(raw: string): StagedFileChange[] {
		return raw
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(Boolean)
			.map((line) => {
				const parts = line.split('\t').filter(Boolean);
				const statusToken = (parts[0] || '').trim();
				const normalizedStatus = statusToken.replace(/\d+/g, '') || statusToken;

				if (normalizedStatus.startsWith('R') || normalizedStatus.startsWith('C')) {
					return {
						status: normalizedStatus.charAt(0),
						previousPath: parts[1] || '',
						path: parts[2] || parts[1] || '',
					};
				}

				return {
					status: normalizedStatus || statusToken,
					path: parts[1] || '',
				};
			})
			.filter(item => Boolean(item.path));
	}

	private async runGitFileCommand(projectPath: string, args: string[]): Promise<string> {
		const { stdout } = await execFileAsync('git', args, {
			cwd: projectPath,
			maxBuffer: GitService.DIFF_MAX_BUFFER,
		});
		return stdout.trim();
	}

	async getMergeBase(projectPath: string, left: string, right: string): Promise<string> {
		try {
			return await this.runGitFileCommand(projectPath, ['merge-base', left, right]);
		} catch {
			return '';
		}
	}

	async getRevisionCount(projectPath: string, revisionRange: string): Promise<number> {
		try {
			const stdout = await this.runGitFileCommand(projectPath, ['rev-list', '--count', revisionRange]);
			return Number.parseInt(stdout.trim(), 10) || 0;
		} catch {
			return Number.MAX_SAFE_INTEGER;
		}
	}

	async getNameStatusDiff(projectPath: string, fromRef: string, toRef: string): Promise<CodeMapRefDiffEntry[]> {
		try {
			const stdout = await this.runGitFileCommand(projectPath, ['diff', '--name-status', '--find-renames', fromRef, toRef]);
			return stdout
				.split(/\r?\n/)
				.map(line => line.trim())
				.filter(Boolean)
				.map((line) => {
					const parts = line.split('\t');
					const statusToken = String(parts[0] || '').trim();
					const normalizedStatus = (statusToken[0] || '') as CodeMapRefDiffEntry['status'];
					if ((normalizedStatus === 'R' || normalizedStatus === 'C') && parts[2]) {
						return {
							status: normalizedStatus,
							oldPath: parts[1] || '',
							path: parts[2] || '',
						};
					}
					return {
						status: normalizedStatus || 'M',
						path: parts[1] || '',
					};
				})
				.filter(entry => Boolean(entry.path));
		} catch {
			return [];
		}
	}

	async getLsTreeSnapshot(projectPath: string, ref: string): Promise<Map<string, string>> {
		try {
			const stdout = await this.runGitFileCommand(projectPath, ['ls-tree', '-r', ref]);
			const snapshot = new Map<string, string>();
			for (const line of stdout.split(/\r?\n/)) {
				const match = line.match(/^[0-9]+\s+blob\s+([0-9a-f]{40})\t(.+)$/i);
				if (!match?.[1] || !match[2]) {
					continue;
				}
				snapshot.set(match[2], match[1]);
			}
			return snapshot;
		} catch {
			return new Map();
		}
	}

	private buildUntrackedPreview(projectPath: string, relativePath: string, maxChars = 4000): Promise<string> {
		return fs.readFile(path.join(projectPath, relativePath), 'utf-8')
			.then((content) => {
				const trimmed = content.slice(0, maxChars);
				return [
					`diff --git a/${relativePath} b/${relativePath}`,
					'new file mode 100644',
					'--- /dev/null',
					`+++ b/${relativePath}`,
					trimmed
						.split(/\r?\n/)
						.map(line => `+${line}`)
						.join('\n'),
					content.length > maxChars ? '+...[file truncated]' : '',
				].filter(Boolean).join('\n');
			})
			.catch(() => `diff --git a/${relativePath} b/${relativePath}\n+++ b/${relativePath}\n+[unable to read file preview]`);
	}

	private async getUncommittedProjectSnapshot(project: string, projectPath: string): Promise<UncommittedProjectData | null> {
		const statusOutput = await this.runGitFileCommand(projectPath, ['status', '--porcelain']);
		const statusLines = statusOutput.split(/\r?\n/).filter(Boolean);
		const untrackedFiles = statusLines
			.filter(line => line.startsWith('?? '))
			.map(line => line.slice(3).trim())
			.filter(Boolean);

		const [stagedNameStatus, unstagedNameStatus] = await Promise.all([
			this.runGitFileCommand(projectPath, [
				'diff',
				'--cached',
				'--name-status',
				'--find-renames',
				'--diff-filter=ACDMR',
			]),
			this.runGitFileCommand(projectPath, [
				'diff',
				'--name-status',
				'--find-renames',
				'--diff-filter=ACDMR',
			]),
		]);

		const stagedFiles = stagedNameStatus ? this.parseStagedNameStatus(stagedNameStatus) : [];
		const unstagedFiles = unstagedNameStatus ? this.parseStagedNameStatus(unstagedNameStatus) : [];
		const untrackedChanges: StagedFileChange[] = untrackedFiles.map((filePath) => ({
			status: 'A',
			path: filePath,
		}));

		if (stagedFiles.length === 0 && unstagedFiles.length === 0 && untrackedChanges.length === 0) {
			return null;
		}

		const [stagedStat, stagedDiff, unstagedStat, unstagedDiff, branch, untrackedPreviews] = await Promise.all([
			stagedFiles.length > 0
				? this.runGitFileCommand(projectPath, [
					'diff',
					'--cached',
					'--stat',
					'--find-renames',
					'--diff-filter=ACDMR',
				])
				: Promise.resolve(''),
			stagedFiles.length > 0
				? this.runGitFileCommand(projectPath, [
					'diff',
					'--cached',
					'--no-color',
					'--no-ext-diff',
					'--find-renames',
					'--diff-filter=ACDMR',
					'--unified=3',
				])
				: Promise.resolve(''),
			unstagedFiles.length > 0
				? this.runGitFileCommand(projectPath, ['diff', '--stat'])
				: Promise.resolve(''),
			unstagedFiles.length > 0
				? this.runGitFileCommand(projectPath, ['diff', '--no-color', '--no-ext-diff', '--find-renames', '--diff-filter=ACDMR', '--unified=3'])
				: Promise.resolve(''),
			this.getCurrentBranch(projectPath),
			Promise.all(untrackedFiles.map((filePath) => this.buildUntrackedPreview(projectPath, filePath))),
		]);

		return {
			project,
			projectPath,
			branch,
			stagedFiles,
			unstagedFiles,
			untrackedFiles: untrackedChanges,
			stagedStat,
			unstagedStat,
			stagedDiff,
			unstagedDiff,
			untrackedDiff: untrackedPreviews.filter(Boolean).join('\n\n'),
		};
	}

	private async getWorkingTreeProjectData(project: string, projectPath: string): Promise<PreparedCommitProjectData | null> {
		const snapshot = await this.getUncommittedProjectSnapshot(project, projectPath);
		return this.buildWorkingTreePreparedData(snapshot);
	}

	private buildWorkingTreePreparedData(snapshot: UncommittedProjectData | null): PreparedCommitProjectData | null {
		if (!snapshot) {
			return null;
		}

		const workingTreeFiles = [...snapshot.unstagedFiles, ...snapshot.untrackedFiles];
		if (workingTreeFiles.length === 0) {
			return null;
		}

		const statParts = [snapshot.unstagedStat];
		if (snapshot.untrackedFiles.length > 0) {
			statParts.push(`Untracked files: ${snapshot.untrackedFiles.length}`);
		}

		const diffParts = [snapshot.unstagedDiff, snapshot.untrackedDiff].filter(Boolean);

		return {
			project: snapshot.project,
			projectPath: snapshot.projectPath,
			branch: snapshot.branch,
			changeSource: 'working-tree',
			stagedFiles: workingTreeFiles,
			stat: statParts.filter(Boolean).join('\n'),
			diff: diffParts.join('\n\n'),
		};
	}

	async getUncommittedProjectData(
		projectPaths: Map<string, string>,
		projectNames: string[],
	): Promise<UncommittedProjectData[]> {
		const effectiveProjects = projectNames.length > 0
			? projectNames
			: Array.from(projectPaths.keys());
		const snapshots: UncommittedProjectData[] = [];

		for (const project of effectiveProjects) {
			const projectPath = projectPaths.get(project);
			if (!projectPath) {
				continue;
			}

			try {
				const snapshot = await this.getUncommittedProjectSnapshot(project, projectPath);
				if (snapshot) {
					snapshots.push(snapshot);
				}
			} catch {
				// Ignore non-git folders and command failures for a specific project.
			}
		}

		return snapshots;
	}

	private getAllowedBaseBranches(configuredAllowedBranches?: string[]): Set<string> {
		const normalized = (configuredAllowedBranches || [])
			.map(branch => branch.trim())
			.filter(Boolean);

		if (normalized.length > 0) {
			return new Set(normalized);
		}

		return new Set(GitService.getConfiguredAllowedBranches());
	}

	/** Get current branches for specified projects */
	async getBranches(projectPaths: Map<string, string>, projectNames: string[]): Promise<BranchInfo[]> {
		const branches: BranchInfo[] = [];

		for (const project of projectNames) {
			const projectPath = projectPaths.get(project);
			if (!projectPath) { continue; }

			try {
				const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: projectPath });
				const currentBranch = stdout.trim();
				if (currentBranch) {
					branches.push({ name: currentBranch, current: true, project });
				}
			} catch {
				// Not a git repo or git not available
			}
		}

		return branches;
	}

	/** Collect staged changes prepared for commit across selected projects */
	async getPreparedCommitProjectData(
		projectPaths: Map<string, string>,
		projectNames: string[]
	): Promise<PreparedCommitProjectData[]> {
		const effectiveProjects = projectNames.length > 0
			? projectNames
			: Array.from(projectPaths.keys());
		const prepared: PreparedCommitProjectData[] = [];

		for (const project of effectiveProjects) {
			const projectPath = projectPaths.get(project);
			if (!projectPath) {
				continue;
			}

			try {
				const snapshot = await this.getUncommittedProjectSnapshot(project, projectPath);
				if (!snapshot) {
					continue;
				}

				if (snapshot.stagedFiles.length > 0) {
					prepared.push({
						project,
						projectPath,
						branch: snapshot.branch,
						changeSource: 'staged',
						stagedFiles: snapshot.stagedFiles,
						stat: snapshot.stagedStat,
						diff: snapshot.stagedDiff,
					});
					continue;
				}

				const workingTreeData = this.buildWorkingTreePreparedData(snapshot);
				if (workingTreeData) {
					prepared.push(workingTreeData);
				}
			} catch {
				// Ignore non-git folders and command failures for a specific project.
			}
		}

		return prepared;
	}

	/** Check if there are uncommitted changes */
	async hasUncommittedChanges(projectPath: string): Promise<{ hasChanges: boolean; details: string }> {
		try {
			const { stdout } = await execAsync('git status --porcelain', { cwd: projectPath });
			const hasChanges = stdout.trim().length > 0;
			return {
				hasChanges,
				details: hasChanges ? stdout.trim() : 'Working tree clean',
			};
		} catch {
			return { hasChanges: false, details: 'Not a git repository' };
		}
	}

	/** Check branch status across multiple projects */
	async checkBranchStatus(
		projectPaths: Map<string, string>,
		projectNames: string[],
		branch: string
	): Promise<{ hasChanges: boolean; details: string }> {
		const results: string[] = [];
		let hasAnyChanges = false;

		for (const project of projectNames) {
			const projectPath = projectPaths.get(project);
			if (!projectPath) { continue; }

			const { hasChanges, details } = await this.hasUncommittedChanges(projectPath);
			if (hasChanges) {
				hasAnyChanges = true;
				results.push(`${project}: ${details}`);
			}
		}

		return {
			hasChanges: hasAnyChanges,
			details: results.join('\n') || 'All projects clean',
		};
	}

	/** Switch branch in specified projects */
	async switchBranch(
		projectPaths: Map<string, string>,
		projectNames: string[],
		branch: string,
		configuredAllowedBranches?: string[],
	): Promise<{ success: boolean; errors: string[] }> {
		const errors: string[] = [];
		const targetBranch = branch.trim();
		const allowedBaseBranches = this.getAllowedBaseBranches(configuredAllowedBranches);

		if (!targetBranch) {
			return { success: false, errors: ['Название ветки пустое'] };
		}

		for (const project of projectNames) {
			const projectPath = projectPaths.get(project);
			if (!projectPath) {
				errors.push(`${project}: workspace folder not found`);
				continue;
			}

			try {
				// Check if branch exists
				const { stdout } = await execAsync(
					`git branch --list "${targetBranch}"`,
					{ cwd: projectPath }
				);

				if (!stdout.trim()) {
					const currentBranch = await this.getCurrentBranch(projectPath);
					if (!allowedBaseBranches.has(currentBranch)) {
						errors.push(
							`${project}: ветка "${targetBranch}" не существует. Создание разрешено только из ${Array.from(allowedBaseBranches).join('/')} (текущая: ${currentBranch || 'unknown'}).`
						);
						continue;
					}

					await execAsync(`git checkout -b "${targetBranch}"`, { cwd: projectPath });
				} else {
					await execAsync(`git checkout "${targetBranch}"`, { cwd: projectPath });
				}
			} catch (err: any) {
				errors.push(`${project}: ${err.message || 'Unknown error'}`);
			}
		}

		return { success: errors.length === 0, errors };
	}

	/** Get current branch name */
	async getCurrentBranch(projectPath: string): Promise<string> {
		try {
			const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: projectPath });
			return stdout.trim();
		} catch {
			return '';
		}
	}

	/** Create a new branch in specified projects */
	async createBranch(
		projectPaths: Map<string, string>,
		projectNames: string[],
		branch: string,
		configuredAllowedBranches?: string[],
	): Promise<{ success: boolean; errors: string[] }> {
		const errors: string[] = [];
		const targetBranch = branch.trim();
		const allowedBaseBranches = this.getAllowedBaseBranches(configuredAllowedBranches);

		if (!targetBranch) {
			return { success: false, errors: ['Название ветки пустое'] };
		}

		for (const project of projectNames) {
			const projectPath = projectPaths.get(project);
			if (!projectPath) {
				errors.push(`${project}: workspace folder not found`);
				continue;
			}

			try {
				const { stdout } = await execAsync(
					`git branch --list "${targetBranch}"`,
					{ cwd: projectPath }
				);

				if (stdout.trim()) {
					await execAsync(`git checkout "${targetBranch}"`, { cwd: projectPath });
					continue;
				}

				const currentBranch = await this.getCurrentBranch(projectPath);
				if (!allowedBaseBranches.has(currentBranch)) {
					errors.push(
						`${project}: ветка "${targetBranch}" не существует. Создание разрешено только из ${Array.from(allowedBaseBranches).join('/')} (текущая: ${currentBranch || 'unknown'}).`
					);
					continue;
				}

				await execAsync(`git checkout -b "${targetBranch}"`, { cwd: projectPath });
			} catch (err: any) {
				errors.push(`${project}: ${err.message || 'Unknown error'}`);
			}
		}

		return { success: errors.length === 0, errors };
	}

	/** Default branches that are considered "safe" (no warning needed) */
	static readonly DEFAULT_ALLOWED_BRANCHES = new Set(['master', 'main', 'prod', 'develop', 'dev']);

	/** Get configured allowed branches from VS Code settings with fallback to defaults */
	static getConfiguredAllowedBranches(): string[] {
		const configured = vscode.workspace
			.getConfiguration('promptManager')
			.get<unknown>('allowedBranches');

		const normalized = Array.isArray(configured)
			? configured
				.filter((item): item is string => typeof item === 'string')
				.map(item => item.trim())
				.filter(Boolean)
			: [];

		if (normalized.length > 0) {
			return normalized;
		}

		return Array.from(GitService.DEFAULT_ALLOWED_BRANCHES);
	}

	/**
	 * Check branches across projects and return mismatches.
	 * A mismatch means the current branch is NOT in the allowed set
	 * (DEFAULT_ALLOWED_BRANCHES + optional prompt branch).
	 */
	async getBranchMismatches(
		projectPaths: Map<string, string>,
		projectNames: string[],
		promptBranch?: string,
		configuredAllowedBranches?: string[],
	): Promise<Array<{ project: string; currentBranch: string }>> {
		const allowedBase = (configuredAllowedBranches || []).map(b => b.trim()).filter(Boolean);
		const allowed = new Set(allowedBase.length > 0
			? allowedBase
			: Array.from(GitService.DEFAULT_ALLOWED_BRANCHES));
		if (promptBranch?.trim()) {
			allowed.add(promptBranch.trim());
		}

		const mismatches: Array<{ project: string; currentBranch: string }> = [];

		for (const project of projectNames) {
			const projectPath = projectPaths.get(project);
			if (!projectPath) { continue; }

			const currentBranch = await this.getCurrentBranch(projectPath);
			if (!currentBranch) { continue; } // not a git repo — skip

			if (!allowed.has(currentBranch)) {
				mismatches.push({ project, currentBranch });
			}
		}

		return mismatches;
	}

	/** Generate a branch name from a task number */
	static suggestBranchName(taskNumber: string): string {
		if (!taskNumber) return '';
		const cleaned = taskNumber
			.replace(/^#/, '')
			.replace(/\s+/g, '-')
			.toLowerCase();
		return `feature/${cleaned}`;
	}
}
