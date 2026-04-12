import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	buildChatContextFiles,
	getChatMemoryDirectoryPath,
} from '../src/utils/chatContextFiles.js';

test('getChatMemoryDirectoryPath appends chat-memory to the storage directory', () => {
	const storageDir = '/tmp/workspace/.vscode/prompt-manager';

	assert.equal(
		getChatMemoryDirectoryPath(storageDir),
		path.join(storageDir, 'chat-memory'),
	);
});

test('buildChatContextFiles returns prompt files and existing memory instruction references from chat-memory', () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-manager-chat-context-files-'));
	const storageDir = path.join(tempDir, '.vscode', 'prompt-manager');
	const workspaceRoot = path.join(tempDir, 'workspace');
	const chatMemoryDirectory = getChatMemoryDirectoryPath(storageDir);
	const sessionInstructionFilePath = path.join(chatMemoryDirectory, 'session.instructions.md');
	const aiInstructionsPath = path.join(chatMemoryDirectory, 'ai.instructions.md');
	const projectInstructionsPath = path.join(chatMemoryDirectory, 'project.instructions.md');
	const codeMapInstructionsPath = path.join(chatMemoryDirectory, 'codemap.instructions.md');

	try {
		fs.mkdirSync(chatMemoryDirectory, { recursive: true });
		fs.writeFileSync(aiInstructionsPath, '# ai', 'utf-8');
		fs.writeFileSync(projectInstructionsPath, '# project', 'utf-8');
		fs.writeFileSync(codeMapInstructionsPath, '# codemap', 'utf-8');
		fs.writeFileSync(sessionInstructionFilePath, '# session', 'utf-8');

		const result = buildChatContextFiles({
			workspaceRoot,
			storageDir,
			promptContextFiles: ['README.md', path.join(tempDir, 'notes.md')],
			sessionInstructionFilePath,
		});

		assert.deepEqual(result.promptContextReferences, [
			`#file:${path.join(workspaceRoot, 'README.md')}`,
			`#file:${path.join(tempDir, 'notes.md')}`,
		]);
		assert.deepEqual(result.instructionReferences, [
			`#file:${aiInstructionsPath}`,
			`#file:${sessionInstructionFilePath}`,
			`#file:${projectInstructionsPath}`,
			`#file:${codeMapInstructionsPath}`,
		]);
		assert.deepEqual(result.allAbsolutePaths, [
			path.join(workspaceRoot, 'README.md'),
			path.join(tempDir, 'notes.md'),
			aiInstructionsPath,
			sessionInstructionFilePath,
			projectInstructionsPath,
			codeMapInstructionsPath,
		]);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});