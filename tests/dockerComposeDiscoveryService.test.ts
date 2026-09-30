import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Проверяет glob, ссылки и обновление кэша в изолированной папке без внешних сервисов. */
test('compose discovery finds root glob matches and file symlinks after forced refresh', async () => {
	// Реальные файлы создаются только во временном каталоге; API редактора полностью подменён.
	const temporaryRoot = mkdtempSync(join(tmpdir(), 'compose-discovery-testing-'));
	const projectRoot = join(temporaryRoot, 'project');
	const moduleLoader = require('node:module') as typeof import('node:module') & { _load: (...args: any[]) => any };
	const originalLoad = moduleLoader._load;
	const dispose = () => undefined;
	const watchedPatterns: string[] = [];
	const vscodeStub = {
		/** Минимальный канал событий не запускает таймеры или наблюдение за диском. */
		EventEmitter: class {
			event = () => ({ dispose });
			fire = () => undefined;
			dispose = dispose;
		},
		/** Сохраняет корневые шаблоны наблюдения для проверки отсутствия рекурсивного поиска. */
		RelativePattern: class {
			constructor(_folder: unknown, public pattern: string) { watchedPatterns.push(pattern); }
		},
		workspace: {
			workspaceFolders: [{ name: 'project', uri: { fsPath: projectRoot } }],
			getConfiguration: () => ({ get: (key: string, fallback: unknown) =>
				key === 'docker.composeFilePatterns' ? ['*.{yml,yaml}'] : fallback }),
			onDidChangeConfiguration: () => ({ dispose }),
			createFileSystemWatcher: () => ({ dispose, onDidCreate: dispose, onDidChange: dispose, onDidDelete: dispose }),
		},
	};
	let service: import('../src/services/dockerComposeDiscoveryService.js').DockerComposeDiscoveryService | undefined;
	try {
		mkdirSync(projectRoot);
		mkdirSync(join(projectRoot, 'nested'));
		writeFileSync(join(projectRoot, 'compose.yml'), 'services: {}');
		writeFileSync(join(projectRoot, 'nested', 'compose.yml'), 'services: {}');
		writeFileSync(join(temporaryRoot, 'shared.yml'), 'services: {}');
		symlinkSync(join(temporaryRoot, 'shared.yml'), join(projectRoot, 'shared.compose.yaml'), 'file');
		symlinkSync(join(temporaryRoot, 'missing.yml'), join(projectRoot, 'broken.yml'), 'file');
		symlinkSync(join(projectRoot, 'nested'), join(projectRoot, 'directory.yml'), 'dir');
		// Подмена действует при загрузке сервиса; вложенные зависимости конфигурации изолированы.
		moduleLoader._load = (request: string, ...args: any[]) => request === 'vscode'
			? vscodeStub : request.endsWith('/codemap/codeMapConfig.js')
				? { getCodeMapSettings: () => ({ excludedPaths: [] }) } : originalLoad(request, ...args);
		const { DockerComposeDiscoveryService } = require('../src/services/dockerComposeDiscoveryService.js') as typeof import('../src/services/dockerComposeDiscoveryService.js');
		service = new DockerComposeDiscoveryService();
		moduleLoader._load = originalLoad;
		assert.deepEqual(service.getComposeFilesSync().map(file => file.relativePath), ['compose.yml', 'shared.compose.yaml']);
		assert.deepEqual(watchedPatterns, ['*.{yml,yaml}']);
		writeFileSync(join(projectRoot, 'new.yaml'), 'services: {}');
		assert.equal((await service.getComposeFiles()).length, 2);
		assert.deepEqual((await service.getComposeFiles(true)).map(file => file.relativePath), ['compose.yml', 'new.yaml', 'shared.compose.yaml']);
	} finally {
		moduleLoader._load = originalLoad;
		service?.dispose();
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
});
