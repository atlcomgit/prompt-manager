/**
 * Страница доски быстрых заметок (отдельная вкладка редактора): клиент заметок, настройки вида и окно заметки.
 * Данные и настройки общие с виджетом панели «Обзор»: расширение рассылает изменения всем открытым страницам.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
	normalizePromptDashboardQuickNotesWidgetState,
	type DashboardQuickNotesWidgetState,
} from '../../types/promptDashboardPreferences.js';
import { QuickNoteIcon } from '../editor/components/quickNotes/QuickNoteIcon';
import { QuickNotesBoard } from '../editor/components/quickNotes/QuickNotesBoard';
import { QUICK_NOTES_CSS } from '../editor/components/quickNotes/quickNotesStyles';
import { QuickNoteModalHost, useQuickNotesActions } from '../editor/components/quickNotes/useQuickNotesActions';
import { useQuickNotesClient } from '../editor/components/quickNotes/useQuickNotesClient';
import { getVsCodeApi } from '../shared/vscodeApi';

/** Отправляет сообщение расширению; вне webview (SSR и тесты) ничего не делает. */
function postToHost(message: Record<string, unknown>): void {
	try {
		getVsCodeApi().postMessage(message);
	} catch {
		// Вне webview API недоступен.
	}
}

/**
 * Настройки вида заметок страницы: начальное значение по умолчанию, затем значение расширения.
 * Изменение применяется сразу и сохраняется вместе с базой, чтобы расширение записало только изменённые поля.
 */
function useQuickNotesPreferences(): [DashboardQuickNotesWidgetState, (patch: Partial<DashboardQuickNotesWidgetState>) => void] {
	const [preferences, setPreferences] = useState(() => normalizePromptDashboardQuickNotesWidgetState(undefined));
	const preferencesRef = useRef(preferences);
	preferencesRef.current = preferences;

	useEffect(() => {
		const listener = (event: MessageEvent) => {
			const message = event.data as { type?: unknown; state?: unknown } | null;
			if (message?.type === 'quickNotesPreferences') {
				setPreferences(normalizePromptDashboardQuickNotesWidgetState(message.state));
			}
		};
		window.addEventListener('message', listener);
		postToHost({ type: 'quickNotesRequestPreferences' });
		return () => window.removeEventListener('message', listener);
	}, []);

	const change = useCallback((patch: Partial<DashboardQuickNotesWidgetState>) => {
		const base = preferencesRef.current;
		const next = normalizePromptDashboardQuickNotesWidgetState({ ...base, ...patch });
		preferencesRef.current = next;
		setPreferences(next);
		postToHost({ type: 'quickNotesSavePreferences', state: next, baseState: base });
	}, []);

	return [preferences, change];
}

/** Страница доски заметок. */
export function QuickNotesBoardApp(): React.ReactElement {
	const client = useQuickNotesClient();
	const actions = useQuickNotesActions(client);
	const [preferences, changePreferences] = useQuickNotesPreferences();
	const { state } = client;

	return (
		<>
			<style>{QUICK_NOTES_CSS}</style>
			{state ? (
				<QuickNotesBoard
					state={state}
					preferences={preferences}
					newNoteIds={actions.newNoteIds}
					covered={actions.modal !== null}
					error={actions.error}
					onDismissError={actions.dismissError}
					onPreferencesChange={changePreferences}
					onCreate={input => actions.createNote(input)?.saved ?? false}
					onApply={actions.applyAll}
					onToggleDone={actions.toggleDone}
					onToggleItem={actions.toggleItem}
					onSetColor={actions.setColor}
					onOpen={(note, navigationIds) => actions.openModal(note, navigationIds)}
					onOpenStorageFile={client.openStorageFile}
					onReload={client.reload}
				/>
			) : (
				<div className="pm-qn-scope pm-qn-board">
					<div className="pm-qn-board-empty" role="status">
						<QuickNoteIcon name="loading" size={14} className="pm-qn-spin" /> Загружаем заметки…
					</div>
				</div>
			)}
			<QuickNoteModalHost client={client} actions={actions} />
		</>
	);
}
