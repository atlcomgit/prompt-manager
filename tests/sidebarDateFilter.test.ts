import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSidebarState } from '../src/types/prompt.js';
import { matchesCreatedAtFilter, resolveCreatedAtFilterRange } from '../src/utils/sidebarDateFilter.js';

function assertLocalDateParts(
	date: Date,
	expected: { year: number; month: number; day: number; hours: number; minutes: number; seconds: number; milliseconds: number },
): void {
	assert.equal(date.getFullYear(), expected.year);
	assert.equal(date.getMonth(), expected.month);
	assert.equal(date.getDate(), expected.day);
	assert.equal(date.getHours(), expected.hours);
	assert.equal(date.getMinutes(), expected.minutes);
	assert.equal(date.getSeconds(), expected.seconds);
	assert.equal(date.getMilliseconds(), expected.milliseconds);
}

test('normalizeSidebarState backfills createdAt filter for legacy persisted sidebar state', () => {
	const result = normalizeSidebarState({
		selectedPromptId: 'prompt-1',
		filters: {
			search: 'legacy',
			status: ['draft'],
			projects: [],
			languages: [],
			frameworks: [],
			favorites: true,
		},
	});

	assert.equal(result.filters.createdAt, 'all');
	assert.equal(result.filters.search, 'legacy');
	assert.deepEqual(result.filters.status, ['draft']);
	assert.equal(result.filters.favorites, true);
});

test('resolveCreatedAtFilterRange uses monday as the start of current week', () => {
	const now = new Date('2026-03-18T15:30:00.000Z');
	const range = resolveCreatedAtFilterRange('current-week', now);

	assertLocalDateParts(range.start, {
		year: 2026,
		month: 2,
		day: 16,
		hours: 0,
		minutes: 0,
		seconds: 0,
		milliseconds: 0,
	});
	assertLocalDateParts(range.end, {
		year: 2026,
		month: 2,
		day: 22,
		hours: 23,
		minutes: 59,
		seconds: 59,
		milliseconds: 999,
	});
});

test('resolveCreatedAtFilterRange returns previous calendar week boundaries', () => {
	const now = new Date('2026-03-18T15:30:00.000Z');
	const range = resolveCreatedAtFilterRange('previous-week', now);

	assertLocalDateParts(range.start, {
		year: 2026,
		month: 2,
		day: 9,
		hours: 0,
		minutes: 0,
		seconds: 0,
		milliseconds: 0,
	});
	assertLocalDateParts(range.end, {
		year: 2026,
		month: 2,
		day: 15,
		hours: 23,
		minutes: 59,
		seconds: 59,
		milliseconds: 999,
	});
});

test('resolveCreatedAtFilterRange returns previous calendar month boundaries', () => {
	const now = new Date('2026-03-18T15:30:00.000Z');
	const range = resolveCreatedAtFilterRange('previous-month', now);

	assertLocalDateParts(range.start, {
		year: 2026,
		month: 1,
		day: 1,
		hours: 0,
		minutes: 0,
		seconds: 0,
		milliseconds: 0,
	});
	assertLocalDateParts(range.end, {
		year: 2026,
		month: 1,
		day: 28,
		hours: 23,
		minutes: 59,
		seconds: 59,
		milliseconds: 999,
	});
});

test('resolveCreatedAtFilterRange returns previous calendar year boundaries', () => {
	const now = new Date('2026-03-18T15:30:00.000Z');
	const range = resolveCreatedAtFilterRange('previous-year', now);

	assertLocalDateParts(range.start, {
		year: 2025,
		month: 0,
		day: 1,
		hours: 0,
		minutes: 0,
		seconds: 0,
		milliseconds: 0,
	});
	assertLocalDateParts(range.end, {
		year: 2025,
		month: 11,
		day: 31,
		hours: 23,
		minutes: 59,
		seconds: 59,
		milliseconds: 999,
	});
});

test('matchesCreatedAtFilter applies rolling last-7-days window', () => {
	const now = new Date('2026-03-21T12:00:00.000Z');

	assert.equal(matchesCreatedAtFilter('2026-03-14T12:00:00.000Z', 'last-7-days', now), true);
	assert.equal(matchesCreatedAtFilter('2026-03-14T11:59:59.999Z', 'last-7-days', now), false);
	assert.equal(matchesCreatedAtFilter('invalid-date', 'last-7-days', now), false);
	assert.equal(matchesCreatedAtFilter('2025-01-01T00:00:00.000Z', 'all', now), true);
});