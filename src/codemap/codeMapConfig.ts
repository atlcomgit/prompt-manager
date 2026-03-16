import type { CodeMapSettings } from '../types/codemap.js';
import { DEFAULT_COPILOT_MODEL_FAMILY, normalizeOptionalCopilotModelFamily } from '../constants/ai.js';
import { resolveConfigurationScope } from '../utils/configurationScope.js';

export const CODEMAP_CHAT_INSTRUCTION_FILE_NAME = 'codemap.instructions.md';

export type CodeMapConfiguration = {
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
		getConfiguration?: (section: string) => CodeMapConfiguration;
	};
	ConfigurationTarget?: VscodeConfigurationTarget;
};

export const DEFAULT_CODEMAP_SETTINGS: CodeMapSettings = {
	enabled: true,
	trackedBranches: [],
	autoUpdate: true,
	notificationsEnabled: true,
	aiModel: DEFAULT_COPILOT_MODEL_FAMILY,
	instructionMaxChars: 120000,
	blockDescriptionMode: 'medium',
	blockMaxChars: 2000,
	batchContextMaxChars: 24000,
	areaBatchMaxItems: 6,
	symbolBatchMaxItems: 24,
	symbolBatchMaxFiles: 8,
	updatePriority: 'normal',
	aiDelayMs: 1000,
	startupDelayMs: 15000,
	maxVersionsPerInstruction: 3,
};

export function getCodeMapSettings(): CodeMapSettings {
	return getCodeMapSettingsFromConfiguration(getCodeMapConfiguration());
}

export function getCodeMapSettingsFromConfiguration(config: Pick<CodeMapConfiguration, 'get'> | null | undefined): CodeMapSettings {
	const trackedBranches = normalizeTrackedBranches(config?.get<string[]>('trackedBranches', DEFAULT_CODEMAP_SETTINGS.trackedBranches) ?? DEFAULT_CODEMAP_SETTINGS.trackedBranches);

	return {
		enabled: config?.get<boolean>('enabled', DEFAULT_CODEMAP_SETTINGS.enabled) ?? DEFAULT_CODEMAP_SETTINGS.enabled,
		trackedBranches,
		autoUpdate: config?.get<boolean>('autoUpdate', DEFAULT_CODEMAP_SETTINGS.autoUpdate) ?? DEFAULT_CODEMAP_SETTINGS.autoUpdate,
		notificationsEnabled: config?.get<boolean>('notifications.enabled', DEFAULT_CODEMAP_SETTINGS.notificationsEnabled) ?? DEFAULT_CODEMAP_SETTINGS.notificationsEnabled,
		aiModel: normalizeModelFamily(config?.get<string>('aiModel', DEFAULT_CODEMAP_SETTINGS.aiModel) ?? DEFAULT_CODEMAP_SETTINGS.aiModel),
		instructionMaxChars: Math.max(5000, config?.get<number>('instructionMaxChars', DEFAULT_CODEMAP_SETTINGS.instructionMaxChars) ?? DEFAULT_CODEMAP_SETTINGS.instructionMaxChars),
		blockDescriptionMode: config?.get<'short' | 'medium' | 'long'>('blockDescriptionMode', DEFAULT_CODEMAP_SETTINGS.blockDescriptionMode) ?? DEFAULT_CODEMAP_SETTINGS.blockDescriptionMode,
		blockMaxChars: Math.max(200, config?.get<number>('blockMaxChars', DEFAULT_CODEMAP_SETTINGS.blockMaxChars) ?? DEFAULT_CODEMAP_SETTINGS.blockMaxChars),
		batchContextMaxChars: Math.max(4000, config?.get<number>('batchContextMaxChars', DEFAULT_CODEMAP_SETTINGS.batchContextMaxChars) ?? DEFAULT_CODEMAP_SETTINGS.batchContextMaxChars),
		areaBatchMaxItems: normalizeCodeMapInteger(
			config?.get<number>('areaBatchMaxItems', DEFAULT_CODEMAP_SETTINGS.areaBatchMaxItems) ?? DEFAULT_CODEMAP_SETTINGS.areaBatchMaxItems,
			DEFAULT_CODEMAP_SETTINGS.areaBatchMaxItems,
			1,
			6,
		),
		symbolBatchMaxItems: normalizeCodeMapInteger(
			config?.get<number>('symbolBatchMaxItems', DEFAULT_CODEMAP_SETTINGS.symbolBatchMaxItems) ?? DEFAULT_CODEMAP_SETTINGS.symbolBatchMaxItems,
			DEFAULT_CODEMAP_SETTINGS.symbolBatchMaxItems,
			1,
			200,
		),
		symbolBatchMaxFiles: normalizeCodeMapInteger(
			config?.get<number>('symbolBatchMaxFiles', DEFAULT_CODEMAP_SETTINGS.symbolBatchMaxFiles) ?? DEFAULT_CODEMAP_SETTINGS.symbolBatchMaxFiles,
			DEFAULT_CODEMAP_SETTINGS.symbolBatchMaxFiles,
			1,
			40,
		),
		updatePriority: normalizePriority(config?.get<string>('updatePriority', DEFAULT_CODEMAP_SETTINGS.updatePriority) ?? DEFAULT_CODEMAP_SETTINGS.updatePriority),
		aiDelayMs: Math.max(0, config?.get<number>('aiDelayMs', DEFAULT_CODEMAP_SETTINGS.aiDelayMs) ?? DEFAULT_CODEMAP_SETTINGS.aiDelayMs),
		startupDelayMs: Math.max(0, config?.get<number>('startupDelayMs', DEFAULT_CODEMAP_SETTINGS.startupDelayMs) ?? DEFAULT_CODEMAP_SETTINGS.startupDelayMs),
		maxVersionsPerInstruction: Math.max(1, config?.get<number>('maxVersionsPerInstruction', DEFAULT_CODEMAP_SETTINGS.maxVersionsPerInstruction) ?? DEFAULT_CODEMAP_SETTINGS.maxVersionsPerInstruction),
	};
}

