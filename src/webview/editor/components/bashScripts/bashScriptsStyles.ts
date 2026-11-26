/** Плоский список с высотой строк как у быстрых заметок использует общую прокрутку панели. */
export const BASH_SCRIPTS_CSS = `
.pm-bs {
	--bs-run: var(--vscode-testing-iconPassed, var(--vscode-charts-green, var(--vscode-terminal-ansiGreen, #39834d)));
	--bs-result: var(--vscode-descriptionForeground);
	--bs-border: var(--vscode-panel-border, var(--vscode-widget-border, var(--vscode-descriptionForeground)));
	container-type: inline-size; display: grid; min-width: 0; gap: 2px 4px;
	grid-template-columns: max-content minmax(0, 1fr) max-content max-content max-content;
}
/* Share the action widths throughout the tree so clocks, flags and long names cannot shift the path column. */
.pm-bs > *, .pm-bs-heading, .pm-bs-history, .pm-bs-hide { grid-column: 1 / -1; }
.pm-bs-groups, .pm-bs-group, .pm-bs-list, .pm-bs-folder, .pm-bs-entry, .pm-bs-row { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; }
.pm-bs-actions [data-active] { color: var(--vscode-textLink-foreground); }
.pm-bs-filters { display: flex; flex-wrap: wrap; gap: 4px; padding-bottom: 3px; min-width: 0; }
.pm-bs-filters input { flex: 1 1 160px; }
.pm-bs-filters > div { flex: 1 1 200px; }
.pm-bs-filters > div, .pm-bs-path, .pm-bs-editor-fields { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
.pm-bs-filters input, .pm-bs-filters select, .pm-bs-editor select {
	box-sizing: border-box; font: inherit; font-size: 12px; padding: 5px 7px; min-width: 0; border-radius: 4px;
	border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
	background: var(--vscode-input-background); color: var(--vscode-input-foreground);
}
.pm-bs-filters select { flex: 1 1 75px; }
/* Внутренняя рамка не меняет высоту строк и свёрнутых заголовков. Все проекты лежат в одной общей рамке. */
.pm-bs-groups, .pm-bs-folder {
	min-width: 0; outline: 1px solid var(--vscode-contrastBorder, color-mix(in srgb, var(--vscode-foreground) 30%, transparent));
	outline-offset: -1px; border-radius: 5px;
}
.pm-bs-group { min-width: 0; }
/* Соседние проекты разделяет тонкая линия без промежутка, поэтому общая рамка остаётся сплошной. */
.pm-bs-group + .pm-bs-group {
	border-block-start: 1px solid var(--vscode-contrastBorder, color-mix(in srgb, var(--vscode-foreground) 20%, transparent));
}
/*
 * Заголовок проекта лежит между шапкой виджета (sideBar) и фоном блока (editor): 40% шапки и 60% фона.
 * Шапка бывает и темнее, и светлее фона, поэтому смесь не сливается с ней ни в светлой, ни в тёмной теме.
 * Скругляются только углы, совпадающие с углами общей рамки.
 */
.pm-bs-group > .pm-bs-heading {
	background: color-mix(in srgb, var(--vscode-sideBar-background) 40%, var(--vscode-editor-background));
}
.pm-bs-group:first-child > .pm-bs-heading { border-radius: 4px 4px 0 0; }
.pm-bs-group:last-child > .pm-bs-heading:only-child { border-end-start-radius: 4px; border-end-end-radius: 4px; }
/* Содержимое подгруппы отступает от её рамки, чтобы заголовок папки и строки не прилегали к линии. */
.pm-bs-folder {
	outline-color: var(--vscode-contrastBorder, color-mix(in srgb, var(--vscode-foreground) 20%, transparent));
	border-radius: 3px; padding: 4px 8px;
}
.pm-bs-heading { display: flex; align-items: center; min-width: 0; }
.pm-bs-heading .pm-bs-group-toggle { flex: 1; min-width: 0; }
.pm-bs-heading .pm-bs-group-toggle:focus-visible { outline-offset: -3px; }
.pm-bs-order-actions { display: inline-flex; flex: none; }
.pm-bs-order-actions .pm-qn-icon-btn { width: 20px; height: 22px; }
.pm-bs .pm-bs-order-actions button[aria-disabled=true] { color: var(--vscode-disabledForeground); cursor: default; }
.pm-bs-up { transform: rotate(180deg); }
.pm-bs-group-toggle, .pm-bs-row {
	display: flex; align-items: center; gap: 4px; width: 100%; min-width: 0; box-sizing: border-box; border-radius: 4px;
}
.pm-bs-group-toggle {
	height: 24px; padding: 0 4px; border: 0; background: transparent; color: var(--vscode-descriptionForeground);
	font: inherit; font-size: 12px; text-align: start; cursor: pointer;
}
.pm-bs-group-toggle:hover, .pm-bs-row:is(:hover, :focus-within) { background: var(--vscode-list-hoverBackground); }
.pm-bs-group-toggle > svg, .pm-bs-group-count { flex: none; }
.pm-bs-group-name { font-weight: 600; color: var(--vscode-foreground); }
.pm-bs-group-name, .pm-bs-group-path, .pm-bs-name, .pm-bs-path-hint {
	min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pm-bs-group-path, .pm-bs-path-hint { font: 11px var(--vscode-editor-font-family, monospace); color: var(--vscode-descriptionForeground); }
.pm-bs-group-path { flex-shrink: 2; }
.pm-bs-group-count { margin-inline-start: auto; padding-inline: 4px; font-size: 11px; font-variant-numeric: tabular-nums; }
.pm-bs-list, .pm-bs-history ol { padding: 0; margin: 0; list-style: none; }
.pm-bs-list { margin-inline-start: 9px; }
/* Рамки подгрупп разделены промежутком 4 px. От заголовка проекта их отделяют 3 px, от низа проекта — 4 px. */
.pm-bs-group > .pm-bs-list:has(> .pm-bs-folder) {
	margin-block: 3px 4px; margin-inline: 6px 3px; row-gap: 4px;
}
.pm-bs-row {
	position: relative;
	display: grid;
	height: 24px; padding: 0 3px;
}
.pm-bs-row[data-runnable], .pm-bs-row button:enabled { cursor: pointer; }
.pm-bs-row .pm-bs-drag:enabled { cursor: grab; color: var(--vscode-descriptionForeground); }
.pm-bs-row .pm-bs-drag:active { cursor: grabbing; }
.pm-bs-row[data-drop="before"] { box-shadow: inset 0 2px var(--vscode-focusBorder); }
.pm-bs-row[data-drop="after"] { box-shadow: inset 0 -2px var(--vscode-focusBorder); }
/* Keep the name and path on one line, reserving most of the available text width for the name. */
.pm-bs-details { display: grid; grid-template-columns: minmax(0, 1fr) min(32%, 18ch); gap: 4px; align-self: stretch; align-items: center; min-width: 0; }
.pm-bs-name-cell {
	position: relative; isolation: isolate; align-self: stretch;
	display: flex; align-items: center; gap: 2px; min-width: 0;
}
.pm-bs-name { font-size: 13px; line-height: 16px; }
.pm-bs-name[data-favorite] { font-weight: 700; }
.pm-bs-name-cell .pm-bs-favorite { width: 18px; height: 18px; }
.pm-bs-favorite[aria-pressed=true] { color: var(--vscode-charts-yellow, var(--vscode-foreground)); }
/* Leave the title its full width until a pointer or keyboard user interacts with the row. */
@media (hover: hover) {
	.pm-bs-row:not(:hover, :focus-within) .pm-bs-favorite[aria-pressed=false] {
		position: absolute; opacity: 0; pointer-events: none;
	}
}
.pm-bs-path-hint {
	/* Clip the directory prefix first. The isolated text keeps its original reading order. */
	direction: rtl; text-align: left; background: transparent;
	color: color-mix(in srgb, var(--vscode-descriptionForeground) 93%, var(--vscode-editor-background));
}
body:is(.vscode-high-contrast, .vscode-high-contrast-light) .pm-bs-path-hint { color: var(--vscode-descriptionForeground); }
.pm-bs-row .pm-bs-play { width: 20px; color: var(--bs-run); }
.pm-bs-row .pm-bs-play:disabled { color: var(--vscode-disabledForeground); opacity: 1; cursor: default; }
.pm-bs-row .pm-bs-play[aria-busy=true] { color: var(--vscode-foreground); }
.pm-bs [data-outcome=success] { --bs-result: var(--bs-run); }
.pm-bs [data-outcome=error] { --bs-result: var(--vscode-testing-iconFailed, var(--vscode-charts-red, #d44444)); }
.pm-bs [data-outcome=running] { --bs-result: var(--vscode-foreground); }
.pm-bs-tools, .pm-bs-flags, .pm-bs-global, .pm-bs-availability, .pm-bs-last-run { display: inline-flex; align-items: center; }
.pm-bs-flags { gap: 2px; }
.pm-bs-global, .pm-bs-last-run { color: var(--vscode-descriptionForeground); }
.pm-bs-tools .pm-qn-icon-btn, .pm-bs-terminal-slot { width: 20px; height: 22px; }
/* Reserve the terminal action even before the first launch, keeping the name column stationary. */
.pm-bs-tools { justify-content: end; }
.pm-bs-availability { gap: 3px; color: var(--vscode-editorWarning-foreground); font-size: 11px; }
/* Give the timer a stable width for each duration format, including the transition from milliseconds to seconds. */
.pm-bs-last-run {
	justify-content: end; gap: 4px; box-sizing: border-box; width: calc(10ch + 23px); height: 22px; padding: 0 3px; border: 0; border-radius: 3px;
	background: transparent; font: inherit; font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; cursor: pointer;
}
.pm-bs-last-run:is(:hover, [aria-expanded=true]) { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
.pm-bs-last-run > span, .pm-bs-duration { color: var(--bs-result); }
.pm-bs-last-run > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.pm-bs-last-run > svg { flex: none; }
.pm-bs-duration-short, .pm-bs-duration-clock { display: none; }
/* Reserve more of a narrow widget for the script name. The history tooltip keeps the full duration. */
@container (max-width: 520px) {
	.pm-bs-last-run { width: calc(9ch + 23px); }
	.pm-bs-duration-full { display: none; }
	.pm-bs-duration-short { display: inline; }
}
@container (max-width: 480px) {
	.pm-bs-availability > span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
	.pm-bs-row, .pm-bs-details { column-gap: 3px; }
	.pm-bs-path-hint { font-size: 10px; }
}
@container (max-width: 350px) {
	.pm-bs-last-run { width: calc(8ch + 23px); }
	.pm-bs-duration-short { display: none; }
	.pm-bs-duration-clock { display: inline; }
}
.pm-bs-history, .pm-bs-hide { margin: 1px 0 4px 23px; }
.pm-bs-history { padding-inline-start: 3px; font-size: 11px; color: var(--vscode-descriptionForeground); }
.pm-bs-history li { position: relative; padding: 3px 2px 5px 14px; }
.pm-bs-history li::before, .pm-bs-history li::after { content: ''; position: absolute; }
.pm-bs-history li:not(:last-child)::before { inset-inline-start: 3px; inset-block: 10px -10px; border-inline-start: 1px solid var(--bs-border); }
.pm-bs-history li::after { inset: 8px auto auto 1px; width: 5px; height: 5px; border-radius: 50%; background: var(--bs-result); }
.pm-bs-event-heading, .pm-bs-measure { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
.pm-bs-event-heading { flex-wrap: wrap; row-gap: 0; }
.pm-bs-event-heading time { color: var(--vscode-foreground); font-variant-numeric: tabular-nums; }
.pm-bs-measure { display: grid; grid-template-columns: minmax(0, 1fr) 8ch; align-items: center; padding-block: 2px; }
.pm-bs-track, .pm-bs-bar { display: block; height: 3px; border-radius: 2px; }
.pm-bs-track { background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent); }
.pm-bs-bar { background: var(--bs-result); }
.pm-bs-live { overflow: hidden; --bs-result: var(--vscode-descriptionForeground); }
/* The 20px track leaves 2px around the 16px label and extends 4px past the start of its column. */
.pm-bs-name-cell > .pm-bs-live {
	position: absolute; inset: 2px 0 2px -4px; z-index: -1; pointer-events: none; box-sizing: border-box; height: auto;
	border-radius: 4px; background: #303338; --bs-result: #505861;
	outline: 1px solid var(--vscode-contrastBorder, #454a50); outline-offset: -1px;
}
.pm-bs-name-cell > .pm-bs-live .pm-bs-bar { border-radius: 0; }
.pm-bs-name-cell:has(> .pm-bs-live) .pm-bs-name { color: #f2f3f5; }
body:is(.vscode-light, .vscode-high-contrast-light) .pm-bs-name-cell > .pm-bs-live {
	background: #c3cad1; --bs-result: #929eab;
	outline-color: var(--vscode-contrastBorder, #858f99);
}
body:is(.vscode-light, .vscode-high-contrast-light) .pm-bs-name-cell:has(> .pm-bs-live) .pm-bs-name { color: #202328; }
.pm-bs-live .pm-bs-bar { height: 100%; }
.pm-bs-live:not([aria-valuenow]) .pm-bs-bar { width: 33.3333%; animation: pm-bs-wait 1.4s ease-in-out infinite alternate; }
@keyframes pm-bs-wait { to { transform: translateX(200%); } }
@media (prefers-reduced-motion: reduce) {
	.pm-bs-live:not([aria-valuenow]) .pm-bs-bar { width: 100%; animation: none; background: repeating-linear-gradient(90deg, var(--bs-result) 0 3px, transparent 3px 7px); }
}
.pm-bs-duration { text-align: end; white-space: nowrap; font-variant-numeric: tabular-nums; }
.pm-bs-unknown { display: block; padding-block: 2px; }
@media (forced-colors: active) {
	.pm-bs-history li::after, .pm-bs-bar { forced-color-adjust: none; }
	.pm-bs-track { border-block-end: 1px solid GrayText; }
	body .pm-bs .pm-bs-name-cell > .pm-bs-live {
		forced-color-adjust: none; background: Canvas; --bs-result: color-mix(in srgb, CanvasText 32%, Canvas);
		border: 1px solid GrayText; outline: none;
	}
}
.pm-bs-hide { display: flex; align-items: center; flex-wrap: wrap; gap: 3px 8px; padding: 2px 0 2px 8px; border-inline-start: 1px solid var(--bs-border); font-size: 12px; }
.pm-bs-hide > span { flex: 1 1 170px; overflow-wrap: anywhere; }
.pm-bs :focus-visible, .pm-bs-actions :focus-visible, .pm-bs-editor :focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.pm-bs-editor label { display: block; font-size: 12px; }
.pm-bs-editor-fields { align-items: end; gap: 8px; }
.pm-bs-editor-fields label:first-child { flex: 1 1 160px; }
.pm-bs-editor input, .pm-bs-editor textarea, .pm-bs-editor select { width: 100%; box-sizing: border-box; }
.pm-bs-editor label > input, .pm-bs-editor label > textarea, .pm-bs-editor label > select, .pm-bs-path { display: block; margin-top: 4px; }
.pm-bs-editor .pm-bs-path { display: flex; }
.pm-bs-path input { flex: 1 1 110px; min-width: 0; }
/* Кнопки копирования не сжимаются: при нехватке ширины переносится весь ряд, а не подпись. */
.pm-bs-copy-path { flex: none; }
/* Сообщение для экранного диктора не занимает место в ряду и не сдвигает кнопки. */
.pm-bs-sr-status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.pm-bs-editor textarea { tab-size: 4; resize: vertical; min-height: 80px; line-height: 1.45; }
.pm-bs-editor .pm-qn-modal-f > span { flex: 1 1 100px; }
.pm-bs-editor .pm-qn-modal-f > [role=alert] { flex-basis: 100%; }
.pm-bs-folder-title { display: flex; align-items: center; gap: 5px; padding: 3px 4px; font-size: 11px; color: var(--vscode-descriptionForeground); }
.pm-bs-heading .pm-bs-folder-visibility { width: 20px; height: 20px; flex: none; }
.pm-bs-folder[data-hidden] > .pm-bs-heading .pm-bs-folder-title { font-style: italic; opacity: .8; }
.pm-bs-folder-title svg { flex: none; }
.pm-bs-folder-title span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;
