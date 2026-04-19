import React, { useEffect, useMemo, useState } from 'react';
import type { MemoryAvailableModel } from '../../../types/memory';
import type { CodeMapSettings } from '../../../types/codemap';
import { memoryButtonStyles } from './buttonStyles';
import { MemoryPanel, memoryUiStyles } from './memoryUi';

interface Props {
	settings: CodeMapSettings | null;
	availableModels: MemoryAvailableModel[];
	onSave: (settings: Partial<CodeMapSettings>) => void;
	onRefresh: () => void;
	t: (key: string) => string;
}

type BatchPreset = 'conservative' | 'balanced' | 'aggressive';

type SliderSettingProps = {
	label: string;
	description: string;
	recommendation: string;
	valueLabel: string;
	value: number;
	min: number;
	max: number;
	step: number;
	onChange: (value: number) => void;
};

// Рендерит слайдер для настройки batch-параметров codemap.
const SliderSetting: React.FC<SliderSettingProps> = ({
	label,
	description,
	recommendation,
	valueLabel,
	value,
	min,
	max,
	step,
	onChange,
}) => (
	<div style={styles.sliderField}>
		<div style={styles.sliderHeader}>
			<div style={styles.settingText}>
				<div style={styles.settingTitle}>{label}</div>
				<div style={styles.settingDescription}>{description}</div>
			</div>
			<div style={styles.sliderValue}>{valueLabel}</div>
		</div>
		<input
			type="range"
			min={min}
			max={max}
			step={step}
			value={value}
			style={styles.sliderInput}
			onChange={event => onChange(Number(event.target.value))}
		/>
		<div style={styles.sliderFooter}>
			<span>{min}</span>
			<span style={styles.sliderRecommendation}>{recommendation}</span>
			<span>{max}</span>
		</div>
	</div>
);

type CheckboxSettingProps = {
	label: string;
	description: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
};

// Рендерит checkbox-настройку с helper text под основным лейблом.
const CheckboxSetting: React.FC<CheckboxSettingProps> = ({ label, description, checked, onChange }) => (
	<div style={styles.checkboxField}>
		<label style={styles.checkboxLabel}>
			<input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />
			<span>{label}</span>
		</label>
		<div style={styles.checkboxDescription}>{description}</div>
	</div>
);

type ControlSettingProps = {
	label: string;
	description: string;
	children: React.ReactNode;
	multiline?: boolean;
};

// Рендерит обычную form-control настройку с коротким описанием.
const ControlSetting: React.FC<ControlSettingProps> = ({ label, description, children, multiline = false }) => (
	<div style={multiline ? styles.controlFieldMultiline : styles.controlField}>
		<div style={styles.settingText}>
			<div style={styles.settingTitle}>{label}</div>
			<div style={styles.settingDescription}>{description}</div>
		</div>
		<div style={multiline ? styles.controlStack : styles.controlBox}>{children}</div>
	</div>
);

// Сопоставляет числовой лимит с предустановленным профилем batch-настроек.
function resolveBatchPreset(value: number, conservativeMax: number, balancedMax: number): BatchPreset {
	if (value <= conservativeMax) {
		return 'conservative';
	}

	if (value <= balancedMax) {
		return 'balanced';
	}

	return 'aggressive';
}

