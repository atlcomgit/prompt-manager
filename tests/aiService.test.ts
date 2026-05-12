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