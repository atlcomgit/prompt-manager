import * as fs from 'fs/promises';
import * as path from 'path';

export const PROMPT_AI_LOG_DIR = path.join('.vscode', 'prompt-manager');
export const PROMPT_AI_LOG_FILE = 'prompt-ai.log';

type ClearPromptAiLogFileIfDateChangedOptions = {
	workspaceRoot: string;
	now?: Date;
};

export function getPromptAiLogFilePath(workspaceRoot: string): string {
	return path.join(workspaceRoot, PROMPT_AI_LOG_DIR, PROMPT_AI_LOG_FILE);
}

export function isSameLocalCalendarDate(left: Date, right: Date): boolean {
	return formatLocalDateKey(left) === formatLocalDateKey(right);
}

export async function clearPromptAiLogFileIfDateChanged(options: ClearPromptAiLogFileIfDateChangedOptions): Promise<boolean> {
	const logFilePath = getPromptAiLogFilePath(options.workspaceRoot);
	const now = options.now ?? new Date();

	let stat: Awaited<ReturnType<typeof fs.stat>>;
	try {
		stat = await fs.stat(logFilePath);
	} catch (error) {
		if (isMissingFileError(error)) {
			return false;
		}
		throw error;
	}

	if (isSameLocalCalendarDate(stat.mtime, now)) {
		return false;
	}

	await fs.writeFile(logFilePath, '', 'utf-8');
	return true;
}

function formatLocalDateKey(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
	return Boolean(error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT');
}