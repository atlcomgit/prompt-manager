import type { CodeMapSettings } from '../types/codemap.js';
import { DEFAULT_COPILOT_MODEL_FAMILY, normalizeCopilotModelFamily } from '../constants/ai.js';

export const CODEMAP_CHAT_INSTRUCTION_FILE_NAME = 'codemap.instructions.md';

type CodeMapConfiguration = {
	get<T>(section: string, defaultValue?: T): T;
};

const DEFAULT_CODEMAP_SETTINGS: CodeMapSettings = {
	enabled: true,
	trackedBranches: [],
	autoUpdate: true,
	notificationsEnabled: true,
	aiModel: DEFAULT_COPILOT_MODEL_FAMILY,
	instructionMaxChars: 120000,
	blockDescriptionMode: 'medium',
	blockMaxChars: 2000,
	batchContextMaxChars: 24000,
	updatePriority: 'normal',
	aiDelayMs: 1000,
	startupDelayMs: 15000,
	maxVersionsPerInstruction: 3,
};

export function getCodeMapSettings(): CodeMapSettings {
	const config = getCodeMapConfiguration();
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
		updatePriority: normalizePriority(config?.get<string>('updatePriority', DEFAULT_CODEMAP_SETTINGS.updatePriority) ?? DEFAULT_CODEMAP_SETTINGS.updatePriority),
		aiDelayMs: Math.max(0, config?.get<number>('aiDelayMs', DEFAULT_CODEMAP_SETTINGS.aiDelayMs) ?? DEFAULT_CODEMAP_SETTINGS.aiDelayMs),
		startupDelayMs: Math.max(0, config?.get<number>('startupDelayMs', DEFAULT_CODEMAP_SETTINGS.startupDelayMs) ?? DEFAULT_CODEMAP_SETTINGS.startupDelayMs),
		maxVersionsPerInstruction: Math.max(1, config?.get<number>('maxVersionsPerInstruction', DEFAULT_CODEMAP_SETTINGS.maxVersionsPerInstruction) ?? DEFAULT_CODEMAP_SETTINGS.maxVersionsPerInstruction),
	};
}

function getCodeMapConfiguration(): CodeMapConfiguration | null {
	try {
		const localRequire = Function('return typeof require !== "undefined" ? require : null;')() as ((id: string) => { workspace?: { getConfiguration?: (section: string) => CodeMapConfiguration; }; }) | null;
		return localRequire?.('vscode')?.workspace?.getConfiguration?.('promptManager.codemap') ?? null;
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
	return normalizeCopilotModelFamily(value);
}