import test from 'node:test';
import assert from 'node:assert/strict';

type ModuleLoaderWithLoad = typeof import('node:module') & {
	_load: (request: string, parent: unknown, isMain: boolean) => unknown;
};

const moduleLoader = require('node:module') as ModuleLoaderWithLoad;
const originalModuleLoad = moduleLoader._load;

let selectChatModelsCalls = 0;
let sendRequestCalls = 0;
const configurationValues = new Map<string, unknown>();

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
					get: (key: string, defaultValue: unknown) => configurationValues.has(key)
						? configurationValues.get(key)
						: defaultValue,
				}),
				fs: {
					stat: async (uri: { fsPath: string }) => require('node:fs').promises.stat(uri.fsPath),
				},
			},
			Uri: {
				file: (fsPath: string) => ({ fsPath }),
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

test.beforeEach(() => {
	configurationValues.set('ai.enabled', true);
});

test.afterEach(() => {
	configurationValues.clear();
	selectChatModelsCalls = 0;
	sendRequestCalls = 0;
	selectChatModelsImpl = async () => [mockModel];
});

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
	(service as any).resolveStateDbPath = async () => null;
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

test('AiService includes custom endpoint models in the prompt model picker', async () => {
	selectChatModelsCalls = 0;
	selectChatModelsImpl = async () => [
		mockModel,
		{
			vendor: 'customendpoint',
			id: 'claude-fable-5',
			family: 'claude-fable-5',
			name: 'Tokenator - Claude Fable 5',
			identifier: 'customendpoint/tokenator/claude-fable-5',
		},
	];

	const service = new AiService();
	(service as any).resolveStateDbPath = async () => null;
	(service as any).getVisibleCopilotModels = async () => [
		{ id: 'gpt-5-mini', name: 'GPT-5 mini' },
	];

	const models = await service.getAvailableModels();

	assert.equal(selectChatModelsCalls, 1);
	assert.deepEqual(models, [
		{ id: 'gpt-5-mini', name: 'GPT-5 mini' },
		{ id: 'customendpoint/tokenator/claude-fable-5', name: 'Tokenator - Claude Fable 5' },
	]);
	selectChatModelsImpl = async () => [mockModel];
});

test('AiService restores custom endpoint identifiers from VS Code model cache', async () => {
	selectChatModelsCalls = 0;
	selectChatModelsImpl = async () => [
		mockModel,
		{
			vendor: 'customendpoint',
			id: 'claude-fable-5',
			family: 'claude-fable-5',
			name: 'Tokenator - Claude Fable 5',
		},
	];

	const service = new AiService();
	(service as any).resolveStateDbPath = async () => '/tmp/state.vscdb';
	(service as any).readStateItemValue = async (_dbPath: string, key: string) => {
		if (key === 'chatModelVisibility') {
			return JSON.stringify({
				hiddenModels: [
					'anthropic/Anthropic/claude-fable-5',
					'openrouter/OpenRouter/anthropic/claude-fable-5',
				],
			});
		}

		if (key === 'chat.cachedLanguageModels.v2') {
			return JSON.stringify([
				{
					identifier: 'customendpoint/tokenator/claude-fable-5',
					metadata: {
						id: 'claude-fable-5',
						vendor: 'customendpoint',
						family: 'claude-fable-5',
						name: 'Tokenator - Claude Fable 5',
						isUserSelectable: true,
					},
				},
				{
					identifier: 'anthropic/Anthropic/claude-fable-5',
					metadata: {
						id: 'claude-fable-5',
						vendor: 'anthropic',
						family: 'claude-fable-5',
						name: 'Claude Fable 5',
						isUserSelectable: true,
					},
				},
			]);
		}

		return '';
	};
	(service as any).getVisibleCopilotModels = async () => [
		{ id: 'gpt-5-mini', name: 'GPT-5 mini' },
	];

	const models = await service.getAvailableModels();

	assert.equal(selectChatModelsCalls, 1);
	assert.deepEqual(models, [
		{ id: 'gpt-5-mini', name: 'GPT-5 mini' },
		{ id: 'customendpoint/tokenator/claude-fable-5', name: 'Tokenator - Claude Fable 5' },
	]);
	selectChatModelsImpl = async () => [mockModel];
});

test('AiService keeps visible custom endpoint models from cache when live results omit them', async () => {
	selectChatModelsCalls = 0;
	selectChatModelsImpl = async () => [mockModel];

	const service = new AiService();
	(service as any).resolveStateDbPath = async () => '/tmp/state.vscdb';
	(service as any).readStateItemValue = async (_dbPath: string, key: string) => {
		if (key === 'chatModelVisibility') {
			return JSON.stringify({
				hiddenModels: [
					'openrouter/OpenRouter/qwen/qwen3-coder:free',
				],
			});
		}

		if (key === 'chat.cachedLanguageModels.v2') {
			return JSON.stringify([
				{
					identifier: 'customendpoint/tokenator/claude-fable-5',
					metadata: {
						id: 'claude-fable-5',
						vendor: 'customendpoint',
						family: 'claude-fable-5',
						name: 'Tokenator - Claude Fable 5',
						isUserSelectable: true,
					},
				},
				{
					identifier: 'openrouter/OpenRouter/qwen/qwen3-coder:free',
					metadata: {
						id: 'qwen/qwen3-coder:free',
						vendor: 'openrouter',
						family: 'qwen/qwen3-coder:free',
						name: 'Qwen: Qwen3 Coder 480B A35B (free)',
						isUserSelectable: true,
					},
				},
			]);
		}

		return '';
	};
	(service as any).getVisibleCopilotModels = async () => [
		{ id: 'gpt-5-mini', name: 'GPT-5 mini' },
	];

	const models = await service.getAvailableModels();

	assert.equal(selectChatModelsCalls, 1);
	assert.deepEqual(models, [
		{ id: 'gpt-5-mini', name: 'GPT-5 mini' },
		{ id: 'customendpoint/tokenator/claude-fable-5', name: 'Tokenator - Claude Fable 5' },
	]);
	selectChatModelsImpl = async () => [mockModel];
});

test('AiService excludes provider-scoped models hidden by the VS Code model picker state', async () => {
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
		{
			vendor: 'customendpoint',
			id: 'claude-fable-5',
			family: 'claude-fable-5',
			name: 'Tokenator - Claude Fable 5',
			identifier: 'customendpoint/tokenator/claude-fable-5',
		},
		{
			vendor: 'openrouter',
			id: 'qwen/qwen3-coder:free',
			family: 'qwen/qwen3-coder:free',
			name: 'Qwen: Qwen3 Coder 480B A35B (free)',
		},
		{
			vendor: 'anthropic',
			id: 'claude-fable-5',
			family: 'claude-fable-5',
			name: 'Anthropic - Claude Fable 5',
		},
	];

	const service = new AiService();
	(service as any).resolveStateDbPath = async () => '/tmp/state.vscdb';
	(service as any).readStateItemValue = async (_dbPath: string, key: string) => {
		if (key === 'chatModelPinned') {
			return JSON.stringify(['copilot/gpt-5.5']);
		}

		return key === 'chatModelVisibility'
			? JSON.stringify({
				hiddenModels: [
					'copilot/gpt-5-mini',
					'openrouter/OpenRouter/qwen/qwen3-coder:free',
					'anthropic/Anthropic/claude-fable-5',
				],
			})
			: '';
	};

	const models = await service.getAvailableModels();

	assert.equal(selectChatModelsCalls, 1);
	assert.deepEqual(models, [
		{ id: 'copilot/gpt-5.5', name: 'GPT-5.5' },
		{ id: 'customendpoint/tokenator/claude-fable-5', name: 'Tokenator - Claude Fable 5' },
	]);
	selectChatModelsImpl = async () => [mockModel];
});

