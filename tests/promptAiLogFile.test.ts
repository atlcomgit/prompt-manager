import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	clearPromptAiLogFileIfDateChanged,
	getPromptAiLogFilePath,
	isSameLocalCalendarDate,
} from '../src/utils/promptAiLogFile.js';

test('getPromptAiLogFilePath returns workspace log path', () => {
	const workspaceRoot = path.join('/tmp', 'prompt-manager-workspace');

	assert.equal(
		getPromptAiLogFilePath(workspaceRoot),
		path.join(workspaceRoot, '.vscode', 'prompt-manager', 'prompt-ai.log'),
	);
});

test('isSameLocalCalendarDate matches dates within the same local day', () => {
	assert.equal(
		isSameLocalCalendarDate(new Date(2026, 2, 21, 8, 30, 0), new Date(2026, 2, 21, 23, 59, 59)),
		true,
	);
	assert.equal(
		isSameLocalCalendarDate(new Date(2026, 2, 21, 23, 59, 59), new Date(2026, 2, 22, 0, 0, 0)),
		false,
	);
});

test('clearPromptAiLogFileIfDateChanged skips missing log file', async () => {
	const workspaceRoot = await createTempWorkspace();

	try {
		const cleared = await clearPromptAiLogFileIfDateChanged({
			workspaceRoot,
			now: new Date(2026, 2, 21, 12, 0, 0),
		});

		assert.equal(cleared, false);
	} finally {
		await removeTempWorkspace(workspaceRoot);
	}
});

test('clearPromptAiLogFileIfDateChanged keeps log written today', async () => {
	const workspaceRoot = await createTempWorkspace();
	const logFilePath = getPromptAiLogFilePath(workspaceRoot);

	try {
		await fs.mkdir(path.dirname(logFilePath), { recursive: true });
		await fs.writeFile(logFilePath, 'today entry\n', 'utf-8');
		await fs.utimes(logFilePath, new Date(2026, 2, 21, 9, 15, 0), new Date(2026, 2, 21, 9, 15, 0));

		const cleared = await clearPromptAiLogFileIfDateChanged({
			workspaceRoot,
			now: new Date(2026, 2, 21, 18, 45, 0),
		});

		assert.equal(cleared, false);
		assert.equal(await fs.readFile(logFilePath, 'utf-8'), 'today entry\n');
	} finally {
		await removeTempWorkspace(workspaceRoot);
	}
});

test('clearPromptAiLogFileIfDateChanged truncates stale log from previous day', async () => {
	const workspaceRoot = await createTempWorkspace();
	const logFilePath = getPromptAiLogFilePath(workspaceRoot);

	try {
		await fs.mkdir(path.dirname(logFilePath), { recursive: true });
		await fs.writeFile(logFilePath, 'yesterday entry\n', 'utf-8');
		await fs.utimes(logFilePath, new Date(2026, 2, 20, 23, 50, 0), new Date(2026, 2, 20, 23, 50, 0));

		const cleared = await clearPromptAiLogFileIfDateChanged({
			workspaceRoot,
			now: new Date(2026, 2, 21, 8, 0, 0),
		});

		assert.equal(cleared, true);
		assert.equal(await fs.readFile(logFilePath, 'utf-8'), '');
	} finally {
		await removeTempWorkspace(workspaceRoot);
	}
});

async function createTempWorkspace(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), 'prompt-ai-log-'));
}

async function removeTempWorkspace(workspaceRoot: string): Promise<void> {
	await fs.rm(workspaceRoot, { recursive: true, force: true });
}