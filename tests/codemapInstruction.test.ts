import test from 'node:test';
import assert from 'node:assert/strict';

import { CodeMapInstructionService, buildCodeMapProjectInstruction, buildFileSummary } from '../src/codemap/codeMapInstructionService.js';

class FakeCodeMapSummaryCache {
	private readonly fileSummaries = new Map<string, unknown>();
	private readonly areaSummaries = new Map<string, unknown>();
	private readonly branchArtifacts = new Map<string, unknown>();

	getCachedFileSummary<T>(repository: string, filePath: string, blobSha: string, locale: string, generationFingerprint: string): T | null {
		return (this.fileSummaries.get(this.buildKey(repository, filePath, blobSha, locale, generationFingerprint)) as T | undefined) || null;
	}

	upsertCachedFileSummary(repository: string, filePath: string, blobSha: string, locale: string, generationFingerprint: string, summary: unknown): void {
		this.fileSummaries.set(this.buildKey(repository, filePath, blobSha, locale, generationFingerprint), this.clone(summary));
	}

	getCachedAreaSummary<T>(repository: string, areaKey: string, snapshotToken: string, locale: string, generationFingerprint: string): T | null {
		return (this.areaSummaries.get(this.buildKey(repository, areaKey, snapshotToken, locale, generationFingerprint)) as T | undefined) || null;
	}

	upsertCachedAreaSummary(repository: string, areaKey: string, snapshotToken: string, locale: string, generationFingerprint: string, summary: unknown): void {
		this.areaSummaries.set(this.buildKey(repository, areaKey, snapshotToken, locale, generationFingerprint), this.clone(summary));
	}

	getBranchArtifact<T>(repository: string, branchName: string, artifactKind: string, locale: string, generationFingerprint: string): T | null {
		return (this.branchArtifacts.get(this.buildKey(repository, branchName, artifactKind, locale, generationFingerprint)) as T | undefined) || null;
	}

	upsertBranchArtifact(
		repository: string,
		branchName: string,
		artifactKind: string,
		locale: string,
		generationFingerprint: string,
		payload: unknown,
		options: {
			sourceSnapshotToken: string;
			treeSha: string;
			headSha: string;
			basedOnBranchName?: string;
			basedOnSnapshotToken?: string;
			generatedAt: string;
		},
	): void {
		this.branchArtifacts.set(this.buildKey(repository, branchName, artifactKind, locale, generationFingerprint), this.clone({
			repository,
			branchName,
			artifactKind,
			locale,
			generationFingerprint,
			sourceSnapshotToken: options.sourceSnapshotToken,
			treeSha: options.treeSha,
			headSha: options.headSha,
			basedOnBranchName: options.basedOnBranchName,
			basedOnSnapshotToken: options.basedOnSnapshotToken,
			payload,
			payloadHash: '',
			uncompressedSize: 0,
			compressedSize: 0,
			generatedAt: options.generatedAt,
			updatedAt: options.generatedAt,
		}));
	}

	private buildKey(...parts: string[]): string {
		return parts.join('::');
	}

	private clone<T>(value: T): T {
		return JSON.parse(JSON.stringify(value)) as T;
	}
}

