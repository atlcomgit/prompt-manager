import { useCallback, useEffect, useRef, useState } from 'react';
import type { BashScriptEntry, BashScriptsRequest, BashScriptsResponse, BashScriptsResult } from '../../../../types/bashScripts.js';
import { getVsCodeApi } from '../../../shared/vscodeApi';

/** Поля действия, для которого клиент добавляет уникальный адрес ответа. */
export type BashScriptsAction = Omit<BashScriptsRequest, 'type' | 'requestId'>;
export type BashScriptsSend = (action: BashScriptsAction) => Promise<BashScriptsResult>;

/** Привязывает один ответ host к действию. Восстановленный save ожидает прежний requestId без повторной отправки. */
export function requestBashScripts(requestId: string, deadline: number, action?: BashScriptsAction,
	signal?: AbortSignal): Promise<BashScriptsResult> {
	return new Promise((resolve, reject) => {
		const finish = (response?: BashScriptsResponse, reason?: string) => {
			window.clearTimeout(timer);
			window.removeEventListener('message', receive);
			signal?.removeEventListener('abort', abort);
			if (reason || response?.error) reject(new Error(reason || response?.error));
			else resolve(response?.result ?? {});
		};
		const abort = () => finish(undefined, 'Виджет закрыт.');
		const receive = (event: MessageEvent<BashScriptsResponse>) => {
			if (event.data?.type === 'bashScriptsResponse' && event.data.requestId === requestId) finish(event.data);
		};
		const timer = window.setTimeout(() => finish(undefined, 'Расширение не ответило. Проверьте состояние скрипта перед повтором.'),
			Math.max(0, deadline - Date.now()));
		if (signal?.aborted) { abort(); return; }
		window.addEventListener('message', receive);
		signal?.addEventListener('abort', abort, { once: true });
		try {
			if (action) getVsCodeApi().postMessage({ ...action, type: 'bashScriptsRequest', requestId } satisfies BashScriptsRequest);
		} catch (error) { finish(undefined, error instanceof Error ? error.message : String(error)); }
	});
}

/** The editor and the list cancel only their own requests when they unmount. */
export function useBashScriptSender(): BashScriptsSend {
	const lifetime = useRef<AbortController | null>(null);
	const send = useCallback<BashScriptsSend>(action => {
		const controller = lifetime.current ??= new AbortController();
		const timeout = action.action === 'choose' ? 10 * 60_000 : 60_000;
		return requestBashScripts(crypto.randomUUID(), Date.now() + timeout, action, controller.signal);
	}, []);
	useEffect(() => () => { lifetime.current?.abort(); lifetime.current = null; }, []);
	return send;
}

// Снимок принадлежит документу webview и доступен сразу при переносе виджета между колонками.
let lastList: BashScriptsResult | undefined;

/** Запросы списка версионируются: медленное чтение до обновления не заменит новый список. */
export function useBashScripts(expanded: boolean) {
	const [entries, setEntries] = useState<BashScriptEntry[] | null>(lastList?.entries ?? null);
	const [listError, setListError] = useState(lastList?.warning ?? '');
	const sequence = useRef(0);
	const stale = useRef(true);
	const pending = useRef<Promise<void>>();
	const send = useBashScriptSender();
	const reload = useCallback(async (scan = false) => {
		stale.current = false;
		const ticket = ++sequence.current;
		try {
			const result = await send({ action: scan ? 'scan' : 'list' });
			if (ticket !== sequence.current) return;
			if (!Array.isArray(result.entries)) throw new Error('Расширение не вернуло список скриптов.');
			lastList = result;
			stale.current = !!result.warning;
			setEntries(result.entries);
			setListError(result.warning ?? '');
		} catch (error) {
			if (ticket === sequence.current) {
				stale.current = true;
				setListError((error as Error).message);
			}
		}
	}, [send]);
	const refresh = useCallback((scan = false) => {
		const request = reload(scan);
		pending.current = request;
		void request.finally(() => { if (pending.current === request) pending.current = undefined; });
		return request;
	}, [reload]);
	const afterRun = useCallback(() => pending.current ?? refresh(), [refresh]);
	const visible = useRef(expanded);
	visible.current = expanded;
	useEffect(() => {
		const receive = (event: MessageEvent) => {
			if (event.data?.type !== 'bashScriptsChanged') return;
			stale.current = true;
			if (visible.current) void refresh();
			else ++sequence.current;
		};
		window.addEventListener('message', receive);
		return () => {
			window.removeEventListener('message', receive);
			++sequence.current;
			stale.current = true;
		};
	}, [refresh]);
	useEffect(() => { if (expanded && stale.current) void refresh(); }, [expanded, refresh]);
	return { entries, send, listError, reload: refresh, afterRun };
}