export async function saveCodeMapSettings(settings: Partial<CodeMapSettings>): Promise<CodeMapSettings> {
	const config = getCodeMapConfiguration();
	if (!config?.update) {
		return getCodeMapSettingsFromConfiguration(config);
	}

	const vscodeApi = getVscodeApi();
	await saveCodeMapSettingsToConfiguration(config, settings, async (key, value, scope) => {
		await config.update?.(
			key,
			value,
			scope === 'workspace'
				? (vscodeApi?.ConfigurationTarget?.Workspace ?? false)
				: (vscodeApi?.ConfigurationTarget?.Global ?? true),
			);
	});

	return getCodeMapSettings();
}

export async function saveCodeMapSettingsToConfiguration(
	config: CodeMapConfiguration,
	settings: Partial<CodeMapSettings>,
	updateValue: (key: string, value: unknown, scope: 'global' | 'workspace') => Promise<void> | void,
): Promise<CodeMapSettings> {
	if (settings.enabled !== undefined) { await updateValue('enabled', settings.enabled, resolveSettingScope(config, 'enabled')); }
	if (settings.trackedBranches !== undefined) {
		await updateValue('trackedBranches', normalizeTrackedBranches(settings.trackedBranches), resolveSettingScope(config, 'trackedBranches'));
	}
	if (settings.autoUpdate !== undefined) { await updateValue('autoUpdate', settings.autoUpdate, resolveSettingScope(config, 'autoUpdate')); }
	if (settings.notificationsEnabled !== undefined) {
		await updateValue('notifications.enabled', settings.notificationsEnabled, resolveSettingScope(config, 'notifications.enabled'));
	}
	if (settings.aiModel !== undefined) {
		await updateValue('aiModel', normalizeModelFamily(settings.aiModel), resolveSettingScope(config, 'aiModel'));
	}
	if (settings.instructionMaxChars !== undefined) {
		await updateValue('instructionMaxChars', Math.max(5000, Math.floor(settings.instructionMaxChars)), resolveSettingScope(config, 'instructionMaxChars'));
	}
	if (settings.blockDescriptionMode !== undefined) {
		await updateValue('blockDescriptionMode', settings.blockDescriptionMode, resolveSettingScope(config, 'blockDescriptionMode'));
	}
	if (settings.blockMaxChars !== undefined) {
		await updateValue('blockMaxChars', Math.max(200, Math.floor(settings.blockMaxChars)), resolveSettingScope(config, 'blockMaxChars'));
	}
	if (settings.batchContextMaxChars !== undefined) {
		await updateValue('batchContextMaxChars', Math.max(4000, Math.floor(settings.batchContextMaxChars)), resolveSettingScope(config, 'batchContextMaxChars'));
	}
	if (settings.areaBatchMaxItems !== undefined) {
		await updateValue('areaBatchMaxItems', normalizeCodeMapInteger(settings.areaBatchMaxItems, DEFAULT_CODEMAP_SETTINGS.areaBatchMaxItems, 1, 6), resolveSettingScope(config, 'areaBatchMaxItems'));
	}
	if (settings.symbolBatchMaxItems !== undefined) {
		await updateValue('symbolBatchMaxItems', normalizeCodeMapInteger(settings.symbolBatchMaxItems, DEFAULT_CODEMAP_SETTINGS.symbolBatchMaxItems, 1, 200), resolveSettingScope(config, 'symbolBatchMaxItems'));
	}
	if (settings.symbolBatchMaxFiles !== undefined) {
		await updateValue('symbolBatchMaxFiles', normalizeCodeMapInteger(settings.symbolBatchMaxFiles, DEFAULT_CODEMAP_SETTINGS.symbolBatchMaxFiles, 1, 40), resolveSettingScope(config, 'symbolBatchMaxFiles'));
	}
	if (settings.updatePriority !== undefined) {
		const value = settings.updatePriority === 'low' ? 'lower' : settings.updatePriority === 'high' ? 'higher' : 'normal';
		await updateValue('updatePriority', value, resolveSettingScope(config, 'updatePriority'));
	}
	if (settings.aiDelayMs !== undefined) { await updateValue('aiDelayMs', settings.aiDelayMs, resolveSettingScope(config, 'aiDelayMs')); }
	if (settings.startupDelayMs !== undefined) { await updateValue('startupDelayMs', settings.startupDelayMs, resolveSettingScope(config, 'startupDelayMs')); }
	if (settings.maxVersionsPerInstruction !== undefined) {
		await updateValue('maxVersionsPerInstruction', settings.maxVersionsPerInstruction, resolveSettingScope(config, 'maxVersionsPerInstruction'));
	}

	return getCodeMapSettingsFromConfiguration(config);
}

