// Утилиты рассчитывают адаптивную ширину колонки номера задачи в компактном списке sidebar.
// Они сохраняют выравнивание строки и не дают длинным номерам ломать сетку.

// Минимальная ширина колонки номера задачи в компактном режиме.
export const COMPACT_TASK_COLUMN_MIN_WIDTH_PX = 32;
// Максимальная доля ширины списка, которую может занять колонка номера задачи.
export const COMPACT_TASK_COLUMN_MAX_WIDTH_RATIO = '33.333%';
// Буфер в символах, чтобы длинные номера не обрезались слишком рано.
export const COMPACT_TASK_COLUMN_BUFFER_CH = 1.5;
// Отступ между номером задачи и заголовком.
export const COMPACT_TASK_TITLE_COLUMN_GAP_PX = 8;
// Отступ между заголовком и статусом.
export const COMPACT_TITLE_STATUS_COLUMN_GAP_PX = 16;


// Нормализует номер задачи и подставляет плейсхолдер, если значение пустое.
export function normalizeCompactTaskNumber(taskNumber?: string | null): string {
	const normalizedTaskNumber = taskNumber?.trim();

	return normalizedTaskNumber ? normalizedTaskNumber : '—';
}

// Оценивает требуемую ширину номера задачи в ch с учетом буфера.
function estimateCompactTaskWidthInCh(taskNumber?: string | null): number {
	const normalizedTaskNumber = normalizeCompactTaskNumber(taskNumber);

	return Number((normalizedTaskNumber.length + COMPACT_TASK_COLUMN_BUFFER_CH).toFixed(1));
}

// Собирает CSS-трек колонки номера задачи с минимальной и адаптивной шириной.
function buildCompactTaskColumnTrack(estimatedWidthInCh: number): string {
	return (
		`minmax(${COMPACT_TASK_COLUMN_MIN_WIDTH_PX}px, `
		+ `min(${COMPACT_TASK_COLUMN_MAX_WIDTH_RATIO}, ${estimatedWidthInCh}ch))`
	);
}

// Возвращает CSS-трек колонки для одного номера задачи.
export function resolveCompactTaskColumnTrack(taskNumber?: string | null): string {
	return buildCompactTaskColumnTrack(estimateCompactTaskWidthInCh(taskNumber));
}

// Возвращает общий CSS-трек по самой широкой задаче в текущем списке.
export function resolveSharedCompactTaskColumnTrack(taskNumbers: Array<string | null | undefined>): string {
	const widestTaskWidthInCh = taskNumbers.reduce(
		(maxWidth, taskNumber) => Math.max(maxWidth, estimateCompactTaskWidthInCh(taskNumber)),
		estimateCompactTaskWidthInCh(undefined),
	);

	return buildCompactTaskColumnTrack(widestTaskWidthInCh);
}

// Собирает grid-template-columns для компактной строки prompt.
export function resolveCompactPromptGridTemplateColumns(taskColumnTrack: string): string {
	return (
		`${taskColumnTrack} ${COMPACT_TASK_TITLE_COLUMN_GAP_PX}px minmax(0, 1fr) `
		+ `${COMPACT_TITLE_STATUS_COLUMN_GAP_PX}px max-content`
	);
}