/**
 * Стили и цвета быстрых заметок: виджет, окно заметки и доска.
 * Классы с префиксом pm-qn- не пересекаются со стилями редактора; наведение и фокус требуют CSS, а не inline-стилей.
 */
import { QUICK_NOTE_PALETTE_COLORS, type QuickNotePaletteColor } from '../../../../types/quickNotes.js';
import { normalizeQuickNoteColor, QUICK_NOTE_NO_COLOR_KEY } from '../../../../utils/quickNotes.js';

/** Подписи цветов палитры для подсказок и ARIA. */
export const QUICK_NOTE_COLOR_LABELS: Record<QuickNotePaletteColor, string> = {
	red: 'Красный',
	orange: 'Оранжевый',
	yellow: 'Жёлтый',
	green: 'Зелёный',
	blue: 'Синий',
	purple: 'Фиолетовый',
	pink: 'Розовый',
	teal: 'Бирюзовый',
};

/** CSS-значение цвета заметки; пустая строка — заметка без цвета. */
export function resolveQuickNoteColorCss(color: string): string {
	const normalized = normalizeQuickNoteColor(color);
	if (!normalized) {
		return '';
	}
	if (normalized.startsWith('#')) {
		return normalized;
	}
	return normalized === 'pink' || normalized === 'teal'
		? `var(--pm-qn-${normalized})`
		: `var(--vscode-charts-${normalized})`;
}

/** Подпись ключа цвета для фильтров и колонок доски. */
export function resolveQuickNoteColorLabel(colorKey: string): string {
	if (colorKey === QUICK_NOTE_NO_COLOR_KEY || !colorKey) {
		return 'Без цвета';
	}
	return (QUICK_NOTE_PALETTE_COLORS as readonly string[]).includes(colorKey)
		? QUICK_NOTE_COLOR_LABELS[colorKey as QuickNotePaletteColor]
		: `Свой цвет ${colorKey}`;
}

/** Общие кнопки и счётчики заголовков нужны и при скрытом виджете заметок. */
export const QUICK_WIDGET_ACTIONS_CSS = `
.pm-qn-icon-btn {
	display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0;
	border: none; border-radius: 4px; background: transparent; cursor: pointer; flex-shrink: 0;
	color: color-mix(in srgb, var(--vscode-foreground) 74%, var(--vscode-descriptionForeground));
}
.pm-qn-icon-btn:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
.pm-qn-icon-btn:disabled { opacity: 0.5; cursor: default; }
.pm-qn-count {
	min-width: 18px; padding: 1px 6px; border-radius: 9px; text-align: center; font-size: 10px; font-weight: 700;
	background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
}
.pm-qn-header-actions { display: inline-flex; align-items: center; gap: 2px; }
`;