test('AiService hides models whose provider section is hidden even when version separators differ', async () => {
	selectChatModelsCalls = 0;
	// Live models that do not resolve back to a cache entry (different display names),
	// so they keep their dotted ids and must still be matched against dashed hidden ids.
	selectChatModelsImpl = async () => [
		{ vendor: 'copilot', id: 'gpt-5.4', family: 'gpt-5.4', name: 'GPT-5.4' },
		{ vendor: 'anthropic', id: 'claude-sonnet-4.6', family: 'claude-sonnet-4.6', name: 'Anthropic Claude Sonnet 4.6 (BYOK)' },
		{ vendor: 'anthropic', id: 'claude-opus-4.7', family: 'claude-opus-4.7', name: 'Anthropic Claude Opus 4.7 (BYOK)' },
		{ vendor: 'openrouter', id: 'qwen/qwen3-coder', family: 'qwen/qwen3-coder', name: 'OpenRouter Qwen3 Coder (BYOK)' },
	];

	const service = new AiService();
	(service as any).resolveStateDbPath = async () => '/tmp/state.vscdb';
	(service as any).readStateItemValue = async (_dbPath: string, key: string) => {
		if (key === 'chatModelVisibility') {
			// The whole Anthropic and OpenRouter sections are hidden; VS Code persists
			// every member id with dashed version separators.
			return JSON.stringify({
				hiddenModels: [
					'anthropic/Anthropic/claude-sonnet-4-6',
					'anthropic/Anthropic/claude-opus-4-7',
					'openrouter/OpenRouter/qwen/qwen3-coder',
				],
			});
		}

		return '';
	};

	const models = await service.getAvailableModels();

	assert.equal(selectChatModelsCalls, 1);
	assert.deepEqual(models, [
		{ id: 'gpt-5.4', name: 'GPT-5.4' },
	]);
	selectChatModelsImpl = async () => [mockModel];
});

