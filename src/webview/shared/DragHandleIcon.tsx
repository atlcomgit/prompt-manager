import React from 'react';

/** Общая ручка разделов и виджетов не зависит от загрузки шрифтов внутри webview. */
export function DragHandleIcon(): React.ReactElement {
	return (
		<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={{ width: 14, height: 14 }}>
			<circle cx="5" cy="4" r="1" fill="currentColor" />
			<circle cx="5" cy="8" r="1" fill="currentColor" />
			<circle cx="5" cy="12" r="1" fill="currentColor" />
			<circle cx="11" cy="4" r="1" fill="currentColor" />
			<circle cx="11" cy="8" r="1" fill="currentColor" />
			<circle cx="11" cy="12" r="1" fill="currentColor" />
		</svg>
	);
}
