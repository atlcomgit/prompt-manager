export type ConfigurationScope = 'global' | 'workspace';

export interface ConfigurationInspectResultLike<T> {
	globalValue?: T;
	workspaceValue?: T;
	workspaceFolderValue?: T;
}

export function resolveConfigurationScope<T>(
	inspected: ConfigurationInspectResultLike<T> | undefined,
): ConfigurationScope {
	if (inspected?.workspaceFolderValue !== undefined || inspected?.workspaceValue !== undefined) {
		return 'workspace';
	}

	return 'global';
}
