import test from 'node:test';
import assert from 'node:assert/strict';

type ModuleLoaderWithLoad = typeof import('node:module') & {
	_load: (request: string, parent: unknown, isMain: boolean) => unknown;
};

const moduleLoader = require('node:module') as ModuleLoaderWithLoad;
const originalModuleLoad = moduleLoader._load;

let selectChatModelsCalls = 0;
/** Селекторы показывают, создаётся ли весь каталог вместо адресного API одной модели. */
const modelSelections: Array<import('vscode').LanguageModelChatSelector | undefined> = [];
let sendRequestCalls = 0;
const configurationValues = new Map<string, unknown>();
/** Снимки запросов и ресурсов позволяют проверить инструкции без LM, диска и рабочего VS Code. */
const modelRequests: Array<Array<{ text: string }>> = [];
const configurationScopes: Array<string | undefined> = [];
const instructionFiles = new Map<string, string>();
const readInstructionFiles: string[] = [];
const aiLogLines: string[] = [];
let disposedTokenSources = 0;
/** Управляемые события VS Code проверяют инвалидирование без реальных аккаунтов и Extension Host. */
const modelCatalogListeners = new Set<() => void>();
const authenticationListeners = new Set<(event: { provider: { id: string } }) => void>();

const mockModel = {
	vendor: 'copilot',
	id: 'gpt-5-mini',
	family: 'gpt-5-mini',
	name: 'GPT-5 mini',
	sendRequest: async (messages: Array<{ text: string }>) => {
		sendRequestCalls += 1;
		modelRequests.push(messages);
		return {
			text: (async function* () {
				yield 'ok';
			})(),
		};
	},
};

let selectChatModelsImpl: (selector?: import('vscode').LanguageModelChatSelector) => Promise<any[]> = async () => [mockModel];

