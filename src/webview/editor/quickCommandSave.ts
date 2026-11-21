import { getVsCodeApi } from '../shared/vscodeApi';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../types/messages.js';
import { DASHBOARD_QUICK_COMMAND_REPLY_TIMEOUT_MS } from '../../constants/webview.js';

type Save = Extract<WebviewToExtensionMessage, { type: 'savePromptDashboardQuickCommand' | 'savePromptDashboardPreferences' }>;

/** Panels sharing a client origin serialize writes even when their extension hosts live on different servers. */
export async function postQuickCommandSave(message: Save, onError: (reason: string) => void, signal?: AbortSignal): Promise<void> {
	const send = () => { if (!signal?.aborted) getVsCodeApi().postMessage(message); };
	let entered = false;
	try {
		if (!navigator.locks) { send(); return; }
		await navigator.locks.request('promptManager.quickCommands.save', { ifAvailable: true }, async acquired => {
			if (signal?.aborted) return;
			if (!acquired) { onError('В другом окне сохраняется команда. Повторите сохранение.'); return; }
			entered = true;
			await new Promise<void>((resolve, reject) => {
				const finish = () => {
					window.removeEventListener('message', receive);
					window.clearTimeout(timer);
					resolve();
				};
				const receive = (event: MessageEvent<ExtensionToWebviewMessage>) => {
					const reply = event.data;
					if ((reply?.type === 'promptDashboardQuickCommandSaved' || reply?.type === 'promptDashboardStateSaved'
						|| reply?.type === 'error') && reply.requestId === message.requestId) finish();
				};
				const timer = window.setTimeout(finish, DASHBOARD_QUICK_COMMAND_REPLY_TIMEOUT_MS);
				window.addEventListener('message', receive);
				try { send(); } catch (error) {
					window.removeEventListener('message', receive); window.clearTimeout(timer); reject(error);
				}
			});
		});
	} catch (error) {
		// Sandboxed browsers can expose the API but deny locks. The host still validates and serializes the edit.
		if (!entered && error instanceof DOMException && ['SecurityError', 'NotSupportedError'].includes(error.name)) {
			send(); return;
		}
		onError('Не удалось передать команду расширению. Повторите сохранение.');
	}
}
