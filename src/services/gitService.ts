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
	GitOverlayChangeFile,
	GitOverlayBranchInfo,
	GitOverlayCommit,
	GitOverlayFileHistoryEntry,
	GitOverlayFileHistoryPayload,
	GitOverlayProjectReviewRequestInput,
	GitOverlayProjectCommitMessage,
	GitOverlayProjectSnapshot,
	GitOverlayReviewComment,
	GitOverlayReviewRemote,
	GitOverlayReviewRequest,
	GitOverlayReviewState,
	GitOverlayReviewUnsupportedReason,
	GitOverlaySnapshot,
} from '../types/git.js';
import type { Prompt } from '../types/prompt.js';
import {
	buildGitOverlayGraph,
	canDeleteGitOverlayBranch,
	normalizeGitOverlayReviewRequestState,
	parseGitOverlayRemoteUrl,
	resolveExistingGitOverlayTrackedBranches,
	resolveGitOverlayBranchNames,
} from '../utils/gitOverlay.js';
import { appendPromptManagerLog } from '../utils/promptManagerOutput.js';
import { getCodeMapSettings } from '../codemap/codeMapConfig.js';
import { shouldIgnoreRealtimeRefreshPath } from '../codemap/codeMapRealtimeRefresh.js';

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

interface BuiltInGitRepositoryState {
	onDidChange: vscode.Event<void>;
}

interface BuiltInGitRepository {
	rootUri: vscode.Uri;
	inputBox: BuiltInGitInputBox;
	state: BuiltInGitRepositoryState;
	onDidCommit?: vscode.Event<void>;
	onDidCheckout?: vscode.Event<void>;
}

interface BuiltInGitApi {
	repositories: BuiltInGitRepository[];
	getRepository(uri: vscode.Uri): BuiltInGitRepository | null;
	onDidOpenRepository?: vscode.Event<BuiltInGitRepository>;
	onDidCloseRepository?: vscode.Event<BuiltInGitRepository>;
}

interface BuiltInGitExtensionExports {
	getAPI(version: 1): BuiltInGitApi;
}

export class GitService {
	private static readonly DIFF_MAX_BUFFER = 8 * 1024 * 1024;
	private readonly reviewCliAvailability = new Map<'gh' | 'glab', boolean>();
	private readonly gitLabProjectIdCache = new Map<string, string>();

	private logDebug(event: string, payload?: Record<string, unknown>): void {
		const serializedPayload = payload ? ` ${JSON.stringify(payload)}` : '';
		appendPromptManagerLog(`[${new Date().toISOString()}] [git-service] ${event}${serializedPayload}`);
	}

	private previewDebugValue(value: unknown, maxLength: number = 220): string {
		const text = Buffer.isBuffer(value)
			? value.toString('utf8')
			: typeof value === 'string'
				? value
				: JSON.stringify(value ?? null);
		const normalized = String(text || '').replace(/\s+/g, ' ').trim();
		if (normalized.length <= maxLength) {
			return normalized;
		}
		return `${normalized.slice(0, maxLength - 1)}…`;
	}

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

	private async runCliCommand(command: 'gh' | 'glab', projectPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
		const { stdout, stderr } = await execFileAsync(command, args, {
			cwd: projectPath,
			maxBuffer: GitService.DIFF_MAX_BUFFER,
		});
		return { stdout, stderr };
	}

