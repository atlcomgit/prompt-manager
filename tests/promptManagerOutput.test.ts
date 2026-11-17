import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

/** Проверяет фактический output-фильтр: замеры доступны с debugLogging, а обычные строки подавляются. */
test('commit generation timings reach output only with debug logging enabled', async () => {
	const originalLoad = (Module as any)._load;
	const lines: string[] = [];
	let enabled = false;
	(Module as any)._load = function (request: string, ...args: unknown[]) {
		if (request === 'vscode') {
			return {
				workspace: { getConfiguration: () => ({ get: () => enabled }) },
				window: { createOutputChannel: () => ({ appendLine: (line: string) => lines.push(line), dispose() {} }) },
			};
		}
		return originalLoad.call(this, request, ...args);
	};
	try {
		const output = await import('../src/utils/promptManagerOutput.js');
		const events = [
			'[report-debug] gitOverlay.commitMessage.timing {"stage":"copilot","durationMs":18000}',
			'[git-service] generateCommitMessage.context {"patchFiles":2}',
			'[git-service] generateCommitMessage.delivery {"stage":"acknowledged"}',
			'[git-service] generateCommitMessage.kilo.skipped {"reason":"inactive"}',
			'[git-service] generateCommitMessage.copilot.timing {"phase":"cancel-deadline","durationMs":30000}',
			'[ai-request] label=generate-commit-message stage=selectModel phase=finish durationMs=1200',
		];
		try {
			for (const event of events) { output.appendPromptManagerLog(event); }
			assert.deepEqual(lines, []);
			enabled = true;
			for (const event of events) { output.appendPromptManagerLog(event); }
			output.appendPromptManagerLog('unrelated verbose output');
			assert.deepEqual(lines, events);
		} finally {
			output.disposePromptManagerOutputChannel();
		}
	} finally {
		(Module as any)._load = originalLoad;
	}
});
