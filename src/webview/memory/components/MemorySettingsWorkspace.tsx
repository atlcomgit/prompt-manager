import React from 'react';
import type { MemoryAvailableModel, MemorySettings } from '../../../types/memory';
import type { CodeMapSettings } from '../../../types/codemap';
import { SettingsPanel } from './SettingsPanel';
import { InstructionSettingsPanel } from './InstructionSettingsPanel';
import { MemoryPanel, MemorySegmentedTabs, memoryUiStyles } from './memoryUi';

export type MemorySettingsWorkspaceTab = 'history' | 'instructions';

interface Props {
	activeTab: MemorySettingsWorkspaceTab;
	onTabChange: (tab: MemorySettingsWorkspaceTab) => void;
	memorySettings: MemorySettings | null;
	codeMapSettings: CodeMapSettings | null;
	availableModels: MemoryAvailableModel[];
	onSaveMemorySettings: (settings: Partial<MemorySettings>) => void;
	onRefreshMemorySettings: () => void;
	onSaveInstructionSettings: (settings: Partial<CodeMapSettings>) => void;
	onRefreshInstructionSettings: () => void;
	t: (key: string) => string;
}

// Объединяет настройки историй и инструкций в один верхний экран с внутренними табами.
export const MemorySettingsWorkspace: React.FC<Props> = ({
	activeTab,
	onTabChange,
	memorySettings,
	codeMapSettings,
	availableModels,
	onSaveMemorySettings,
	onRefreshMemorySettings,
	onSaveInstructionSettings,
	onRefreshInstructionSettings,
	t,
}) => {
	return (
		<div style={styles.container}>
			<div style={memoryUiStyles.pageStack}>
				<MemoryPanel
					title={t('memory.settings.workspaceTitle')}
					description={t('memory.settings.workspaceDescription')}
				>
					<MemorySegmentedTabs
						ariaLabel={t('memory.settings.workspaceTabs')}
						stretch
						items={[
							{ value: 'history', label: t('memory.settings.tab.history') },
							{ value: 'instructions', label: t('memory.settings.tab.instructions') },
						]}
						activeValue={activeTab}
						onChange={onTabChange}
					/>
				</MemoryPanel>

				<div style={styles.contentShell}>
					{activeTab === 'history' ? (
						<SettingsPanel
							settings={memorySettings}
							availableModels={availableModels}
							onSave={onSaveMemorySettings}
							onRefresh={onRefreshMemorySettings}
							t={t}
						/>
					) : (
						<InstructionSettingsPanel
							settings={codeMapSettings}
							availableModels={availableModels}
							onSave={onSaveInstructionSettings}
							onRefresh={onRefreshInstructionSettings}
							t={t}
						/>
					)}
				</div>
			</div>
		</div>
	);
};

// Описывает outer-shell для объединенного экрана настроек.
const styles: Record<string, React.CSSProperties> = {
	container: {
		height: '100%',
		overflow: 'auto',
		padding: '20px',
		boxSizing: 'border-box',
	},
	contentShell: {
		minHeight: 0,
		borderRadius: '18px',
		border: '1px solid color-mix(in srgb, var(--vscode-panel-border) 82%, transparent)',
		background: 'color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-sideBar-background) 6%)',
		overflow: 'hidden',
	},
};