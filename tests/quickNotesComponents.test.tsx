import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DashboardQuickNotesWidgetState } from '../src/types/promptDashboardPreferences.js';
import type { QuickNoteScope, QuickNotesState, QuickNoteView } from '../src/types/quickNotes.js';
import { QuickNoteModal, parseQuickNoteDroppedUris, type QuickNoteModalClient } from '../src/webview/editor/components/quickNotes/QuickNoteModal.js';
import { QuickNotesBoard, splitQuickNoteBoardInput } from '../src/webview/editor/components/quickNotes/QuickNotesBoard.js';
import {
	buildQuickNoteExpandedKey,
	QuickNotesWidget,
	resolveQuickNoteListMove,
	type QuickNotesWidgetProps,
} from '../src/webview/editor/components/quickNotes/QuickNotesWidget.js';
import { resolveEffectiveQuickNotesState } from '../src/webview/editor/components/quickNotes/useQuickNotesClient.js';
import { QuickNotesBoardApp } from '../src/webview/quickNotes/QuickNotesBoardApp.js';

/** Заметка с заполненными обязательными полями. */
function note(id: string, patch: Partial<QuickNoteView> = {}, scope: QuickNoteScope = 'workspace'): QuickNoteView {
	return {
		id, title: `Заметка ${id}`, description: '', color: '', done: false, order: 0, items: [], files: [],
		createdAt: '2026-11-18T08:00:00.000Z', updatedAt: '2026-11-18T08:00:00.000Z', scope, ...patch,
	};
}

/** Состояние обеих областей с заметками. */
function createState(notes: QuickNoteView[], patch: Partial<QuickNotesState['scopes']> = {}): QuickNotesState {
	return {
		scopes: {
			workspace: { scope: 'workspace', available: true, filePath: '/ws/.vscode/prompt-manager/quick-notes.json' },
			global: { scope: 'global', available: true, filePath: '/home/u/.vscode/prompt-manager/quick-notes.json' },
			...patch,
		},
		notes,
	};
}

/** Вид заметок по умолчанию. */
const preferences: DashboardQuickNotesWidgetState = {
	newNoteScope: 'workspace', search: '', colors: [], boardGroupBy: 'none', boardScope: 'all', boardShowDone: false,
};

/** Отрисовывает виджет с заглушками действий. */
function renderWidget(props: Partial<QuickNotesWidgetProps>): string {
	const noop = () => undefined;
	return renderToStaticMarkup(
		<QuickNotesWidget
			state={null}
			preferences={preferences}
			expanded={{}}
			newNoteIds={new Set()}
			onAdd={() => false}
			onPreferencesChange={noop}
			onToggleExpanded={noop}
			onToggleDone={noop}
			onToggleItem={noop}
			onOpen={noop}
			onOpenPrompt={noop}
			onReorder={noop}
			onClearDone={noop}
			onOpenStorageFile={noop}
			onReload={noop}
			{...props}
		/>,
	);
}

/** Клиент окна без обращения к расширению. */
const modalClient: QuickNoteModalClient = {
	apply: async () => ({ ok: true }),
	attach: async () => ({ files: [], previewUris: {}, skipped: [] }),
	attachLocalFiles: async () => ({ files: [], previewUris: {}, skipped: [] }),
	removeDraftFile: async () => ({ ok: true }),
	setDescriptionHeight: () => undefined,
	discardDraft: () => undefined,
	openFile: () => undefined,
	createPrompt: async () => ({ ok: true }),
	openPrompt: () => undefined,
	suggest: async () => ({ text: '' }),
};

/** До ответа расширения виджет показывает загрузку, без заметок — подсказку о первом добавлении. */
test('QuickNotesWidget renders loading and first-note hint states', () => {
	assert.match(renderWidget({ state: null }), /Загружаем заметки/);
	const empty = renderWidget({ state: createState([]) });
	assert.match(empty, /placeholder="Новая заметка…"/);
	assert.match(empty, /Запишите заметку и нажмите/);
	assert.match(empty, /\.vscode\/prompt-manager/);
	assert.doesNotMatch(empty, /Поиск заметок/);
});

