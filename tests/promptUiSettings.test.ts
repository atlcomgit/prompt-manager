import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePromptEditorLayout, type PromptUiSettingsSnapshot } from '../src/types/promptEditorLayout.js';
import { normalizePromptDashboardLayouts } from '../src/types/promptDashboard.js';
import { normalizePromptDashboardPreferences } from '../src/types/promptDashboardPreferences.js';
import {
	appendPendingPromptUiEdit, planPromptEditorSplitRatioSave, rejectPendingPromptUiEdit, rebasePromptUiSettings,
	resolvePromptEditorSplitRatioSave, type PendingPromptUiEdit,
} from '../src/utils/promptUiSettings.js';
import { applyUiSettingsChanges } from '../src/utils/uiSettingsPatch.js';

/** Изолированный снимок не обращается к VS Code, файлам, БД и внешним сервисам. */
function snapshot(): PromptUiSettingsSnapshot {
	return {
		editorLayout: normalizePromptEditorLayout(),
		dashboardLayouts: normalizePromptDashboardLayouts(),
		dashboardPreferences: normalizePromptDashboardPreferences(undefined),
	};
}

/** Поздний host update сохраняет ожидающую локальную перестановку и доставляет независимые изменения. */
test('UI settings rebase keeps pending order and accepts external preferences', () => {
	const base = snapshot();
	const next = structuredClone(base);
	next.editorLayout.main.reverse();
	const external = structuredClone(base);
	external.dashboardPreferences!.todos.search = 'external';
	const result = rebasePromptUiSettings(external, [{ area: 'editor', requestId: 'one', base, next }]);
	assert.deepEqual(result.editorLayout.main, next.editorLayout.main);
	assert.equal(result.dashboardPreferences!.todos.search, 'external');
	assert.deepEqual(base, snapshot());
});

/** Ошибка не отменяет видимый выбор; независимое сворачивание другого профиля приходит из host. */
test('UI settings rebase retains failed flags without discarding external fields', () => {
	const base = snapshot();
	const next = structuredClone(base);
	next.dashboardLayouts['single-column'].collapsedSections = { activity: true };
	const external = structuredClone(base);
	external.dashboardLayouts['two-columns'].collapsedSections = { todos: true };
	const result = rebasePromptUiSettings(external,
		[{ area: 'collapse:single-column', requestId: 'failed', base, next, failed: true }]);
	assert.deepEqual(result.dashboardLayouts['single-column'].collapsedSections, { activity: true });
	assert.deepEqual(result.dashboardLayouts['two-columns'].collapsedSections, { todos: true });
});

/** Раскрытие удаляет только собственный старый флаг, не заменяя карту сворачивания другим окном. */
test('UI settings patch preserves concurrent flags when clearing one flag', () => {
	assert.deepEqual(applyUiSettingsChanges({ activity: true, todos: true }, {}, { activity: true }), { todos: true });
	assert.deepEqual(applyUiSettingsChanges({ node: true, other: true }, { node: false }, { node: true }),
		{ node: false, other: true });
});

/** После подтверждения локальная правка больше не перекрывает новые настройки. */
test('UI settings accepts authoritative empty values after edits are acknowledged', () => {
	const confirmed = snapshot();
	confirmed.dashboardLayouts['two-columns'].collapsedSections = {};
	confirmed.dashboardPreferences!.showAllBranchProjects = false;
	assert.deepEqual(rebasePromptUiSettings(confirmed, []), confirmed);
});

