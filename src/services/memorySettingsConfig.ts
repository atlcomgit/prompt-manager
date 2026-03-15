import type { MemorySettings } from '../types/memory.js';
import { DEFAULT_MEMORY_SETTINGS } from '../types/memory.js';
import { normalizeHistoryAnalysisLimit } from '../utils/historyAnalysisLimit.js';
import { resolveConfigurationScope } from '../utils/configurationScope.js';

export type MemoryConfiguration = {
	get<T>(section: string, defaultValue?: T): T;
	inspect?<T>(section: string): {
		globalValue?: T;
		workspaceValue?: T;
		workspaceFolderValue?: T;
	} | undefined;
	update?(section: string, value: unknown, target: unknown): Thenable<void>;
};

type VscodeConfigurationTarget = {
	Global?: unknown;
	Workspace?: unknown;
};

type VscodeApi = {
	workspace?: {
		getConfiguration?: (section: string) => MemoryConfiguration;
	};
	ConfigurationTarget?: VscodeConfigurationTarget;
};

export function getMemorySettings(): MemorySettings {
	return getMemorySettingsFromConfiguration(getMemoryConfiguration());
}

export function getMemorySettingsFromConfiguration(config: Pick<MemoryConfiguration, 'get'> | null | undefined): MemorySettings {
	return {
		enabled: config?.get<boolean>('memory.enabled', DEFAULT_MEMORY_SETTINGS.enabled) ?? DEFAULT_MEMORY_SETTINGS.enabled,
		aiModel: config?.get<string>('memory.aiModel', DEFAULT_MEMORY_SETTINGS.aiModel) ?? DEFAULT_MEMORY_SETTINGS.aiModel,
		analysisDepth: config?.get<MemorySettings['analysisDepth']>('memory.analysisDepth', DEFAULT_MEMORY_SETTINGS.analysisDepth) ?? DEFAULT_MEMORY_SETTINGS.analysisDepth,
		diffLimit: config?.get<number>('memory.diffLimit', DEFAULT_MEMORY_SETTINGS.diffLimit) ?? DEFAULT_MEMORY_SETTINGS.diffLimit,
		maxRecords: config?.get<number>('memory.maxRecords', DEFAULT_MEMORY_SETTINGS.maxRecords) ?? DEFAULT_MEMORY_SETTINGS.maxRecords,
		retentionDays: config?.get<number>('memory.retentionDays', DEFAULT_MEMORY_SETTINGS.retentionDays) ?? DEFAULT_MEMORY_SETTINGS.retentionDays,
		shortTermLimit: config?.get<number>('memory.shortTermLimit', DEFAULT_MEMORY_SETTINGS.shortTermLimit) ?? DEFAULT_MEMORY_SETTINGS.shortTermLimit,
		historyAnalysisLimit: normalizeHistoryAnalysisLimit(
			undefined,
			config?.get<number>('memory.historyAnalysisLimit', DEFAULT_MEMORY_SETTINGS.historyAnalysisLimit) ?? DEFAULT_MEMORY_SETTINGS.historyAnalysisLimit,
		),
		autoCleanup: config?.get<boolean>('memory.autoCleanup', DEFAULT_MEMORY_SETTINGS.autoCleanup) ?? DEFAULT_MEMORY_SETTINGS.autoCleanup,
		notificationsEnabled: config?.get<boolean>('memory.notifications.enabled', DEFAULT_MEMORY_SETTINGS.notificationsEnabled) ?? DEFAULT_MEMORY_SETTINGS.notificationsEnabled,
		notificationType: config?.get<MemorySettings['notificationType']>('memory.notifications.type', DEFAULT_MEMORY_SETTINGS.notificationType) ?? DEFAULT_MEMORY_SETTINGS.notificationType,
		embeddingsEnabled: config?.get<boolean>('memory.embeddings.enabled', DEFAULT_MEMORY_SETTINGS.embeddingsEnabled) ?? DEFAULT_MEMORY_SETTINGS.embeddingsEnabled,
		knowledgeGraphEnabled: config?.get<boolean>('memory.knowledgeGraph.enabled', DEFAULT_MEMORY_SETTINGS.knowledgeGraphEnabled) ?? DEFAULT_MEMORY_SETTINGS.knowledgeGraphEnabled,
		httpPort: config?.get<number>('memory.httpPort', DEFAULT_MEMORY_SETTINGS.httpPort) ?? DEFAULT_MEMORY_SETTINGS.httpPort,
	};
}

