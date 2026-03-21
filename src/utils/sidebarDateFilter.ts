import type { CreatedAtFilter } from '../types/prompt.js';

const DAY_MS = 24 * 60 * 60 * 1000;

interface DateRange {
	start: Date;
	end: Date;
}

export function matchesCreatedAtFilter(createdAt: string, filter: CreatedAtFilter, now: Date = new Date()): boolean {
	if (filter === 'all') {
		return true;
	}

	const createdAtDate = new Date(createdAt);
	if (Number.isNaN(createdAtDate.getTime())) {
		return false;
	}

	const range = resolveCreatedAtFilterRange(filter, now);
	return createdAtDate >= range.start && createdAtDate <= range.end;
}

export function resolveCreatedAtFilterRange(filter: Exclude<CreatedAtFilter, 'all'>, now: Date = new Date()): DateRange {
	switch (filter) {
		case 'last-1-day':
			return { start: new Date(now.getTime() - DAY_MS), end: now };
		case 'last-7-days':
			return { start: new Date(now.getTime() - 7 * DAY_MS), end: now };
		case 'last-14-days':
			return { start: new Date(now.getTime() - 14 * DAY_MS), end: now };
		case 'last-30-days':
			return { start: new Date(now.getTime() - 30 * DAY_MS), end: now };
		case 'last-1-year':
			return { start: new Date(now.getTime() - 365 * DAY_MS), end: now };
		case 'current-week':
			return resolveCurrentWeekRange(now);
		case 'previous-week':
			return resolvePreviousWeekRange(now);
		case 'current-month':
			return {
				start: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0),
				end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
			};
		case 'previous-month':
			return {
				start: new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0),
				end: new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999),
			};
		case 'current-year':
			return {
				start: new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0),
				end: new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999),
			};
		case 'previous-year':
			return {
				start: new Date(now.getFullYear() - 1, 0, 1, 0, 0, 0, 0),
				end: new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59, 999),
			};
	}
}

function resolveCurrentWeekRange(now: Date): DateRange {
	const start = startOfWeek(now);
	const end = new Date(start);
	end.setDate(start.getDate() + 6);
	end.setHours(23, 59, 59, 999);
	return { start, end };
}

function resolvePreviousWeekRange(now: Date): DateRange {
	const currentWeekStart = startOfWeek(now);
	const start = new Date(currentWeekStart);
	start.setDate(currentWeekStart.getDate() - 7);
	start.setHours(0, 0, 0, 0);
	const end = new Date(currentWeekStart);
	end.setMilliseconds(-1);
	return { start, end };
}

function startOfWeek(now: Date): Date {
	const start = new Date(now);
	const day = start.getDay();
	const diff = day === 0 ? -6 : 1 - day;
	start.setDate(start.getDate() + diff);
	start.setHours(0, 0, 0, 0);
	return start;
}