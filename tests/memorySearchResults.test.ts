import test from 'node:test';
import assert from 'node:assert/strict';

import type { MemoryAnalysis, MemoryCommit, MemorySearchResult } from '../src/types/memory.js';
import { dedupeMemorySearchResults } from '../src/utils/memorySearchResults.js';

function createCommit(sha: string, message: string): MemoryCommit {
	return {
		sha,
		author: 'Alek',
		email: 'alek@example.com',
		date: '2026-03-12T10:00:00.000Z',
		branch: 'main',
		repository: 'prompt-manager',
		parentSha: '',
		commitType: 'other',
		message,
	};
}

function createAnalysis(commitSha: string, summary: string): MemoryAnalysis {
	return {
		commitSha,
		summary,
		keyInsights: [],
		components: [],
		categories: ['other'],
		keywords: [],
		architectureImpact: '',
		architectureImpactScore: 0,
		layers: ['other'],
		businessDomains: [],
		isBreakingChange: false,
		createdAt: '2026-03-12T10:00:00.000Z',
	};
}

test('dedupeMemorySearchResults removes duplicate commits while preserving first-hit order', () => {
	const results: MemorySearchResult[] = [
		{ commit: createCommit('aaa1111', 'first'), score: 0.9 },
		{ commit: createCommit('bbb2222', 'second'), score: 0.8 },
		{ commit: createCommit('aaa1111', 'first duplicate'), score: 0.7 },
	];

	const unique = dedupeMemorySearchResults(results);

	assert.deepEqual(unique.map((entry) => entry.commit.sha), ['aaa1111', 'bbb2222']);
	assert.equal(unique[0].commit.message, 'first');
});

test('dedupeMemorySearchResults keeps the highest-score hit for the same commit', () => {
	const results: MemorySearchResult[] = [
		{ commit: createCommit('aaa1111', 'stale'), score: 0.4 },
		{ commit: createCommit('aaa1111', 'best'), score: 0.95 },
	];

	const unique = dedupeMemorySearchResults(results);

	assert.equal(unique, unique);
	assert.equal(unique.length, 1);
	assert.equal(unique[0].commit.message, 'best');
	assert.equal(unique[0].score, 0.95);
});

test('dedupeMemorySearchResults prefers analysed entry when duplicate scores are equal', () => {
	const results: MemorySearchResult[] = [
		{ commit: createCommit('aaa1111', 'without analysis'), score: 0.8 },
		{ commit: createCommit('aaa1111', 'with analysis'), analysis: createAnalysis('aaa1111', 'summary'), score: 0.8 },
	];

	const unique = dedupeMemorySearchResults(results);

	assert.equal(unique.length, 1);
	assert.equal(unique[0].analysis?.summary, 'summary');
	assert.equal(unique[0].commit.message, 'with analysis');
});