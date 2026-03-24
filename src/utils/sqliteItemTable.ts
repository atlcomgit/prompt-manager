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
	const buffer = fs.readFileSync(dbPath);
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
