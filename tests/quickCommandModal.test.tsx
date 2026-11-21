import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import React from 'react';
import type { Uri, Webview } from 'vscode';
import type { WebviewToExtensionMessage } from '../src/types/messages.js';

/** Run the actual shared button-focus script; pointer events alone miss its animation-frame blur in component tests. */
async function installWebviewFocusHandlers() {
	const modules = Module as unknown as { _load: (...args: unknown[]) => unknown };
	const load = modules._load;
	modules._load = function (request, ...args) {
		return request === 'vscode' ? { Uri: { joinPath: () => '/editor.js' } } : load.call(this, request, ...args);
	};
	try {
		const { getWebviewHtml } = await import('../src/utils/webviewHtml.js');
		const html = getWebviewHtml({ asWebviewUri: (uri: Uri) => uri, cspSource: '' } as Webview, {} as Uri, 'editor.js', '', 'ru');
		const scripts = new DOMParser().parseFromString(html, 'text/html').querySelectorAll('script');
		const script = Array.from(scripts).find(element => element.textContent?.includes('pointerdown'));
		assert.ok(script?.textContent);
		new Function(script.textContent)();
	} finally { modules._load = load; }
}

test('modal retains focus and its exact draft/base until the matching save acknowledgement', async t => {
	const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
	GlobalRegistrator.register();
	const { createRoot } = await import('react-dom/client');
	const { flushSync } = await import('react-dom');
	const { QuickCommandModal } = await import('../src/webview/editor/components/QuickCommandModal.js');
	type Request = Extract<WebviewToExtensionMessage, { type: 'savePromptDashboardQuickCommand' }>;
	const requests: Request[] = [];
	Object.defineProperty(globalThis, 'acquireVsCodeApi', { configurable: true, value: () => ({
		postMessage: (msg: WebviewToExtensionMessage) => { if (msg.type === 'savePromptDashboardQuickCommand') requests.push(msg); },
	}) });
	await installWebviewFocusHandlers();
	const root = createRoot(document.createElement('div'));
	t.after(async () => {
		root.unmount();
		Reflect.deleteProperty(globalThis, 'acquireVsCodeApi');
		await GlobalRegistrator.unregister();
	});
	const rail = document.body.appendChild(document.createElement('aside'));
	rail.setAttribute('data-pm-prompt-dashboard', 'true');
	Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1000 });
	Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 740 });
	let left = 390;
	t.mock.method(rail, 'getBoundingClientRect', () => ({ left, right: 1000, top: 40, bottom: 700 }));
	const opener = document.body.appendChild(document.createElement('button'));
	const item = { title: 'A', text: 'A\r\nBC' };
	const close = t.mock.fn(() => root.render(null));
	flushSync(() => root.render(<QuickCommandModal session={{ original: item, opener }} items={[item]}
		prompt={{ id: 'id', promptUuid: 'uuid', title: 'Test', taskNumber: '7' }} onClose={close} />));
	const form = document.querySelector<HTMLFormElement>('.pm-quick-command-modal')!;
	const overlay = form.closest<HTMLElement>('.pm-dashboard-dialog-overlay')!;
	assert.equal(overlay.style.paddingLeft, '402px');
	assert.equal(overlay.style.paddingTop, '52px');
	assert.equal(overlay.style.paddingBottom, '52px');
	left = 600;
	window.dispatchEvent(new Event('resize'));
	assert.equal(overlay.style.paddingLeft, '612px');
	const textarea = form.querySelector('textarea')!;
	// A native textarea exposes LF offsets for an incoming CRLF Settings Sync value.
	textarea.value = textarea.value.replace(/\r\n/g, '\n');
	textarea.setSelectionRange(textarea.value.length, textarea.value.length);
	flushSync(() => form.querySelector<HTMLButtonElement>('button[title="{{taskNumber}}"]')!.click());
	assert.equal(textarea.value, 'A\nBC{{taskNumber}}');
	const preview = form.querySelector<HTMLButtonElement>('.pm-quick-command-preview button')!;
	flushSync(() => {
		preview.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		preview.focus();
		preview.click();
	});
	await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
	assert.equal(document.activeElement, preview);
	const key = (name: string, ctrlKey = false) => flushSync(() =>
		document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: name, ctrlKey, bubbles: true, cancelable: true })));
	key('Escape');
	assert.match(form.textContent!, /Закрыть без сохранения/);
	key('s', true);
	assert.equal(requests.length, 0);
	key('Escape');
	key('s', true);
	assert.equal(requests.length, 1);
	const reply = (requestId: string, error?: string) => flushSync(() => window.dispatchEvent(new MessageEvent('message', {
		data: { type: 'promptDashboardQuickCommandSaved', requestId, error },
	})));
	reply(requests[0].requestId, 'Ошибка записи');
	assert.equal(close.mock.callCount(), 0);
	assert.equal(form.querySelector('[role=alert]')?.textContent, 'Ошибка записи');
	key('s', true);
	assert.equal(requests.length, 2);
	assert.deepEqual(requests[0].edit, requests[1].edit);
	assert.deepEqual(requests[1].edit.original, item);
	assert.equal(requests[1].edit.command.text, textarea.value);
	assert.notEqual(requests[1].requestId, requests[0].requestId);
	reply(requests[0].requestId);
	assert.equal(close.mock.callCount(), 0);
	reply(requests[1].requestId);
	assert.equal(close.mock.callCount(), 1);
	assert.equal(document.activeElement, opener);
});
