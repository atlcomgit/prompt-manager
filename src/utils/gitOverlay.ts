import type {
	GitOverlayActionKind,
	GitOverlayBranchKind,
	GitOverlayGraphEdge,
	GitOverlayGraphNode,
	GitOverlayReviewProvider,
	GitOverlayReviewRequestState,
	GitOverlayReviewSetupAction,
} from '../types/git.js';
import type { PromptStatus } from '../types/prompt.js';

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

type GitOverlayStartChatBranchProject = {
	available: boolean;
	currentBranch: string;
};

type GitOverlayTrackedBranchProject = {
	available: boolean;
	currentBranch: string;
	branches: Array<{
		name: string;
		kind: GitOverlayBranchKind;
		exists: boolean;
	}>;
};

type GitOverlaySyncProject = {
	available: boolean;
	upstream: string;
	behind: number;
};

type GitOverlayActionableProject = {
	available: boolean;
	currentBranch: string;
	changeGroups: {
		merge: unknown[];
		staged: unknown[];
		workingTree: unknown[];
		untracked: unknown[];
	};
};

function countGitOverlayActionableProjectChanges<T extends GitOverlayActionableProject>(project: T): number {
	return project.changeGroups.merge.length
		+ project.changeGroups.staged.length
		+ project.changeGroups.workingTree.length
		+ project.changeGroups.untracked.length;
}

function normalizeInteractiveTerminalCommand(command: string): string {
	return command.replace(/\t/g, '    ');
}

