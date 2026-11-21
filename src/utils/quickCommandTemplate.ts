import { DASHBOARD_QUICK_COMMAND_TEXT_LIMIT } from '../types/promptDashboardPreferences.js';

/** Единый словарь для редактора команд и подстановки на стороне расширения. */
export const QUICK_COMMAND_VARIABLES = {
	workspacePath: 'Полный путь рабочей области',
	workspaceRelativePath: 'Путь от домашней папки',
	workspaceName: 'Имя рабочей области',
	taskNumber: 'Номер задачи',
	promptTitle: 'Название промпта',
	promptDirectory: 'Папка промпта',
} as const;

/** Результат одинаков для предпросмотра, вставки и копирования черновика. */
export type QuickCommandTemplateResult = { text: string } | { error: string };

/** Подставляет только известные переменные, однократно и без изменения форматирования.
 * Пустые значения и буквальные фигурные скобки проверяет quickCommandsWidget.test.tsx. */
export function expandQuickCommandText(template: string, getValue: (key: keyof typeof QUICK_COMMAND_VARIABLES) => string | undefined):
	QuickCommandTemplateResult {
	if (typeof template !== 'string' || !template.trim()) {
		return { error: 'Не задан текст команды. Заполните поле «Текст команды».' };
	}
	if (template.length > DASHBOARD_QUICK_COMMAND_TEXT_LIMIT) {
		return { error: `Текст команды превышает ${DASHBOARD_QUICK_COMMAND_TEXT_LIMIT} символов.` };
	}
	// Каталог сохранённого промпта ищем только по запросу и один раз для всех повторов в шаблоне.
	const values = new Map<string, string | undefined>();
	let missing: string | undefined;
	const text = template.replace(/\{\{[ \t]*(\w+)[ \t]*\}\}/g, (token, name: string) => {
		if (!Object.hasOwn(QUICK_COMMAND_VARIABLES, name)) return token;
		if (!values.has(name)) values.set(name, getValue(name as keyof typeof QUICK_COMMAND_VARIABLES));
		const value = values.get(name);
		if (!value?.trim()) missing ??= token;
		return value ?? '';
	});
	return missing ? { error: `Нет значения для переменной ${missing} в текущем контексте.` } : { text };
}
