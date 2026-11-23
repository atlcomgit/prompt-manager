import { postQuickCommandSave } from '../quickCommandSave';
import { WidgetDialogOverlay } from './quickNotes/WidgetDialogOverlay';
import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { DASHBOARD_QUICK_COMMAND_REPLY_TIMEOUT_MS } from '../../../constants/webview.js';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../../types/messages.js';
import type { Prompt } from '../../../types/prompt.js';
import {
	DASHBOARD_QUICK_COMMAND_CATEGORY_LIMIT, DASHBOARD_QUICK_COMMAND_LIMIT, DASHBOARD_QUICK_COMMAND_TEXT_LIMIT,
	type DashboardQuickCommand, type PromptDashboardPreferences,
} from '../../../types/promptDashboardPreferences.js';
import { QUICK_COMMAND_VARIABLES, type QuickCommandTemplateResult } from '../../../utils/quickCommandTemplate.js';
import { getVsCodeApi } from '../../shared/vscodeApi';
import { textareaDraft, textareaValue } from '../../shared/textareaValue';
import { QuickNoteIcon } from './quickNotes/QuickNoteIcon';
import { focusInActiveWebview, restoreWidgetDialogFocus, trapQuickNotesTabKey, useQuickNotesFocusFallback } from './quickNotes/quickNotesFocus';

/** Исходная строка сохраняет привязку при перестановке команд. Кнопка получает фокус после закрытия. */
export interface QuickCommandEditSession {
	original: DashboardQuickCommand | null;
	opener: HTMLButtonElement;
}

/** Поля промпта, при изменении которых значения шаблона нужно запросить заново. */
export type QuickCommandPreviewPrompt = Pick<Prompt, 'id' | 'promptUuid' | 'title' | 'taskNumber' | 'archived'>;

type SaveRequest = Extract<WebviewToExtensionMessage, { type: 'savePromptDashboardQuickCommand' }>;

