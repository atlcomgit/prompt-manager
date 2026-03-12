import type { StagedFileChange, UncommittedProjectData } from '../services/gitService.js';

export interface UncommittedChangesSummaryOptions {
	maxProjects?: number;
	maxFilesPerProject?: number;
	maxAreasPerFile?: number;
	maxSymbolsPerFile?: number;
}

export interface UncommittedFileSummary {
	path: string;
	previousPath?: string;
	scopes: Array<'staged' | 'unstaged' | 'untracked'>;
	isNewFile: boolean;
	isDeleted: boolean;
	areas: string[];
	symbols: string[];
}

export interface UncommittedProjectSummary {
	project: string;
	branch: string;
	totalFiles: number;
	counts: {
		staged: number;
		unstaged: number;
		untracked: number;
		renamed: number;
		deleted: number;
	};
	files: UncommittedFileSummary[];
	hiddenFiles: number;
}

export interface UncommittedChangesSummary {
	generatedAt: string;
	projects: UncommittedProjectSummary[];
	hiddenProjects: number;
}

const DEFAULT_OPTIONS: Required<UncommittedChangesSummaryOptions> = {
	maxProjects: 3,
	maxFilesPerProject: 5,
	maxAreasPerFile: 2,
	maxSymbolsPerFile: 2,
};

type Scope = 'staged' | 'unstaged' | 'untracked';

interface MutableFileSummary {
	path: string;
	previousPath?: string;
	scopes: Set<Scope>;
	isNewFile: boolean;
	isDeleted: boolean;
	areas: string[];
	symbols: string[];
}

export function summarizeUncommittedProjects(
	projects: UncommittedProjectData[],
	options?: UncommittedChangesSummaryOptions,
): UncommittedChangesSummary {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const limitedProjects = projects.slice(0, opts.maxProjects);

	return {
		generatedAt: new Date().toISOString(),
		projects: limitedProjects.map((project) => summarizeProject(project, opts)),
		hiddenProjects: Math.max(0, projects.length - limitedProjects.length),
	};
}

function summarizeProject(
	project: UncommittedProjectData,
	opts: Required<UncommittedChangesSummaryOptions>,
): UncommittedProjectSummary {
	const fileMap = new Map<string, MutableFileSummary>();
	const diffByPath = buildDiffMap(project);

	applyScope(fileMap, project.stagedFiles, 'staged');
	applyScope(fileMap, project.unstagedFiles, 'unstaged');
	applyScope(fileMap, project.untrackedFiles, 'untracked');

	for (const entry of fileMap.values()) {
		const segments = diffByPath.get(entry.path) || [];
		const combinedDiff = segments.join('\n\n');
		const fileSignals = extractSignals(combinedDiff, opts);
		entry.isNewFile = entry.isNewFile || fileSignals.isNewFile;
		entry.isDeleted = entry.isDeleted || fileSignals.isDeleted;
		if (!entry.previousPath && fileSignals.previousPath) {
			entry.previousPath = fileSignals.previousPath;
		}
		entry.areas = fileSignals.areas;
		entry.symbols = fileSignals.symbols;
	}

	const allFiles = Array.from(fileMap.values())
		.sort((left, right) => compareFileSummaries(left, right))
		.map((entry) => ({
			path: entry.path,
			previousPath: entry.previousPath,
			scopes: normalizeScopes(entry.scopes),
			isNewFile: entry.isNewFile,
			isDeleted: entry.isDeleted,
			areas: entry.areas,
			symbols: entry.symbols,
		}));

	const files = allFiles.slice(0, opts.maxFilesPerProject);
	const hiddenFiles = Math.max(0, allFiles.length - files.length);

	return {
		project: project.project,
		branch: project.branch,
		totalFiles: allFiles.length,
		counts: {
			staged: countScope(allFiles, 'staged'),
			unstaged: countScope(allFiles, 'unstaged'),
			untracked: countScope(allFiles, 'untracked'),
			renamed: allFiles.filter((entry) => Boolean(entry.previousPath)).length,
			deleted: allFiles.filter((entry) => entry.isDeleted).length,
		},
		files,
		hiddenFiles,
	};
}

