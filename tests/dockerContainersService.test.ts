import test from 'node:test';
import assert from 'node:assert/strict';

type ModuleLoaderWithLoad = typeof import('node:module') & {
	_load: (request: string, parent: unknown, isMain: boolean) => unknown;
};

const moduleLoader = require('node:module') as ModuleLoaderWithLoad;
const originalModuleLoad = moduleLoader._load;
const configurationValuesBySection: Record<string, Record<string, unknown>> = {
	promptManager: {
		'docker.enabled': true,
	},
};

function loadWithVscodeStub(request: string, parent: unknown, isMain: boolean): unknown {
	if (request === 'vscode') {
		class Disposable {
			constructor(private readonly disposeCallback: () => void = () => undefined) { }

			dispose(): void {
				this.disposeCallback();
			}
		}

		class EventEmitter<T> {
			private readonly listeners = new Set<(value: T) => void>();

			readonly event = (listener: (value: T) => void) => {
				this.listeners.add(listener);
				return new Disposable(() => this.listeners.delete(listener));
			};

			fire(value: T): void {
				for (const listener of this.listeners) {
					listener(value);
				}
			}

			dispose(): void {
				this.listeners.clear();
			}
		}

		return {
			Disposable,
			EventEmitter,
			workspace: {
				getConfiguration: (section = '') => ({
					get: (key: string, defaultValue?: unknown) => configurationValuesBySection[section]?.[key] ?? defaultValue,
				}),
			},
		};
	}
	return originalModuleLoad(request, parent, isMain);
}

moduleLoader._load = loadWithVscodeStub;
const { DockerContainersService } = require('../src/services/dockerContainersService.js') as typeof import('../src/services/dockerContainersService.js');
moduleLoader._load = originalModuleLoad;

test('DockerContainersService restarts the Docker event stream after it closes', async () => {
	const closeCallbacks: Array<(() => void) | undefined> = [];
	let streamCalls = 0;
	const apiClient = {
		streamContainerEvents: async (_listener: unknown, onClosed?: () => void) => {
			streamCalls += 1;
			closeCallbacks.push(onClosed);
			return {
				dispose: () => undefined,
			};
		},
	} as any;
	const composeDiscoveryService = {
		onDidChange: () => ({ dispose: () => undefined }),
		dispose: () => undefined,
	} as any;

	const service = new DockerContainersService(apiClient, composeDiscoveryService);
	(service as any).ensureEventStream();
	await Promise.resolve();
	assert.equal(streamCalls, 1);

	closeCallbacks[0]?.();
	await new Promise(resolve => setTimeout(resolve, 1100));
	assert.equal(streamCalls, 2);

	service.dispose();
});

test('DockerContainersService normalizes container CPU to total host capacity', () => {
	const composeDiscoveryService = {
		onDidChange: () => ({ dispose: () => undefined }),
		dispose: () => undefined,
	} as any;
	const service = new DockerContainersService({} as any, composeDiscoveryService);
	const stats = (service as any).calculateResourceStats('container-1', {
		read: '2026-05-31T16:00:00.000Z',
		cpu_stats: {
			online_cpus: 4,
			system_cpu_usage: 1300,
			cpu_usage: {
				total_usage: 300,
				percpu_usage: [1, 1, 1, 1],
			},
		},
		precpu_stats: {
			online_cpus: 4,
			system_cpu_usage: 900,
			cpu_usage: {
				total_usage: 100,
				percpu_usage: [1, 1, 1, 1],
			},
		},
		memory_stats: {
			usage: 0,
			limit: 0,
			stats: {},
		},
		networks: {},
	} as any);

	assert.equal(stats.cpuPercent, 50);
	service.dispose();
});
