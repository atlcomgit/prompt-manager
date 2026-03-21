import test from 'node:test';
import assert from 'node:assert/strict';

import {
	COMPLETED_CHAT_RESPONSE_STATE,
	FALLBACK_COMPLETION_QUIET_PERIOD_MS,
	isCompletedChatResponse,
	observeStableChatCompletion,
} from '../src/utils/chatCompletionState.js';

test('isCompletedChatResponse requires ended request and no pending edits', () => {
	assert.equal(isCompletedChatResponse({
		lastRequestStarted: 100,
		lastRequestEnded: 200,
		lastResponseState: COMPLETED_CHAT_RESPONSE_STATE,
		hasPendingEdits: false,
	}), true);

	assert.equal(isCompletedChatResponse({
		lastRequestStarted: 100,
		lastRequestEnded: 100,
		lastResponseState: COMPLETED_CHAT_RESPONSE_STATE,
		hasPendingEdits: false,
	}), false);

	assert.equal(isCompletedChatResponse({
		lastRequestStarted: 100,
		lastRequestEnded: 200,
		lastResponseState: 2,
		hasPendingEdits: false,
	}), true);

	assert.equal(isCompletedChatResponse({
		lastRequestStarted: 100,
		lastRequestEnded: 200,
		lastResponseState: COMPLETED_CHAT_RESPONSE_STATE,
		hasPendingEdits: true,
	}), false);
});

test('observeStableChatCompletion waits for the same completion snapshot to stay stable', () => {
	const snapshot = {
		sessionId: 'session-1',
		lastRequestStarted: 100,
		lastRequestEnded: 200,
		lastResponseState: COMPLETED_CHAT_RESPONSE_STATE,
		hasPendingEdits: false,
	};

	const first = observeStableChatCompletion(null, snapshot, 1000, 1500);
	assert.equal(first.completed, false);
	assert.ok(first.candidate);

	const second = observeStableChatCompletion(first.candidate, snapshot, 2000, 1500);
	assert.equal(second.completed, false);
	assert.ok(second.candidate);

	const third = observeStableChatCompletion(second.candidate, snapshot, 2600, 1500);
	assert.equal(third.completed, true);
	assert.ok(third.candidate);
});

test('observeStableChatCompletion resets candidate when the snapshot changes or stops being complete', () => {
	const first = observeStableChatCompletion(null, {
		sessionId: 'session-1',
		lastRequestStarted: 100,
		lastRequestEnded: 200,
		lastResponseState: COMPLETED_CHAT_RESPONSE_STATE,
		hasPendingEdits: false,
	}, 1000, 1500);

	const changed = observeStableChatCompletion(first.candidate, {
		sessionId: 'session-1',
		lastRequestStarted: 100,
		lastRequestEnded: 250,
		lastResponseState: COMPLETED_CHAT_RESPONSE_STATE,
		hasPendingEdits: false,
	}, 1200, 1500);
	assert.equal(changed.completed, false);
	assert.ok(changed.candidate);
	assert.equal(changed.candidate?.lastRequestEnded, 250);

	const incomplete = observeStableChatCompletion(changed.candidate, {
		sessionId: 'session-1',
		lastRequestStarted: 300,
		lastRequestEnded: 300,
		lastResponseState: 2,
		hasPendingEdits: false,
	}, 1500, 1500);
	assert.equal(incomplete.completed, false);
	assert.equal(incomplete.candidate, null);
});

test('observeStableChatCompletion uses a longer quiet fallback when response state is not explicitly completed', () => {
	const snapshot = {
		sessionId: 'session-1',
		lastRequestStarted: 100,
		lastRequestEnded: 200,
		lastResponseState: 2,
		hasPendingEdits: false,
	};

	const first = observeStableChatCompletion(null, snapshot, 1000, 1500);
	assert.equal(first.completed, false);

	const tooEarly = observeStableChatCompletion(first.candidate, snapshot, 1000 + FALLBACK_COMPLETION_QUIET_PERIOD_MS - 1, 1500);
	assert.equal(tooEarly.completed, false);

	const completed = observeStableChatCompletion(first.candidate, snapshot, 1000 + FALLBACK_COMPLETION_QUIET_PERIOD_MS, 1500);
	assert.equal(completed.completed, true);
});