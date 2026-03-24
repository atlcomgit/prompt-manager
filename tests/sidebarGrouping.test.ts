import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultSidebarState, type FilterState } from '../src/types/prompt.js';
import { hasActiveSidebarFilters, makeSidebarGroupCollapseKey, shouldAutoExpandSidebarGroups } from '../src/utils/sidebarGrouping.js';

function makeFilters(overrides: Partial<FilterState> = {}): FilterState {
	return {
		...createDefaultSidebarState().filters,
		...overrides,
	};
}

test('hasActiveSidebarFilters returns false for default sidebar filters', () => {
	assert.equal(hasActiveSidebarFilters(makeFilters()), false);
});

test('hasActiveSidebarFilters detects search and structured filters', () => {
	assert.equal(hasActiveSidebarFilters(makeFilters({ search: 'bugfix' })), true);
	assert.equal(hasActiveSidebarFilters(makeFilters({ status: ['draft'] })), true);
	assert.equal(hasActiveSidebarFilters(makeFilters({ favorites: true })), true);
	assert.equal(hasActiveSidebarFilters(makeFilters({ createdAt: 'last-7-days' })), true);
});

test('shouldAutoExpandSidebarGroups expands grouped results while filters are active', () => {
	assert.equal(
		shouldAutoExpandSidebarGroups('status', makeFilters({ search: 'api' })),
		true,
	);
	assert.equal(
		shouldAutoExpandSidebarGroups('project', makeFilters({ favorites: true })),
		true,
	);
});

test('shouldAutoExpandSidebarGroups restores remembered group state after filters reset', () => {
	const savedKey = makeSidebarGroupCollapseKey('status', 'draft');
	const collapsedGroups = { [savedKey]: true };

	assert.equal(shouldAutoExpandSidebarGroups('status', makeFilters()), false);
	assert.equal(collapsedGroups[savedKey], true);
	assert.equal(shouldAutoExpandSidebarGroups('none', makeFilters({ search: 'api' })), false);
});
