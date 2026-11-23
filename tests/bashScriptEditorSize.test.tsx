import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import type { BashScriptsRequest } from '../src/types/bashScripts.js';

test('Редактор показывает загрузку в поле кода и переносит выбранный размер на следующий скрипт', async t => {
	const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
	GlobalRegistrator.register();
	const { act } = await import('react');
	const { createRoot } = await import('react-dom/client');
	const { BashScriptEditor } = await import('../src/webview/editor/components/bashScripts/BashScriptEditor.js');
	const messages: BashScriptsRequest[] = [];
	Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
	Object.defineProperty(globalThis, 'acquireVsCodeApi', { configurable: true, value: () => ({
		getState: () => ({}), postMessage: (message: BashScriptsRequest) => messages.push(message),
	}) });
	const root = createRoot(document.body.appendChild(document.createElement('div')));
	t.after(async () => {
		await act(async () => root.unmount());
		Reflect.deleteProperty(globalThis, 'acquireVsCodeApi');
		Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
		await GlobalRegistrator.unregister();
	});
	const sizeKey = 'promptManager.bashScriptEditor.size';
	const mount = (name: string) => act(async () => root.render(<BashScriptEditor key={name}
		initial={{ scope: 'project', path: name, name, content: '', base: { name, path: name }, ref: { scope: 'project', id: name } }}
		opener={null} onClose={() => root.render(null)} />));
	const dialog = () => document.querySelector<HTMLElement>('.pm-bs-editor')!;
	const close = () => act(async () => dialog().querySelector<HTMLButtonElement>('[aria-label="Закрыть редактор"]')!.click());
	const loading = () => dialog().querySelector('.pm-bs-content [role="status"]');
	// A corrupt preference should use the default box even while the slow first read is pending.
	localStorage.setItem(sizeKey, '{"width":"bad","height":null}');
	await mount('first.sh');
	assert.equal(dialog().style.width, '');
	assert.equal(dialog().style.height, '');
	assert.match(loading()?.textContent ?? '', /Чтение файла/);
	assert.ok(loading()?.querySelector('svg'));
	const originalDialog = dialog();
	await act(async () => { window.dispatchEvent(new MessageEvent('message', { data: {
		type: 'bashScriptsResponse', requestId: messages.at(-1)!.requestId,
		result: { path: 'first.sh', content: '', revision: '1', nativeEditorReason: 'Файл больше 1 МиБ' },
	} })); });
	assert.equal(dialog(), originalDialog);
	assert.equal(loading(), null);
	assert.ok(dialog().textContent?.includes('Файл больше 1 МиБ'));
	// CSS resizing writes inline sizes. Closing immediately must also flush the preference.
	dialog().setAttribute('style', 'width: 532px; height: 410px;');
	await close();
	await mount('second.sh');
	assert.equal(dialog().style.width, '532px');
	assert.equal(dialog().style.height, '410px');
	assert.match(loading()?.textContent ?? '', /Чтение файла/);
	// A change to the available rail area belongs to the overlay, separate from the preferred size.
	dialog().parentElement!.style.paddingRight = '300px';
	window.dispatchEvent(new Event('resize'));
	await close();
	assert.deepEqual(JSON.parse(localStorage.getItem(sizeKey)!), { width: '532px', height: '410px' });
});