export async function saveMemorySettings(settings: Partial<MemorySettings>): Promise<MemorySettings> {
	const config = getMemoryConfiguration();
	if (!config?.update) {
		return getMemorySettingsFromConfiguration(config);
	}

	const vscodeApi = getVscodeApi();
	await saveMemorySettingsToConfiguration(config, settings, async (key, value, scope) => {
		await config.update?.(
			key,
			value,
			scope === 'workspace'
				? (vscodeApi?.ConfigurationTarget?.Workspace ?? false)
				: (vscodeApi?.ConfigurationTarget?.Global ?? true),
			);
	});

	return getMemorySettings();
}

export async function saveMemorySettingsToConfiguration(
	config: MemoryConfiguration,
	settings: Partial<MemorySettings>,
	updateValue: (key: string, value: unknown, scope: 'global' | 'workspace') => Promise<void> | void,
): Promise<MemorySettings> {
	if (settings.enabled !== undefined) { await updateValue('memory.enabled', settings.enabled, resolveSettingScope(config, 'memory.enabled')); }
	if (settings.aiModel !== undefined) { await updateValue('memory.aiModel', settings.aiModel, resolveSettingScope(config, 'memory.aiModel')); }
	if (settings.analysisDepth !== undefined) { await updateValue('memory.analysisDepth', settings.analysisDepth, resolveSettingScope(config, 'memory.analysisDepth')); }
	if (settings.diffLimit !== undefined) { await updateValue('memory.diffLimit', settings.diffLimit, resolveSettingScope(config, 'memory.diffLimit')); }
	if (settings.maxRecords !== undefined) { await updateValue('memory.maxRecords', settings.maxRecords, resolveSettingScope(config, 'memory.maxRecords')); }
	if (settings.retentionDays !== undefined) { await updateValue('memory.retentionDays', settings.retentionDays, resolveSettingScope(config, 'memory.retentionDays')); }
	if (settings.shortTermLimit !== undefined) { await updateValue('memory.shortTermLimit', settings.shortTermLimit, resolveSettingScope(config, 'memory.shortTermLimit')); }
	if (settings.historyAnalysisLimit !== undefined) {
		await updateValue(
			'memory.historyAnalysisLimit',
			normalizeHistoryAnalysisLimit(settings.historyAnalysisLimit, DEFAULT_MEMORY_SETTINGS.historyAnalysisLimit),
			resolveSettingScope(config, 'memory.historyAnalysisLimit'),
		);
	}
	if (settings.autoCleanup !== undefined) { await updateValue('memory.autoCleanup', settings.autoCleanup, resolveSettingScope(config, 'memory.autoCleanup')); }
	if (settings.notificationsEnabled !== undefined) {
		await updateValue('memory.notifications.enabled', settings.notificationsEnabled, resolveSettingScope(config, 'memory.notifications.enabled'));
	}
	if (settings.notificationType !== undefined) {
		await updateValue('memory.notifications.type', settings.notificationType, resolveSettingScope(config, 'memory.notifications.type'));
	}
	if (settings.embeddingsEnabled !== undefined) {
		await updateValue('memory.embeddings.enabled', settings.embeddingsEnabled, resolveSettingScope(config, 'memory.embeddings.enabled'));
	}
	if (settings.knowledgeGraphEnabled !== undefined) {
		await updateValue('memory.knowledgeGraph.enabled', settings.knowledgeGraphEnabled, resolveSettingScope(config, 'memory.knowledgeGraph.enabled'));
	}
	if (settings.httpPort !== undefined) { await updateValue('memory.httpPort', settings.httpPort, resolveSettingScope(config, 'memory.httpPort')); }

	return getMemorySettingsFromConfiguration(config);
}

function getMemoryConfiguration(): MemoryConfiguration | null {
	try {
		return getVscodeApi()?.workspace?.getConfiguration?.('promptManager') ?? null;
	} catch {
		return null;
	}
}

function getVscodeApi(): VscodeApi | null {
	try {
		if (typeof require !== 'function') {
			return null;
		}

		return require('vscode') as VscodeApi;
	} catch {
		return null;
	}
}

function resolveSettingScope(config: Pick<MemoryConfiguration, 'inspect'>, key: string): 'global' | 'workspace' {
	return resolveConfigurationScope(config.inspect?.(key));
}
