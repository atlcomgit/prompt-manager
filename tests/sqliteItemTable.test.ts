import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import initSqlJs from 'sql.js';

import {
	readSqliteItemTable,
	readSqliteItemValue,
	readSqliteItemValueCached,
	resolveBundledSqlJsWasmPath,
} from '../src/utils/sqliteItemTable.js';

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

test('readSqliteItemValue reads one ItemTable value without scanning all rows', async () => {
	const { tempDir, dbPath, wasmPath } = await createStateDbWithItems([
		['github.copilot-chat-github', 'atlcomgit'],
		['chat.cachedLanguageModels.v2', '[{"identifier":"copilot/gpt-5-mini"}]'],
	]);

	try {
		const value = await readSqliteItemValue(dbPath, wasmPath, 'github.copilot-chat-github');
		const missing = await readSqliteItemValue(dbPath, wasmPath, 'missing-key');

		assert.equal(value, 'atlcomgit');
		assert.equal(missing, null);
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

/** Проверяет, что чтение снимка не меняет файл БД и перечитывает его только после изменения. */
test('readSqliteItemValueCached reads a snapshot without modifying the database file', async () => {
	const { tempDir, dbPath, wasmPath } = await createStateDbWithItems([
		['chat.ChatSessionStore.index', '{"version":1,"entries":{}}'],
	]);

	try {
		const originalBytes = fs.readFileSync(dbPath);
		const value = await readSqliteItemValueCached(dbPath, wasmPath, 'chat.ChatSessionStore.index');
		const missing = await readSqliteItemValueCached(dbPath, wasmPath, 'missing-key');

		assert.equal(value, '{"version":1,"entries":{}}');
		assert.equal(missing, null);
		// Файл БД и его окружение остаются нетронутыми: ни изменений, ни журналов.
		assert.deepEqual(fs.readFileSync(dbPath), originalBytes);
		assert.deepEqual(fs.readdirSync(tempDir), ['state.vscdb']);

		// Подменяем файл новой версией БД: кэш должен инвалидироваться по отпечатку файла.
		const updated = await createStateDbWithItems([
			['chat.ChatSessionStore.index', '{"version":1,"entries":{"a":{}}}'],
		]);
		try {
			fs.copyFileSync(updated.dbPath, dbPath);
			const future = new Date(Date.now() + 5000);
			fs.utimesSync(dbPath, future, future);
			const refreshed = await readSqliteItemValueCached(dbPath, wasmPath, 'chat.ChatSessionStore.index');
			assert.equal(refreshed, '{"version":1,"entries":{"a":{}}}');
		} finally {
			fs.rmSync(updated.tempDir, { recursive: true, force: true });
		}
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

/** Проверяет, что для отсутствующей БД возвращается null без создания файла. */
test('readSqliteItemValueCached returns null for a missing database without creating it', async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-manager-sqlite-missing-'));
	const dbPath = path.join(tempDir, 'state.vscdb');
	const wasmPath = path.resolve(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

	try {
		assert.equal(await readSqliteItemValueCached(dbPath, wasmPath, 'any-key'), null);
		assert.equal(fs.existsSync(dbPath), false);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

/** Проверяет поиск WASM-файла sql.js в папке `dist` расширения. */
test('resolveBundledSqlJsWasmPath returns the dist wasm path only when it exists', () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-manager-sqljs-wasm-'));

	try {
		assert.equal(resolveBundledSqlJsWasmPath(tempDir), null);
		assert.equal(resolveBundledSqlJsWasmPath(''), null);

		fs.mkdirSync(path.join(tempDir, 'dist'));
		fs.writeFileSync(path.join(tempDir, 'dist', 'sql-wasm.wasm'), '');
		assert.equal(resolveBundledSqlJsWasmPath(tempDir), path.join(tempDir, 'dist', 'sql-wasm.wasm'));
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
