/** AI settings used to gate Prompt Manager internal AI features. */
export type AiSettings = {
	/** Whether internal AI-powered features are enabled. */
	enabled: boolean;
};

/** Default AI settings for Prompt Manager. */
export const DEFAULT_AI_SETTINGS: AiSettings = {
	enabled: false,
};

export type AiConfiguration = {
	get<T>(section: string, defaultValue?: T): T;
};

type VscodeApi = {
	workspace?: {
		getConfiguration?: (section: string) => AiConfiguration;
	};
};

/** Read normalized AI settings from the active VS Code configuration. */
export function getAiSettings(): AiSettings {
	return getAiSettingsFromConfiguration(getAiConfiguration());
}

/** Build normalized AI settings from a configuration-like object. */
export function getAiSettingsFromConfiguration(config: Pick<AiConfiguration, 'get'> | null | undefined): AiSettings {
	return {
		enabled: config?.get<boolean>('ai.enabled', DEFAULT_AI_SETTINGS.enabled) ?? DEFAULT_AI_SETTINGS.enabled,
	};
}

/** Check whether Prompt Manager internal AI features may execute AI requests. */
export function areInternalAiFeaturesEnabled(): boolean {
	return getAiSettings().enabled;
}

/** Resolve the Prompt Manager configuration section when VS Code APIs are available. */
function getAiConfiguration(): AiConfiguration | null {
	try {
		return getVscodeApi()?.workspace?.getConfiguration?.('promptManager') ?? null;
	} catch {
		return null;
	}
}

/** Load the VS Code API lazily so tests can run without the extension host. */
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