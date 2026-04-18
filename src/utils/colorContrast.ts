/**
 * Определение контрастного цвета текста для светлого или тёмного фона.
 */

interface RgbColor {
	r: number;
	g: number;
	b: number;
}

/** Разобрать поддерживаемую CSS-строку цвета в RGB. */
function parseColorToRgb(color: string): RgbColor | null {
	const normalized = color.trim().toLowerCase();
	if (!normalized) {
		return null;
	}

	const hexMatch = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
	if (hexMatch) {
		const hex = hexMatch[1];
		if (hex.length === 3 || hex.length === 4) {
			return {
				r: Number.parseInt(hex[0] + hex[0], 16),
				g: Number.parseInt(hex[1] + hex[1], 16),
				b: Number.parseInt(hex[2] + hex[2], 16),
			};
		}

		return {
			r: Number.parseInt(hex.slice(0, 2), 16),
			g: Number.parseInt(hex.slice(2, 4), 16),
			b: Number.parseInt(hex.slice(4, 6), 16),
		};
	}

	const rgbMatch = normalized.match(/^rgba?\(([^)]+)\)$/i);
	if (!rgbMatch) {
		return null;
	}

	const parts = rgbMatch[1]
		.split(',')
		.slice(0, 3)
		.map(part => Number.parseFloat(part.trim()));
	if (parts.length !== 3 || parts.some(value => !Number.isFinite(value))) {
		return null;
	}

	return {
		r: Math.max(0, Math.min(255, Math.round(parts[0]))),
		g: Math.max(0, Math.min(255, Math.round(parts[1]))),
		b: Math.max(0, Math.min(255, Math.round(parts[2]))),
	};
}

/** Преобразовать sRGB-канал в линейное пространство для расчёта luminance. */
function toLinearChannel(channel: number): number {
	const normalized = channel / 255;
	return normalized <= 0.04045
		? normalized / 12.92
		: ((normalized + 0.055) / 1.055) ** 2.4;
}

/** Посчитать относительную яркость по WCAG. */
function getRelativeLuminance(color: RgbColor): number {
	return (
		(0.2126 * toLinearChannel(color.r))
		+ (0.7152 * toLinearChannel(color.g))
		+ (0.0722 * toLinearChannel(color.b))
	);
}

/** Вернуть чёрный или белый текст с лучшим контрастом к цвету фона. */
export function resolveReadableTextColor(backgroundColor: string): '#000000' | '#ffffff' | undefined {
	const rgbColor = parseColorToRgb(backgroundColor);
	if (!rgbColor) {
		return undefined;
	}

	const luminance = getRelativeLuminance(rgbColor);
	const blackContrast = (luminance + 0.05) / 0.05;
	const whiteContrast = 1.05 / (luminance + 0.05);
	return blackContrast >= whiteContrast ? '#000000' : '#ffffff';
}