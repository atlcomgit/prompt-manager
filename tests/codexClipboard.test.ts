import test from 'node:test';
import assert from 'node:assert/strict';
import { splitCodexPasteText } from '../src/utils/codexClipboard.js';

test('Codex paste chunks stay below the attachment threshold and preserve the full input', () => {
	for (const length of [0, 1, 4999, 5000, 5001, 8000, 25000, 100000]) {
		const text = 'я'.repeat(length);
		const chunks = splitCodexPasteText(text);
		assert.equal(chunks.join(''), text);
		assert.ok(chunks.every(chunk => chunk.length < 5000));
		assert.equal(chunks.length === 1, length < 5000);
	}
});

test('Codex paste chunks preserve whitespace, surrogate pairs and CRLF boundaries', () => {
	for (const boundary of ['😀', '\r\n']) {
		const text = ' '.repeat(3999) + boundary + '\tя\n'.repeat(2000) + '  \n';
		const chunks = splitCodexPasteText(text);
		assert.equal(chunks.join(''), text);
		assert.ok(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk)));
		for (let index = 1; index < chunks.length; index++) {
			assert.ok(!(chunks[index - 1].endsWith('\r') && chunks[index].startsWith('\n')));
		}
	}
});
