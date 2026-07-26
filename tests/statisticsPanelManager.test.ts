import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

/** Original CommonJS loader restored after installing the VS Code module mock. */
const originalLoad = (Module as any)._load;

/** URI shape used by the focused VS Code mock. */
interface MockUri {
	/** File-system path used by save and join operations. */
	fsPath: string;
	/** String representation used by webview HTML helpers. */
	toString: () => string;
}

/** Captured writeFile call for XLSX export assertions. */
interface WriteFileCall {
	/** Target URI selected by the mocked save dialog. */
	uri: MockUri;
	/** Workbook bytes passed to workspace.fs.writeFile. */
	content: Uint8Array;
}

/** Minimal webview panel shape used to emit registered messages. */
interface MockWebviewPanel {
	/** Webview API exposed to StatisticsPanelManager.show(). */
	webview: {
		/** HTML assigned by the manager during panel creation. */
		html: string;
		/** CSP source used by getWebviewHtml. */
		cspSource: string;
		/** Convert extension URIs into webview URIs. */
		asWebviewUri: (uri: MockUri) => MockUri;
		/** Register a message listener for test-triggered messages. */
		onDidReceiveMessage: (listener: MessageListener) => DisposableLike;
		/** Record host-to-webview messages when other message types are used. */
		postMessage: (message: unknown) => Promise<boolean>;
	};
	/** Whether dispose() was called for currentPanel cleanup. */
	disposed: boolean;
	/** Messages posted back to the webview. */
	postedMessages: unknown[];
	/** Trigger the registered onDidReceiveMessage handlers. */
	emitMessage: (message: unknown) => Promise<void>;
	/** Dispose the panel and notify dispose listeners. */
	dispose: () => void;
	/** Reveal is called when a global currentPanel already exists. */
	reveal: () => void;
	/** Register dispose listeners for currentPanel cleanup. */
	onDidDispose: (listener: () => void | Promise<void>) => DisposableLike;
	/** Icon path assigned by the manager. */
	iconPath?: MockUri;
}

/** Disposable shape returned by VS Code listener registration methods. */
interface DisposableLike {
	/** Dispose callback for listener registration cleanup. */
	dispose: () => void;
}

/** Message listener shape captured from webview.onDidReceiveMessage. */
type MessageListener = (message: unknown) => void | Promise<void>;

/** Created panels captured by createWebviewPanel. */
const createdPanels: MockWebviewPanel[] = [];

/** XLSX writes captured by workspace.fs.writeFile. */
const writeFileCalls: WriteFileCall[] = [];

/** Error messages shown through the VS Code window mock. */
const errorMessages: string[] = [];

/** Information messages shown through the VS Code window mock. */
const informationMessages: string[] = [];

/** Save dialog options captured for basic handler verification. */
const saveDialogOptions: unknown[] = [];

/** Current mock locale returned by vscode.env.language. */
let mockLanguage = 'en';

/** Current mock save dialog result. */
let saveDialogResult: MockUri | undefined;

/** Optional save dialog failure injected by a test. */
let saveDialogError: Error | undefined;

/** Optional writeFile failure injected by a test. */
let writeFileError: Error | undefined;

/** Manager instance disposed in test finally blocks. */
let activeManager: { dispose: () => void } | undefined;

/** Create a mock disposable object for VS Code event registration. */
function createDisposable(): DisposableLike {
	return { dispose() { } };
}

/** Create a stable mock URI with VS Code-like path joining behavior. */
function createUri(fsPath: string): MockUri {
	return {
		fsPath,
		toString: () => fsPath,
	};
}

/** Reset mutable VS Code mock state before each focused scenario. */
function resetVsCodeMockState(): void {
	createdPanels.length = 0;
	writeFileCalls.length = 0;
	errorMessages.length = 0;
	informationMessages.length = 0;
	saveDialogOptions.length = 0;
	mockLanguage = 'en';
	saveDialogResult = undefined;
	saveDialogError = undefined;
	writeFileError = undefined;
	activeManager = undefined;
}

/** Create a mock panel that stores and invokes webview message listeners. */
function createMockWebviewPanel(): MockWebviewPanel {
	const messageListeners: MessageListener[] = [];
	const disposeListeners: Array<() => void | Promise<void>> = [];
	const panel: MockWebviewPanel = {
		disposed: false,
		postedMessages: [],
		webview: {
			html: '',
			cspSource: 'vscode-resource:',
			asWebviewUri: (uri: MockUri) => uri,
			onDidReceiveMessage: (listener: MessageListener) => {
				messageListeners.push(listener);
				return createDisposable();
			},
			postMessage: async (message: unknown) => {
				panel.postedMessages.push(message);
				return true;
			},
		},
		emitMessage: async (message: unknown) => {
			for (const listener of messageListeners) {
				await listener(message);
			}
		},
		dispose: () => {
			if (panel.disposed) {
				return;
			}

			panel.disposed = true;
			for (const listener of disposeListeners) {
				void listener();
			}
		},
		reveal: () => undefined,
		onDidDispose: (listener: () => void | Promise<void>) => {
			disposeListeners.push(listener);
			return createDisposable();
		},
	};

	return panel;
}