/** Успешный новый ввод не откатывается к старому, чей отказ пришёл после второго пользовательского действия. */
test('UI settings late failure cannot overwrite a newer acknowledged value', () => {
	const base = snapshot();
	const first = structuredClone(base);
	first.dashboardPreferences!.todos.search = 'a';
	let edits = appendPendingPromptUiEdit([], { requestId: 'A', area: 'preferences', base, next: first });
	const second = structuredClone(first);
	second.dashboardPreferences!.todos.search = 'ab';
	edits = appendPendingPromptUiEdit(edits, { requestId: 'B', area: 'preferences', base: first, next: second });
	const acknowledgedBeforeError = edits.filter(edit => edit.requestId !== 'B');
	assert.equal(rebasePromptUiSettings(second, acknowledgedBeforeError).dashboardPreferences!.todos.search, 'ab');
	assert.deepEqual(rejectPendingPromptUiEdit(acknowledgedBeforeError, 'A'), []);
	edits = rejectPendingPromptUiEdit(edits, 'A');
	assert.equal(rebasePromptUiSettings(base, edits).dashboardPreferences!.todos.search, 'ab');
	edits = edits.filter(edit => edit.requestId !== 'B');
	assert.equal(rebasePromptUiSettings(second, edits).dashboardPreferences!.todos.search, 'ab');
	const external = structuredClone(second);
	external.dashboardPreferences!.todos.search = 'another window';
	assert.equal(rebasePromptUiSettings(external, edits).dashboardPreferences!.todos.search, 'another window');
});

/** Независимое ошибочное поле сохраняется и при новом действии той же области, и после его подтверждения. */
test('UI settings supersedes fields without discarding independent failures in the same area', () => {
	const base = snapshot();
	const first = structuredClone(base);
	first.dashboardPreferences!.todos.search = 'unsaved todo';
	first.dashboardPreferences!.docker.search = 'old docker';
	let edits = appendPendingPromptUiEdit([], {
		requestId: 'A', area: 'preferences', base, next: first, failed: true,
	});
	const second = structuredClone(first);
	second.dashboardPreferences!.docker.search = 'new docker';
	edits = appendPendingPromptUiEdit(edits, { requestId: 'B', area: 'preferences', base: first, next: second });
	edits = edits.filter(edit => edit.requestId !== 'B');
	const confirmed = structuredClone(base);
	confirmed.dashboardPreferences!.docker.search = 'new docker';
	const visible = rebasePromptUiSettings(confirmed, edits);
	assert.equal(visible.dashboardPreferences!.todos.search, 'unsaved todo');
	assert.equal(visible.dashboardPreferences!.docker.search, 'new docker');
	assert.equal(edits[0].failed, true);
});

/** Удаление, false и массивы считаются новыми намерениями, даже при возврате к исходному значению. */
test('UI settings supersession preserves deletions, false and atomic arrays after acknowledgement', () => {
	const base = snapshot();
	const first = structuredClone(base);
	first.dashboardPreferences!.showAllBranchProjects = true;
	first.dashboardPreferences!.expanded = { 'repo.with.dots': true, independent: true };
	first.editorLayout.main.reverse();
	const firstEdit: PendingPromptUiEdit = { requestId: 'A', area: 'editor', base, next: first };
	const second = structuredClone(first);
	second.dashboardPreferences!.showAllBranchProjects = false;
	delete second.dashboardPreferences!.expanded['repo.with.dots'];
	second.editorLayout.main = [...base.editorLayout.main];
	let edits = appendPendingPromptUiEdit([firstEdit], {
		requestId: 'B', area: 'editor', base: first, next: second,
	});
	edits = rejectPendingPromptUiEdit(edits, 'A');
	edits = edits.filter(edit => edit.requestId !== 'B');
	const visible = rebasePromptUiSettings(base, edits);
	assert.equal(visible.dashboardPreferences!.showAllBranchProjects, false);
	assert.deepEqual(visible.dashboardPreferences!.expanded, { independent: true });
	assert.deepEqual(visible.editorLayout.main, base.editorLayout.main);
	assert.equal(firstEdit.supersededPaths, undefined);
});

