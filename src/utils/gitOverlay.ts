import type {
	GitOverlayBranchKind,
	GitOverlayGraphEdge,
	GitOverlayGraphNode,
	GitOverlayReviewProvider,
	GitOverlayReviewRequestState,
	GitOverlayReviewSetupAction,
} from '../types/git.js';

type ParsedGitOverlayRemote = {
	provider: GitOverlayReviewProvider;
	host: string;
	repositoryPath: string;
	owner: string;
	name: string;
	supported: boolean;
	cliCommand: 'gh' | 'glab' | '';
	actionLabel: string;
};

type GitOverlayReviewCliSetupCommand = {
	terminalName: string;
	command: string;
	manualUrl: string;
};

function normalizeInteractiveTerminalCommand(command: string): string {
	return command.replace(/\t/g, '    ');
}

function quoteShellArg(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function quotePowerShellArg(value: string): string {
	return `'${value.replace(/'/g, `''`)}'`;
}

function resolveReviewCliManualUrl(cliCommand: 'gh' | 'glab'): string {
	return cliCommand === 'gh'
		? 'https://cli.github.com/'
		: 'https://docs.gitlab.com/cli/';
}

function buildReviewCliAuthCommand(cliCommand: 'gh' | 'glab', host: string, platform: string): string {
	if (platform === 'win32') {
		const quotedHost = quotePowerShellArg(host);
		return cliCommand === 'gh'
			? `gh auth login --hostname ${quotedHost} --web`
			: `glab auth login --hostname ${quotedHost}`;
	}

	const quotedHost = quoteShellArg(host);
	return cliCommand === 'gh'
		? `gh auth login --hostname ${quotedHost} --web`
		: `glab auth login --hostname ${quotedHost}`;
}

function buildPosixReviewCliInstallCommand(cliCommand: 'gh' | 'glab', manualUrl: string): string {
	const installPackage = cliCommand === 'gh' ? 'gh' : 'glab';
	const pacmanPackage = cliCommand === 'gh' ? 'github-cli' : 'glab';
	const installBody = cliCommand === 'gh'
		? [
			'if command -v brew >/dev/null; then',
			'    brew install gh',
			'    return',
			'fi',
			'if command -v apt-get >/dev/null; then',
			'    run_privileged mkdir -p /etc/apt/keyrings',
			'    if command -v curl >/dev/null; then',
			'        curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | run_privileged tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null',
			'    elif command -v wget >/dev/null; then',
			'        wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | run_privileged tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null',
			'    else',
			'        echo "[Prompt Manager] curl or wget is required to install gh on Debian/Ubuntu."',
			`        echo "[Prompt Manager] Manual install: ${manualUrl}"`,
			'        exit 1',
			'    fi',
			'    run_privileged chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg',
			'    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | run_privileged tee /etc/apt/sources.list.d/github-cli.list >/dev/null',
			'    run_privileged apt-get update',
			'    run_privileged apt-get install -y gh',
			'    return',
			'fi',
		]
		: [
			'if command -v brew >/dev/null; then',
			'    brew install glab',
			'    return',
			'fi',
		];

	return normalizeInteractiveTerminalCommand([
		'set -e',
		'set -o pipefail',
		'run_privileged() {',
		'    if command -v sudo >/dev/null; then',
		'        sudo "$@"',
		'    else',
		'        "$@"',
		'    fi',
		'}',
		'install_review_cli() {',
		...installBody,
		'    if command -v dnf >/dev/null; then',
		`        run_privileged dnf install -y ${installPackage}`,
		'        return',
		'    fi',
		'    if command -v yum >/dev/null; then',
		`        run_privileged yum install -y ${installPackage}`,
		'        return',
		'    fi',
		'    if command -v pacman >/dev/null; then',
		`        run_privileged pacman -Sy --noconfirm ${pacmanPackage}`,
		'        return',
		'    fi',
		'    if command -v zypper >/dev/null; then',
		`        run_privileged zypper --non-interactive install ${installPackage}`,
		'        return',
		'    fi',
		`    echo "[Prompt Manager] No supported package manager was detected for automatic ${cliCommand} installation."`,
		`    echo "[Prompt Manager] Manual install: ${manualUrl}"`,
		'    exit 1',
		'}',
		`if ! command -v ${cliCommand} >/dev/null; then`,
		`    echo "[Prompt Manager] Installing ${cliCommand}..."`,
		'    install_review_cli',
		'fi',
	].join('\n'));
}

function buildWindowsReviewCliInstallCommand(cliCommand: 'gh' | 'glab', host: string, action: GitOverlayReviewSetupAction, manualUrl: string): string {
	const wingetId = cliCommand === 'gh' ? 'GitHub.cli' : 'GLab.GLab';
	const chocoId = cliCommand === 'gh' ? 'gh' : 'glab';
	const scoopId = cliCommand === 'gh' ? 'gh' : 'glab';
	const authCommand = buildReviewCliAuthCommand(cliCommand, host, 'win32');
	const installCommand = action === 'install-and-auth'
		? [
			`if (-not (Get-Command ${cliCommand} -ErrorAction SilentlyContinue)) {`,
			`    Write-Host '[Prompt Manager] Installing ${cliCommand}...'`,
			"    if (Get-Command winget -ErrorAction SilentlyContinue) {",
			`        winget install -e --id ${wingetId} --accept-package-agreements --accept-source-agreements`,
			"    } elseif (Get-Command choco -ErrorAction SilentlyContinue) {",
			`        choco install ${chocoId} -y`,
			"    } elseif (Get-Command scoop -ErrorAction SilentlyContinue) {",
			`        scoop install ${scoopId}`,
			'    } else {',
			`        Write-Host '[Prompt Manager] No supported package manager was detected for automatic ${cliCommand} installation.'`,
			`        Write-Host '[Prompt Manager] Manual install: ${manualUrl}'`,
			'        exit 1',
			'    }',
			'}',
		].join('\n')
		: '';

	return normalizeInteractiveTerminalCommand([
		"$ErrorActionPreference = 'Stop'",
		installCommand,
		`Write-Host '[Prompt Manager] Opening ${cliCommand} authentication...'`,
		authCommand,
		`Write-Host '[Prompt Manager] ${cliCommand} is ready. Return to Git Flow and refresh the overlay.'`,
	].filter(Boolean).join('\n'));
}

export function buildGitOverlayReviewCliSetupCommand(input: {
	platform: string;
	cliCommand: 'gh' | 'glab';
	host: string;
	action: GitOverlayReviewSetupAction;
}): GitOverlayReviewCliSetupCommand {
	const host = input.host.trim() || (input.cliCommand === 'gh' ? 'github.com' : 'gitlab.com');
	const manualUrl = resolveReviewCliManualUrl(input.cliCommand);
	const authCommand = buildReviewCliAuthCommand(input.cliCommand, host, input.platform);

	if (input.platform === 'win32') {
		return {
			terminalName: `Prompt Manager ${input.cliCommand}`,
			manualUrl,
			command: buildWindowsReviewCliInstallCommand(input.cliCommand, host, input.action, manualUrl),
		};
	}

	const installCommand = input.action === 'install-and-auth'
		? buildPosixReviewCliInstallCommand(input.cliCommand, manualUrl)
		: ['set -e', 'set -o pipefail'].join('\n');

	return {
		terminalName: `Prompt Manager ${input.cliCommand}`,
		manualUrl,
		command: normalizeInteractiveTerminalCommand([
			installCommand,
			`echo "[Prompt Manager] Opening ${input.cliCommand} authentication..."`,
			authCommand,
			`echo "[Prompt Manager] ${input.cliCommand} is ready. Return to Git Flow and refresh the overlay."`,
		].join('\n')),
	};
}

export function resolveGitOverlayBranchNames(
	trackedBranches: string[],
	promptBranch: string,
	currentBranch: string,
): string[] {
	const result = new Set<string>();

	for (const branch of trackedBranches) {
		const normalized = branch.trim();
		if (normalized) {
			result.add(normalized);
		}
	}

	const normalizedPromptBranch = promptBranch.trim();
	if (normalizedPromptBranch) {
		result.add(normalizedPromptBranch);
	}

	const normalizedCurrentBranch = currentBranch.trim();
	if (normalizedCurrentBranch) {
		result.add(normalizedCurrentBranch);
	}

	return [...result];
}

export function canDeleteGitOverlayBranch(
	branchName: string,
	currentBranch: string,
	trackedBranches: string[],
	promptBranch: string,
): boolean {
	const normalizedBranch = branchName.trim();
	if (!normalizedBranch) {
		return false;
	}

	if (normalizedBranch === currentBranch.trim()) {
		return false;
	}

	if (normalizedBranch === promptBranch.trim()) {
		return false;
	}

	return !trackedBranches
		.map(branch => branch.trim())
		.filter(Boolean)
		.includes(normalizedBranch);
}

export function normalizeCommitMessageGenerationInstructions(value: unknown): string {
	if (typeof value === 'string') {
		return value.trim();
	}

	if (Array.isArray(value)) {
		return value
			.map(item => String(item || '').trim())
			.filter(Boolean)
			.join('\n');
	}

	return '';
}

export function buildGitOverlayGraph(input: {
	branchNames: string[];
	trackedBranches: string[];
	promptBranch: string;
	currentBranch: string;
	currentUpstream?: string;
}): { nodes: GitOverlayGraphNode[]; edges: GitOverlayGraphEdge[] } {
	const nodes = new Map<string, GitOverlayGraphNode>();
	const edges = new Map<string, GitOverlayGraphEdge>();

	const addNode = (name: string, kind: GitOverlayBranchKind, current = false) => {
		const normalized = name.trim();
		if (!normalized) {
			return;
		}

		const existing = nodes.get(normalized);
		if (existing) {
			nodes.set(normalized, {
				...existing,
				kind: existing.kind === 'current' || existing.kind === 'prompt' ? existing.kind : kind,
				current: existing.current || current,
			});
			return;
		}

		nodes.set(normalized, {
			id: normalized,
			label: normalized,
			kind,
			current,
		});
	};

	for (const branchName of input.branchNames) {
		const normalized = branchName.trim();
		if (!normalized) {
			continue;
		}

		let kind: GitOverlayBranchKind = 'local';
		if (normalized === input.currentBranch.trim()) {
			kind = 'current';
		} else if (normalized === input.promptBranch.trim()) {
			kind = 'prompt';
		} else if (input.trackedBranches.map(branch => branch.trim()).includes(normalized)) {
			kind = 'tracked';
		}

		addNode(normalized, kind, normalized === input.currentBranch.trim());
	}

	const normalizedPromptBranch = input.promptBranch.trim();
	if (normalizedPromptBranch) {
		addNode(normalizedPromptBranch, 'prompt', normalizedPromptBranch === input.currentBranch.trim());
	}

	for (const trackedBranch of input.trackedBranches) {
		const normalizedTrackedBranch = trackedBranch.trim();
		if (!normalizedTrackedBranch) {
			continue;
		}

		addNode(normalizedTrackedBranch, 'tracked', normalizedTrackedBranch === input.currentBranch.trim());
		if (normalizedPromptBranch && normalizedPromptBranch !== normalizedTrackedBranch) {
			edges.set(
				`${normalizedPromptBranch}->${normalizedTrackedBranch}:prompt-base`,
				{
					from: normalizedPromptBranch,
					to: normalizedTrackedBranch,
					kind: 'prompt-base',
					label: 'base',
				},
			);
		}
		if (!normalizedPromptBranch) {
			continue;
		}
		edges.set(
			`${normalizedTrackedBranch}->${normalizedPromptBranch}:tracked`,
			{
				from: normalizedTrackedBranch,
				to: normalizedPromptBranch,
				kind: 'tracked',
				label: 'tracked',
			},
		);
	}

	const normalizedCurrentBranch = input.currentBranch.trim();
	const normalizedCurrentUpstream = (input.currentUpstream || '').trim();
	if (normalizedCurrentBranch && normalizedCurrentUpstream) {
		addNode(normalizedCurrentBranch, 'current', true);
		addNode(normalizedCurrentUpstream, 'remote');
		edges.set(
			`${normalizedCurrentBranch}->${normalizedCurrentUpstream}:current-upstream`,
			{
				from: normalizedCurrentBranch,
				to: normalizedCurrentUpstream,
				kind: 'current-upstream',
				label: 'upstream',
			},
		);
	}

	return {
		nodes: [...nodes.values()],
		edges: [...edges.values()],
	};
}

export function parseGitOverlayRemoteUrl(remoteUrl: string): ParsedGitOverlayRemote | null {
	const normalizedRemoteUrl = remoteUrl.trim();
	if (!normalizedRemoteUrl) {
		return null;
	}

	let host = '';
	let repositoryPath = '';

	if (/^[^@\s]+@[^:\s]+:.+$/.test(normalizedRemoteUrl)) {
		const [authority, pathPart] = normalizedRemoteUrl.split(':', 2);
		host = authority.split('@')[1] || '';
		repositoryPath = pathPart || '';
	} else {
		try {
			const parsed = new URL(normalizedRemoteUrl);
			host = parsed.hostname;
			repositoryPath = parsed.pathname || '';
		} catch {
			return null;
		}
	}

	const cleanedPath = repositoryPath
		.replace(/^\/+/, '')
		.replace(/\.git$/i, '')
		.replace(/\/+$/, '');
	if (!host || !cleanedPath) {
		return null;
	}

	const segments = cleanedPath.split('/').filter(Boolean);
	if (segments.length < 2) {
		return null;
	}

	const normalizedHost = host.trim().toLowerCase();
	const provider: GitOverlayReviewProvider = normalizedHost.includes('gitlab')
		? 'gitlab'
		: normalizedHost.includes('github')
			? 'github'
			: 'unknown';

	return {
		provider,
		host: host.trim(),
		repositoryPath: cleanedPath,
		owner: segments[0],
		name: segments[segments.length - 1],
		supported: provider === 'github' || provider === 'gitlab',
		cliCommand: provider === 'github' ? 'gh' : provider === 'gitlab' ? 'glab' : '',
		actionLabel: provider === 'github' ? 'Pull request' : provider === 'gitlab' ? 'Merge request' : 'Review request',
	};
}

export function normalizeGitOverlayReviewRequestState(input: {
	state: string;
	mergedAt?: string | null;
	merged?: boolean;
}): GitOverlayReviewRequestState {
	if (input.merged === true || Boolean((input.mergedAt || '').trim())) {
		return 'accepted';
	}

	const normalizedState = input.state.trim().toLowerCase();
	if (normalizedState === 'merged' || normalizedState === 'accepted') {
		return 'accepted';
	}
	if (normalizedState === 'open' || normalizedState === 'opened') {
		return 'open';
	}
	return 'closed';
}

export function buildGitOverlayReviewRequestTitle(input: {
	promptTitle: string;
	taskNumber?: string;
	projectName?: string;
	projectCount?: number;
}): string {
	const MAX_TITLE_LENGTH = 180;
	const normalizedTitle = input.promptTitle.trim();
	const normalizedTaskNumber = (input.taskNumber || '').trim();
	const normalizedProjectName = (input.projectName || '').trim();
	const projectCount = Math.max(0, input.projectCount || 0);
	const truncate = (value: string): string => {
		if (value.length <= MAX_TITLE_LENGTH) {
			return value;
		}

		const shortened = value.slice(0, MAX_TITLE_LENGTH - 1);
		const lastSpace = shortened.lastIndexOf(' ');
		return `${(lastSpace > 0 ? shortened.slice(0, lastSpace) : shortened).trimEnd()}…`;
	};

	const base = [normalizedTaskNumber, normalizedTitle].filter(Boolean).join(' ').trim();
	if (base) {
		return truncate(projectCount > 1 && normalizedProjectName
			? `${base} [${normalizedProjectName}]`
			: base);
	}

	if (normalizedProjectName) {
		return truncate(projectCount > 1 ? `Update ${normalizedProjectName}` : normalizedProjectName);
	}

	return 'Update changes';
}