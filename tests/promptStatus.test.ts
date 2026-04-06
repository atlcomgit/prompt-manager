import test from 'node:test';
import assert from 'node:assert/strict';

import { getNextPromptStatus, isPromptStatus, PROMPT_STATUS_ORDER } from '../src/types/prompt.js';

test('getNextPromptStatus follows canonical prompt status order', () => {
	for (let index = 0; index < PROMPT_STATUS_ORDER.length - 1; index += 1) {
		assert.equal(
			getNextPromptStatus(PROMPT_STATUS_ORDER[index] as typeof PROMPT_STATUS_ORDER[number]),
			PROMPT_STATUS_ORDER[index + 1],
		);
	}

	assert.equal(getNextPromptStatus('closed'), null);
});

test('isPromptStatus validates runtime status values', () => {
	assert.equal(isPromptStatus('draft'), true);
	assert.equal(isPromptStatus('in-progress'), true);
	assert.equal(isPromptStatus('archived'), false);
	assert.equal(isPromptStatus(''), false);
});