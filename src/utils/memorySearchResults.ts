import type { MemorySearchResult } from '../types/memory.js';

/**
 * Remove duplicate search hits by commit SHA while keeping stable output order.
 * If the same commit appears multiple times, the highest-score result wins.
 */
export function dedupeMemorySearchResults(results: MemorySearchResult[]): MemorySearchResult[] {
	const resultBySha = new Map<string, MemorySearchResult>();
	const order: string[] = [];

	for (const result of results) {
		const sha = result.commit.sha;
		const existing = resultBySha.get(sha);

		if (!existing) {
			resultBySha.set(sha, result);
			order.push(sha);
			continue;
		}

		if (result.score > existing.score) {
			resultBySha.set(sha, result);
			continue;
		}

		if (result.score === existing.score && !existing.analysis && result.analysis) {
			resultBySha.set(sha, result);
		}
	}

	return order
		.map((sha) => resultBySha.get(sha))
		.filter((result): result is MemorySearchResult => Boolean(result));
}