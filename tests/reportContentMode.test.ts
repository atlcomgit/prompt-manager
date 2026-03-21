import test from 'node:test';
import assert from 'node:assert/strict';

import {
	detectReportContentMode,
	looksLikeExplicitHtml,
	looksLikeMarkdown,
} from '../src/utils/reportContentMode.js';

test('detectReportContentMode prefers html only for explicit markup', () => {
	const html = '<p><strong>Done</strong></p><ul><li>Item</li></ul>';

	assert.equal(looksLikeExplicitHtml(html), true);
	assert.equal(detectReportContentMode(html), 'html');
});

test('detectReportContentMode recognizes markdown reports', () => {
	const markdown = [
		'# Result',
		'',
		'- Added Markdown preview',
		'- Reordered buttons',
		'',
		'```ts',
		'const mode = "markdown";',
		'```',
	].join('\n');

	assert.equal(looksLikeMarkdown(markdown), true);
	assert.equal(detectReportContentMode(markdown), 'markdown');
	assert.equal(looksLikeExplicitHtml(markdown), false);
});

test('detectReportContentMode keeps plain text as text', () => {
	const text = 'Result prepared successfully. Next step is manual verification.';

	assert.equal(looksLikeExplicitHtml(text), false);
	assert.equal(looksLikeMarkdown(text), false);
	assert.equal(detectReportContentMode(text), 'text');
});

test('detectReportContentMode does not treat angle brackets and autolinks as html', () => {
	const textWithAngles = 'Compare values when a < b > c and keep <https://example.com> for reference.';

	assert.equal(looksLikeExplicitHtml(textWithAngles), false);
	assert.equal(detectReportContentMode(textWithAngles), 'text');
});

test('detectReportContentMode recognizes markdown tables and links', () => {
	const markdownTable = [
		'| Name | Status |',
		'| --- | --- |',
		'| Report | Ready |',
		'',
		'See [report](./report.md)',
	].join('\n');

	assert.equal(looksLikeMarkdown(markdownTable), true);
	assert.equal(detectReportContentMode(markdownTable), 'markdown');
});

test('detectReportContentMode recognizes self-closing html tags', () => {
	const html = 'Line 1<br/>Line 2<hr />';

	assert.equal(looksLikeExplicitHtml(html), true);
	assert.equal(detectReportContentMode(html), 'html');
});