function getCodeMapConfiguration(): CodeMapConfiguration | null {
	try {
		return getVscodeApi()?.workspace?.getConfiguration?.('promptManager.codemap') ?? null;
	} catch {
		return null;
	}
}

function normalizeTrackedBranches(value: string[]): string[] {
	const normalized = (value || [])
		.map(item => String(item || '').trim())
		.filter(Boolean);

	if (normalized.length > 0) {
		return Array.from(new Set(normalized));
	}

	return [];
}

function normalizePriority(value: string): CodeMapSettings['updatePriority'] {
	switch ((value || '').trim().toLowerCase()) {
		case 'lower':
		case 'low':
			return 'low';
		case 'higher':
		case 'high':
			return 'high';
		default:
			return 'normal';
	}
}

function normalizeModelFamily(value: string): string {
	return normalizeOptionalCopilotModelFamily(value);
}

function normalizeCodeMapInteger(value: number, fallback: number, min: number, max: number): number {
	if (!Number.isFinite(value)) {
		return fallback;
	}

	return Math.min(max, Math.max(min, Math.floor(value)));
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

function resolveSettingScope(config: Pick<CodeMapConfiguration, 'inspect'>, key: string): 'global' | 'workspace' {
	return resolveConfigurationScope(config.inspect?.(key));
}
