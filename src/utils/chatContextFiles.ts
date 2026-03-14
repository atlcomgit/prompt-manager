import * as fs from 'fs';
import * as path from 'path';

interface BuildChatContextFilesOptions {
	workspaceRoot: string;
	storageDir: string;
	promptContextFiles: string[];
	sessionInstructionFilePath?: string | null;
}

interface ChatContextFilesResult {
	allAbsolutePaths: string[];
	promptContextReferences: string[];
	instructionReferences: string[];
}

const CHAT_MEMORY_DIR_NAME = 'chat-memory';
const AI_INSTRUCTIONS_FILE_NAME = 'ai.instructions.md';
const CODEMAP_INSTRUCTIONS_FILE_NAME = 'codemap.instructions.md';

export function buildChatContextFiles(options: BuildChatContextFilesOptions): ChatContextFilesResult {
	const promptContextAbsolutePaths = dedupe(
		(options.promptContextFiles || [])
			.map(filePath => toAbsolutePath(filePath, options.workspaceRoot))
			.filter(Boolean)
	);

	const instructionAbsolutePaths = dedupe([
		path.join(options.storageDir, CHAT_MEMORY_DIR_NAME, AI_INSTRUCTIONS_FILE_NAME),
		(options.sessionInstructionFilePath || '').trim(),
		path.join(options.storageDir, CHAT_MEMORY_DIR_NAME, CODEMAP_INSTRUCTIONS_FILE_NAME),
	].filter(filePath => Boolean(filePath) && fs.existsSync(filePath)));

	return {
		allAbsolutePaths: dedupe([...promptContextAbsolutePaths, ...instructionAbsolutePaths]),
		promptContextReferences: promptContextAbsolutePaths.map(filePath => `#file:${filePath}`),
		instructionReferences: instructionAbsolutePaths.map(filePath => `#file:${filePath}`),
	};
}

function toAbsolutePath(filePath: string, workspaceRoot: string): string {
	const normalizedPath = (filePath || '').trim();
	if (!normalizedPath) {
		return '';
	}

	return path.isAbsolute(normalizedPath)
		? normalizedPath
		: path.join(workspaceRoot, normalizedPath);
}

function dedupe(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}