function quoteShellArg(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function quotePowerShellArg(value: string): string {
	return `'${value.replace(/'/g, `''`)}'`;
}

function isIpLiteralHost(host: string): boolean {
	const normalizedHost = host.trim();
	if (!normalizedHost) {
		return false;
	}

	const ipv4Match = normalizedHost.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/);
	if (ipv4Match) {
		return ipv4Match[1]
			.split('.')
			.every(part => Number(part) >= 0 && Number(part) <= 255);
	}

	const bracketedIpv6Match = normalizedHost.match(/^\[([0-9A-Fa-f:]+)\](?::\d+)?$/);
	if (bracketedIpv6Match) {
		return true;
	}

	return normalizedHost.includes(':') && /^[0-9A-Fa-f:]+$/.test(normalizedHost);
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

/** Проверка, требуется ли self-managed GitLab сценарий с вводом PAT */
function isGitLabSelfManaged(cliCommand: 'gh' | 'glab', host: string): boolean {
	return cliCommand === 'glab' && host !== 'gitlab.com';
}

/** Генерирует POSIX-блок интерактивной авторизации для self-managed GitLab через Personal Access Token */
function buildPosixGitLabSelfManagedAuthBlock(host: string, manualUrl: string): string {
	const quotedHost = quoteShellArg(host);
	const shouldSkipTlsVerify = isIpLiteralHost(host);
	return [
		'echo ""',
		`echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"`,
		`echo "  To authenticate, create a Personal Access Token:"`,
		`echo ""`,
		`echo "  1. Open: https://${host}/-/user_settings/personal_access_tokens"`,
		`echo "  2. Name: glab-cli"`,
		`echo "  3. Scopes: api, write_repository"`,
		`echo "  4. Click 'Create personal access token'"`,
		`echo "  5. Copy the token and paste it below"`,
		`echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"`,
		'echo ""',
		'printf "Paste your token: "',
		'read -r _pm_token',
		'if [ -z "$_pm_token" ]; then',
		'    echo "[Prompt Manager] Token cannot be empty."',
		`    echo "[Prompt Manager] Manual setup: ${manualUrl}"`,
		'    echo ""',
		'    echo "Press Enter to close this terminal..."',
		'    read -r _',
		'    exit 1',
		'fi',
		`_pm_api_protocol=$(glab config get api_protocol --host ${quotedHost} 2>/dev/null || printf '%s' 'https')`,
		'if [ -z "$_pm_api_protocol" ]; then',
		"    _pm_api_protocol='https'",
		'fi',
		`_pm_git_protocol=$(glab config get git_protocol --host ${quotedHost} 2>/dev/null || printf '%s' 'ssh')`,
		'if [ -z "$_pm_git_protocol" ]; then',
		"    _pm_git_protocol='ssh'",
		'fi',
		...(shouldSkipTlsVerify
			? [
				`echo "[Prompt Manager] ${host} is an IP-based GitLab host. Enabling skip_tls_verify for glab."`,
			]
			: []),
		`if glab config set api_protocol "$_pm_api_protocol" --host ${quotedHost} \
		    && glab config set git_protocol "$_pm_git_protocol" --host ${quotedHost} \
		    ${shouldSkipTlsVerify ? `&& glab config set skip_tls_verify true --host ${quotedHost} \\
		    ` : ''}&& glab config set token "$_pm_token" --host ${quotedHost} \
		    && glab auth status --hostname ${quotedHost} >/dev/null 2>/dev/null; then`,
		`    echo "[Prompt Manager] glab is ready. Return to Git Flow and refresh the overlay."`,
		'else',
		`    echo "[Prompt Manager] glab authentication failed (exit code $?)."`,
		`    echo "[Prompt Manager] Manual setup: ${manualUrl}"`,
		'    echo ""',
		'    echo "Press Enter to close this terminal..."',
		'    read -r _',
		'fi',
	].join('\n');
}

/** Генерирует Windows-блок интерактивной авторизации для self-managed GitLab через Personal Access Token */
function buildWindowsGitLabSelfManagedAuthBlock(host: string, manualUrl: string): string {
	const quotedHost = quotePowerShellArg(host);
	const shouldSkipTlsVerify = isIpLiteralHost(host);
	return [
		"Write-Host ''",
		`Write-Host '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'`,
		`Write-Host '  To authenticate, create a Personal Access Token:'`,
		"Write-Host ''",
		`Write-Host '  1. Open: https://${host}/-/user_settings/personal_access_tokens'`,
		`Write-Host '  2. Name: glab-cli'`,
		`Write-Host '  3. Scopes: api, write_repository'`,
		`Write-Host "  4. Click 'Create personal access token'"`,
		`Write-Host '  5. Copy the token and paste it below'`,
		`Write-Host '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'`,
		"Write-Host ''",
		"$pmToken = Read-Host 'Paste your token'",
		"if ([string]::IsNullOrWhiteSpace($pmToken)) {",
		"    Write-Host '[Prompt Manager] Token cannot be empty.'",
		`    Write-Host '[Prompt Manager] Manual setup: ${manualUrl}'`,
		"    Write-Host ''",
		"    Write-Host 'Press Enter to close this terminal...'",
		"    Read-Host",
		"    exit 1",
		"}",
		`$pmApiProtocol = (glab config get api_protocol --host ${quotedHost} 2>$null).Trim()`,
		"if ([string]::IsNullOrWhiteSpace($pmApiProtocol)) {",
		"    $pmApiProtocol = 'https'",
		"}",
		`$pmGitProtocol = (glab config get git_protocol --host ${quotedHost} 2>$null).Trim()`,
		"if ([string]::IsNullOrWhiteSpace($pmGitProtocol)) {",
		"    $pmGitProtocol = 'ssh'",
		"}",
		"function Invoke-PromptManagerGlabCommand {",
		"    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)",
		"    & glab @Arguments",
		"    if ($LASTEXITCODE -ne 0) {",
		"        throw \"glab $($Arguments -join ' ') failed with exit code $LASTEXITCODE\"",
		"    }",
		"}",
		'try {',
		`    Invoke-PromptManagerGlabCommand config set api_protocol $pmApiProtocol --host ${quotedHost}`,
		`    Invoke-PromptManagerGlabCommand config set git_protocol $pmGitProtocol --host ${quotedHost}`,
		...(shouldSkipTlsVerify
			? [
				`    Write-Host '[Prompt Manager] ${host} is an IP-based GitLab host. Enabling skip_tls_verify for glab.'`,
				`    Invoke-PromptManagerGlabCommand config set skip_tls_verify true --host ${quotedHost}`,
			]
			: []),
		`    Invoke-PromptManagerGlabCommand config set token $pmToken --host ${quotedHost}`,
		`    Invoke-PromptManagerGlabCommand auth status --hostname ${quotedHost}`,
		`    Write-Host '[Prompt Manager] glab is ready. Return to Git Flow and refresh the overlay.'`,
		'} catch {',
		`    Write-Host "[Prompt Manager] glab authentication failed: $_"`,
		`    Write-Host '[Prompt Manager] Manual setup: ${manualUrl}'`,
		"    Write-Host ''",
		"    Write-Host 'Press Enter to close this terminal...'",
		"    Read-Host",
		'}',
	].join('\n');
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
			'if command -v snap >/dev/null; then',
			'    run_privileged snap install glab',
			'    return',
			'fi',
			'if command -v apt-get >/dev/null; then',
			'    if command -v curl >/dev/null; then',
			'        curl -sSL "https://raw.githubusercontent.com/upciti/wakemeops/main/assets/install_repository" | run_privileged bash',
			'    elif command -v wget >/dev/null; then',
			'        wget -qO- "https://raw.githubusercontent.com/upciti/wakemeops/main/assets/install_repository" | run_privileged bash',
			'    else',
			'        echo "[Prompt Manager] curl or wget is required to install glab on Debian/Ubuntu."',
			`        echo "[Prompt Manager] Manual install: ${manualUrl}"`,
			'        exit 1',
			'    fi',
			'    run_privileged apt-get update',
			'    run_privileged apt-get install -y glab',
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

	/* Для self-managed GitLab используем интерактивный ввод PAT вместо OAuth */
	const selfManaged = isGitLabSelfManaged(cliCommand, host);
	if (selfManaged) {
		return normalizeInteractiveTerminalCommand([
			"$ErrorActionPreference = 'Stop'",
			installCommand,
			buildWindowsGitLabSelfManagedAuthBlock(host, manualUrl),
		].filter(Boolean).join('\n'));
	}

	return normalizeInteractiveTerminalCommand([
		"$ErrorActionPreference = 'Stop'",
		installCommand,
		`Write-Host '[Prompt Manager] Opening ${cliCommand} authentication...'`,
		'try {',
		`    ${authCommand}`,
		`    Write-Host '[Prompt Manager] ${cliCommand} is ready. Return to Git Flow and refresh the overlay.'`,
		'} catch {',
		`    Write-Host "[Prompt Manager] ${cliCommand} authentication failed: $_"`,
		`    Write-Host '[Prompt Manager] Manual setup: ${manualUrl}'`,
		"    Write-Host ''",
		"    Write-Host 'Press Enter to close this terminal...'",
		'    Read-Host',
		'}',
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

	/* Для self-managed GitLab используем интерактивный ввод PAT вместо OAuth */
	const selfManaged = isGitLabSelfManaged(input.cliCommand, host);
	if (selfManaged) {
		return {
			terminalName: `Prompt Manager ${input.cliCommand}`,
			manualUrl,
			command: normalizeInteractiveTerminalCommand([
				installCommand,
				buildPosixGitLabSelfManagedAuthBlock(host, manualUrl),
			].join('\n')),
		};
	}

	return {
		terminalName: `Prompt Manager ${input.cliCommand}`,
		manualUrl,
		command: normalizeInteractiveTerminalCommand([
			installCommand,
			`echo "[Prompt Manager] Opening ${input.cliCommand} authentication..."`,
			`if ${authCommand}; then`,
			`    echo "[Prompt Manager] ${input.cliCommand} is ready. Return to Git Flow and refresh the overlay."`,
			'else',
			`    echo "[Prompt Manager] ${input.cliCommand} authentication failed (exit code $?)."`,
			`    echo "[Prompt Manager] Manual setup: ${manualUrl}"`,
			'    echo ""',
			'    echo "Press Enter to close this terminal..."',
			'    read -r _',
			'fi',
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

export function resolveExistingGitOverlayTrackedBranches<T extends GitOverlayTrackedBranchProject>(
	trackedBranches: string[],
	projects: T[],
): string[] {
	const normalizedTrackedBranches = Array.from(new Set(
		trackedBranches
			.map(branch => branch.trim())
			.filter(Boolean),
	));

	const availableProjects = projects.filter(project => project.available);
	const projectsToInspect = availableProjects.length > 0 ? availableProjects : projects;
	if (projectsToInspect.length === 0) {
		return [];
	}

	if (normalizedTrackedBranches.length > 0) {
		return normalizedTrackedBranches.filter(branchName => projectsToInspect.some(project => project.branches.some(branch => (
			(branch.kind === 'tracked' || branch.kind === 'current')
			&& branch.exists
			&& branch.name.trim() === branchName
		))));
	}

	const result = new Set<string>();
	for (const project of projectsToInspect) {
		for (const branch of project.branches) {
			const normalizedBranch = branch.name.trim();
			if (branch.kind !== 'tracked' || !branch.exists || !normalizedBranch) {
				continue;
			}
			result.add(normalizedBranch);
		}
	}

	return [...result];
}

export function resolveGitOverlayTrackedBranchOptions<T extends GitOverlayTrackedBranchProject>(
	trackedBranches: string[],
	projects: T[],
	promptBranch: string,
	preferredTrackedBranch = '',
): string[] {
	const normalizedTrackedBranches = Array.from(new Set(
		trackedBranches
			.map(branch => branch.trim())
			.filter(Boolean),
	));
	if (normalizedTrackedBranches.length > 0) {
		return normalizedTrackedBranches;
	}

	const availableProjects = projects.filter(project => project.available);
	const projectsToInspect = availableProjects.length > 0 ? availableProjects : projects;
	const normalizedPromptBranch = promptBranch.trim();
	const preferredBranch = preferredTrackedBranch.trim();
	const fallbackBranches = projectsToInspect
		.map(project => project.currentBranch.trim())
		.filter(Boolean)
		.filter(branch => branch !== normalizedPromptBranch);
	const options = Array.from(new Set(fallbackBranches.length > 0 ? fallbackBranches : projectsToInspect
		.map(project => project.currentBranch.trim())
		.filter(Boolean)));

	if (!preferredBranch) {
		return options;
	}

	return Array.from(new Set([preferredBranch, ...options]));
}

export function isGitOverlayStartChatBranchAllowed(
	branchName: string,
	promptBranch: string,
	trackedBranches: string[],
): boolean {
	const normalizedBranch = branchName.trim();
	if (!normalizedBranch) {
		return false;
	}

	if (normalizedBranch === promptBranch.trim()) {
		return true;
	}

	return trackedBranches
		.map(branch => branch.trim())
		.filter(Boolean)
		.includes(normalizedBranch);
}

export function isGitOverlayDefaultStepBranchAllowed(
	branchName: string,
	promptBranch: string,
	trackedBranches: string[],
): boolean {
	if (!promptBranch.trim()) {
		return false;
	}

	return isGitOverlayStartChatBranchAllowed(branchName, promptBranch, trackedBranches);
}

export function collectGitOverlayStartChatBranchMismatches<T extends GitOverlayStartChatBranchProject>(
	projects: T[],
	promptBranch: string,
	trackedBranches: string[],
): T[] {
	return projects.filter(project => project.available && !isGitOverlayStartChatBranchAllowed(project.currentBranch, promptBranch, trackedBranches));
}

export function collectGitOverlayDefaultStepBranchMismatches<T extends GitOverlayStartChatBranchProject>(
	projects: T[],
	promptBranch: string,
	trackedBranches: string[],
): T[] {
	return projects.filter(project => project.available && !isGitOverlayDefaultStepBranchAllowed(project.currentBranch, promptBranch, trackedBranches));
}

export function collectGitOverlayProjectsNeedingSync<T extends GitOverlaySyncProject>(projects: T[]): T[] {
	return projects.filter(project => project.available && Boolean(project.upstream.trim()) && project.behind > 0);
}

export function isGitOverlayPassiveTrackedProject<T extends GitOverlayActionableProject>(
	project: T,
	promptBranch: string,
	trackedBranches: string[],
): boolean {
	if (!project.available) {
		return false;
	}

	const normalizedCurrentBranch = project.currentBranch.trim();
	if (!normalizedCurrentBranch) {
		return false;
	}

	const normalizedPromptBranch = promptBranch.trim();
	if (normalizedPromptBranch && normalizedCurrentBranch === normalizedPromptBranch) {
		return false;
	}

	const trackedBranchSet = new Set(
		trackedBranches
			.map(branch => branch.trim())
			.filter(Boolean),
	);
	if (!trackedBranchSet.has(normalizedCurrentBranch)) {
		return false;
	}

	return countGitOverlayActionableProjectChanges(project) === 0;
}

export function collectGitOverlayActionableProjects<T extends GitOverlayActionableProject>(
	projects: T[],
	promptBranch: string,
	trackedBranches: string[],
): T[] {
	return projects.filter(project => !isGitOverlayPassiveTrackedProject(project, promptBranch, trackedBranches));
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

export function resolveGitOverlayDoneStatus(completedActions: Record<GitOverlayActionKind, boolean>): PromptStatus | null {
	if (completedActions.merge) {
		return 'closed';
	}

	if (completedActions['review-request']) {
		return 'review';
	}

	if (completedActions.push) {
		return 'report';
	}

	return null;
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

export function parseGitOverlayRemoteUrl(
	remoteUrl: string,
	providerHosts?: Record<string, string>,
): ParsedGitOverlayRemote | null {
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

	/* Определение провайдера: сначала проверяем пользовательский маппинг хостов,
	   затем автоматическое определение по имени хоста. */
	const explicitProvider = resolveExplicitReviewProvider(normalizedHost, providerHosts);
	const provider: GitOverlayReviewProvider = explicitProvider
		|| (normalizedHost.includes('gitlab')
			? 'gitlab'
			: normalizedHost.includes('github')
				? 'github'
				: 'unknown');

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

/** Сопоставляет хост с провайдером из пользовательского маппинга. */
function resolveExplicitReviewProvider(
	normalizedHost: string,
	providerHosts?: Record<string, string>,
): GitOverlayReviewProvider | null {
	if (!providerHosts) {
		return null;
	}

	for (const [hostPattern, providerValue] of Object.entries(providerHosts)) {
		const normalizedPattern = (hostPattern || '').trim().toLowerCase();
		if (!normalizedPattern) {
			continue;
		}

		if (normalizedHost === normalizedPattern) {
			const normalized = (providerValue || '').trim().toLowerCase();
			if (normalized === 'github' || normalized === 'gitlab') {
				return normalized;
			}
		}
	}

	return null;
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