/** Строки показывают область, прогресс, описание, файлы, промпт и блок выполненных. */
test('QuickNotesWidget renders compact rows with metadata and done block', () => {
	const markup = renderWidget({
		state: createState([
			note('a', {
				title: 'Проверить кеш', color: 'red', description: 'Подробности',
				items: [{ id: 'i1', text: 'Найти', done: true }, { id: 'i2', text: 'Исправить', done: false }],
				files: [{ id: 'f', name: 'a.png', storedName: 'a.png', size: 1, addedAt: '' }],
				prompt: { id: 'p', promptUuid: 'u' },
			}),
			note('b', { order: 5 }, 'global'),
			note('c', { done: true, completedAt: '2026-11-18T09:00:00.000Z' }),
		]),
		expanded: { [buildQuickNoteExpandedKey({ scope: 'workspace', id: 'a' })]: true },
		newNoteIds: new Set(['b']),
	});
	assert.match(markup, /Проверить кеш/);
	assert.match(markup, /aria-label="Чек-лист: 1 из 2"/);
	assert.match(markup, /aria-expanded="true"/);
	assert.match(markup, /Исправить/);
	assert.match(markup, /title="Есть описание"/);
	assert.match(markup, /title="Глобальная"/);
	assert.match(markup, /aria-label="Открыть связанный промпт"/);
	assert.match(markup, /Выполнено \(1\)/);
	assert.match(markup, /aria-label="Фильтр: Красный"/);
	assert.match(markup, /pm-qn-row is-new/);
	assert.match(markup, /--pm-qn-note:var\(--vscode-charts-red\)/);
	assert.match(markup, /aria-label="Перетащить заметку: Проверить кеш"/);
});

