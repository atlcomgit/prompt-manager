import React from 'react';
import { QUICK_NOTE_PALETTE_COLORS } from '../../../../types/quickNotes.js';
import { normalizeQuickNoteColor } from '../../../../utils/quickNotes.js';
import { resolveQuickNoteColorCss, resolveQuickNoteColorLabel } from './quickNotesStyles';

/** Палитра для новой заметки и окна редактирования. */
export function QuickNoteColorPicker({ color, label, onChange }: {
	color: string;
	label: string;
	onChange(color: string): void;
}): React.ReactElement {
	const selected = normalizeQuickNoteColor(color);
	const custom = selected.startsWith('#');
	return (
		<div className="pm-qn-swatches" role="group" aria-label={label}>
			<button type="button" className="pm-qn-swatch is-none" aria-pressed={!selected}
				title="Без цвета" aria-label="Без цвета" onClick={() => onChange('')} />
			{QUICK_NOTE_PALETTE_COLORS.map(value => (
				<button key={value} type="button" className="pm-qn-swatch" aria-pressed={selected === value}
					title={resolveQuickNoteColorLabel(value)} aria-label={resolveQuickNoteColorLabel(value)}
					style={{ background: resolveQuickNoteColorCss(value) }} onClick={() => onChange(value)} />
			))}
			<label className={`pm-qn-swatch is-custom${custom ? ' is-selected' : ''}`} title="Свой цвет…"
				style={custom ? { background: selected } : undefined}>
				<input type="color" aria-label={custom ? `Свой цвет: ${selected}, выбран` : 'Свой цвет'}
					value={custom ? selected : '#3794ff'} onChange={event => onChange(event.target.value)} />
			</label>
		</div>
	);
}
