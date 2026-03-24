import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import initSqlJs from 'sql.js';

import { readSqliteItemTable } from '../src/utils/sqliteItemTable.js';

test('readSqliteItemTable reads ItemTable values without external sqlite binary', async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-manager-sqlite-item-table-'));
	const dbPath = path.join(tempDir, 'state.vscdb');
	const wasmPath = path.resolve(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
	const SQL = await initSqlJs({
		locateFile: () => wasmPath,
	});
	const db = new SQL.Database();

	try {
		db.run('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB);');
		db.run('INSERT INTO ItemTable (key, value) VALUES (?, ?);', [
			'chat.cachedLanguageModels.v2',
			'[{"identifier":"copilot/gpt-5-mini","metadata":{"id":"gpt-5-mini","name":"GPT-5 mini"}}]',
		]);
		db.run('INSERT INTO ItemTable (key, value) VALUES (?, ?);', [
			'chat.modelsControl',
			'{"free":{"gpt-5-mini":{"id":"copilot/gpt-5-mini","label":"GPT-5 mini","featured":true}}}',
		]);

		fs.writeFileSync(dbPath, Buffer.from(db.export()));
	} finally {
		db.close();
	}

	try {
		const items = await readSqliteItemTable(dbPath, wasmPath);
		assert.equal(
			items.get('chat.cachedLanguageModels.v2'),
			'[{"identifier":"copilot/gpt-5-mini","metadata":{"id":"gpt-5-mini","name":"GPT-5 mini"}}]',
		);
		assert.equal(
			items.get('chat.modelsControl'),
			'{"free":{"gpt-5-mini":{"id":"copilot/gpt-5-mini","label":"GPT-5 mini","featured":true}}}',
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
