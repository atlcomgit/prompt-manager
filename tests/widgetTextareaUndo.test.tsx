import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import type { WebviewToExtensionMessage } from '../src/types/messages.js';
import type { QuickNoteView } from '../src/types/quickNotes.js';
import type { QuickNoteModalClient } from '../src/webview/editor/components/quickNotes/QuickNoteModal.js';

test('Заметка и команда сохраняют окончания строк при отмене ввода и переименовании', async t => {
	const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
	GlobalRegistrator.register();
	const { act } = await import('react');
	const { createRoot } = await import('react-dom/client');
	const { Simulate } = await import('react-dom/test-utils');
	const { QuickCommandModal } = await import('../src/webview/editor/components/QuickCommandModal.js');
	const { QuickNoteModal } = await import('../src/webview/editor/components/quickNotes/QuickNoteModal.js');
	const root = createRoot(document.body.appendChild(document.createElement('div')));
	Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
	let command: Extract<WebviewToExtensionMessage, { type: 'savePromptDashboardQuickCommand' }> | undefined;
	Object.defineProperty(globalThis, 'acquireVsCodeApi', { configurable: true, value: () => ({
		postMessage(message: WebviewToExtensionMessage) {
			if (message.type === 'savePromptDashboardQuickCommand') command = message;
		},
	}) });
	t.after(async () => {
		await act(async () => root.unmount());
		Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
		Reflect.deleteProperty(globalThis, 'acquireVsCodeApi');
		await GlobalRegistrator.unregister();
	});
	let savedNoteText: string | undefined;
	const client: QuickNoteModalClient = {
		apply: async operation => { if (operation.kind === 'replace') savedNoteText = operation.note.description; return { ok: true }; },
		attach: async () => ({ files: [], previewUris: {}, skipped: [] }),
		attachLocalFiles: async () => ({ files: [], previewUris: {}, skipped: [] }),
		removeDraftFile: async () => ({ ok: true }), setDescriptionHeight() {}, discardDraft() {}, openFile() {},
		createPrompt: async () => ({ ok: true }), openPrompt() {}, suggest: async () => ({ text: '' }),
	};
	const opener = document.body.appendChild(document.createElement('button'));
	const prompt = { id: 'test', promptUuid: 'test', title: 'Тест', taskNumber: '' };
	const change = (field: HTMLInputElement | HTMLTextAreaElement, value: string) =>
		act(async () => { field.value = value; Simulate.change(field); });
	const click = (button: HTMLButtonElement) => act(async () => button.click());
	const button = (label: string) => {
		const found = Array.from(document.querySelectorAll('button')).find(element => element.textContent === label || element.getAttribute('aria-label') === label);
		assert.ok(found, label);
		return found;
	};
	for (const kind of ['note', 'command'] as const) {
		for (const raw of ['one\r\ntwo\r\n', 'one\rtwo\r', 'one\r\ntwo\rthree\n']) {
			const visible = raw.replace(/\r\n?/g, '\n');
			let closed = 0;
			const onClose = () => { closed++; };
			const item = { title: 'Исходное', text: raw };
			const note: QuickNoteView = { id: 'n', title: item.title, description: raw, scope: 'workspace', order: 0,
				createdAt: '2026-01-01', updatedAt: '2026-01-01', files: [], items: [], done: false, color: '' };
			const mount = () => act(async () => root.render(kind === 'note'
				? <QuickNoteModal note={note} client={client} navigationIds={[]} workspaceAvailable onNavigate={() => {}} onClose={onClose} />
				: <QuickCommandModal session={{ original: item, opener }} items={[item]} prompt={prompt} onClose={onClose} />));
			await mount();
			const field = document.querySelector('textarea')!;
			assert.equal(field.value, visible);
			await change(field, visible + 'x');
			await click(button('Отмена'));
			assert.equal(closed, 0);
			await click(button('Остаться'));
			// После отмены ввода браузер отдаёт из textarea текст с LF.
			await change(field, visible);
			await click(button('Отмена'));
			assert.equal(closed, 1);
			await act(async () => root.render(null));
			await mount();
			const text = document.querySelector('textarea')!;
			await change(text, visible + 'x');
			await change(text, visible);
			await change(document.querySelector<HTMLInputElement>('[aria-label="Название заметки"], input.pm-qn-input')!, 'Переименовано');
			await click(document.querySelector<HTMLButtonElement>('.pm-qn-modal-f .is-primary')!);
			assert.equal(kind === 'note' ? savedNoteText : command?.edit.command.text, raw);
			await act(async () => root.render(null));
		}
	}
});
