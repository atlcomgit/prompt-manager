import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { QuickNoteView } from '../../../../types/quickNotes.js';
import { getQuickNoteChecklistProgress } from '../../../../utils/quickNotes.js';
import { QuickNoteIcon } from './QuickNoteIcon';
import { resolveQuickNoteColorCss } from './quickNotesStyles';

/** Содержимое заметки для чтения рядом со строкой списка. */
export function QuickNotePreview({ id, note, anchor, onDismiss }: {
	id: string;
	note: QuickNoteView;
	anchor: HTMLElement;
	onDismiss(): void;
}): React.ReactElement {
	const cardRef = useRef<HTMLDivElement>(null);
	const { done, total } = getQuickNoteChecklistProgress(note);
	const color = resolveQuickNoteColorCss(note.color);

	// Перестройка списка тоже сдвигает якорь. Карточка не перекрывает его при двойном щелчке.
	useLayoutEffect(() => {
		const card = cardRef.current;
		if (!card) return;
		const updatePosition = () => {
			const { top, bottom, left } = anchor.getBoundingClientRect();
			if (!anchor.isConnected || bottom <= 0 || top >= window.innerHeight) {
				onDismiss();
				return;
			}
			const gap = 8;
			const roomAbove = top - gap * 2;
			const roomBelow = window.innerHeight - bottom - gap * 2;
			const requiredHeight = Math.min(420, card.scrollHeight + card.offsetHeight - card.clientHeight);
			const above = roomBelow < requiredHeight && roomAbove > roomBelow;
			card.style.left = `${Math.max(gap, Math.min(left, window.innerWidth - card.offsetWidth - gap))}px`;
			card.style.maxHeight = `${Math.max(0, Math.min(420, above ? roomAbove : roomBelow))}px`;
			card.style.top = above ? 'auto' : `${bottom + gap}px`;
			card.style.bottom = above ? `${window.innerHeight - top + gap}px` : 'auto';
		};
		updatePosition();
		window.addEventListener('resize', updatePosition);
		return () => window.removeEventListener('resize', updatePosition);
	});

	// Фокус позволяет сразу читать и прокручивать карточку с клавиатуры.
	useLayoutEffect(() => cardRef.current?.focus({ preventScroll: true }), []);

	/** Возвращает фокус в список при явном закрытии карточки. */
	const closePreview = () => {
		anchor.focus({ preventScroll: true });
		onDismiss();
	};
	useEffect(() => {
		const dismissOnPointer = (event: PointerEvent) => {
			if (event.target instanceof Node && !cardRef.current?.contains(event.target) && !anchor.contains(event.target)) {
				onDismiss();
			}
		};
		const dismissOnScroll = (event: Event) => {
			if (!(event.target instanceof Node) || !cardRef.current?.contains(event.target)) onDismiss();
		};
		const dismissOnEscape = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			if (cardRef.current?.contains(document.activeElement)) anchor.focus({ preventScroll: true });
			onDismiss();
		};
		window.addEventListener('pointerdown', dismissOnPointer, true);
		window.addEventListener('scroll', dismissOnScroll, true);
		window.addEventListener('keydown', dismissOnEscape);
		// При переходе в другую часть VS Code браузер не передаёт новый элемент в onBlur карточки.
		window.addEventListener('blur', onDismiss);
		return () => {
			window.removeEventListener('pointerdown', dismissOnPointer, true);
			window.removeEventListener('scroll', dismissOnScroll, true);
			window.removeEventListener('keydown', dismissOnEscape);
			window.removeEventListener('blur', onDismiss);
		};
	}, [anchor, onDismiss]);

	return createPortal(
		<div ref={cardRef} id={id} role="dialog" aria-labelledby={`${id}-title`} tabIndex={0}
			className="pm-qn-preview pm-qn-scope" style={color ? { ['--pm-qn-note' as string]: color } : undefined}
			onBlur={event => {
				const target = event.relatedTarget;
				if (target && !event.currentTarget.contains(target) && !anchor.contains(target)) onDismiss();
			}}>
			<header className="pm-qn-preview-header">
				<h2 id={`${id}-title`}>{note.title}</h2>
				<button type="button" className="pm-qn-icon-btn" aria-label="Закрыть предпросмотр" onClick={closePreview}>
					<QuickNoteIcon name="close" size={14} />
				</button>
			</header>
			{note.description.trim() ? <div className="pm-qn-preview-description">{note.description}</div> : null}
			{total > 0 ? (
				<section className="pm-qn-preview-section">
					<h3><QuickNoteIcon name="checklist" size={13} />Чек-лист <span>{done}/{total}</span></h3>
					<ul>
						{note.items.map(item => (
							<li key={item.id} className={item.done ? 'is-done' : undefined}>
								<span className="pm-qn-preview-check" role="img" aria-label={item.done ? 'Готово' : 'Открыто'}>
									{item.done ? <QuickNoteIcon name="check" size={10} /> : null}
								</span>
								<span>{item.text}</span>
							</li>
						))}
					</ul>
				</section>
			) : null}
			{note.files.length > 0 ? (
				<section className="pm-qn-preview-section">
					<h3><QuickNoteIcon name="attach" size={13} />Вложения</h3>
					<ul>{note.files.map(file => <li key={file.id}>{file.name}</li>)}</ul>
				</section>
			) : null}
		</div>,
		document.body,
	);
}
