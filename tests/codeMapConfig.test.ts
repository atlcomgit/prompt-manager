import test from 'node:test';
import assert from 'node:assert/strict';

import {
	getCodeMapSettingsFromConfiguration,
	saveCodeMapSettingsToConfiguration,
} from '../src/codemap/codeMapConfig.js';

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

test('getCodeMapSettingsFromConfiguration normalizes stored update priority values', () => {
	const config = new FakeConfig({
		updatePriority: 'higher',
	});

	const settings = getCodeMapSettingsFromConfiguration(config);

	assert.equal(settings.updatePriority, 'high');
});

test('saveCodeMapSettingsToConfiguration trims tracked branches, preserves workspace scope and normalizes returned settings', async () => {
	const config = new FakeConfig(
		{
			trackedBranches: ['main'],
			updatePriority: 'normal',
		},
		{
			trackedBranches: 'workspace',
			updatePriority: 'workspace',
		},
	);
	const updates: Array<{ key: string; value: unknown; scope: Scope }> = [];

	const settings = await saveCodeMapSettingsToConfiguration(
		config,
		{
			trackedBranches: [' main ', '', 'dev', 'main'],
			updatePriority: 'high',
			notificationsEnabled: false,
		},
		async (key, value, scope) => {
			updates.push({ key, value, scope });
			await config.apply(key, value, scope);
		},
	);

	assert.deepEqual(updates, [
		{ key: 'trackedBranches', value: ['main', 'dev'], scope: 'workspace' },
		{ key: 'notifications.enabled', value: false, scope: 'global' },
		{ key: 'updatePriority', value: 'higher', scope: 'workspace' },
	]);
	assert.deepEqual(settings.trackedBranches, ['main', 'dev']);
	assert.equal(settings.notificationsEnabled, false);
	assert.equal(settings.updatePriority, 'high');
});