/** Create the VS Code mock required by StatisticsPanelManager.show(). */
function createVsCodeMock() {
	return {
		Uri: {
			joinPath: (base: MockUri, ...parts: string[]) => {
				const cleanBase = base.fsPath.replace(/\/+$/, '');
				return createUri([cleanBase, ...parts].join('/'));
			},
		},
		ViewColumn: {
			One: 1,
			Beside: 2,
		},
		workspace: {
			workspaceFolders: [{ uri: createUri('/tmp/prompt-manager-workspace') }],
			fs: {
				writeFile: async (uri: MockUri, content: Uint8Array) => {
					if (writeFileError) {
						throw writeFileError;
					}

					writeFileCalls.push({ uri, content: Buffer.from(content) });
				},
			},
		},
		window: {
			createWebviewPanel: () => {
				const panel = createMockWebviewPanel();
				createdPanels.push(panel);
				return panel;
			},
			showSaveDialog: async (options: unknown) => {
				saveDialogOptions.push(options);
				if (saveDialogError) {
					throw saveDialogError;
				}

				return saveDialogResult;
			},
			showErrorMessage: (message: string) => {
				errorMessages.push(message);
				return undefined;
			},
			showInformationMessage: (message: string) => {
				informationMessages.push(message);
				return undefined;
			},
		},
		env: {
			get language() {
				return mockLanguage;
			},
		},
	};
}

/** Import StatisticsPanelManager while resolving the vscode module to the local mock. */
async function importStatisticsPanelManager() {
	(Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
		if (request === 'vscode') {
			return createVsCodeMock();
		}

		return originalLoad.call(this, request, parent, isMain);
	};

	try {
		return await import('../src/providers/statisticsPanelManager.js');
	} finally {
		(Module as any)._load = originalLoad;
	}
}

/** Create and show a manager, returning the panel with a registered message handler. */
async function showStatisticsPanel() {
	const { StatisticsPanelManager } = await importStatisticsPanelManager();
	const manager = new StatisticsPanelManager(
		createUri('/tmp/prompt-manager-extension') as any,
		{ getStatistics: async () => ({}) } as any,
		{ getStatisticsUiState: () => ({}), saveStatisticsUiState: async () => undefined } as any,
	);
	activeManager = manager;

	await manager.show();
	assert.equal(createdPanels.length, 1);

	return { manager, panel: createdPanels[0] };
}

/** Valid export row used by XLSX save scenarios. */
function createValidExportRow() {
	return {
		taskNumber: '162',
		title: '=1+1',
		status: 'completed',
		timeWriting: 1_000,
		timeImplementing: 61_000,
		timeOnTask: 3_661_000,
		timeUntracked: 2_000,
		totalTime: 0,
	};
}

/** Dispose the active manager to clear module-level currentPanel state. */
function disposeActiveManager(): void {
	activeManager?.dispose();
	activeManager = undefined;
}

/** Verify save cancellation does not write a file or show an error. */
test('StatisticsPanelManager cancels XLSX export without writing a file', async () => {
	resetVsCodeMockState();
	saveDialogResult = undefined;
	const { panel } = await showStatisticsPanel();

	try {
		await panel.emitMessage({ type: 'exportStatisticsXlsx', rows: [createValidExportRow()] });

		assert.equal(saveDialogOptions.length, 1);
		assert.equal(writeFileCalls.length, 0);
		assert.deepEqual(errorMessages, []);
		assert.deepEqual(informationMessages, []);
	} finally {
		disposeActiveManager();
	}
});

/** Verify successful XLSX export writes a real ZIP-backed workbook buffer. */
test('StatisticsPanelManager writes a real XLSX buffer and tolerates invalid rows', async () => {
	resetVsCodeMockState();
	saveDialogResult = createUri('/tmp/prompt-statistics.xlsx');
	const { panel } = await showStatisticsPanel();

	try {
		// Invalid entries should be normalized or filtered without throwing before the valid row is exported.
		await panel.emitMessage({
			type: 'exportStatisticsXlsx',
			rows: [null, 'invalid', { title: '', timeWriting: Number.NaN }, createValidExportRow()],
		});

		assert.equal(writeFileCalls.length, 1);
		assert.equal(writeFileCalls[0]?.uri.fsPath, '/tmp/prompt-statistics.xlsx');
		assert.equal(Buffer.from(writeFileCalls[0]?.content || []).subarray(0, 2).toString('utf8'), 'PK');
		assert.equal(errorMessages.length, 0);
		assert.match(informationMessages[0] || '', /Excel file saved:/);
	} finally {
		disposeActiveManager();
	}
});

/** Verify save dialog failures are shown through a localized error message. */
test('StatisticsPanelManager localizes showSaveDialog failures', async () => {
	resetVsCodeMockState();
	mockLanguage = 'ru';
	saveDialogError = new Error('dialog failed');
	const { panel } = await showStatisticsPanel();

	try {
		await panel.emitMessage({ type: 'exportStatisticsXlsx', rows: [createValidExportRow()] });

		assert.equal(writeFileCalls.length, 0);
		assert.equal(errorMessages.length, 1);
		assert.match(errorMessages[0] || '', /^Не удалось сохранить Excel-файл: dialog failed$/);
	} finally {
		disposeActiveManager();
	}
});

/** Verify write failures are shown through a localized error message. */
test('StatisticsPanelManager localizes writeFile failures', async () => {
	resetVsCodeMockState();
	mockLanguage = 'en';
	saveDialogResult = createUri('/tmp/prompt-statistics.xlsx');
	writeFileError = new Error('write failed');
	const { panel } = await showStatisticsPanel();

	try {
		await panel.emitMessage({ type: 'exportStatisticsXlsx', rows: [createValidExportRow()] });

		assert.equal(writeFileCalls.length, 0);
		assert.equal(errorMessages.length, 1);
		assert.match(errorMessages[0] || '', /^Failed to save Excel file: write failed$/);
	} finally {
		disposeActiveManager();
	}
});