test('AiService excludes session-scoped live models bound to a chat session type', async () => {
	selectChatModelsCalls = 0;
	// The public selectChatModels() API returns session-bound providers (copilotcli, claude-code)
	// without exposing targetChatSessionType, so they must be filtered using cached metadata.
	selectChatModelsImpl = async () => [
		{ vendor: 'copilot', id: 'gpt-5.4', family: 'gpt-5.4', name: 'GPT-5.4' },
		{ vendor: 'copilot', id: 'claude-opus-4.8', family: 'claude-opus-4.8', name: 'Claude Opus 4.8' },
		{ vendor: 'copilotcli', id: 'claude-sonnet-4.6', family: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
		{ vendor: 'claude-code', id: 'claude-opus-4.8', family: 'claude-opus-4.8', name: 'Claude Opus 4.8' },
	];

	const service = new AiService();
	(service as any).resolveStateDbPath = async () => '/tmp/state.vscdb';
	(service as any).readStateItemValue = async (_dbPath: string, key: string) => {
		if (key === 'chat.cachedLanguageModels.v2') {
			return JSON.stringify([
				{ identifier: 'copilotcli/claude-sonnet-4.6', metadata: { id: 'claude-sonnet-4.6', vendor: 'copilotcli', family: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', isUserSelectable: true, targetChatSessionType: 'copilotcli' } },
				{ identifier: 'claude-code/claude-opus-4.8', metadata: { id: 'claude-opus-4.8', vendor: 'claude-code', family: 'claude-opus-4.8', name: 'Claude Opus 4.8', isUserSelectable: true, targetChatSessionType: 'claude-code' } },
			]);
		}

		return '';
	};

	const models = await service.getAvailableModels();

	assert.equal(selectChatModelsCalls, 1);
	// The session-scoped copilotcli/claude-code models must not appear; the regular Copilot
	// claude-opus-4.8 stays because it is not session-bound.
	assert.deepEqual(models, [
		{ id: 'claude-opus-4.8', name: 'Claude Opus 4.8' },
		{ id: 'gpt-5.4', name: 'GPT-5.4' },
	]);
	selectChatModelsImpl = async () => [mockModel];
});

test('AiService mirrors the promoted Copilot Chat model picker list', async () => {
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
		{
			vendor: 'copilot',
			id: 'gpt-5.5',
			family: 'gpt-5.5',
			name: 'GPT-5.5',
			identifier: 'copilot/gpt-5.5',
		},
		{
			vendor: 'copilot',
			id: 'claude-opus-4.8',
			family: 'claude-opus-4.8',
			name: 'Claude Opus 4.8',
			identifier: 'copilot/claude-opus-4.8',
		},
		{
			vendor: 'copilot',
			id: 'claude-fable-5',
			family: 'claude-fable-5',
			name: 'Claude Fable 5',
			identifier: 'copilot/claude-fable-5',
		},
		{
			vendor: 'copilot',
			id: 'gemini-3.1-pro-preview',
			family: 'gemini-3.1-pro-preview',
			name: 'Gemini 3.1 Pro (Preview)',
			identifier: 'copilot/gemini-3.1-pro-preview',
		},
		{
			vendor: 'customendpoint',
			id: 'claude-fable-5',
			family: 'claude-fable-5',
			name: 'Tokenator - Claude Fable 5',
		},
	];

	const service = new AiService();
	(service as any).resolveStateDbPath = async () => '/tmp/state.vscdb';
	(service as any).readStateItemValue = async (_dbPath: string, key: string) => {
		if (key === 'chatModelPinned') {
			return JSON.stringify([
				'copilot/gpt-5.4',
				'copilot/gpt-5.5',
				'customendpoint/tokenator/claude-fable-5',
			]);
		}

		if (key === 'chatModelRecentlyUsed') {
			return JSON.stringify([
				'copilot/gpt-5.5',
				'customendpoint/tokenator/claude-fable-5',
				'copilot/gpt-5.4',
			]);
		}

		if (key === 'chat.currentLanguageModel.chat') {
			return 'copilot/gpt-5.4';
		}

		if (key === 'chat.modelsControl') {
			return JSON.stringify({
				paid: {
					'gpt-5.5': { id: 'gpt-5.5', label: 'GPT-5.5', featured: true },
					'claude-sonnet-4.6': { id: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6', featured: true },
					'claude-opus-4.8': { id: 'claude-opus-4.8', label: 'Claude Opus 4.8', featured: true },
				},
			});
		}

		if (key === 'chatModelVisibility') {
			return JSON.stringify({
				hiddenModels: [
					'copilot/claude-sonnet-4.6',
					'copilot/gemini-3.1-pro-preview',
					'anthropic/Anthropic/claude-fable-5',
					'openrouter/OpenRouter/anthropic/claude-fable-5',
				],
			});
		}

		if (key === 'chat.cachedLanguageModels.v2') {
			return JSON.stringify([
				{
					identifier: 'customendpoint/tokenator/claude-fable-5',
					metadata: {
						id: 'claude-fable-5',
						vendor: 'customendpoint',
						family: 'claude-fable-5',
						name: 'Tokenator - Claude Fable 5',
						isUserSelectable: true,
					},
				},
			]);
		}

		return '';
	};

	const models = await service.getAvailableModels();

	assert.equal(selectChatModelsCalls, 1);
	assert.deepEqual(models, [
		{ id: 'copilot/gpt-5.4', name: 'GPT-5.4' },
		{ id: 'copilot/gpt-5.5', name: 'GPT-5.5' },
		{ id: 'customendpoint/tokenator/claude-fable-5', name: 'Tokenator - Claude Fable 5' },
		{ id: 'copilot/claude-opus-4.8', name: 'Claude Opus 4.8' },
		{ id: 'gpt-5-mini', name: 'GPT-5 mini' },
	]);
	assert.equal(models.some(model => model.name === 'Claude Fable 5'), false);
	assert.equal(models.some(model => model.name === 'Gemini 3.1 Pro (Preview)'), false);
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
		{
			vendor: 'copilot',
			id: 'claude-sonnet-4.6',
			family: 'claude-sonnet-4.6',
			name: 'Claude Sonnet 4.6',
			identifier: 'copilot/claude-sonnet-4.6',
		},
	];

	const service = new AiService();
	(service as any).resolveStateDbPath = async () => '/tmp/state.vscdb';
	(service as any).readStateItemValue = async (_dbPath: string, key: string) => {
		if (key === 'chat.currentLanguageModel.chat') {
			return 'copilot/gpt-5.4';
		}

		if (key === 'chat.modelsControl') {
			return JSON.stringify({
				paid: {
					'gpt-5.4': { id: 'gpt-5.4', label: 'GPT-5.4', featured: true },
					'claude-sonnet-4.6': { id: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6', featured: true },
				},
			});
		}

		return '';
	};

	const models = await service.getAvailableModels();

	assert.equal(selectChatModelsCalls, 1);
	assert.deepEqual(models, [
		{ id: 'copilot/gpt-5.4', name: 'GPT-5.4' },
		{ id: 'copilot/claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
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

test('AiService resolves custom endpoint identifiers for chat startup flows', async () => {
	selectChatModelsCalls = 0;
	selectChatModelsImpl = async () => [
		mockModel,
		{
			vendor: 'customendpoint',
			id: 'claude-fable-5',
			family: 'claude-fable-5',
			name: 'Tokenator - Claude Fable 5',
			identifier: 'customendpoint/tokenator/claude-fable-5',
		},
	];

	const service = new AiService();
	const storageIdentifier = await service.resolveModelStorageIdentifier('customendpoint/tokenator/claude-fable-5');
	const selector = await service.resolveChatOpenModelSelector('customendpoint/tokenator/claude-fable-5');

	assert.equal(storageIdentifier, 'customendpoint/tokenator/claude-fable-5');
	assert.deepEqual(selector, {
		vendor: 'customendpoint',
		id: 'claude-fable-5',
		family: 'claude-fable-5',
	});
	selectChatModelsImpl = async () => [mockModel];
});

test('AiService skips internal AI requests when Prompt Manager AI setting is disabled', async () => {
	configurationValues.set('ai.enabled', false);

	const service = new AiService();
	const title = await service.generateTitle('Сгенерируй заголовок');

	assert.equal(title, 'Промпт без названия');
	assert.equal(selectChatModelsCalls, 0);
	assert.equal(sendRequestCalls, 0);
});

test('AiService picks the state database that actually holds the chat picker state', async () => {
	const os = require('node:os') as typeof import('node:os');
	const fs = require('node:fs') as typeof import('node:fs');
	const path = require('node:path') as typeof import('node:path');

	// An empty Extension Development Host database (no picker state) plus the real
	// profile database that carries the user's hidden models.
	const emptyDb = path.join(os.tmpdir(), `pm-empty-${Date.now()}.vscdb`);
	const activeDb = path.join(os.tmpdir(), `pm-active-${Date.now()}.vscdb`);
	fs.writeFileSync(emptyDb, 'empty');
	fs.writeFileSync(activeDb, 'active');

	try {
		const service = new AiService();
		(service as any).getStateDbCandidates = () => [emptyDb, activeDb];
		(service as any).readStateItemValue = async (dbPath: string, key: string) => {
			if (key === 'chatModelVisibility' && dbPath === activeDb) {
				return JSON.stringify({ hiddenModels: ['copilot/claude-sonnet-4.6'] });
			}

			return '';
		};

		const resolved = await (service as any).resolveStateDbPath();
		assert.equal(resolved, activeDb);
	} finally {
		fs.rmSync(emptyDb, { force: true });
		fs.rmSync(activeDb, { force: true });
	}
});