import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BashScriptScope } from '../../../../types/bashScripts.js';
import { QuickNoteIcon } from '../quickNotes/QuickNoteIcon';
import { focusInActiveWebview, restoreWidgetDialogFocus, trapQuickNotesTabKey, useQuickNotesFocusFallback } from '../quickNotes/quickNotesFocus';
import { WidgetDialogOverlay } from '../quickNotes/WidgetDialogOverlay';
import { useBashScriptSender } from './useBashScripts';
import { BashScriptCodeEditor, BashScriptContentLoader } from './BashScriptCodeEditor';
import { BASH_SCRIPT_EDITOR_CSS } from './bashScriptCodeEditorStyles';
import { rememberScriptDraft, restoreScriptDraft, submitScriptDraft, watchScriptSave, type ScriptDraft } from './bashScriptDraft';

const EDITOR_SIZE_KEY = 'promptManager.bashScriptEditor.size';

/** Native resizing sets inline pixel sizes. Layout constraints can resize the rail without changing this preference. */
function useEditorSize(form: React.RefObject<HTMLDivElement>): void {
	useLayoutEffect(() => {
		const dialog = form.current;
		if (!dialog) return;
		let saved: { width?: string; height?: string } | null = null;
		try { saved = JSON.parse(window.localStorage.getItem(EDITOR_SIZE_KEY) || 'null'); } catch { /* Storage is optional. */ }
		for (const axis of ['width', 'height'] as const) {
			const value = saved?.[axis];
			if (typeof value === 'string' && /^\d+(?:\.\d+)?px$/.test(value)) dialog.style[axis] = value;
		}
		const persist = () => {
			try { window.localStorage.setItem(EDITOR_SIZE_KEY, JSON.stringify({ width: dialog.style.width, height: dialog.style.height })); }
			catch { /* A restricted webview can still resize for the current edit. */ }
		};
		let timer: number | undefined;
		const observer = new MutationObserver(() => {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => { timer = undefined; persist(); }, 150);
		});
		observer.observe(dialog, { attributes: true, attributeFilter: ['style'] });
		return () => {
			const changed = observer.takeRecords().length > 0 || timer !== undefined;
			observer.disconnect();
			window.clearTimeout(timer);
			if (changed) persist();
		};
	}, [form]);
}

