/**
 * MemoryGitHookService — Installs, updates, and manages git post-commit hooks
 * for all workspace repositories. The hook sends commit data to the local
 * HTTP server run by MemoryHttpServerService.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Version marker inside hook files for upgrade detection */
const HOOK_VERSION = '1';

/** Marker comment identifying hooks managed by this extension */
const HOOK_MARKER = '# prompt-manager-memory-hook';

export class MemoryGitHookService {
	/**
	 * Install hooks for all git repositories in the workspace.
	 * @param workspaceFolders Folder paths to scan for .git directories
	 * @param port HTTP server port
	 * @param token Authentication token
	 */
	async installHooksForWorkspace(
		workspaceFolders: string[],
		port: number,
		token: string,
	): Promise<void> {
		for (const folder of workspaceFolders) {
			const gitDir = path.join(folder, '.git');
			if (fs.existsSync(gitDir) && fs.statSync(gitDir).isDirectory()) {
				await this.installHook(folder, port, token);
			}
		}
	}

	/**
	 * Install or update the post-commit hook for a single repository.
	 * Preserves existing non-managed hook content.
	 */
	async installHook(repoPath: string, port: number, token: string): Promise<void> {
		const hooksDir = path.join(repoPath, '.git', 'hooks');
		const hookPath = path.join(hooksDir, 'post-commit');

		// Ensure hooks directory exists
		if (!fs.existsSync(hooksDir)) {
			fs.mkdirSync(hooksDir, { recursive: true });
		}

		// Write port and token files for the hook to read
		this.writeHookConfig(repoPath, port, token);

		// Generate hook script content
		const hookScript = this.generateHookScript();

		if (fs.existsSync(hookPath)) {
			const existing = fs.readFileSync(hookPath, 'utf-8');

			// If hook already has our marker, replace our section
			if (existing.includes(HOOK_MARKER)) {
				const updated = this.replaceHookSection(existing, hookScript);
				fs.writeFileSync(hookPath, updated, { mode: 0o755 });
			} else {
				// Append our hook to the existing file
				const combined = existing.trimEnd() + '\n\n' + hookScript;
				fs.writeFileSync(hookPath, combined, { mode: 0o755 });
			}
		} else {
			// Create new hook file
			const content = '#!/bin/sh\n\n' + hookScript;
			fs.writeFileSync(hookPath, content, { mode: 0o755 });
		}
	}

	/**
	 * Update port and token in .git/ config files when server restarts.
	 */
	updateHookConfig(repoPath: string, port: number, token: string): void {
		this.writeHookConfig(repoPath, port, token);
	}

	/**
	 * Remove the managed hook section from a repository.
	 */
	removeHook(repoPath: string): void {
		const hookPath = path.join(repoPath, '.git', 'hooks', 'post-commit');
		if (!fs.existsSync(hookPath)) { return; }

		const content = fs.readFileSync(hookPath, 'utf-8');
		if (!content.includes(HOOK_MARKER)) { return; }

		// Remove our section
		const cleaned = this.removeHookSection(content);
		if (cleaned.trim() === '#!/bin/sh' || cleaned.trim() === '') {
			// No other hook content — delete the file
			fs.unlinkSync(hookPath);
		} else {
			fs.writeFileSync(hookPath, cleaned, { mode: 0o755 });
		}

		// Remove config files
		this.removeHookConfig(repoPath);
	}

