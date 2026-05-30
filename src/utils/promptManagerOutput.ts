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
const PROMPT_MANAGER_ERROR_MESSAGE_RE = /\b(error|failed|exception)\b/i;
const PROMPT_MANAGER_TASK_DEBUG_MESSAGE_RE = /\[report-debug\]\s+(?:webview\.editor-layout\.sectionHeights\.measured|webview\.editor-report\.mainRichText\.(?:autoResize\.heightChanged|pageScroll\.(?:snapshot|restore)|blur\.(?:defer|cancelDeferred|commitDeferred)|text\.syncFromSourceSurface)|webview\.editor-dashboard\.[^\s]+|promptDashboard\.[^\s]+)\b/;

export const PROMPT_MANAGER_OUTPUT_CHANNEL_NAME = 'Prompt Manager';

let outputChannel: vscode.OutputChannel | undefined;
let rawOutputChannel: vscode.OutputChannel | undefined;
let restoreConsoleMethods: (() => void) | undefined;

function isPromptManagerDebugLoggingEnabled(): boolean {
	const getConfiguration = vscode.workspace?.getConfiguration;
	if (typeof getConfiguration !== 'function') {
		return false;
	}

	return getConfiguration('promptManager').get<boolean>('debugLogging.enabled', false) === true;
}

function shouldWritePromptManagerLogMessage(message: string): boolean {
	if (PROMPT_MANAGER_ERROR_MESSAGE_RE.test(message)) {
		return true;
	}

	if (!isPromptManagerDebugLoggingEnabled()) {
		return false;
	}

	return PROMPT_MANAGER_TASK_DEBUG_MESSAGE_RE.test(message);
}

export function getPromptManagerOutputChannel(): vscode.OutputChannel {
	if (!outputChannel) {
		rawOutputChannel = vscode.window.createOutputChannel(PROMPT_MANAGER_OUTPUT_CHANNEL_NAME);
		outputChannel = new Proxy(rawOutputChannel, {
			get(target, property, receiver) {
				if (property === 'appendLine') {
					return (message: string) => {
						if (!shouldWritePromptManagerLogMessage(String(message || ''))) {
							return;
						}
						target.appendLine(message);
					};
				}

				if (property === 'append') {
					return (message: string) => {
						if (!shouldWritePromptManagerLogMessage(String(message || ''))) {
							return;
						}
						target.append(message);
					};
				}

				const value = Reflect.get(target, property, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		}) as vscode.OutputChannel;
	}
	return outputChannel;
}

export function appendPromptManagerLog(message: string): void {
	if (!isPromptManagerDebugLoggingEnabled()) {
		return;
	}
	if (!shouldWritePromptManagerLogMessage(message)) {
		return;
	}
	getPromptManagerOutputChannel().appendLine(message);
}

export function showPromptManagerOutputChannel(preserveFocus = true): void {
	getPromptManagerOutputChannel().show(preserveFocus);
}

export function disposePromptManagerOutputChannel(): void {
	rawOutputChannel?.dispose();
	rawOutputChannel = undefined;
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
