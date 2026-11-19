/**
 * Управление фокусом модальных слоёв быстрых заметок: удержание Tab внутри слоя и возврат фокуса на корень,
 * если закрытый вложенный элемент (меню, блок AI, подтверждение) оставил фокус на body.
 */
import { useEffect, type RefObject } from 'react';

/** Элементы, которые получают фокус по Tab. */
const QUICK_NOTES_FOCUSABLE_SELECTOR =
	'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Удерживает Tab внутри слоя: с последнего элемента — на первый, с первого по Shift+Tab — на последний. */
export function trapQuickNotesTabKey(event: { key: string; shiftKey: boolean; preventDefault(): void }, root: HTMLElement | null): void {
	if (event.key !== 'Tab' || !root) {
		return;
	}
	const focusable = Array.from(root.querySelectorAll<HTMLElement>(QUICK_NOTES_FOCUSABLE_SELECTOR))
		.filter(element => element.offsetParent !== null || element === document.activeElement);
	if (focusable.length === 0) {
		event.preventDefault();
		root.focus();
		return;
	}
	const first = focusable[0];
	const last = focusable[focusable.length - 1];
	const active = document.activeElement;
	if (event.shiftKey && (active === first || active === root)) {
		event.preventDefault();
		last.focus();
	} else if (!event.shiftKey && (active === last || !root.contains(active))) {
		event.preventDefault();
		first.focus();
	}
}

/**
 * Возвращает фокус на корень слоя, когда фокус оказался на body: клавиши Escape и Tab слоя
 * продолжают работать после закрытия меню, блока AI или подтверждения. Удаление элемента с фокусом
 * не порождает событий фокуса, поэтому проверка выполняется после каждой отрисовки слоя, пока enabled.
 */
export function useQuickNotesFocusFallback(rootRef: RefObject<HTMLElement>, enabled = true): void {
	useEffect(() => {
		const root = rootRef.current;
		const active = document.activeElement;
		if (enabled && root?.isConnected && (!active || active === document.body)) {
			root.focus({ preventScroll: true });
		}
	});
}
