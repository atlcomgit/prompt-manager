import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const originalLoad = (Module as any)._load;

type StatusBarItemMock = {
	text: string;
	tooltip: unknown;
	command: string | undefined;
	color: { id: string } | undefined;
	backgroundColor: { id: string } | undefined;
	visible: boolean;
	show: () => void;
	hide: () => void;
	dispose: () => void;
};

type VsCodeMockState = {
	lastStatusBarItem: StatusBarItemMock | null;
	statusBarItems: StatusBarItemMock[];
	globalState: Map<string, unknown>;
};

/** Создаёт общий mock VS Code для service/provider тестов. */
function createVsCodeMock(state: VsCodeMockState) {
	class EventEmitter<T> {
		private readonly listeners: Array<(value: T) => void> = [];

		public readonly event = (listener: (value: T) => void) => {
			this.listeners.push(listener);
			return { dispose() { } };
		};

		fire(value: T): void {
			for (const listener of this.listeners) {
				listener(value);
			}
		}

		dispose(): void {
			this.listeners.length = 0;
		}
	}

	class ThemeColor {
		constructor(public readonly id: string) { }
	}

	class Disposable {
		constructor(private readonly callback: () => void = () => { }) { }

		dispose(): void {
			this.callback();
		}
	}

	class MarkdownString {
		public value: string;
		public isTrusted = false;
		public supportThemeIcons = false;

		constructor(value = '') {
			this.value = value;
		}

		appendMarkdown(text: string): void {
			this.value += text;
		}
	}

	return {
		EventEmitter,
		ThemeColor,
		Disposable,
		MarkdownString,
		StatusBarAlignment: {
			Right: 2,
		},
		FileType: {
			Directory: 2,
		},
		Uri: {
			file: (value: string) => ({ fsPath: value }),
			joinPath: (base: { fsPath?: string }, ...parts: string[]) => ({
				fsPath: [base.fsPath || '', ...parts].join('/'),
			}),
		},
		workspace: {
			getConfiguration: () => ({
				get: <T>(_: string, defaultValue: T) => defaultValue,
			}),
			onDidChangeConfiguration: () => ({ dispose() { } }),
			fs: {
				stat: async () => {
					throw new Error('fs.stat is not implemented in test');
				},
				readDirectory: async () => [],
			},
		},
		window: {
			createStatusBarItem: () => {
				const item: StatusBarItemMock = {
					text: '',
					tooltip: undefined,
					command: undefined,
					color: undefined,
					backgroundColor: undefined,
					visible: false,
					show() {
						this.visible = true;
					},
					hide() {
						this.visible = false;
					},
					dispose() {
						this.visible = false;
					},
				};
				state.lastStatusBarItem = item;
				state.statusBarItems.push(item);
				return item;
			},
			createOutputChannel: () => ({
				appendLine() { },
				show() { },
				clear() { },
				dispose() { },
			}),
			onDidChangeWindowState: () => ({ dispose() { } }),
			showInformationMessage: async () => undefined,
			showWarningMessage: async () => undefined,
		},
		commands: {
			registerCommand: () => ({ dispose() { } }),
			executeCommand: async () => undefined,
		},
		authentication: {
			onDidChangeSessions: () => ({ dispose() { } }),
			getAccounts: async () => [],
			getSession: async () => null,
		},
		env: {
			language: 'en',
			clipboard: {
				writeText: async () => undefined,
			},
		},
	};
}

/** Создаёт минимальный ExtensionContext для сервиса. */
function createExtensionContext(state: VsCodeMockState) {
	return {
		globalState: {
			get<T>(key: string, defaultValue?: T): T | undefined {
				return (state.globalState.has(key) ? state.globalState.get(key) : defaultValue) as T | undefined;
			},
			async update(key: string, value: unknown) {
				state.globalState.set(key, value);
			},
		},
		extensionUri: { fsPath: '/tmp/prompt-manager-extension' },
		storageUri: undefined,
		subscriptions: [],
	};
}

let modulesPromise: Promise<{
	state: VsCodeMockState;
	serviceModule: typeof import('../src/services/copilotUsageService.js');
	providerModule: typeof import('../src/providers/copilotStatusBarProvider.js');
}> | null = null;

/** Один раз импортирует тестируемые модули с подменённым vscode. */
function loadModules() {
	if (modulesPromise) {
		return modulesPromise;
	}

	modulesPromise = (async () => {
		const state: VsCodeMockState = {
			lastStatusBarItem: null,
			statusBarItems: [],
			globalState: new Map<string, unknown>(),
		};
		const vscodeMock = createVsCodeMock(state);

		(Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
			if (request === 'vscode') {
				return vscodeMock;
			}

			return originalLoad.call(this, request, parent, isMain);
		};

		try {
			const [serviceModule, providerModule] = await Promise.all([
				import('../src/services/copilotUsageService.js'),
				import('../src/providers/copilotStatusBarProvider.js'),
			]);
			return { state, serviceModule, providerModule };
		} finally {
			(Module as any)._load = originalLoad;
		}
	})();

	return modulesPromise;
}

