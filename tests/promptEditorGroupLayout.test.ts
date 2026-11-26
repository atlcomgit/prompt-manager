import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { observePromptEditorGroupLayout } from '../src/webview/editor/promptEditorGroupLayout.js';

beforeEach(async () => {
	const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
	GlobalRegistrator.register();
});
afterEach(async () => {
	const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
	await GlobalRegistrator.unregister();
});

function size(width: number, height = 800, outerWidth = 1500) {
	for (const [key, value] of Object.entries({ innerWidth: width, innerHeight: height, outerWidth, outerHeight: 900 })) {
		Object.defineProperty(window, key, { configurable: true, value });
	}
	window.dispatchEvent(new Event('resize'));
}

function confirm(viewportWidth: number, singleGroup: boolean, hideDashboard: boolean, groupWidthFraction?: number) {
	window.dispatchEvent(new MessageEvent('message', {
		data: { type: 'promptEditorGroupLayoutChanged', singleGroup, hideDashboard, viewportWidth, groupWidthFraction },
	}));
}

/** Drive real resize and message events independently so late workbench geometry cannot mask a missed first frame. */
test('prompt editor previews a split on resize and accepts corrections for the current width', () => {
	size(1200);
	const requests: number[] = [];
	const changes: { hidden: boolean; beforePaint: boolean }[] = [];
	const stop = observePromptEditorGroupLayout(window, width => requests.push(width),
		(hidden, beforePaint) => changes.push({ hidden, beforePaint }));
	try {
		confirm(1200, true, false);
		size(600);
		assert.deepEqual(requests, [1200, 600]);
		assert.deepEqual(changes, [{ hidden: true, beforePaint: true }]);
		confirm(1200, true, false);
		assert.equal(changes.length, 1);
		// Opening a wide sidebar can produce the very same geometry. Its confirmed layout takes precedence.
		confirm(600, true, false);
		assert.deepEqual(changes.at(-1), { hidden: false, beforePaint: false });
		size(1200);
		confirm(1200, true, false);
		size(601);
		size(600);
		assert.equal(changes.length, 2, 'crossing half width during a gradual drag');
		size(1200);
		size(600, 400);
		assert.equal(changes.length, 2, 'both axes changed');
		size(1200);
		size(600, 800, 900);
		assert.equal(changes.length, 2, 'the outer window was resized');
		size(1200);
		size(599);
		confirm(599, false, true);
		assert.equal(changes.length, 3, 'confirmation keeps the same hidden state');
		size(1200);
		confirm(1200, false, false);
		assert.deepEqual(changes.at(-1), { hidden: false, beforePaint: false });
		size(600);
		assert.equal(changes.length, 4, 'a known multi-group layout always waits for its exact proportions');
	} finally {
		stop();
	}
});

/** The editor can open directly in a split and rejoin it before the workbench answers the previous resize. */
test('closing an equal or uneven split restores the dashboard before paint and ignores the old hidden width', () => {
	for (const paneWidth of [400, 640]) {
		size(paneWidth);
		const changes: { hidden: boolean; beforePaint: boolean }[] = [];
		const stop = observePromptEditorGroupLayout(window, () => {}, (hidden, beforePaint) => changes.push({ hidden, beforePaint }));
		// The workbench group can include a one-pixel edge outside the measured webview.
		const fraction = (paneWidth === 400 ? 401 : paneWidth) / 1280;
		try {
			confirm(paneWidth, false, true, fraction);
			size(paneWidth - 32);
			assert.deepEqual(changes, [{ hidden: true, beforePaint: false }]);
			size(1281);
			assert.deepEqual(changes.at(-1), { hidden: false, beforePaint: true });
			confirm(paneWidth, false, true, fraction);
			assert.equal(changes.length, 2, 'late split confirmation after close');
			size(640);
			assert.deepEqual(changes.at(-1), { hidden: true, beforePaint: true });
			confirm(1281, true, false);
			assert.equal(changes.length, 3, 'late close confirmation after another split');
			size(1280);
			assert.deepEqual(changes.at(-1), { hidden: false, beforePaint: true });
			confirm(1280, true, false);
			assert.equal(changes.length, 4);
		} finally {
			stop();
		}
	}
});
