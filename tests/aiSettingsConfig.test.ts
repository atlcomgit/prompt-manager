import test from 'node:test';
import assert from 'node:assert/strict';

import {
	DEFAULT_AI_SETTINGS,
	getAiSettingsFromConfiguration,
} from '../src/services/aiSettingsConfig.js';

class FakeConfig {
	private readonly values = new Map<string, unknown>();

	constructor(initialValues: Record<string, unknown>) {
		for (const [key, value] of Object.entries(initialValues)) {
			this.values.set(key, value);
		}
	}

	get<T>(section: string, defaultValue?: T): T {
		return this.values.has(section) ? this.values.get(section) as T : defaultValue as T;
	}
}

test('getAiSettingsFromConfiguration keeps internal AI disabled by default', () => {
	const settings = getAiSettingsFromConfiguration(new FakeConfig({}));

	assert.equal(settings.enabled, false);
	assert.equal(DEFAULT_AI_SETTINGS.enabled, false);
});

test('getAiSettingsFromConfiguration reads explicit enabled value', () => {
	const settings = getAiSettingsFromConfiguration(new FakeConfig({
		'ai.enabled': true,
	}));

	assert.equal(settings.enabled, true);
});