export const InstructionSettingsPanel: React.FC<Props> = ({
	settings,
	availableModels,
	onSave,
	onRefresh,
	t,
}) => {
	const [localSettings, setLocalSettings] = useState<CodeMapSettings | null>(settings);

	// Синхронизирует локальную форму с настройками из extension host.
	useEffect(() => {
		if (settings) {
			setLocalSettings({ ...settings });
		}
	}, [settings]);

	// Поддерживает выбранную AI-модель валидной при обновлении списка доступных моделей.
	useEffect(() => {
		setLocalSettings(prev => {
			if (!prev) {
				return prev;
			}

			if (availableModels.length === 0) {
				if (!prev.aiModel) {
					return prev;
				}

				return { ...prev, aiModel: '' };
			}

			if (availableModels.some(item => item.id === prev.aiModel)) {
				return prev;
			}

			return { ...prev, aiModel: availableModels[0]!.id };
		});
	}, [availableModels]);

	const modelOptions = useMemo(() => [...availableModels], [availableModels]);
	const selectedModel = localSettings && modelOptions.some(item => item.id === localSettings.aiModel)
		? localSettings.aiModel
		: (modelOptions[0]?.id || '');
	const charsUnit = t('memory.instructions.unit.chars');
	const areasUnit = t('memory.instructions.unit.areas');
	const symbolsUnit = t('memory.instructions.unit.symbols');
	const filesUnit = t('memory.instructions.unit.files');

	// Обновляет отдельное поле формы без потери остальных значений.
	const updateSetting = <K extends keyof CodeMapSettings>(key: K, value: CodeMapSettings[K]) => {
		setLocalSettings(prev => prev ? { ...prev, [key]: value } : prev);
	};

	// Возвращает локализованный helper для текущего batch-профиля.
	const getBatchRecommendation = (preset: BatchPreset): string => t(`memory.instructions.recommendation.${preset}`);

	// Сохраняет форму в конфигурацию extension host.
	const saveSettings = () => {
		if (!localSettings) {
			return;
		}

		onSave({
			...localSettings,
			trackedBranches: localSettings.trackedBranches.map(item => item.trim()).filter(Boolean),
			excludedPaths: localSettings.excludedPaths.map(item => item.trim()).filter(Boolean),
		});
	};

	if (!localSettings) {
		return <div style={styles.loading}>{t('memory.loading')}</div>;
	}

	return (
		<div style={styles.container}>
			<div style={styles.actions}>
				<button style={memoryButtonStyles.primary} onClick={saveSettings}>
					💾 {t('memory.saveSettings')}
				</button>
				<button style={memoryButtonStyles.secondary} onClick={onRefresh}>
					↻ {t('memory.refresh')}
				</button>
			</div>

			<div style={memoryUiStyles.pageStack}>
				<MemoryPanel title={t('memory.settingsGeneral')}>
					<CheckboxSetting
						label={t('memory.enabled')}
						description={t('memory.instructions.enabled.help')}
						checked={localSettings.enabled}
						onChange={value => updateSetting('enabled', value)}
					/>
					<CheckboxSetting
						label={t('memory.instructions.autoUpdate')}
						description={t('memory.instructions.autoUpdate.help')}
						checked={localSettings.autoUpdate}
						onChange={value => updateSetting('autoUpdate', value)}
					/>
					<CheckboxSetting
						label={t('memory.instructions.includeFileTree')}
						description={t('memory.instructions.includeFileTree.help')}
						checked={localSettings.includeFileTree}
						onChange={value => updateSetting('includeFileTree', value)}
					/>
					<CheckboxSetting
						label={t('memory.notificationsEnabled')}
						description={t('memory.instructions.notificationsEnabled.help')}
						checked={localSettings.notificationsEnabled}
						onChange={value => updateSetting('notificationsEnabled', value)}
					/>
				</MemoryPanel>

				<MemoryPanel title={t('memory.instructions.trackedBranches')}>
					<ControlSetting
						label={t('memory.instructions.trackedBranches')}
						description={t('memory.instructions.trackedBranches.help')}
						multiline
					>
						<textarea
							style={styles.textarea}
							value={localSettings.trackedBranches.join('\n')}
							onChange={event => updateSetting('trackedBranches', event.target.value.split('\n'))}
						/>
					</ControlSetting>
				</MemoryPanel>

				<MemoryPanel title={t('memory.instructions.excludedPaths')} description={t('memory.instructions.excludedPaths.help')}>
					<textarea
						style={styles.textarea}
						value={localSettings.excludedPaths.join('\n')}
						onChange={event => updateSetting('excludedPaths', event.target.value.split('\n'))}
					/>
				</MemoryPanel>

				<MemoryPanel title={t('memory.instructions.limits')}>
					<ControlSetting
						label={t('memory.instructions.instructionMaxChars')}
						description={t('memory.instructions.instructionMaxChars.help')}
					>
						<input type="number" style={styles.input} value={localSettings.instructionMaxChars} onChange={event => updateSetting('instructionMaxChars', Number(event.target.value))} />
					</ControlSetting>
					<ControlSetting
						label={t('memory.instructions.blockMaxChars')}
						description={t('memory.instructions.blockMaxChars.help')}
					>
						<input type="number" style={styles.input} value={localSettings.blockMaxChars} onChange={event => updateSetting('blockMaxChars', Number(event.target.value))} />
					</ControlSetting>
					<ControlSetting
						label={t('memory.instructions.maxVersions')}
						description={t('memory.instructions.maxVersions.help')}
					>
						<input type="number" style={styles.input} value={localSettings.maxVersionsPerInstruction} onChange={event => updateSetting('maxVersionsPerInstruction', Number(event.target.value))} />
					</ControlSetting>
				</MemoryPanel>

				<MemoryPanel title={t('memory.instructions.batching')} description={t('memory.instructions.batchingSummary')}>
					<div style={styles.sliderStack}>
						<SliderSetting
							label={t('memory.instructions.batchContextMaxChars')}
							description={t('memory.instructions.batchContextMaxChars.help')}
							recommendation={getBatchRecommendation(resolveBatchPreset(localSettings.batchContextMaxChars, 12000, 32000))}
							valueLabel={`${localSettings.batchContextMaxChars.toLocaleString()} ${charsUnit}`}
							value={localSettings.batchContextMaxChars}
							min={4000}
							max={200000}
							step={2000}
							onChange={value => updateSetting('batchContextMaxChars', value)}
						/>
						<SliderSetting
							label={t('memory.instructions.areaBatchMaxItems')}
							description={t('memory.instructions.areaBatchMaxItems.help')}
							recommendation={getBatchRecommendation(resolveBatchPreset(localSettings.areaBatchMaxItems, 2, 4))}
							valueLabel={`${localSettings.areaBatchMaxItems} ${areasUnit}`}
							value={localSettings.areaBatchMaxItems}
							min={1}
							max={6}
							step={1}
							onChange={value => updateSetting('areaBatchMaxItems', value)}
						/>
						<SliderSetting
							label={t('memory.instructions.symbolBatchMaxItems')}
							description={t('memory.instructions.symbolBatchMaxItems.help')}
							recommendation={getBatchRecommendation(resolveBatchPreset(localSettings.symbolBatchMaxItems, 12, 28))}
							valueLabel={`${localSettings.symbolBatchMaxItems} ${symbolsUnit}`}
							value={localSettings.symbolBatchMaxItems}
							min={1}
							max={200}
							step={1}
							onChange={value => updateSetting('symbolBatchMaxItems', value)}
						/>
						<SliderSetting
							label={t('memory.instructions.symbolBatchMaxFiles')}
							description={t('memory.instructions.symbolBatchMaxFiles.help')}
							recommendation={getBatchRecommendation(resolveBatchPreset(localSettings.symbolBatchMaxFiles, 3, 6))}
							valueLabel={`${localSettings.symbolBatchMaxFiles} ${filesUnit}`}
							value={localSettings.symbolBatchMaxFiles}
							min={1}
							max={40}
							step={1}
							onChange={value => updateSetting('symbolBatchMaxFiles', value)}
						/>
					</div>
				</MemoryPanel>

				<MemoryPanel title={t('memory.instructions.ai')}>
					<ControlSetting
						label={t('memory.aiModel')}
						description={t('memory.instructions.aiModel.help')}
					>
						<select
							style={styles.select}
							value={selectedModel}
							disabled={modelOptions.length === 0}
							onChange={event => updateSetting('aiModel', event.target.value)}
						>
							{modelOptions.map(model => (
								<option key={model.id} value={model.id}>{model.name}</option>
							))}
						</select>
					</ControlSetting>
					<ControlSetting
						label={t('memory.instructions.blockDescriptionMode')}
						description={t('memory.instructions.blockDescriptionMode.help')}
					>
						<select style={styles.select} value={localSettings.blockDescriptionMode} onChange={event => updateSetting('blockDescriptionMode', event.target.value as CodeMapSettings['blockDescriptionMode'])}>
							<option value="short">short</option>
							<option value="medium">medium</option>
							<option value="long">long</option>
						</select>
					</ControlSetting>
					<ControlSetting
						label={t('memory.instructions.updatePriority')}
						description={t('memory.instructions.updatePriority.help')}
					>
						<select style={styles.select} value={localSettings.updatePriority} onChange={event => updateSetting('updatePriority', event.target.value as CodeMapSettings['updatePriority'])}>
							<option value="lowest">lowest</option>
							<option value="low">low</option>
							<option value="normal">normal</option>
							<option value="high">high</option>
						</select>
					</ControlSetting>
					<ControlSetting
						label={t('memory.instructions.aiDelayMs')}
						description={t('memory.instructions.aiDelayMs.help')}
					>
						<input type="number" style={styles.input} value={localSettings.aiDelayMs} onChange={event => updateSetting('aiDelayMs', Number(event.target.value))} />
					</ControlSetting>
					<ControlSetting
						label={t('memory.instructions.startupDelayMs')}
						description={t('memory.instructions.startupDelayMs.help')}
					>
						<input type="number" style={styles.input} value={localSettings.startupDelayMs} onChange={event => updateSetting('startupDelayMs', Number(event.target.value))} />
					</ControlSetting>
				</MemoryPanel>
			</div>
		</div>
	);
};

