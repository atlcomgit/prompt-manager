/** Identity подсказки учитывает UUID и архив, включая одинаковые имена папок в разных областях. */
export interface PromptHoverTarget {
	id: string;
	promptUuid: string;
	archived: boolean;
}

/** Пустой текст является успешным чтением; отсутствие промпта и ошибка доступа различаются. */
export type PromptHoverPreviewResult =
	| { state: 'ready'; content: string }
	| { state: 'missing' }
	| { state: 'error' };
