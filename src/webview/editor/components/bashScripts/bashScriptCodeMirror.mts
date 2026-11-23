import { defaultKeymap, history, historyKeymap, indentLess, insertTab, invertedEffects } from '@codemirror/commands';
import { bracketMatching, HighlightStyle, indentUnit, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { gotoLine, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, StateEffect, StateField, type Extension, type Text } from '@codemirror/state';
import { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { tags } from '@lezer/highlight';

/** Редактор получает только текст файла. Ревизия, защита от конфликтов и сохранение остаются у диалога. */
interface CodeEditorOptions {
	value: string;
	disabled: boolean;
	onChange(value: string): void;
	onCursor(line: number, column: number): void;
}

const colors = HighlightStyle.define([
	{ tag: [tags.keyword, tags.bool], class: 'pm-bs-code-keyword' },
	{ tag: [tags.string, tags.special(tags.string), tags.quote], class: 'pm-bs-code-string' },
	{ tag: [tags.variableName, tags.derefOperator], class: 'pm-bs-code-variable' },
	{ tag: [tags.standard(tags.variableName), tags.function(tags.variableName)], class: 'pm-bs-code-command' },
	{ tag: [tags.comment, tags.meta], class: 'pm-bs-code-comment' },
	{ tag: [tags.number, tags.attributeName], class: 'pm-bs-code-number' },
	{ tag: tags.operator, class: 'pm-bs-code-operator' },
]);

const phrases = EditorState.phrases.of({
	'Find': 'Найти', 'Replace': 'Заменить', 'next': 'Далее', 'previous': 'Назад', 'all': 'Все',
	'match case': 'Регистр', 'regexp': 'Рег. выражение', 'by word': 'Слово целиком', 'replace': 'Заменить',
	'replace all': 'Заменить все', 'close': 'Закрыть', 'Go to line': 'Перейти к строке', 'go': 'Перейти',
	'current match': 'Совпадение', 'on line': 'в строке', 'replaced $ matches': 'Заменено совпадений: $',
	'replaced match on line $': 'Замена в строке $', 'Selection deleted': 'Выделение удалено',
});

const endingsByMark: Record<string, string> = { L: '\n', W: '\r\n', R: '\r' };
const markForEnding = (ending: string) => ending === '\r\n' ? 'W' : ending === '\r' ? 'R' : 'L';

/** По одному символу на строку смешанного файла. Undo восстанавливает разделители вместе с текстом. */
function mixedLineEndings(initial: readonly string[], preferred: string) {
	const originalMarks = initial.map(markForEnding).join('');
	const newMark = markForEnding(preferred);
	const restore = StateEffect.define<string>();
	const field = StateField.define<string>({
		create: () => originalMarks,
		update(previous, transaction) {
			let restored: string | undefined;
			for (const effect of transaction.effects) if (effect.is(restore)) restored = effect.value;
			if (restored !== undefined || !transaction.docChanged) return restored ?? previous;
			let result: string[] | undefined;
			let consumed = 0;
			transaction.changes.iterChanges((from, to, _fromNew, _toNew, inserted) => {
				const first = transaction.startState.doc.lineAt(from).number - 1;
				const after = transaction.startState.doc.lineAt(to).number - 1;
				const removed = after - first;
				const added = inserted.lines - 1;
				if (removed === added) return;
				result ??= [];
				result.push(previous.slice(consumed, first + Math.min(removed, added)));
				if (added > removed) result.push(newMark.repeat(added - removed));
				consumed = after;
			});
			return result ? result.join('') + previous.slice(consumed) : previous;
		},
	});
	const keepHistory = invertedEffects.of(transaction => {
		const previous = transaction.startState.field(field);
		return transaction.docChanged && previous !== transaction.state.field(field) ? [restore.of(previous)] : [];
	});
	return { field, extensions: [field, keepHistory] };
}

function joinMixedLines(doc: Text, endings: string): string {
	const chunks: string[] = [];
	let next = 0;
	for (const cursor = doc.iter(); !cursor.next().done;) chunks.push(cursor.lineBreak ? endingsByMark[endings[next++]] : cursor.value);
	return chunks.join('');
}

const language = StreamLanguage.define(shell);

/** select() сам по себе не во всех webview переводит клавиатуру с кода на поле панели. */
function openPanelInput(view: EditorView, open: (view: EditorView) => boolean, selector: string): boolean {
	open(view);
	const input = view.dom.querySelector<HTMLInputElement>(selector);
	input?.focus();
	input?.select();
	return true;
}
const findInCode = (view: EditorView) => openPanelInput(view, openSearchPanel, '.cm-search [main-field]');
const selectLine = (view: EditorView) => openPanelInput(view, gotoLine, '.cm-goto-line input');

/** Загружается отдельным локальным bundle по первому открытию доступного файла. */
export function mountBashCodeEditor(parent: HTMLElement, options: CodeEditorOptions) {
	const bom = options.value.startsWith('\uFEFF') ? '\uFEFF' : '';
	const source = options.value.slice(bom.length);
	const endings = source.match(/\r\n?|\n/g) ?? [];
	const preferred = endings[0] ?? '\n';
	const mixed = endings.some(ending => ending !== preferred) ? mixedLineEndings(endings, preferred) : undefined;
	const wrapping = new Compartment();
	const readOnly = new Compartment();
	const tab = new Compartment();
	const access = (disabled: boolean): Extension[] => [
		EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled),
		EditorView.contentAttributes.of({ 'aria-label': 'Содержимое файла', 'aria-multiline': 'true',
			'aria-readonly': String(disabled), 'aria-keyshortcuts': 'Control+S Meta+S Control+F Meta+F Control+G Meta+G',
			spellcheck: 'false', tabindex: disabled ? '-1' : '0' }),
	];
	const view = new EditorView({
		parent, state: EditorState.create({ doc: source, extensions: [
			language, syntaxHighlighting(colors), lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(),
			bracketMatching(), history(), search({ top: true }), phrases, EditorState.tabSize.of(4), indentUnit.of('  '),
			placeholder('#!/usr/bin/env bash'), readOnly.of(access(options.disabled)), wrapping.of(EditorView.lineWrapping), tab.of([]),
			keymap.of([{ key: 'Mod-f', run: findInCode, scope: 'editor search-panel' },
				{ key: 'Mod-g', run: selectLine }, { key: 'Mod-Alt-g', run: selectLine },
				...searchKeymap, ...historyKeymap, ...defaultKeymap]),
			mixed?.extensions ?? [],
			EditorView.updateListener.of(update => {
				if (update.docChanged) {
					const text = mixed ? joinMixedLines(update.state.doc, update.state.field(mixed.field))
						: update.state.doc.sliceString(0, undefined, preferred);
					options.onChange(bom + text);
				}
				if (update.selectionSet || update.docChanged) {
					const cursor = update.state.selection.main.head;
					const line = update.state.doc.lineAt(cursor);
					options.onCursor(line.number, cursor - line.from + 1);
				}
			}),
		] }),
	});
	return {
		lineEnding: mixed ? 'Смешанные' : preferred === '\r\n' ? 'CRLF' : preferred === '\r' ? 'CR' : 'LF',
		encoding: bom ? 'UTF-8 BOM' : 'UTF-8',
		setDisabled: (disabled: boolean) => view.dispatch({ effects: readOnly.reconfigure(access(disabled)) }),
		setWrap: (wrap: boolean) => view.dispatch({ effects: wrapping.reconfigure(wrap ? EditorView.lineWrapping : []) }),
		setIndentTab: (indent: boolean) => view.dispatch({ effects: tab.reconfigure(indent ? [
			keymap.of([{ key: 'Tab', run: insertTab, shift: indentLess }]),
			EditorView.contentAttributes.of({ 'aria-description': 'Tab вставляет отступ. Escape вернёт переход по полям.' }),
		] : []) }),
		find: () => findInCode(view),
		goToLine: () => selectLine(view),
		destroy: () => view.destroy(),
	};
}