/** Редактор команды поверх обеих колонок панели. Шаблон хранится без подстановки значений. */
export function QuickCommandModal({ session, items, prompt, recoverableTexts, migration, onClose }: {
	session: QuickCommandEditSession;
	items: DashboardQuickCommand[];
	prompt: QuickCommandPreviewPrompt;
	recoverableTexts?: Record<string, string>;
	onClose(): void;
	migration?: PromptDashboardPreferences;
}): React.ReactPortal {
	const { original, opener } = session;
	const [base, setBase] = useState(original);
	const [restoredFrom, setRestoredFrom] = useState<string>();
	const [title, setTitle] = useState(original?.title ?? '');
	const [text, setText] = useState(original?.text ?? '');
	const [category, setCategory] = useState(original?.category ?? '');
	const [confirmClose, setConfirmClose] = useState(false);
	const [previewOpen, setPreviewOpen] = useState(false);
	const [insertError, setInsertError] = useState('');
	const [saveError, setSaveError] = useState('');
	const [pending, setPending] = useState<SaveRequest>();
	const lastAttempt = useRef<{ draft: string; request: SaveRequest }>();
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	const titleRef = useRef<HTMLInputElement>(null);
	const formRef = useRef<HTMLFormElement>(null);
	const savedTitle = useRef<string>();
	const textRef = useRef<HTMLTextAreaElement>(null);
	const headingId = useId();
	const categoriesId = 'pm-command-categories-' + useId().replace(/:/g, '');
	const previewId = useId();
	const name = title.trim();
	const dirty = title !== (original?.title ?? '') || text !== (original?.text ?? '') || category !== (original?.category ?? '');
	const live = base && items.find(item => item.title === base.title);
	const duplicate = items.some(item => item.title === name && item.title !== base?.title);
	const conflict = base && (!live || live.text !== base.text || live.category !== base.category);
	const command = { title: name, text, ...(category.trim() ? { category: category.trim() } : {}) };
	const draft = JSON.stringify([command, restoredFrom]);
	const retry = Boolean(saveError && lastAttempt.current?.draft === draft);
	const canSave = !pending && !confirmClose && name && (retry || (!duplicate && !conflict && (base || items.length < DASHBOARD_QUICK_COMMAND_LIMIT)));

	// Keep the exact base for retries, including a settings broadcast preceding a lost acknowledgement.
	useEffect(() => {
		if (!pending) return;
		const receive = (event: MessageEvent<ExtensionToWebviewMessage>) => {
			const reply = event.data;
			if (reply?.type !== 'promptDashboardQuickCommandSaved' || reply.requestId !== pending.requestId) return;
			window.clearTimeout(timeout);
			if (reply.error) { setSaveError(reply.error); setPending(undefined); }
			else { savedTitle.current = name; closeRef.current(); }
		};
		const timeout = window.setTimeout(() => {
			setSaveError('Расширение не подтвердило сохранение. Черновик доступен для повтора.');
			setPending(undefined);
		}, DASHBOARD_QUICK_COMMAND_REPLY_TIMEOUT_MS);
		window.addEventListener('message', receive);
		const controller = new AbortController();
		void postQuickCommandSave(pending, reason => {
			if (controller.signal.aborted) return;
			setSaveError(reason); setPending(undefined);
		}, controller.signal);
		return () => { controller.abort(); window.removeEventListener('message', receive); window.clearTimeout(timeout); };
	}, [pending, name]);

	useEffect(() => {
		focusInActiveWebview(titleRef.current);
		return () => {
			// Переименование и перенос между колонками заменяют исходную кнопку новым DOM-элементом.
			const name = savedTitle.current ?? original?.title;
			const restore = (attempt: number) => {
				const row = name && document.querySelector(`.pm-quick-commands [data-pm-editor-section="${CSS.escape(name)}"]`);
				const target = (row || null)?.querySelector<HTMLButtonElement>('[aria-label="Изменить команду"]');
				if (!target && savedTitle.current && original?.title !== name && attempt < 3) {
					window.requestAnimationFrame(() => restore(attempt + 1)); return;
				}
				const button = target ?? (opener.isConnected ? opener
					: document.querySelector<HTMLButtonElement>('[aria-label="Добавить быструю команду"]'));
				restoreWidgetDialogFocus(opener, button ?? null);
			};
			restore(0);
		};
	}, [opener, original]);
	useQuickNotesFocusFallback(formRef);

	/** Кнопка заменяет выделение и возвращает каретку сразу за вставленный маркер. */
	const insertVariable = (key: string) => {
		const field = textRef.current;
		if (!field) return;
		const token = `{{${key}}}`;
		const { selectionStart, selectionEnd } = field;
		// DOM selection offsets use LF even when the saved template contains CRLF.
		const next = field.value.slice(0, selectionStart) + token + field.value.slice(selectionEnd);
		if (next.length > DASHBOARD_QUICK_COMMAND_TEXT_LIMIT) {
			setInsertError(`Для переменной не хватает места. Максимум — ${DASHBOARD_QUICK_COMMAND_TEXT_LIMIT} символов.`);
			return;
		}
		flushSync(() => { setInsertError(''); setText(next); });
		field.focus();
		field.setSelectionRange(selectionStart + token.length, selectionStart + token.length);
	};
	const requestClose = () => { if (pending) return; if (dirty) setConfirmClose(true); else onClose(); };

	return createPortal(
		<WidgetDialogOverlay onBackdrop={requestClose}>
			<form ref={formRef} tabIndex={-1} className="pm-qn-modal pm-quick-command-modal" role="dialog" aria-modal="true" aria-labelledby={headingId}
				onSubmit={event => {
					event.preventDefault();
					event.stopPropagation();
					if (canSave) {
						const restore = restoredFrom !== undefined && Object.hasOwn(recoverableTexts ?? {}, restoredFrom)
							? { title: restoredFrom, text: recoverableTexts![restoredFrom] } : undefined;
						const edit = retry && lastAttempt.current ? lastAttempt.current.request.edit : { original: base, command, restore };
						const request: SaveRequest = { type: 'savePromptDashboardQuickCommand', requestId: crypto.randomUUID(), edit, migration };
						lastAttempt.current = { draft, request };
						setSaveError('');
						setPending(request);
					}
				}}
				onKeyDown={event => {
					event.stopPropagation();
					if (event.nativeEvent.isComposing) return;
					trapQuickNotesTabKey(event, event.currentTarget);
					if (event.key === 'Escape') {
						event.preventDefault();
						if (confirmClose) setConfirmClose(false); else requestClose();
					} else if ((event.ctrlKey || event.metaKey) && (event.key === 'Enter' || event.code === 'KeyS' || event.key.toLowerCase() === 's')) {
						event.preventDefault();
						event.currentTarget.requestSubmit();
					}
				}}>
				<header className="pm-qn-modal-h">
					<span id={headingId} className="pm-qn-crumb">{original ? 'Редактировать команду' : 'Новая быстрая команда'}</span>
					<button type="button" className="pm-qn-icon-btn" aria-label="Закрыть" title="Закрыть (Escape)" onClick={requestClose}>
						<QuickNoteIcon name="close" size={14} />
					</button>
				</header>
				<div className="pm-qn-modal-b" aria-busy={Boolean(pending)}>
					<label>Название команды
						<input readOnly={Boolean(pending)} className="pm-qn-input" ref={titleRef} value={title} maxLength={DASHBOARD_QUICK_COMMAND_TEXT_LIMIT}
							onChange={event => setTitle(event.target.value)} required />
					</label>
					<label>Категория
						<input readOnly={Boolean(pending)} className="pm-qn-input" value={category} placeholder="Без категории" list={categoriesId}
							maxLength={DASHBOARD_QUICK_COMMAND_CATEGORY_LIMIT} onChange={event => setCategory(event.target.value)} />
					</label>
					<datalist id={categoriesId}>{[...new Set(items.map(item => item.category).filter(Boolean))]
						.map(value => <option key={value} value={value} />)}</datalist>
					<label>Текст команды
						<textarea readOnly={Boolean(pending)} className="pm-qn-textarea" ref={textRef} rows={6} value={textareaValue(text)} maxLength={DASHBOARD_QUICK_COMMAND_TEXT_LIMIT}
							onChange={event => { setText(textareaDraft(event.target.value, original?.text ?? '')); setInsertError(''); }} />
					</label>
					<div role="group" aria-label="Вставить переменную" className="pm-quick-command-variables">
						<span className="pm-qn-label">Вставить переменную</span>
						{Object.entries(QUICK_COMMAND_VARIABLES).map(([key, label]) =>
							<button disabled={Boolean(pending)} key={key} type="button" className="pm-qn-btn is-secondary" title={`{{${key}}}`}
								onClick={() => insertVariable(key)}>{label}</button>)}
					</div>
					<div className="pm-quick-command-preview">
						<button type="button" className="pm-qn-btn is-secondary" aria-expanded={previewOpen}
							aria-controls={previewOpen ? previewId : undefined} onClick={() => setPreviewOpen(open => !open)}>
							<QuickNoteIcon name={previewOpen ? 'chevron-down' : 'chevron-right'} size={12} />
							Предпросмотр
						</button>
						{previewOpen && <QuickCommandPreview id={previewId} text={text} prompt={prompt} />}
					</div>
					{recoverableTexts && Object.keys(recoverableTexts).length > 0 && <details>
						<summary>Восстановить прежний текст</summary>
						{Object.entries(recoverableTexts).map(([source, body]) => <button type="button" key={source}
							className="pm-qn-btn is-secondary" disabled={Boolean(pending)} onClick={() => {
								setText(body); setRestoredFrom(source);
							}}>{source}</button>)}
					</details>}
					{duplicate && !pending && <div role="alert">Команда с таким названием уже есть.</div>}
					{conflict && !pending && <div role="alert">
						{live ? 'В другом окне сохранена новая версия команды.' : 'Команда удалена или переименована в другом окне.'}
						{live && <pre>{live.text}</pre>}
						<button type="button" className="pm-qn-btn is-secondary" onClick={() => {
							setBase(live || null); lastAttempt.current = undefined; setSaveError('');
						}}>{live ? 'Продолжить с моим черновиком' : 'Сохранить как новую команду'}</button>
					</div>}
					{saveError && <div role="alert">{saveError}</div>}
					{insertError && <div role="alert">{insertError}</div>}
				</div>
				<footer className="pm-qn-modal-f">
					{confirmClose ? <>
						<span>Закрыть без сохранения изменений?</span>
						<button type="button" className="pm-qn-btn is-danger" onClick={onClose}>Закрыть</button>
						<button type="button" className="pm-qn-btn is-secondary" onClick={() => setConfirmClose(false)}>Остаться</button>
					</> : <>
						<span className="pm-qn-grow" />
						<button type="button" className="pm-qn-btn is-secondary" onClick={requestClose}>Отмена</button>
						<button type="submit" className="pm-qn-btn is-primary" disabled={!canSave} title="Сохранить (Ctrl+Enter)">{pending ? 'Сохранение…' : 'Сохранить'}</button>
					</>}
				</footer>
			</form>
		</WidgetDialogOverlay>, document.body,
	);
}

