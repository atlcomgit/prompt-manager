import test from 'node:test';
import assert from 'node:assert/strict';

import {
	resolveRichTextEditorHeight,
	resolveRichTextEditorCopyValue,
	shouldCommitDeferredRichTextBlur,
	shouldDeferRichTextModeSwitchAutoResize,
	shouldPreserveRichTextPageScrollSnapshotOnNoop,
	shouldRetryRichTextPageScrollRestore,
	shouldUseRichTextPageScrollFallback,
	shouldRestoreRichTextPageScroll,
} from '../src/webview/editor/components/RichTextEditor.js';

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

test('resolveRichTextEditorCopyValue returns the representation of the selected mode', () => {
	assert.equal(resolveRichTextEditorCopyValue({
		mode: 'visual',
		rawValue: '<p>fallback</p>',
		visualHtml: '<p>Hello <strong>world</strong></p>',
	}), '<p>Hello <strong>world</strong></p>');

	assert.equal(resolveRichTextEditorCopyValue({
		mode: 'html',
		rawValue: 'fallback',
		sourceText: 'Line 1\r\nLine 2',
	}), 'Line 1\nLine 2');

	assert.equal(resolveRichTextEditorCopyValue({
		mode: 'markdown',
		rawValue: '# Title\r\n\r\nBody',
	}), '# Title\n\nBody');
});

test('shouldCommitDeferredRichTextBlur ignores transient blur when focus already returned into the editor', () => {
	assert.equal(shouldCommitDeferredRichTextBlur({
		activeElementInsideEditor: true,
		documentHasFocus: true,
	}), false);
});

test('shouldCommitDeferredRichTextBlur ignores blur while the document itself is unfocused', () => {
	assert.equal(shouldCommitDeferredRichTextBlur({
		activeElementInsideEditor: false,
		documentHasFocus: false,
	}), false);
});

test('shouldCommitDeferredRichTextBlur commits once focus moved outside the editor inside the same document', () => {
	assert.equal(shouldCommitDeferredRichTextBlur({
		activeElementInsideEditor: false,
		documentHasFocus: true,
	}), true);
});

test('shouldRestoreRichTextPageScroll skips no-op restore when the viewport did not move', () => {
	assert.equal(shouldRestoreRichTextPageScroll({
		currentTop: 320,
		savedTop: 320,
		currentLeft: 0,
		savedLeft: 0,
	}), false);
});

test('shouldRestoreRichTextPageScroll restores when the surrounding page jumped vertically', () => {
	assert.equal(shouldRestoreRichTextPageScroll({
		currentTop: 0,
		savedTop: 320,
		currentLeft: 0,
		savedLeft: 0,
	}), true);
});

test('shouldDeferRichTextModeSwitchAutoResize ignores obviously stale tiny first-pass measurement after mode switch', () => {
	assert.equal(shouldDeferRichTextModeSwitchAutoResize({
		modeSwitchPending: true,
		sourceLength: 2600,
		currentHeight: 1281,
		measuredHeight: 64,
		deferredMeasurements: 0,
	}), true);
});

test('shouldDeferRichTextModeSwitchAutoResize accepts stable measurements and stops after the retry budget', () => {
	assert.equal(shouldDeferRichTextModeSwitchAutoResize({
		modeSwitchPending: true,
		sourceLength: 2600,
		currentHeight: 1281,
		measuredHeight: 621,
		deferredMeasurements: 0,
	}), false);

	assert.equal(shouldDeferRichTextModeSwitchAutoResize({
		modeSwitchPending: true,
		sourceLength: 2600,
		currentHeight: 1281,
		measuredHeight: 64,
		deferredMeasurements: 2,
	}), false);
});

test('shouldPreserveRichTextPageScrollSnapshotOnNoop keeps mode-switch and blur snapshots alive while retries remain', () => {
	assert.equal(shouldPreserveRichTextPageScrollSnapshotOnNoop({
		snapshotReason: 'mode.switch',
		remainingAttempts: 3,
	}), true);

	assert.equal(shouldPreserveRichTextPageScrollSnapshotOnNoop({
		snapshotReason: 'blur.pointerDown',
		remainingAttempts: 2,
	}), true);

	assert.equal(shouldPreserveRichTextPageScrollSnapshotOnNoop({
		snapshotReason: 'mode.switch',
		remainingAttempts: 1,
	}), false);

	assert.equal(shouldPreserveRichTextPageScrollSnapshotOnNoop({
		snapshotReason: 'autoResize.heightChanged',
		remainingAttempts: 3,
	}), false);
});

test('shouldRetryRichTextPageScrollRestore retries only harmless no-op attempts', () => {
	assert.equal(shouldRetryRichTextPageScrollRestore({
		restoreResult: 'noop',
		snapshotReason: 'mode.switch',
		remainingAttempts: 3,
	}), true);

	assert.equal(shouldRetryRichTextPageScrollRestore({
		restoreResult: 'restored',
		snapshotReason: 'mode.switch',
		remainingAttempts: 3,
	}), false);

	assert.equal(shouldRetryRichTextPageScrollRestore({
		restoreResult: 'noop',
		snapshotReason: 'autoResize.heightChanged',
		remainingAttempts: 3,
	}), false);
});

test('shouldUseRichTextPageScrollFallback reuses the last stable focused scroll only for early top-reset snapshots', () => {
	assert.equal(shouldUseRichTextPageScrollFallback({
		reason: 'mode.switch',
		currentTop: 0,
		currentLeft: 0,
		lastKnownTop: 432,
		lastKnownLeft: 0,
		lastKnownAgeMs: 250,
	}), true);

	assert.equal(shouldUseRichTextPageScrollFallback({
		reason: 'blur.defer',
		currentTop: 0,
		currentLeft: 0,
		lastKnownTop: 277,
		lastKnownLeft: 0,
		lastKnownAgeMs: 3900,
	}), true);

	assert.equal(shouldUseRichTextPageScrollFallback({
		reason: 'mode.switch',
		currentTop: 16,
		currentLeft: 0,
		lastKnownTop: 432,
		lastKnownLeft: 0,
		lastKnownAgeMs: 250,
	}), false);

	assert.equal(shouldUseRichTextPageScrollFallback({
		reason: 'autoResize.heightChanged',
		currentTop: 0,
		currentLeft: 0,
		lastKnownTop: 432,
		lastKnownLeft: 0,
		lastKnownAgeMs: 250,
	}), false);

	assert.equal(shouldUseRichTextPageScrollFallback({
		reason: 'mode.switch',
		currentTop: 0,
		currentLeft: 0,
		lastKnownTop: 432,
		lastKnownLeft: 0,
		lastKnownAgeMs: 5000,
	}), false);
});