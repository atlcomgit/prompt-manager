/**
 * Git service — branch management and status checks
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface BranchInfo {
	name: string;
	current: boolean;
	project: string;
}

export class GitService {
	/** Get branches for specified projects */
	async getBranches(projectPaths: Map<string, string>, projectNames: string[]): Promise<BranchInfo[]> {
		const branches: BranchInfo[] = [];

		for (const project of projectNames) {
			const projectPath = projectPaths.get(project);
			if (!projectPath) { continue; }

			try {
				const { stdout } = await execAsync('git branch --no-color', { cwd: projectPath });
				const lines = stdout.split('\n').filter(l => l.trim());

				for (const line of lines) {
					const isCurrent = line.startsWith('*');
					const name = line.replace(/^\*?\s+/, '').trim();
					if (name) {
						branches.push({ name, current: isCurrent, project });
					}
				}
			} catch {
				// Not a git repo or git not available
			}
		}

		return branches;
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
		branch: string
	): Promise<{ success: boolean; errors: string[] }> {
		const errors: string[] = [];

		for (const project of projectNames) {
			const projectPath = projectPaths.get(project);
			if (!projectPath) {
				errors.push(`${project}: workspace folder not found`);
				continue;
			}

			try {
				// Check if branch exists
				const { stdout } = await execAsync(
					`git branch --list "${branch}"`,
					{ cwd: projectPath }
				);

				if (!stdout.trim()) {
					// Branch doesn't exist — create it
					await execAsync(`git checkout -b "${branch}"`, { cwd: projectPath });
				} else {
					await execAsync(`git checkout "${branch}"`, { cwd: projectPath });
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
		branch: string
	): Promise<{ success: boolean; errors: string[] }> {
		const errors: string[] = [];

		for (const project of projectNames) {
			const projectPath = projectPaths.get(project);
			if (!projectPath) {
				errors.push(`${project}: workspace folder not found`);
				continue;
			}

			try {
				await execAsync(`git checkout -b "${branch}"`, { cwd: projectPath });
			} catch (err: any) {
				errors.push(`${project}: ${err.message || 'Unknown error'}`);
			}
		}

		return { success: errors.length === 0, errors };
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
