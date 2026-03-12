import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
	if (!outputChannel) {
		outputChannel = vscode.window.createOutputChannel('Prompt Manager Memory Graph Debug');
	}
	return outputChannel;
}

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
	const message = suffix ? `[${timestamp}] ${scope} ${suffix}` : `[${timestamp}] ${scope}`;
	getOutputChannel().appendLine(message);
	console.log(`[PromptManager/MemoryGraph] ${scope}`, payload ?? '');
}

export function showMemoryGraphDebugChannel(preserveFocus = true): void {
	getOutputChannel().show(preserveFocus);
}