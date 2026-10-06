/**
 * Read-only доступ к `ItemTable` внутренних SQLite-хранилищ VS Code (`state.vscdb`).
 *
 * Файл БД целиком читается в память и открывается через sql.js (WASM), поэтому на рабочем
 * файле VS Code не устанавливаются SQLite-блокировки и не создаются журналы. Запись в эти БД
 * запрещена: собственные настройки расширения хранятся только в `ExtensionContext.globalState`.
 */
import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { type SqlJsStatic } from 'sql.js';

/** Кэш инициализированных модулей sql.js по пути к WASM-файлу. */
const sqlJsModuleCache = new Map<string, Promise<SqlJsStatic>>();

/** Значения ключей, прочитанные из одной версии файла БД (версия определяется отпечатком файла). */
interface SqliteItemValueSnapshot {
	/** Отпечаток файла БД (размер и время изменения), для которого валидны значения */
	fingerprint: string;
	/** Прочитанные значения по ключу; `null` — ключ отсутствует в БД */
	values: Map<string, string | null>;
}

/** Кэш значений по пути к БД: повторное чтение файла выполняется только после его изменения. */
const sqliteItemValueSnapshotCache = new Map<string, SqliteItemValueSnapshot>();

/** Максимум БД в кэше значений, чтобы не держать в памяти данные давно неиспользуемых workspace. */
const SQLITE_ITEM_VALUE_SNAPSHOT_CACHE_LIMIT = 32;

/** Возвращает (и кэширует) модуль sql.js, загруженный из указанного WASM-файла. */

function getSqlJsModule(wasmPath: string): Promise<SqlJsStatic> {
	const normalizedPath = wasmPath.trim();
	const cached = sqlJsModuleCache.get(normalizedPath);
	if (cached) {
		return cached;
	}

	const created = initSqlJs({
		locateFile: () => normalizedPath,
	});
	sqlJsModuleCache.set(normalizedPath, created);
	return created;
}

/**
 * Возвращает путь к `sql-wasm.wasm`, который копируется в `dist/` при сборке расширения.
 * Возвращает `null`, если путь к расширению неизвестен или файл отсутствует.
 */
export function resolveBundledSqlJsWasmPath(extensionPath: string | undefined | null): string | null {
	const normalizedExtensionPath = String(extensionPath || '').trim();
	if (!normalizedExtensionPath) {
		return null;
	}

	const wasmPath = path.join(normalizedExtensionPath, 'dist', 'sql-wasm.wasm');
	return fs.existsSync(wasmPath) ? wasmPath : null;
}

/** Читает все строки `ItemTable` из снимка файла БД (read-only, без блокировок исходного файла). */
export async function readSqliteItemTable(dbPath: string, wasmPath: string): Promise<Map<string, string>> {
	const SQL = await getSqlJsModule(wasmPath);
	const buffer = await fs.promises.readFile(dbPath);
	const db = new SQL.Database(buffer);

	try {
		const items = new Map<string, string>();
		const result = db.exec('SELECT key, value FROM ItemTable;');
		for (const row of result[0]?.values || []) {
			const key = String(row[0] ?? '').trim();
			if (!key) {
				continue;
			}

			items.set(key, String(row[1] ?? ''));
		}

		return items;
	} finally {
		db.close();
	}
}

/** Читает одно значение `ItemTable` по ключу из снимка файла БД; `null` — ключ отсутствует. */
export async function readSqliteItemValue(dbPath: string, wasmPath: string, key: string): Promise<string | null> {
	const normalizedKey = key.trim();
	if (!normalizedKey) {
		return null;
	}

	const SQL = await getSqlJsModule(wasmPath);
	const buffer = await fs.promises.readFile(dbPath);
	const db = new SQL.Database(buffer);

	try {
		const statement = db.prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1;');
		try {
			statement.bind([normalizedKey]);
			if (!statement.step()) {
				return null;
			}

			const row = statement.getAsObject();
			return row.value === undefined || row.value === null ? '' : String(row.value);
		} finally {
			statement.free();
		}
	} finally {
		db.close();
	}
}

/** Строит отпечаток файла БД по размеру и времени изменения; `null` — файл недоступен. */
async function getSqliteFileFingerprint(dbPath: string): Promise<string | null> {
	try {
		const stat = await fs.promises.stat(dbPath);
		return `${stat.size}:${stat.mtimeMs}`;
	} catch {
		return null;
	}
}

/**
 * Читает значение `ItemTable` из снимка файла БД с кэшированием по отпечатку файла.
 * Подходит для частого опроса больших workspace-БД: файл повторно читается только после того,
 * как VS Code его изменил. Возвращает `null`, если файл или ключ отсутствует.
 */
export async function readSqliteItemValueCached(dbPath: string, wasmPath: string, key: string): Promise<string | null> {
	const normalizedKey = key.trim();
	const fingerprint = normalizedKey ? await getSqliteFileFingerprint(dbPath) : null;
	if (!fingerprint) {
		return null;
	}

	// Сбрасываем значения устаревшей версии файла и ограничиваем размер кэша.
	let snapshot = sqliteItemValueSnapshotCache.get(dbPath);
	if (!snapshot || snapshot.fingerprint !== fingerprint) {
		snapshot = { fingerprint, values: new Map() };
		sqliteItemValueSnapshotCache.delete(dbPath);
		if (sqliteItemValueSnapshotCache.size >= SQLITE_ITEM_VALUE_SNAPSHOT_CACHE_LIMIT) {
			const oldestDbPath = sqliteItemValueSnapshotCache.keys().next().value;
			if (oldestDbPath !== undefined) {
				sqliteItemValueSnapshotCache.delete(oldestDbPath);
			}
		}
		sqliteItemValueSnapshotCache.set(dbPath, snapshot);
	}

	if (snapshot.values.has(normalizedKey)) {
		return snapshot.values.get(normalizedKey) ?? null;
	}

	const value = await readSqliteItemValue(dbPath, wasmPath, normalizedKey);
	snapshot.values.set(normalizedKey, value);
	return value;
}