function applyScope(
	fileMap: Map<string, MutableFileSummary>,
	files: StagedFileChange[],
	scope: Scope,
): void {
	for (const file of files) {
		const entry = fileMap.get(file.path) || {
			path: file.path,
			previousPath: file.previousPath,
			scopes: new Set<Scope>(),
			isNewFile: scope === 'untracked' || file.status === 'A',
			isDeleted: file.status === 'D',
			areas: [],
			symbols: [],
		};

		entry.scopes.add(scope);
		if (!entry.previousPath && file.previousPath) {
			entry.previousPath = file.previousPath;
		}
		if (file.status === 'A' && scope === 'untracked') {
			entry.isNewFile = true;
		}
		if (file.status === 'D') {
			entry.isDeleted = true;
		}

		fileMap.set(file.path, entry);
	}
}

function buildDiffMap(project: UncommittedProjectData): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const diff of [project.stagedDiff, project.unstagedDiff, project.untrackedDiff]) {
		for (const segment of splitDiffSegments(diff)) {
			const existing = map.get(segment.path) || [];
			existing.push(segment.content);
			map.set(segment.path, existing);
		}
	}
	return map;
}

function splitDiffSegments(diff: string): Array<{ path: string; content: string }> {
	if (!diff.trim()) {
		return [];
	}

	const segments: Array<{ path: string; content: string }> = [];
	const lines = diff.split(/\r?\n/);
	let currentPath = '';
	let currentLines: string[] = [];

	const flush = () => {
		if (!currentPath || currentLines.length === 0) {
			return;
		}
		segments.push({
			path: currentPath,
			content: currentLines.join('\n'),
		});
	};

	for (const line of lines) {
		if (line.startsWith('diff --git ')) {
			flush();
			currentPath = parseDiffPath(line);
			currentLines = [line];
			continue;
		}

		if (!currentPath) {
			continue;
		}

		currentLines.push(line);
	}

	flush();
	return segments;
}

function parseDiffPath(line: string): string {
	const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line.trim());
	if (!match) {
		return '';
	}

	return match[2] || match[1] || '';
}

function extractSignals(
	diff: string,
	opts: Required<UncommittedChangesSummaryOptions>,
): {
	isNewFile: boolean;
	isDeleted: boolean;
	previousPath?: string;
	areas: string[];
	symbols: string[];
} {
	const areas = Array.from(diff.matchAll(/^@@[^@]*@@\s*(.+)$/gm))
		.map((match) => (match[1] || '').trim())
		.filter(Boolean)
		.slice(0, opts.maxAreasPerFile);

	const declarationSymbols = Array.from(diff.matchAll(/^[+-](?!\+\+\+|---)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm))
		.map((match) => match[1]);
	const methodSymbols = Array.from(diff.matchAll(/^[+-](?!\+\+\+|---)\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm))
		.map((match) => match[1]);

	const symbols = [...declarationSymbols, ...methodSymbols]
		.filter(Boolean)
		.filter((value, index, source) => source.indexOf(value) === index)
		.slice(0, opts.maxSymbolsPerFile);

	const previousPathMatch = /^rename from\s+(.+)$/m.exec(diff);

	return {
		isNewFile: /new file mode/m.test(diff),
		isDeleted: /deleted file mode/m.test(diff),
		previousPath: previousPathMatch?.[1]?.trim() || undefined,
		areas,
		symbols,
	};
}

function compareFileSummaries(left: MutableFileSummary, right: MutableFileSummary): number {
	const byScore = scoreFile(right) - scoreFile(left);
	if (byScore !== 0) {
		return byScore;
	}

	return left.path.localeCompare(right.path);
}

function scoreFile(file: MutableFileSummary): number {
	let score = 0;
	if (file.previousPath) {
		score += 4;
	}
	if (file.isNewFile || file.isDeleted) {
		score += 3;
	}
	score += file.symbols.length * 2;
	score += file.areas.length;
	score += file.scopes.size;
	return score;
}

function normalizeScopes(scopes: Set<Scope>): Scope[] {
	return (['staged', 'unstaged', 'untracked'] as const).filter((scope) => scopes.has(scope));
}

function countScope(files: UncommittedFileSummary[], scope: Scope): number {
	return files.filter((file) => file.scopes.includes(scope)).length;
}