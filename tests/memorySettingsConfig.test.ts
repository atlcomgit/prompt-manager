import test from 'node:test';
import assert from 'node:assert/strict';

import {
	getMemorySettingsFromConfiguration,
	saveMemorySettingsToConfiguration,
} from '../src/services/memorySettingsConfig.js';

type Scope = 'global' | 'workspace';

class FakeConfig {
	private readonly values = new Map<string, unknown>();
	private readonly scopes = new Map<string, Scope>();

	constructor(initialValues: Record<string, unknown>, initialScopes: Record<string, Scope> = {}) {
		for (const [key, value] of Object.entries(initialValues)) {
			this.values.set(key, value);
		}

		for (const [key, value] of Object.entries(initialScopes)) {
			this.scopes.set(key, value);
		}
	}

	get<T>(section: string, defaultValue?: T): T {
		return this.values.has(section) ? this.values.get(section) as T : defaultValue as T;
	}

	inspect<T>(section: string): { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined {
		const scope = this.scopes.get(section);
		if (!scope || !this.values.has(section)) {
			return undefined;
		}

		const value = this.values.get(section) as T;
		return scope === 'workspace' ? { workspaceValue: value } : { globalValue: value };
	}

	async apply(section: string, value: unknown, scope: Scope): Promise<void> {
		this.values.set(section, value);
		this.scopes.set(section, scope);
	}
}

test('getMemorySettingsFromConfiguration normalizes invalid historyAnalysisLimit values', () => {
	const config = new FakeConfig({
		'memory.historyAnalysisLimit': Number.NaN,
	});

	const settings = getMemorySettingsFromConfiguration(config);

	assert.equal(settings.historyAnalysisLimit, 100);
});

test('saveMemorySettingsToConfiguration preserves workspace scope and normalizes saved historyAnalysisLimit', async () => {
	const config = new FakeConfig(
		{
			'memory.enabled': true,
			'memory.historyAnalysisLimit': 20,
		},
		{
			'memory.enabled': 'workspace',
			'memory.historyAnalysisLimit': 'workspace',
		},
	);
	const updates: Array<{ key: string; value: unknown; scope: Scope }> = [];

	const settings = await saveMemorySettingsToConfiguration(
		config,
		{
			enabled: false,
			historyAnalysisLimit: 0,
		},
		async (key, value, scope) => {
			updates.push({ key, value, scope });
			await config.apply(key, value, scope);
		},
	);

	assert.deepEqual(updates, [
		{ key: 'memory.enabled', value: false, scope: 'workspace' },
		{ key: 'memory.historyAnalysisLimit', value: 1, scope: 'workspace' },
	]);
	assert.equal(settings.enabled, false);
	assert.equal(settings.historyAnalysisLimit, 1);
});
