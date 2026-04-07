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