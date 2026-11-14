import type { PromptConfig, SortField, SortOrder } from '../types/prompt.js';

/** Поля списка, необходимые для сравнения без изменения сохранённых метаданных промпта. */
type SidebarSortablePrompt = Pick<PromptConfig, 'id' | 'title' | 'taskNumber' | 'createdAt' | 'updatedAt' | 'status'>;

/** Сравнивает цифровые части без Number: длина номера не ограничена точностью числового типа. */
function compareDigitParts(left: string, right: string): number {
	// Ведущие нули не меняют числовое значение; полностью нулевая часть становится пустой строкой.
	const leftDigits = left.replace(/^0+/, '');
	const rightDigits = right.replace(/^0+/, '');

	return leftDigits.length - rightDigits.length || (leftDigits < rightDigits ? -1 : leftDigits > rightDigits ? 1 : 0);
}

/** Сравнивает составные номера естественно, включая ABC-2, ABC-12 и очень длинные цифровые части. */
function compareTaskNumbers(left: string, right: string): number {
	// Текст и цифры сравниваются отдельными частями, поэтому номер остаётся строковым идентификатором.
	const leftParts = left.match(/[0-9]+|[^0-9]+/g) ?? [];
	const rightParts = right.match(/[0-9]+|[^0-9]+/g) ?? [];

	for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index += 1) {
		const leftPart = leftParts[index];
		const rightPart = rightParts[index];
		const comparison = /^[0-9]/.test(leftPart) && /^[0-9]/.test(rightPart)
			? compareDigitParts(leftPart, rightPart)
			: leftPart.localeCompare(rightPart);
		if (comparison !== 0) {
			return comparison;
		}
	}

	return leftParts.length - rightParts.length;
}

/** Упорядочивает одинаковые номера по названию и id независимо от порядка чтения папок. */
function comparePromptIdentity(left: SidebarSortablePrompt, right: SidebarSortablePrompt): number {
	return (left.title || left.id).localeCompare(right.title || right.id)
		|| left.id.localeCompare(right.id)
		|| (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

/**
 * Сортирует список, включая номер задачи с дополнительной датой; пустые номера всегда остаются в конце.
 * Поведение и сохранность метаданных проверяются в tests/sidebarSorting.test.ts.
 */
export function compareSidebarPrompts(
	left: SidebarSortablePrompt,
	right: SidebarSortablePrompt,
	field: SortField,
	order: SortOrder,
): number {
	// Направление применяется после исключения пустых номеров из основной части списка.
	let comparison = 0;
	switch (field) {
		case 'taskNumber':
		case 'taskNumberCreatedAt': {
			const leftNumber = (left.taskNumber || '').trim();
			const rightNumber = (right.taskNumber || '').trim();
			if (!leftNumber && rightNumber) {
				return 1;
			}
			if (leftNumber && !rightNumber) {
				return -1;
			}
			// Дата сравнивает равные номера, включая отсутствующие; название и id разрешают последнее равенство.
			comparison = compareTaskNumbers(leftNumber, rightNumber)
				|| (field === 'taskNumberCreatedAt' ? left.createdAt.localeCompare(right.createdAt) : 0)
				|| comparePromptIdentity(left, right);
			break;
		}
		case 'title':
			comparison = (left.title || left.id).localeCompare(right.title || right.id);
			break;
		case 'createdAt':
			comparison = left.createdAt.localeCompare(right.createdAt);
			break;
		case 'updatedAt':
			comparison = left.updatedAt.localeCompare(right.updatedAt);
			break;
		case 'status':
			comparison = left.status.localeCompare(right.status);
			break;
	}

	return order === 'asc' ? comparison : -comparison;
}
