import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = 'button, input:not([type="hidden"]), textarea, select, summary, a[href], [contenteditable="true"], [tabindex]';

/** A delayed dialog action must leave the keyboard in the VS Code pane the user selected. */
export function focusInActiveWebview(element: HTMLElement | null | undefined): void {
	if (element?.ownerDocument.hasFocus()) element.focus({ preventScroll: true });
}

/** Keep Tab inside the top dialog. Code editors, selects and custom controls participate in document order. */
export function trapQuickNotesTabKey(event: { key: string; shiftKey: boolean; preventDefault(): void }, root: HTMLElement | null): void {
	if (event.key !== 'Tab' || !root) return;
	const active = document.activeElement;
	const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
		.filter(element => !element.matches(':disabled, [tabindex="-1"]') && !element.closest('[inert], [hidden]')
			&& (element.getClientRects().length > 0 || element === active));
	const first = focusable[0];
	const last = focusable[focusable.length - 1];
	if (!first || (!root.contains(active) || (event.shiftKey ? active === first || active === root : active === last))) {
		event.preventDefault();
		(event.shiftKey ? last ?? root : first ?? root).focus({ preventScroll: true });
	}
}

interface FieldFocus { field: HTMLElement; selection?: [number, number, 'forward' | 'backward' | 'none']; range?: Range }
const returnFields = new WeakMap<HTMLElement, FieldFocus>();
let pointerSource: { trigger: HTMLElement; focus: FieldFocus } | undefined;

/** A pointer usually transfers focus to the button before React receives its click. Capture the editing position first. */
function readFieldFocus(element: Element | null): FieldFocus | undefined {
	if (!(element instanceof HTMLElement)) return;
	if (element instanceof HTMLSelectElement) return { field: element };
	if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
		if (element instanceof HTMLInputElement && element.matches('[type=button], [type=submit], [type=checkbox], [type=radio], [type=reset]')) return;
		if (element.selectionStart === null || element.selectionEnd === null) return { field: element };
		return { field: element, selection: [element.selectionStart, element.selectionEnd, element.selectionDirection ?? 'none'] };
	}
	if (element.isContentEditable) {
		const selection = element.ownerDocument.getSelection();
		return { field: element, range: selection?.rangeCount && element.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : undefined };
	}
	return undefined;
}

/** Install only for dashboard and board pages. A keyboard-opened dialog goes back to its keyboard trigger. */
export function useWidgetDialogFocusHistory(): void {
	useEffect(() => {
		const remember = (event: PointerEvent) => {
			if (!(event.target instanceof Element) || event.target.closest('[aria-modal="true"]')) return;
			const trigger = event.target.closest<HTMLElement>('button, [aria-haspopup="dialog"], [data-qn-sticky]');
			const focus = readFieldFocus(document.activeElement);
			if (trigger && focus) pointerSource = { trigger, focus };
			else if (!trigger || trigger !== pointerSource?.trigger) pointerSource = undefined;
		};
		const clear = () => { pointerSource = undefined; };
		document.addEventListener('pointerdown', remember, true);
		document.addEventListener('keydown', clear, true);
		return () => {
			document.removeEventListener('pointerdown', remember, true);
			document.removeEventListener('keydown', clear, true);
			clear();
		};
	}, []);
}

export function rememberWidgetDialogOpener(opener: HTMLElement | null): void {
	if (!opener) return;
	const focus = pointerSource?.trigger === opener ? pointerSource.focus : readFieldFocus(opener);
	if (focus) returnFields.set(opener, focus);
	else returnFields.delete(opener);
	pointerSource = undefined;
}

/** Return the caret on explicit close, unless the user already moved to another control or opened another dialog. */
export function restoreWidgetDialogFocus(opener: HTMLElement | null, fallback = opener): boolean {
	// When another VS Code pane owns the keyboard, activeElement can still point to the old field.
	if (!document.hasFocus()) return false;
	const previous = opener ? returnFields.get(opener) : undefined;
	const active = document.activeElement;
	if (document.querySelector('[aria-modal="true"]')) return false;
	if (active && active !== document.body && active !== opener && active !== fallback) return false;
	let field = previous?.field;
	if (field && !field.isConnected) {
		const name = field.getAttribute('name');
		const matches = name ? document.getElementsByName(name) : [];
		const replacement = field.id ? document.getElementById(field.id) : matches.length === 1 ? matches[0] : null;
		field = replacement instanceof HTMLElement && replacement.tagName === field.tagName ? replacement : undefined;
	}
	if (previous && field?.isConnected && !field.matches(':disabled') && !field.closest('[inert], [hidden]')) {
		const { selection, range } = previous;
		field.focus({ preventScroll: true });
		if (selection && (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) field.setSelectionRange(...selection);
		else if (range && field.contains(range.commonAncestorContainer)) {
			const selection = field.ownerDocument.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
		}
		if (opener) returnFields.delete(opener);
		return true;
	}
	if (!fallback?.isConnected) return false;
	fallback.focus({ preventScroll: true });
	return true;
}

/** Retain the last real field when a focused confirmation/control is removed or temporarily disabled. */
export function useQuickNotesFocusFallback(rootRef: RefObject<HTMLElement>, enabled = true): void {
	const lastField = useRef<HTMLElement>();
	const previousControl = useRef<HTMLElement>();
	useLayoutEffect(() => {
		const root = rootRef.current;
		if (!root || !enabled) return;
		const doc = root.ownerDocument;
		const clear = () => { previousControl.current = undefined; lastField.current = undefined; };
		const track = (event: FocusEvent) => {
			const control = event.target;
			if (!(control instanceof HTMLElement) || !root.contains(control)) { clear(); return; }
			previousControl.current = control;
			if (control.matches('input, textarea, select, [contenteditable="true"]')) lastField.current = control;
		};
		doc.addEventListener('focusin', track);
		doc.defaultView?.addEventListener('blur', clear);
		return () => {
			doc.removeEventListener('focusin', track);
			doc.defaultView?.removeEventListener('blur', clear);
			clear();
		};
	}, [enabled, rootRef]);
	useEffect(() => {
		const root = rootRef.current;
		const previous = previousControl.current;
		// Only recover an actual lost control. A render or a switch to the chat is not a focus request.
		if (!enabled || !root?.isConnected || !previous || !root.ownerDocument.hasFocus()) return;
		if (root.contains(previous) && !previous.matches(':disabled') && !previous.closest('[hidden], [inert]')) return;
		previousControl.current = undefined;
		const active = root.ownerDocument.activeElement;
		if (active && active !== document.body && active !== root) return;
		const field = lastField.current;
		const target = field && root.contains(field) && !field.matches(':disabled') && !field.closest('[hidden], [inert]') ? field : root;
		if (active !== target) target.focus({ preventScroll: true });
	});
}
