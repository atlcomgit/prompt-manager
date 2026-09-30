import { shouldIgnoreRealtimeRefreshPath } from '../codemap/codeMapRealtimeRefresh.js';

/** Экранирует текст имени файла для регулярного выражения. */
function escapeDockerComposeRootPatternRegex(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.*]/g, '\\$&');
}

/** Компилирует корневой glob: звёздочки, одиночные символы, группы и диапазоны VS Code. */
function compileDockerComposeRootPattern(pattern: string): RegExp | null {
	// Группы остаются в выражении, поэтому число альтернатив не раздувает список шаблонов.
	let source = '';
	let braceDepth = 0;
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index];
		if (character === '*') {
			source += '[^/]*';
			while (pattern[index + 1] === '*') index += 1;
		} else if (character === '?') {
			source += '[^/]';
		} else if (character === '{') {
			source += '(?:';
			braceDepth += 1;
		} else if (character === '}' && braceDepth > 0) {
			source += ')';
			braceDepth -= 1;
		} else if (character === ',' && braceDepth > 0) {
			source += '|';
		} else if (character === '[') {
			// Скобка в начале диапазона задаёт литерал: [[] и []] экранируют имена файлов.
			const bodyStart = index + 1 + (pattern[index + 1] === '!' ? 1 : 0);
			const end = pattern.indexOf(']', bodyStart + (pattern[bodyStart] === ']' ? 1 : 0));
			if (end < 0) {
				source += '\\[';
				continue;
			}
			const body = pattern.slice(bodyStart, end).replace(/[\\\[\]^]/g, '\\$&');
			source += `[${pattern[index + 1] === '!' ? '^' : ''}${body}]`;
			index = end;
		} else {
			source += escapeDockerComposeRootPatternRegex(character);
		}
	}
	try {
		return new RegExp(`^${source}$`);
	} catch {
		// Ошибочный пользовательский диапазон не должен прерывать обнаружение остальных файлов.
		return null;
	}
}

/** Подготавливает шаблоны один раз перед проверкой всех записей корневой папки. */
export function createDockerComposeRootMatcher(patterns: string[]): (fileName: string) => boolean {
	const expressions = patterns.map(normalizeDockerComposeRootPattern)
		.filter(Boolean).map(compileDockerComposeRootPattern).filter((value): value is RegExp => value !== null);
	return (fileName) => {
		const normalized = normalizeDockerComposeRelativePath(fileName);
		return Boolean(normalized && !normalized.includes('/') && expressions.some(expression => expression.test(normalized)));
	};
}

/** Converts recursive compose patterns into root-only workspace project patterns. */
export function normalizeDockerComposeRootPattern(value: string): string {
	let normalized = String(value || '')
		.trim()
		.replace(/\\/g, '/')
		.replace(/^\.\/+/g, '')
		.replace(/^\/+/g, '')
		.replace(/\/+/g, '/');
	while (normalized.startsWith('**/')) {
		normalized = normalized.slice(3);
	}
	const parts = normalized.split('/').filter(Boolean);
	const rootPattern = parts.length > 0 ? parts[parts.length - 1] : normalized;
	return rootPattern && rootPattern !== '**' ? rootPattern : '';
}

/** Проверяет имя корневого файла по glob-шаблону VS Code. */
export function matchesDockerComposeRootPattern(fileName: string, pattern: string): boolean {
	return createDockerComposeRootMatcher([pattern])(fileName);
}

/** Returns true only for compose files placed directly in a scanned project root. */
export function shouldIncludeDockerComposeFile(relativePath: string, excludedPaths: string[]): boolean {
	const normalized = normalizeDockerComposeRelativePath(relativePath);
	return Boolean(normalized && !normalized.includes('/') && !shouldIgnoreRealtimeRefreshPath(normalized, excludedPaths));
}

/** Normalizes a workspace-relative path for Docker compose discovery checks. */
export function normalizeDockerComposeRelativePath(value: string): string {
	return String(value || '')
		.trim()
		.replace(/\\/g, '/')
		.replace(/^\.\/+/g, '')
		.replace(/^\/+/g, '')
		.replace(/\/+/g, '/');
}
