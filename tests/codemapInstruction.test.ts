import test from 'node:test';
import assert from 'node:assert/strict';

import { CodeMapInstructionService, buildCodeMapProjectInstruction, buildFileSummary } from '../src/codemap/codeMapInstructionService.js';

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