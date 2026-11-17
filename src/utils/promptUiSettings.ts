import { normalizePromptEditorLayout, type PromptEditorLayout, type PromptUiSettingsSnapshot } from '../types/promptEditorLayout.js';
import { applyUiSettingsChanges } from './uiSettingsPatch.js';

/** Локальная правка остаётся видимой до подтверждения; ошибка допускает повтор того же действия. */
export interface PendingPromptUiEdit {
	requestId: string;
	area: string;
	base: PromptUiSettingsSnapshot;
	next: PromptUiSettingsSnapshot;
	failed?: boolean;
	/** Поля, для которых уже принято более новое действие, даже если оно подтвердилось раньше этой правки. */
	supersededPaths?: readonly (readonly string[])[];
}

/** JSON-объекты раскрываются по полям; массивы сохраняют смысл единого упорядоченного значения. */
function isSettingsRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Находит границы патча с теми же правилами объектов, удаления и массивов, что applyUiSettingsChanges. */
function changedPaths(base: unknown, next: unknown, path: readonly string[] = []): string[][] {
	if (JSON.stringify(base) === JSON.stringify(next)) {
		return [];
	}
	if (!isSettingsRecord(base) || !isSettingsRecord(next)) {
		return [[...path]];
	}
	return [...new Set([...Object.keys(base), ...Object.keys(next)])]
		.filter(key => !['__proto__', 'constructor', 'prototype'].includes(key))
		.flatMap(key => !Object.hasOwn(next, key)
			? [[...path, key]] : changedPaths(base[key], next[key], [...path, key]));
}

/** Родительский путь включает все вложенные поля; имена динамических ключей не разбиваются по точкам. */
function containsPath(parent: readonly string[], child: readonly string[]): boolean {
	return parent.length <= child.length && parent.every((key, index) => key === child[index]);
}

/** Полностью вытесненная ошибка уже не содержит пользовательского выбора для сохранения. */
function retainPendingFields(edit: PendingPromptUiEdit): boolean {
	return !edit.failed || changedPaths(edit.base, edit.next)
		.some(path => !edit.supersededPaths?.some(superseded => containsPath(superseded, path)));
}

/** Поздний отказ сохраняет независимые поля и освобождает уже вытесненную ошибочную запись. */
export function rejectPendingPromptUiEdit(
	edits: readonly PendingPromptUiEdit[], requestId: string,
): PendingPromptUiEdit[] {
	return edits.map(edit => edit.requestId === requestId ? { ...edit, failed: true } : edit).filter(retainPendingFields);
}

/** Добавляет новое намерение, оставляя в старых ошибочных и ожидающих правках только независимые поля. */
export function appendPendingPromptUiEdit(
	edits: readonly PendingPromptUiEdit[],
	edit: PendingPromptUiEdit,
): PendingPromptUiEdit[] {
	const newerPaths = changedPaths(edit.base, edit.next);
	return [...edits.map(previous => {
		const previousPaths = changedPaths(previous.base, previous.next);
		const superseded = [...previous.supersededPaths ?? []];
		for (const path of newerPaths) {
			if (!previousPaths.some(older => containsPath(older, path) || containsPath(path, older))
				|| superseded.some(older => containsPath(older, path))) {
				continue;
			}
			for (let index = superseded.length - 1; index >= 0; index--) {
				if (containsPath(path, superseded[index])) {
					superseded.splice(index, 1);
				}
			}
			superseded.push(path);
		}
		return superseded.length ? { ...previous, supersededPaths: superseded } : previous;
	}).filter(retainPendingFields), edit];
}

/** Возвращает вытесненное поле из актуального снимка, сохраняя различие удаления и явного false. */
function restorePath(target: unknown, source: unknown, path: readonly string[]): void {
	const key = path[0];
	if (!key || !isSettingsRecord(target)) {
		return;
	}
	const hasSource = isSettingsRecord(source) && Object.hasOwn(source, key);
	if (path.length === 1) {
		if (hasSource) {
			target[key] = structuredClone(source[key]);
		} else {
			delete target[key];
		}
		return;
	}
	if (!isSettingsRecord(target[key])) {
		if (!hasSource || !isSettingsRecord(source[key])) {
			return;
		}
		target[key] = {};
	}
	restorePath(target[key], hasSource ? source[key] : undefined, path.slice(1));
}

/** Решение о записи доли ширины: base задаётся только для повтора значения, отклонённого host. */
export type PromptEditorSplitRatioSaveDecision =
	| { save: false }
	| { save: true; base?: PromptUiSettingsSnapshot };

/**
 * Определяет, нужна ли запись доли ширины. Совпадение с видимым значением ничего не пишет, кроме повтора
 * отклонённой записи: тогда база берётся из ошибочной правки, чтобы host и очередь увидели изменение.
 * Тесты: promptUiSettings.test.ts.
 */
export function resolvePromptEditorSplitRatioSave(
	edits: readonly PendingPromptUiEdit[],
	current: PromptUiSettingsSnapshot,
	ratio: number | null,
): PromptEditorSplitRatioSaveDecision {
	if ((current.editorLayout.panelSplitRatio ?? null) !== ratio) {
		return { save: true };
	}
	const failed = [...edits].reverse().find(edit => edit.failed
		&& (edit.base.editorLayout.panelSplitRatio ?? null) !== (edit.next.editorLayout.panelSplitRatio ?? null)
		&& (edit.next.editorLayout.panelSplitRatio ?? null) === ratio);
	if (!failed) {
		return { save: false };
	}
	const base = structuredClone(current);
	base.editorLayout = { ...base.editorLayout, panelSplitRatio: failed.base.editorLayout.panelSplitRatio ?? null };
	return { save: true, base };
}

/**
 * План записи доли ширины для EditorApp: макет формы с новой долей и база повтора; null — запись не нужна.
 * Остальные поля макета (порядок и раскрытие разделов) переносятся из видимого снимка без изменений.
 * Тесты: promptUiSettings.test.ts.
 */
export function planPromptEditorSplitRatioSave(
	edits: readonly PendingPromptUiEdit[],
	current: PromptUiSettingsSnapshot,
	ratio: number | null,
): { layout: PromptEditorLayout; base?: PromptUiSettingsSnapshot } | null {
	const decision = resolvePromptEditorSplitRatioSave(edits, current, ratio);
	if (!decision.save) {
		return null;
	}
	const layout = normalizePromptEditorLayout({ ...current.editorLayout, panelSplitRatio: ratio });
	return decision.base ? { layout, base: decision.base } : { layout };
}

/** Внешний снимок обновляет незатронутые поля, сохраняя локальные правки и не повторяя запись. */
export function rebasePromptUiSettings(
	confirmed: PromptUiSettingsSnapshot,
	edits: readonly PendingPromptUiEdit[],
): PromptUiSettingsSnapshot {
	return edits.reduce((current, edit) => {
		const next = applyUiSettingsChanges(current, edit.next, edit.base);
		for (const path of edit.supersededPaths ?? []) {
			restorePath(next, current, path);
		}
		return next;
	}, confirmed);
}