moduleLoader._load = (request, parent, isMain) => {
	if (request === 'vscode') {
		class CancellationTokenSource {
			public token = { isCancellationRequested: false };

			cancel(): void {
				this.token.isCancellationRequested = true;
			}

			dispose(): void {
				disposedTokenSources += 1;
				this.cancel();
			}
		}

		return {
			window: {
				createOutputChannel: () => ({
					appendLine: (line: string) => aiLogLines.push(line),
					show: () => undefined,
					dispose: () => undefined,
				}),
			},
			workspace: {
				workspaceFolders: undefined,
				getConfiguration: (_section: unknown, scope?: { fsPath: string }) => {
					configurationScopes.push(scope?.fsPath);
					return {
					get: (key: string, defaultValue: unknown) => configurationValues.has(key)
						? configurationValues.get(key)
						: defaultValue,
					};
				},
				fs: {
					stat: async (uri: { fsPath: string }) => require('node:fs').promises.stat(uri.fsPath),
					readFile: async (uri: { fsPath: string }) => {
						readInstructionFiles.push(uri.fsPath);
						const text = instructionFiles.get(uri.fsPath);
						if (text === undefined) { throw new Error('missing fixture'); }
						return Buffer.from(text);
					},
				},
			},
			Uri: {
				file: (fsPath: string) => ({ fsPath }),
				joinPath: (uri: { fsPath: string }, ...parts: string[]) => ({
					fsPath: require('node:path').join(uri.fsPath, ...parts),
				}),
			},
			env: {
				language: 'ru',
			},
			lm: {
				onDidChangeChatModels: (listener: () => void) => {
					modelCatalogListeners.add(listener);
					return { dispose: () => modelCatalogListeners.delete(listener) };
				},
				selectChatModels: async (selector?: import('vscode').LanguageModelChatSelector) => {
					selectChatModelsCalls += 1;
					modelSelections.push(selector);
					return selectChatModelsImpl(selector);
				},
			},
			authentication: {
				onDidChangeSessions: (listener: (event: { provider: { id: string } }) => void) => {
					authenticationListeners.add(listener);
					return { dispose: () => authenticationListeners.delete(listener) };
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
	modelRequests.length = 0;
	configurationScopes.length = 0;
	instructionFiles.clear();
	readInstructionFiles.length = 0;
	aiLogLines.length = 0;
	disposedTokenSources = 0;
	selectChatModelsCalls = 0;
	modelSelections.length = 0;
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

test('AiService includes custom endpoint models in the Chat model picker', async () => {
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

test('AiService restores visible custom endpoint identifiers from VS Code model cache', async () => {
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

test('AiService keeps visible custom endpoint cache entries when live results omit them', async () => {
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

test('AiService keeps hidden Copilot models and visible external providers', async () => {
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
		{ id: 'gpt-5-mini', name: 'GPT-5 mini' },
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
		{ id: 'copilot/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (Preview)' },
		{ id: 'gpt-5-mini', name: 'GPT-5 mini' },
	]);
	assert.equal(models.some(model => model.id.startsWith('customendpoint/')), true);
	assert.equal(models.some(model => model.name === 'Gemini 3.1 Pro (Preview)'), true);
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

test('AiService resolves only GitHub Copilot Chat model families for internal settings', async () => {
	selectChatModelsCalls = 0;
	selectChatModelsImpl = async () => [
		mockModel,
		{
			vendor: 'copilot',
			id: 'claude-sonnet-4.6',
			family: 'claude-sonnet-4.6',
			name: 'Claude Sonnet 4.6',
			identifier: 'copilot/claude-sonnet-4.6',
		},
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

	assert.equal(await service.resolveCopilotModelFamily('copilot/claude-sonnet-4.6'), 'claude-sonnet-4.6');
	assert.equal(await service.resolveCopilotModelFamily('customendpoint/tokenator/claude-fable-5'), '');
	assert.deepEqual(await service.getAvailableCopilotModelFamilies(), [
		{ id: 'gpt-5-mini', name: 'GPT-5 mini' },
		{ id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
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
	const fs = require('node:fs') as typeof import('node:fs');
	const path = require('node:path') as typeof import('node:path');

	// An empty Extension Development Host database (no picker state) plus the real
	// profile database that carries the user's hidden models.
	// Это текстовые фикстуры: SQL-reader подменён, рабочие БД не открываются.
	const directory = fs.mkdtempSync('/tmp/opencode/commit-models-172-');
	const emptyDb = path.join(directory, 'testing-empty.vscdb');
	const activeDb = path.join(directory, 'testing-active.vscdb');
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
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

/** Объектные инструкции, ссылки на файлы и номер задачи доходят до реального построителя LM-запроса. */
test('AiService commit instructions preserve text, file order, project scope and task context', async () => {
	configurationValues.set('debugLogging.enabled', true);
	configurationValues.set('github.copilot.chat.commitMessageGeneration.instructions', [
		{ text: 'Одной строкой, от первого лица в прошедшем времени, до 100 символов.' },
		{ file: '.github/commit.md' },
		'Без точки в конце',
		{ text: 'Используй taskNumber текущего промпта.' },
		{ text: 'Упоминай тесты только тогда, когда коммит касается исключительно тестов.' },
		null, 123, { unknown: true },
	]);
	instructionFiles.set('/workspace/web/.github/commit.md', 'Формат: 🅰️🅻🅴🅺 <taskNumber> | <описание>');
	const service = new AiService();
	assert.equal(await service.generateCommitMessage({
		projectName: 'web', projectPath: '/workspace/web', taskNumber: '00172',
		currentBranch: 'master', stagedChangesSummary: 'Исправление обработки инструкций',
	}), 'ok');
	const [system, user] = modelRequests[0];
	assert.match(system.text, /Одной строкой[^]*Формат: 🅰️🅻🅴🅺[^]*Без точки[^]*Используй taskNumber/);
	assert.match(system.text, /Упоминай тесты только тогда, когда коммит касается исключительно тестов\./);
	assert.doesNotMatch(system.text, /\[object Object\]|72 characters|imperative/);
	assert.match(user.text, /Current prompt taskNumber: 00172/);
	assert.match(user.text, /Current Git branch: master/);
	assert.ok(configurationScopes.includes('/workspace/web'));
	assert.deepEqual(readInstructionFiles, ['/workspace/web/.github/commit.md']);
	assert.equal(disposedTokenSources, 1);
	assert.ok(aiLogLines.some(line => /stage=selectModel phase=finish durationMs=\d+/.test(line)));
	assert.ok(aiLogLines.some(line => /stage=response durationMs=\d+/.test(line)));
});

/** Ошибка файла не подменяет результат сообщением, сгенерированным без обязательных правил. */
test('AiService does not silently drop unavailable commit instruction files', async () => {
	configurationValues.set('github.copilot.chat.commitMessageGeneration.instructions', [{ file: 'missing.md' }]);
	await assert.rejects(new AiService().generateCommitMessage({
		projectPath: '/workspace/web', stagedChangesSummary: 'diff',
	}), /файл инструкций/);
	assert.equal(selectChatModelsCalls, 0);
	assert.equal(sendRequestCalls, 0);
});

/** Выключение AI запрещает даже чтение ссылочных правил commit. */
test('AiService disabled commit generation skips instructions and model discovery', async () => {
	configurationValues.set('ai.enabled', false);
	configurationValues.set('github.copilot.chat.commitMessageGeneration.instructions', [{ file: 'missing.md' }]);
	assert.equal(await new AiService().generateCommitMessage({ stagedChangesSummary: '' }), '');
	assert.deepEqual(readInstructionFiles, []);
	assert.equal(selectChatModelsCalls, 0);
});

/** Локальные метаданные заменяют БД; реальные функции сервиса определяют допустимые бесплатные модели. */
function stubFreeModelCatalog(service: InstanceType<typeof AiService>, freeIds: string[], cachedIds = freeIds): void {
	(service as unknown as { resolveStateDbPath: () => Promise<string> }).resolveStateDbPath = async () => '/testing-state';
	(service as unknown as { readStateItemValue: (path: string, key: string) => Promise<string> }).readStateItemValue = async (_path, key) => {
		if (key === 'chat.modelsControl') {
			return JSON.stringify({ free: Object.fromEntries(freeIds.map(id => [id, { id, label: id, featured: true }])) });
		}
		if (key === 'chat.cachedLanguageModels.v2') {
			return JSON.stringify(cachedIds.map(id => ({ identifier: `copilot/${id}`,
				metadata: { id, vendor: 'copilot', family: id, name: id, isUserSelectable: true } })));
		}
		return '';
	};
}

/** Холодный fallback выбирает один бесплатный id; последующие внутренние сценарии переиспользуют выбранную модель. */
test('AiService selects a cached free candidate without enumerating all models', async () => {
	configurationValues.set('debugLogging.enabled', true);
	const freeModel = { ...mockModel, id: 'gpt-6-luna', family: 'gpt-6-luna' };
	selectChatModelsImpl = async selector => selector?.id === freeModel.id ? [freeModel] : [];
	const service = new AiService();
	stubFreeModelCatalog(service, [freeModel.id]);
	assert.equal(await service.generateCommitMessage({ stagedChangesSummary: 'diff' }), 'ok');
	assert.equal(await service.generateTitle('title'), 'ok');
	assert.equal(await service.generateDescription('description'), 'ok');
	assert.deepEqual(modelSelections, [
		{ vendor: 'copilot', family: 'gpt-5-mini' }, { vendor: 'copilot', id: freeModel.id },
	]);
	assert.equal(sendRequestCalls, 3);
	assert.ok(aiLogLines.some(line => line.includes('stage=fallbackCandidate phase=finish')));
	assert.ok(!aiLogLines.some(line => line.includes('stage=fallbackModels')));
});

/** Устаревший id или ошибка адресного API сохраняют поиск остальных кандидатов и полный резервный путь. */
for (const staleResult of ['empty', 'error', 'missing-cache'] as const) {
	test(`AiService refreshes free candidates after ${staleResult}`, async () => {
		const freeModel = { ...mockModel, id: 'gpt-6-luna', family: 'gpt-6-luna' };
		const service = new AiService();
		stubFreeModelCatalog(service, ['retired-free', freeModel.id], staleResult === 'missing-cache' ? [] : ['retired-free']);
		selectChatModelsImpl = async selector => {
			if (selector?.id === 'retired-free' && staleResult === 'error') { throw new Error('stale id'); }
			return selector?.family || selector?.id ? [] : [freeModel];
		};
		assert.equal(await service.generateCommitMessage({ stagedChangesSummary: '+code' }), 'ok');
		assert.deepEqual(modelSelections, [
			{ vendor: 'copilot', family: 'gpt-5-mini' },
			...(staleResult === 'missing-cache' ? [] : [{ vendor: 'copilot', id: 'retired-free' }]),
			undefined,
		]);
		assert.equal(sendRequestCalls, 1);
	});
}

/** Отказ первого бесплатного кандидата не включает полный каталог, пока доступен следующий адресный кандидат. */
test('AiService tries the next cached free candidate after a targeted failure', async () => {
	const freeModel = { ...mockModel, id: 'gpt-6-luna', family: 'gpt-6-luna' };
	const service = new AiService();
	stubFreeModelCatalog(service, ['retired-free', freeModel.id]);
	selectChatModelsImpl = async selector => {
		if (selector?.id === 'retired-free') { throw new Error('stale id'); }
		return selector?.id === freeModel.id ? [freeModel] : [];
	};
	assert.equal(await service.generateCommitMessage({ stagedChangesSummary: '+code' }), 'ok');
	assert.deepEqual(modelSelections, [
		{ vendor: 'copilot', family: 'gpt-5-mini' }, { vendor: 'copilot', id: 'retired-free' },
		{ vendor: 'copilot', id: freeModel.id },
	]);
});

/** Управляемое завершение исключает ожидания таймеров из проверок совместной загрузки и гонок. */
function deferredModels() {
	let resolve!: (models: typeof mockModel[]) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<typeof mockModel[]>((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
}

/** Восстановление вкладки и ручной запрос дожидаются тех же провайдеров, что и автоматический прогрев. */
test('AiService waits for provider activation before loading the shared catalog', async t => {
	let finishStartup!: (ready: boolean) => void;
	const readiness = new Promise<boolean>(resolve => { finishStartup = resolve; });
	const service = new AiService(undefined, () => readiness);
	t.after(() => service.dispose());
	stubFreeModelCatalog(service, [mockModel.id]);
	const panel = service.getAvailableModels();
	const command = service.generateTitle('title');
	let notifications = 0;
	service.initializeModelCatalog(() => { notifications++; });
	service.clearCopilotModelCaches();
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual(modelSelections, []);
	assert.equal(modelCatalogListeners.size, 0);
	assert.equal(authenticationListeners.size, 0);
	finishStartup(true);
	assert.ok((await panel).some(model => model.id.includes(mockModel.id)));
	assert.equal(await command, 'ok');
	assert.deepEqual(modelSelections, [undefined]);
	assert.equal(notifications, 1);
	assert.equal(modelCatalogListeners.size, 1);
	assert.equal(authenticationListeners.size, 1);
});

/** Холодный адресный запрос к одной модели также подчиняется готовности и отмене при завершении. */
for (const outcome of ['ready', 'canceled', 'disposed'] as const) {
	test(`AiService gates a cold model query when startup is ${outcome}`, async t => {
		let finishStartup!: (ready: boolean) => void;
		const readiness = new Promise<boolean>(resolve => { finishStartup = resolve; });
		const service = new AiService(undefined, () => readiness);
		t.after(() => service.dispose());
		stubFreeModelCatalog(service, []);
		const request = service.generateCommitMessage({ stagedChangesSummary: '+code' });
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(modelSelections, []);
		if (outcome === 'disposed') { service.dispose(); }
		finishStartup(outcome !== 'canceled');
		assert.equal(await request, outcome === 'ready' ? 'ok' : '');
		assert.deepEqual(modelSelections, outcome === 'ready' ? [{ vendor: 'copilot', family: mockModel.family }] : []);
	});
}

/** Прогрев общий для picker, бесплатного списка и нескольких Git Flow проектов, даже после TTL выбранной модели. */
test('AiService warmup shares one catalog with concurrent pickers and commit requests', async t => {
	configurationValues.set('debugLogging.enabled', true);
	const service = new AiService();
	t.after(() => service.dispose());
	const freeModel = { ...mockModel, id: 'gpt-6-luna', family: 'gpt-6-luna' };
	stubFreeModelCatalog(service, [freeModel.id]);
	const pending = deferredModels();
	selectChatModelsImpl = () => pending.promise;
	let notifications = 0;
	service.initializeModelCatalog(() => { notifications++; });
	service.initializeModelCatalog(() => { assert.fail('duplicate initialization'); });
	const results = Promise.all([
		service.getAvailableModels(), service.getAvailableModels(), service.getAvailableFreeModels(),
		service.generateCommitMessage({ stagedChangesSummary: '+code one' }),
		service.generateCommitMessage({ stagedChangesSummary: '+code two' }),
	]);
	assert.equal(selectChatModelsCalls, 1);
	assert.equal(sendRequestCalls, 0);
	pending.resolve([freeModel]);
	const [first, second, free, commitOne, commitTwo] = await results;
	assert.deepEqual(first, second);
	assert.ok(first.some(model => model.id.includes(freeModel.id)));
	assert.deepEqual(free, [{ id: freeModel.id, name: freeModel.id }]);
	assert.equal(commitOne, 'ok');
	assert.equal(commitTwo, 'ok');
	assert.equal(notifications, 1);
	const later = Date.now() + 120_000;
	t.mock.method(Date, 'now', () => later);
	await service.generateTitle('title');
	await service.generateDescription('description');
	assert.deepEqual(modelSelections, [undefined]);
	assert.equal(sendRequestCalls, 4);
	assert.equal(aiLogLines.filter(line => line.includes('label=model-catalog result=loaded')).length, 1);
	assert.ok(aiLogLines.some(line => line.includes('label=model-catalog result=cache-hit') && line.includes('gpt-6-luna')));
});

/** События моделей и GitHub очищают общий и выбранный кеш; сторонняя auth-сессия не вызывает новый запрос. */
test('AiService refreshes the catalog after model and account changes', async t => {
	const service = new AiService();
	t.after(() => service.dispose());
	stubFreeModelCatalog(service, [mockModel.id]);
	let activeModel = mockModel;
	selectChatModelsImpl = async () => [activeModel];
	let notifications = 0;
	service.initializeModelCatalog(() => { notifications++; });
	await service.getAvailableModels();
	await service.generateTitle('first');
	for (const listener of authenticationListeners) { listener({ provider: { id: 'other' } }); }
	await service.getAvailableModels();
	assert.equal(selectChatModelsCalls, 1);
	for (const kind of ['catalog', 'github', 'github-enterprise']) {
		activeModel = { ...mockModel, sendRequest: async messages => {
			const response = await mockModel.sendRequest(messages);
			return { ...response, text: (async function* () { yield kind; })() };
		} };
		if (kind === 'catalog') {
			for (const listener of modelCatalogListeners) { listener(); }
		} else {
			for (const listener of authenticationListeners) { listener({ provider: { id: kind } }); }
		}
		await service.getAvailableModels();
		assert.equal(await service.generateTitle('new account'), kind);
	}
	assert.equal(selectChatModelsCalls, 4);
	assert.equal(notifications, 4);
});

/** Несколько событий во время RPC объединяются; старый аккаунт не попадает в списки и запросы. */
test('AiService discards stale catalog completion and coalesces invalidations', async t => {
	const service = new AiService();
	t.after(() => service.dispose());
	stubFreeModelCatalog(service, [mockModel.id]);
	const old = deferredModels();
	const fresh = { ...mockModel, name: 'New account', sendRequest: async (messages: Array<{ text: string }>) => {
		await mockModel.sendRequest(messages);
		return { text: (async function* () { yield 'fresh'; })() };
	} };
	selectChatModelsImpl = () => selectChatModelsCalls === 1 ? old.promise : Promise.resolve([fresh]);
	let notifications = 0;
	service.initializeModelCatalog(() => { notifications++; });
	const picker = service.getAvailableModels();
	const commit = service.generateCommitMessage({ stagedChangesSummary: '+code' });
	for (let index = 0; index < 3; index++) { service.clearCopilotModelCaches(); }
	assert.equal(selectChatModelsCalls, 1);
	old.resolve([{ ...mockModel, sendRequest: async () => { assert.fail('stale model'); } }]);
	await picker;
	assert.equal(await commit, 'fresh');
	assert.equal(selectChatModelsCalls, 2);
	assert.equal(notifications, 1);
});

/** Ошибка и пустой каталог не закрепляются на весь сеанс; ближайший запрос после backoff повторяет загрузку. */
for (const failure of ['empty', 'error', 'partial'] as const) {
	test(`AiService retries a ${failure} catalog and preserves the Copilot fallback`, async t => {
		const service = new AiService();
		t.after(() => service.dispose());
		stubFreeModelCatalog(service, []);
		let recovering = false;
		selectChatModelsImpl = async selector => {
			if (recovering) { return [mockModel]; }
			if (failure === 'empty') { return []; }
			if (failure === 'partial' && selector?.vendor === 'copilot') { return [mockModel]; }
			throw new Error('provider unavailable');
		};
		service.initializeModelCatalog(() => undefined);
		await service.getAvailableModels();
		const callsBeforeRetry = selectChatModelsCalls;
		await service.getAvailableModels();
		assert.equal(selectChatModelsCalls, callsBeforeRetry);
		if (failure === 'partial') { assert.equal(await service.generateTitle('fallback'), 'ok'); }
		recovering = true;
		const later = Date.now() + 2000;
		t.mock.method(Date, 'now', () => later);
		const models = await service.getAvailableModels();
		assert.ok(models.some(model => model.id.includes(mockModel.id)));
		assert.equal(selectChatModelsCalls, callsBeforeRetry + 1);
	});
}

/** Изменение visibility не требует нового дорогого LM-каталога, но должно менять выдачу picker. */
test('AiService keeps picker metadata current while reusing the live catalog', async t => {
	const service = new AiService();
	t.after(() => service.dispose());
	const external = { ...mockModel, vendor: 'customendpoint', id: 'external', family: 'external' };
	selectChatModelsImpl = async () => [external];
	let hidden = false;
	(service as unknown as { resolveStateDbPath: () => Promise<string> }).resolveStateDbPath = async () => '/testing-state';
	(service as unknown as { readStateItemValue: (path: string, key: string) => Promise<string> }).readStateItemValue =
		async (_path, key) => key === 'chatModelVisibility' && hidden
			? JSON.stringify({ hiddenModels: ['customendpoint/external'] }) : '';
	assert.equal((await service.getAvailableModels()).length, 1);
	hidden = true;
	assert.deepEqual(await service.getAvailableModels(), []);
	assert.equal(selectChatModelsCalls, 1);
});

/** Прогретый список не даёт разрешения использовать платную или похожую модель в free-only fallback. */
test('AiService warm catalog keeps free-only fallback and exact vendor/id matching', async t => {
	const service = new AiService();
	t.after(() => service.dispose());
	stubFreeModelCatalog(service, ['gpt-free']);
	selectChatModelsImpl = async () => [
		{ ...mockModel, id: 'gpt-free-premium', family: 'gpt-free', name: 'gpt-free' },
		{ ...mockModel, vendor: 'other', id: 'gpt-free', family: 'gpt-free' },
	];
	service.initializeModelCatalog(() => undefined);
	await service.getAvailableModels();
	assert.equal(await service.generateCommitMessage({ stagedChangesSummary: '+code' }), '');
	assert.equal(sendRequestCalls, 0);
	assert.equal(selectChatModelsCalls, 1);
});

/** Dispose запрещает позднее уведомление и запрос модели; снимает обе подписки и таймер восстановления. */
for (const outcome of ['success', 'error'] as const) {
	test(`AiService disposal ignores pending catalog ${outcome} and removes listeners`, async () => {
		const service = new AiService();
		stubFreeModelCatalog(service, [mockModel.id]);
		const pending = deferredModels();
		selectChatModelsImpl = () => pending.promise;
		service.initializeModelCatalog(() => { assert.fail('notification after dispose'); });
		const picker = service.getAvailableModels();
		const commit = service.generateCommitMessage({ stagedChangesSummary: '+code' });
		service.dispose();
		if (outcome === 'success') { pending.resolve([mockModel]); }
		else { pending.reject(new Error('late provider error')); }
		assert.deepEqual(await picker, []);
		assert.equal(await commit, '');
		assert.equal(modelCatalogListeners.size, 0);
		assert.equal(authenticationListeners.size, 0);
		assert.equal(sendRequestCalls, 0);
		assert.equal(selectChatModelsCalls, 1);
	});
}

/** Автоповторы ограничены двумя попытками, а dispose отменяет ещё не наступившую попытку. */
test('AiService bounds background retries and cancels their timer on disposal', async t => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
	const service = new AiService();
	t.after(() => service.dispose());
	stubFreeModelCatalog(service, []);
	selectChatModelsImpl = async () => [];
	service.initializeModelCatalog(() => undefined);
	await service.getAvailableModels();
	for (const delay of [1500, 5000]) {
		t.mock.timers.tick(delay);
		await service.getAvailableModels();
	}
	assert.equal(selectChatModelsCalls, 3);
	t.mock.timers.tick(60_000);
	assert.equal(selectChatModelsCalls, 3);
	service.clearCopilotModelCaches();
	await service.getAvailableModels();
	service.dispose();
	t.mock.timers.tick(60_000);
	assert.equal(selectChatModelsCalls, 4);
});

/** NotFound удаляет устаревший API из общего кеша, но не повторяет уже неуспешный пользовательский запрос. */
test('AiService refreshes a removed model without retrying the failed request', async t => {
	const service = new AiService();
	t.after(() => service.dispose());
	stubFreeModelCatalog(service, [mockModel.id]);
	const removed = { ...mockModel, sendRequest: async () => {
		throw Object.assign(new Error('removed model'), { code: 'NotFound' });
	} };
	selectChatModelsImpl = async () => selectChatModelsCalls === 1 ? [removed] : [mockModel];
	service.initializeModelCatalog(() => undefined);
	await service.getAvailableModels();
	assert.equal(await service.generateCommitMessage({ stagedChangesSummary: '+code' }), '');
	assert.equal(sendRequestCalls, 0);
	await service.getAvailableModels();
	assert.equal(await service.generateCommitMessage({ stagedChangesSummary: '+code' }), 'ok');
	assert.equal(sendRequestCalls, 1);
	assert.equal(selectChatModelsCalls, 2);
});

/** Совпадение по похожему имени или другому провайдеру не разрешает отправку запроса в адресном free-only пути. */
for (const mismatch of ['id', 'vendor', 'paid-only'] as const) {
	test(`AiService free fallback rejects ${mismatch} model`, async () => {
		const service = new AiService();
		stubFreeModelCatalog(service, mismatch === 'paid-only' ? [] : ['gpt-free']);
		const wrongModel = { ...mockModel, vendor: mismatch === 'vendor' ? 'other' : 'copilot',
			id: mismatch === 'vendor' ? 'gpt-free' : 'gpt-free-premium', family: 'gpt-free' };
		selectChatModelsImpl = async selector => selector?.id || (mismatch === 'paid-only' && !selector?.family)
			? [wrongModel] : [];
		assert.equal(await service.generateCommitMessage({ stagedChangesSummary: '+code' }), '');
		assert.equal(sendRequestCalls, 0);
	});
}

/** Запрошенная бесплатная модель имеет приоритет даже при другом порядке локального списка. */
test('AiService prefers the requested free candidate before other cached models', async () => {
	const service = new AiService();
	stubFreeModelCatalog(service, ['gpt-other', 'gpt-5-mini']);
	selectChatModelsImpl = async selector => selector?.id === mockModel.id ? [mockModel] : [];
	assert.equal(await service.generateCommitMessage({ stagedChangesSummary: '+code' }), 'ok');
	assert.deepEqual(modelSelections, [
		{ vendor: 'copilot', family: 'gpt-5-mini' }, { vendor: 'copilot', id: 'gpt-5-mini' },
	]);
});

/** Отсутствие модели, пустой ответ и отказы LM дают сигнал резервному генератору, а не фиктивный текст коммита. */
for (const failure of ['no-model', 'empty', 'request', 'stream'] as const) {
	test(`AiService commit generation returns no message after ${failure} failure`, async t => {
		if (failure === 'no-model') {
			selectChatModelsImpl = async () => [];
		} else {
			t.mock.method(mockModel, 'sendRequest', async () => {
				if (failure === 'request') { throw new Error('request failed'); }
				return { text: (async function* () {
					yield failure === 'stream' ? 'incomplete result' : '   ';
					if (failure === 'stream') { throw new Error('stream failed'); }
				})() };
			});
		}
		const service = new AiService();
		(service as unknown as { resolveStateDbPath: () => Promise<null> }).resolveStateDbPath = async () => null;
		assert.equal(await service.generateCommitMessage({ stagedChangesSummary: '+code' }), '');
		assert.equal(disposedTokenSources, failure === 'no-model' ? 0 : 1);
	});
}
