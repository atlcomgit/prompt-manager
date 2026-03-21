import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { clearPromptAiLogFileIfDateChanged, getPromptAiLogFilePath } from './promptAiLogFile.js';

const MAX_LOG_LINE_LENGTH = 1024;
const ELLIPSIS = '...';

type PromptAiLogKind = 'ai' | 'chat';

type PromptAiLogEntry = {
	kind: PromptAiLogKind;
	prompt: string;
	callerMethod: string;
	model?: string;
};

let appendQueue: Promise<void> = Promise.resolve();

export async function appendPromptAiLog(entry: PromptAiLogEntry): Promise<void> {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceRoot) {
		return;
	}

	const rawPrompt = String(entry.prompt || '');
	const timestamp = formatTimestamp(new Date());
	const kindLabel = entry.kind === 'chat' ? 'CHAT' : 'AI';
	const suffix = ` (${formatPromptSize(rawPrompt)}, ${normalizeCallerMethod(entry.callerMethod)}, ${normalizeModel(entry.model)})`;
	const prefix = `[${timestamp}] [${kindLabel}] `;
	const maxPromptLength = Math.max(0, MAX_LOG_LINE_LENGTH - prefix.length - suffix.length);
	const singleLinePrompt = normalizeSingleLine(rawPrompt);
	const truncatedPrompt = truncateText(singleLinePrompt, maxPromptLength);
	const line = `${prefix}${truncatedPrompt}${suffix}`.slice(0, MAX_LOG_LINE_LENGTH);
	const logFilePath = getPromptAiLogFilePath(workspaceRoot);

	try {
		await enqueuePromptAiLogOperation(async () => {
			await fs.mkdir(path.dirname(logFilePath), { recursive: true });
			await fs.appendFile(logFilePath, `${line}\n`, 'utf-8');
		});
	} catch {
		return;
	}
}

export async function clearPromptAiLogIfDateChanged(options: { workspaceRoot?: string; now?: Date } = {}): Promise<boolean> {
	const workspaceRoot = options.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceRoot) {
		return false;
	}

	try {
		return await enqueuePromptAiLogOperation(() => clearPromptAiLogFileIfDateChanged({
			workspaceRoot,
			now: options.now,
		}));
	} catch {
		return false;
	}
}

async function enqueuePromptAiLogOperation<T>(operation: () => Promise<T>): Promise<T> {
	const previousOperation = appendQueue.catch(() => undefined);
	let releaseQueue: (() => void) | undefined;

	appendQueue = new Promise<void>(resolve => {
		releaseQueue = resolve;
	});

	await previousOperation;

	try {
		return await operation();
	} finally {
		releaseQueue?.();
	}
}

function formatTimestamp(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	const hours = String(date.getHours()).padStart(2, '0');
	const minutes = String(date.getMinutes()).padStart(2, '0');
	const seconds = String(date.getSeconds()).padStart(2, '0');
	return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function normalizeSingleLine(value: string): string {
	return String(value || '')
		.replace(/\s+/g, ' ')
		.trim();
}

function truncateText(value: string, maxLength: number): string {
	if (maxLength <= 0) {
		return '';
	}
	if (value.length <= maxLength) {
		return value;
	}
	if (maxLength <= ELLIPSIS.length) {
		return ELLIPSIS.slice(0, maxLength);
	}
	return `${value.slice(0, maxLength - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`;
}

function formatPromptSize(prompt: string): string {
	const bytes = Buffer.byteLength(prompt, 'utf-8');
	return `${(bytes / 1024).toFixed(1)} Кб`;
}

function normalizeCallerMethod(value: string): string {
	const normalized = String(value || '').trim();
	return normalized || 'unknown';
}

function normalizeModel(value?: string): string {
	const normalized = String(value || '').trim();
	return normalized || 'default';
}
