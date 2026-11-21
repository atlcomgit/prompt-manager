import type { QuickNotesState, QuickNoteView } from '../src/types/quickNotes.js';
import { normalizePromptDashboardQuickNotesWidgetState } from '../src/types/promptDashboardPreferences.js';
import type { QuickNotesWidgetProps } from '../src/webview/editor/components/quickNotes/QuickNotesWidget.js';

/** Состояние обеих областей для тестов виджета и доски. */
export function createState(notes: QuickNoteView[], patch: Partial<QuickNotesState['scopes']> = {}): QuickNotesState {
	return {
		scopes: {
			workspace: { scope: 'workspace', available: true, filePath: '.vscode/prompt-manager/quick-notes.json' },
			global: { scope: 'global', available: true, filePath: '~/.vscode/prompt-manager/quick-notes.json' },
			...patch,
		},
		notes,
	};
}

const noop = () => undefined;
/** Свойства виджета для проверок разметки и взаимодействия без extension host. */
export const widgetDefaults: QuickNotesWidgetProps = {
	state: null, preferences: normalizePromptDashboardQuickNotesWidgetState({}), expanded: {}, newNoteIds: new Set(),
	onAdd: () => false, onPreferencesChange: noop, onToggleExpanded: noop, onToggleDone: noop, onToggleItem: noop,
	onOpen: noop, onOpenPrompt: noop, onReorder: noop, onClearDone: noop, onOpenStorageFile: noop, onReload: noop,
	onPin: noop, onDelete: noop, onDuplicate: noop, onSetColor: noop,
};
