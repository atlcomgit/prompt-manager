export interface PlanChecklistItem {
	text: string;
	checked: boolean;
	lineNumber: number;
}

export interface PlanChecklistStats {
	total: number;
	completed: number;
	pending: number;
}

const PLAN_CHECKLIST_ITEM_PATTERN = /^\s*(?:[-*+]|\d+\.)\s+\[([ xX])\]\s+(.+?)\s*$/;

/** Keeps headings and checkbox items at their source indices for compact plan rendering. */
export function selectCompactPlanLines(lines: readonly string[]): Array<{ index: number; text: string }> {
	const result: Array<{ index: number; text: string }> = [];
	let fenceMarker = '';
	let fenceLength = 0;

	for (let index = 0; index < lines.length; index += 1) {
		const text = lines[index];
		const fence = text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
		if (fence) {
			const marker = fence[1];
			if (!fenceMarker) {
				fenceMarker = marker[0];
				fenceLength = marker.length;
			} else if (marker[0] === fenceMarker && marker.length >= fenceLength && !fence[2].trim()) {
				fenceMarker = '';
				fenceLength = 0;
			}
			continue;
		}
		if (fenceMarker) {
			continue;
		}
		const isHeading = /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(text);
		const isChecklistItem = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?\[[ xX]\](?:\s|$)/.test(text);
		if (isHeading || isChecklistItem) {
			// Keep one existing blank line before a heading, without adding extra empty rows.
			if (isHeading && result.length > 0 && index > 0
				&& lines[index - 1].trim() === '' && result[result.length - 1].text !== '') {
				result.push({ index: index - 1, text: '' });
			}
			result.push({ index, text });
		}
	}

	return result;
}

export function parsePlanChecklist(markdown: string): PlanChecklistItem[] {
	if (!markdown.trim()) {
		return [];
	}

	return markdown
		.split(/\r?\n/)
		.map((line, index) => {
			const match = line.match(PLAN_CHECKLIST_ITEM_PATTERN);
			if (!match) {
				return null;
			}

			const text = (match[2] || '').trim();
			if (!text) {
				return null;
			}

			return {
				text,
				checked: (match[1] || ' ').toLowerCase() === 'x',
				lineNumber: index + 1,
			} satisfies PlanChecklistItem;
		})
		.filter((item): item is PlanChecklistItem => item !== null);
}

export function getPlanChecklistStats(items: readonly PlanChecklistItem[]): PlanChecklistStats {
	const completed = items.filter(item => item.checked).length;
	const total = items.length;

	return {
		total,
		completed,
		pending: Math.max(0, total - completed),
	};
}

export function buildPlanChecklistSummary(items: readonly PlanChecklistItem[]): string[] {
	if (items.length === 0) {
		return [];
	}

	const stats = getPlanChecklistStats(items);

	return [
		`Выполнено: ${stats.completed}`,
		`Осталось: ${stats.pending}`,
		`Всего: ${stats.total}`,
	];
}