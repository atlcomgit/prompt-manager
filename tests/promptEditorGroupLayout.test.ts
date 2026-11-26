import assert from 'node:assert/strict';
import test from 'node:test';
import { observePromptEditorGroupLayout } from '../src/webview/editor/promptEditorGroupLayout.js';

/** Drive real resize and message events independently so late workbench geometry cannot mask a missed first frame. */
test('prompt editor previews a split on resize and accepts corrections for the current width', async t => {
	const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
	GlobalRegistrator.register();
	t.after(() => GlobalRegistrator.unregister());
	function size(width: number, height = 800, outerWidth = 1500) {
		for (const [key, value] of Object.entries({ innerWidth: width, innerHeight: height, outerWidth, outerHeight: 900 })) {
			Object.defineProperty(window, key, { configurable: true, value });
		}
		window.dispatchEvent(new Event('resize'));
	}
	function confirm(viewportWidth: number, singleGroup: boolean, hideDashboard: boolean) {
		window.dispatchEvent(new MessageEvent('message', {
			data: { type: 'promptEditorGroupLayoutChanged', singleGroup, hideDashboard, viewportWidth },
		}));
	}

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