/** Пересечение целого объекта и вложенного поля не возвращает независимые неудачно сохранённые значения. */
test('UI settings restores newer fields when an older patch adds or removes their parent', () => {
	const base = snapshot();
	base.editorLayout.mainExpandedSections = { basic: true, status: true };
	const first = structuredClone(base);
	delete first.editorLayout.mainExpandedSections;
	const second = structuredClone(first);
	second.editorLayout.mainExpandedSections = { basic: false };
	const edits = appendPendingPromptUiEdit([
		{ requestId: 'A', area: 'editor', base, next: first, failed: true },
	], { requestId: 'B', area: 'editor', base: first, next: second });
	const afterAcknowledgement = edits.filter(edit => edit.requestId !== 'B');
	assert.deepEqual(rebasePromptUiSettings(second, afterAcknowledgement).editorLayout.mainExpandedSections,
		{ basic: false });

	const initial = snapshot();
	const introduced = structuredClone(initial);
	introduced.editorLayout.mainExpandedSections = { basic: true, status: false };
	const changed = structuredClone(introduced);
	changed.editorLayout.mainExpandedSections!.basic = false;
	const additions = appendPendingPromptUiEdit([
		{ requestId: 'A', area: 'editor', base: initial, next: introduced, failed: true },
	], { requestId: 'B', area: 'editor', base: introduced, next: changed });
	const confirmed = structuredClone(initial);
	confirmed.editorLayout.mainExpandedSections = { basic: false };
	assert.deepEqual(rebasePromptUiSettings(confirmed, additions.filter(edit => edit.requestId !== 'B'))
		.editorLayout.mainExpandedSections, { basic: false, status: false });
});

/** Быстрые повторы вытесняют прежние значения до ответа и не расширяют патч независимыми ошибками. */
test('UI settings rapid retries preserve latest field ownership through late responses', () => {
	const base = snapshot();
	const first = structuredClone(base);
	first.dashboardPreferences!.todos.search = 'a';
	first.dashboardPreferences!.docker.search = 'unsaved';
	let edits = appendPendingPromptUiEdit([], { requestId: 'A', area: 'preferences', base, next: first });
	const second = structuredClone(first);
	second.dashboardPreferences!.todos.search = 'ab';
	edits = appendPendingPromptUiEdit(edits, { requestId: 'B', area: 'preferences', base: first, next: second });
	edits = rejectPendingPromptUiEdit(rejectPendingPromptUiEdit(edits, 'A'), 'B');
	const retry = structuredClone(second);
	retry.dashboardPreferences!.todos.search = 'abc';
	edits = appendPendingPromptUiEdit(edits, { requestId: 'C', area: 'preferences', base: second, next: retry });
	const last = structuredClone(retry);
	last.dashboardPreferences!.todos.search = '';
	edits = appendPendingPromptUiEdit(edits, { requestId: 'D', area: 'preferences', base: retry, next: last });
	edits = edits.filter(edit => edit.requestId !== 'D');
	edits = rejectPendingPromptUiEdit(edits, 'C');
	const visible = rebasePromptUiSettings(base, edits);
	assert.equal(visible.dashboardPreferences!.todos.search, '');
	assert.equal(visible.dashboardPreferences!.docker.search, 'unsaved');
	assert.deepEqual(edits[0].supersededPaths, [['dashboardPreferences', 'todos', 'search']]);
	assert.deepEqual(edits.map(edit => edit.requestId), ['A']);
});

/** Доля ширины и порядок разделов — независимые поля: внешние и локальные правки не стирают друг друга. */
test('UI settings keep a pending panel split ratio independent from section order and external updates', () => {
	const base = snapshot();
	const resized = structuredClone(base);
	resized.editorLayout.panelSplitRatio = 0.6;
	let edits = appendPendingPromptUiEdit([], { requestId: 'ratio', area: 'editor', base, next: resized });
	const reordered = structuredClone(resized);
	reordered.editorLayout.main.reverse();
	edits = appendPendingPromptUiEdit(edits, { requestId: 'order', area: 'editor', base: resized, next: reordered });
	assert.equal(edits.length, 2);
	const external = structuredClone(base);
	external.dashboardPreferences!.todos.search = 'other window';
	const rebased = rebasePromptUiSettings(external, edits);
	assert.equal(rebased.editorLayout.panelSplitRatio, 0.6);
	assert.deepEqual(rebased.editorLayout.main, reordered.editorLayout.main);
	assert.equal(rebased.dashboardPreferences!.todos.search, 'other window');
	// После подтверждения обеих записей ширина из другого окна применяется без локального отката.
	const fromOtherWindow = structuredClone(reordered);
	fromOtherWindow.editorLayout.panelSplitRatio = null;
	assert.equal(rebasePromptUiSettings(fromOtherWindow, []).editorLayout.panelSplitRatio, null);
});