	private async runJsonCliCommand(command: 'gh' | 'glab', projectPath: string, args: string[]): Promise<unknown> {
		const { stdout } = await this.runCliCommand(command, projectPath, args);
		const normalized = stdout.trim();
		if (!normalized) {
			return null;
		}

		try {
			return JSON.parse(normalized);
		} catch (error) {
			throw new Error(`${command} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private extractCliErrorOutput(error: unknown): string {
		if (!(error instanceof Error)) {
			return String(error || '').trim();
		}

		const stdout = typeof (error as { stdout?: unknown }).stdout === 'string'
			? String((error as { stdout?: string }).stdout)
			: '';
		const stderr = typeof (error as { stderr?: unknown }).stderr === 'string'
			? String((error as { stderr?: string }).stderr)
			: '';

		return [stdout, stderr, error.message]
			.map(part => part.trim())
			.filter(Boolean)
			.join('\n');
	}

	private extractGitLabProjectId(payload: unknown): string {
		if (!payload || typeof payload !== 'object') {
			return '';
		}

		const projectId = (payload as { id?: number | string }).id;
		return projectId === undefined || projectId === null ? '' : String(projectId).trim();
	}

	private parseGitLabProjectIdFromRedirectOutput(output: string): string {
		const normalized = output.trim();
		if (!normalized) {
			return '';
		}

		const locationMatch = normalized.match(/Location:\s+[^\s]*\/projects\/(\d+)(?:\b|[/?#])/i);
		if (locationMatch?.[1]) {
			return locationMatch[1].trim();
		}

		const messageMatch = normalized.match(/\/projects\/(\d+)(?:\b|[/?#])/i);
		return messageMatch?.[1]?.trim() || '';
	}

	private async resolveGitLabProjectId(projectPath: string, remote: GitOverlayReviewRemote): Promise<string> {
		const cacheKey = `${remote.host}:${remote.repositoryPath}`;
		const cached = this.gitLabProjectIdCache.get(cacheKey);
		if (cached) {
			return cached;
		}

		const encodedRepoPath = encodeURIComponent(remote.repositoryPath);

		try {
			const payload = await this.runJsonCliCommand('glab', projectPath, [
				'api',
				`projects/${encodedRepoPath}`,
			]);
			const projectId = this.extractGitLabProjectId(payload);
			if (projectId) {
				this.gitLabProjectIdCache.set(cacheKey, projectId);
				return projectId;
			}
		} catch (error) {
			const redirectedProjectId = this.parseGitLabProjectIdFromRedirectOutput(this.extractCliErrorOutput(error));
			if (redirectedProjectId) {
				this.gitLabProjectIdCache.set(cacheKey, redirectedProjectId);
				return redirectedProjectId;
			}
			throw error;
		}

		throw new Error(`Не удалось определить GitLab project id для ${remote.repositoryPath}.`);
	}

	private ensureGitLabDraftTitle(title: string, draft: boolean): string {
		const normalizedTitle = title.trim();
		if (!draft || !normalizedTitle) {
			return normalizedTitle;
		}

		return /^(draft|wip)\s*:/i.test(normalizedTitle)
			? normalizedTitle
			: `Draft: ${normalizedTitle}`;
	}

	private async isCliCommandAvailable(command: 'gh' | 'glab'): Promise<boolean> {
		const cached = this.reviewCliAvailability.get(command);
		if (cached !== undefined) {
			return cached;
		}

		let available = false;
		try {
			await execFileAsync(command, ['--version'], {
				maxBuffer: 256 * 1024,
			});
			available = true;
		} catch {
			available = false;
		}

		if (available) {
			this.reviewCliAvailability.set(command, true);
		} else {
			this.reviewCliAvailability.delete(command);
		}
		return available;
	}

	private async isCliAuthenticated(command: 'gh' | 'glab', projectPath: string, host: string): Promise<boolean> {
		const args = command === 'gh'
			? ['auth', 'status', '--active', '--hostname', host]
			: ['auth', 'status', '--hostname', host];
		const projectLabel = path.basename(projectPath) || projectPath;

		try {
			const { stdout, stderr } = await execFileAsync(command, args, {
				cwd: projectPath,
				maxBuffer: 256 * 1024,
			});
			this.logDebug('reviewCli.auth.check.ok', {
				project: projectLabel,
				command,
				host,
				stdoutPreview: this.previewDebugValue(stdout, 180) || null,
				stderrPreview: this.previewDebugValue(stderr, 180) || null,
			});
			return true;
		} catch (error) {
			const errorRecord = error as {
				code?: number | string;
				message?: string;
				stdout?: string | Buffer;
				stderr?: string | Buffer;
				shortMessage?: string;
			};
			this.logDebug('reviewCli.auth.check.failed', {
				project: projectLabel,
				command,
				host,
				code: errorRecord.code ?? null,
				message: this.previewDebugValue(errorRecord.shortMessage || errorRecord.message || error, 260) || null,
				stdoutPreview: this.previewDebugValue(errorRecord.stdout, 180) || null,
				stderrPreview: this.previewDebugValue(errorRecord.stderr, 180) || null,
			});
			return false;
		}
	}

	private parseNumstatOutput(raw: string): { additions: number | null; deletions: number | null; isBinary: boolean } {
		const line = raw
			.split(/\r?\n/)
			.map(item => item.trim())
			.find(Boolean);

		if (!line) {
			return { additions: 0, deletions: 0, isBinary: false };
		}

		const parts = line.split('\t');
		if (parts.length < 2) {
			return { additions: 0, deletions: 0, isBinary: false };
		}

		const additionsToken = (parts[0] || '').trim();
		const deletionsToken = (parts[1] || '').trim();
		if (additionsToken === '-' || deletionsToken === '-') {
			return { additions: null, deletions: null, isBinary: true };
		}

		return {
			additions: Number.parseInt(additionsToken || '0', 10) || 0,
			deletions: Number.parseInt(deletionsToken || '0', 10) || 0,
			isBinary: false,
		};
	}

	private async resolveOverlayFileSize(projectPath: string, filePath: string, previousPath?: string): Promise<number> {
		const candidates = Array.from(new Set([filePath, previousPath || ''].map(item => item.trim()).filter(Boolean)));
		for (const candidate of candidates) {
			try {
				const stat = await fs.stat(path.join(projectPath, candidate));
				if (stat.isFile()) {
					return stat.size;
				}
			} catch {
				// Fallback to Git blob size.
			}

			const sizeFromHead = await this.runGitFileCommandOptional(projectPath, ['cat-file', '-s', `HEAD:${candidate}`]);
			const parsedSize = Number.parseInt(sizeFromHead, 10);
			if (Number.isFinite(parsedSize) && parsedSize >= 0) {
				return parsedSize;
			}
		}

		return 0;
	}

	private async getTrackedChangeDiffStats(
		projectPath: string,
		filePath: string,
		previousPath: string | undefined,
		cached: boolean,
	): Promise<{ additions: number | null; deletions: number | null; isBinary: boolean }> {
		const args = ['diff'];
		if (cached) {
			args.push('--cached');
		}
		args.push('--numstat', '--find-renames', '--');
		if (previousPath && previousPath !== filePath) {
			args.push(previousPath, filePath);
		} else {
			args.push(filePath);
		}

		const output = await this.runGitFileCommandOptional(projectPath, args);
		return this.parseNumstatOutput(output);
	}

	private async getUntrackedChangeDiffStats(projectPath: string, filePath: string): Promise<{ additions: number | null; deletions: number | null; isBinary: boolean }> {
		try {
			const content = await fs.readFile(path.join(projectPath, filePath));
			if (content.includes(0)) {
				return { additions: null, deletions: null, isBinary: true };
			}

			const text = content.toString('utf-8');
			if (!text) {
				return { additions: 0, deletions: 0, isBinary: false };
			}

			return {
				additions: text.split(/\r?\n/).length,
				deletions: 0,
				isBinary: false,
			};
		} catch {
			return { additions: null, deletions: null, isBinary: false };
		}
	}

	private async enrichOverlayChangeFile(projectPath: string, change: GitOverlayProjectSnapshot['changeGroups'][keyof GitOverlayProjectSnapshot['changeGroups']][number]): Promise<GitOverlayProjectSnapshot['changeGroups'][keyof GitOverlayProjectSnapshot['changeGroups']][number]> {
		const fileSizeBytes = await this.resolveOverlayFileSize(projectPath, change.path, change.previousPath);
		const diffStats = change.group === 'untracked'
			? await this.getUntrackedChangeDiffStats(projectPath, change.path)
			: await this.getTrackedChangeDiffStats(projectPath, change.path, change.previousPath, change.group === 'staged');

		return {
			...change,
			fileSizeBytes,
			additions: diffStats.additions,
			deletions: diffStats.deletions,
			isBinary: diffStats.isBinary,
		};
	}

	private async resolveReviewRemoteContext(
		projectPath: string,
		branchName: string,
	): Promise<{ remote: GitOverlayReviewRemote | null; unsupportedReason: GitOverlayReviewUnsupportedReason | null }> {
		const projectLabel = path.basename(projectPath) || projectPath;
		const remoteName = await this.getBranchRemote(projectPath, branchName);
		if (!remoteName) {
			this.logDebug('reviewRemote.missing', {
				project: projectLabel,
				branchName,
			});
			return { remote: null, unsupportedReason: 'missing-remote' };
		}

		const remoteUrl = await this.runGitFileCommandOptional(projectPath, ['remote', 'get-url', remoteName]);
		const providerHosts = GitService.getReviewProviderHostsSetting();
		const parsed = parseGitOverlayRemoteUrl(remoteUrl, providerHosts);
		if (!parsed) {
			this.logDebug('reviewRemote.unrecognized', {
				project: projectLabel,
				branchName,
				remoteName,
				remoteUrl: this.previewDebugValue(remoteUrl, 260) || null,
			});
			return { remote: null, unsupportedReason: 'unrecognized-remote' };
		}

		const cliAvailable = parsed.cliCommand
			? await this.isCliCommandAvailable(parsed.cliCommand)
			: false;

		const remote = {
			...parsed,
			remoteName,
			remoteUrl,
			cliAvailable,
		};
		this.logDebug('reviewRemote.resolved', {
			project: projectLabel,
			branchName,
			remoteName,
			host: remote.host,
			provider: remote.provider,
			supported: remote.supported,
			cliCommand: remote.cliCommand || null,
			cliAvailable,
		});

		return {
			remote,
			unsupportedReason: parsed.supported ? null : 'unsupported-provider',
		};
	}

	private async getReviewRemote(projectPath: string, branchName: string): Promise<GitOverlayReviewRemote | null> {
		const { remote } = await this.resolveReviewRemoteContext(projectPath, branchName);
		return remote;
	}

	private normalizeGitHubReviewComments(issueComments: unknown, reviewComments: unknown): GitOverlayReviewComment[] {
		const comments: GitOverlayReviewComment[] = [];
		const appendComments = (items: unknown, prefix: string) => {
			if (!Array.isArray(items)) {
				return;
			}

			for (const item of items) {
				const record = item as {
					id?: number | string;
					body?: string;
					created_at?: string;
					user?: { login?: string };
				};
				const body = String(record?.body || '').trim();
				if (!body) {
					continue;
				}

				comments.push({
					id: `${prefix}-${String(record?.id || body)}`,
					author: String(record?.user?.login || 'github'),
					body,
					createdAt: String(record?.created_at || ''),
					system: false,
				});
			}
		};

		appendComments(issueComments, 'issue');
		appendComments(reviewComments, 'review');

		return comments.sort((left, right) => left.createdAt.localeCompare(right.createdAt, 'ru'));
	}

	private normalizeGitLabReviewComments(notes: unknown): GitOverlayReviewComment[] {
		if (!Array.isArray(notes)) {
			return [];
		}

		return notes
			.map((item) => {
				const record = item as {
					id?: number | string;
					body?: string;
					created_at?: string;
					system?: boolean;
					author?: { username?: string; name?: string };
				};
				const body = String(record?.body || '').trim();
				if (!body) {
					return null;
				}

				return {
					id: `note-${String(record?.id || body)}`,
					author: String(record?.author?.username || record?.author?.name || 'gitlab'),
					body,
					createdAt: String(record?.created_at || ''),
					system: Boolean(record?.system),
				} satisfies GitOverlayReviewComment;
			})
			.filter((item): item is GitOverlayReviewComment => Boolean(item))
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt, 'ru'));
	}

	private async getGitHubReviewRequest(projectPath: string, remote: GitOverlayReviewRemote, sourceBranch: string): Promise<GitOverlayReviewRequest | null> {
		const encodedHead = encodeURIComponent(`${remote.owner}:${sourceBranch}`);
		const payload = await this.runJsonCliCommand('gh', projectPath, [
			'api',
			`repos/${remote.repositoryPath}/pulls?state=all&head=${encodedHead}`,
		]);

		if (!Array.isArray(payload) || payload.length === 0) {
			return null;
		}

		const selected = payload
			.map(item => item as {
				id?: number | string;
				number?: number | string;
				title?: string;
				html_url?: string;
				state?: string;
				merged_at?: string | null;
				updated_at?: string;
				draft?: boolean;
				head?: { ref?: string };
				base?: { ref?: string };
			})
			.filter(item => String(item.head?.ref || '').trim() === sourceBranch)
			.sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || ''), 'ru'))[0];

		if (!selected) {
			return null;
		}

		const number = String(selected.number || selected.id || '').trim();
		if (!number) {
			return null;
		}

		const [issueComments, reviewComments] = await Promise.all([
			this.runJsonCliCommand('gh', projectPath, ['api', `repos/${remote.repositoryPath}/issues/${number}/comments`]).catch(() => []),
			this.runJsonCliCommand('gh', projectPath, ['api', `repos/${remote.repositoryPath}/pulls/${number}/comments`]).catch(() => []),
		]);

		return {
			id: String(selected.id || number),
			number,
			title: String(selected.title || '').trim(),
			url: String(selected.html_url || '').trim(),
			state: normalizeGitOverlayReviewRequestState({
				state: String(selected.state || ''),
				mergedAt: selected.merged_at || null,
			}),
			sourceBranch: String(selected.head?.ref || sourceBranch).trim(),
			targetBranch: String(selected.base?.ref || '').trim(),
			isDraft: Boolean(selected.draft),
			comments: this.normalizeGitHubReviewComments(issueComments, reviewComments),
		};
	}

	private async getGitLabReviewRequest(projectPath: string, remote: GitOverlayReviewRemote, sourceBranch: string): Promise<GitOverlayReviewRequest | null> {
		const gitLabProjectId = await this.resolveGitLabProjectId(projectPath, remote);
		const encodedSourceBranch = encodeURIComponent(sourceBranch);
		const payload = await this.runJsonCliCommand('glab', projectPath, [
			'api',
			`projects/${gitLabProjectId}/merge_requests?source_branch=${encodedSourceBranch}&state=all`,
		]);

		if (!Array.isArray(payload) || payload.length === 0) {
			return null;
		}

		const selected = payload
			.map(item => item as {
				id?: number | string;
				iid?: number | string;
				title?: string;
				web_url?: string;
				state?: string;
				merged_at?: string | null;
				updated_at?: string;
				source_branch?: string;
				target_branch?: string;
				work_in_progress?: boolean;
				draft?: boolean;
			})
			.filter(item => String(item.source_branch || '').trim() === sourceBranch)
			.sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || ''), 'ru'))[0];

		if (!selected) {
			return null;
		}

		const iid = String(selected.iid || selected.id || '').trim();
		if (!iid) {
			return null;
		}

		const notes = await this.runJsonCliCommand('glab', projectPath, [
			'api',
			`projects/${gitLabProjectId}/merge_requests/${iid}/notes`,
		]).catch(() => []);

		return {
			id: String(selected.id || iid),
			number: iid,
			title: String(selected.title || '').trim(),
			url: String(selected.web_url || '').trim(),
			state: normalizeGitOverlayReviewRequestState({
				state: String(selected.state || ''),
				mergedAt: selected.merged_at || null,
			}),
			sourceBranch: String(selected.source_branch || sourceBranch).trim(),
			targetBranch: String(selected.target_branch || '').trim(),
			isDraft: Boolean(selected.draft || selected.work_in_progress),
			comments: this.normalizeGitLabReviewComments(notes),
		};
	}

	private async getExistingReviewRequest(projectPath: string, remote: GitOverlayReviewRemote, sourceBranch: string): Promise<GitOverlayReviewRequest | null> {
		if (!remote.supported || !remote.cliAvailable || !sourceBranch.trim()) {
			return null;
		}

		if (remote.provider === 'github') {
			return this.getGitHubReviewRequest(projectPath, remote, sourceBranch.trim());
		}

		if (remote.provider === 'gitlab') {
			return this.getGitLabReviewRequest(projectPath, remote, sourceBranch.trim());
		}

		return null;
	}

	private async getProjectReviewState(projectPath: string, branchName: string): Promise<GitOverlayReviewState> {
		const projectLabel = path.basename(projectPath) || projectPath;
		const titlePrefix = await this.resolveReviewRequestTitlePrefix(projectPath);
		const { remote, unsupportedReason } = await this.resolveReviewRemoteContext(projectPath, branchName);
		if (!remote) {
			this.logDebug('reviewState.resolved', {
				project: projectLabel,
				branchName,
				remote: null,
				setupAction: null,
				unsupportedReason: unsupportedReason || null,
			});
			return { remote: null, request: null, error: '', setupAction: null, titlePrefix, unsupportedReason };
		}

		if (!remote.supported) {
			this.logDebug('reviewState.resolved', {
				project: projectLabel,
				branchName,
				host: remote.host,
				provider: remote.provider,
				cliAvailable: remote.cliAvailable,
				setupAction: null,
				unsupportedReason: unsupportedReason || null,
			});
			return { remote, request: null, error: '', setupAction: null, titlePrefix, unsupportedReason };
		}

		if (!remote.cliAvailable) {
			this.logDebug('reviewState.resolved', {
				project: projectLabel,
				branchName,
				host: remote.host,
				provider: remote.provider,
				cliAvailable: false,
				setupAction: 'install-and-auth',
				unsupportedReason: null,
			});
			return {
				remote,
				request: null,
				error: '',
				setupAction: 'install-and-auth',
				titlePrefix,
				unsupportedReason: null,
			};
		}

		const cliCommand = remote.cliCommand;
		if (cliCommand !== 'gh' && cliCommand !== 'glab') {
			this.logDebug('reviewState.resolved', {
				project: projectLabel,
				branchName,
				host: remote.host,
				provider: remote.provider,
				cliAvailable: remote.cliAvailable,
				setupAction: null,
				unsupportedReason: unsupportedReason || null,
			});
			return { remote, request: null, error: '', setupAction: null, titlePrefix, unsupportedReason };
		}

		const authenticated = await this.isCliAuthenticated(cliCommand, projectPath, remote.host);
		if (!authenticated) {
			this.logDebug('reviewState.resolved', {
				project: projectLabel,
				branchName,
				host: remote.host,
				provider: remote.provider,
				cliAvailable: remote.cliAvailable,
				authenticated: false,
				setupAction: 'auth',
				unsupportedReason: null,
			});
			return {
				remote,
				request: null,
				error: '',
				setupAction: 'auth',
				titlePrefix,
				unsupportedReason: null,
			};
		}

		try {
			const request = await this.getExistingReviewRequest(projectPath, remote, branchName);
			this.logDebug('reviewState.resolved', {
				project: projectLabel,
				branchName,
				host: remote.host,
				provider: remote.provider,
				cliAvailable: remote.cliAvailable,
				authenticated: true,
				setupAction: null,
				hasRequest: Boolean(request),
				requestState: request?.state || null,
			});
			return { remote, request, error: '', setupAction: null, titlePrefix, unsupportedReason: null };
		} catch (error) {
			this.logDebug('reviewState.request.error', {
				project: projectLabel,
				branchName,
				host: remote.host,
				provider: remote.provider,
				message: this.previewDebugValue(error instanceof Error ? (error.stack || error.message) : String(error), 320),
			});
			return {
				remote,
				request: null,
				error: error instanceof Error ? error.message : String(error),
				setupAction: null,
				titlePrefix,
				unsupportedReason: null,
			};
		}
	}

	private buildReviewRequestBody(prompt: Prompt): string {
		const lines = [
			prompt.taskNumber?.trim() ? `Task: ${prompt.taskNumber.trim()}` : '',
			prompt.title?.trim() ? `Prompt: ${prompt.title.trim()}` : '',
			prompt.branch?.trim() ? `Branch: ${prompt.branch.trim()}` : '',
			'',
			(prompt.description || '').trim(),
		].filter(Boolean);

		return lines.join('\n').trim();
	}

	private async createGitHubReviewRequest(
		projectPath: string,
		remote: GitOverlayReviewRemote,
		sourceBranch: string,
		targetBranch: string,
		title: string,
		body: string,
		draft: boolean,
	): Promise<void> {
		await this.runJsonCliCommand('gh', projectPath, [
			'api',
			'-X',
			'POST',
			`repos/${remote.repositoryPath}/pulls`,
			'-f',
			`title=${title}`,
			'-f',
			`head=${remote.owner}:${sourceBranch}`,
			'-f',
			`base=${targetBranch}`,
			'-f',
			`body=${body}`,
			'-f',
			`draft=${draft ? 'true' : 'false'}`,
		]);
	}

	private async createGitLabReviewRequest(
		projectPath: string,
		remote: GitOverlayReviewRemote,
		sourceBranch: string,
		targetBranch: string,
		title: string,
		body: string,
		draft: boolean,
		removeSourceBranch: boolean,
	): Promise<void> {
		const gitLabProjectId = await this.resolveGitLabProjectId(projectPath, remote);
		const resolvedTitle = this.ensureGitLabDraftTitle(title, draft);
		await this.runJsonCliCommand('glab', projectPath, [
			'api',
			'-X',
			'POST',
			`projects/${gitLabProjectId}/merge_requests`,
			'-F',
			`source_branch=${sourceBranch}`,
			'-F',
			`target_branch=${targetBranch}`,
			'-F',
			`title=${resolvedTitle}`,
			'-F',
			`description=${body}`,
			'-F',
			`remove_source_branch=${removeSourceBranch ? 'true' : 'false'}`,
		]);
	}

	public async getBuiltInGitApi(): Promise<BuiltInGitApi | null> {
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

	private async getCurrentLocalBranchRecord(projectPath: string): Promise<GitLocalBranchRecord | null> {
		const currentBranch = await this.getCurrentBranch(projectPath);
		if (!currentBranch) {
			return null;
		}

		const localBranches = await this.listLocalBranches(projectPath);
		return localBranches.get(currentBranch) || null;
	}

	private async pullCurrentBranchIfTracked(projectPath: string): Promise<boolean> {
		const currentBranchRecord = await this.getCurrentLocalBranchRecord(projectPath);
		if (!currentBranchRecord) {
			return false;
		}

		if (!currentBranchRecord.upstream) {
			return false;
		}

		await this.runGitFileMutation(projectPath, ['pull', '--ff-only']);
		return true;
	}

	private async ensureBranchCheckedOutAndPulled(projectPath: string, branchName: string): Promise<void> {
		await this.ensureBranchCheckedOut(projectPath, branchName);
		await this.pullCurrentBranchIfTracked(projectPath);
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
		const excludedPaths = getCodeMapSettings().excludedPaths;
		const shouldTrackPath = (filePath: string): boolean => {
			const normalizedFilePath = String(filePath || '').trim();
			return Boolean(normalizedFilePath) && !shouldIgnoreRealtimeRefreshPath(normalizedFilePath, excludedPaths);
		};
		const [statusOutput, conflictOutput, stagedOutput, workingTreeOutput] = await Promise.all([
			this.runGitFileCommandOptional(projectPath, ['status', '--porcelain', '--untracked-files=all']),
			this.runGitFileCommandOptional(projectPath, ['diff', '--name-only', '--diff-filter=U']),
			this.runGitFileCommandOptional(projectPath, [
				'diff',
				'--cached',
				'--name-status',
				'--find-renames',
				'--diff-filter=ACDMR',
			]),
			this.runGitFileCommandOptional(projectPath, [
				'diff',
				'--name-status',
				'--find-renames',
				'--diff-filter=ACDMR',
			]),
		]);

		const conflictedFiles = new Set(
			conflictOutput
				.split(/\r?\n/)
				.map(line => line.trim())
				.filter(shouldTrackPath),
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
				fileSizeBytes: 0,
				additions: null,
				deletions: null,
				isBinary: false,
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
				fileSizeBytes: 0,
				additions: null,
				deletions: null,
				isBinary: false,
			})),
			staged: [],
			workingTree: [],
			untracked: statusOutput
				.split(/\r?\n/)
				.filter(line => line.startsWith('?? '))
				.map(line => line.slice(3).trim())
				.filter(shouldTrackPath)
				.map(filePath => ({
					project,
					path: filePath,
					status: 'A',
					group: 'untracked' as const,
					conflicted: false,
					staged: false,
					fileSizeBytes: 0,
					additions: null,
					deletions: null,
					isBinary: false,
				})),
		};

		for (const file of this.parseStagedNameStatus(stagedOutput)) {
			if (!conflictedFiles.has(file.path) && shouldTrackPath(file.path)) {
				mapChange(file, changeGroups.staged, 'staged', true);
			}
		}

		for (const file of this.parseStagedNameStatus(workingTreeOutput)) {
			if (!conflictedFiles.has(file.path) && shouldTrackPath(file.path)) {
				mapChange(file, changeGroups.workingTree, 'workingTree', false);
			}
		}

		const [merge, staged, workingTree, untracked] = await Promise.all([
			Promise.all(changeGroups.merge.map(item => this.enrichOverlayChangeFile(projectPath, item))),
			Promise.all(changeGroups.staged.map(item => this.enrichOverlayChangeFile(projectPath, item))),
			Promise.all(changeGroups.workingTree.map(item => this.enrichOverlayChangeFile(projectPath, item))),
			Promise.all(changeGroups.untracked.map(item => this.enrichOverlayChangeFile(projectPath, item))),
		]);

		return {
			merge,
			staged,
			workingTree,
			untracked,
		};
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
					review: { remote: null, request: null, error: '', setupAction: null, titlePrefix: '', unsupportedReason: null },
					recentCommits: [],
					staleLocalBranches: [],
					graph: { nodes: [], edges: [] },
				};
			}

			const [localBranches, remoteBranches, changeGroups, recentCommits, review] = await Promise.all([
				this.listLocalBranches(projectPath),
				this.listRemoteBranchNames(projectPath),
				this.getChangeGroups(project, projectPath),
				this.getRecentCommits(projectPath, currentBranch, 12),
				this.getProjectReviewState(projectPath, promptBranch.trim() || currentBranch),
			]);

			const currentBranchRecord = localBranches.get(currentBranch) || null;
			const availableTrackedBranches = trackedBranches.filter((branchName) => {
				const normalizedBranchName = branchName.trim();
				if (!normalizedBranchName) {
					return false;
				}

				return Boolean(localBranches.get(normalizedBranchName)) || remoteBranches.has(normalizedBranchName);
			});
			const trackedBranchSet = new Set(availableTrackedBranches);
			const visibleBranchNames = resolveGitOverlayBranchNames(availableTrackedBranches, promptBranch, currentBranch);
			const branches: GitOverlayBranchInfo[] = visibleBranchNames.map((branchName) => {
				const localBranch = localBranches.get(branchName) || null;
				const kind = branchName === promptBranch.trim()
					? 'prompt'
					: branchName === currentBranch
						? 'current'
						: trackedBranchSet.has(branchName)
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
					canDelete: Boolean(localBranch) && canDeleteGitOverlayBranch(branchName, currentBranch, availableTrackedBranches, promptBranch),
					stale: Boolean(localBranch?.stale),
				};
			});

			const cleanupBranches = [...localBranches.values()]
				.filter(branch => canDeleteGitOverlayBranch(branch.name, currentBranch, availableTrackedBranches, promptBranch))
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
				trackedBranches: availableTrackedBranches,
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
				review,
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
				review: { remote: null, request: null, error: '', setupAction: null, titlePrefix: '', unsupportedReason: null },
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

	private normalizeTrackedBranchesByProject(
		projectNames: string[],
		trackedBranch: string,
		trackedBranchesByProject?: Record<string, string>,
	): Record<string, string> {
		const normalizedFallbackTrackedBranch = (trackedBranch || '').trim();
		const normalizedSelections: Record<string, string> = {};

		for (const project of projectNames) {
			const normalizedProject = project.trim();
			if (!normalizedProject) {
				continue;
			}

			const mappedBranch = typeof trackedBranchesByProject?.[normalizedProject] === 'string'
				? trackedBranchesByProject[normalizedProject].trim()
				: '';
			const resolvedBranch = mappedBranch || normalizedFallbackTrackedBranch;
			if (!resolvedBranch) {
				continue;
			}

			normalizedSelections[normalizedProject] = resolvedBranch;
		}

		return normalizedSelections;
	}

	private async switchProjectBranch(
		project: string,
		projectPath: string,
		targetBranch: string,
		allowedBaseBranches: Set<string>,
	): Promise<void> {
		this.logDebug('switchBranch.project.start', {
			project,
			projectPath,
			targetBranch,
		});

		const hasLocalBranch = await this.branchExistsLocally(projectPath, targetBranch);
		this.logDebug('switchBranch.project.localBranchChecked', {
			project,
			targetBranch,
			hasLocalBranch,
		});
		if (!hasLocalBranch) {
			const remoteBranchRef = await this.findRemoteBranchRef(projectPath, targetBranch);
			this.logDebug('switchBranch.project.remoteBranchResolved', {
				project,
				targetBranch,
				remoteBranchRef: remoteBranchRef || null,
			});
			if (remoteBranchRef) {
				this.logDebug('switchBranch.project.checkoutTracked.start', {
					project,
					targetBranch,
					remoteBranchRef,
				});
				await this.ensureBranchCheckedOutAndPulled(projectPath, targetBranch);
				this.logDebug('switchBranch.project.checkoutTracked.done', {
					project,
					targetBranch,
				});
				return;
			}

			const currentBranch = await this.getCurrentBranch(projectPath);
			this.logDebug('switchBranch.project.currentBranchResolved', {
				project,
				targetBranch,
				currentBranch,
			});
			if (!allowedBaseBranches.has(currentBranch)) {
				this.logDebug('switchBranch.project.disallowedBaseBranch', {
					project,
					targetBranch,
					currentBranch,
				});
				throw new Error(
					`ветка "${targetBranch}" не существует. Создание разрешено только из ${Array.from(allowedBaseBranches).join('/')} (текущая: ${currentBranch || 'unknown'}).`
				);
			}

			this.logDebug('switchBranch.project.createAndCheckout.start', {
				project,
				targetBranch,
				currentBranch,
			});
			await this.runGitFileMutation(projectPath, ['checkout', '-b', targetBranch]);
			this.logDebug('switchBranch.project.createAndCheckout.done', {
				project,
				targetBranch,
			});
			return;
		}

		this.logDebug('switchBranch.project.checkoutExisting.start', {
			project,
			targetBranch,
		});
		await this.runGitFileMutation(projectPath, ['checkout', targetBranch]);
		await this.pullCurrentBranchIfTracked(projectPath);
		this.logDebug('switchBranch.project.checkoutExisting.done', {
			project,
			targetBranch,
		});
	}

	/** Switch branch in specified projects */
	async switchBranch(
		projectPaths: Map<string, string>,
		projectNames: string[],
		branch: string,
		configuredAllowedBranches?: string[],
	): Promise<GitMultiProjectResult> {
		const errors: string[] = [];
		const changedProjects: string[] = [];
		const skippedProjects: string[] = [];
		const targetBranch = branch.trim();
		const effectiveProjects = projectNames.length > 0
			? projectNames
			: Array.from(projectPaths.keys());
		const allowedBaseBranches = this.getAllowedBaseBranches(configuredAllowedBranches);

		if (!targetBranch) {
			return { success: false, errors: ['Название ветки пустое'], changedProjects, skippedProjects };
		}

		this.logDebug('switchBranch.start', {
			targetBranch,
			projectNames: effectiveProjects,
			allowedBaseBranches: Array.from(allowedBaseBranches),
		});

		for (const project of effectiveProjects) {
			const projectPath = projectPaths.get(project);
			if (!projectPath) {
				this.logDebug('switchBranch.project.missingPath', {
					project,
					targetBranch,
				});
				errors.push(`${project}: workspace folder not found`);
				continue;
			}

			try {
				await this.switchProjectBranch(project, projectPath, targetBranch, allowedBaseBranches);
				changedProjects.push(project);
			} catch (err: any) {
				this.logDebug('switchBranch.project.error', {
					project,
					targetBranch,
					message: err?.stack || err?.message || String(err),
				});
				errors.push(`${project}: ${err.message || 'Unknown error'}`);
			}
		}

		this.logDebug('switchBranch.finish', {
			targetBranch,
			success: errors.length === 0,
			changedProjects,
			errorCount: errors.length,
			errors,
		});

		return { success: errors.length === 0, errors, changedProjects, skippedProjects };
	}

	async switchBranchesByProject(
		projectPaths: Map<string, string>,
		projectNames: string[],
		trackedBranch: string,
		trackedBranchesByProject?: Record<string, string>,
		configuredAllowedBranches?: string[],
	): Promise<GitMultiProjectResult> {
		const errors: string[] = [];
		const changedProjects: string[] = [];
		const skippedProjects: string[] = [];
		const effectiveProjects = projectNames.length > 0
			? projectNames
			: Array.from(projectPaths.keys());
		const branchSelections = this.normalizeTrackedBranchesByProject(
			effectiveProjects,
			trackedBranch,
			trackedBranchesByProject,
		);
		const allowedBaseBranches = this.getAllowedBaseBranches(configuredAllowedBranches);

		this.logDebug('switchBranchesByProject.start', {
			projectNames: effectiveProjects,
			branchSelections,
			allowedBaseBranches: Array.from(allowedBaseBranches),
		});

		for (const project of effectiveProjects) {
			const projectPath = projectPaths.get(project);
			if (!projectPath) {
				errors.push(`${project}: workspace folder not found`);
				continue;
			}

			const targetBranch = (branchSelections[project] || '').trim();
			if (!targetBranch) {
				errors.push(`${project}: не выбрана tracked-ветка.`);
				continue;
			}

			try {
				await this.switchProjectBranch(project, projectPath, targetBranch, allowedBaseBranches);
				changedProjects.push(project);
			} catch (err: any) {
				errors.push(`${project}: ${err.message || 'Unknown error'}`);
			}
		}

		this.logDebug('switchBranchesByProject.finish', {
			success: errors.length === 0,
			changedProjects,
			errorCount: errors.length,
			errors,
		});

		return { success: errors.length === 0, errors, changedProjects, skippedProjects };
	}

	async applyBranchTargetsByProject(
		projectPaths: Map<string, string>,
		projectNames: string[],
		promptBranch: string,
		sourceBranchesByProject?: Record<string, string>,
		targetBranchesByProject?: Record<string, string>,
		configuredAllowedBranches?: string[],
	): Promise<GitMultiProjectResult> {
		const effectiveProjects = projectNames.length > 0
			? projectNames
			: Array.from(projectPaths.keys());
		const normalizedPromptBranch = promptBranch.trim();
		const sourceSelections = this.normalizeTrackedBranchesByProject(
			effectiveProjects,
			'',
			sourceBranchesByProject,
		);
		const targetSelections = this.normalizeTrackedBranchesByProject(
			effectiveProjects,
			'',
			targetBranchesByProject,
		);
		const allowedBaseBranches = this.getAllowedBaseBranches(configuredAllowedBranches);

		this.logDebug('applyBranchTargetsByProject.start', {
			projectNames: effectiveProjects,
			normalizedPromptBranch,
			sourceSelections,
			targetSelections,
			allowedBaseBranches: Array.from(allowedBaseBranches),
		});

		return this.runProjectMutation(projectPaths, effectiveProjects, async (project, projectPath) => {
			const targetBranch = (targetSelections[project] || '').trim();
			if (!targetBranch) {
				throw new Error('Не выбрана ожидаемая ветка.');
			}

			const currentBranch = await this.getCurrentBranch(projectPath);
			if (currentBranch === targetBranch) {
				return false;
			}

			if (normalizedPromptBranch && targetBranch === normalizedPromptBranch) {
				const promptBranchExistsLocally = await this.branchExistsLocally(projectPath, normalizedPromptBranch);
				const promptBranchRemoteRef = promptBranchExistsLocally
					? ''
					: await this.findRemoteBranchRef(projectPath, normalizedPromptBranch);

				if (promptBranchExistsLocally || promptBranchRemoteRef) {
					await this.switchProjectBranch(project, projectPath, normalizedPromptBranch, allowedBaseBranches);
					return;
				}

				const sourceBranch = (sourceSelections[project] || '').trim();
				if (!sourceBranch) {
					throw new Error('Не выбрана исходная tracked-ветка для создания ветки промпта.');
				}

				await this.ensureBranchCheckedOutAndPulled(projectPath, sourceBranch);
				await this.runGitFileMutation(projectPath, ['checkout', '-b', normalizedPromptBranch, sourceBranch]);
				return;
			}

			await this.switchProjectBranch(project, projectPath, targetBranch, allowedBaseBranches);
		});
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

	/** Маппинг пользовательских хостов на провайдера (github / gitlab) из настроек VS Code. */
	static getReviewProviderHostsSetting(): Record<string, string> {
		const raw = vscode.workspace
			.getConfiguration('promptManager')
			.get<unknown>('reviewProviderHosts');

		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			return {};
		}

		const result: Record<string, string> = {};
		for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
			const host = (key || '').trim().toLowerCase();
			const provider = typeof value === 'string' ? value.trim().toLowerCase() : '';
			if (host && (provider === 'github' || provider === 'gitlab')) {
				result[host] = provider;
			}
		}

		return result;
	}

	private getReviewRequestTitlePrefixSetting(): string {
		const configured = vscode.workspace
			.getConfiguration('promptManager')
			.get<string>('gitOverlay.reviewTitlePrefix', '');

		return typeof configured === 'string' && configured.trim() ? configured : '';
	}

	private async getGitUserName(projectPath: string): Promise<string> {
		return (await this.runGitFileCommandOptional(projectPath, ['config', 'user.name'])).trim();
	}

	private async resolveReviewRequestTitlePrefix(projectPath: string): Promise<string> {
		const configuredPrefix = this.getReviewRequestTitlePrefixSetting();
		if (configuredPrefix) {
			return configuredPrefix;
		}

		return await this.getGitUserName(projectPath);
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
		const normalizedTrackedBranches = Array.from(new Set(
			trackedBranches.map(branch => branch.trim()).filter(Boolean),
		));
		const projects = await Promise.all(
			this.getEffectiveProjects(projectPaths, projectNames)
				.map(({ project, projectPath }) => this.buildProjectSnapshot(project, projectPath, promptBranch, normalizedTrackedBranches)),
		);
		const resolvedTrackedBranches = resolveExistingGitOverlayTrackedBranches(normalizedTrackedBranches, projects);

		return {
			generatedAt: new Date().toISOString(),
			promptBranch: promptBranch.trim(),
			trackedBranches: resolvedTrackedBranches,
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

	private async discardProjectChange(
		projectPath: string,
		filePath: string,
		group: GitOverlayChangeGroup,
		previousPath?: string,
	): Promise<void> {
		const affectedPaths = previousPath && previousPath !== filePath
			? [filePath, previousPath]
			: [filePath];

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
			await this.discardProjectChange(projectPath, affectedPaths[0], group, affectedPaths[1]);
		});
	}

	async discardProjectChanges(
		projectPaths: Map<string, string>,
		projectName: string,
		changes: GitOverlayChangeFile[],
	): Promise<GitMultiProjectResult> {
		const normalizedChanges = changes.filter(change => Boolean(change.path.trim()));
		const uniqueChanges = Array.from(new Map(
			normalizedChanges.map(change => {
				const previousPath = (change.previousPath || '').trim();
				const key = [change.group, change.path.trim(), previousPath, change.status.trim()].join('::');
				return [key, change] as const;
			}),
		).values());

		return this.runProjectMutation(projectPaths, [projectName], async (_project, projectPath) => {
			if (uniqueChanges.length === 0) {
				return false;
			}

			for (const change of uniqueChanges) {
				await this.discardProjectChange(projectPath, change.path, change.group, change.previousPath);
			}
		});
	}

	async ensurePromptBranchFromTracked(
		projectPaths: Map<string, string>,
		projectNames: string[],
		promptBranch: string,
		trackedBranch: string,
		trackedBranchesByProject?: Record<string, string>,
	): Promise<GitMultiProjectResult> {
		const normalizedPromptBranch = promptBranch.trim();
		const effectiveProjects = projectNames.length > 0
			? projectNames
			: Array.from(projectPaths.keys());
		const branchSelections = this.normalizeTrackedBranchesByProject(
			effectiveProjects,
			trackedBranch,
			trackedBranchesByProject,
		);
		if (!normalizedPromptBranch) {
			return { success: false, errors: ['Название ветки промпта пустое.'], changedProjects: [], skippedProjects: [] };
		}

		return this.runProjectMutation(projectPaths, effectiveProjects, async (project, projectPath) => {
			const trackedBranchForProject = (branchSelections[project] || '').trim();
			if (!trackedBranchForProject) {
				throw new Error('Не выбрана tracked-ветка.');
			}

			await this.ensureBranchCheckedOutAndPulled(projectPath, trackedBranchForProject);
			if (await this.branchExistsLocally(projectPath, normalizedPromptBranch)) {
				await this.runGitFileMutation(projectPath, ['checkout', normalizedPromptBranch]);
				await this.pullCurrentBranchIfTracked(projectPath);
				return;
			}
			await this.runGitFileMutation(projectPath, ['checkout', '-b', normalizedPromptBranch, trackedBranchForProject]);
		});
	}

	async mergePromptBranchIntoTracked(
		projectPaths: Map<string, string>,
		projectNames: string[],
		promptBranch: string,
		trackedBranch: string,
		trackedBranchesByProject?: Record<string, string>,
		stayOnTrackedBranch = true,
	): Promise<GitMergeProjectsResult> {
		const normalizedPromptBranch = promptBranch.trim();
		const effectiveProjects = projectNames.length > 0
			? projectNames
			: Array.from(projectPaths.keys());
		const branchSelections = this.normalizeTrackedBranchesByProject(
			effectiveProjects,
			trackedBranch,
			trackedBranchesByProject,
		);
		if (!normalizedPromptBranch) {
			return { success: false, errors: ['Название ветки промпта пустое.'], changedProjects: [], skippedProjects: [], conflicts: [] };
		}

		const result: GitMergeProjectsResult = {
			success: true,
			errors: [],
			changedProjects: [],
			skippedProjects: [],
			conflicts: [],
		};

		for (const { project, projectPath } of this.getEffectiveProjects(projectPaths, effectiveProjects)) {
			const trackedBranchForProject = (branchSelections[project] || '').trim();
			if (!trackedBranchForProject) {
				result.errors.push(`${project}: Не выбрана tracked-ветка для merge.`);
				continue;
			}

			try {
				await this.ensureBranchCheckedOutAndPulled(projectPath, trackedBranchForProject);
				try {
					await this.runGitFileMutation(projectPath, ['merge', '--no-edit', normalizedPromptBranch]);
					if (!stayOnTrackedBranch) {
						await this.ensureBranchCheckedOutAndPulled(projectPath, normalizedPromptBranch);
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

	async createReviewRequests(
		projectPaths: Map<string, string>,
		prompt: Prompt,
		requests: GitOverlayProjectReviewRequestInput[],
	): Promise<GitMultiProjectResult> {
		const promptBranch = (prompt.branch || '').trim();
		if (!promptBranch) {
			return { success: false, errors: ['Название ветки промпта пустое.'], changedProjects: [], skippedProjects: [] };
		}

		const normalizedRequests = Array.from(new Map(
			(requests || [])
				.map((item) => ({
					project: (item.project || '').trim(),
					targetBranch: (item.targetBranch || '').trim(),
					title: (item.title || '').trim(),
					draft: item.draft !== false,
					removeSourceBranch: item.removeSourceBranch === true,
				}))
				.filter(item => Boolean(item.project) && Boolean(item.targetBranch) && Boolean(item.title))
				.map(item => [item.project, item]),
		).values());

		if (normalizedRequests.length === 0) {
			return { success: false, errors: ['Не выбраны проекты для создания MR/PR.'], changedProjects: [], skippedProjects: [] };
		}

		const result: GitMultiProjectResult = {
			success: true,
			errors: [],
			changedProjects: [],
			skippedProjects: [],
		};

		const body = this.buildReviewRequestBody(prompt);

		for (const item of normalizedRequests) {
			const projectPath = projectPaths.get(item.project);
			if (!projectPath) {
				result.errors.push(`${item.project}: workspace folder not found`);
				continue;
			}

			try {
				const remote = await this.getReviewRemote(projectPath, promptBranch);
				if (!remote || !remote.supported) {
					result.errors.push(`${item.project}: поддержка MR/PR доступна только для GitHub и GitLab.`);
					continue;
				}
				if (!remote.cliAvailable) {
					result.errors.push(`${item.project}: CLI ${remote.cliCommand} не найден.`);
					continue;
				}
				const cliCommand = remote.cliCommand;
				if (cliCommand !== 'gh' && cliCommand !== 'glab') {
					result.errors.push(`${item.project}: CLI для этого провайдера не поддерживается.`);
					continue;
				}
				const authenticated = await this.isCliAuthenticated(cliCommand, projectPath, remote.host);
				if (!authenticated) {
					result.errors.push(`${item.project}: CLI ${cliCommand} не авторизован.`);
					continue;
				}

				const existingRequest = await this.getExistingReviewRequest(projectPath, remote, promptBranch);
				if (existingRequest) {
					result.skippedProjects.push(item.project);
					continue;
				}

				if (remote.provider === 'github') {
					await this.createGitHubReviewRequest(projectPath, remote, promptBranch, item.targetBranch, item.title, body, item.draft);
				} else {
					await this.createGitLabReviewRequest(projectPath, remote, promptBranch, item.targetBranch, item.title, body, item.draft, item.removeSourceBranch);
				}

				result.changedProjects.push(item.project);
			} catch (error) {
				result.errors.push(`${item.project}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		result.success = result.errors.length === 0;
		return result;
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
			const currentBranchRecord = await this.getCurrentLocalBranchRecord(projectPath);
			if (!currentBranchRecord) {
				return false;
			}
			if (!currentBranchRecord.upstream || currentBranchRecord.behind <= 0 || currentBranchRecord.stale) {
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
