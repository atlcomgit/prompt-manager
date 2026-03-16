import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAreaDescriptionBatches, buildSymbolDescriptionBatches, parseCodeMapAreaBatchResponse } from '../src/codemap/codeMapInstructionService.js';

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

test('buildAreaDescriptionBatches respects explicit max items per batch', () => {
	const items = [
		{ id: 'area-1', area: 'src/services', representativeFiles: ['src/services/a.ts'], symbols: ['ServiceA'], snippets: [{ filePath: 'src/services/a.ts', snippet: 'a' }] },
		{ id: 'area-2', area: 'src/providers', representativeFiles: ['src/providers/b.ts'], symbols: ['ProviderB'], snippets: [{ filePath: 'src/providers/b.ts', snippet: 'b' }] },
		{ id: 'area-3', area: 'src/webview', representativeFiles: ['src/webview/c.ts'], symbols: ['WebviewC'], snippets: [{ filePath: 'src/webview/c.ts', snippet: 'c' }] },
	];

	const batches = buildAreaDescriptionBatches(items, 24000, 2);

	assert.deepEqual(batches.map(batch => batch.map(item => item.id)), [
		['area-1', 'area-2'],
		['area-3'],
	]);
});

test('buildSymbolDescriptionBatches respects max files and max items limits', () => {
	const batches = buildSymbolDescriptionBatches([
		{ id: 's-1', filePath: 'a.ts', fileRole: 'services', kind: 'method', name: 'a', signature: 'a()', excerpt: 'a()', fallbackDescription: 'a' },
		{ id: 's-2', filePath: 'a.ts', fileRole: 'services', kind: 'method', name: 'b', signature: 'b()', excerpt: 'b()', fallbackDescription: 'b' },
		{ id: 's-3', filePath: 'b.ts', fileRole: 'services', kind: 'method', name: 'c', signature: 'c()', excerpt: 'c()', fallbackDescription: 'c' },
		{ id: 's-4', filePath: 'c.ts', fileRole: 'services', kind: 'method', name: 'd', signature: 'd()', excerpt: 'd()', fallbackDescription: 'd' },
	], 24000, 3, 2);

	assert.deepEqual(batches.map(batch => batch.map(item => item.id)), [
		['s-1', 's-2', 's-3'],
		['s-4'],
	]);
});

test('parseCodeMapAreaBatchResponse extracts area descriptions from fenced JSON payloads', () => {
	const parsed = parseCodeMapAreaBatchResponse('```json\n{"areas":[{"id":"area-1","description":"Первое описание"},{"id":"area-2","description":"Second description"}]}\n```');

	assert.deepEqual(parsed, {
		'area-1': 'Первое описание',
		'area-2': 'Second description',
	});
});
