import type { PromptHoverTarget } from '../types/promptHoverPreview.js';

/** Сравнивает полный адрес строки; тесты: promptHoverPreview.test.ts. */
export function isSamePromptHoverTarget(left: PromptHoverTarget, right: PromptHoverTarget): boolean {
	return left.id === right.id && left.promptUuid === right.promptUuid && left.archived === right.archived;
}

/** Принимает ответ только для открытого запроса; проверки закрытия и гонок: promptHoverPreview.test.ts. */
export function isCurrentPromptHoverResponse(
	active: { requestId: string; target: PromptHoverTarget } | null,
	response: { requestId: string; target: PromptHoverTarget },
): boolean {
	return Boolean(active && response.target && active.requestId === response.requestId
		&& isSamePromptHoverTarget(active.target, response.target));
}

/** Геометрия якоря в координатах viewport, не зависит от React и DOM. */
export interface PromptHoverAnchorRect {
	left: number;
	top: number;
	bottom: number;
}

/** Поздний scroll с уже учтёнными координатами не закрывает карточку; тест: promptHoverPreview.test.ts. */
export function hasPromptHoverAnchorMoved(previous: PromptHoverAnchorRect, current: PromptHoverAnchorRect): boolean {
	return previous.top !== current.top || previous.bottom !== current.bottom || previous.left !== current.left;
}

/** Удерживает карточку внутри webview, выбирая свободное место; тесты: promptHoverPreview.test.ts. */
export function getPromptHoverPosition(
	anchor: PromptHoverAnchorRect, viewportWidth: number, viewportHeight: number, cardHeight: number,
): { left: number; top: number; width: number; maxHeight: number } {
	// Маленький viewport также оставляет доступную область без отрицательных размеров.
	const gap = Math.min(8, viewportWidth / 4, viewportHeight / 4);
	const width = Math.max(0, Math.min(420, viewportWidth - gap * 2));
	const below = Math.max(0, viewportHeight - anchor.bottom - gap * 2);
	const above = Math.max(0, anchor.top - gap * 2);
	const placeBelow = below >= Math.min(cardHeight, 180) || below >= above;
	const available = placeBelow ? below : above;
	const maxHeight = Math.min(450, available >= 120 ? available : viewportHeight - gap * 2);
	const height = Math.min(cardHeight, maxHeight);
	const preferredTop = placeBelow ? anchor.bottom + gap : anchor.top - gap - height;
	return {
		left: Math.max(gap, Math.min(anchor.left, viewportWidth - width - gap)),
		top: Math.max(gap, Math.min(preferredTop, viewportHeight - height - gap)),
		width,
		maxHeight,
	};
}
