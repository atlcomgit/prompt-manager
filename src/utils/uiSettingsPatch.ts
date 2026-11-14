/** Применяет только изменения относительно снимка отправителя; массивы считаются одним значением. */
export function applyUiSettingsChanges<T>(current: T, next: T, base?: T): T {
	if (base === undefined) {
		return structuredClone(next);
	}
	if (JSON.stringify(base) === JSON.stringify(next)) {
		return structuredClone(current);
	}
	if (isSettingsRecord(base) && isSettingsRecord(next)) {
		const result: Record<string, unknown> = isSettingsRecord(current) ? { ...current } : {};
		for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
			if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
				continue;
			}
			if (!Object.hasOwn(next, key)) {
				delete result[key];
			} else if (JSON.stringify(base[key]) !== JSON.stringify(next[key])) {
				result[key] = applyUiSettingsChanges(result[key], next[key], base[key]);
			}
		}
		return result as T;
	}
	return structuredClone(next);
}

/** JSON-объект настроек не должен превращать массив в карту числовых ключей. */
function isSettingsRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