test('CopilotUsageService treats GitHub auth errors as unauthenticated state', async () => {
	const { state, serviceModule } = await loadModules();
	const { CopilotUsageService } = serviceModule;
	state.globalState.clear();

	const originalStartPolling = (CopilotUsageService.prototype as any).startCopilotPreferencePolling;
	const originalStopPolling = (CopilotUsageService.prototype as any).stopCopilotPreferencePolling;
	(CopilotUsageService.prototype as any).startCopilotPreferencePolling = function noop() { };
	(CopilotUsageService.prototype as any).stopCopilotPreferencePolling = function noop() { };

	try {
		const service = new CopilotUsageService(createExtensionContext(state) as any);
		(service as any).cachedData = {
			used: 8254,
			limit: 1500,
			periodStart: '2026-04-01T00:00:00.000Z',
			periodEnd: '2026-04-30T23:59:59.999Z',
			lastUpdated: '2026-04-21T12:00:00.000Z',
			avgPerDay: 393,
			authenticated: true,
			planType: 'Pro+',
			source: 'local',
			lastSyncStatus: 'local-db:stale',
			snapshots: [{ date: '2026-04-21', used: 8254, limit: 1500 }],
		};
		(service as any).refreshCopilotGitHubPreference = async () => false;
		(service as any).getGitHubSession = async () => ({
			accessToken: 'token',
			account: { id: 'user-1', label: 'atlcomgit' },
			scopes: ['read:user'],
		});
		(service as any).fetchCopilotSubscription = async () => ({ planType: 'individual_pro' });
		(service as any).fetchCopilotUsageMetrics = async () => ({
			kind: 'auth-error',
			statusText: 'github-auth-error:api:user -> 401 (Bad credentials)',
		});

		const data = await service.fetchUsage(true);

		assert.equal(data.authenticated, false);
		assert.equal(data.used, 0);
		assert.equal(data.limit, 0);
		assert.match(data.lastSyncStatus || '', /^github-auth-error:/);
		assert.equal(service.getLastKnownAuthenticated(), false);
		assert.equal(service.getCachedData()?.authenticated, false);
		service.dispose();
	} finally {
		(CopilotUsageService.prototype as any).startCopilotPreferencePolling = originalStartPolling;
		(CopilotUsageService.prototype as any).stopCopilotPreferencePolling = originalStopPolling;
	}
});

test('CopilotStatusBarProvider shows explicit sign-in error label for auth-error usage data', async () => {
	const { state, providerModule } = await loadModules();
	const { CopilotStatusBarProvider } = providerModule;
	state.lastStatusBarItem = null;
	state.statusBarItems.length = 0;

	const authErrorData = {
		used: 0,
		limit: 0,
		periodStart: '2026-04-01T00:00:00.000Z',
		periodEnd: '2026-04-30T23:59:59.999Z',
		lastUpdated: '2026-04-21T12:00:00.000Z',
		avgPerDay: 0,
		authenticated: false,
		planType: 'Pro+',
		source: 'local' as const,
		lastSyncStatus: 'github-auth-error:api:user -> 401 (Bad credentials)',
		snapshots: [],
	};

	const usageService = {
		onDidChangeUsage: () => ({ dispose() { } }),
		onDidChangeAccountSwitchState: () => ({ dispose() { } }),
		getAccountSwitchState: () => ({
			isSwitching: false,
			phase: 'idle',
			message: '',
			accountLabel: null,
			startedAt: null,
			updatedAt: '2026-04-21T12:00:00.000Z',
		}),
		getCachedData: () => authErrorData,
		fetchUsage: async () => authErrorData,
		getAccountBindingSummary: async () => ({
			copilotPreferredGitHubLabel: null,
			promptManagerPreferredGitHubLabel: null,
			activeGithubSessionAccountLabel: null,
			githubSessionIssue: null,
			availableGitHubAccounts: [],
		}),
		startAutoRefresh: () => undefined,
		stopAutoRefresh: () => undefined,
		authenticate: async () => true,
	};

	const provider = new CopilotStatusBarProvider(
		usageService as any,
		{ show: async () => undefined } as any,
	);

	assert.ok(state.lastStatusBarItem);
	const statusBarItem = state.lastStatusBarItem as StatusBarItemMock;
	assert.equal(statusBarItem.text, '$(error) Ошибка входа');
	assert.equal(statusBarItem.command, 'promptManager.copilotUsageAuth');
	assert.equal(statusBarItem.color?.id, 'errorForeground');
	assert.equal(statusBarItem.backgroundColor?.id, 'statusBarItem.errorBackground');
	assert.equal(statusBarItem.visible, true);

	provider.dispose();
});