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

test('getCodeMapSettingsFromConfiguration clamps batching limits to safe ranges', () => {
	const config = new FakeConfig({
		areaBatchMaxItems: 99,
		symbolBatchMaxItems: 0,
		symbolBatchMaxFiles: -5,
	});

	const settings = getCodeMapSettingsFromConfiguration(config);

	assert.equal(settings.areaBatchMaxItems, 6);
	assert.equal(settings.symbolBatchMaxItems, 1);
	assert.equal(settings.symbolBatchMaxFiles, 1);
});

test('getCodeMapSettingsFromConfiguration normalizes excluded paths and falls back to defaults when empty', () => {
	const normalized = getCodeMapSettingsFromConfiguration(new FakeConfig({
		excludedPaths: [' node_modules ', './vendor/', '', '.github', 'node_modules'],
	}));
	const fallback = getCodeMapSettingsFromConfiguration(new FakeConfig({
		excludedPaths: [],
	}));

	assert.deepEqual(normalized.excludedPaths, ['node_modules', 'vendor', '.github']);
	assert.deepEqual(fallback.excludedPaths, ['node_modules', 'vendor', '.vscode', '.github', '.nuxt', '.qodo']);
});

test('saveCodeMapSettingsToConfiguration trims tracked branches, preserves workspace scope and normalizes returned settings', async () => {
	const config = new FakeConfig(
		{
			trackedBranches: ['main'],
			excludedPaths: ['node_modules'],
			updatePriority: 'normal',
		},
		{
			trackedBranches: 'workspace',
			excludedPaths: 'workspace',
			updatePriority: 'workspace',
		},
	);
	const updates: Array<{ key: string; value: unknown; scope: Scope }> = [];

	const settings = await saveCodeMapSettingsToConfiguration(
		config,
		{
			trackedBranches: [' main ', '', 'dev', 'main'],
			excludedPaths: [' ./vendor ', '.github/', 'vendor'],
			updatePriority: 'high',
			notificationsEnabled: false,
			areaBatchMaxItems: 4,
			symbolBatchMaxItems: 18,
			symbolBatchMaxFiles: 5,
		},
		async (key, value, scope) => {
			updates.push({ key, value, scope });
			await config.apply(key, value, scope);
		},
	);

	assert.deepEqual(updates, [
		{ key: 'trackedBranches', value: ['main', 'dev'], scope: 'workspace' },
		{ key: 'excludedPaths', value: ['vendor', '.github'], scope: 'workspace' },
		{ key: 'notifications.enabled', value: false, scope: 'global' },
		{ key: 'areaBatchMaxItems', value: 4, scope: 'global' },
		{ key: 'symbolBatchMaxItems', value: 18, scope: 'global' },
		{ key: 'symbolBatchMaxFiles', value: 5, scope: 'global' },
		{ key: 'updatePriority', value: 'higher', scope: 'workspace' },
	]);
	assert.deepEqual(settings.trackedBranches, ['main', 'dev']);
	assert.deepEqual(settings.excludedPaths, ['vendor', '.github']);
	assert.equal(settings.notificationsEnabled, false);
	assert.equal(settings.areaBatchMaxItems, 4);
	assert.equal(settings.symbolBatchMaxItems, 18);
	assert.equal(settings.symbolBatchMaxFiles, 5);
	assert.equal(settings.updatePriority, 'high');
});

test('saveCodeMapSettingsToConfiguration preserves empty aiModel when none is selected', async () => {
	const config = new FakeConfig(
		{
			aiModel: 'gpt-5-mini',
		},
		{
			aiModel: 'workspace',
		},
	);
	const updates: Array<{ key: string; value: unknown; scope: Scope }> = [];

	const settings = await saveCodeMapSettingsToConfiguration(
		config,
		{
			aiModel: '',
		},
		async (key, value, scope) => {
			updates.push({ key, value, scope });
			await config.apply(key, value, scope);
		},
	);

	assert.deepEqual(updates, [
		{ key: 'aiModel', value: '', scope: 'workspace' },
	]);
	assert.equal(settings.aiModel, '');
});
