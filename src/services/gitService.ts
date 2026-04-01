/**
 * Git service — branch management and status checks
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { CodeMapRefDiffEntry } from '../types/codemap.js';
import type {
	GitOverlayChangeGroup,
	GitOverlayBranchInfo,
	GitOverlayCommit,
	GitOverlayFileHistoryEntry,
	GitOverlayFileHistoryPayload,
	GitOverlayProjectCommitMessage,
	GitOverlayProjectSnapshot,
	GitOverlaySnapshot,
} from '../types/git.js';
import {
	buildGitOverlayGraph,
	canDeleteGitOverlayBranch,
	resolveGitOverlayBranchNames,
} from '../utils/gitOverlay.js';

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

interface GitLocalBranchRecord {
	name: string;
	current: boolean;
	upstream: string;
	ahead: number;
	behind: number;
	stale: boolean;
	sha: string;
	author: string;
	committedAt: string;
	subject: string;
}

interface GitMultiProjectResult {
	success: boolean;
	errors: string[];
	changedProjects: string[];
	skippedProjects: string[];
}

interface GitMergeProjectsResult extends GitMultiProjectResult {
	conflicts: Array<{ project: string; files: string[] }>;
}

interface BuiltInGitInputBox {
	value: string;
}

interface BuiltInGitRepository {
	rootUri: vscode.Uri;
	inputBox: BuiltInGitInputBox;
}

interface BuiltInGitApi {
	repositories: BuiltInGitRepository[];
	getRepository(uri: vscode.Uri): BuiltInGitRepository | null;
}

interface BuiltInGitExtensionExports {
	getAPI(version: 1): BuiltInGitApi;
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

	private async runGitFileCommandRaw(projectPath: string, args: string[]): Promise<string> {
		const { stdout } = await execFileAsync('git', args, {
			cwd: projectPath,
			maxBuffer: GitService.DIFF_MAX_BUFFER,
		});
		return stdout;
	}

	private async runGitFileCommandOptional(projectPath: string, args: string[]): Promise<string> {
		try {
			return await this.runGitFileCommand(projectPath, args);
		} catch {
			return '';
		}
	}

	private async runGitFileMutation(projectPath: string, args: string[]): Promise<void> {
		await execFileAsync('git', args, {
			cwd: projectPath,
			maxBuffer: GitService.DIFF_MAX_BUFFER,
		});
	}

	private async getBuiltInGitApi(): Promise<BuiltInGitApi | null> {
		const extension = vscode.extensions.getExtension<BuiltInGitExtensionExports>('vscode.git');
		if (!extension) {
			return null;
		}

		const exports = extension.isActive ? extension.exports : await extension.activate();
		if (!exports || typeof exports.getAPI !== 'function') {
			return null;
		}

		return exports.getAPI(1);
	}

	private async getBuiltInGitRepository(projectPath: string): Promise<BuiltInGitRepository | null> {
		const gitApi = await this.getBuiltInGitApi();
		if (!gitApi) {
			return null;
		}

		const projectUri = vscode.Uri.file(projectPath);
		const directRepository = gitApi.getRepository(projectUri);
		if (directRepository) {
			return directRepository;
		}

		const normalizedProjectPath = path.resolve(projectPath);
		return gitApi.repositories.find((repository) => {
			const repositoryRootPath = path.resolve(repository.rootUri.fsPath);
			return normalizedProjectPath === repositoryRootPath
				|| normalizedProjectPath.startsWith(`${repositoryRootPath}${path.sep}`)
				|| repositoryRootPath.startsWith(`${normalizedProjectPath}${path.sep}`);
		}) || null;
	}

	private getEffectiveProjects(projectPaths: Map<string, string>, projectNames: string[]): Array<{ project: string; projectPath: string }> {
		const effectiveProjects = projectNames.length > 0
			? projectNames
			: Array.from(projectPaths.keys());

		return effectiveProjects
			.map(project => ({ project, projectPath: projectPaths.get(project) || '' }))
			.filter(item => Boolean(item.projectPath));
	}

	private parseTrackStatus(rawTrack: string): { ahead: number; behind: number; stale: boolean } {
		const normalized = (rawTrack || '').trim();
		if (!normalized) {
			return { ahead: 0, behind: 0, stale: false };
		}

		if (normalized.includes('[gone]')) {
			return { ahead: 0, behind: 0, stale: true };
		}

		const aheadMatch = normalized.match(/ahead\s+(\d+)/i);
		const behindMatch = normalized.match(/behind\s+(\d+)/i);

		return {
			ahead: Number.parseInt(aheadMatch?.[1] || '0', 10) || 0,
			behind: Number.parseInt(behindMatch?.[1] || '0', 10) || 0,
			stale: false,
		};
	}

	private async listRemoteBranchNames(projectPath: string): Promise<Set<string>> {
		const stdout = await this.runGitFileCommandOptional(projectPath, ['for-each-ref', 'refs/remotes', '--format=%(refname:short)']);
		const result = new Set<string>();
		for (const line of stdout.split(/\r?\n/)) {
			const normalized = line.trim();
			if (!normalized || normalized.endsWith('/HEAD')) {
				continue;
			}
			result.add(normalized);
			const parts = normalized.split('/');
			if (parts.length > 1) {
				result.add(parts.slice(1).join('/'));
			}
		}
		return result;
	}

	private async findRemoteBranchRef(projectPath: string, branchName: string): Promise<string> {
		const stdout = await this.runGitFileCommandOptional(projectPath, ['for-each-ref', 'refs/remotes', '--format=%(refname:short)']);
		for (const line of stdout.split(/\r?\n/)) {
			const normalized = line.trim();
			if (!normalized || normalized.endsWith('/HEAD')) {
				continue;
			}
			if (normalized === branchName || normalized.endsWith(`/${branchName}`)) {
				return normalized;
			}
		}
		return '';
	}

	private async branchExistsLocally(projectPath: string, branchName: string): Promise<boolean> {
		try {
			await execFileAsync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], {
				cwd: projectPath,
				maxBuffer: GitService.DIFF_MAX_BUFFER,
			});
			return true;
		} catch {
			return false;
		}
	}

	private async ensureBranchCheckedOut(projectPath: string, branchName: string): Promise<void> {
		if (await this.branchExistsLocally(projectPath, branchName)) {
			await this.runGitFileMutation(projectPath, ['checkout', branchName]);
			return;
		}

		const remoteBranchRef = await this.findRemoteBranchRef(projectPath, branchName);
		if (!remoteBranchRef) {
			throw new Error(`Ветка "${branchName}" не найдена локально или на remote.`);
		}

		await this.runGitFileMutation(projectPath, ['checkout', '-b', branchName, '--track', remoteBranchRef]);
	}

	private async getBranchRemote(projectPath: string, branchName: string): Promise<string> {
		const configuredRemote = await this.runGitFileCommandOptional(projectPath, ['config', `branch.${branchName}.remote`]);
		if (configuredRemote) {
			return configuredRemote;
		}

		const remotes = await this.runGitFileCommandOptional(projectPath, ['remote']);
		const remoteNames = remotes.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
		if (remoteNames.includes('origin')) {
			return 'origin';
		}
		return remoteNames[0] || '';
	}

	private async listLocalBranches(projectPath: string): Promise<Map<string, GitLocalBranchRecord>> {
		const stdout = await this.runGitFileCommandOptional(
			projectPath,
			[
				'for-each-ref',
				'refs/heads',
				'--sort=-committerdate',
				'--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:iso-strict)%00%(objectname)%00%(authorname)%00%(subject)',
			],
		);
		const result = new Map<string, GitLocalBranchRecord>();

		for (const line of stdout.split(/\r?\n/)) {
			if (!line) {
				continue;
			}
			const [
				name,
				headMarker,
				upstream,
				track,
				committedAt,
				sha,
				author,
				subject,
			] = line.split('\u0000');
			const parsedTrack = this.parseTrackStatus(track || '');
			result.set(name, {
				name,
				current: (headMarker || '').trim() === '*',
				upstream: (upstream || '').trim(),
				ahead: parsedTrack.ahead,
				behind: parsedTrack.behind,
				stale: parsedTrack.stale,
				sha: (sha || '').trim(),
				author: (author || '').trim(),
				committedAt: (committedAt || '').trim(),
				subject: (subject || '').trim(),
			});
		}

		return result;
	}

	private async getChangeGroups(project: string, projectPath: string): Promise<GitOverlayProjectSnapshot['changeGroups']> {
		const statusOutput = await this.runGitFileCommandOptional(projectPath, ['status', '--porcelain', '--untracked-files=all']);
		const conflictOutput = await this.runGitFileCommandOptional(projectPath, ['diff', '--name-only', '--diff-filter=U']);
		const stagedOutput = await this.runGitFileCommandOptional(projectPath, [
			'diff',
			'--cached',
			'--name-status',
			'--find-renames',
			'--diff-filter=ACDMR',
		]);
		const workingTreeOutput = await this.runGitFileCommandOptional(projectPath, [
			'diff',
			'--name-status',
			'--find-renames',
			'--diff-filter=ACDMR',
		]);

		const conflictedFiles = new Set(
			conflictOutput
				.split(/\r?\n/)
				.map(line => line.trim())
				.filter(Boolean),
		);

		const mapChange = (file: StagedFileChange, group: GitOverlayProjectSnapshot['changeGroups'][keyof GitOverlayProjectSnapshot['changeGroups']], groupName: 'merge' | 'staged' | 'workingTree' | 'untracked', staged: boolean) => {
			group.push({
				project,
				path: file.path,
				previousPath: file.previousPath,
				status: file.status,
				group: groupName === 'workingTree' ? 'working-tree' : groupName,
				conflicted: conflictedFiles.has(file.path),
				staged,
			});
		};

		const changeGroups: GitOverlayProjectSnapshot['changeGroups'] = {
			merge: [...conflictedFiles].map(filePath => ({
				project,
				path: filePath,
				status: 'U',
				group: 'merge',
				conflicted: true,
				staged: false,
			})),
			staged: [],
			workingTree: [],
			untracked: statusOutput
				.split(/\r?\n/)
				.filter(line => line.startsWith('?? '))
				.map(line => line.slice(3).trim())
				.filter(Boolean)
				.map(filePath => ({
					project,
					path: filePath,
					status: 'A',
					group: 'untracked' as const,
					conflicted: false,
					staged: false,
				})),
		};

		for (const file of this.parseStagedNameStatus(stagedOutput)) {
			if (!conflictedFiles.has(file.path)) {
				mapChange(file, changeGroups.staged, 'staged', true);
			}
		}

		for (const file of this.parseStagedNameStatus(workingTreeOutput)) {
			if (!conflictedFiles.has(file.path)) {
				mapChange(file, changeGroups.workingTree, 'workingTree', false);
			}
		}

		return changeGroups;
	}

	private parseCommitLog(raw: string): GitOverlayCommit[] {
		return raw
			.split('\u001e')
			.map(record => record.trim())
			.filter(Boolean)
			.map((record) => {
				const [sha, shortSha, author, committedAt, refNamesRaw, subject] = record.split('\u001f');
				return {
					sha: (sha || '').trim(),
					shortSha: (shortSha || '').trim(),
					author: (author || '').trim(),
					committedAt: (committedAt || '').trim(),
					refNames: (refNamesRaw || '')
						.split(',')
						.map(item => item.trim())
						.filter(Boolean),
					subject: (subject || '').trim(),
				};
			})
			.filter(commit => Boolean(commit.sha));
	}

	private async getRecentCommits(projectPath: string, ref: string, limit: number): Promise<GitOverlayCommit[]> {
		const stdout = await this.runGitFileCommandOptional(projectPath, [
			'log',
			ref,
			`--max-count=${limit}`,
			'--date=iso-strict',
			'--decorate=short',
			'--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%D%x1f%s%x1e',
		]);
		return this.parseCommitLog(stdout);
	}

	private async getLastCommit(projectPath: string, ref: string): Promise<GitOverlayCommit | null> {
		return (await this.getRecentCommits(projectPath, ref, 1))[0] || null;
	}

	private async getFileHistory(projectPath: string, filePath: string, limit: number): Promise<GitOverlayFileHistoryEntry[]> {
		const stdout = await this.runGitFileCommandOptional(projectPath, [
			'log',
			'--follow',
			`--max-count=${limit}`,
			'--date=iso-strict',
			'--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e',
			'--name-status',
			'--',
			filePath,
		]);

		return stdout
			.split('\u001e')
			.map(record => record.trim())
			.filter(Boolean)
			.map((record) => {
				const lines = record.split(/\r?\n/).filter(Boolean);
				const [sha, shortSha, author, committedAt, subject] = (lines.shift() || '').split('\u001f');
				const statusLine = lines[0] || '';
				const status = (statusLine.split('\t')[0] || '').trim() || 'M';
				return {
					sha: (sha || '').trim(),
					shortSha: (shortSha || '').trim(),
					author: (author || '').trim(),
					committedAt: (committedAt || '').trim(),
					subject: (subject || '').trim(),
					status,
				};
			})
			.filter(entry => Boolean(entry.sha));
	}

	private async buildProjectSnapshot(
		project: string,
		projectPath: string,
		promptBranch: string,
		trackedBranches: string[],
	): Promise<GitOverlayProjectSnapshot> {
		try {
			const currentBranch = await this.getCurrentBranch(projectPath);
			if (!currentBranch) {
				return {
					project,
					repositoryPath: projectPath,
					available: false,
					error: 'Not a git repository',
					currentBranch: '',
					promptBranch: promptBranch.trim(),
					dirty: false,
					hasConflicts: false,
					upstream: '',
					ahead: 0,
					behind: 0,
					lastCommit: null,
					branches: [],
					cleanupBranches: [],
					changeGroups: { merge: [], staged: [], workingTree: [], untracked: [] },
					recentCommits: [],
					staleLocalBranches: [],
					graph: { nodes: [], edges: [] },
				};
			}

			const [localBranches, remoteBranches, changeGroups, recentCommits] = await Promise.all([
				this.listLocalBranches(projectPath),
				this.listRemoteBranchNames(projectPath),
				this.getChangeGroups(project, projectPath),
				this.getRecentCommits(projectPath, currentBranch, 12),
			]);

			const currentBranchRecord = localBranches.get(currentBranch) || null;
			const visibleBranchNames = resolveGitOverlayBranchNames(trackedBranches, promptBranch, currentBranch);
			const branches: GitOverlayBranchInfo[] = visibleBranchNames.map((branchName) => {
				const localBranch = localBranches.get(branchName) || null;
				const kind = branchName === promptBranch.trim()
					? 'prompt'
					: branchName === currentBranch
						? 'current'
						: trackedBranches.map(branch => branch.trim()).includes(branchName)
							? 'tracked'
							: 'local';

				return {
					name: branchName,
					current: branchName === currentBranch,
					exists: Boolean(localBranch) || remoteBranches.has(branchName),
					kind,
					upstream: localBranch?.upstream || '',
					ahead: localBranch?.ahead || 0,
					behind: localBranch?.behind || 0,
					lastCommit: localBranch
						? {
							sha: localBranch.sha,
							shortSha: localBranch.sha.slice(0, 7),
							author: localBranch.author,
							committedAt: localBranch.committedAt,
							refNames: [localBranch.name],
							subject: localBranch.subject,
						}
						: null,
					canSwitch: Boolean(localBranch) || remoteBranches.has(branchName),
					canDelete: Boolean(localBranch) && canDeleteGitOverlayBranch(branchName, currentBranch, trackedBranches, promptBranch),
					stale: Boolean(localBranch?.stale),
				};
			});

			const cleanupBranches = [...localBranches.values()]
				.filter(branch => canDeleteGitOverlayBranch(branch.name, currentBranch, trackedBranches, promptBranch))
				.map((branch): GitOverlayBranchInfo => ({
					name: branch.name,
					current: false,
					exists: true,
					kind: 'cleanup',
					upstream: branch.upstream,
					ahead: branch.ahead,
					behind: branch.behind,
					lastCommit: {
						sha: branch.sha,
						shortSha: branch.sha.slice(0, 7),
						author: branch.author,
						committedAt: branch.committedAt,
						refNames: [branch.name],
						subject: branch.subject,
					},
					canSwitch: true,
					canDelete: true,
					stale: branch.stale,
				}))
				.sort((left, right) => {
					if (left.stale !== right.stale) {
						return left.stale ? -1 : 1;
					}
					return left.name.localeCompare(right.name, 'ru', { sensitivity: 'base' });
				});

			const graph = buildGitOverlayGraph({
				branchNames: [...new Set([...branches.map(branch => branch.name), ...cleanupBranches.map(branch => branch.name)])],
				trackedBranches,
				promptBranch,
				currentBranch,
				currentUpstream: currentBranchRecord?.upstream,
			});

			const hasChanges = changeGroups.merge.length > 0
				|| changeGroups.staged.length > 0
				|| changeGroups.workingTree.length > 0
				|| changeGroups.untracked.length > 0;

			return {
				project,
				repositoryPath: projectPath,
				available: true,
				error: '',
				currentBranch,
				promptBranch: promptBranch.trim(),
				dirty: hasChanges,
				hasConflicts: changeGroups.merge.length > 0,
				upstream: currentBranchRecord?.upstream || '',
				ahead: currentBranchRecord?.ahead || 0,
				behind: currentBranchRecord?.behind || 0,
				lastCommit: recentCommits[0] || null,
				branches,
				cleanupBranches,
				changeGroups,
				recentCommits,
				staleLocalBranches: cleanupBranches.filter(branch => branch.stale).map(branch => branch.name),
				graph,
			};
		} catch (error) {
			return {
				project,
				repositoryPath: projectPath,
				available: false,
				error: error instanceof Error ? error.message : String(error),
				currentBranch: '',
				promptBranch: promptBranch.trim(),
				dirty: false,
				hasConflicts: false,
				upstream: '',
				ahead: 0,
				behind: 0,
				lastCommit: null,
				branches: [],
				cleanupBranches: [],
				changeGroups: { merge: [], staged: [], workingTree: [], untracked: [] },
				recentCommits: [],
				staleLocalBranches: [],
				graph: { nodes: [], edges: [] },
			};
		}
	}

	private async runProjectMutation(
		projectPaths: Map<string, string>,
		projectNames: string[],
		runner: (project: string, projectPath: string) => Promise<boolean | void>,
	): Promise<GitMultiProjectResult> {
		const errors: string[] = [];
		const changedProjects: string[] = [];
		const skippedProjects: string[] = [];

		for (const { project, projectPath } of this.getEffectiveProjects(projectPaths, projectNames)) {
			try {
				const result = await runner(project, projectPath);
				if (result === false) {
					skippedProjects.push(project);
					continue;
				}
				changedProjects.push(project);
			} catch (error) {
				errors.push(`${project}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		return {
			success: errors.length === 0,
			errors,
			changedProjects,
			skippedProjects,
		};
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
				const currentBranch = await this.runGitFileCommand(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
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
			const stdout = await this.runGitFileCommandRaw(projectPath, ['status', '--porcelain']);
			const normalized = stdout.trim();
			const hasChanges = normalized.length > 0;
			return {
				hasChanges,
				details: hasChanges ? normalized : 'Working tree clean',
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
				const hasLocalBranch = await this.branchExistsLocally(projectPath, targetBranch);
				if (!hasLocalBranch) {
					const remoteBranchRef = await this.findRemoteBranchRef(projectPath, targetBranch);
					if (remoteBranchRef) {
						await this.ensureBranchCheckedOut(projectPath, targetBranch);
						continue;
					}

					const currentBranch = await this.getCurrentBranch(projectPath);
					if (!allowedBaseBranches.has(currentBranch)) {
						errors.push(
							`${project}: ветка "${targetBranch}" не существует. Создание разрешено только из ${Array.from(allowedBaseBranches).join('/')} (текущая: ${currentBranch || 'unknown'}).`
						);
						continue;
					}

					await this.runGitFileMutation(projectPath, ['checkout', '-b', targetBranch]);
				} else {
					await this.runGitFileMutation(projectPath, ['checkout', targetBranch]);
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
			return await this.runGitFileCommand(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
		} catch {
			return '';
		}
	}

	async generateCommitMessageViaCopilot(projectPath: string): Promise<string> {
		const repository = await this.getBuiltInGitRepository(projectPath);
		if (!repository) {
			return '';
		}

		const previousInputValue = repository.inputBox.value;
		const cancellationSource = new vscode.CancellationTokenSource();

		try {
			repository.inputBox.value = '';
			await vscode.commands.executeCommand(
				'github.copilot.git.generateCommitMessage',
				repository.rootUri,
				undefined,
				cancellationSource.token,
			);
			return repository.inputBox.value.trim();
		} catch {
			return '';
		} finally {
			repository.inputBox.value = previousInputValue;
			cancellationSource.dispose();
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
				const hasLocalBranch = await this.branchExistsLocally(projectPath, targetBranch);
				if (hasLocalBranch) {
					await this.runGitFileMutation(projectPath, ['checkout', targetBranch]);
					continue;
				}

				const remoteBranchRef = await this.findRemoteBranchRef(projectPath, targetBranch);
				if (remoteBranchRef) {
					await this.ensureBranchCheckedOut(projectPath, targetBranch);
					continue;
				}

				const currentBranch = await this.getCurrentBranch(projectPath);
				if (!allowedBaseBranches.has(currentBranch)) {
					errors.push(
						`${project}: ветка "${targetBranch}" не существует. Создание разрешено только из ${Array.from(allowedBaseBranches).join('/')} (текущая: ${currentBranch || 'unknown'}).`
					);
					continue;
				}

				await this.runGitFileMutation(projectPath, ['checkout', '-b', targetBranch]);
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

	async getStagedCommitProjectData(
		projectPaths: Map<string, string>,
		projectNames: string[],
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
				if (!snapshot || snapshot.stagedFiles.length === 0) {
					continue;
				}

				prepared.push({
					project,
					projectPath,
					branch: snapshot.branch,
					changeSource: 'staged',
					stagedFiles: snapshot.stagedFiles,
					stat: snapshot.stagedStat,
					diff: snapshot.stagedDiff,
				});
			} catch {
				// Ignore non-git folders and command failures for a specific project.
			}
		}

		return prepared;
	}

	async getGitOverlaySnapshot(
		projectPaths: Map<string, string>,
		projectNames: string[],
		promptBranch: string,
		trackedBranches: string[],
	): Promise<GitOverlaySnapshot> {
		const projects = await Promise.all(
			this.getEffectiveProjects(projectPaths, projectNames)
				.map(({ project, projectPath }) => this.buildProjectSnapshot(project, projectPath, promptBranch, trackedBranches)),
		);

		return {
			generatedAt: new Date().toISOString(),
			promptBranch: promptBranch.trim(),
			trackedBranches: trackedBranches.map(branch => branch.trim()).filter(Boolean),
			projects,
		};
	}

	async stageAll(
		projectPaths: Map<string, string>,
		projectNames: string[],
		trackedOnly: boolean,
		projectFilter?: string,
	): Promise<GitMultiProjectResult> {
		const filteredProjects = projectFilter ? projectNames.filter(project => project === projectFilter) : projectNames;
		return this.runProjectMutation(projectPaths, filteredProjects, async (_project, projectPath) => {
			await this.runGitFileMutation(projectPath, trackedOnly ? ['add', '--update'] : ['add', '--all']);
		});
	}

	async unstageAll(
		projectPaths: Map<string, string>,
		projectNames: string[],
		projectFilter?: string,
	): Promise<GitMultiProjectResult> {
		const filteredProjects = projectFilter ? projectNames.filter(project => project === projectFilter) : projectNames;
		return this.runProjectMutation(projectPaths, filteredProjects, async (_project, projectPath) => {
			await this.runGitFileMutation(projectPath, ['restore', '--staged', '--', '.']);
		});
	}

	async stageFile(
		projectPaths: Map<string, string>,
		projectName: string,
		filePath: string,
	): Promise<GitMultiProjectResult> {
		return this.runProjectMutation(projectPaths, [projectName], async (_project, projectPath) => {
			await this.runGitFileMutation(projectPath, ['add', '--', filePath]);
		});
	}

	async unstageFile(
		projectPaths: Map<string, string>,
		projectName: string,
		filePath: string,
	): Promise<GitMultiProjectResult> {
		return this.runProjectMutation(projectPaths, [projectName], async (_project, projectPath) => {
			await this.runGitFileMutation(projectPath, ['restore', '--staged', '--', filePath]);
		});
	}

	async discardFile(
		projectPaths: Map<string, string>,
		projectName: string,
		filePath: string,
		group: GitOverlayChangeGroup,
		previousPath?: string,
	): Promise<GitMultiProjectResult> {
		const affectedPaths = previousPath && previousPath !== filePath
			? [filePath, previousPath]
			: [filePath];

		return this.runProjectMutation(projectPaths, [projectName], async (_project, projectPath) => {
			if (group === 'untracked') {
				await this.runGitFileMutation(projectPath, ['clean', '-fd', '--', ...affectedPaths]);
				return;
			}

			if (group === 'staged') {
				await this.runGitFileMutation(projectPath, ['restore', '--staged', '--source=HEAD', '--', ...affectedPaths]);
				return;
			}

			if (group === 'working-tree') {
				await this.runGitFileMutation(projectPath, ['restore', '--worktree', '--source=HEAD', '--', ...affectedPaths]);
				return;
			}

			await this.runGitFileMutation(projectPath, ['restore', '--staged', '--worktree', '--source=HEAD', '--', ...affectedPaths]);
		});
	}

	async ensurePromptBranchFromTracked(
		projectPaths: Map<string, string>,
		projectNames: string[],
		promptBranch: string,
		trackedBranch: string,
	): Promise<GitMultiProjectResult> {
		const normalizedPromptBranch = promptBranch.trim();
		const normalizedTrackedBranch = trackedBranch.trim();
		if (!normalizedPromptBranch) {
			return { success: false, errors: ['Название ветки промпта пустое.'], changedProjects: [], skippedProjects: [] };
		}
		if (!normalizedTrackedBranch) {
			return { success: false, errors: ['Не выбрана tracked-ветка.'], changedProjects: [], skippedProjects: [] };
		}

		return this.runProjectMutation(projectPaths, projectNames, async (_project, projectPath) => {
			await this.ensureBranchCheckedOut(projectPath, normalizedTrackedBranch);
			if (await this.branchExistsLocally(projectPath, normalizedPromptBranch)) {
				await this.runGitFileMutation(projectPath, ['checkout', normalizedPromptBranch]);
				return;
			}
			await this.runGitFileMutation(projectPath, ['checkout', '-b', normalizedPromptBranch, normalizedTrackedBranch]);
		});
	}

	async mergePromptBranchIntoTracked(
		projectPaths: Map<string, string>,
		projectNames: string[],
		promptBranch: string,
		trackedBranch: string,
		stayOnTrackedBranch = true,
	): Promise<GitMergeProjectsResult> {
		const normalizedPromptBranch = promptBranch.trim();
		const normalizedTrackedBranch = trackedBranch.trim();
		if (!normalizedPromptBranch) {
			return { success: false, errors: ['Название ветки промпта пустое.'], changedProjects: [], skippedProjects: [], conflicts: [] };
		}
		if (!normalizedTrackedBranch) {
			return { success: false, errors: ['Не выбрана tracked-ветка для merge.'], changedProjects: [], skippedProjects: [], conflicts: [] };
		}

		const result: GitMergeProjectsResult = {
			success: true,
			errors: [],
			changedProjects: [],
			skippedProjects: [],
			conflicts: [],
		};

		for (const { project, projectPath } of this.getEffectiveProjects(projectPaths, projectNames)) {
			try {
				await this.ensureBranchCheckedOut(projectPath, normalizedTrackedBranch);
				try {
					await this.runGitFileMutation(projectPath, ['merge', '--no-edit', normalizedPromptBranch]);
					if (!stayOnTrackedBranch) {
						await this.ensureBranchCheckedOut(projectPath, normalizedPromptBranch);
					}
					result.changedProjects.push(project);
				} catch (error) {
					const conflictFiles = await this.runGitFileCommandOptional(projectPath, ['diff', '--name-only', '--diff-filter=U']);
					const normalizedConflictFiles = conflictFiles.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
					if (normalizedConflictFiles.length > 0) {
						result.conflicts.push({ project, files: normalizedConflictFiles });
						result.errors.push(`${project}: merge остановлен из-за конфликтов.`);
						continue;
					}
					throw error;
				}
			} catch (error) {
				result.errors.push(`${project}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		result.success = result.errors.length === 0;
		return result;
	}

	async deleteLocalBranch(
		projectPaths: Map<string, string>,
		projectNames: string[],
		branchName: string,
		promptBranch: string,
		trackedBranches: string[],
	): Promise<GitMultiProjectResult> {
		const normalizedBranchName = branchName.trim();
		if (!normalizedBranchName) {
			return { success: false, errors: ['Название ветки пустое.'], changedProjects: [], skippedProjects: [] };
		}

		return this.runProjectMutation(projectPaths, projectNames, async (_project, projectPath) => {
			const currentBranch = await this.getCurrentBranch(projectPath);
			if (!canDeleteGitOverlayBranch(normalizedBranchName, currentBranch, trackedBranches, promptBranch)) {
				throw new Error('Эту ветку нельзя удалить по текущим правилам.');
			}
			if (!(await this.branchExistsLocally(projectPath, normalizedBranchName))) {
				return false;
			}
			await this.runGitFileMutation(projectPath, ['branch', '-D', normalizedBranchName]);
		});
	}

	async pushBranch(
		projectPaths: Map<string, string>,
		projectNames: string[],
		branchName?: string,
	): Promise<GitMultiProjectResult> {
		const normalizedBranchName = (branchName || '').trim();
		return this.runProjectMutation(projectPaths, projectNames, async (_project, projectPath) => {
			const currentBranch = await this.getCurrentBranch(projectPath);
			const targetBranch = normalizedBranchName || currentBranch;
			if (!targetBranch) {
				throw new Error('Не удалось определить ветку для push.');
			}
			const remote = await this.getBranchRemote(projectPath, targetBranch);
			if (!remote) {
				throw new Error(`Для ветки "${targetBranch}" не настроен remote.`);
			}
			if (targetBranch === currentBranch) {
				const upstream = await this.runGitFileCommandOptional(projectPath, ['config', `branch.${targetBranch}.merge`]);
				if (upstream) {
					await this.runGitFileMutation(projectPath, ['push']);
					return;
				}
			}
			const hasUpstream = await this.runGitFileCommandOptional(projectPath, ['config', `branch.${targetBranch}.merge`]);
			await this.runGitFileMutation(projectPath, hasUpstream ? ['push', remote, `${targetBranch}:${targetBranch}`] : ['push', '-u', remote, `${targetBranch}:${targetBranch}`]);
		});
	}

	async fetchProjects(
		projectPaths: Map<string, string>,
		projectNames: string[],
	): Promise<GitMultiProjectResult> {
		return this.runProjectMutation(projectPaths, projectNames, async (_project, projectPath) => {
			await this.runGitFileMutation(projectPath, ['fetch', '--all', '--prune']);
		});
	}

	async syncProjects(
		projectPaths: Map<string, string>,
		projectNames: string[],
	): Promise<GitMultiProjectResult> {
		return this.runProjectMutation(projectPaths, projectNames, async (_project, projectPath) => {
			const currentBranch = await this.getCurrentBranch(projectPath);
			if (!currentBranch) {
				return false;
			}
			const upstream = await this.runGitFileCommandOptional(projectPath, ['config', `branch.${currentBranch}.merge`]);
			if (!upstream) {
				return false;
			}
			await this.runGitFileMutation(projectPath, ['pull', '--ff-only']);
		});
	}

	async commitStagedChanges(
		projectPaths: Map<string, string>,
		messages: GitOverlayProjectCommitMessage[],
	): Promise<GitMultiProjectResult> {
		const normalizedMessages = Array.from(new Map(
			(messages || [])
				.map((item) => ({
					project: (item.project || '').trim(),
					message: (item.message || '').trim(),
				}))
				.filter(item => Boolean(item.project) && Boolean(item.message))
				.map(item => [item.project, item.message]),
		).entries()).map(([project, message]) => ({ project, message }));

		if (normalizedMessages.length === 0) {
			return { success: false, errors: ['Не переданы сообщения коммита по проектам.'], changedProjects: [], skippedProjects: [] };
		}

		const changedProjects: string[] = [];
		const skippedProjects: string[] = [];
		const errors: string[] = [];

		for (const item of normalizedMessages) {
			const projectPath = projectPaths.get(item.project);
			if (!projectPath) {
				errors.push(`${item.project}: workspace folder not found`);
				continue;
			}

			try {
				const stagedStatus = await this.runGitFileCommandOptional(projectPath, ['diff', '--cached', '--name-only']);
				if (!stagedStatus.trim()) {
					skippedProjects.push(item.project);
					continue;
				}

				const paragraphs = item.message
					.split(/\n\s*\n/g)
					.map(part => part.trim())
					.filter(Boolean);
				const commitArgs = ['commit'];
				for (const paragraph of (paragraphs.length > 0 ? paragraphs : [item.message.trim()])) {
					commitArgs.push('-m', paragraph);
				}
				await this.runGitFileMutation(projectPath, commitArgs);
				changedProjects.push(item.project);
			} catch (error) {
				errors.push(`${item.project}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		return {
			success: errors.length === 0,
			errors,
			changedProjects,
			skippedProjects,
		};
	}

	async getFileHistoryPayload(
		projectPaths: Map<string, string>,
		projectName: string,
		filePath: string,
	): Promise<GitOverlayFileHistoryPayload> {
		const projectPath = projectPaths.get(projectName);
		if (!projectPath) {
			return { project: projectName, filePath, entries: [] };
		}

		return {
			project: projectName,
			filePath,
			entries: await this.getFileHistory(projectPath, filePath, 20),
		};
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
