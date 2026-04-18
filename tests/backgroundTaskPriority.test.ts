import test from 'node:test';
import assert from 'node:assert/strict';
import type { BackgroundTaskPriority } from '../src/types/backgroundTaskPriority.js';

import {
	compareBackgroundTaskPriority,
	normalizeBackgroundTaskPriority,
	serializeBackgroundTaskPriority,
} from '../src/utils/backgroundTaskPriority.js';

test('normalizeBackgroundTaskPriority handles legacy aliases and the new lowest level', () => {
	assert.equal(normalizeBackgroundTaskPriority('lowest'), 'lowest');
	assert.equal(normalizeBackgroundTaskPriority('lower'), 'low');
	assert.equal(normalizeBackgroundTaskPriority('higher'), 'high');
	assert.equal(normalizeBackgroundTaskPriority('unknown', 'lowest'), 'lowest');
});

test('serializeBackgroundTaskPriority keeps settings-compatible labels', () => {
	assert.equal(serializeBackgroundTaskPriority('lowest'), 'lowest');
	assert.equal(serializeBackgroundTaskPriority('low'), 'lower');
	assert.equal(serializeBackgroundTaskPriority('normal'), 'normal');
	assert.equal(serializeBackgroundTaskPriority('high'), 'higher');
});

test('compareBackgroundTaskPriority orders queue levels from high to lowest', () => {
	const ordered: BackgroundTaskPriority[] = ['lowest', 'normal', 'high', 'low'];
	ordered.sort((left, right) => compareBackgroundTaskPriority(right, left));

	assert.deepEqual(ordered, ['high', 'normal', 'low', 'lowest']);
});