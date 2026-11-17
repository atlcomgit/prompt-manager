import { createDefaultEditorPromptExpandedSections, type EditorPromptExpandedSections, type EditorPromptSectionKey, type EditorPromptTab } from './prompt.js';
import type { PromptDashboardLayouts } from './promptDashboard.js';
import type { PromptDashboardPreferences } from './promptDashboardPreferences.js';

/** Подтверждённые настройки интерфейса; runtime-данные и состояние Process сюда не входят. */
export interface PromptUiSettingsSnapshot {
	editorLayout: PromptEditorLayout;
	dashboardLayouts: PromptDashboardLayouts;
	dashboardPreferences?: PromptDashboardPreferences;
}

/** Порядок формы независим от профилей ширины виджетов; тесты: promptEditorLayout.test.ts. */
export const PROMPT_EDITOR_TAB_SECTIONS: Record<EditorPromptTab, readonly EditorPromptSectionKey[]> = {
	main: ['basic', 'status', 'time', 'workspace', 'prompt', 'globalPrompt', 'tech', 'integrations', 'agent', 'groups', 'files'],
	process: ['notes', 'memory', 'plan', 'report'],
};

/** Только main получает глобальное раскрытие; правила Process остаются в EditorPromptViewState. */
export interface PromptEditorLayout {
	main: EditorPromptSectionKey[];
	process: EditorPromptSectionKey[];
	mainExpandedSections?: Partial<EditorPromptExpandedSections>;
	/**
	 * Доля ширины формы от суммы ширин формы и виджетов без промежутка; общая для промптов и вкладок.
	 * `null` — автоматическая ширина, отсутствие поля — значение не передано и не меняется при patch.
	 */
	panelSplitRatio?: number | null;
}

/** Точность хранения доли: четыре знака не создают лишних изменений в Settings Sync. */
const PROMPT_EDITOR_PANEL_SPLIT_RATIO_SCALE = 10_000;

/** Возвращает долю в диапазоне 0…1 или null для автоматического режима; тесты: promptEditorLayout.test.ts. */
export function normalizePromptEditorPanelSplitRatio(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
		return null;
	}
	return Math.round(value * PROMPT_EDITOR_PANEL_SPLIT_RATIO_SCALE) / PROMPT_EDITOR_PANEL_SPLIT_RATIO_SCALE;
}

/** Удаляет неизвестные ключи и добавляет новые разделы без дублей; скрытие не меняет список вкладки. */
export function normalizePromptEditorSectionOrder(value: unknown, tab: EditorPromptTab): EditorPromptSectionKey[] {
	const defaults = PROMPT_EDITOR_TAB_SECTIONS[tab];
	const saved = Array.isArray(value) ? value.filter((key): key is EditorPromptSectionKey => defaults.includes(key)) : [];
	const order = Array.from(new Set(saved));
	for (const key of defaults) {
		if (!order.includes(key)) {
			if (key === 'status' && order.includes('basic')) {
				order.splice(order.indexOf('basic') + 1, 0, key);
			} else {
				order.push(key);
			}
		}
	}
	return order;
}

/** Проверяет только ключи main, не перенося автоматические переопределения Process. */
export function normalizePromptEditorMainExpanded(value: unknown): Partial<EditorPromptExpandedSections> {
	const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
	const defaults = createDefaultEditorPromptExpandedSections();
	const state: Partial<EditorPromptExpandedSections> = {};
	for (const key of PROMPT_EDITOR_TAB_SECTIONS.main) {
		state[key] = typeof source[key] === 'boolean' ? source[key] : defaults[key];
	}
	return state;
}

/** Отсутствие main-снимка и доли ширины позволяет использовать прежнее состояние до первого сохранения. */
export function normalizePromptEditorLayout(value?: Partial<PromptEditorLayout> | null): PromptEditorLayout {
	return {
		main: normalizePromptEditorSectionOrder(value?.main, 'main'),
		process: normalizePromptEditorSectionOrder(value?.process, 'process'),
		...(value?.mainExpandedSections !== undefined
			? { mainExpandedSections: normalizePromptEditorMainExpanded(value.mainExpandedSections) } : {}),
		...(value?.panelSplitRatio !== undefined
			? { panelSplitRatio: normalizePromptEditorPanelSplitRatio(value.panelSplitRatio) } : {}),
	};
}
