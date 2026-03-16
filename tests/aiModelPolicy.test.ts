import test from 'node:test';
import assert from 'node:assert/strict';

import { isZeroCostCopilotModelPickerCategory, normalizeCopilotModelFamily, normalizeOptionalCopilotModelFamily } from '../src/constants/ai.js';

test('normalizeCopilotModelFamily strips vendor prefixes from copilot identifiers', () => {
	assert.equal(normalizeCopilotModelFamily('copilot/gpt-5-mini'), 'gpt-5-mini');
	assert.equal(normalizeCopilotModelFamily('gpt-4.1'), 'gpt-4.1');
});

test('normalizeOptionalCopilotModelFamily preserves empty model selection', () => {
	assert.equal(normalizeOptionalCopilotModelFamily(''), '');
	assert.equal(normalizeOptionalCopilotModelFamily('  '), '');
	assert.equal(normalizeOptionalCopilotModelFamily('copilot/gpt-5-mini'), 'gpt-5-mini');
	assert.equal(normalizeOptionalCopilotModelFamily('some-random-model'), '');
});

test('isZeroCostCopilotModelPickerCategory recognizes standard model buckets', () => {
	assert.equal(isZeroCostCopilotModelPickerCategory({ label: 'Стандартные модели', order: 0 }), true);
	assert.equal(isZeroCostCopilotModelPickerCategory({ label: 'Standard Models', order: 0 }), true);
});

test('isZeroCostCopilotModelPickerCategory rejects premium model buckets', () => {
	assert.equal(isZeroCostCopilotModelPickerCategory({ label: 'Премиум-модели', order: 1 }), false);
	assert.equal(isZeroCostCopilotModelPickerCategory({ label: 'Premium Models', order: 1 }), false);
});
