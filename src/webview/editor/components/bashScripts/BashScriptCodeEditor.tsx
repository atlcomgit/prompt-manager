import React, { useEffect, useRef, useState } from 'react';
import { QuickNoteIcon } from '../quickNotes/QuickNoteIcon';
import type { mountBashCodeEditor } from './bashScriptCodeMirror.mjs' with { 'resolution-mode': 'import' };

type CodeModule = { mountBashCodeEditor: typeof mountBashCodeEditor };
type CodeEditor = ReturnType<typeof mountBashCodeEditor>;
declare global { interface Window { promptManagerBashCode?: CodeModule } }

// Соседний bundle получает адрес, версию и CSP nonce реально загруженного editor.js (в том числе в Tunnel).
const editorScript = typeof document === 'undefined' ? null : document.currentScript as HTMLScriptElement | null;
let loading: Promise<CodeModule> | undefined;
function loadCodeEditor(): Promise<CodeModule> {
	if (window.promptManagerBashCode) return Promise.resolve(window.promptManagerBashCode);
	if (loading) return loading;
	loading = new Promise<CodeModule>((resolve, reject) => {
		if (!editorScript?.src) { reject(new Error('Нет адреса локального редактора.')); return; }
		const main = new URL(editorScript.src);
		const url = new URL('bashScriptCode.js', main);
		url.search = main.search;
		const script = document.createElement('script');
		script.src = url.href;
		script.nonce = editorScript.nonce;
		script.onload = () => {
			script.remove();
			if (window.promptManagerBashCode) resolve(window.promptManagerBashCode);
			else reject(new Error('Расширение не загрузило редактор кода.'));
		};
		script.onerror = () => { script.remove(); reject(new Error('Не удалось загрузить редактор кода.')); };
		document.head.appendChild(script);
	}).catch((error: Error) => { loading = undefined; throw error; });
	return loading;
}

/** Both the file read and the lazy editor bundle occupy the same content area. */
export function BashScriptContentLoader({ children }: { children: string }) {
	return <div className="pm-bs-content-loader" role="status">
		<QuickNoteIcon name="loading" size={18} className="pm-qn-spin" />{children}
	</div>;
}

/** Создаёт ровно один EditorView на прочитанный файл и держит движение курсора внутри поля кода. */
export function BashScriptCodeEditor({ value, filename, disabled, onChange }: {
	value: string; filename: string; disabled: boolean; onChange(value: string): void;
}) {
	const parent = useRef<HTMLDivElement>(null);
	const editor = useRef<CodeEditor>();
	const initial = useRef(value);
	const current = useRef({ disabled, onChange });
	current.current = { disabled, onChange };
	const [attempt, setAttempt] = useState(0);
	const [error, setError] = useState('');
	const [ready, setReady] = useState(false);
	const [wrap, setWrap] = useState(true);
	const [indentTab, setIndentTab] = useState(false);
	const [position, setPosition] = useState([1, 1]);
	useEffect(() => {
		let active = true;
		void loadCodeEditor().then(module => {
			if (!active || !parent.current) return;
			editor.current = module.mountBashCodeEditor(parent.current, {
				value: initial.current, disabled: current.current.disabled,
				onChange: value => current.current.onChange(value),
				onCursor: (line, column) => setPosition(previous =>
					previous[0] === line && previous[1] === column ? previous : [line, column]),
			});
			setReady(true);
		}).catch((error: Error) => { if (active) setError(error.message); });
		return () => { active = false; editor.current?.destroy(); editor.current = undefined; };
	}, [attempt]);
	useEffect(() => { editor.current?.setDisabled(disabled); }, [disabled]);
	const controlsDisabled = !ready || disabled;
	function setTabMode(indent: boolean) { editor.current?.setIndentTab(indent); setIndentTab(indent); }
	return <div className="pm-bs-code" onKeyDown={event => {
		if (event.key === 'Escape' && indentTab && !event.defaultPrevented && event.target === parent.current?.querySelector('.cm-content')) {
			event.preventDefault(); event.stopPropagation(); setTabMode(false);
		}
	}}>
		<header className="pm-bs-code-bar">
			<span className="pm-bs-code-name" title={filename}><QuickNoteIcon name="file-code" size={15} /><strong>{filename}</strong></span>
			<div className="pm-bs-code-tools">
				<button type="button" className="pm-qn-icon-btn" aria-label="Найти в скрипте" title="Найти в скрипте (Ctrl+F)" disabled={controlsDisabled} onClick={() => editor.current?.find()}><QuickNoteIcon name="search" size={14} /></button>
				<button type="button" aria-label="Перенос длинных строк" title="Перенос длинных строк" aria-pressed={wrap} disabled={controlsDisabled}
					onClick={() => { editor.current?.setWrap(!wrap); setWrap(!wrap); }}>Перенос</button>
				<button type="button" aria-label="Отступ клавишей Tab" title={indentTab ? 'Tab вставляет отступ. Escape вернёт переход по полям.' : 'Вставлять отступ клавишей Tab'}
					aria-pressed={indentTab} disabled={controlsDisabled} onClick={() => setTabMode(!indentTab)}>Tab</button>
			</div>
		</header>
		{error ? <div className="pm-bs-code-message" role="alert">{error} <button type="button" className="pm-qn-btn is-secondary"
			onClick={() => { setError(''); setAttempt(previous => previous + 1); }}>Повторить</button></div>
			: !ready && <BashScriptContentLoader>Загрузка редактора кода…</BashScriptContentLoader>}
		<div ref={parent} className="pm-bs-code-surface" />
		{ready && <div className="pm-bs-code-status">
			<span>Bash</span><span title="Кодировка файла">{editor.current?.encoding}</span><span title="Окончания строк">{editor.current?.lineEnding}</span>
			<button type="button" disabled={disabled} title="Перейти к строке (Ctrl+G)" aria-label="Перейти к строке" onClick={() => editor.current?.goToLine()}>
				Стр {position[0]}, стлб {position[1]}</button>
		</div>}
	</div>;
}
