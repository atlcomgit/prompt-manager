import {
	appendPromptManagerLog,
	showPromptManagerOutputChannel,
} from './promptManagerOutput.js';

function stringifyPayload(payload: unknown): string {
	if (payload === undefined) {
		return '';
	}
	try {
		return JSON.stringify(payload);
	} catch {
		return String(payload);
	}
}

export function logMemoryGraphDebug(scope: string, payload?: unknown): void {
	const timestamp = new Date().toISOString();
	const suffix = stringifyPayload(payload);
	const message = suffix
		? `[${timestamp}] [memory-graph] ${scope} ${suffix}`
		: `[${timestamp}] [memory-graph] ${scope}`;
	appendPromptManagerLog(message);
}

export function showMemoryGraphDebugChannel(preserveFocus = true): void {
	showPromptManagerOutputChannel(preserveFocus);
}