	/**
	 * Check if the hook is installed and up-to-date.
	 * @returns 'installed' | 'outdated' | 'missing'
	 */
	checkHookInstalled(repoPath: string): 'installed' | 'outdated' | 'missing' {
		const hookPath = path.join(repoPath, '.git', 'hooks', 'post-commit');
		if (!fs.existsSync(hookPath)) { return 'missing'; }

		const content = fs.readFileSync(hookPath, 'utf-8');
		if (!content.includes(HOOK_MARKER)) { return 'missing'; }

		// Check version
		const versionMatch = content.match(/# pm-hook-version:(\d+)/);
		if (!versionMatch || versionMatch[1] !== HOOK_VERSION) { return 'outdated'; }

		return 'installed';
	}

	/**
	 * Get commit data from a repository using git commands.
	 * Used for manual analysis of historical commits.
	 */
	async getCommitData(
		repoPath: string,
		sha: string,
	): Promise<{
		author: string;
		email: string;
		date: string;
		branch: string;
		parentSha: string;
		message: string;
		diff: string;
		files: Array<{ status: string; path: string; oldPath?: string }>;
	} | null> {
		try {
			// Get commit metadata
			const { stdout: logOutput } = await execFileAsync('git', [
				'log', '-1', '--format=%an%n%ae%n%aI%n%P%n%B', sha,
			], { cwd: repoPath, maxBuffer: 8 * 1024 * 1024 });

			const lines = logOutput.split('\n');
			const author = lines[0] || '';
			const email = lines[1] || '';
			const date = lines[2] || '';
			const parentSha = (lines[3] || '').split(' ')[0] || '';
			const message = lines.slice(4).join('\n').trim();

			// Get current branch
			let branch = '';
			try {
				const { stdout: branchOutput } = await execFileAsync('git', [
					'branch', '--contains', sha, '--format=%(refname:short)',
				], { cwd: repoPath });
				branch = branchOutput.split('\n')[0]?.trim() || '';
			} catch {
				branch = 'unknown';
			}

			// Get diff
			const diffArgs = parentSha
				? ['diff', parentSha, sha]
				: ['diff', '--root', sha];
			let diff = '';
			try {
				const { stdout: diffOutput } = await execFileAsync('git', diffArgs, {
					cwd: repoPath,
					maxBuffer: 8 * 1024 * 1024,
				});
				diff = diffOutput;
			} catch {
				diff = '';
			}

			// Get changed files
			const filesArgs = parentSha
				? ['diff', '--name-status', parentSha, sha]
				: ['diff', '--name-status', '--root', sha];
			let files: Array<{ status: string; path: string; oldPath?: string }> = [];
			try {
				const { stdout: filesOutput } = await execFileAsync('git', filesArgs, {
					cwd: repoPath,
					maxBuffer: 8 * 1024 * 1024,
				});
				files = filesOutput
					.split('\n')
					.filter(Boolean)
					.map(line => {
						const parts = line.split('\t');
						const status = parts[0] || '';
						if (status.startsWith('R') || status.startsWith('C')) {
							return { status: status[0], path: parts[2] || '', oldPath: parts[1] };
						}
						return { status: status[0], path: parts[1] || '' };
					});
			} catch {
				files = [];
			}

			return { author, email, date, branch, parentSha, message, diff, files };
		} catch {
			return null;
		}
	}

	/**
	 * Get list of commit SHAs from a repository.
	 * @param repoPath Path to the repository
	 * @param limit Maximum number of commits
	 * @param fromSha Start from this SHA (exclusive)
	 */
	async getCommitShas(
		repoPath: string,
		limit: number,
		fromSha?: string,
	): Promise<string[]> {
		try {
			const args = ['log', '--format=%H', `-n${limit}`];
			if (fromSha) {
				args.push(`${fromSha}..HEAD`);
			}
			const { stdout } = await execFileAsync('git', args, {
				cwd: repoPath,
				maxBuffer: 8 * 1024 * 1024,
			});
			return stdout.split('\n').filter(Boolean);
		} catch {
			return [];
		}
	}

	/**
	 * Get the repository name from a folder path.
	 */
	getRepositoryName(repoPath: string): string {
		return path.basename(repoPath);
	}

	// ---- Private helpers ----

	/** Write port and token files to .git/ directory */
	private writeHookConfig(repoPath: string, port: number, token: string): void {
		const gitDir = path.join(repoPath, '.git');
		fs.writeFileSync(path.join(gitDir, 'prompt-manager-port'), String(port), 'utf-8');
		fs.writeFileSync(path.join(gitDir, 'prompt-manager-token'), token, { encoding: 'utf-8', mode: 0o600 });
	}

	/** Remove port and token files from .git/ */
	private removeHookConfig(repoPath: string): void {
		const gitDir = path.join(repoPath, '.git');
		const portFile = path.join(gitDir, 'prompt-manager-port');
		const tokenFile = path.join(gitDir, 'prompt-manager-token');
		if (fs.existsSync(portFile)) { fs.unlinkSync(portFile); }
		if (fs.existsSync(tokenFile)) { fs.unlinkSync(tokenFile); }
	}

	/**
	 * Generate the bash hook script content.
	 * The script reads port/token from .git/, collects commit data, and sends it
	 * to the local HTTP server. Runs async with `&` to not block the commit.
	 */
	private generateHookScript(): string {
		return `${HOOK_MARKER}
# pm-hook-version:${HOOK_VERSION}
# Managed by Copilot Prompt Manager — do not edit this section manually
(
  GIT_DIR="$(git rev-parse --git-dir 2>/dev/null)"
  PM_PORT_FILE="\${GIT_DIR}/prompt-manager-port"
  PM_TOKEN_FILE="\${GIT_DIR}/prompt-manager-token"

  # Exit silently if config files are missing (VS Code not running)
  [ -f "\${PM_PORT_FILE}" ] && [ -f "\${PM_TOKEN_FILE}" ] || exit 0

  PM_PORT="$(cat "\${PM_PORT_FILE}")"
  PM_TOKEN="$(cat "\${PM_TOKEN_FILE}")"

  # Collect commit data
  COMMIT_SHA="$(git rev-parse HEAD)"
  AUTHOR="$(git log -1 --format='%an')"
  EMAIL="$(git log -1 --format='%ae')"
  DATE="$(git log -1 --format='%aI')"
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  PARENT_SHA="$(git log -1 --format='%P' | cut -d' ' -f1)"
  MESSAGE="$(git log -1 --format='%B')"
  REPO_NAME="$(basename "$(git rev-parse --show-toplevel)")"

  # Get diff (limited to 200KB to avoid huge payloads)
  DIFF="$(git diff HEAD~1 HEAD 2>/dev/null | head -c 204800)"

  # Get changed files as JSON array
  FILES_JSON="$(git diff --name-status HEAD~1 HEAD 2>/dev/null | awk -F'\\t' '
    BEGIN { printf "[" }
    NR>1 { printf "," }
    {
      status=$1; path=$NF; oldPath=""
      if (status ~ /^[RC]/) { oldPath=$2; path=$3 }
      gsub(/"/, "\\\\\\\\\\\\\"", path)
      gsub(/"/, "\\\\\\\\\\\\\"", oldPath)
      if (oldPath != "") {
        printf "{\\"status\\":\\"%s\\",\\"path\\":\\"%s\\",\\"oldPath\\":\\"%s\\"}", substr(status,1,1), path, oldPath
      } else {
        printf "{\\"status\\":\\"%s\\",\\"path\\":\\"%s\\"}", substr(status,1,1), path
      }
    }
    END { printf "]" }
  ')"

  # Escape message and diff for JSON
  MESSAGE_ESC="$(printf '%s' "\${MESSAGE}" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "\${MESSAGE}")"
  DIFF_ESC="$(printf '%s' "\${DIFF}" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '""')"

  # Build JSON payload
  PAYLOAD="$(cat <<ENDPAYLOAD
{
  "sha": "\${COMMIT_SHA}",
  "author": "\${AUTHOR}",
  "email": "\${EMAIL}",
  "date": "\${DATE}",
  "branch": "\${BRANCH}",
  "repository": "\${REPO_NAME}",
  "parentSha": "\${PARENT_SHA}",
  "message": \${MESSAGE_ESC},
  "diff": \${DIFF_ESC},
  "files": \${FILES_JSON:-[]}
}
ENDPAYLOAD
)"

  # Send to local HTTP server (timeout 5s, async)
  curl -s -X POST \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer \${PM_TOKEN}" \\
    -d "\${PAYLOAD}" \\
    --connect-timeout 2 --max-time 5 \\
    "http://127.0.0.1:\${PM_PORT}/commit" >/dev/null
) &
# end prompt-manager-memory-hook`;
	}

	/** Replace the managed hook section in existing hook content */
	private replaceHookSection(existingContent: string, newSection: string): string {
		const startMarker = HOOK_MARKER;
		const endMarker = '# end prompt-manager-memory-hook';
		const startIdx = existingContent.indexOf(startMarker);
		const endIdx = existingContent.indexOf(endMarker);

		if (startIdx === -1 || endIdx === -1) {
			return existingContent + '\n\n' + newSection;
		}

		const before = existingContent.substring(0, startIdx);
		const after = existingContent.substring(endIdx + endMarker.length);
		return before + newSection + after;
	}

	/** Remove the managed hook section from content */
	private removeHookSection(content: string): string {
		const startMarker = HOOK_MARKER;
		const endMarker = '# end prompt-manager-memory-hook';
		const startIdx = content.indexOf(startMarker);
		const endIdx = content.indexOf(endMarker);

		if (startIdx === -1 || endIdx === -1) { return content; }

		const before = content.substring(0, startIdx);
		const after = content.substring(endIdx + endMarker.length);
		return (before + after).replace(/\n{3,}/g, '\n\n');
	}
}
