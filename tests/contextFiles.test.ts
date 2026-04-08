import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
	buildContextFileCardPlaceholder,
	hasContextFileParentTraversal,
	extractContextFilePathsFromClipboardText,
	getContextFileExtensionFromMimeType,
	getContextFileKind,
	isContextFilePreviewSupported,
} from '../src/utils/contextFiles.js';
import { ContextFileCard } from '../src/webview/editor/components/ContextFileCard.js';

function withLocale<T>(locale: string, callback: () => T): T {
	const previousWindow = globalThis.window;
	Object.defineProperty(globalThis, 'window', {
		value: { __LOCALE__: locale },
		configurable: true,
		writable: true,
	});

	try {
		return callback();
	} finally {
		if (previousWindow === undefined) {
			Reflect.deleteProperty(globalThis as Record<string, unknown>, 'window');
		} else {
			Object.defineProperty(globalThis, 'window', {
				value: previousWindow,
				configurable: true,
				writable: true,
			});
		}
	}
}

test('extractContextFilePathsFromClipboardText normalizes, parses file URLs and deduplicates values', () => {
	const result = extractContextFilePathsFromClipboardText([
		'  src/webview/editor/EditorApp.tsx  ',
		'"src/webview/editor/EditorApp.tsx"',
		'file:///tmp/example.png',
		'notes without extension',
	].join('\n'));

	assert.deepEqual(result, [
		'src/webview/editor/EditorApp.tsx',
		'/tmp/example.png',
	]);
});

test('context file helpers detect previewable kinds and build stable placeholders', () => {
	const imageCard = buildContextFileCardPlaceholder('assets/screenshot.png');
	const videoKind = getContextFileKind('videos/demo.mp4');
	const pdfKind = getContextFileKind('docs/spec.pdf');

	assert.equal(imageCard.displayName, 'screenshot.png');
	assert.equal(imageCard.tileLabel, 'PNG');
	assert.equal(imageCard.kind, 'image');
	assert.equal(imageCard.sizeLabel, '…');
	assert.equal(isContextFilePreviewSupported(videoKind), true);
	assert.equal(isContextFilePreviewSupported(pdfKind), false);
});

test('hasContextFileParentTraversal blocks relative parent traversal but keeps absolute paths intact', () => {
	assert.equal(hasContextFileParentTraversal('../secret/file.txt'), true);
	assert.equal(hasContextFileParentTraversal('../../secret/file.txt'), true);
	assert.equal(hasContextFileParentTraversal('/var/tmp/file.txt'), false);
	assert.equal(hasContextFileParentTraversal('C:/Users/test/file.txt'), false);
	assert.equal(hasContextFileParentTraversal('src/webview/editor/EditorApp.tsx'), false);
});

test('getContextFileExtensionFromMimeType maps common image clipboard mime types', () => {
	assert.equal(getContextFileExtensionFromMimeType('image/png'), 'png');
	assert.equal(getContextFileExtensionFromMimeType('image/jpeg'), 'jpg');
	assert.equal(getContextFileExtensionFromMimeType('image/webp'), 'webp');
	assert.equal(getContextFileExtensionFromMimeType('application/octet-stream'), 'bin');
});

test('ContextFileCard renders fallback state with size, path hint and missing badge', () => {
	const markup = withLocale('ru', () => renderToStaticMarkup(React.createElement(ContextFileCard, {
		file: {
			path: 'assets/missing.png',
			displayName: 'missing.png',
			directoryLabel: 'assets',
			extension: 'png',
			tileLabel: 'PNG',
			kind: 'image',
			typeLabel: 'PNG image',
			exists: false,
			sizeLabel: '—',
			previewUri: undefined,
		},
		onOpen: () => { },
		onRemove: () => { },
	})));

	assert.match(markup, /missing\.png/);
	assert.match(markup, /Недоступен/);
	assert.match(markup, /PNG image/);
	assert.match(markup, /assets/);
	assert.match(markup, /disabled=""/);
});

test('ContextFileCard renders an image preview when previewUri is available', () => {
	const markup = withLocale('en', () => renderToStaticMarkup(React.createElement(ContextFileCard, {
		file: {
			path: 'images/preview.png',
			displayName: 'preview.png',
			directoryLabel: 'images',
			extension: 'png',
			tileLabel: 'PNG',
			kind: 'image',
			typeLabel: 'PNG image',
			exists: true,
			sizeLabel: '18.4 KB',
			previewUri: 'vscode-webview-resource://preview.png',
			modifiedAt: '2026-04-08T04:00:00.000Z',
		},
		onOpen: () => { },
		onRemove: () => { },
	})));

	assert.match(markup, /<img/);
	assert.match(markup, /18\.4 KB/);
	assert.match(markup, /preview\.png/);
	assert.doesNotMatch(markup, /Unavailable/);
});