import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PromptHoverTarget } from '../src/types/promptHoverPreview.js';

/** Подмена только событий VS Code: чтение preview проверяется на настоящих изолированных файлах без БД. */
const moduleLoader = Module as unknown as { _load: (name: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleLoader._load;
const disposable = () => ({ dispose() { /* Подписка не создаёт ресурсов в тесте. */ } });
moduleLoader._load = function (name, parent, isMain) {
  if (name === 'vscode') {
    return {
      EventEmitter: class {
        event = disposable;
        dispose() { /* Нет активных подписок. */ }
      },
      RelativePattern: class { },
      workspace: { createFileSystemWatcher: () => ({
        onDidCreate: disposable, onDidChange: disposable, onDidDelete: disposable, dispose() { },
      }) },
    };
  }
  return originalLoad.call(this, name, parent, isMain);
};
// require выполняется внутри области подмены; production-модуль не получает тестовые пути по умолчанию.
const { StorageService } = require('../src/services/storageService.js') as typeof import('../src/services/storageService.js');
moduleLoader._load = originalLoad;

/** Каждая проверка создаёт собственную папку и удаляет её даже при ошибке утверждения. */
async function withStorage(run: (storage: InstanceType<typeof StorageService>, root: string) => Promise<void>) {
  const parent = path.join(os.tmpdir(), 'codex');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'prompt-hover-169-'));
  const storage = new StorageService(root);
  try { await run(storage, root); } finally { storage.dispose(); await fs.rm(root, { recursive: true, force: true }); }
}

/** Минимальная legacy-конфигурация выявляет любые непредусмотренные backfill-записи. */
async function seed(root: string, target: PromptHoverTarget, content: string): Promise<string> {
  const directory = path.join(root, '.vscode/prompt-manager', ...(target.archived ? ['archive'] : []), target.id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({ promptUuid: target.promptUuid }));
  await fs.writeFile(path.join(directory, 'prompt.md'), content);
  return directory;
}

/** Полное чтение не вызывает getPrompt/readConfig, создание отчёта, нормализацию или кеш списка. */
test('hover preview preserves full text and leaves legacy files unchanged', async () => withStorage(async (storage, root) => {
  const target = { id: '169-example', promptUuid: 'uuid-a', archived: false };
  const content = '# Заголовок\n\n' + 'Полный текст.\n'.repeat(4000);
  const directory = await seed(root, target, content);
  const before = await fs.readFile(path.join(directory, 'config.json'), 'utf8');
  assert.deepEqual(await storage.getPromptHoverPreview(target), { state: 'ready', content });
  assert.equal(await fs.readFile(path.join(directory, 'config.json'), 'utf8'), before);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['config.json', 'prompt.md']);
  assert.deepEqual(await fs.readdir(path.dirname(directory)), ['169-example']);
}));

/** Одинаковое имя активной и архивной папки не смешивает тексты; неправильный UUID ничего не возвращает. */
test('hover preview separates archived identities and rejects replaced prompts', async () => withStorage(async (storage, root) => {
  const active = { id: 'same', promptUuid: 'active-uuid', archived: false };
  const archived = { ...active, promptUuid: 'archive-uuid', archived: true };
  await seed(root, active, 'Active');
  await seed(root, archived, 'Archived');
  assert.deepEqual(await storage.getPromptHoverPreview(active), { state: 'ready', content: 'Active' });
  assert.deepEqual(await storage.getPromptHoverPreview(archived), { state: 'ready', content: 'Archived' });
  assert.deepEqual(await storage.getPromptHoverPreview({ ...active, promptUuid: 'previous' }), { state: 'missing' });
}));

/** Пустой файл, отсутствие файла и повреждение конфигурации имеют разные результаты. */
test('hover preview distinguishes empty missing and unreadable content', async () => withStorage(async (storage, root) => {
  const target = { id: 'empty', promptUuid: 'uuid', archived: false };
  const directory = await seed(root, target, '');
  assert.deepEqual(await storage.getPromptHoverPreview(target), { state: 'ready', content: '' });
  await fs.writeFile(path.join(directory, 'config.json'), '{invalid');
  assert.deepEqual(await storage.getPromptHoverPreview(target), { state: 'error' });
  await fs.unlink(path.join(directory, 'prompt.md'));
  assert.deepEqual(await storage.getPromptHoverPreview(target), { state: 'missing' });
  assert.equal(await fs.readFile(path.join(directory, 'config.json'), 'utf8'), '{invalid');
}));

/** Webview не может использовать traversal или символические ссылки для чтения посторонних файлов. */
test('hover preview rejects unsafe paths and symlinks outside its prompt directory', async () => withStorage(async (storage, root) => {
  const target = { id: 'safe', promptUuid: 'uuid', archived: false };
  const directory = await seed(root, target, 'Safe');
  for (const id of ['..', '.', '../safe', '/tmp/elsewhere', 'a\\b', 'archive', '__new__', '', 'a\0b']) {
    assert.deepEqual(await storage.getPromptHoverPreview({ ...target, id }), { state: 'missing' }, id);
  }
  const outside = path.join(root, 'outside.md');
  await fs.writeFile(outside, 'Private outside text');
  await fs.unlink(path.join(directory, 'prompt.md'));
  await fs.symlink(outside, path.join(directory, 'prompt.md'));
  assert.deepEqual(await storage.getPromptHoverPreview(target), { state: 'missing' });
  await fs.symlink(root, path.join(path.dirname(directory), 'outside-folder'));
  assert.deepEqual(await storage.getPromptHoverPreview({ ...target, id: 'outside-folder' }), { state: 'missing' });
}));