/** Только открытый предпросмотр запрашивает подстановку для текущего, в том числе несохранённого, текста. */
function QuickCommandPreview({ id, text, prompt }: { id: string; text: string; prompt: QuickCommandPreviewPrompt }) {
	const [contextRevision, setContextRevision] = useState(0);
	// Переименование или архивирование может менять результат даже при тех же id и тексте.
	const request = useMemo<Extract<WebviewToExtensionMessage, { type: 'promptDashboardQuickCommandPreview' }>>(() => ({
		type: 'promptDashboardQuickCommandPreview', requestId: crypto.randomUUID(), text, promptId: prompt.id, promptUuid: prompt.promptUuid,
	}), [text, prompt.id, prompt.promptUuid, prompt.title, prompt.taskNumber, prompt.archived, contextRevision]);
	const [reply, setReply] = useState<{ requestId: string; result: QuickCommandTemplateResult }>();
	const result = reply?.requestId === request.requestId ? reply.result : undefined;
	const output = useRef<HTMLDivElement>(null);
	// В невысоком окне сразу открываем начало результата. Ни ответ хоста, ни ввод повторно не прокручивают форму.
	useLayoutEffect(() => {
		output.current?.parentElement?.scrollIntoView({ block: 'nearest' });
	}, []);

	useEffect(() => {
		let settled = false;
		const refresh = () => setContextRevision(revision => revision + 1);
		const finish = (result: QuickCommandTemplateResult) => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timeout);
			setReply({ requestId: request.requestId, result });
		};
		const receive = (event: MessageEvent<ExtensionToWebviewMessage>) => {
			const message = event.data;
			if (message?.type === 'promptDashboardQuickCommandPreviewInvalidated') {
				refresh();
			} else if (message?.type === 'promptDashboardQuickCommandPreviewResult' && message.requestId === request.requestId) {
				finish(message.result);
			}
		};
		const timeout = window.setTimeout(() => finish({ error: 'Расширение не ответило. Откройте предпросмотр ещё раз.' }),
			DASHBOARD_QUICK_COMMAND_REPLY_TIMEOUT_MS);
		window.addEventListener('message', receive);
		window.addEventListener('focus', refresh);
		// После короткой паузы запрашиваем только последнюю правку, в том числе при работе через Tunnel.
		const send = window.setTimeout(() => getVsCodeApi().postMessage(request), 150);
		return () => {
			window.clearTimeout(send);
			window.clearTimeout(timeout);
			window.removeEventListener('message', receive);
			window.removeEventListener('focus', refresh);
		};
	}, [request]);

	return <div ref={output} id={id} role="status" aria-label="Предпросмотр команды" aria-busy={!result}>
		{!result ? 'Подставляю значения…' : 'error' in result
			? <span className="pm-quick-command-preview-error">{result.error}</span> : <pre>{result.text}</pre>}
	</div>;
}
