import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
	EditorSectionDragHandle,
	SortableEditorSections,
	findEditorSectionsScrollContainer,
	reorderEditorSections,
	resolveEditorSectionDropTarget,
} from '../src/webview/editor/components/SortableEditorSections.js';
import { isDragPointer, subscribeDragPointerEvents } from '../src/webview/shared/dragPointer.js';

/** Скрытые условием разделы сохраняются при переносе видимого раздела. */
test('reorderEditorSections preserves hidden keys and relative order of unaffected sections', () => {
	const order = ['main', 'hidden', 'time', 'environment'];
	assert.deepEqual(reorderEditorSections(order, 'environment', { sectionKey: 'main', placement: 'before' }),
		['environment', 'main', 'hidden', 'time']);
	assert.deepEqual(reorderEditorSections(order, 'main', { sectionKey: 'time', placement: 'after' }),
		['hidden', 'time', 'main', 'environment']);
	assert.deepEqual(order, ['main', 'hidden', 'time', 'environment']);
	assert.deepEqual(reorderEditorSections(order, 'unknown', { sectionKey: 'main', placement: 'before' }), order);
	assert.deepEqual(reorderEditorSections(order, 'main', { sectionKey: 'unknown', placement: 'before' }), order);
	assert.deepEqual(reorderEditorSections(order, 'main', { sectionKey: 'main', placement: 'after' }), order);
});

/** Геометрия использует соседние разделы и середины вместо CSS-порядка или индексов скрытых элементов. */
test('resolveEditorSectionDropTarget supports gaps, both placements and excludes the source', () => {
	const bounds = [
		{ sectionKey: 'time', top: 200, bottom: 300 },
		{ sectionKey: 'main', top: 0, bottom: 100 },
		{ sectionKey: 'environment', top: 400, bottom: 500 },
	];
	assert.deepEqual(resolveEditorSectionDropTarget(120, bounds, 'time'),
		{ sectionKey: 'environment', placement: 'before' });
	assert.deepEqual(resolveEditorSectionDropTarget(-10, bounds, 'time'),
		{ sectionKey: 'main', placement: 'before' });
	assert.deepEqual(resolveEditorSectionDropTarget(600, bounds, 'time'),
		{ sectionKey: 'environment', placement: 'after' });
	assert.equal(resolveEditorSectionDropTarget(200, [bounds[0]], 'time'), null);
});

/** Проверяет фактическую последовательность HTML и доступность ручки в отключённой форме. */
test('SortableEditorSections renders actual ordered DOM and ignores hidden children', () => {
	const markup = renderToStaticMarkup(
		<SortableEditorSections order={['time', 'hidden', 'main']} scopeKey="prompt:main" disabled
			onReorder={() => assert.fail('Rendering must not save the order')}>
			<section key="main" data-pm-editor-section="main">
				<EditorSectionDragHandle sectionKey="main" title="Основное" /><input defaultValue="Draft" />
			</section>
			{false}
			<section key="time" data-pm-editor-section="time">Учет времени</section>
			<section key="new" data-pm-editor-section="new">Новый раздел</section>
		</SortableEditorSections>,
	);
	assert.ok(markup.indexOf('data-pm-sortable-section="time"') < markup.indexOf('data-pm-sortable-section="main"'));
	assert.ok(markup.indexOf('data-pm-sortable-section="main"') < markup.indexOf('data-pm-sortable-section="new"'));
	assert.doesNotMatch(markup, /data-pm-sortable-section="hidden"/);
	assert.match(markup, /aria-label="Перетащить раздел: Основное"/);
	assert.match(markup, /<svg[^>]*viewBox="0 0 16 16"/);
	assert.doesNotMatch(markup, /codicon-gripper/);
	assert.match(markup, /aria-keyshortcuts="ArrowUp ArrowDown Home End Escape"/);
	assert.match(markup, /disabled=""/);
	assert.match(markup, /value="Draft"/);
});

/** Минимальная геометрия задаёт реальный переполняемый предок без браузера и внешних ресурсов. */
test('findEditorSectionsScrollContainer uses scrollable ancestors and document fallback', () => {
	const documentElement = {};
	const ownerDocument = {
		documentElement,
		scrollingElement: documentElement,
		defaultView: { getComputedStyle: (node: { overflow: string }) => ({ overflowY: node.overflow }) },
	};
	const stacked = { ownerDocument, parentElement: null, overflow: 'auto', clientHeight: 600, scrollHeight: 1800 };
	const column = { ownerDocument, parentElement: stacked, overflow: 'visible', clientHeight: 900, scrollHeight: 900 };
	const element = { ownerDocument, parentElement: column, overflow: 'visible', clientHeight: 900, scrollHeight: 900 };
	assert.equal(findEditorSectionsScrollContainer(element as unknown as HTMLElement), stacked);
	stacked.scrollHeight = stacked.clientHeight;
	assert.equal(findEditorSectionsScrollContainer(element as unknown as HTMLElement), documentElement);
	column.overflow = 'auto';
	column.scrollHeight = 1900;
	assert.equal(findEditorSectionsScrollContainer(element as unknown as HTMLElement), column);
});

/** Эмулирует свойства pointer-событий средствами Node без глобального DOM. */
function dispatch(target: EventTarget, type: string, fields: PointerEventInit): void {
	target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), fields));
}

/** Общий helper сохраняет поддержку смешанного ввода и освобождает все подписки после завершения. */
test('shared drag pointer supports mixed mouse movement and cleanup', () => {
	const target = new EventTarget();
	const calls: string[] = [];
	const stop = subscribeDragPointerEvents(target, { pointerId: 1, pointerType: 'mouse' }, {
		move: () => calls.push('move'), finish: () => { calls.push('finish'); stop(); }, cancel: () => stop(),
	});
	dispatch(target, 'pointermove', { pointerId: 2, pointerType: 'pen', isPrimary: true });
	dispatch(target, 'mousemove', { buttons: 1 });
	dispatch(target, 'pointermove', { pointerId: 9, pointerType: 'mouse', isPrimary: true });
	dispatch(target, 'mousemove', { buttons: 1 });
	dispatch(target, 'pointerup', { pointerId: 9, pointerType: 'mouse', isPrimary: true });
	dispatch(target, 'mousemove', { buttons: 1 });
	assert.deepEqual(calls, ['move', 'move', 'finish']);
	for (const pointerType of ['touch', 'pen']) {
		assert.equal(isDragPointer({ pointerId: 1, pointerType }, { pointerId: 2, pointerType, isPrimary: true }), false);
		assert.equal(isDragPointer({ pointerId: 1, pointerType }, { pointerId: 1, pointerType, isPrimary: true }), true);
	}
});