/** Диалог редактирует только версию выбранного файла; устаревший ответ оставляет черновик открытым. */
export function BashScriptEditor({ initial, opener, onClose }: {
	initial: ScriptDraft; opener: HTMLButtonElement | null; onClose(): void;
}) {
	const [draft, setDraft] = useState(initial);
	const send = useBashScriptSender();
	const [readVersion, setReadVersion] = useState(0);
	const [localPending, setPending] = useState<'read' | 'choose' | 'openFile' | null>(initial.path && !initial.file ? 'read' : null);
	const pending = draft.pendingSave ? 'save' : localPending;
	const [error, setError] = useState(initial.saveFailure?.message ?? '');
	const [confirm, setConfirm] = useState<{ kind: 'close' } | { kind: 'read'; path: string } | null>(null);
	const mounted = useRef(false);
	const busy = useRef(false);
	const recovery = useRef<ScriptDraft>();
	const closed = useRef(false);
	const nameField = useRef<HTMLInputElement>(null);
	const nameEdits = useRef(0);
	const currentPath = useRef(draft.path);
	currentPath.current = draft.path;
	const form = useRef<HTMLDivElement>(null);
	useEditorSize(form);
	const heading = useId();
	const pathId = useId();
	const contentDirty = draft.content !== (draft.file?.original ?? '');
	const dirty = contentDirty || draft.name !== (draft.base?.name ?? '') || draft.path !== (draft.base?.path ?? '');
	const loaded = draft.file?.path === draft.path;
	const canSave = loaded && draft.name.trim() && (dirty || !draft.ref) && !pending;

	// Длинный скрипт передаётся в состояние webview после паузы ввода. Закрытие панели сразу сохраняет последние правки.
	useLayoutEffect(() => {
		recovery.current = dirty || draft.pendingSave ? draft : undefined;
		if (draft.pendingSave) return;
		if (!dirty) { rememberScriptDraft(); return; }
		const timer = window.setTimeout(() => { if (!closed.current && !recovery.current?.pendingSave) rememberScriptDraft(recovery.current); }, 250);
		return () => window.clearTimeout(timer);
	}, [dirty, draft]);
	useEffect(() => {
		const persist = () => { if (!closed.current && !recovery.current?.pendingSave) rememberScriptDraft(recovery.current); };
		window.addEventListener('pagehide', persist);
		return () => { window.removeEventListener('pagehide', persist); persist(); };
	}, []);
	useEffect(() => {
		mounted.current = true;
		if (opener || !document.activeElement || document.activeElement === document.body) focusInActiveWebview(nameField.current);
		return () => {
			mounted.current = false;
			if (!closed.current) return;
			const key = opener?.dataset.pmBashEditorOpener;
			const fallback = opener?.isConnected || !key ? opener
				: document.querySelector<HTMLElement>(`[data-pm-bash-editor-opener="${CSS.escape(key)}"]`);
			restoreWidgetDialogFocus(opener, fallback);
		};
	}, [opener]);
	useQuickNotesFocusFallback(form);

	/** Блокирует второе сохранение или чтение до ответа, в том числе при быстром повторе клавиш. */
	async function perform(kind: NonNullable<typeof localPending>, action: () => Promise<void>) {
		if (busy.current || draft.pendingSave) return;
		busy.current = true;
		setPending(kind);
		setError('');
		try { await action(); }
		catch (failure) { if (mounted.current) setError((failure as Error).message); }
		finally { busy.current = false; if (mounted.current) setPending(null); }
	}
	async function readFile(path: string) {
		const previousPath = currentPath.current;
		const initialEdits = nameEdits.current;
		const result = await send({ action: 'read', scope: draft.scope, path, ref: draft.ref, base: draft.base });
		if (!mounted.current || currentPath.current !== previousPath) return;
		if (typeof result.content !== 'string' || typeof result.revision !== 'string' || typeof result.path !== 'string') {
			throw new Error('Расширение не вернуло содержимое файла.');
		}
		const { content, path: selectedPath, revision } = result;
		const fillName = nameEdits.current === initialEdits;
		setDraft(previous => ({ ...previous, path: selectedPath, content,
			name: !previous.name && fillName ? selectedPath.split(/[/\\]/).pop() || '' : previous.name,
			file: { path: selectedPath, revision, original: content, exists: result.exists,
				nativeEditorReason: result.nativeEditorReason } }));
		// Даже повторное чтение той же ревизии по подтверждению сбрасывает undo отброшенного черновика.
		setReadVersion(version => version + 1);
	}
	// При восстановлении черновика уже прочитанный текст и revision берутся из состояния панели.
	useEffect(() => {
		if (initial.path && !initial.file) void perform('read', () => readFile(initial.path));
	}, [initial]);
	function requestRead(path: string) {
		if (!path.trim()) return;
		if (contentDirty) setConfirm({ kind: 'read', path });
		else void perform('read', () => readFile(path));
	}
	function chooseFile() {
		void perform('choose', async () => {
			const result = await send({ action: 'choose', scope: draft.scope });
			if (!mounted.current || !result.path) return;
			if (contentDirty) setConfirm({ kind: 'read', path: result.path });
			else { setPending('read'); await readFile(result.path); }
		});
	}
	function close() { closed.current = true; rememberScriptDraft(); onClose(); }
	function requestClose() {
		// Reads can be cancelled immediately. A dispatched save owns its draft until acknowledgement.
		if (draft.pendingSave || recovery.current?.pendingSave) return;
		if (dirty) setConfirm({ kind: 'close' }); else close();
	}
	// После повторного монтирования присоединяемся к сохранению ровно этого снимка.
	useEffect(() => {
		const save = draft.pendingSave;
		if (!save) return;
		let observing = true;
		void watchScriptSave(save).then(() => {
			if (!observing) return;
			const saved = restoreScriptDraft();
			if (saved?.saveFailure?.id === save.id) {
				busy.current = false;
				setDraft(saved);
				setError(saved.saveFailure.message);
			} else {
				closed.current = true;
				onClose();
			}
		});
		return () => { observing = false; };
	}, [draft.pendingSave, onClose]);
	function save() {
		if (!canSave || !draft.file || busy.current) return;
		busy.current = true;
		const submitted = submitScriptDraft(draft, draft.file.revision);
		recovery.current = submitted;
		setDraft(submitted);
		setError('');
	}
	return createPortal(<WidgetDialogOverlay onBackdrop={requestClose}>
		<style>{BASH_SCRIPT_EDITOR_CSS}</style>
		<div className="pm-qn-modal pm-bs-editor" role="dialog" aria-modal="true" aria-labelledby={heading} ref={form} tabIndex={-1}
			onKeyDownCapture={event => {
				if (event.nativeEvent.isComposing || (!event.metaKey && !event.ctrlKey)) return;
				const codePanel = event.target instanceof Element && event.target.closest('.cm-panel');
				if (event.code === 'KeyS' || event.key.toLowerCase() === 's' || (event.key === 'Enter' && !codePanel)) {
					event.preventDefault(); event.stopPropagation(); if (!confirm) save();
				}
			}}
			onKeyDown={event => {
				event.stopPropagation();
				if (event.defaultPrevented || event.nativeEvent.isComposing) return;
				trapQuickNotesTabKey(event, event.currentTarget);
				if (event.key === 'Escape') {
					event.preventDefault(); if (confirm) setConfirm(null); else requestClose();
				} else if (event.key === 'Enter' && event.target === nameField.current) {
					event.preventDefault(); if (!confirm) save();
				}
			}}>
			<header className="pm-qn-modal-h"><strong id={heading} className="pm-qn-crumb">{draft.ref ? 'Редактировать Bash скрипт' : 'Добавить Bash скрипт'}</strong>
				<button className="pm-qn-icon-btn" type="button" aria-label="Закрыть редактор" title="Закрыть (Escape)" disabled={pending === 'save'} onClick={requestClose}><QuickNoteIcon name="close" /></button>
			</header>
			<div className="pm-qn-modal-b" aria-busy={!!pending}>
				<div className="pm-bs-editor-fields"><label>Название скрипта<input className="pm-qn-input" name="bashScriptName" ref={nameField} value={draft.name} readOnly={pending === 'save' || !!confirm}
					onChange={e => { const name = e.target.value; nameEdits.current++; setDraft(previous => ({ ...previous, name })); }} /></label>
					<label>Область<select name="bashScriptScope" value={draft.scope} disabled={!!draft.ref || !!pending || !!confirm} onChange={e => { const scope = e.target.value as BashScriptScope; setDraft(previous => ({ ...previous, scope })); }}>
						<option value="project">Проект</option><option value="global">Глобальная</option>
					</select></label></div>
				<div><label htmlFor={pathId}>Путь к файлу</label><div className="pm-bs-path">
					<input id={pathId} name="bashScriptPath" className="pm-qn-input" value={draft.path} placeholder={draft.scope === 'project' ? 'scripts/build.sh или полный путь' : 'Полный путь к скрипту'} readOnly={!!pending || !!confirm}
						onChange={e => { const path = e.target.value; currentPath.current = path; setDraft(previous => ({ ...previous, path })); }}
						onKeyDown={e => { if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); requestRead(draft.path); } }} />
					<button type="button" className="pm-qn-btn is-secondary" title="Выбрать файл скрипта" aria-label="Выбрать файл скрипта" disabled={!!pending || !!confirm} onClick={chooseFile}><QuickNoteIcon name="folder-opened" /></button>
					<button type="button" className="pm-qn-btn is-secondary" disabled={!draft.path.trim() || !!pending || !!confirm} onClick={() => requestRead(draft.path)}>{loaded ? 'Перечитать' : 'Загрузить'}</button>
				</div></div>
				<div className="pm-bs-content">
					{loaded && draft.file?.nativeEditorReason ? <div>
						<p>{draft.file.nativeEditorReason}</p>
						<button type="button" className="pm-qn-btn is-secondary" disabled={!!pending || !!confirm}
							onClick={() => void perform('openFile', async () => { await send({ action: 'openFile', scope: draft.scope, path: draft.path }); })}>
							Открыть файл в VS Code
						</button>
					</div> : loaded ? <BashScriptCodeEditor key={readVersion} value={draft.content} filename={draft.path.split(/[/\\]/).pop() || draft.path}
						disabled={!!pending || !!confirm} onChange={content => setDraft(previous => ({ ...previous, content }))} />
						: pending !== 'read' && <div className="pm-bs-code-message">Выберите файл или загрузите его по пути.</div>}
					{pending === 'read' && <BashScriptContentLoader>Чтение файла…</BashScriptContentLoader>}
				</div>
				{loaded && draft.file?.exists === false && <div role="status">
					{draft.ref && !draft.content ? 'Файл отсутствует. Сохранится только запись в списке.' : 'Файл будет создан при сохранении.'}
				</div>}
				{error && <div role="alert" className="pm-qn-banner is-error">{error}</div>}
			</div>
			<footer className="pm-qn-modal-f">
				{confirm ? <><span role="alert">{confirm.kind === 'close' ? 'Сохранить изменения перед закрытием?' : 'Заменить изменённый текст содержимым файла?'}</span>
					<button type="button" className="pm-qn-btn is-secondary" ref={focusInActiveWebview} disabled={!!pending} onClick={() => setConfirm(null)}>Продолжить редактирование</button>
					{confirm.kind === 'close' ? <><button type="button" className="pm-qn-btn is-danger" disabled={!!pending} onClick={close}>Закрыть без сохранения</button>
						<button type="button" className="pm-qn-btn is-primary" disabled={!canSave} onClick={() => { setConfirm(null); save(); }}>Сохранить</button></>
						: <button type="button" className="pm-qn-btn is-danger" onClick={() => { const path = confirm.path; setConfirm(null); void perform('read', () => readFile(path)); }}>Заменить текст</button>}
				</> : <><span className={dirty ? 'pm-qn-dirty' : undefined} role="status">{pending === 'save' ? 'Сохранение…' : dirty ? 'Есть несохранённые изменения' : ''}</span>
					<button className="pm-qn-btn is-secondary" type="button" disabled={pending === 'save'} onClick={requestClose}>Закрыть</button>
					<button className="pm-qn-btn is-primary" type="button" disabled={!canSave} title="Сохранить (Ctrl+S)" onClick={save}>Сохранить</button></>}
			</footer>
		</div>
	</WidgetDialogOverlay>, document.body);
}
