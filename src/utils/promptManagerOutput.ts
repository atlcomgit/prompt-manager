import * as vscode from 'vscode';

type ConsoleMethod = 'debug' | 'info' | 'log' | 'warn' | 'error';

function createDisposable(dispose: () => void): vscode.Disposable {
	if (typeof vscode.Disposable === 'function') {
		return new vscode.Disposable(dispose);
	}

	return { dispose } as vscode.Disposable;
}

const NOOP_DISPOSABLE = createDisposable(() => { });
const CONSOLE_METHODS: ConsoleMethod[] = ['debug', 'info', 'log', 'warn', 'error'];

export const PROMPT_MANAGER_OUTPUT_CHANNEL_NAME = 'Prompt Manager';

let outputChannel: vscode.OutputChannel | undefined;
let restoreConsoleMethods: (() => void) | undefined;

function isPromptManagerDebugLoggingEnabled(): boolean {
	const getConfiguration = vscode.workspace?.getConfiguration;
	if (typeof getConfiguration !== 'function') {
		return false;
	}

	return getConfiguration('promptManager').get<boolean>('debugLogging.enabled', false) === true;
}

export function getPromptManagerOutputChannel(): vscode.OutputChannel {
	if (!outputChannel) {
		outputChannel = vscode.window.createOutputChannel(PROMPT_MANAGER_OUTPUT_CHANNEL_NAME);
	}
	return outputChannel;
}

export function appendPromptManagerLog(message: string): void {
	if (!isPromptManagerDebugLoggingEnabled()) {
		return;
	}
	getPromptManagerOutputChannel().appendLine(message);
}

export function showPromptManagerOutputChannel(preserveFocus = true): void {
	getPromptManagerOutputChannel().show(preserveFocus);
}

export function disposePromptManagerOutputChannel(): void {
	outputChannel?.dispose();
	outputChannel = undefined;
}

export function installPromptManagerConsoleInterceptor(): vscode.Disposable {
	if (restoreConsoleMethods) {
		return NOOP_DISPOSABLE;
	}

	const patchedConsole = console as unknown as Record<ConsoleMethod, (...data: unknown[]) => void>;
	const originalMethods = Object.fromEntries(
		CONSOLE_METHODS.map(method => [method, patchedConsole[method].bind(console)]),
	) as Record<ConsoleMethod, (...data: unknown[]) => void>;

	for (const method of CONSOLE_METHODS) {
		const originalMethod = originalMethods[method];
		patchedConsole[method] = (...data: unknown[]) => {
			try {
				appendPromptManagerLog(formatConsoleMessage(method, data));
			} catch {
				// best effort logging only
			}
			originalMethod(...data);
		};
	}

	restoreConsoleMethods = () => {
		for (const method of CONSOLE_METHODS) {
			patchedConsole[method] = originalMethods[method];
		}
		restoreConsoleMethods = undefined;
	};

	return createDisposable(() => {
		restoreConsoleMethods?.();
	});
}

function formatConsoleMessage(method: ConsoleMethod, data: unknown[]): string {
	const timestamp = new Date().toISOString();
	if (data.length === 0) {
		return `[${timestamp}] [console.${method}]`;
	}
	return `[${timestamp}] [console.${method}] ${data.map(formatConsoleArgument).join(' ')}`;
}

function formatConsoleArgument(value: unknown): string {
	if (value instanceof Error) {
		return value.stack || `${value.name}: ${value.message}`;
	}
	if (typeof value === 'string') {
		return value;
	}
	if (value === undefined) {
		return 'undefined';
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
