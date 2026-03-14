import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAreaDescriptionBatches, parseCodeMapAreaBatchResponse } from '../src/codemap/codeMapInstructionService.js';

test('buildAreaDescriptionBatches packs multiple areas until the configured context budget is reached', () => {
	const items = [
		{ id: 'area-1', area: 'src/services', representativeFiles: ['src/services/a.ts'], symbols: ['ServiceA'], snippets: [{ filePath: 'src/services/a.ts', snippet: 'a'.repeat(1500) }] },
		{ id: 'area-2', area: 'src/providers', representativeFiles: ['src/providers/b.ts'], symbols: ['ProviderB'], snippets: [{ filePath: 'src/providers/b.ts', snippet: 'b'.repeat(1500) }] },
		{ id: 'area-3', area: 'webview/memory', representativeFiles: ['webview/memory/c.tsx'], symbols: ['MemoryView'], snippets: [{ filePath: 'webview/memory/c.tsx', snippet: 'c'.repeat(1500) }] },
	];

	const batches = buildAreaDescriptionBatches(items, 4000);

	assert.equal(batches.length, 2);
	assert.deepEqual(batches[0].map(item => item.id), ['area-1', 'area-2']);
	assert.deepEqual(batches[1].map(item => item.id), ['area-3']);
});

test('parseCodeMapAreaBatchResponse extracts area descriptions from fenced JSON payloads', () => {
	const parsed = parseCodeMapAreaBatchResponse('```json\n{"areas":[{"id":"area-1","description":"Первое описание"},{"id":"area-2","description":"Second description"}]}\n```');

	assert.deepEqual(parsed, {
		'area-1': 'Первое описание',
		'area-2': 'Second description',
	});
});
