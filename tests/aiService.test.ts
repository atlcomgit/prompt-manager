import test from 'node:test';
import assert from 'node:assert/strict';

type ModuleLoaderWithLoad = typeof import('node:module') & {
	_load: (request: string, parent: unknown, isMain: boolean) => unknown;
};

const moduleLoader = require('node:module') as ModuleLoaderWithLoad;
const originalModuleLoad = moduleLoader._load;

let selectChatModelsCalls = 0;
let sendRequestCalls = 0;

const mockModel = {
	vendor: 'copilot',
	id: 'gpt-5-mini',
	family: 'gpt-5-mini',
	name: 'GPT-5 mini',
	sendRequest: async () => {
		sendRequestCalls += 1;
		return {
			text: (async function* () {
				yield 'ok';
			})(),
		};
	},
};

let selectChatModelsImpl: () => Promise<any[]> = async () => [mockModel];

moduleLoader._load = (request, parent, isMain) => {
	if (request === 'vscode') {
		class CancellationTokenSource {
			public token = { isCancellationRequested: false };

			cancel(): void {
				this.token.isCancellationRequested = true;
			}

			dispose(): void {
				this.cancel();
			}
		}

		return {
			window: {
				createOutputChannel: () => ({
					appendLine: () => undefined,
					show: () => undefined,
					dispose: () => undefined,
				}),
			},
			workspace: {
				workspaceFolders: undefined,
				getConfiguration: () => ({
					get: (_key: string, defaultValue: unknown) => defaultValue,
				}),
			},
			env: {
				language: 'ru',
			},
			lm: {
				selectChatModels: async () => {
					selectChatModelsCalls += 1;
					return selectChatModelsImpl();
				},
			},
			LanguageModelChatMessage: {
				User: (text: string) => ({ role: 'user', text }),
			},
			CancellationTokenSource,
		};
	}

	return originalModuleLoad(request, parent, isMain);
};

const { AiService } = require('../src/services/aiService.js') as typeof import('../src/services/aiService.js');
moduleLoader._load = originalModuleLoad;

test('AiService reuses the selected Copilot model across consecutive requests', async () => {
	selectChatModelsCalls = 0;
	sendRequestCalls = 0;
	selectChatModelsImpl = async () => [mockModel];

	const service = new AiService();
	await service.generateTitle('Сгенерируй заголовок');
	await service.generateDescription('Сгенерируй описание');

	assert.equal(sendRequestCalls, 2);
	assert.equal(selectChatModelsCalls, 1);
});

test('AiService keeps live Copilot models that are missing from visible cache state', async () => {
	selectChatModelsCalls = 0;
	selectChatModelsImpl = async () => [
		mockModel,
		{
			vendor: 'copilot',
			id: 'gpt-5.5',
			family: 'gpt-5.5',
			name: 'GPT-5.5',
			identifier: 'copilot/gpt-5.5',
		},
	];

	const service = new AiService();
	(service as any).getVisibleCopilotModels = async () => [
		{ id: 'gpt-5-mini', name: 'GPT-5 mini' },
	];

	const models = await service.getAvailableModels();

	assert.equal(selectChatModelsCalls, 1);
	assert.deepEqual(models, [
		{ id: 'gpt-5-mini', name: 'GPT-5 mini' },
		{ id: 'copilot/gpt-5.5', name: 'GPT-5.5' },
	]);
	selectChatModelsImpl = async () => [mockModel];
});

test('AiService prefers modelsControl over stale legacy cache for visible models', async () => {
	selectChatModelsCalls = 0;
	selectChatModelsImpl = async () => [
		mockModel,
		{
			vendor: 'copilot',
			id: 'gpt-5.4',
			family: 'gpt-5.4',
			name: 'GPT-5.4',
			identifier: 'copilot/gpt-5.4',
		},
	];

	const service = new AiService();
	(service as any).resolveStateDbPath = async () => '/tmp/state.vscdb';
	(service as any).getVisibleCopilotModelsFromWorkspaceSessions = async () => [];
	(service as any).getVisibleCopilotModelsFromCache = async () => [];
	(service as any).getVisibleCopilotModelsFromControl = async () => [
		{ id: 'gpt-5.4', name: 'GPT-5.4' },
		{ id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
	];
	(service as any).getVisibleCopilotModelsFromLegacyCache = async () => [
		{ id: 'gpt-4.1', name: 'GPT-4.1' },
		{ id: 'oswe-vscode-prime', name: 'Raptor mini (Preview)' },
	];

	const models = await service.getAvailableModels();

	assert.equal(selectChatModelsCalls, 1);
	assert.deepEqual(models, [
		{ id: 'gpt-5.4', name: 'GPT-5.4' },
		{ id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
		{ id: 'gpt-5-mini', name: 'GPT-5 mini' },
	]);
	selectChatModelsImpl = async () => [mockModel];
});

test('AiService prefers modelsControl over stale legacy cache for free models', async () => {
	selectChatModelsCalls = 0;
	selectChatModelsImpl = async () => [mockModel];

	const service = new AiService();
	(service as any).resolveStateDbPath = async () => '/tmp/state.vscdb';
	(service as any).getVisibleCopilotModelsFromControl = async () => [
		{ id: 'gpt-5.4', name: 'GPT-5.4' },
		{ id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5' },
	];
	(service as any).getVisibleCopilotModelsFromCache = async () => [
		{ id: 'gpt-4.1', name: 'GPT-4.1' },
	];
	(service as any).getVisibleCopilotModelsFromLegacyCache = async () => [
		{ id: 'oswe-vscode-prime', name: 'Raptor mini (Preview)' },
	];

	const models = await service.getAvailableFreeModels();

	assert.equal(selectChatModelsCalls, 1);
	assert.deepEqual(models, [
		{ id: 'gpt-5.4', name: 'GPT-5.4' },
		{ id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5' },
	]);
	selectChatModelsImpl = async () => [mockModel];
});

test('AiService clears cached Copilot model selectors and state snapshots on demand', () => {
	const service = new AiService();
	(service as any).selectedModelCache.set('selector', {
		model: mockModel,
		expiresAtMs: Date.now() + 60_000,
	});
	(service as any).stateDbItemCache.set('/tmp/state.vscdb', {
		fingerprint: 'fingerprint',
		items: new Map([['chat.modelsControl', '{}']]),
	});

	service.clearCopilotModelCaches();

	assert.equal((service as any).selectedModelCache.size, 0);
	assert.equal((service as any).stateDbItemCache.size, 0);
});