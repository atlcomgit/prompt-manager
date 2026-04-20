import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveRichTextEditorHeight } from '../src/webview/editor/components/RichTextEditor.js';

test('resolveRichTextEditorHeight keeps auto-resize height above the manual cap', () => {
	assert.equal(resolveRichTextEditorHeight({
		measuredHeight: 980,
		autoResize: true,
	}), 982);
});

test('resolveRichTextEditorHeight keeps the manual drag cap for non auto-resize mode', () => {
	assert.equal(resolveRichTextEditorHeight({
		measuredHeight: 980,
		autoResize: false,
	}), 800);
});

test('resolveRichTextEditorHeight ignores invalid measurements', () => {
	assert.equal(resolveRichTextEditorHeight({
		measuredHeight: 0,
		autoResize: true,
	}), null);
});