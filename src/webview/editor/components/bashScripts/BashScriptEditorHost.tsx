import React, { createContext, useCallback, useEffect, useState } from 'react';
import { BashScriptEditor } from './BashScriptEditor';
import { restoreScriptDraft, type ScriptDraft } from './bashScriptDraft';

type EditorSession = { draft: ScriptDraft; opener: HTMLButtonElement | null };

/** The dialog belongs to the dashboard, so changing the widget's column never remounts the active input. */
export const OpenBashScriptEditor = createContext<(draft: ScriptDraft, opener: HTMLButtonElement) => void>(() => {});

export function BashScriptEditorHost({ children, enabled = true }: { children: React.ReactNode; enabled?: boolean }) {
	const [session, setSession] = useState<EditorSession | null>(null);
	const open = useCallback((draft: ScriptDraft, opener: HTMLButtonElement) => setSession({ draft, opener }), []);
	const close = useCallback(() => setSession(null), []);
	useEffect(() => {
		if (!enabled) { setSession(null); return; }
		const draft = restoreScriptDraft();
		if (draft) setSession(current => current ?? { draft, opener: null });
	}, [enabled]);
	return <OpenBashScriptEditor.Provider value={open}>
		{children}
		{enabled && session && <BashScriptEditor initial={session.draft} opener={session.opener} onClose={close} />}
	</OpenBashScriptEditor.Provider>;
}