/** Совпадающее значение не пишется; повтор отклонённого значения получает базу ошибочной правки. */
test('UI settings retry a rejected panel split ratio with the base of the failed edit', () => {
	const confirmed = snapshot();
	confirmed.editorLayout.panelSplitRatio = 0.6;
	assert.deepEqual(resolvePromptEditorSplitRatioSave([], confirmed, 0.6), { save: false });
	assert.deepEqual(resolvePromptEditorSplitRatioSave([], confirmed, 0.45), { save: true });

	const reset = structuredClone(confirmed);
	reset.editorLayout.panelSplitRatio = null;
	let edits = appendPendingPromptUiEdit([], { requestId: 'reset', area: 'editor', base: confirmed, next: reset });
	assert.deepEqual(resolvePromptEditorSplitRatioSave(edits, reset, null), { save: false });
	edits = rejectPendingPromptUiEdit(edits, 'reset');
	const visible = rebasePromptUiSettings(confirmed, edits);
	assert.equal(visible.editorLayout.panelSplitRatio, null);

	const decision = resolvePromptEditorSplitRatioSave(edits, visible, null);
	assert.equal(decision.save, true);
	const retryBase = decision.save ? decision.base : undefined;
	assert.equal(retryBase?.editorLayout.panelSplitRatio, 0.6);
	assert.deepEqual(retryBase?.editorLayout.main, visible.editorLayout.main);
	// Повтор вытесняет ошибочную правку, а его подтверждение очищает очередь.
	edits = appendPendingPromptUiEdit(edits, { requestId: 'retry', area: 'editor', base: retryBase!, next: visible });
	assert.deepEqual(edits.map(edit => edit.requestId), ['retry']);
	edits = edits.filter(edit => edit.requestId !== 'retry');
	assert.equal(rebasePromptUiSettings(reset, edits).editorLayout.panelSplitRatio, null);
	// Ошибка другого значения не разрешает повтор текущего видимого значения.
	const failedOther = rejectPendingPromptUiEdit(appendPendingPromptUiEdit([],
		{ requestId: 'other', area: 'editor', base: confirmed, next: reset }), 'other');
	assert.deepEqual(resolvePromptEditorSplitRatioSave(failedOther, confirmed, 0.6), { save: false });
});

/** План записи переносит порядок и раскрытие формы, а повтор отклонённого значения получает базу ошибки. */
test('planPromptEditorSplitRatioSave keeps other layout fields and plans retries of rejected values', () => {
	const current = snapshot();
	current.editorLayout = normalizePromptEditorLayout({ main: ['files'], mainExpandedSections: { basic: false },
		panelSplitRatio: 0.5 });
	const plan = planPromptEditorSplitRatioSave([], current, 0.65);
	assert.deepEqual(plan, { layout: { ...current.editorLayout, panelSplitRatio: 0.65 } });
	assert.equal(planPromptEditorSplitRatioSave([], current, 0.5), null);
	assert.deepEqual(planPromptEditorSplitRatioSave([], current, null)?.layout.panelSplitRatio, null);

	const rejected = structuredClone(current);
	rejected.editorLayout.panelSplitRatio = 0.65;
	const edits = rejectPendingPromptUiEdit(appendPendingPromptUiEdit([],
		{ requestId: 'ratio', area: 'editor', base: current, next: rejected }), 'ratio');
	const retry = planPromptEditorSplitRatioSave(edits, rejected, 0.65);
	assert.equal(retry?.layout.panelSplitRatio, 0.65);
	assert.equal(retry?.base?.editorLayout.panelSplitRatio, 0.5);
	assert.deepEqual(retry?.layout.main, current.editorLayout.main);
});
