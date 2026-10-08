import test from 'node:test';
import assert from 'node:assert/strict';

import {
	getSessionTypePanelModelStateKey,
	isCodexAgentHostSessionType,
	resolveChatModeForSessionType,
	resolveSessionTypeRememberedModel,
	shouldSetNewSessionDefaultAgentMode,
	type CachedSessionTypeModelEntry,
} from '../src/utils/sessionTypeChatModel.js';

/** Кеш моделей VS Code с моделями Codex разных провайдеров и обычной моделью Copilot. */
const cachedModels: CachedSessionTypeModelEntry[] = [
	{
		identifier: 'agent-host-codex:@provider=vscode-proxy:gpt-5.2',
		metadata: { vendor: 'agent-host-codex', id: '@provider=vscode-proxy:gpt-5.2', targetChatSessionType: 'agent-host-codex', isUserSelectable: true },
	},
	{
		identifier: 'agent-host-codex:@provider=openai:gpt-6-astra',
		metadata: { vendor: 'agent-host-codex', id: '@provider=openai:gpt-6-astra', targetChatSessionType: 'agent-host-codex', isUserSelectable: true },
	},
	{
		identifier: 'copilot/gpt-5-mini',
		metadata: { vendor: 'copilot', id: 'gpt-5-mini', isUserSelectable: true },
	},
];

test('getSessionTypePanelModelStateKey builds the panel model key for a session type', () => {
	assert.equal(getSessionTypePanelModelStateKey('agent-host-codex'), 'chat.currentLanguageModel.panel.agent-host-codex');
});

test('resolveSessionTypeRememberedModel returns the remembered Codex model with its exact provider', () => {
	assert.deepEqual(
		resolveSessionTypeRememberedModel('agent-host-codex', 'agent-host-codex:@provider=openai:gpt-6-astra', cachedModels),
		{
			sessionType: 'agent-host-codex',
			identifier: 'agent-host-codex:@provider=openai:gpt-6-astra',
			selector: { vendor: 'agent-host-codex', id: '@provider=openai:gpt-6-astra' },
		},
	);
});

test('resolveSessionTypeRememberedModel skips the local Copilot session type', () => {
	assert.equal(resolveSessionTypeRememberedModel('local', 'copilot/gpt-5-mini', cachedModels), undefined);
	assert.equal(resolveSessionTypeRememberedModel('', 'agent-host-codex:@provider=openai:gpt-6-astra', cachedModels), undefined);
});

test('resolveSessionTypeRememberedModel rejects models of another session type or missing from cache', () => {
	assert.equal(resolveSessionTypeRememberedModel('agent-host-codex', 'copilot/keep-current-model', cachedModels), undefined);
	assert.equal(resolveSessionTypeRememberedModel('agent-host-codex', 'agent-host-codex:@provider=openai:unknown', cachedModels), undefined);
	assert.equal(resolveSessionTypeRememberedModel('agent-host-claude', 'agent-host-codex:@provider=openai:gpt-6-astra', cachedModels), undefined);
});

test('resolveSessionTypeRememberedModel rejects cache entries bound to a different session type or hidden', () => {
	const mismatched: CachedSessionTypeModelEntry[] = [
		{
			identifier: 'agent-host-codex:@provider=openai:gpt-6-astra',
			metadata: { vendor: 'agent-host-codex', id: '@provider=openai:gpt-6-astra', targetChatSessionType: 'copilotcli' },
		},
	];
	const hidden: CachedSessionTypeModelEntry[] = [
		{
			identifier: 'agent-host-codex:@provider=openai:gpt-6-astra',
			metadata: { vendor: 'agent-host-codex', id: '@provider=openai:gpt-6-astra', targetChatSessionType: 'agent-host-codex', isUserSelectable: false },
		},
	];
	assert.equal(resolveSessionTypeRememberedModel('agent-host-codex', 'agent-host-codex:@provider=openai:gpt-6-astra', mismatched), undefined);
	assert.equal(resolveSessionTypeRememberedModel('agent-host-codex', 'agent-host-codex:@provider=openai:gpt-6-astra', hidden), undefined);
});

test('resolveChatModeForSessionType forces Agent mode for Codex agent host chats', () => {
	assert.equal(resolveChatModeForSessionType('plan', 'agent-host-codex'), 'agent');
	assert.equal(resolveChatModeForSessionType('agent', 'agent-host-codex'), 'agent');
	assert.equal(resolveChatModeForSessionType(undefined, 'agent-host-codex'), 'agent');
});

test('resolveChatModeForSessionType keeps the prompt mode for other session types', () => {
	assert.equal(resolveChatModeForSessionType('plan', 'local'), 'plan');
	assert.equal(resolveChatModeForSessionType('plan', ''), 'plan');
	assert.equal(resolveChatModeForSessionType('agent', 'agent-host-claude'), 'agent');
	assert.equal(resolveChatModeForSessionType(undefined, ''), 'agent');
});

test('isCodexAgentHostSessionType recognizes only the Codex agent host session type', () => {
	assert.equal(isCodexAgentHostSessionType('agent-host-codex'), true);
	assert.equal(isCodexAgentHostSessionType(' agent-host-codex '), true);
	assert.equal(isCodexAgentHostSessionType('agent-host-claude'), false);
	assert.equal(isCodexAgentHostSessionType(undefined), false);
});

test('shouldSetNewSessionDefaultAgentMode sets Agent only when the user did not configure the mode', () => {
	assert.equal(shouldSetNewSessionDefaultAgentMode(undefined), true);
	assert.equal(shouldSetNewSessionDefaultAgentMode({}), true);
	assert.equal(shouldSetNewSessionDefaultAgentMode({ globalValue: '  ' }), true);
	assert.equal(shouldSetNewSessionDefaultAgentMode({ globalValue: 'ask' }), false);
	assert.equal(shouldSetNewSessionDefaultAgentMode({ workspaceValue: 'agent' }), false);
	assert.equal(shouldSetNewSessionDefaultAgentMode({ workspaceFolderValue: 'plan' }), false);
});
