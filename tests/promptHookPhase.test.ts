import test from 'node:test';
import assert from 'node:assert/strict';

import {
	filterPromptHookIdsForPhase,
	resolvePromptHookPhases,
	shouldRunPromptHookInPhase,
} from '../src/utils/promptHookPhase.js';

test('resolvePromptHookPhases routes finish hooks only to afterChatCompleted', () => {
	assert.deepEqual(resolvePromptHookPhases('agent-finish-voice'), ['afterChatCompleted']);
	assert.equal(shouldRunPromptHookInPhase('agent-finish-voice', 'beforeChat'), false);
	assert.equal(shouldRunPromptHookInPhase('agent-finish-voice', 'afterChatCompleted'), true);
});

test('resolvePromptHookPhases routes error hooks only to chatError', () => {
	assert.deepEqual(resolvePromptHookPhases('agent-finish-voice-error'), ['chatError']);
	assert.equal(shouldRunPromptHookInPhase('agent-finish-voice-error', 'chatError'), true);
	assert.equal(shouldRunPromptHookInPhase('agent-finish-voice-error', 'afterChatCompleted'), false);
});

test('resolvePromptHookPhases routes start hooks only to beforeChat', () => {
	assert.deepEqual(resolvePromptHookPhases('agent-start-banner'), ['beforeChat']);
	assert.equal(shouldRunPromptHookInPhase('agent-start-banner', 'beforeChat'), true);
	assert.equal(shouldRunPromptHookInPhase('agent-start-banner', 'chatError'), false);
});

test('filterPromptHookIdsForPhase preserves unknown hooks on every phase for compatibility', () => {
	assert.deepEqual(
		filterPromptHookIdsForPhase(['custom-audit', 'agent-finish-voice', 'agent-finish-voice-error'], 'beforeChat'),
		['custom-audit'],
	);
	assert.deepEqual(
		filterPromptHookIdsForPhase(['custom-audit', 'agent-finish-voice', 'agent-finish-voice-error'], 'afterChatCompleted'),
		['custom-audit', 'agent-finish-voice'],
	);
	assert.deepEqual(
		filterPromptHookIdsForPhase(['custom-audit', 'agent-finish-voice', 'agent-finish-voice-error'], 'chatError'),
		['custom-audit', 'agent-finish-voice-error'],
	);
});