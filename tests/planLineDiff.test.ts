import test from 'node:test';
import assert from 'node:assert/strict';

import { getChangedLineIndexes } from '../src/utils/planLineDiff.js';

test('getChangedLineIndexes returns empty array when content is unchanged', () => {
	assert.deepEqual(getChangedLineIndexes('a\nb\nc', 'a\nb\nc'), []);
});

test('getChangedLineIndexes highlights inserted and modified lines in next content', () => {
	const previous = [
		'# План',
		'',
		'- шаг 1',
		'- шаг 2',
	].join('\n');

	const next = [
		'# План',
		'',
		'- шаг 1',
		'- шаг 2 (обновлён)',
		'- шаг 3',
	].join('\n');

	assert.deepEqual(getChangedLineIndexes(previous, next), [3, 4]);
});

test('getChangedLineIndexes highlights nearest surviving line for deletions', () => {
	const previous = [
		'# План',
		'- шаг 1',
		'- шаг 2',
		'- шаг 3',
	].join('\n');

	const next = [
		'# План',
		'- шаг 1',
		'- шаг 3',
	].join('\n');

	assert.deepEqual(getChangedLineIndexes(previous, next), [2]);
});

test('getChangedLineIndexes highlights all lines when file appears after being empty', () => {
	const next = [
		'# План',
		'',
		'- новый пункт',
	].join('\n');

	assert.deepEqual(getChangedLineIndexes('', next), [0, 1, 2]);
});