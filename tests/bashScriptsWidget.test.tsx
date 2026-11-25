import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import type { BashScriptEntry, BashScriptsRequest, BashScriptsResult } from '../src/types/bashScripts.js';

/** Две одноимённые привязки отличаются областью, абсолютным путём и доступностью. */
const project: BashScriptEntry = { scope: 'project', id: 'same', name: 'Сборка', path: 'scripts/build.sh', absolutePath: '/workspace/scripts/build.sh', available: true,
	history: [{ id: '1', startedAt: '2026-02-01T10:00:00Z', finishedAt: '2026-02-01T10:02:00Z', exitCode: 7 }] };
const globalEntry: BashScriptEntry = { ...project, scope: 'global', available: false, path: '/common/build.sh', absolutePath: '/common/build.sh', history: [] };

test('Bash script filters combine scope, availability and path and order recent scripts by start time', async () => {
	const { filterBashScripts } = await import('../src/webview/editor/components/bashScripts/BashScriptsWidget.js');
	const later = { ...globalEntry, name: 'Позднее', history: [{ id: '2', startedAt: '2026-02-02T10:00:00Z' }] };
	const entries = [project, globalEntry, later];
	assert.deepEqual(filterBashScripts(entries, '  COMMON  ', 'global', 'missing'), [later, globalEntry]);
	assert.deepEqual(filterBashScripts(entries, '/WORKSPACE', 'project', 'available'), [project]);
	assert.deepEqual(filterBashScripts(entries, '', 'all', 'recent'), [later, project]);
	// Одноимённые записи разных областей отмечаются раздельно: ключ избранного включает область.
	assert.deepEqual(filterBashScripts(entries, '', 'all', 'favorite', { 'project:same': true, 'global:other': true }), [project]);
	assert.deepEqual(filterBashScripts(entries, '', 'global', 'favorite', { 'project:same': true }), []);
	assert.deepEqual(filterBashScripts(entries, '', 'all', 'favorite'), [], 'без отметок фильтр пуст');
	assert.deepEqual(entries, [project, globalEntry, later]);
});

