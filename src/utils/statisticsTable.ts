/** Format milliseconds into compact localized table duration text. */
export function formatStatisticsDurationForDisplay(milliseconds: number, locale: string): string {
	const safeMilliseconds = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
	const isRussian = locale.toLowerCase().startsWith('ru');
	const hourUnit = isRussian ? 'ч' : 'h';
	const minuteUnit = isRussian ? 'м' : 'm';
	const secondUnit = isRussian ? 'с' : 's';
	if (safeMilliseconds < 1000) {
		return `0${secondUnit}`;
	}

	const totalSeconds = Math.floor(safeMilliseconds / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}${hourUnit} ${minutes}${minuteUnit} ${seconds}${secondUnit}`;
	}

	if (minutes > 0) {
		return `${minutes}${minuteUnit} ${seconds}${secondUnit}`;
	}

	return `${seconds}${secondUnit}`;
}
