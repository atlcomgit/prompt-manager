/** Рамка, подсветка и панели поиска следуют текущим цветам VS Code, включая светлую и контрастную темы. */
export const BASH_SCRIPT_EDITOR_CSS = `
.pm-qn-overlay .pm-bs-editor {
	box-sizing: border-box; width: 820px; height: 560px; max-width: 100%; max-height: 100%;
	min-width: min(280px, 100%); min-height: min(260px, 100%); resize: both; overflow: auto;
}
.pm-bs-editor .pm-qn-modal-b { flex: 1 1 0; min-height: 0; gap: 12px; }
.pm-bs-editor .pm-qn-modal-h, .pm-bs-editor .pm-qn-modal-f { flex-shrink: 0; }
.pm-bs-content { position: relative; min-width: 0; flex: 1 0 145px; display: flex; flex-direction: column; }
.pm-bs-content-loader {
	position: absolute; inset: 0; z-index: 1; display: flex; align-items: center; justify-content: center; gap: 8px;
	border-radius: 5px; background: var(--vscode-input-background); color: var(--vscode-descriptionForeground); font-size: 12px;
}
@media (prefers-reduced-motion: reduce) { .pm-bs-content-loader svg { animation: none; } }
.pm-bs-editor .pm-bs-code {
	position: absolute; inset: 0; min-width: 0; display: flex; flex-direction: column; overflow: hidden; color: var(--vscode-input-foreground);
	background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 6px;
}
.pm-bs-editor .pm-bs-code:focus-within { border-color: var(--vscode-focusBorder); }
.pm-bs-code-bar, .pm-bs-code-status {
	display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; padding: 4px 8px;
	background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-sideBar-background));
}
.pm-bs-code-bar { min-height: 25px; border-bottom: 1px solid var(--vscode-panel-border); }
.pm-bs-code-name { display: flex; flex: 1 1 80px; align-items: center; gap: 6px; min-width: 0; font-size: 12px; }
.pm-bs-code-name > svg { color: var(--vscode-symbolIcon-fileForeground, var(--vscode-descriptionForeground)); flex-shrink: 0; }
.pm-bs-code-name > strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.pm-bs-code-tools { display: flex; align-items: center; gap: 3px; }
.pm-bs-code-tools button, .pm-bs-code-status button {
	background: transparent; border: 1px solid transparent; border-radius: 3px; padding: 2px 5px; min-height: 21px;
	cursor: pointer; color: var(--vscode-descriptionForeground); font: inherit; font-size: 11px;
}
.pm-bs-code-tools button[aria-pressed=true] {
	color: var(--vscode-inputOption-activeForeground, var(--vscode-foreground));
	background: var(--vscode-inputOption-activeBackground); border-color: var(--vscode-inputOption-activeBorder, transparent);
}
.pm-bs-code-tools button:hover:enabled, .pm-bs-code-status button:hover:enabled { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
.pm-bs-code-tools button:disabled, .pm-bs-code-status button:disabled { color: var(--vscode-disabledForeground); cursor: default; }
.pm-bs-code-status { min-height: 18px; padding-block: 1px; border-top: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); font-size: 11px; }
.pm-bs-code-status button { margin-inline-start: auto; font-variant-numeric: tabular-nums; }
.pm-bs-code-message { padding: 12px; color: var(--vscode-descriptionForeground); font-size: 12px; }
.pm-bs-code-surface { position: relative; flex: 1; min-height: 0; }
.pm-bs-code .cm-editor { position: absolute; inset: 0; color: var(--vscode-input-foreground); background: var(--vscode-input-background); }
.pm-bs-code .cm-editor.cm-focused, .pm-bs-code .cm-content:focus { outline: none; }
.pm-bs-code .cm-scroller { overflow: auto; font: var(--vscode-editor-font-size, 13px)/1.55 var(--vscode-editor-font-family, monospace); }
.pm-bs-code .cm-content { padding: 6px 0; caret-color: var(--vscode-editorCursor-foreground); }
.pm-bs-code .cm-line { padding-inline: 8px; }
.pm-bs-code .cm-gutters { background: var(--vscode-input-background); color: var(--vscode-editorLineNumber-foreground); border-right: 1px solid var(--vscode-panel-border); }
.pm-bs-code .cm-activeLine, .pm-bs-code .cm-activeLineGutter { background: var(--vscode-editor-lineHighlightBackground, color-mix(in srgb, var(--vscode-editor-foreground) 6%, transparent)); }
.pm-bs-code .cm-activeLine { box-shadow: inset 0 0 0 1px var(--vscode-editor-lineHighlightBorder, transparent); }
.pm-bs-code .cm-activeLineGutter { color: var(--vscode-editorLineNumber-activeForeground); }
.pm-bs-code .cm-content ::selection { background: var(--vscode-editor-selectionBackground); }
.pm-bs-code .cm-matchingBracket { background: var(--vscode-editorBracketMatch-background); outline: 1px solid var(--vscode-editorBracketMatch-border); }
.pm-bs-code .cm-searchMatch { background: var(--vscode-editor-findMatchHighlightBackground); }
.pm-bs-code .cm-searchMatch-selected { background: var(--vscode-editor-findMatchBackground); }
.pm-bs-code .cm-placeholder { color: var(--vscode-editorGhostText-foreground, var(--vscode-descriptionForeground)); }
.pm-bs-code .cm-panels { color: var(--vscode-foreground); background: var(--vscode-editorWidget-background); border-color: var(--vscode-editorWidget-border, var(--vscode-panel-border)); }
.pm-bs-code .cm-panel { padding: 5px 7px; }
.pm-bs-code .cm-search label, .pm-bs-code .cm-goto-line label { display: inline-flex; align-items: center; gap: 3px; }
.pm-bs-code input.cm-textfield, .pm-bs-code .cm-panels input[type=checkbox] { width: auto; max-width: 100%; display: inline-block; margin: 2px; }
.pm-bs-code input.cm-textfield { width: min(12em, 100%); padding: 3px 5px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); color: var(--vscode-input-foreground); background: var(--vscode-input-background); }
.pm-bs-code .cm-button { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 1px solid var(--vscode-contrastBorder, transparent); }
/* Some webview themes omit symbol or debugger colors. Keep syntax readable in both base palettes. */
.pm-bs-code {
	--bs-shell-keyword: #c586c0; --bs-shell-string: #ce9178; --bs-shell-variable: #9cdcfe;
	--bs-shell-command: #dcdcaa; --bs-shell-number: #b5cea8;
}
:is(.vscode-light, .vscode-high-contrast-light) .pm-bs-code {
	--bs-shell-keyword: #70248c; --bs-shell-string: #963315; --bs-shell-variable: #12587e;
	--bs-shell-command: #79540a; --bs-shell-number: #22662b;
}
.pm-bs-code-keyword { color: var(--vscode-symbolIcon-keywordForeground, var(--vscode-debugTokenExpression-boolean, var(--bs-shell-keyword))); }
.pm-bs-code-string { color: var(--vscode-debugTokenExpression-string, var(--vscode-symbolIcon-stringForeground, var(--bs-shell-string))); }
.pm-bs-code-variable { color: var(--vscode-debugTokenExpression-name, var(--vscode-symbolIcon-variableForeground, var(--bs-shell-variable))); }
.pm-bs-code-command { color: var(--vscode-symbolIcon-functionForeground, var(--bs-shell-command)); }
.pm-bs-code-comment { color: var(--vscode-descriptionForeground); font-style: italic; }
.pm-bs-code-number { color: var(--vscode-debugTokenExpression-number, var(--vscode-symbolIcon-numberForeground, var(--bs-shell-number))); }
.pm-bs-code-operator { color: var(--vscode-symbolIcon-operatorForeground, var(--vscode-foreground)); }
`;
