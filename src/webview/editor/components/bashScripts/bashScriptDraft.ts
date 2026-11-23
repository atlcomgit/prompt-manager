import type { BashScriptEntry, BashScriptRef, BashScriptScope } from '../../../../types/bashScripts.js';
import { getVsCodeApi } from '../../../shared/vscodeApi';
import { requestBashScripts, type BashScriptsAction } from './useBashScripts';

/** Обе области разрешают относительный путь от одного корня. Ревизию конкретного файла проверяет host. */
interface FileSnapshot { path: string; revision: string; original: string; exists?: boolean; nativeEditorReason?: string }
interface PendingSave { id: string; deadline: number }
export interface ScriptDraft {
	ref?: BashScriptRef;
	base?: { name: string; path: string };
	scope: BashScriptScope;
	name: string;
	path: string;
	content: string;
	file?: FileSnapshot;
	pendingSave?: PendingSave;
	saveFailure?: { id: string; message: string };
}

export function newScriptDraft(entry?: BashScriptEntry, scope: BashScriptScope = 'project'): ScriptDraft {
	return entry ? { ref: { scope: entry.scope, id: entry.id }, base: { name: entry.name, path: entry.path },
		scope: entry.scope, name: entry.name, path: entry.path, content: '' }
		: { scope, name: '', path: '', content: '' };
}

/** Состояние принадлежит одной панели VS Code и переживает повторное создание React-компонента. */
export function restoreScriptDraft(): ScriptDraft | undefined {
	const saved: ScriptDraft | undefined = getVsCodeApi().getState?.()?.bashScriptDraft;
	if (saved && (saved.scope === 'global' || saved.scope === 'project') && typeof saved.path === 'string'
		&& typeof saved.name === 'string' && typeof saved.content === 'string') return saved;
	return undefined;
}

export function rememberScriptDraft(draft?: ScriptDraft) {
	const api = getVsCodeApi();
	const state = { ...api.getState?.() };
	if (draft) state.bashScriptDraft = draft;
	else if (Object.hasOwn(state, 'bashScriptDraft')) delete state.bashScriptDraft;
	else return;
	api.setState?.(state);
}

// Ожидание записи живёт до ответа или таймаута, даже когда виджет перемещается между колонками.
const saves = new Map<string, Promise<void>>();

export function watchScriptSave(save: PendingSave, action?: BashScriptsAction): Promise<void> {
	const active = saves.get(save.id);
	if (active) return active;
	if (restoreScriptDraft()?.pendingSave?.id !== save.id) return Promise.resolve();
	const settle = (message?: string) => {
		const current = restoreScriptDraft();
		// Запоздалое подтверждение может относиться к уже заменённому черновику.
		if (current?.pendingSave?.id !== save.id) return;
		rememberScriptDraft(message ? { ...current, pendingSave: undefined, saveFailure: { id: save.id, message } } : undefined);
	};
	const completion = requestBashScripts(save.id, save.deadline, action)
		.then(() => settle(), (error: Error) => settle(error.message))
		.finally(() => saves.delete(save.id));
	saves.set(save.id, completion);
	return completion;
}

export function submitScriptDraft(draft: ScriptDraft, revision: string): ScriptDraft {
	const pendingSave = { id: crypto.randomUUID(), deadline: Date.now() + 60_000 };
	const submitted = { ...draft, pendingSave, saveFailure: undefined };
	rememberScriptDraft(submitted);
	void watchScriptSave(pendingSave, { action: 'save', ref: draft.ref, base: draft.base, scope: draft.scope,
		path: draft.path, name: draft.name.trim(), content: draft.content, revision });
	return submitted;
}
