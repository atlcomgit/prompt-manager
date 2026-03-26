import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import initSqlJs from 'sql.js';

import { readSqliteItemTable } from '../src/utils/sqliteItemTable.js';

async function createStateDbWithItems(items: Array<[string, string]>): Promise<{ tempDir: string; dbPath: string; wasmPath: string }> {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-manager-sqlite-item-table-'));
	const dbPath = path.join(tempDir, 'state.vscdb');
	const wasmPath = path.resolve(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
	const SQL = await initSqlJs({
		locateFile: () => wasmPath,
	});
	const db = new SQL.Database();

	try {
		db.run('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB);');
		for (const [key, value] of items) {
			db.run('INSERT INTO ItemTable (key, value) VALUES (?, ?);', [key, value]);
		}

		fs.writeFileSync(dbPath, Buffer.from(db.export()));
	} finally {
		db.close();
	}

	return { tempDir, dbPath, wasmPath };
}

test('readSqliteItemTable reads ItemTable values without external sqlite binary', async () => {
	const { tempDir, dbPath, wasmPath } = await createStateDbWithItems([
		[
			'chat.cachedLanguageModels.v2',
			'[{"identifier":"copilot/gpt-5-mini","metadata":{"id":"gpt-5-mini","name":"GPT-5 mini"}}]',
		],
		[
			'chat.modelsControl',
			'{"free":{"gpt-5-mini":{"id":"copilot/gpt-5-mini","label":"GPT-5 mini","featured":true}}}',
		],
	]);

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

test('readSqliteItemTable exposes Copilot preference and usage keys for state DB fallback logic', async () => {
	const usagePayload = JSON.stringify([
		{ extensionId: 'github.copilot-chat', lastUsed: 101 },
		{ extensionId: 'github.copilot', lastUsed: 202 },
	]);
	const { tempDir, dbPath, wasmPath } = await createStateDbWithItems([
		['github.copilot-chat-github', 'alekfiend'],
		['alek-fiend.copilot-prompt-manager-github', 'alekfiend'],
		['github-alekfiend-usages', usagePayload],
	]);

	try {
		const items = await readSqliteItemTable(dbPath, wasmPath);
		assert.equal(items.get('github.copilot-chat-github'), 'alekfiend');
		assert.equal(items.get('alek-fiend.copilot-prompt-manager-github'), 'alekfiend');
		assert.equal(items.get('github-alekfiend-usages'), usagePayload);
		assert.equal(items.get('missing-key'), undefined);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