/** Без папки новая заметка сохраняется глобально; ошибка файла показывает действия восстановления. */
test('QuickNotesWidget handles unavailable workspace, damaged file and empty filter result', () => {
	const markup = renderWidget({
		state: createState([note('a', { title: 'Глобальная заметка' }, 'global')], {
			workspace: { scope: 'workspace', available: false, filePath: '' },
			global: { scope: 'global', available: true, filePath: '/g.json', error: 'Файл quick-notes.json повреждён: JSON' },
		}),
		preferences: { ...preferences, search: 'нет такой' },
		error: 'Расширение не ответило. Изменение не сохранено.',
		onDismissError: () => undefined,
	});
	assert.match(markup, /Расширение не ответило\. Изменение не сохранено\.<\/span><button[^>]*aria-label="Скрыть сообщение"/);
	assert.match(markup, /aria-label="Область новой заметки: Глобальная"/);
	assert.match(markup, /disabled=""[^>]*title="Откройте папку/);
	assert.match(markup, /Файл quick-notes\.json повреждён/);
	assert.match(markup, /Открыть файл/);
	assert.match(markup, /Ничего не найдено/);
});

/** Перенос в списке определяется по перемещённому элементу и его новому соседу. */
test('resolveQuickNoteListMove finds the moved note and its anchor', () => {
	assert.deepEqual(resolveQuickNoteListMove(['a', 'b', 'c'], ['c', 'a', 'b']), { movingId: 'c', anchorId: 'a', placement: 'before' });
	assert.deepEqual(resolveQuickNoteListMove(['a', 'b', 'c'], ['b', 'c', 'a']), { movingId: 'a', anchorId: 'c', placement: 'after' });
	assert.equal(resolveQuickNoteListMove(['a', 'b'], ['a', 'b']), null);
});

/** Окно — доступный диалог с черновиком, чек-листом, AI-кнопкой, плиткой «+» и неактивным сохранением без правок. */
test('QuickNoteModal renders the single-column draft dialog', () => {
	const markup = renderToStaticMarkup(
		<QuickNoteModal
			note={note('a', {
				title: 'Проверить кеш', color: 'blue', description: 'Описание заметки',
				items: [{ id: 'i1', text: 'Найти', done: true }, { id: 'i2', text: 'Исправить', done: false }],
			})}
			navigationIds={['a', 'b']}
			workspaceAvailable
			client={modalClient}
			onNavigate={() => undefined}
			onClose={() => undefined}
		/>,
	);
	assert.match(markup, /role="dialog"/);
	assert.match(markup, /aria-modal="true"/);
	assert.match(markup, /Быстрая заметка · Проект/);
	assert.match(markup, /1 из 2/);
	assert.match(markup, /value="Проверить кеш"/);
	assert.match(markup, />Описание</);
	assert.match(markup, /Описание заметки/);
	assert.equal((markup.match(/class="pm-qn-swatch[^"]*" aria-pressed=/g) || []).length, 9);
	assert.doesNotMatch(markup, /role="radio"/);
	assert.match(markup, /aria-pressed="true" title="Синий"/);
	assert.match(markup, /type="color" aria-label="Свой цвет"/);
	assert.match(markup, /role="dialog"[^>]*tabindex="-1"/);
	assert.match(markup, /1\/2/);
	assert.match(markup, /Добавить предложение AI/);
	assert.match(markup, /aria-haspopup="menu"/);
	assert.match(markup, />В промпт</);
	assert.match(markup, /class="pm-qn-btn is-primary" disabled="">Сохранить/);
});

/** Удалённая в другом окне заметка показывает предупреждение и блокирует сохранение. */
test('QuickNoteModal shows missing note banner', () => {
	const markup = renderToStaticMarkup(
		<QuickNoteModal note={note('a', { prompt: { id: 'p', promptUuid: 'u' } })} missing navigationIds={[]} workspaceAvailable={false}
			client={modalClient} onNavigate={() => undefined} onClose={() => undefined} />,
	);
	assert.match(markup, /удалена или перенесена в другом окне/);
	assert.match(markup, /Открыть промпт/);
	assert.match(markup, /disabled="" title="Откройте папку/);
});

/** Доска: шапка с фильтрами, плитка добавления и стикеры; при группировке — колонки групп. */
test('QuickNotesBoard renders the grid and grouped columns', () => {
	const state = createState([
		note('a', { title: 'Красная', color: 'red', items: [1, 2, 3, 4, 5].map(index => ({ id: `i${index}`, text: `П${index}`, done: index === 1 })) }),
		note('b', { title: 'Без цвета', order: 3 }, 'global'),
		note('c', { title: 'Готово', done: true, completedAt: 'T' }),
	]);
	const noop = () => undefined;
	const grid = renderToStaticMarkup(
		<QuickNotesBoard state={state} preferences={preferences} newNoteIds={new Set()} onPreferencesChange={noop} onCreate={() => false}
			onApply={noop} onToggleDone={noop} onToggleItem={noop} onSetColor={noop} onOpen={noop} error="Диск заполнен" onDismissError={noop} />,
	);
	// Доска — содержимое отдельной страницы: основная область без диалога и кнопки закрытия.
	assert.match(grid, /<main class="pm-qn-board pm-qn-scope" aria-label="Доска быстрых заметок" tabindex="-1">/);
	assert.doesNotMatch(grid, /role="dialog"|aria-modal|Закрыть доску|Esc — закрыть/);
	assert.match(grid, /role="alert"><svg[^]*Диск заполнен/);
	assert.match(grid, /aria-pressed="true">Все</);
	assert.match(grid, /2 открытых · 1 выполнено/);
	assert.match(grid, /Новая заметка/);
	assert.equal((grid.match(/data-qn-sticky=/g) || []).length, 2);
	assert.match(grid, /ещё 1/);
	assert.match(grid, /class="pm-qn-sticky is-plain"/);
	const grouped = renderToStaticMarkup(
		<QuickNotesBoard state={state} preferences={{ ...preferences, boardGroupBy: 'color', boardShowDone: true }} newNoteIds={new Set()}
			onPreferencesChange={noop} onCreate={() => false} onApply={noop} onToggleDone={noop} onToggleItem={noop} onSetColor={noop}
			onOpen={noop} />,
	);
	assert.match(grouped, /data-qn-group="red"/);
	assert.match(grouped, /data-qn-group="none"/);
	assert.match(grouped, /aria-label="Новая заметка: Красный"/);
	assert.equal((grouped.match(/data-qn-sticky=/g) || []).length, 3);
});

/** Страница доски до ответа расширения показывает загрузку и подключает стили заметок. */
test('QuickNotesBoardApp renders loading state before host data', () => {
	const markup = renderToStaticMarkup(<QuickNotesBoardApp />);
	assert.match(markup, /<style>[^<]*\.pm-qn-board/);
	assert.match(markup, /role="status"[^]*Загружаем заметки/);
});

/** Ввод стикера и перетащенные URI разбираются без пустых строк и комментариев. */
test('board input and dropped URI helpers parse user input', () => {
	assert.deepEqual(splitQuickNoteBoardInput(' Название \nстрока 1\nстрока 2 '), { title: 'Название', description: 'строка 1\nстрока 2' });
	assert.deepEqual(splitQuickNoteBoardInput(''), { title: '', description: '' });
	const longFirstLine = 'Длинная первая строка с описанием задачи, которую нужно сохранить полностью, потому что здесь находится основная информация о проблеме и ожидаемом результате.';
	const prepared = splitQuickNoteBoardInput(longFirstLine + '\nПодробности ниже.');
	assert.equal(prepared.description, longFirstLine + '\nПодробности ниже.');
	assert.equal(prepared.autoTitle, true);
	assert.ok(prepared.title.length < 80);
	assert.deepEqual(parseQuickNoteDroppedUris('# comment\r\nfile:///a.txt\n\n file:///b.png '), ['file:///a.txt', 'file:///b.png']);
});

/** Неподтверждённые операции переигрываются поверх состояния расширения. */
test('resolveEffectiveQuickNotesState replays pending operations over host state', () => {
	const host = createState([note('a')]);
	assert.equal(resolveEffectiveQuickNotesState(null, []), null);
	assert.equal(resolveEffectiveQuickNotesState(host, []), host);
	const effective = resolveEffectiveQuickNotesState(host, [
		{ operation: { kind: 'update', scope: 'workspace', id: 'a', patch: { done: true }, at: 'T' } },
		{ operation: { kind: 'create', scope: 'global', note: note('b') } },
	]);
	assert.deepEqual(effective?.notes.map(entry => [entry.id, entry.done, entry.scope]), [['b', false, 'global'], ['a', true, 'workspace']]);
});


/** AI title progress is visible at the trailing edge of the title field only while generating. */
test('QuickNoteModal renders local browser file picker and active title spinner', () => {
	const a = renderToStaticMarkup(
		<QuickNoteModal note={note('loading-title')} navigationIds={['loading-title']}
			workspaceAvailable client={modalClient} titleGenerating
			onNavigate={() => undefined} onClose={() => undefined} />,
	);
	assert.match(a, /aria-label="Генерируем название"/);
	assert.match(a, /class="pm-qn-title-spinner"/);
	assert.match(a, /type="file" multiple=""/);
	assert.match(a, /aria-label="Выбрать файлы с этого компьютера"/);
	const b = renderToStaticMarkup(
		<QuickNoteModal note={note('ready-title')} navigationIds={['ready-title']}
			workspaceAvailable client={modalClient} titleGenerating={false}
			onNavigate={() => undefined} onClose={() => undefined} />,
	);
	assert.doesNotMatch(b, /aria-label="Генерируем название"/);
});


/** Grid is row-major for deterministic drag positions, with an editor-wide drag preview and no text selection. */
test('QuickNotesBoard uses a row-major grid with predictable drop placement', async () => {
	const { resolveQuickNoteDropPlacement } = await import('../src/webview/editor/components/quickNotes/QuickNotesBoard.js');
	assert.equal(resolveQuickNoteDropPlacement({ left: 0, top: 0, width: 100, height: 200 }, 20, 170, 'none'), 'before');
	assert.equal(resolveQuickNoteDropPlacement({ left: 0, top: 0, width: 100, height: 200 }, 70, 30, 'none'), 'after');
	assert.equal(resolveQuickNoteDropPlacement({ left: 0, top: 0, width: 100, height: 200 }, 70, 30, 'scope'), 'before');
	assert.equal(resolveQuickNoteDropPlacement({ left: 0, top: 0, width: 100, height: 200 }, 20, 170, 'scope'), 'after');
	const render = renderToStaticMarkup(
		<QuickNotesBoard state={createState([note('one'), note('two')])} preferences={preferences}
			newNoteIds={new Set()} onPreferencesChange={() => undefined} onCreate={() => false}
			onApply={() => undefined} onToggleDone={() => undefined} onToggleItem={() => undefined}
			onSetColor={() => undefined} onOpen={() => undefined} />,
	);
	assert.match(render, /class="pm-qn-masonry" style="grid-template-columns:/);
	assert.equal((render.match(/data-qn-sticky=/g) || []).length, 2);
});

/** Saved global textarea height appears on every note without changing note content. */
test('QuickNoteModal uses the global description height', () => {
	const html = renderToStaticMarkup(
		<QuickNoteModal note={note('height')} navigationIds={['height']} workspaceAvailable
			client={{ ...modalClient, descriptionHeight: 312 }} onNavigate={() => undefined} onClose={() => undefined} />,
	);
	assert.match(html, /height:312px/);
});
