import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveReadableTextColor } from '../src/utils/colorContrast.js';

test('resolveReadableTextColor returns white for dark backgrounds', () => {
	assert.equal(resolveReadableTextColor('#1f3a5f'), '#ffffff');
	assert.equal(resolveReadableTextColor('rgb(12, 28, 44)'), '#ffffff');
});

test('resolveReadableTextColor returns black for light backgrounds', () => {
	assert.equal(resolveReadableTextColor('#bfe6ff'), '#000000');
	assert.equal(resolveReadableTextColor('rgb(240, 240, 240)'), '#000000');
});

test('resolveReadableTextColor returns undefined for unsupported color formats', () => {
	assert.equal(resolveReadableTextColor('var(--vscode-editor-background)'), undefined);
	assert.equal(resolveReadableTextColor(''), undefined);
});