/** Полный набор стилей заметок для панели и отдельной вкладки доски. */
export const QUICK_NOTES_CSS = `${QUICK_WIDGET_ACTIONS_CSS}
/* Розовый и бирюзовый не входят в цвета диаграмм VS Code: свои значения для тёмной и светлой темы. */
:root { --pm-qn-pink: #e06c9f; --pm-qn-teal: #4ec9b0; }
body.vscode-light, body.vscode-high-contrast-light { --pm-qn-pink: #c2185b; --pm-qn-teal: #16825d; }
.pm-qn-scope ::selection, .pm-qn-scope::selection { background: var(--vscode-editor-selectionBackground); }
.pm-qn-scope button { font-family: inherit; }
.pm-qn-scope button:focus-visible, .pm-qn-scope [tabindex]:focus-visible, .pm-qn-scope input:focus-visible,
.pm-qn-scope textarea:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }

/* Тело виджета. */
.pm-qn { display: flex; flex-direction: column; gap: 8px; }
.pm-qn-add {
	display: flex; align-items: center; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
	border-radius: 4px; background: var(--vscode-input-background);
}
.pm-qn-add:focus-within { border-color: var(--vscode-focusBorder); }
.pm-qn-add-lead { display: inline-flex; padding: 0 2px 0 8px; color: var(--vscode-descriptionForeground); }
.pm-qn-add textarea {
	flex: 1; min-width: 0; min-height: 28px; max-height: 120px; padding: 5px 6px 4px 4px;
	border: none; outline: none !important; resize: vertical; box-sizing: border-box;
	background: transparent; color: var(--vscode-input-foreground); font: inherit; font-size: 13px;
	line-height: 18px; overflow-y: auto; field-sizing: content;
}
.pm-qn-add textarea::placeholder, .pm-qn-input::placeholder, .pm-qn-textarea::placeholder {
	color: var(--vscode-input-placeholderForeground);
}
.pm-qn-scope-toggle {
	display: inline-flex; align-items: center; gap: 4px; height: 22px; margin-right: 3px; padding: 0 7px; border: none;
	border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
	font-size: 11px; cursor: pointer; white-space: nowrap;
}
.pm-qn-scope-toggle:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
.pm-qn-scope-toggle:disabled { opacity: 0.7; cursor: default; }
.pm-qn-hint { font-size: 11px; line-height: 1.45; color: var(--vscode-descriptionForeground); }
.pm-qn-hint code { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
.pm-qn-hint kbd {
	padding: 0 4px; border: 1px solid var(--vscode-panel-border); border-bottom-width: 2px; border-radius: 3px;
	font-family: inherit; font-size: 10px;
}
.pm-qn-filters { display: flex; align-items: center; gap: 8px; }
.pm-qn-search {
	flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; height: 24px; padding: 0 6px;
	border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px;
	background: var(--vscode-input-background); color: var(--vscode-descriptionForeground);
}
.pm-qn-search:focus-within { border-color: var(--vscode-focusBorder); }
.pm-qn-search input {
	flex: 1; min-width: 0; border: none; outline: none !important; background: transparent;
	color: var(--vscode-input-foreground); font: inherit; font-size: 12px;
}
.pm-qn-dots { display: flex; align-items: center; gap: 2px; }
.pm-qn-dot {
	width: 12px; height: 12px; margin: 2px; padding: 0; border-radius: 50%; border: none; cursor: pointer; opacity: 0.55;
}
.pm-qn-dot.is-none { background: transparent; border: 1px dashed var(--vscode-descriptionForeground); }
.pm-qn-dots.is-all .pm-qn-dot, .pm-qn-dot[aria-pressed="true"] { opacity: 1; }
.pm-qn-dot[aria-pressed="true"] {
	box-shadow: 0 0 0 2px var(--vscode-editor-background), 0 0 0 3px var(--vscode-foreground);
}


/* Focused editor overlays the note list instead of changing widget layout height. */
.pm-qn-add-slot { position: relative; height: 30px; min-width: 0; }
.pm-qn-add-slot > .pm-qn-add { min-height: 28px; width: 100%; box-sizing: border-box; }
.pm-qn-add.is-expanded {
	position: absolute; left: 0; right: 0; top: 0; z-index: 90;
	display: flex; flex-direction: column; align-items: stretch;
	background: color-mix(in srgb, var(--vscode-input-background) 94%, transparent);
	backdrop-filter: blur(5px);
	border-color: var(--vscode-focusBorder);
	box-shadow: 0 9px 25px var(--vscode-widget-shadow, rgba(0,0,0,.35));
}
.pm-qn-add.is-expanded textarea {
	width: 100%; min-height: 90px; max-height: 280px;
	padding: 8px; resize: none; transition: height .16s ease;
	background: transparent;
}
.pm-qn-add:not(.is-expanded) textarea { height: 28px !important; resize: none; }
/* На узкой карточке образцы цвета переносятся внутри средней колонки, а область остаётся справа. */
.pm-qn-add-colors {
	display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 6px 8px;
	border-top: 1px solid var(--vscode-panel-border);
}
.pm-qn-add-tools {
	display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 6px;
	padding: 5px 7px; border-top: 1px solid var(--vscode-panel-border);
}
/* Keep the draft reset at the left edge of the action row. */
.pm-qn-add-clear { margin-right: auto; }
.pm-qn-row.is-copied { outline: 1px solid var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground); }
.pm-qn-row.is-pinned::before { background: var(--vscode-charts-yellow, #d7ba7d); }
.pm-qn-context-menu {
	position: fixed; z-index: 3000; box-sizing: border-box; width: max-content;
	min-width: min(230px, calc(100vw - 16px)); max-width: calc(100vw - 16px);
	max-height: calc(100vh - 16px); overflow: auto;
	background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
	color: var(--vscode-menu-foreground, var(--vscode-foreground));
	border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
	border-radius: 5px; padding: 5px; box-shadow: 0 8px 25px var(--vscode-widget-shadow, rgba(0,0,0,.35));
}
.pm-qn-context-menu > button {
	display: block; width: 100%; text-align: left; padding: 7px 9px; color: inherit; border: 0; background: none;
	border-radius: 3px; cursor: pointer; font: inherit; font-size: 12px;
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pm-qn-context-menu > button:hover, .pm-qn-context-menu > button:focus-visible { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, var(--vscode-foreground)); }
.pm-qn-context-colors { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; border-top: 1px solid var(--vscode-panel-border); margin: 5px 0; padding: 6px 4px; font-size: 11px; }
.pm-qn-context-color { width: 16px; height: 16px; padding: 0; border-radius: 50%; border: 1px solid var(--vscode-panel-border); cursor: pointer; }
.pm-qn-menu-error { font-size: 11px; padding: 7px; color: var(--vscode-errorForeground); }
@media (prefers-reduced-motion: reduce) { .pm-qn-add.is-expanded textarea { transition: none; } }

/* Строки заметок фиксированной высоты с цветной полосой слева. */
.pm-qn-list { display: flex; flex-direction: column; margin: 0 -4px; }
.pm-qn-row {
	position: relative; display: flex; align-items: center; gap: 4px; height: 28px; padding: 0 4px 0 7px;
	border-radius: 4px; min-width: 0; cursor: pointer;
}
.pm-qn-row::before {
	content: ""; position: absolute; left: 1px; top: 5px; bottom: 5px; width: 3px; border-radius: 2px;
	background: var(--pm-qn-note, transparent);
}
.pm-qn-row:hover, .pm-qn-row:focus-within, .pm-qn-row[aria-controls] { background: var(--vscode-list-hoverBackground); }
.pm-qn-row.is-selected {
	background: var(--vscode-list-activeSelectionBackground);
	color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
	box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
}
.pm-qn-row .pm-qn-grip { opacity: 0; }
.pm-qn-row:hover .pm-qn-grip, .pm-qn-row:focus-within .pm-qn-grip { opacity: 1; }
.pm-qn-grip > button { width: 14px !important; height: 18px !important; }
.pm-qn-check {
	width: 15px; height: 15px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; padding: 0;
	border: 1px solid var(--vscode-checkbox-border, var(--vscode-input-border, var(--vscode-panel-border)));
	border-radius: 3px; background: var(--vscode-checkbox-background, var(--vscode-input-background));
	color: var(--vscode-button-foreground); cursor: pointer;
}
.pm-qn-check[aria-checked="true"] { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
.pm-qn-check.is-small { width: 13px; height: 13px; }
.pm-qn-check.is-large { width: 18px; height: 18px; }
.pm-qn-title {
	flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 4px;
	font-size: 13px;
}
.pm-qn-row.is-done .pm-qn-title { color: var(--vscode-descriptionForeground); text-decoration: line-through; }

/* Предпросмотр использует цвета подсказок VS Code и прокручивает длинную заметку внутри карточки. */
.pm-qn-preview {
	position: fixed; z-index: 1000; box-sizing: border-box; width: min(420px, calc(100vw - 16px));
	overflow: auto; overscroll-behavior: contain; padding: 10px 12px; border-radius: 7px;
	border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border));
	border-inline-start: 3px solid var(--pm-qn-note, var(--vscode-editorHoverWidget-border, var(--vscode-panel-border)));
	background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background));
	color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
	box-shadow: 0 6px 22px var(--vscode-widget-shadow, rgba(0,0,0,.35));
	font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; user-select: text;
}
.pm-qn-preview-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.pm-qn-preview-header h2 { min-width: 0; margin: 0; font-size: 14px; font-weight: 600; }
.pm-qn-preview-description { margin-top: 6px; white-space: pre-wrap; }
.pm-qn-preview-section { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--vscode-panel-border); }
.pm-qn-preview-section h3 {
	display: flex; align-items: center; gap: 5px; margin: 0;
	font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground);
}
.pm-qn-preview-section ul { list-style: none; padding: 0; margin: 4px 0 0; }
.pm-qn-preview-section li { display: flex; align-items: baseline; gap: 6px; white-space: pre-wrap; }
.pm-qn-preview-section li + li { margin-top: 3px; }
.pm-qn-preview-section li.is-done { color: var(--vscode-descriptionForeground); text-decoration: line-through; }
.pm-qn-preview-check {
	flex: none; display: inline-grid; place-items: center; width: 12px; height: 12px; align-self: flex-start;
	box-sizing: border-box; margin-top: 4px; border: 1px solid currentColor; border-radius: 3px;
}
.pm-qn-meta { display: flex; align-items: center; gap: 6px; flex-shrink: 0; font-size: 11px; color: var(--vscode-descriptionForeground); }
.pm-qn-meta-item { display: inline-flex; align-items: center; gap: 2px; }
.pm-qn-meta-item.is-link { color: var(--vscode-textLink-foreground); }
.pm-qn-meta-toggle {
	display: inline-flex; align-items: center; gap: 2px; height: 20px; padding: 0 4px; margin: 0 -2px; border: none;
	border-radius: 3px; background: transparent; color: inherit; font: inherit; cursor: pointer;
}
.pm-qn-meta-toggle:hover, .pm-qn-meta-toggle[aria-expanded="true"] {
	background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground);
}
.pm-qn-row .pm-qn-open { opacity: 0; }
.pm-qn-row:hover .pm-qn-open, .pm-qn-row:focus-within .pm-qn-open { opacity: 1; }
.pm-qn-row.is-new { animation: pm-qn-flash 1.2s ease-out; }
@keyframes pm-qn-flash {
	0% { background: color-mix(in srgb, var(--vscode-focusBorder) 35%, transparent); }
	100% { background: transparent; }
}
.pm-qn-sub {
	display: flex; flex-direction: column; margin: 0 0 4px 26px; padding-left: 10px;
	border-left: 1px solid var(--vscode-panel-border);
}
.pm-qn-sub-row { display: flex; align-items: center; gap: 6px; min-height: 24px; font-size: 12px; }
.pm-qn-sub-row.is-done span { color: var(--vscode-descriptionForeground); text-decoration: line-through; }
.pm-qn-done-toggle {
	display: flex; align-items: center; gap: 4px; margin-top: 2px; padding: 4px 3px 0;
	border-top: 1px solid var(--vscode-panel-border); font-size: 12px; color: var(--vscode-descriptionForeground);
}
.pm-qn-done-toggle .pm-qn-plain-btn { display: inline-flex; align-items: center; gap: 4px; }
.pm-qn-plain-btn { border: none; background: none; color: inherit; font: inherit; padding: 0; cursor: pointer; }
.pm-qn-link-btn {
	margin-left: auto; border: none; background: none; padding: 0 2px; cursor: pointer;
	color: var(--vscode-textLink-foreground); font: inherit; font-size: 11px;
}
.pm-qn-confirm { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--vscode-foreground); }
.pm-qn-empty { font-size: 12px; color: var(--vscode-descriptionForeground); padding: 4px 2px; }
.pm-qn-error {
	display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 4px; font-size: 12px;
	border: 1px solid color-mix(in srgb, var(--vscode-errorForeground) 45%, transparent);
	background: color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent);
}

/* Кнопки окна и доски. */
.pm-qn-btn {
	display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px; border-radius: 3px;
	border: 1px solid transparent; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.pm-qn-btn:disabled { opacity: 0.5; cursor: default; }
.pm-qn-btn.is-small { height: 20px; padding: 0 6px; font-size: 11px; }
.pm-qn-btn.is-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.pm-qn-btn.is-primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
.pm-qn-btn.is-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.pm-qn-btn.is-secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
.pm-qn-btn.is-ghost { background: transparent; color: var(--vscode-foreground); }
.pm-qn-btn.is-ghost:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
.pm-qn-btn.is-danger { background: transparent; color: var(--vscode-errorForeground); }
.pm-qn-btn.is-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent); }

/* Модальное окно заметки. */
.pm-qn-overlay {
	position: fixed; inset: 0; z-index: 1000; display: flex; align-items: flex-start; justify-content: center;
	padding: 7vh 16px 16px; background: rgba(0, 0, 0, 0.45);
}
body.vscode-light .pm-qn-overlay { background: rgba(0, 0, 0, 0.25); }
.pm-qn-modal {
	width: min(640px, 100%); max-height: 86vh; display: flex; flex-direction: column; color: var(--vscode-foreground);
	background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px;
	box-shadow: 0 8px 28px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
}
.pm-qn-modal-h {
	display: flex; align-items: center; gap: 8px; padding: 8px 10px 8px 14px; border-radius: 8px 8px 0 0;
	border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background);
}
.pm-qn-crumb {
	flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; font-size: 12px;
	color: var(--vscode-descriptionForeground);
}
.pm-qn-pos { font-size: 11px; color: var(--vscode-descriptionForeground); }
.pm-qn-modal-b { overflow-y: auto; padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 16px; }
.pm-qn-title-line { display: flex; align-items: center; gap: 10px; }
.pm-qn-title-input {
	flex: 1; min-width: 0; padding: 4px 6px; margin-left: -6px; border: 1px solid transparent; border-radius: 4px;
	background: transparent; color: var(--vscode-foreground); font: inherit; font-size: 16px; font-weight: 600;
}
.pm-qn-title-field { position: relative; display: flex; flex: 1; min-width: 0; align-items: center; }
.pm-qn-title-field .pm-qn-title-input { flex: 1; width: 100%; box-sizing: border-box; padding-right: 32px; }
.pm-qn-title-spinner {
	position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
	display: inline-flex; align-items: center; justify-content: center;
	color: var(--vscode-textLink-foreground); pointer-events: none;
}
.pm-qn-title-input:hover { border-color: var(--vscode-input-border, var(--vscode-panel-border)); }
.pm-qn-title-input:focus {
	outline: none; border-color: var(--vscode-focusBorder); background: var(--vscode-input-background);
}
.pm-qn-props { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; }
.pm-qn-prop { display: flex; align-items: center; gap: 8px; }
.pm-qn-label {
	font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
	color: var(--vscode-descriptionForeground);
}
.pm-qn-swatches { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.pm-qn-swatch {
	position: relative; width: 16px; height: 16px; margin: 1px; padding: 0; border: none; border-radius: 50%; cursor: pointer;
}
.pm-qn-swatch.is-none { background: transparent; border: 1px dashed var(--vscode-descriptionForeground); }
.pm-qn-swatch.is-custom { background: conic-gradient(#f14c4c, #cca700, #89d185, #3794ff, #b180d7, #f14c4c); overflow: hidden; }
.pm-qn-swatch.is-custom input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
/* Клавиатурный фокус прозрачного поля показываем на видимом образце, снаружи кольца выбранного цвета. */
.pm-qn-swatch.is-custom:has(input:focus-visible) { outline: 2px solid var(--vscode-focusBorder); outline-offset: 4px; }
.pm-qn-swatch[aria-pressed="true"], .pm-qn-swatch.is-selected {
	box-shadow: 0 0 0 2px var(--vscode-editor-background), 0 0 0 3.5px var(--vscode-foreground);
}
.pm-qn-seg {
	display: inline-flex; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
	border-radius: 4px; overflow: hidden;
}
.pm-qn-seg button {
	display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 9px; border: none; cursor: pointer;
	background: transparent; color: var(--vscode-foreground); font-size: 12px;
}
.pm-qn-seg button + button { border-left: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); }
/* Выбранное состояние — пара фона и текста переключателя опций поиска VS Code: в любой теме текст контрастен фону. */
.pm-qn-seg button[aria-pressed="true"], .pm-qn-chip[aria-pressed="true"] {
	background: var(--vscode-inputOption-activeBackground, var(--vscode-button-secondaryBackground));
	color: var(--vscode-inputOption-activeForeground, var(--vscode-button-secondaryForeground, var(--vscode-foreground)));
	box-shadow: inset 0 0 0 1px var(--vscode-inputOption-activeBorder, transparent); font-weight: 600;
}
.pm-qn-seg button:disabled { opacity: 0.5; cursor: default; }
.pm-qn-block { display: flex; flex-direction: column; gap: 6px; }
.pm-qn-block-h { display: flex; align-items: center; gap: 8px; }
.pm-qn-muted { font-size: 11px; color: var(--vscode-descriptionForeground); }
.pm-qn-progress {
	flex: 1; max-width: 160px; height: 3px; border-radius: 2px; overflow: hidden; background: var(--vscode-input-background);
}
.pm-qn-progress > span { display: block; height: 100%; background: var(--vscode-charts-green); }
.pm-qn-textarea {
	width: 100%; min-height: 84px; resize: vertical; padding: 7px 8px; border-radius: 4px;
	border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); background: var(--vscode-input-background);
	color: var(--vscode-input-foreground); font: inherit; font-size: 13px; line-height: 1.45;
}
.pm-qn-textarea:focus { outline: none; border-color: var(--vscode-focusBorder); }
.pm-qn-items { display: flex; flex-direction: column; }
.pm-qn-item { display: flex; align-items: center; gap: 6px; min-height: 28px; padding: 0 4px; border-radius: 4px; }
.pm-qn-item:hover, .pm-qn-item:focus-within { background: var(--vscode-list-hoverBackground); }
.pm-qn-item .pm-qn-grip { opacity: 0; }
.pm-qn-item:hover .pm-qn-grip, .pm-qn-item:focus-within .pm-qn-grip { opacity: 1; }
.pm-qn-item-text {
	flex: 1; min-width: 0; border: none; background: transparent; color: var(--vscode-foreground);
	font: inherit; font-size: 13px; outline: none !important; padding: 2px 0;
}
.pm-qn-item.is-done .pm-qn-item-text { color: var(--vscode-descriptionForeground); text-decoration: line-through; }
.pm-qn-item .pm-qn-item-del { opacity: 0; }
.pm-qn-item:hover .pm-qn-item-del, .pm-qn-item:focus-within .pm-qn-item-del { opacity: 1; }
.pm-qn-add-item { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 4px 0 24px; color: var(--vscode-descriptionForeground); }
.pm-qn-add-item input { flex: 1; min-width: 0; border: none; background: transparent; color: var(--vscode-foreground); font: inherit; outline: none !important; }
.pm-qn-ai-btn {
	align-self: flex-start; display: inline-flex; align-items: center; gap: 5px; height: 24px; margin-left: 20px; padding: 0 8px;
	border: none; border-radius: 4px; background: transparent; color: var(--vscode-textLink-foreground); font-size: 12px; cursor: pointer;
}
.pm-qn-ai-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
.pm-qn-ai-box {
	display: flex; flex-direction: column; gap: 8px; margin: 2px 0 0 20px; padding: 10px; border-radius: 6px;
	border: 1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 45%, var(--vscode-panel-border));
	background: color-mix(in srgb, var(--vscode-textLink-foreground) 6%, var(--vscode-editor-background));
}
.pm-qn-ai-h { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; }
.pm-qn-ai-h > svg { color: var(--vscode-textLink-foreground); }
.pm-qn-grow { flex: 1; }
.pm-qn-input {
	width: 100%; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
	background: var(--vscode-input-background); color: var(--vscode-input-foreground); font: inherit; font-size: 13px;
}
.pm-qn-input:focus { outline: none; border-color: var(--vscode-focusBorder); }
.pm-qn-status { display: flex; align-items: center; gap: 8px; min-height: 30px; font-size: 12px; color: var(--vscode-descriptionForeground); }
.pm-qn-spin { animation: pm-qn-spin 1s linear infinite; }
@keyframes pm-qn-spin { to { transform: rotate(360deg); } }
.pm-qn-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.pm-qn-files { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 8px; }
.pm-qn-files.is-over { outline: 2px dashed var(--vscode-focusBorder); outline-offset: 3px; border-radius: 5px; }
.pm-qn-files.is-over .pm-qn-add-tile {
	border-style: solid; border-color: var(--vscode-focusBorder); color: var(--vscode-foreground);
	background: color-mix(in srgb, var(--vscode-focusBorder) 12%, transparent);
}
.pm-qn-file {
	position: relative; display: flex; flex-direction: column; min-width: 0; overflow: hidden; border-radius: 6px;
	border: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background);
}
.pm-qn-file:hover, .pm-qn-file:focus-within { border-color: var(--vscode-focusBorder); }
.pm-qn-file-open {
	display: flex; flex-direction: column; padding: 0; border: none; background: transparent; color: inherit;
	text-align: left; cursor: pointer;
}
.pm-qn-file-thumb {
	height: 72px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
	color: var(--vscode-descriptionForeground); background-size: cover; background-position: center;
}
.pm-qn-file-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.pm-qn-file-ext { font-size: 13px; font-weight: 700; letter-spacing: 0.06em; color: var(--vscode-foreground); }
.pm-qn-file-name { padding: 5px 7px 0; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pm-qn-file-size { padding: 0 7px 6px; font-size: 10px; color: var(--vscode-descriptionForeground); }
.pm-qn-file .pm-qn-file-rm { position: absolute; top: 4px; right: 4px; opacity: 0; background: var(--vscode-editor-background); }
.pm-qn-file:hover .pm-qn-file-rm, .pm-qn-file:focus-within .pm-qn-file-rm { opacity: 1; }
.pm-qn-add-tile-wrap { position: relative; }
.pm-qn-add-tile {
	width: 100%; min-height: 112px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
	border: 1px dashed var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 6px; background: transparent;
	color: var(--vscode-descriptionForeground); font-size: 11px; cursor: pointer;
}
.pm-qn-add-tile:hover, .pm-qn-add-tile[aria-expanded="true"] { border-color: var(--vscode-focusBorder); color: var(--vscode-foreground); }
.pm-qn-menu {
	position: absolute; left: 0; top: calc(100% + 4px); z-index: 5; min-width: 220px; padding: 4px; text-align: left;
	border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-editor-background);
	box-shadow: 0 4px 14px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
}
.pm-qn-menu button {
	display: flex; align-items: center; gap: 8px; width: 100%; height: 26px; padding: 0 8px; border: none; border-radius: 4px;
	background: transparent; color: var(--vscode-foreground); font-size: 12px; cursor: pointer;
}
.pm-qn-menu button:hover, .pm-qn-menu button:focus-visible { background: var(--vscode-list-hoverBackground); }
.pm-qn-menu-key { margin-left: auto; font-size: 11px; color: var(--vscode-descriptionForeground); }
.pm-qn-menu-note {
	margin-top: 4px; padding: 4px 8px 2px; font-size: 11px; color: var(--vscode-descriptionForeground);
	border-top: 1px solid var(--vscode-panel-border);
}
.pm-qn-prompt-box {
	display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 6px;
	background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-panel-border);
}
.pm-qn-prompt-box > svg { flex-shrink: 0; }
.pm-qn-prompt-text { flex: 1; min-width: 0; font-size: 12px; line-height: 1.4; color: var(--vscode-descriptionForeground); }
.pm-qn-prompt-text b { color: var(--vscode-foreground); font-weight: 600; }
.pm-qn-banner {
	display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 4px; font-size: 12px;
	border: 1px solid color-mix(in srgb, var(--vscode-editorWarning-foreground) 55%, transparent);
	background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 12%, transparent);
}
.pm-qn-banner > svg { color: var(--vscode-editorWarning-foreground); flex-shrink: 0; }
.pm-qn-banner.is-error { border-color: color-mix(in srgb, var(--vscode-errorForeground) 55%, transparent);
	background: color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent); }
.pm-qn-banner.is-error > svg { color: var(--vscode-errorForeground); }
.pm-qn-banner .pm-qn-grow { min-width: 160px; }
.pm-qn-modal-f { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--vscode-panel-border); }
.pm-qn-dirty { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--vscode-descriptionForeground); }
.pm-qn-dirty::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-editorWarning-foreground); }
.pm-qn-kbd { font-size: 10px; opacity: 0.75; margin-left: 2px; }

/* Доска заметок: отдельная страница-вкладка, занимает всю область webview. */
.pm-qn-board {
	display: flex; flex-direction: column; height: 100vh; min-height: 0; color: var(--vscode-foreground);
	background: var(--vscode-editor-background); outline: none;
}
.pm-qn-board > .pm-qn-error { margin: 10px 16px 0; }
.pm-qn-board-h {
	display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 16px;
	border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background);
}
.pm-qn-board-title { display: flex; align-items: center; gap: 8px; margin-right: 6px; font-size: 14px; font-weight: 700; }
.pm-qn-board-count { font-size: 11px; font-weight: 400; color: var(--vscode-descriptionForeground); }
.pm-qn-board-h .pm-qn-search { flex: 0 1 240px; height: 26px; }
.pm-qn-chip {
	display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px; border-radius: 4px; cursor: pointer;
	border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); background: transparent;
	color: var(--vscode-foreground); font-size: 12px;
}
.pm-qn-board-keys { font-size: 11px; color: var(--vscode-descriptionForeground); }
.pm-qn-board-b { flex: 1; overflow: auto; padding: 18px 20px 28px; }
.pm-qn-masonry { display: grid; gap: 14px; align-items: start; }
.pm-qn-mcol { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 14px; }
.pm-qn-sticky {
	position: relative; display: flex; flex-direction: column; gap: 8px; min-height: 96px; padding: 13px 12px 10px;
	border-radius: 8px; cursor: pointer; text-align: left; color: var(--vscode-foreground);
	background: color-mix(in srgb, var(--pm-qn-note) 13%, var(--vscode-editor-background));
	border: 1px solid color-mix(in srgb, var(--pm-qn-note) 34%, var(--vscode-panel-border));
	box-shadow: 0 1px 2px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
	transition: transform 0.12s ease, box-shadow 0.12s ease; touch-action: none;
}
.pm-qn-sticky::before {
	content: ""; position: absolute; left: 12px; right: 12px; top: -1px; height: 3px; border-radius: 0 0 3px 3px;
	background: var(--pm-qn-note);
}
.pm-qn-sticky.is-plain { background: var(--vscode-sideBar-background); border-color: var(--vscode-panel-border); }
.pm-qn-sticky.is-plain::before { display: none; }
.pm-qn-sticky:hover { transform: translateY(-1px); box-shadow: 0 6px 18px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36)); }
.pm-qn-sticky:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
.pm-qn-sticky.is-done { opacity: 0.62; }
.pm-qn-sticky.is-done .pm-qn-st-title { text-decoration: line-through; }
.pm-qn-sticky.is-dragging { opacity: 0.25; transform: none; }
.pm-qn-board.is-reordering, .pm-qn-sticky { user-select: none; -webkit-user-select: none; }
.pm-qn-board.is-reordering * { cursor: grabbing !important; }
.pm-qn-drag-ghost {
	position: fixed; z-index: 999; max-width: 270px; padding: 9px 13px;
	border: 1px solid var(--vscode-focusBorder); border-radius: 7px;
	background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
	box-shadow: 0 8px 22px var(--vscode-widget-shadow, rgba(0,0,0,0.36));
	color: var(--vscode-foreground); font-size: 13px; font-weight: 600;
	pointer-events: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pm-qn-sticky.is-new { animation: pm-qn-sticky-in 0.9s ease-out; }
@keyframes pm-qn-sticky-in {
	0% { transform: scale(0.96); box-shadow: 0 0 0 3px var(--vscode-focusBorder); }
	100% { transform: none; }
}
.pm-qn-sticky.is-drop-before::after, .pm-qn-sticky.is-drop-after::after {
	content: ""; position: absolute; left: 0; right: 0; height: 3px; border-radius: 2px; background: var(--vscode-focusBorder);
}
.pm-qn-sticky.is-drop-before::after { top: -9px; }
.pm-qn-sticky.is-drop-after::after { bottom: -9px; }
/* В «Сетке» порядок читается по рядам: вставка «до» и «после» — слева и справа от стикера. */
.pm-qn-sticky.is-drop-left::after, .pm-qn-sticky.is-drop-right::after {
	content: ""; position: absolute; top: 0; bottom: 0; width: 3px; border-radius: 2px; background: var(--vscode-focusBorder);
}
.pm-qn-sticky.is-drop-left::after { left: -9px; }
.pm-qn-sticky.is-drop-right::after { right: -9px; }
.pm-qn-st-h { display: flex; align-items: flex-start; gap: 8px; }
.pm-qn-st-h .pm-qn-check { margin-top: 1px; }
.pm-qn-st-title {
	flex: 1; min-width: 0; margin: 0; font-size: 13px; font-weight: 600; line-height: 1.35; overflow: hidden;
	display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow-wrap: anywhere;
}
.pm-qn-st-actions { display: flex; margin: -4px -6px 0 0; opacity: 0; }
.pm-qn-sticky:hover .pm-qn-st-actions, .pm-qn-sticky:focus-within .pm-qn-st-actions, .pm-qn-sticky.is-pop .pm-qn-st-actions { opacity: 1; }
.pm-qn-st-desc {
	margin: 0; font-size: 12px; line-height: 1.45; white-space: pre-line; overflow: hidden; overflow-wrap: anywhere;
	color: color-mix(in srgb, var(--vscode-foreground) 80%, var(--vscode-descriptionForeground));
	display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical;
}
.pm-qn-st-items { display: flex; flex-direction: column; gap: 4px; }
.pm-qn-st-item { display: flex; align-items: center; gap: 6px; font-size: 12px; line-height: 1.3; min-width: 0; }
.pm-qn-st-item span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-qn-st-item.is-done span { text-decoration: line-through; color: var(--vscode-descriptionForeground); }
.pm-qn-st-more { padding-left: 19px; font-size: 11px; color: var(--vscode-descriptionForeground); }
.pm-qn-st-imgs { display: flex; gap: 6px; }
.pm-qn-st-imgs img { width: 58px; height: 40px; object-fit: cover; border-radius: 4px; border: 1px solid var(--vscode-panel-border); }
.pm-qn-st-f { display: flex; align-items: center; gap: 9px; font-size: 11px; color: var(--vscode-descriptionForeground); }
.pm-qn-popover {
	position: absolute; top: 34px; right: 8px; z-index: 3; display: flex; align-items: center; gap: 2px; padding: 6px;
	border-radius: 6px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border);
	box-shadow: 0 4px 14px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36)); cursor: default;
}
.pm-qn-add-sticky {
	align-items: center; justify-content: center; gap: 4px; border: 1px dashed var(--vscode-input-border, var(--vscode-panel-border));
	background: transparent; color: var(--vscode-descriptionForeground); font: inherit; box-shadow: none;
}
.pm-qn-add-sticky::before { display: none; }
.pm-qn-add-sticky:hover { border-color: var(--vscode-focusBorder); color: var(--vscode-foreground); }
.pm-qn-add-sticky.is-editing {
	cursor: default; align-items: stretch; justify-content: flex-start; border-style: solid; transform: none;
	border-color: var(--vscode-focusBorder); background: var(--vscode-input-background);
}
.pm-qn-add-sticky textarea {
	min-height: 64px; border: none; outline: none !important; resize: none; background: transparent;
	color: var(--vscode-input-foreground); font: inherit; font-size: 13px; line-height: 1.4;
}
.pm-qn-add-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
.pm-qn-board-cols { display: flex; gap: 14px; align-items: flex-start; }
.pm-qn-bcol { flex: 0 0 276px; display: flex; flex-direction: column; gap: 8px; }
.pm-qn-bcol-h { display: flex; align-items: center; gap: 7px; padding: 2px 4px; font-size: 12px; font-weight: 600; }
.pm-qn-bcol-dot { width: 10px; height: 10px; border-radius: 50%; }
.pm-qn-bcol-dot.is-none { border: 1px dashed var(--vscode-descriptionForeground); }
.pm-qn-bcol-list {
	display: flex; flex-direction: column; gap: 10px; min-height: 84px; padding: 8px; border-radius: 8px;
	border: 1px solid transparent; background: color-mix(in srgb, var(--vscode-sideBar-background) 75%, transparent);
}
.pm-qn-bcol-list.is-over { border-color: var(--vscode-focusBorder); background: color-mix(in srgb, var(--vscode-focusBorder) 8%, transparent); }
.pm-qn-bcol-empty {
	padding: 18px 8px; border: 1px dashed var(--vscode-panel-border); border-radius: 6px; text-align: center;
	font-size: 12px; color: var(--vscode-descriptionForeground);
}
.pm-qn-board-empty { padding: 48px 16px; text-align: center; font-size: 13px; color: var(--vscode-descriptionForeground); }
@media (prefers-reduced-motion: reduce) {
	.pm-qn-row.is-new, .pm-qn-sticky.is-new, .pm-qn-spin { animation: none; }
	.pm-qn-sticky { transition: none; }
}
`;