test('Bash widget addresses actions by scope + id, protects a file draft and restores its original revision', { timeout: 60_000 }, async t => {
	const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
	GlobalRegistrator.register();
	const { createRoot } = await import('react-dom/client');
	const { act } = await import('react');
	const { Simulate } = await import('react-dom/test-utils');
	// Тот же модуль, который поставляется отдельным локальным bundle в webview.
	window.promptManagerBashCode = await import('../src/webview/editor/components/bashScripts/bashScriptCodeMirror.mjs');
	const { EditorView } = await import('@codemirror/view');
	const code = () => {
		const node = document.querySelector<HTMLElement>('.pm-bs-code .cm-content');
		assert.ok(node, 'редактор кода должен смонтироваться');
		const view = EditorView.findFromDOM(node);
		assert.ok(view);
		return view;
	};
	const editCode = (insert: string) => act(async () => {
		const view = code();
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert } });
	});
	const { BashScriptsWidget } = await import('../src/webview/editor/components/bashScripts/BashScriptsWidget.js');
	const { BashScriptEditorHost } = await import('../src/webview/editor/components/bashScripts/BashScriptEditorHost.js');
	const messages: BashScriptsRequest[] = [];
	let panel: Record<string, unknown> = { unrelated: true };
	Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
	Object.defineProperty(globalThis, 'acquireVsCodeApi', { configurable: true, value: () => ({
		postMessage: (message: BashScriptsRequest) => messages.push(message), getState: () => panel,
		setState: (state: Record<string, unknown>) => { panel = state; },
	}) });
	const root = createRoot(document.body.appendChild(document.createElement('div')));
	t.after(async () => {
		await act(async () => root.unmount());
		Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
		Reflect.deleteProperty(globalThis, 'acquireVsCodeApi');
		await GlobalRegistrator.unregister();
	});
	const render = (collapsed = false) => act(async () => root.render(<BashScriptEditorHost><BashScriptsWidget collapsed={collapsed} onToggleCollapse={() => {}} expandedGroups={{}} onGroupChoicesChange={() => {}}
		bashScriptOrder={{}} bashScriptFavorites={{}} bashScriptHiddenFolders={{}}
		onOrderChange={() => {}} onFavoriteChange={() => {}} onFolderHiddenChange={() => {}}
		renderShell={(actions, body) => <section><header>{actions}</header>{body}</section>} /></BashScriptEditorHost>));
	const reply = (request: BashScriptsRequest, result: BashScriptsResult = {}, error?: string) => act(async () => {
		window.dispatchEvent(new MessageEvent('message', { data: { type: 'bashScriptsResponse', requestId: request.requestId, result, error } }));
	});
	const newest = (action: BashScriptsRequest['action']) => { const last = messages.at(-1)!; assert.equal(last.action, action); return last; };
	const click = (button: HTMLButtonElement) => act(async () => { assert.ok(button); button.click(); });
	const byLabel = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
	const byText = (label: string) => Array.from(document.querySelectorAll('button')).find(button => button.textContent === label)!;
	await render(true);
	assert.equal(messages.length, 0);
	await render();
	await reply(newest('list'), { entries: [project, globalEntry] });
	const play = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label="Запустить Сборка"]'));
	assert.equal(play.filter(button => button.disabled).length, 1);
	await click(play.find(button => !button.disabled)!);
	assert.deepEqual(newest('run').ref, { id: project.id, scope: 'project' });
	assert.equal(newest('run').path, project.absolutePath);
	await reply(newest('run'));
	await reply(newest('list'), { entries: [{ ...project, terminalRunIds: ['1', 'older'] }, globalEntry] });
	const projectRow = document.querySelector<HTMLButtonElement>('.pm-bs-play:not(:disabled)')!.closest('li')!;
	// Терминал показывается по самому новому запуску строки, а у записи без терминала кнопки нет.
	assert.equal(document.querySelectorAll('button[aria-label="Показать терминал Сборка"]').length, 1);
	await click(projectRow.querySelector('button[aria-label="Показать терминал Сборка"]')!);
	assert.deepEqual(newest('showTerminal').ref, { id: project.id, scope: 'project' });
	assert.equal(newest('showTerminal').runId, '1');
	await reply(newest('showTerminal'));
	assert.equal(document.querySelector('[role=alert]'), null);
	// Закрытие терминала приходит как изменение списка: кнопка исчезает без перезагрузки виджета.
	await act(async () => { window.dispatchEvent(new MessageEvent('message', { data: { type: 'bashScriptsChanged' } })); });
	await reply(newest('list'), { entries: [project, globalEntry] });
	assert.equal(document.querySelector('button[aria-label="Показать терминал Сборка"]'), null);
	await click(projectRow.querySelector('button[aria-label^="История"]')!);
	assert.match(projectRow.querySelector('[role=region]')!.textContent!, /Код 7/);
	await click(projectRow.querySelector('button[aria-label^="Редактировать"]')!);
	const initialName = document.querySelector<HTMLInputElement>('[name=bashScriptName]')!;
	assert.ok(document.activeElement === initialName && !initialName.readOnly, 'имя доступно сразу, пока идёт чтение');
	// Пути для копирования появляются вместе с прочитанным файлом и копируются через host.
	const copyRelative = () => byLabel('Копировать относительный путь');
	const copyAbsolute = () => byLabel('Копировать абсолютный путь');
	assert.ok(copyRelative().disabled && copyAbsolute().disabled, 'до чтения пути файла неизвестны');
	await reply(newest('read'), { path: project.path, content: 'echo one\r\n', revision: 'initial-revision',
		absolutePath: project.absolutePath, relativePath: 'scripts/build.sh' });
	assert.match(copyAbsolute().title, /\/workspace\/scripts\/build\.sh$/);
	await click(copyAbsolute());
	await reply(newest('copyPath'), {}, 'Буфер обмена недоступен.');
	assert.match(document.querySelector('.pm-bs-editor [role=alert]')!.textContent!, /Буфер обмена недоступен/);
	await click(copyRelative());
	const copyRequest = newest('copyPath');
	assert.deepEqual([copyRequest.scope, copyRequest.path, copyRequest.pathKind], ['project', project.path, 'relative']);
	await reply(copyRequest);
	assert.equal(document.querySelector('.pm-bs-editor [role=alert]'), null, 'успех снимает собственную ошибку копирования');
	assert.equal(copyRelative().title, 'Скопировано');
	assert.equal(document.querySelector('.pm-bs-sr-status')!.textContent, 'Путь скопирован');
	await editCode('echo draft\n');
	await click(byLabel('Закрыть редактор'));
	assert.ok(byText('Продолжить редактирование'));
	await click(byText('Продолжить редактирование'));
	await click(byText('Перечитать'));
	assert.ok(byText('Заменить текст'));
	await click(byText('Продолжить редактирование'));
	await act(async () => root.render(null));
	assert.ok(panel.bashScriptDraft);
	const previousReads = messages.filter(message => message.action === 'read').length;
	const outside = document.body.appendChild(document.createElement('input'));
	outside.focus();
	await render();
	assert.ok(document.activeElement === outside, 'восстановление черновика не забирает фокус из другого поля');
	outside.remove();
	assert.equal(code().state.doc.toString(), 'echo draft\n');
	assert.equal(messages.filter(message => message.action === 'read').length, previousReads);
	await click(byText('Сохранить'));
	const save = newest('save');
	assert.deepEqual(save.base, { name: project.name, path: project.path });
	assert.equal(save.revision, 'initial-revision');
	assert.equal(save.content, 'echo draft\r\n');
	await reply(save, {}, 'Файл изменился.');
	assert.match(document.querySelector('[role=alert]')!.textContent!, /Файл изменился/);
	assert.equal(code().state.doc.toString(), 'echo draft\n');
	await click(byText('Перечитать'));
	await click(byText('Заменить текст'));
	await reply(newest('read'), { path: project.path, content: 'echo external\n', revision: 'next' });
	assert.equal(code().state.doc.toString(), 'echo external\n');
	await click(byLabel('Закрыть редактор'));
	assert.equal(document.querySelector('[role=dialog]'), null);
	assert.deepEqual(panel, { unrelated: true });
	const beforeUnmount = () => act(async () => root.render(null));
	const change = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) =>
		act(async () => { element.value = value; Simulate.change(element); });
	const field = <T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(name: string) =>
		document.querySelector<T>(`[name="${name}"]`)!;
	const changed = () => act(async () => { window.dispatchEvent(new MessageEvent('message', { data: { type: 'bashScriptsChanged' } })); });
	await t.test('При раскрытии запрос нужен только после изменения, в том числе если старый ответ пришёл уже после сворачивания', async () => {
		await changed();
		await reply(newest('list'), { entries: [project] });
		const count = messages.length;
		await render(true);
		await render();
		assert.equal(messages.length, count);
		await changed();
		const old = newest('list');
		await render(true);
		await changed();
		await reply(old, { entries: [] });
		await render();
		const fresh = newest('list');
		assert.notEqual(fresh.requestId, old.requestId);
		assert.equal(document.querySelectorAll('.pm-bs-entry').length, 1);
		await reply(fresh, { entries: [project, globalEntry] });
		assert.equal(document.querySelectorAll('.pm-bs-entry').length, 2);
	});
	const saves = () => messages.filter(message => message.action === 'save');
	async function openNew(path: string) {
		await click(byLabel('Добавить Bash скрипт'));
		await change(field('bashScriptPath'), path);
		await click(byText('Загрузить'));
		await reply(newest('read'), { path, content: 'original', revision: 'file-revision', exists: true });
		await editCode('edited');
	}

	await t.test('Чтение, перемещение курсора и отмена правки оставляют исходный скрипт без изменений', async () => {
		const { undo } = await import('@codemirror/commands');
		await changed();
		await reply(newest('list'), { entries: [project] });
		const originalFiles = ['', '\uFEFF', 'echo text\n', 'echo text\r\n', 'echo text\r',
			'\uFEFF#!/bin/bash\r\necho one\recho two\n\n', '  echo\t"тест"  '];
		for (const content of originalFiles) {
			const row = document.querySelector('.pm-bs-row')!;
			await click(row.querySelector<HTMLButtonElement>('[aria-label^="Редактировать"]')!);
			await reply(newest('read'), { path: project.path, content, revision: 'baseline' });
			const view = code();
			await act(async () => view.dispatch({ selection: { anchor: view.state.doc.length } }));
			assert.equal(byText('Сохранить').disabled, true, JSON.stringify(content));
			await act(async () => view.dispatch({ changes: { from: 0, insert: 'echo edited\n' } }));
			assert.equal(byText('Сохранить').disabled, false);
			await click(byLabel('Закрыть редактор'));
			assert.ok(byText('Продолжить редактирование'));
			await click(byText('Продолжить редактирование'));
			await act(async () => { assert.ok(undo(view)); });
			assert.equal(byText('Сохранить').disabled, true, JSON.stringify(content));
			await click(byLabel('Закрыть редактор'));
			assert.equal(document.querySelector('.pm-bs-editor'), null);
			assert.deepEqual(panel, { unrelated: true });
		}
	});

	await t.test('Повторный выбор проектного файла сохраняет относительный путь и закрывается без подтверждения', async () => {
		const source = 'echo clean\r\n';
		await click(document.querySelector<HTMLButtonElement>('.pm-bs-row [aria-label^="Редактировать"]')!);
		await reply(newest('read'), { path: project.path, revision: 'before', content: source });
		await click(byLabel('Выбрать файл скрипта'));
		await reply(newest('choose'), { path: project.absolutePath });
		const read = newest('read');
		assert.equal(read.path, project.absolutePath);
		assert.deepEqual(read.base, { name: project.name, path: project.path });
		await reply(read, { path: project.path, revision: 'after', content: source + '# external change\r\n' });
		assert.equal(field('bashScriptPath').value, project.path);
		assert.equal(byText('Сохранить').disabled, true);
		await click(byLabel('Закрыть редактор'));
		assert.equal(document.querySelector('.pm-bs-editor'), null);

		await click(document.querySelector<HTMLButtonElement>('.pm-bs-row [aria-label^="Редактировать"]')!);
		await reply(newest('read'), { path: project.path, revision: 'before', content: source });
		await click(byLabel('Выбрать файл скрипта'));
		const different = '/other/build.sh';
		await reply(newest('choose'), { path: different });
		await reply(newest('read'), { path: different, revision: 'other', content: source });
		assert.equal(field('bashScriptPath').value, different);
		await click(byLabel('Закрыть редактор'));
		await click(byText('Закрыть без сохранения'));
	});

	await t.test('closing during a slow read restores the opener and ignores the response in the next editor', async () => {
		await changed();
		await reply(newest('list'), { entries: [project] });
		const opener = document.querySelector<HTMLButtonElement>('.pm-bs-row button[aria-label^="Редактировать"]')!;
		opener.focus();
		await click(opener);
		const pending = newest('read');
		const dialog = document.querySelector<HTMLElement>('.pm-bs-editor')!;
		assert.equal(byLabel('Закрыть редактор').disabled, false);
		await act(async () => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
		assert.equal(document.querySelector('.pm-bs-editor'), null);
		assert.equal(document.activeElement, opener);
		await click(byLabel('Добавить Bash скрипт'));
		await reply(pending, { path: 'stale.sh', content: 'old', revision: 'late' });
		assert.equal(field('bashScriptPath').value, '');
		assert.equal(document.querySelector('.pm-bs-code'), null);
		await click(byLabel('Закрыть редактор'));
	});
	await t.test('editing a Bash file preserves name focus, BOM, mixed endings and undo through Ctrl+S', async t => {
		// Браузер доставляет selectionchange после изменения выделения. Happy DOM вызывает его внутри Selection.collapse.
		const dispatch = document.dispatchEvent.bind(document);
		const deferred = new WeakSet<Event>();
		t.mock.method(document, 'dispatchEvent', (event: Event) => {
			if (event.type !== 'selectionchange' || deferred.has(event)) return dispatch(event);
			deferred.add(event);
			queueMicrotask(() => dispatch(event));
			return true;
		});
		const path = 'scripts/mixed.sh';
		const raw = '\uFEFF#!/bin/bash\r\necho one\recho two\n';
		await click(byLabel('Добавить Bash скрипт'));
		const name = field<HTMLInputElement>('bashScriptName');
		const pathField = field<HTMLInputElement>('bashScriptPath');
		await change(pathField, path);
		await click(byText('Загрузить'));
		name.focus();
		assert.equal(name.readOnly, false);
		assert.equal(pathField.readOnly, true);
		await change(name, 'Моё название');
		await reply(newest('read'), { path, content: raw, revision: 'mixed' });
		assert.ok(document.activeElement === name, 'после чтения фокус остаётся в имени');
		assert.equal(name.value, 'Моё название');
		const view = code();
		assert.equal(view.state.doc.lines, 4);
		assert.ok(view.dom.querySelector('.cm-lineNumbers'));
		assert.ok(view.dom.querySelector('.cm-activeLine'));
		assert.ok(view.contentDOM.querySelector('.pm-bs-code-command'), 'команды Bash получают подсветку');
		assert.match(document.querySelector('.pm-bs-code-status')!.textContent!, /UTF-8 BOM.*Смешанные/);
		const key = (target: HTMLElement, key: string, code: string, ctrlKey = false) => act(async () => {
			target.dispatchEvent(new KeyboardEvent('keydown', { key, code, ctrlKey, bubbles: true, cancelable: true }));
		});
		await act(async () => view.focus());
		await key(view.contentDOM, 'f', 'KeyF', true);
		const find = view.dom.querySelector<HTMLInputElement>('[name=search]')!;
		assert.ok(find && document.activeElement === find, 'Ctrl+F переводит фокус в поиск');
		await key(find, 'Escape', 'Escape');
		assert.ok(!view.dom.querySelector('[name=search]'), 'Escape закрывает поиск');
		assert.ok(document.querySelector('[role=dialog]'));
		await click(byLabel('Перейти к строке'));
		const go = view.dom.querySelector<HTMLInputElement>('.cm-goto-line input')!;
		assert.ok(go && document.activeElement === go, 'переход к строке фокусирует поле');
		await act(async () => { go.value = '3'; go.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
		assert.equal(view.state.selection.main.head, view.state.doc.line(3).from);
		const wrapButton = byLabel('Перенос длинных строк');
		assert.equal(view.contentDOM.classList.contains('cm-lineWrapping'), true);
		await click(wrapButton);
		assert.equal(view.contentDOM.classList.contains('cm-lineWrapping'), false);
		await click(wrapButton);
		await click(byLabel('Отступ клавишей Tab'));
		await key(view.contentDOM, 'Tab', 'Tab');
		assert.equal(view.state.doc.line(3).text, '\techo two');
		await key(view.contentDOM, 'Escape', 'Escape');
		assert.equal(byLabel('Отступ клавишей Tab').getAttribute('aria-pressed'), 'false');
		const { undo, redo, isolateHistory } = await import('@codemirror/commands');
		await act(async () => {
			view.dispatch({ changes: { from: view.state.doc.line(1).to, to: view.state.doc.line(3).from, insert: '' },
				annotations: isolateHistory.of('full') });
			assert.ok(undo(view));
			assert.ok(redo(view));
			assert.ok(undo(view));
		});
		await key(view.contentDOM, 's', 'KeyS', true);
		const save = newest('save');
		assert.equal(save.name, 'Моё название');
		assert.equal(save.content, raw.replace('echo two', '\techo two'));
		assert.equal(save.revision, 'mixed');
		await reply(save);
		assert.equal(document.querySelector('[role=dialog]'), null);
	});

	await t.test('opening a large or non-UTF-8 script delegates text editing to the native editor', async () => {
		for (const reason of ['Для этого файла требуется выбор кодировки в редакторе VS Code.', 'Файл больше 1 МиБ.']) {
			await click(byLabel('Добавить Bash скрипт'));
			await change(field('bashScriptPath'), 'scripts/legacy.sh');
			await click(byText('Загрузить'));
			await reply(newest('read'), { path: 'scripts/legacy.sh', content: '', revision: 'native:123', nativeEditorReason: reason });
			assert.ok(!document.querySelector('.pm-bs-code .cm-content'));
			assert.ok(document.querySelector('[role=dialog]')!.textContent!.includes(reason));
			await click(byText('Открыть файл в VS Code'));
			await reply(newest('openFile'));
			await click(byLabel('Закрыть редактор'));
			await click(byText('Закрыть без сохранения'));
		}
	});

	await t.test('scope changes preserve edited bytes and the revision for absolute and relative paths', async () => {
		for (const path of ['/shared/sample.sh', 'scripts/sample.sh']) {
			await openNew(path);
			const reads = messages.filter(message => message.action === 'read').length;
			await change(field('bashScriptScope'), 'global');
			assert.equal(code().state.readOnly, false);
			assert.equal(code().state.doc.toString(), 'edited');
			assert.equal(byText('Сохранить').disabled, false);
			assert.equal(messages.filter(message => message.action === 'read').length, reads);
			await click(byText('Сохранить'));
			const submitted = newest('save');
			assert.equal(submitted.scope, 'global');
			assert.equal(submitted.path, path);
			assert.equal(submitted.revision, 'file-revision');
			assert.equal(submitted.content, 'edited');
			// Ответ может прийти как до, так и после появления формы в новой колонке.
			await beforeUnmount();
			if (path.startsWith('/')) {
				await render();
				assert.equal(byText('Сохранить').disabled, true);
				assert.equal(code().state.readOnly, true);
				const count = saves().length;
				await click(byText('Сохранить'));
				assert.equal(saves().length, count);
				await reply(submitted);
			} else {
				await reply(submitted);
				await render();
			}
			assert.equal(document.querySelector('[role=dialog]'), null);
			assert.deepEqual(panel, { unrelated: true });
		}
	});

	await t.test('errors received between mounts preserve the draft and permit an explicit retry', async () => {
		await openNew('scripts/failure.sh');
		await click(byText('Сохранить'));
		const first = newest('save');
		await beforeUnmount();
		await reply(first, {}, 'Конфликт сохранения');
		await render();
		assert.match(document.querySelector('[role=dialog] [role=alert]')!.textContent!, /Конфликт сохранения/);
		assert.equal(code().state.doc.toString(), 'edited');
		assert.equal(byText('Сохранить').disabled, false);
		await editCode('updated');
		await click(byText('Сохранить'));
		const retry = newest('save');
		assert.notEqual(retry.requestId, first.requestId);
		await reply(first);
		assert.equal(code().state.doc.toString(), 'updated');
		assert.equal(byText('Сохранить').disabled, true);
		await reply(retry);
		assert.deepEqual(panel, { unrelated: true });
	});

	await t.test('expired save restores the editable draft; a late response cannot erase later changes', async () => {
		await openNew('scripts/timeout.sh');
		// Имитируем истёкшее ожидание после восстановления webview без исходного JS-контекста.
		await beforeUnmount();
		const body = panel.bashScriptDraft as Record<string, unknown>;
		panel.bashScriptDraft = { ...body, pendingSave: { id: 'from-previous-webview', deadline: Date.now() - 1 } };
		const count = saves().length;
		await render();
		await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
		assert.match(document.querySelector('[role=dialog] [role=alert]')!.textContent!, /не ответило/);
		assert.equal(saves().length, count);
		assert.equal(byText('Сохранить').disabled, false);
		await editCode('new edits after timeout');
		await reply({ ...saves().at(-1)!, requestId: 'from-previous-webview' });
		assert.equal(code().state.doc.toString(), 'new edits after timeout');
		await click(byText('Сохранить'));
		await reply(newest('save'));
		assert.deepEqual(panel, { unrelated: true });
	});

	await t.test('a late acknowledgement leaves a different draft in panel storage intact', async () => {
		await openNew('scripts/first.sh');
		await click(byText('Сохранить'));
		const first = newest('save');
		await beforeUnmount();
		const nextDraft = { scope: 'project', name: 'Новый', path: 'scripts/next.sh', content: 'changed',
			file: { path: 'scripts/next.sh', revision: 'next-file', original: 'old' } };
		panel.bashScriptDraft = nextDraft;
		await reply(first);
		assert.equal(panel.bashScriptDraft, nextDraft);
		await render();
		assert.equal(code().state.doc.toString(), 'changed');
		await click(byLabel('Закрыть редактор'));
		await click(byText('Закрыть без сохранения'));
	});

	await t.test('hide uses the path shown when confirmation opened, including after a list refresh', async () => {
		await changed();
		await reply(newest('list'), { entries: [project] });
		await click(byLabel('Убрать Сборка из виджета'));
		const moved = { ...project, path: 'scripts/moved.sh', absolutePath: '/workspace/scripts/moved.sh' };
		await changed();
		await reply(newest('list'), { entries: [moved] });
		const confirmation = document.querySelector('[aria-label="Подтверждение скрытия скрипта"]')!;
		assert.match(confirmation.textContent!, /scripts\/build\.sh/);
		await click(byText('Убрать'));
		const request = newest('hide');
		assert.deepEqual(request.ref, { scope: project.scope, id: project.id });
		assert.equal(request.path, project.absolutePath);
		await reply(request, {}, 'Путь скрипта изменился.');
		assert.equal(document.querySelector('[aria-label="Подтверждение скрытия скрипта"]'), null);
		await click(byLabel('Убрать Сборка из виджета'));
		await click(byText('Убрать'));
		assert.equal(newest('hide').path, moved.absolutePath);
		await reply(newest('hide'));
	});

	await t.test('a failed run and refreshed availability disable further launches', async () => {
		await changed();
		await reply(newest('list'), { entries: [project] });
		await click(byLabel('Запустить Сборка'));
		const run = newest('run');
		await changed();
		await reply(newest('list'), { entries: [{ ...project, available: false }] });
		await reply(run, {}, 'Файл Bash-скрипта недоступен.');
		assert.equal(document.querySelector('.pm-bs-availability')!.textContent, 'Недоступен');
		assert.equal(byLabel('Запустить Сборка').disabled, true);
		const attempts = messages.filter(message => message.action === 'run').length;
		await click(byLabel('Запустить Сборка'));
		assert.equal(messages.filter(message => message.action === 'run').length, attempts);
	});
});
