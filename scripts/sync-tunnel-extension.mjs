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

/** Разрешает родительские ссылки, даже если папку резервной копии ещё предстоит создать. */
async function physicalPath(file) {
  try {
    return await fs.realpath(file);
  } catch (error) {
    const parent = path.dirname(file);
    if (error.code !== 'ENOENT' || parent === file) throw error;
    return path.join(await physicalPath(parent), path.basename(file));
  }
}

/** Проверяет принадлежность сохранённой копии по её контрольному файлу. */
async function hasOriginalBackup(backup, destination, identifier) {
  try {
    const ready = await readJson(path.join(backup, 'ready.json'));
    if (ready.destination !== destination || ready.identifier !== identifier) {
      throw new Error('Резервная копия принадлежит другой установке.');
    }
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Проверяет физическую установку и её запись в реестре до любых изменений. */
async function readTarget(projectRoot, manifest, config) {
  for (const key of ['extensionDirectory', 'backupDirectory']) {
    if (typeof config?.[key] !== 'string' || !path.isAbsolute(config[key])) {
      throw new Error(`tunnel-dev.json: ${key} должен быть абсолютным путём.`);
    }
  }
  const destination = path.resolve(config.extensionDirectory);
  const backup = path.resolve(config.backupDirectory);
  if (await fs.realpath(destination) !== destination || await physicalPath(backup) !== backup
    || contains(projectRoot, destination) || contains(destination, projectRoot)
    || contains(destination, backup) || contains(backup, destination)
    || contains(projectRoot, backup) || contains(backup, projectRoot)) {
    throw new Error('Синхронизация требует отдельную обычную папку расширения и отдельную резервную копию.');
  }
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
    throw new Error(`Не удалось однозначно определить серверную установку в ${registryFile}.`);
  }
  await hasOriginalBackup(backup, destination, identifier);
  return { destination, backup, installed, identifier, registryFile, registryBefore, registry, entry: matches[0] };
}

/** Заменяет сборку одной установки под блокировкой её реестра. */
async function syncTarget(projectRoot, manifest, target) {
  const { destination, backup, installed, identifier, registryFile, registryBefore, registry, entry } = target;
  await fs.mkdir(path.dirname(backup), { recursive: true });
  const extensionsDirectory = path.dirname(registryFile);
  const lockFile = path.join(extensionsDirectory, '.prompt-manager-sync.lock');
  const lock = await fs.open(lockFile, 'wx');
  let stage;
  let keepStage = false;
  const applied = [];
  try {
    if (await fs.readFile(registryFile, 'utf8') !== registryBefore) {
      throw new Error('Реестр расширений изменился параллельно; синхронизация отменена.');
    }
    // Переименование файлов реестра и установки остаётся на их файловой системе.
    stage = await fs.mkdtemp(path.join(extensionsDirectory, '.prompt-manager-sync-'));
    // Подготавливаем все файлы до изменения работающей установки.
    for (const name of ['dist', 'media']) {
      await fs.cp(path.join(projectRoot, name), path.join(stage, name), { recursive: true });
    }
    const nextManifest = { ...manifest, ...(installed.__metadata ? { __metadata: installed.__metadata } : {}) };
    await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify(nextManifest, null, 2) + '\n');
    // Сохраняем исходную установку один раз; последующие compile не накапливают резервные копии.
    if (!await hasOriginalBackup(backup, destination, identifier)) {
      await fs.mkdir(backup, { recursive: true });
      for (const name of ['dist', 'media', 'package.json']) {
        await fs.cp(path.join(destination, name), path.join(backup, name), { recursive: true });
      }
      await fs.writeFile(path.join(backup, 'entry.before.json'), JSON.stringify(entry, null, 2) + '\n');
      await fs.writeFile(path.join(backup, 'ready.json'), JSON.stringify({ destination, identifier }) + '\n');
    }
    entry.version = manifest.version;
    entry.metadata = { ...entry.metadata, pinned: true };
    await fs.writeFile(path.join(stage, 'extensions.json'), JSON.stringify(registry));
    if (await fs.readFile(registryFile, 'utf8') !== registryBefore) {
      throw new Error('Реестр расширений изменился параллельно; синхронизация отменена.');
    }
    // Корень расширения сохраняется физической папкой: require("vscode") остаётся в зарегистрированном пути.
    for (const name of ['dist', 'media', 'package.json', 'extensions.json']) {
      const target = name === 'extensions.json' ? registryFile : path.join(destination, name);
      const previous = path.join(stage, `previous-${name}`);
      if (name.endsWith('.json')) {
        await fs.copyFile(target, previous);
        await fs.chmod(path.join(stage, name), (await fs.stat(target)).mode & 0o777);
        if (name === 'extensions.json' && await fs.readFile(registryFile, 'utf8') !== registryBefore) {
          throw new Error('Реестр расширений изменился параллельно; синхронизация отменена.');
        }
        await fs.rename(path.join(stage, name), target);
        applied.push({ target, previous });
      } else {
        await fs.rename(target, previous);
        applied.push({ target, previous });
        await fs.rename(path.join(stage, name), target);
      }
    }
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

/** Сверяет все установки до записи и обновляет каждый реестр один раз. Тесты: syncTunnelExtension.test.ts. */
export async function syncTunnelExtension(projectRoot, { check = false, report = () => {} } = {}) {
  projectRoot = await fs.realpath(projectRoot);
  const configFile = path.join(projectRoot, '.vscode', 'tunnel-dev.json');
  let config;
  try { config = await readJson(configFile); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (config.enabled !== true) return false;
  const configured = config.installations === undefined ? [config] : config.installations;
  if (!Array.isArray(configured) || configured.length === 0) {
    throw new Error('tunnel-dev.json: installations должен быть непустым массивом установок.');
  }
  const manifest = await readJson(path.join(projectRoot, 'package.json'));
  const targets = [];
  for (const definition of configured) {
    const target = await readTarget(projectRoot, manifest, definition);
    // Туннели с одинаковой физической установкой могут указать её дважды в списке.
    if (targets.some(other => other.destination === target.destination && other.backup === target.backup)) continue;
    if (targets.some(other => other.registryFile === target.registryFile
      || contains(other.destination, target.destination) || contains(target.destination, other.destination)
      || contains(other.backup, target.backup) || contains(target.backup, other.backup)
      || contains(other.destination, target.backup) || contains(target.backup, other.destination)
      || contains(target.destination, other.backup) || contains(other.backup, target.destination))) {
      throw new Error(`tunnel-dev.json: пересекаются реестры или резервные копии установок (${target.destination}).`);
    }
    targets.push(target);
  }
  if (!check) await fs.access(path.join(projectRoot, 'dist', 'extension.js'));

  const errors = [];
  for (const target of targets) {
    try {
      if (!check) await syncTarget(projectRoot, manifest, target);
      report(target.destination);
    } catch (error) {
      errors.push(new Error(`${target.destination}: ${error.message}`, { cause: error }));
    }
  }
  if (errors.length > 0) {
    if (targets.length === 1) throw errors[0].cause;
    throw new AggregateError(errors, errors.map(error => error.message).join('\n'));
  }
  return true;
}

/** Сборка синхронизирует настроенные цели, а --check проверяет реестры и манифесты без записи. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const check = process.argv.includes('--check');
    const updated = await syncTunnelExtension(root, {
      check,
      report: destination => console.log(`[tunnel] ${check ? 'Проверено' : 'Обновлено'}: ${destination}`),
    });
    if (!check && updated) {
      console.log('[tunnel] Перезагрузите страницы туннелей, чтобы загрузить новую сборку.');
    } else if (check && !updated) {
      console.log('[tunnel] Синхронизация отключена.');
    }
  } catch (error) {
    console.error(`[tunnel] ${error.message}`);
    process.exitCode = 1;
  }
}