test('buildCodeMapProjectInstruction renders repository summary and file tree', () => {
	const output = buildCodeMapProjectInstruction({
		repository: 'prompt-manager',
		branchName: 'main',
		resolvedBranchName: 'main',
		baseBranchName: 'main',
		instructionKind: 'base',
		branchRole: 'tracked',
		generatedAt: '2026-03-14T00:00:00.000Z',
		headSha: 'abc123',
		locale: 'ru',
		files: ['src/extension.ts', 'src/services/gitService.ts', 'package.json'],
		manifest: {
			name: 'copilot-prompt-manager',
			description: 'Prompt manager extension',
			scripts: { build: 'npm run build', test: 'npm test' },
			dependencies: { react: '^18.2.0', vscode: '^1.95.0' },
			devDependencies: { typescript: '^5.3.3' },
		},
	});

	assert.match(output, /Code Map проекта prompt-manager/);
	assert.match(output, /- Ветка: main/);
	assert.match(output, /VS Code extension/);
	assert.match(output, /## Описание кода/);
	assert.match(output, /src\/services/);
	assert.match(output, /extension\.ts/);
	assert.match(output, /Codemap теперь старается показывать только сигнальные для ИИ файлы/);
});

test('buildFileSummary produces contextual PHP symbols without false method detections', () => {
	const summary = buildFileSummary('app/Http/Controllers/LaravelHelper/ModelLogTestController.php', `<?php

class ModelLogTestController extends DefaultController
{
	public function __construct()
	{
	}

	protected function response(bool $status)
	{
		return $status;
	}

	public function testModelLogEloquentCreate()
	{
		if (true) {
			app(TestService::class);
		}
	}
}
`, true);

	assert.equal(summary.role, 'HTTP-контроллеры и обработчики маршрутов');
	assert.deepEqual(summary.symbols.map(symbol => symbol.name), ['ModelLogTestController', '__construct', 'response', 'testModelLogEloquentCreate']);
	assert.ok(summary.symbols.every(symbol => !/самостоятельный блок логики|инкапсулирует связанную логику файла/.test(symbol.description)));
	assert.match(summary.symbols.find(symbol => symbol.name === 'response')?.description || '', /унифицированный ответ/);
	assert.match(summary.symbols.find(symbol => symbol.name === 'response')?.description || '', /напрямую возвращает параметр status/);
	assert.match(summary.symbols.find(symbol => symbol.name === 'testModelLogEloquentCreate')?.description || '', /проверяет сценарий «model log eloquent create»/);
	assert.match(summary.symbols.find(symbol => symbol.name === 'testModelLogEloquentCreate')?.description || '', /разрешает через контейнер TestService/);
});

test('buildCodeMapProjectInstruction filters noise and detects Laravel signals', () => {
	const output = buildCodeMapProjectInstruction({
		repository: 'laravel-test',
		branchName: 'master',
		resolvedBranchName: 'master',
		baseBranchName: 'master',
		instructionKind: 'base',
		branchRole: 'current',
		generatedAt: '2026-03-14T00:00:00.000Z',
		headSha: 'abc123',
		locale: 'ru',
		files: [
			'..env.swp',
			'.editorconfig',
			'app/Http/Controllers/LaravelHelper/ModelLogTestController.php',
			'app/Models/Test.php',
			'artisan',
			'bootstrap/app.php',
			'composer.json',
			'database/migrations/0001_01_01_000003_create_tests_table.php',
			'package.json',
			'routes/api-testing.php',
			'storage/framework/.gitignore',
			'tests/Feature/LaravelHelper/ModelLogTest.php',
		],
		manifest: {
			name: 'laravel-test-frontend',
			scripts: { build: 'vite build', dev: 'vite' },
			dependencies: { vite: '^6.0.0', tailwindcss: '^4.0.0' },
		},
		composerManifest: {
			name: 'atlcom/laravel-test',
			description: 'Laravel helper test application',
			require: { 'laravel/framework': '^12.0' },
			requireDev: { 'phpunit/phpunit': '^11.0' },
		},
	});

	assert.match(output, /Laravel/);
	assert.match(output, /PHPUnit/);
	assert.doesNotMatch(output, /swp/);
	assert.doesNotMatch(output, /storage\/framework\/\.gitignore/);
	assert.doesNotMatch(output, /editorconfig/);
});

test('buildCodeMapProjectInstruction uses localized labels and clearer file elements section', () => {
	const output = buildCodeMapProjectInstruction({
		repository: 'laravel-test',
		branchName: 'master',
		resolvedBranchName: 'master',
		baseBranchName: 'master',
		instructionKind: 'base',
		branchRole: 'current',
		generatedAt: '2026-03-14T00:00:00.000Z',
		headSha: 'abc123',
		locale: 'ru',
		files: ['app/Http/Controllers/TestController.php'],
		manifest: null,
		codeDescription: {
			projectEssence: ['Тестовая суть проекта.'],
			architectureSummary: ['Тестовое описание архитектуры.'],
			patterns: [],
			entryPoints: [],
			areas: [{
				area: 'app/Http',
				fileCount: 1,
				description: 'Описание области.',
				representativeFiles: ['app/Http/Controllers/TestController.php'],
				symbols: ['TestController'],
			}],
			fileSummaries: [{
				path: 'app/Http/Controllers/TestController.php',
				lineCount: 12,
				role: 'HTTP-контроллеры и обработчики маршрутов',
				imports: [],
				symbols: [{
					kind: 'method',
					name: 'testAction',
					signature: 'testAction(): Response',
					line: 5,
					column: 1,
					description: 'Метод testAction обслуживает HTTP-сценарий этой области.',
				}],
			}],
			relations: [],
			recentChanges: [],
		},
	});

	assert.match(output, /- Репозиторий: laravel-test/);
	assert.match(output, /- Ключевые элементы: TestController/);
	assert.match(output, /- Элементы файла:/);
	assert.match(output, /Описание: Метод testAction обслуживает HTTP-сценарий этой области\./);
	assert.doesNotMatch(output, /Назначение:/);
	assert.doesNotMatch(output, /- Символы:/);
	assert.match(output, /- Элементы файла:\n\n  - Метод testAction/);
});

test('buildFileSummary does not expose anonymous php classes as extends symbol names', () => {
	const summary = buildFileSummary('database/migrations/0001_create_tests_table.php', `<?php

return new class extends Migration
{
	public function up(): void
	{
	}
};
`, true);

	assert.ok(summary.symbols.some(symbol => symbol.kind === 'class'));
	assert.ok(summary.symbols.every(symbol => symbol.name !== 'extends'));
});

test('buildFileSummary extracts linked frontend blocks from vue files', () => {
	const summary = buildFileSummary('src/pages/OrdersPage.vue', `<template>
		<main class="orders-page">
			<form class="orders-filters" @submit.prevent="submitFilters">
				<input v-model="filters.query" name="query" />
				<StatusSelect v-model="filters.status" />
			</form>
			<section class="orders-table">
				<OrdersTable :items="orders" @open="openOrder" />
			</section>
			<div class="empty-state" v-if="!orders.length && !isLoading">No orders</div>
		</main>
	</template>
	<script setup lang="ts">
	const filters = reactive({ query: '', status: 'all' });
	const orders = ref([]);
	const isLoading = ref(false);
	const route = useRoute();
	const router = useRouter();
	const ordersStore = useOrdersStore();
	const submitFilters = async () => {
		await ordersStore.fetch(filters);
		router.push({ query: filters });
	};
	const openOrder = (id: number) => {
		router.push(\`/orders/\${id}\`);
	};
	</script>
	`, true);

	assert.equal(summary.role, 'frontend-компоненты и страницы интерфейса');
	assert.ok((summary.frontendContract || []).some(item => /Фреймворк\/UI-слой: vue/i.test(item)));
	assert.ok((summary.frontendContract || []).some(item => /ordersStore|router|route/.test(item)));
	const filtersBlock = (summary.frontendBlocks || []).find(block => block.name === 'OrdersFilters');
	assert.ok(filtersBlock);
	assert.equal(filtersBlock?.kind, 'filters');
	assert.match(filtersBlock?.description || '', /submitFilters/);
	assert.match(filtersBlock?.description || '', /filters|query/);
	assert.ok((summary.frontendBlocks || []).some(block => block.name === 'OrdersTable'));
});

test('buildCodeMapProjectInstruction renders frontend contract and ui blocks for frontend files', () => {
	const output = buildCodeMapProjectInstruction({
		repository: 'frontend-app',
		branchName: 'main',
		resolvedBranchName: 'main',
		baseBranchName: 'main',
		instructionKind: 'base',
		branchRole: 'current',
		generatedAt: '2026-03-14T00:00:00.000Z',
		headSha: 'abc123',
		locale: 'ru',
		files: ['src/pages/OrdersPage.vue'],
		manifest: null,
		codeDescription: {
			projectEssence: ['Тестовая суть проекта.'],
			architectureSummary: ['Тестовое описание архитектуры.'],
			patterns: [],
			entryPoints: [],
			areas: [],
			fileSummaries: [{
				path: 'src/pages/OrdersPage.vue',
				lineCount: 48,
				role: 'frontend-компоненты и страницы интерфейса',
				imports: ['@/stores/orders'],
				frontendContract: ['Фреймворк/UI-слой: vue. Значимые блоки: OrdersFilters, OrdersTable.'],
				frontendBlocks: [{
					kind: 'filters',
					name: 'OrdersFilters',
					line: 4,
					column: 3,
					description: 'UI-блок OrdersFilters управляет фильтрами, зависит от состояния filters и инициирует submitFilters.',
					purpose: 'OrdersFilters управляет полями query, status.',
					stateDeps: ['filters'],
					eventHandlers: ['submitFilters'],
					dataSources: ['ordersStore (useOrdersStore)'],
					childComponents: ['StatusSelect'],
					conditions: [],
					routes: [],
					forms: ['query', 'status'],
				}],
				symbols: [],
			}],
			relations: [],
			recentChanges: [],
		},
	});

	assert.match(output, /- Frontend-контракт:/);
	assert.match(output, /- UI-блоки:/);
	assert.match(output, /Фильтры OrdersFilters/);
	assert.match(output, /События: submitFilters/);
	assert.match(output, /Источники данных: ordersStore/);
});

test('generateInstruction emits detailed progress messages for area batching and file summaries', async () => {
	const service = new CodeMapInstructionService({
		generateCodeMapAreaDescriptionsBatch: async () => JSON.stringify({
			areas: [
				{ id: 'area-1', description: 'Описание HTTP-слоя.' },
				{ id: 'area-2', description: 'Описание моделей.' },
			],
		}),
	} as never) as any;

	service.getFilesAtRef = async () => [
		'app/Http/Controllers/TestController.php',
		'app/Models/Test.php',
		'routes/api.php',
	];
	service.readJsonAtRef = async (_projectPath: string, _ref: string, filePath: string) => {
		if (filePath === 'composer.json') {
			return {
				name: 'atlcom/laravel-test',
				require: { 'laravel/framework': '^12.0' },
			};
		}
		return null;
	};
	service.readFileTexts = async () => new Map([
		['app/Http/Controllers/TestController.php', '<?php class TestController { public function testAction(): Response {} }'],
		['app/Models/Test.php', '<?php class Test {}'],
		['routes/api.php', '<?php'],
	]);
	service.readRecentChanges = async () => [];

	const progress: Array<{ stage: string; detail?: string; completed?: number; total?: number }> = [];
	await service.generateInstruction({
		repository: 'laravel-test',
		projectPath: '/tmp/laravel-test',
		currentBranch: 'master',
		resolvedBranchName: 'master',
		baseBranchName: 'master',
		branchRole: 'current',
		isTrackedBranch: true,
		hasUncommittedChanges: false,
		resolvedHeadSha: 'abc123',
		currentHeadSha: 'abc123',
	}, 'base', 'ru', 'gpt-5-mini', (item: { stage: string; detail?: string; completed?: number; total?: number }) => progress.push(item));

	assert.ok(progress.some(item => item.stage === 'describing-areas' && /AI-батч/.test(item.detail || '')));
	assert.ok(progress.some(item => item.stage === 'describing-areas' && /Готово \d+\/\d+/.test(item.detail || '')));
	assert.ok(progress.some(item => item.stage === 'describing-files' && /Файл 1\//.test(item.detail || '')));
});

test('generateInstruction normalizes codemap aiModel through free-model resolver', async () => {
	const requestedModels: string[] = [];
	const generationModels: string[] = [];
	const service = new CodeMapInstructionService({
		resolveFreeCopilotModel: async (model: string) => {
			requestedModels.push(model);
			return 'gpt-5-mini';
		},
		generateCodeMapAreaDescriptionsBatch: async (_input: unknown, model?: string) => {
			generationModels.push(model || '');
			return JSON.stringify({
				areas: [
					{ id: 'area-1', description: 'Описание HTTP-слоя.' },
				],
			});
		},
	} as never) as any;

	service.getFilesAtRef = async () => [
		'app/Http/Controllers/TestController.php',
		'routes/api.php',
	];
	service.readJsonAtRef = async () => null;
	service.readFileTexts = async () => new Map([
		['app/Http/Controllers/TestController.php', '<?php class TestController { public function testAction(): Response {} }'],
		['routes/api.php', '<?php'],
	]);
	service.readRecentChanges = async () => [];

	const record = await service.generateInstruction({
		repository: 'laravel-test',
		projectPath: '/tmp/laravel-test',
		currentBranch: 'master',
		resolvedBranchName: 'master',
		baseBranchName: 'master',
		branchRole: 'current',
		isTrackedBranch: true,
		hasUncommittedChanges: false,
		resolvedHeadSha: 'abc123',
		currentHeadSha: 'abc123',
	}, 'base', 'ru', 'gpt-4o');

	assert.deepEqual(requestedModels, ['gpt-4o']);
	assert.deepEqual(generationModels, ['gpt-5-mini']);
	assert.equal(record.aiModel, 'gpt-5-mini');
});

test('generateInstruction batches symbol descriptions across multiple files', async () => {
	const symbolBatchSizes: number[] = [];
	const service = new CodeMapInstructionService({
		resolveFreeCopilotModel: async () => 'gpt-5-mini',
		generateCodeMapAreaDescriptionsBatch: async () => JSON.stringify({
			areas: [
				{ id: 'area-1', description: 'Описание HTTP-слоя.' },
				{ id: 'area-2', description: 'Описание сервисов.' },
			],
		}),
		generateCodeMapSymbolDescriptionsBatch: async (input: { symbols: Array<{ id: string; name: string }> }) => {
			symbolBatchSizes.push(input.symbols.length);
			return JSON.stringify({
				symbols: input.symbols.map(symbol => ({
					id: symbol.id,
					description: `AI-описание для ${symbol.name}`,
				})),
			});
		},
	} as never) as any;

	service.getFilesAtRef = async () => [
		'app/Http/Controllers/TestController.php',
		'app/Services/TestService.php',
		'routes/api.php',
	];
	service.readJsonAtRef = async () => null;
	service.readFileTexts = async () => new Map([
		['app/Http/Controllers/TestController.php', `<?php
class TestController {
	public function index(): Response {
		return response()->json([]);
	}
}`],
		['app/Services/TestService.php', `<?php
class TestService {
	public function buildReport(array $items): array {
		return $items;
	}
}`],
		['routes/api.php', '<?php'],
	]);
	service.readRecentChanges = async () => [];

	const record = await service.generateInstruction({
		repository: 'laravel-test',
		projectPath: '/tmp/laravel-test',
		currentBranch: 'master',
		resolvedBranchName: 'master',
		baseBranchName: 'master',
		branchRole: 'current',
		isTrackedBranch: true,
		hasUncommittedChanges: false,
		resolvedHeadSha: 'abc123',
		currentHeadSha: 'abc123',
	}, 'base', 'ru', 'gpt-5-mini');

	assert.ok(symbolBatchSizes.length >= 1);
	assert.ok(symbolBatchSizes.some(size => size >= 2));
	assert.match(record.content, /AI-описание для index/);
	assert.match(record.content, /AI-описание для buildReport/);
});

test('generateInstruction batches frontend block descriptions for vue files', async () => {
	const frontendBatchSizes: number[] = [];
	const service = new CodeMapInstructionService({
		resolveFreeCopilotModel: async () => 'gpt-5-mini',
		generateCodeMapAreaDescriptionsBatch: async () => JSON.stringify({
			areas: [
				{ id: 'area-1', description: 'Описание фронтенд-слоя.' },
			],
		}),
		generateCodeMapFrontendBlockDescriptionsBatch: async (input: { blocks: Array<{ id: string; blockName: string }> }) => {
			frontendBatchSizes.push(input.blocks.length);
			return JSON.stringify({
				blocks: input.blocks.map(block => ({
					id: block.id,
					description: `AI-описание UI-блока ${block.blockName}`,
				})),
			});
		},
	} as never) as any;

	service.getFilesAtRef = async () => [
		'src/pages/OrdersPage.vue',
	];
	service.readJsonAtRef = async () => ({
		name: 'frontend-app',
		dependencies: { vue: '^3.4.0' },
	});
	service.readFileTexts = async () => new Map([
		['src/pages/OrdersPage.vue', `<template>
			<main class="orders-page">
				<form class="orders-filters" @submit.prevent="submitFilters">
					<input v-model="filters.query" name="query" />
				</form>
				<section class="orders-table">
					<OrdersTable :items="orders" @open="openOrder" />
				</section>
			</main>
		</template>
		<script setup lang="ts">
		const filters = reactive({ query: '' });
		const orders = ref([]);
		const ordersStore = useOrdersStore();
		const submitFilters = async () => {
			await ordersStore.fetch(filters);
		};
		const openOrder = (id: number) => {
			return id;
		};
		</script>`],
	]);
	service.readRecentChanges = async () => [];

	const record = await service.generateInstruction({
		repository: 'frontend-app',
		projectPath: '/tmp/frontend-app',
		currentBranch: 'main',
		resolvedBranchName: 'main',
		baseBranchName: 'main',
		branchRole: 'current',
		isTrackedBranch: true,
		hasUncommittedChanges: false,
		resolvedHeadSha: 'abc123',
		currentHeadSha: 'abc123',
	}, 'base', 'ru', 'gpt-5-mini');

	assert.ok(frontendBatchSizes.length >= 1);
	assert.ok(frontendBatchSizes.some(size => size >= 2));
	assert.match(record.content, /AI-описание UI-блока OrdersFilters/);
	assert.match(record.content, /AI-описание UI-блока OrdersTable/);
});

test('generateInstruction reuses cached area and file summaries when blobs are unchanged', async () => {
	const cache = new FakeCodeMapSummaryCache();
	const areaCalls: string[][] = [];
	const symbolCalls: string[][] = [];
	const frontendCalls: string[][] = [];
	const readRequests: string[][] = [];
	const fileSources = new Map([
		['app/Http/Controllers/TestController.php', `<?php
class TestController {
	public function index(): Response {
		return response()->json([]);
	}
}`],
		['src/pages/OrdersPage.vue', `<template>
			<main class="orders-page">
				<form class="orders-filters" @submit.prevent="submitFilters">
					<input v-model="filters.query" name="query" />
				</form>
				<section class="orders-table">
					<OrdersTable :items="orders" @open="openOrder" />
				</section>
			</main>
		</template>
		<script setup lang="ts">
		const filters = reactive({ query: '' });
		const orders = ref([]);
		const ordersStore = useOrdersStore();
		const submitFilters = async () => {
			await ordersStore.fetch(filters);
		};
		const openOrder = (id: number) => {
			return id;
		};
		</script>`],
		['routes/api.php', '<?php Route::get("/orders", TestController::class);'],
	]);
	const blobMap = new Map([
		['app/Http/Controllers/TestController.php', '1111111111111111111111111111111111111111'],
		['src/pages/OrdersPage.vue', '2222222222222222222222222222222222222222'],
		['routes/api.php', '3333333333333333333333333333333333333333'],
	]);
	const service = new CodeMapInstructionService({
		resolveFreeCopilotModel: async () => 'gpt-5-mini',
		generateCodeMapAreaDescriptionsBatch: async (input: { areas: Array<{ id: string; area: string }> }) => {
			areaCalls.push(input.areas.map(area => area.area));
			return JSON.stringify({
				areas: input.areas.map(area => ({
					id: area.id,
					description: `Описание области ${area.area}`,
				})),
			});
		},
		generateCodeMapSymbolDescriptionsBatch: async (input: { symbols: Array<{ id: string; name: string; filePath: string }> }) => {
			symbolCalls.push(input.symbols.map(symbol => `${symbol.filePath}:${symbol.name}`));
			return JSON.stringify({
				symbols: input.symbols.map(symbol => ({
					id: symbol.id,
					description: `AI-описание для ${symbol.name}`,
				})),
			});
		},
		generateCodeMapFrontendBlockDescriptionsBatch: async (input: { blocks: Array<{ id: string; blockName: string }> }) => {
			frontendCalls.push(input.blocks.map(block => block.blockName));
			return JSON.stringify({
				blocks: input.blocks.map(block => ({
					id: block.id,
					description: `AI-описание UI-блока ${block.blockName}`,
				})),
			});
		},
	} as never, cache as never) as any;

	service.getFilesAtRef = async () => Array.from(fileSources.keys());
	service.getFileBlobShasAtRef = async () => new Map(blobMap);
	service.readJsonAtRef = async (_projectPath: string, _ref: string, filePath: string) => {
		if (filePath === 'package.json') {
			return {
				name: 'frontend-app',
				dependencies: { vue: '^3.4.0' },
			};
		}
		return null;
	};
	service.readFileTexts = async (_projectPath: string, _ref: string, files: string[]) => {
		readRequests.push([...files].sort());
		return new Map(files.map(filePath => [filePath, fileSources.get(filePath) || '']));
	};
	service.readRecentChanges = async () => [];

	const firstRecord = await service.generateInstruction({
		repository: 'frontend-app',
		projectPath: '/tmp/frontend-app',
		currentBranch: 'main',
		resolvedBranchName: 'main',
		baseBranchName: 'main',
		branchRole: 'current',
		isTrackedBranch: true,
		hasUncommittedChanges: false,
		resolvedHeadSha: 'abc123',
		currentHeadSha: 'abc123',
	}, 'base', 'ru', 'gpt-5-mini');
	const secondRecord = await service.generateInstruction({
		repository: 'frontend-app',
		projectPath: '/tmp/frontend-app',
		currentBranch: 'main',
		resolvedBranchName: 'main',
		baseBranchName: 'main',
		branchRole: 'current',
		isTrackedBranch: true,
		hasUncommittedChanges: false,
		resolvedHeadSha: 'abc123',
		currentHeadSha: 'abc123',
	}, 'base', 'ru', 'gpt-5-mini');

	assert.equal(areaCalls.length, 1);
	assert.equal(symbolCalls.length, 1);
	assert.equal(frontendCalls.length, 1);
	assert.equal(readRequests.length, 1);
	assert.match(firstRecord.content, /AI-описание для index/);
	assert.match(secondRecord.content, /AI-описание для index/);
	assert.match(secondRecord.content, /AI-описание UI-блока OrdersFilters/);
});

test('generateInstruction regenerates only changed file summaries and affected area', async () => {
	const cache = new FakeCodeMapSummaryCache();
	const areaCalls: string[][] = [];
	const symbolCalls: string[][] = [];
	const frontendCalls: Array<Array<{ blockName: string; eventHandlers: string[] }>> = [];
	const readRequests: string[][] = [];
	const fileSources = new Map([
		['app/Http/Controllers/TestController.php', `<?php
class TestController {
	public function index(): Response {
		return response()->json([]);
	}
}`],
		['src/pages/OrdersPage.vue', `<template>
			<main class="orders-page">
				<form class="orders-filters" @submit.prevent="submitFilters">
					<input v-model="filters.query" name="query" />
				</form>
				<section class="orders-table">
					<OrdersTable :items="orders" @open="openOrder" />
				</section>
			</main>
		</template>
		<script setup lang="ts">
		const filters = reactive({ query: '' });
		const orders = ref([]);
		const ordersStore = useOrdersStore();
		const submitFilters = async () => {
			await ordersStore.fetch(filters);
		};
		const openOrder = (id: number) => {
			return id;
		};
		</script>`],
		['routes/api.php', '<?php Route::get("/orders", TestController::class);'],
	]);
	const blobMap = new Map([
		['app/Http/Controllers/TestController.php', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
		['src/pages/OrdersPage.vue', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
		['routes/api.php', 'cccccccccccccccccccccccccccccccccccccccc'],
	]);
	const service = new CodeMapInstructionService({
		resolveFreeCopilotModel: async () => 'gpt-5-mini',
		generateCodeMapAreaDescriptionsBatch: async (input: { areas: Array<{ id: string; area: string }> }) => {
			areaCalls.push(input.areas.map(area => area.area));
			return JSON.stringify({
				areas: input.areas.map(area => ({
					id: area.id,
					description: `Описание области ${area.area}`,
				})),
			});
		},
		generateCodeMapSymbolDescriptionsBatch: async (input: { symbols: Array<{ id: string; name: string; filePath: string }> }) => {
			symbolCalls.push(input.symbols.map(symbol => `${symbol.filePath}:${symbol.name}`));
			return JSON.stringify({
				symbols: input.symbols.map(symbol => ({
					id: symbol.id,
					description: `AI-описание для ${symbol.name}`,
				})),
			});
		},
		generateCodeMapFrontendBlockDescriptionsBatch: async (input: { blocks: Array<{ id: string; blockName: string; eventHandlers: string[] }> }) => {
			frontendCalls.push(input.blocks.map(block => ({ blockName: block.blockName, eventHandlers: [...block.eventHandlers] })));
			return JSON.stringify({
				blocks: input.blocks.map(block => ({
					id: block.id,
					description: `AI-описание UI-блока ${block.blockName}: ${block.eventHandlers.join(', ') || 'no-events'}`,
				})),
			});
		},
	} as never, cache as never) as any;

	service.getFilesAtRef = async () => Array.from(fileSources.keys());
	service.getFileBlobShasAtRef = async () => new Map(blobMap);
	service.readJsonAtRef = async (_projectPath: string, _ref: string, filePath: string) => {
		if (filePath === 'package.json') {
			return {
				name: 'frontend-app',
				dependencies: { vue: '^3.4.0' },
			};
		}
		return null;
	};
	service.readFileTexts = async (_projectPath: string, _ref: string, files: string[]) => {
		readRequests.push([...files].sort());
		return new Map(files.map(filePath => [filePath, fileSources.get(filePath) || '']));
	};
	service.readRecentChanges = async () => [];

	await service.generateInstruction({
		repository: 'frontend-app',
		projectPath: '/tmp/frontend-app',
		currentBranch: 'main',
		resolvedBranchName: 'main',
		baseBranchName: 'main',
		branchRole: 'current',
		isTrackedBranch: true,
		hasUncommittedChanges: false,
		resolvedHeadSha: 'abc123',
		currentHeadSha: 'abc123',
	}, 'base', 'ru', 'gpt-5-mini');

	fileSources.set('src/pages/OrdersPage.vue', `<template>
		<main class="orders-page">
			<form class="orders-filters" @submit.prevent="submitFiltersFast">
				<input v-model="filters.query" name="query" />
			</form>
			<section class="orders-table">
				<OrdersTable :items="orders" @open="openOrder" />
			</section>
		</main>
	</template>
	<script setup lang="ts">
	const filters = reactive({ query: '' });
	const orders = ref([]);
	const ordersStore = useOrdersStore();
	const submitFiltersFast = async () => {
		await ordersStore.fetch(filters);
	};
	const openOrder = (id: number) => {
		return id;
	};
	</script>`);
	blobMap.set('src/pages/OrdersPage.vue', 'dddddddddddddddddddddddddddddddddddddddd');

	const secondRecord = await service.generateInstruction({
		repository: 'frontend-app',
		projectPath: '/tmp/frontend-app',
		currentBranch: 'main',
		resolvedBranchName: 'main',
		baseBranchName: 'main',
		branchRole: 'current',
		isTrackedBranch: true,
		hasUncommittedChanges: false,
		resolvedHeadSha: 'abc123',
		currentHeadSha: 'abc123',
	}, 'base', 'ru', 'gpt-5-mini');

	assert.deepEqual(areaCalls, [
		['app/Http', 'routes/api.php', 'src/pages'],
		['src/pages'],
	]);
	assert.ok(symbolCalls[1]?.every(item => item.startsWith('src/pages/OrdersPage.vue:')));
	assert.ok((frontendCalls[1] || []).every(item => ['OrdersPageTable', 'OrdersFilters', 'OrdersTable'].includes(item.blockName)));
	assert.ok((frontendCalls[1] || []).some(item => item.blockName === 'OrdersFilters' && item.eventHandlers.includes('submitFiltersFast')));
	assert.ok((frontendCalls[1] || []).some(item => item.blockName === 'OrdersTable' && item.eventHandlers.includes('openOrder')));
	assert.deepEqual(readRequests, [
		['app/Http/Controllers/TestController.php', 'routes/api.php', 'src/pages/OrdersPage.vue'],
		['src/pages/OrdersPage.vue'],
	]);
	assert.match(secondRecord.content, /AI-описание для submitFiltersFast/);
	assert.match(secondRecord.content, /AI-описание UI-блока OrdersFilters: submitFiltersFast/);
	assert.match(secondRecord.content, /AI-описание для index/);
});

test('generateInstruction builds delta for a non-tracked branch from the parent tracked artifact', async () => {
	const cache = new FakeCodeMapSummaryCache();
	const symbolCalls: string[][] = [];
	const readRequests: Array<{ ref: string; files: string[] }> = [];
	const fileSourcesByRef = new Map<string, Map<string, string>>([
		['main', new Map([
			['src/services/orderService.ts', `export async function listOrders() {
	return [];
}`],
			['src/pages/OrdersPage.vue', `<template>
	<section class="orders-page">
		<button @click="openOrder">Open</button>
	</section>
</template>
<script setup lang="ts">
const openOrder = () => true;
</script>`],
		])],
		['feature/orders-filters', new Map([
			['src/services/orderService.ts', `export async function listOrders() {
	return [];
}`],
			['src/pages/OrdersPage.vue', `<template>
	<section class="orders-page">
		<form class="orders-filters" @submit.prevent="applyFilters">
			<input v-model="query" />
		</form>
	</section>
</template>
<script setup lang="ts">
const query = ref('');
const applyFilters = () => query.value;
</script>`],
		])],
	]);
	const blobMapByRef = new Map<string, Map<string, string>>([
		['main', new Map([
			['src/services/orderService.ts', '1111111111111111111111111111111111111111'],
			['src/pages/OrdersPage.vue', '2222222222222222222222222222222222222222'],
		])],
		['feature/orders-filters', new Map([
			['src/services/orderService.ts', '1111111111111111111111111111111111111111'],
			['src/pages/OrdersPage.vue', '3333333333333333333333333333333333333333'],
		])],
	]);
	const service = new CodeMapInstructionService({
		resolveFreeCopilotModel: async () => 'gpt-5-mini',
		generateCodeMapAreaDescriptionsBatch: async (input: { areas: Array<{ id: string; area: string }> }) => JSON.stringify({
			areas: input.areas.map(area => ({
				id: area.id,
				description: `Описание области ${area.area}`,
			})),
		}),
		generateCodeMapSymbolDescriptionsBatch: async (input: { symbols: Array<{ id: string; name: string; filePath: string }> }) => {
			symbolCalls.push(input.symbols.map(symbol => `${symbol.filePath}:${symbol.name}`));
			return JSON.stringify({
				symbols: input.symbols.map(symbol => ({
					id: symbol.id,
					description: `AI-описание для ${symbol.name}`,
				})),
			});
		},
		generateCodeMapFrontendBlockDescriptionsBatch: async (input: { blocks: Array<{ id: string; blockName: string }> }) => JSON.stringify({
			blocks: input.blocks.map(block => ({
				id: block.id,
				description: `AI-описание UI-блока ${block.blockName}`,
			})),
		}),
	} as never, cache as never) as any;

	service.getFilesAtRef = async (_projectPath: string, ref: string) => Array.from(fileSourcesByRef.get(ref)?.keys() || []);
	service.getFileBlobShasAtRef = async (_projectPath: string, ref: string, files: string[]) => {
		const blobMap = blobMapByRef.get(ref) || new Map();
		return new Map(files.map(filePath => [filePath, blobMap.get(filePath) || '']));
	};
	service.readJsonAtRef = async (_projectPath: string, _ref: string, filePath: string) => {
		if (filePath === 'package.json') {
			return {
				name: 'orders-app',
				dependencies: { vue: '^3.4.0' },
			};
		}
		return null;
	};
	service.readFileTexts = async (_projectPath: string, ref: string, files: string[]) => {
		readRequests.push({ ref, files: [...files].sort() });
		const sources = fileSourcesByRef.get(ref) || new Map();
		return new Map(files.map(filePath => [filePath, sources.get(filePath) || '']));
	};
	service.readRecentChanges = async () => [];

	const baseRecord = await service.generateInstruction({
		repository: 'orders-app',
		projectPath: '/tmp/orders-app',
		currentBranch: 'main',
		resolvedBranchName: 'main',
		baseBranchName: 'main',
		branchRole: 'tracked',
		isTrackedBranch: true,
		hasUncommittedChanges: false,
		resolvedHeadSha: 'base-head',
		currentHeadSha: 'base-head',
	}, 'base', 'ru', 'gpt-5-mini');
	const baseArtifact = cache.getBranchArtifact<any>(
		'orders-app',
		'main',
		'full',
		'ru',
		String(baseRecord.metadata?.generationFingerprint || ''),
	);
	assert.ok(baseArtifact);
	service.selectReuseContext = async () => ({
		sourceArtifact: baseArtifact,
		diffEntries: [{ status: 'M', path: 'src/pages/OrdersPage.vue' }],
		changedFiles: new Set(['src/pages/OrdersPage.vue']),
		deletedFiles: [],
		renamedFiles: [],
	});

	const deltaRecord = await service.generateInstruction({
		repository: 'orders-app',
		projectPath: '/tmp/orders-app',
		currentBranch: 'feature/orders-filters',
		resolvedBranchName: 'main',
		baseBranchName: 'main',
		branchRole: 'resolved-base',
		isTrackedBranch: false,
		hasUncommittedChanges: false,
		resolvedHeadSha: 'base-head',
		currentHeadSha: 'feature-head',
	}, 'delta', 'ru', 'gpt-5-mini');

	assert.match(deltaRecord.content, /Delta Code Map проекта orders-app/);
	assert.match(deltaRecord.content, /Базовая tracked-ветка: main/);
	assert.match(deltaRecord.content, /src\/pages\/OrdersPage\.vue/);
	assert.doesNotMatch(deltaRecord.content, /src\/services\/orderService\.ts/);
	assert.ok(symbolCalls[symbolCalls.length - 1]?.every(item => item.startsWith('src/pages/OrdersPage.vue:')));
	assert.deepEqual(readRequests.map(item => item.files), [
		['src/pages/OrdersPage.vue', 'src/services/orderService.ts'],
		['src/pages/OrdersPage.vue'],
	]);
	assert.equal(deltaRecord.metadata?.basedOnBranchName, 'main');
	assert.equal(deltaRecord.metadata?.artifactKind, 'delta');
});

test('codemap source filtering respects excluded paths and tracked .gitignore rules', async () => {
	const service = new CodeMapInstructionService() as any;
	const rawFiles = [
		'.gitignore',
		'.vscode/settings.json',
		'dist/app.js',
		'ignored.log',
		'nested/.gitignore',
		'nested/tmp/cache.json',
		'nested/keep.ts',
		'src/visible.ts',
	];
	const blobMap = new Map([
		['.gitignore', '1111111111111111111111111111111111111111'],
		['nested/.gitignore', '2222222222222222222222222222222222222222'],
		['.vscode/settings.json', '3333333333333333333333333333333333333333'],
		['dist/app.js', '4444444444444444444444444444444444444444'],
		['ignored.log', '5555555555555555555555555555555555555555'],
		['nested/tmp/cache.json', '6666666666666666666666666666666666666666'],
		['nested/keep.ts', '7777777777777777777777777777777777777777'],
		['src/visible.ts', '8888888888888888888888888888888888888888'],
	]);
	const gitIgnoreContents = new Map([
		['.gitignore', 'dist/\nignored.log\n'],
		['nested/.gitignore', 'tmp/\n'],
	]);

	service.readTextAtRef = async (_projectPath: string, _ref: string, filePath: string) => gitIgnoreContents.get(filePath) || '';
	service.getFileBlobShasAtRef = async (_projectPath: string, _ref: string, files: string[]) => new Map(files.map(filePath => [filePath, blobMap.get(filePath) || '']));

	const filteredFiles = await service.filterFilesForCodeMap('/tmp/repo', 'main', rawFiles, ['.vscode']);
	const tokenBefore = await service.buildSourceSnapshotTokenForFiles('/tmp/repo', 'main', rawFiles, filteredFiles, ['.vscode']);

	blobMap.set('dist/app.js', '9999999999999999999999999999999999999999');
	const tokenAfterIgnoredChange = await service.buildSourceSnapshotTokenForFiles('/tmp/repo', 'main', rawFiles, filteredFiles, ['.vscode']);

	blobMap.set('src/visible.ts', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
	const tokenAfterVisibleChange = await service.buildSourceSnapshotTokenForFiles('/tmp/repo', 'main', rawFiles, filteredFiles, ['.vscode']);

	blobMap.set('src/visible.ts', '8888888888888888888888888888888888888888');
	blobMap.set('.gitignore', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
	const tokenAfterGitIgnoreChange = await service.buildSourceSnapshotTokenForFiles('/tmp/repo', 'main', rawFiles, filteredFiles, ['.vscode']);

	assert.deepEqual(filteredFiles.sort(), ['nested/keep.ts', 'src/visible.ts']);
	assert.equal(tokenAfterIgnoredChange, tokenBefore);
	assert.notEqual(tokenAfterVisibleChange, tokenBefore);
	assert.notEqual(tokenAfterGitIgnoreChange, tokenBefore);
});
