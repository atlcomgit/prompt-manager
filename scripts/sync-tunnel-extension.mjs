import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Читает локальную настройку и манифесты без обращения к Marketplace. */
async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

/** Проверяет границы путей, чтобы сборка не заменяла проект или его родительские каталоги. */
function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Копирует сборку в обычную установленную папку; проверки: tests/syncTunnelExtension.test.ts. */
export async function syncTunnelExtension(projectRoot) {
  projectRoot = await fs.realpath(projectRoot);
  const configFile = path.join(projectRoot, '.vscode', 'tunnel-dev.json');
  let config;
  try { config = await readJson(configFile); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (config.enabled !== true) return false;
  for (const key of ['extensionDirectory', 'backupDirectory']) {
    if (typeof config[key] !== 'string' || !path.isAbsolute(config[key])) {
      throw new Error(`tunnel-dev.json: ${key} должен быть абсолютным путём.`);
    }
  }
  const destination = path.resolve(config.extensionDirectory);
  const backup = path.resolve(config.backupDirectory);
  if (await fs.realpath(destination) !== destination
    || contains(projectRoot, destination) || contains(destination, projectRoot)
    || contains(destination, backup) || contains(backup, destination)
    || contains(projectRoot, backup) || contains(backup, projectRoot)) {
    throw new Error('Синхронизация требует отдельную обычную папку расширения и отдельную резервную копию.');
  }
  const manifest = await readJson(path.join(projectRoot, 'package.json'));
  const installed = await readJson(path.join(destination, 'package.json'));
  const identifier = `${manifest.publisher}.${manifest.name}`;
  if (identifier !== 'alek-fiend.copilot-prompt-manager'
    || `${installed.publisher}.${installed.name}` !== identifier) {
    throw new Error('Целевая папка не является установкой Prompt Manager.');
  }
  const registryFile = path.join(path.dirname(destination), 'extensions.json');
  const registryBefore = await fs.readFile(registryFile, 'utf8');
  const registry = JSON.parse(registryBefore);
  const matches = registry.filter(entry => entry.identifier?.id === identifier);
  if (matches.length !== 1 || matches[0].location?.path !== destination) {
    throw new Error('Не удалось однозначно определить серверную установку в extensions.json.');
  }
  await fs.access(path.join(projectRoot, 'dist', 'extension.js'));
  await fs.mkdir(path.dirname(backup), { recursive: true });
  const lockFile = path.join(path.dirname(backup), '.prompt-manager-sync.lock');
  const lock = await fs.open(lockFile, 'wx');
  let stage;
  let keepStage = false;
  const applied = [];
  try {
    stage = await fs.mkdtemp(path.join(path.dirname(backup), '.prompt-manager-sync-'));
    // Подготавливаем все файлы до изменения работающей установки.
    for (const name of ['dist', 'media']) {
      await fs.cp(path.join(projectRoot, name), path.join(stage, name), { recursive: true });
    }
    const nextManifest = { ...manifest, ...(installed.__metadata ? { __metadata: installed.__metadata } : {}) };
    await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify(nextManifest, null, 2) + '\n');
    // Сохраняем исходную установку один раз; последующие compile не накапливают резервные копии.
    try {
      const ready = await readJson(path.join(backup, 'ready.json'));
      if (ready.destination !== destination || ready.identifier !== identifier) {
        throw new Error('Резервная копия принадлежит другой установке.');
      }
    }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.mkdir(backup, { recursive: true });
      for (const name of ['dist', 'media', 'package.json']) {
        await fs.cp(path.join(destination, name), path.join(backup, name), { recursive: true });
      }
      await fs.writeFile(path.join(backup, 'entry.before.json'), JSON.stringify(matches[0], null, 2) + '\n');
      await fs.writeFile(path.join(backup, 'ready.json'), JSON.stringify({ destination, identifier }) + '\n');
    }
    matches[0].version = manifest.version;
    matches[0].metadata = { ...matches[0].metadata, pinned: true };
    await fs.writeFile(path.join(stage, 'extensions.json'), JSON.stringify(registry));
    if (await fs.readFile(registryFile, 'utf8') !== registryBefore) {
      throw new Error('Реестр расширений изменился параллельно; синхронизация отменена.');
    }
    // Корень расширения сохраняется физической папкой: require("vscode") остаётся в зарегистрированном пути.
    for (const name of ['dist', 'media', 'package.json', 'extensions.json']) {
      const target = name === 'extensions.json' ? registryFile : path.join(destination, name);
      if (name === 'extensions.json' && await fs.readFile(registryFile, 'utf8') !== registryBefore) {
        throw new Error('Реестр расширений изменился параллельно; синхронизация отменена.');
      }
      const previous = path.join(stage, `previous-${name}`);
      if (name.endsWith('.json')) {
        await fs.copyFile(target, previous);
        await fs.chmod(path.join(stage, name), (await fs.stat(target)).mode & 0o777);
      } else {
        await fs.rename(target, previous);
      }
      applied.push({ target, previous });
      await fs.rename(path.join(stage, name), target);
    }
    return true;
  } catch (error) {
    // При отказе заменяем только файлы, затронутые этой попыткой.
    try {
      for (const { target, previous } of applied.reverse()) {
        if (!(await fs.stat(previous)).isFile()) await fs.rm(target, { recursive: true, force: true });
        await fs.rename(previous, target);
      }
    } catch (rollbackError) {
      keepStage = true;
      throw new AggregateError([error, rollbackError], `Не удалось завершить откат; сохранены файлы в ${stage}`);
    }
    throw error;
  } finally {
    try { if (stage && !keepStage) await fs.rm(stage, { recursive: true, force: true }); }
    finally { await lock.close(); await fs.unlink(lockFile); }
  }
}

/** npm run compile синхронизирует только явно включённую локальную установку. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL('..', import.meta.url));
    if (await syncTunnelExtension(root)) {
      console.log('[tunnel] Prompt Manager обновлён. Перезагрузите страницу туннеля.');
    }
  } catch (error) {
    console.error(`[tunnel] ${error.message}`);
    process.exitCode = 1;
  }
}