// Собирает form-стили формы настроек codemap в одном месте.
const styles: Record<string, React.CSSProperties> = {
	container: {
		padding: '2px 2px 16px',
		overflow: 'auto',
		height: '100%',
	},
	loading: {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		height: '100%',
		color: 'var(--vscode-descriptionForeground)',
	},
	actions: {
		display: 'flex',
		gap: '8px',
		marginBottom: '16px',
		flexWrap: 'wrap',
	},
	checkboxField: {
		display: 'flex',
		flexDirection: 'column',
		gap: '8px',
	},
	checkboxLabel: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		fontSize: '12px',
		fontWeight: 600,
	},
	checkboxDescription: {
		fontSize: '11px',
		lineHeight: 1.5,
		color: 'var(--vscode-descriptionForeground)',
		marginLeft: '26px',
		maxWidth: '72ch',
	},
	controlField: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'flex-start',
		gap: '14px',
		paddingBottom: '12px',
		borderBottom: '1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent)',
	},
	controlFieldMultiline: {
		display: 'flex',
		flexDirection: 'column',
		gap: '12px',
	},
	settingText: {
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
		minWidth: 0,
		flex: 1,
	},
	settingTitle: {
		fontSize: '12px',
		fontWeight: 700,
	},
	settingDescription: {
		fontSize: '11px',
		lineHeight: 1.5,
		color: 'var(--vscode-descriptionForeground)',
		maxWidth: '72ch',
	},
	controlBox: {
		flex: '0 0 auto',
	},
	controlStack: {
		width: '100%',
	},
	textarea: {
		width: '100%',
		minHeight: '124px',
		padding: '10px 12px',
		background: 'var(--vscode-input-background)',
		color: 'var(--vscode-input-foreground)',
		border: '1px solid var(--vscode-input-border)',
		borderRadius: '10px',
		fontSize: '12px',
		fontFamily: 'var(--vscode-editor-font-family)',
		lineHeight: 1.45,
	},
	input: {
		width: '180px',
		padding: '8px 10px',
		background: 'var(--vscode-input-background)',
		color: 'var(--vscode-input-foreground)',
		border: '1px solid var(--vscode-input-border)',
		borderRadius: '10px',
		fontSize: '12px',
	},
	select: {
		width: '200px',
		padding: '8px 10px',
		background: 'var(--vscode-input-background)',
		color: 'var(--vscode-input-foreground)',
		border: '1px solid var(--vscode-input-border)',
		borderRadius: '10px',
		fontSize: '12px',
	},
	sliderStack: {
		display: 'flex',
		flexDirection: 'column',
		gap: '14px',
	},
	sliderField: {
		padding: '14px',
		borderRadius: '14px',
		background: 'color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-sideBar-background) 18%)',
		border: '1px solid color-mix(in srgb, var(--vscode-panel-border) 88%, transparent)',
	},
	sliderHeader: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'flex-start',
		gap: '12px',
		marginBottom: '10px',
	},
	sliderValue: {
		fontSize: '12px',
		fontWeight: 700,
		whiteSpace: 'nowrap',
		color: 'var(--vscode-textLink-foreground)',
	},
	sliderInput: {
		width: '100%',
		margin: '2px 0 6px 0',
	},
	sliderFooter: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
		gap: '12px',
		fontSize: '11px',
		color: 'var(--vscode-descriptionForeground)',
	},
	sliderRecommendation: {
		flex: 1,
		textAlign: 'center',
	},
};