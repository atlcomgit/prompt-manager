import test from 'node:test';
import assert from 'node:assert/strict';

import {
	DEFAULT_HISTORY_ANALYSIS_LIMIT,
	normalizeHistoryAnalysisLimit,
} from '../src/utils/historyAnalysisLimit.js';

test('normalizeHistoryAnalysisLimit uses configured value when explicit limit is not provided', () => {
	assert.equal(normalizeHistoryAnalysisLimit(undefined, 2), 2);
});

test('normalizeHistoryAnalysisLimit clamps values below minimum to one', () => {
	assert.equal(normalizeHistoryAnalysisLimit(undefined, 0), 1);
	assert.equal(normalizeHistoryAnalysisLimit(-5, 10), 1);
});

test('normalizeHistoryAnalysisLimit floors non-integer values', () => {
	assert.equal(normalizeHistoryAnalysisLimit(2.9, 10), 2);
});

test('normalizeHistoryAnalysisLimit falls back to default for invalid configured values', () => {
	assert.equal(normalizeHistoryAnalysisLimit(undefined, Number.NaN), DEFAULT_HISTORY_ANALYSIS_LIMIT);
});