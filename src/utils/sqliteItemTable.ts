import * as fs from 'fs';
import initSqlJs, { type SqlJsStatic } from 'sql.js';

const sqlJsModuleCache = new Map<string, Promise<SqlJsStatic>>();

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
