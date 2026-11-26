import type { ExtensionToWebviewMessage } from '../../types/messages.js';

/** The first resize requests geometry immediately. During a divider drag, also send the final width. */
const RESIZE_QUERY_INTERVAL_MS = 80;

function measure(view: Window) {
	return { width: view.innerWidth, height: view.innerHeight, outerWidth: view.outerWidth, outerHeight: view.outerHeight };
}

/** A side-by-side split halves the previous single group's width, with pixel rounding at the divider. */
function looksLikeEqualSplit(single: ReturnType<typeof measure>, current: ReturnType<typeof measure>): boolean {
	const remainingPixels = single.width - 2 * current.width;
	return current.width > 0 && remainingPixels >= 0 && remainingPixels <= 2
		&& single.height === current.height && single.outerWidth === current.outerWidth && single.outerHeight === current.outerHeight;
}

/** Preview splitting or rejoining editor groups before paint, then reconcile with the workbench. */
export function observePromptEditorGroupLayout(
	view: Window,
	requestLayout: (width: number) => void,
	setHidden: (hidden: boolean, beforePaint: boolean) => void,
): () => void {
	let singleGroup: ReturnType<typeof measure> | undefined;
	let hiddenSplit: { fullWidth: number; roundingTolerance: number; outerWidth: number } | undefined;
	let previousWidth = view.innerWidth;
	let confirmedHidden = false;
	let displayedHidden = false;
	let timer: number | undefined;
	let resizePending = false;

	function display(hidden: boolean, beforePaint: boolean) {
		if (displayedHidden === hidden) return;
		displayedHidden = hidden;
		setHidden(hidden, beforePaint);
	}

	function sendResize() {
		resizePending = false;
		requestLayout(view.innerWidth);
		timer = view.setTimeout(() => {
			timer = undefined;
			if (resizePending) sendResize();
		}, RESIZE_QUERY_INTERVAL_MS);
	}

	function onResize() {
		const current = measure(view);
		if (singleGroup) {
			// An ordinary sidebar drag can cross half width in small steps.
			const splitStarted = previousWidth === singleGroup.width && looksLikeEqualSplit(singleGroup, current);
			const stillNarrower = displayedHidden && current.width <= singleGroup.width / 2;
			display(splitStarted || stillNarrower, true);
		} else if (hiddenSplit && current.outerWidth === hiddenSplit.outerWidth) {
			if (displayedHidden && current.width > previousWidth
				&& Math.abs(current.width - hiddenSplit.fullWidth) <= hiddenSplit.roundingTolerance) {
				// Use the actual restored width if the user splits again before the reply arrives.
				hiddenSplit.fullWidth = current.width;
				display(false, true);
			} else if (!displayedHidden && current.width <= hiddenSplit.fullWidth / 2) {
				display(true, true);
			}
		}
		previousWidth = current.width;
		if (timer === undefined) sendResize();
		else resizePending = true;
	}

	function onMessage(event: MessageEvent<ExtensionToWebviewMessage>) {
		const message = event.data;
		if (message?.type !== 'promptEditorGroupLayoutChanged') return;
		const current = measure(view);
		// An answer sampled before this resize cannot invalidate a preview or establish a new single-group width.
		const staleWidth = message.viewportWidth !== undefined && message.viewportWidth !== current.width;
		const previewActive = displayedHidden !== confirmedHidden;
		if (staleWidth && (singleGroup || message.singleGroup || previewActive)) return;
		if (message.viewportWidth === undefined && previewActive) return;
		singleGroup = message.singleGroup && current.width > 0 ? current : undefined;
		const fraction = message.groupWidthFraction;
		if (!message.hideDashboard || typeof fraction !== 'number' || !(fraction > 0 && fraction <= 0.5)) {
			hiddenSplit = undefined;
		} else if (!staleWidth && message.viewportWidth === current.width && current.width > 0) {
			// Convert the pane's CSS width and its two-pixel rounding allowance into full-editor coordinates.
			hiddenSplit = { fullWidth: current.width / fraction, roundingTolerance: 2 / fraction, outerWidth: current.outerWidth };
		}
		confirmedHidden = message.hideDashboard;
		display(confirmedHidden, false);
	}

	view.addEventListener('message', onMessage);
	view.addEventListener('resize', onResize);
	requestLayout(view.innerWidth);
	return () => {
		view.removeEventListener('message', onMessage);
		view.removeEventListener('resize', onResize);
		view.clearTimeout(timer);
	};
}
