import React, { useLayoutEffect, useRef } from 'react';

/** Center dashboard editors inside the visible widget rail while keeping the backdrop over the entire page. */
export function WidgetDialogOverlay({ children, onBackdrop }: { children: React.ReactNode; onBackdrop(): void }) {
	const overlay = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const rail = document.querySelector<HTMLElement>('[data-pm-prompt-dashboard]');
		const element = overlay.current;
		if (!rail || !element) return;
		const align = () => {
			const rect = rail.getBoundingClientRect();
			const width = document.documentElement.clientWidth;
			const height = document.documentElement.clientHeight;
			const left = Math.max(0, Math.min(width, rect.left));
			const right = Math.max(0, width - Math.max(0, rect.right));
			const top = Math.max(0, Math.min(height, rect.top));
			const bottom = Math.max(0, height - Math.max(0, rect.bottom));
			// A stacked rail can scroll completely offscreen; keep the editor reachable in that viewport.
			const horizontal = left + right < width;
			const vertical = top + bottom + 120 < height;
			element.style.padding = [vertical ? top : 0, horizontal ? right : 0, vertical ? bottom : 0, horizontal ? left : 0]
				.map(inset => (inset + 12) + 'px').join(' ');
		};
		element.classList.add('pm-dashboard-dialog-overlay');
		align();
		const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(align);
		observer?.observe(rail);
		const scrolled = (event: Event) => {
			if (event.target === document || (event.target instanceof Element && event.target !== rail && event.target.contains(rail))) align();
		};
		window.addEventListener('resize', align);
		window.addEventListener('scroll', scrolled, true);
		return () => {
			observer?.disconnect();
			window.removeEventListener('resize', align);
			window.removeEventListener('scroll', scrolled, true);
		};
	}, []);
	return <div ref={overlay} className="pm-qn-overlay pm-qn-scope" role="presentation"
		onMouseDown={event => { if (event.target === event.currentTarget) onBackdrop(); }}>{children}</div>;
}
