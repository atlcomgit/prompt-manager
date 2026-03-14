/**
 * SettingsPanel — Allows the user to view and edit memory system settings.
 */

import React, { useState, useEffect } from 'react';
import type { MemoryAvailableModel, MemorySettings, MemoryAnalysisDepth, MemoryNotificationType } from '../../../types/memory';
import { memoryButtonStyles } from './buttonStyles';

interface Props {
	settings: MemorySettings | null;
	availableModels: MemoryAvailableModel[];
	onSave: (settings: Partial<MemorySettings>) => void;
	onRefresh: () => void;
	t: (key: string) => string;
}

export const SettingsPanel: React.FC<Props> = ({ settings, availableModels, onSave, onRefresh, t }) => {
	const [local, setLocal] = useState<MemorySettings | null>(null);

	// Sync local state with incoming settings
	useEffect(() => {
		if (settings) { setLocal({ ...settings }); }
	}, [settings]);

	if (!local) {
		return <div style={styles.loading}>{t('memory.loading')}</div>;
	}

	const modelOptions = [...availableModels];
	if (local.aiModel && !modelOptions.some(item => item.id === local.aiModel)) {
		modelOptions.unshift({ id: local.aiModel, name: local.aiModel });
	}

	/** Update a single field in local state */
	const update = <K extends keyof MemorySettings>(key: K, value: MemorySettings[K]) => {
		setLocal(prev => prev ? { ...prev, [key]: value } : prev);
	};

	/** Save all changes */
	const handleSave = () => {
		if (local) { onSave(local); }
	};

	return (
		<div style={styles.container}>
			<div style={styles.actions}>
				<button style={memoryButtonStyles.primary} onClick={handleSave}>
					💾 {t('memory.saveSettings')}
				</button>
				<button style={memoryButtonStyles.secondary} onClick={onRefresh}>
					↻ {t('memory.refresh')}
				</button>
			</div>

			{/* General */}
			<div style={styles.section}>
				<h4 style={styles.sectionTitle}>{t('memory.settingsGeneral')}</h4>

				<div style={styles.field}>
					<label style={styles.label}>
						<input
							type="checkbox"
							checked={local.enabled}
							onChange={e => update('enabled', e.target.checked)}
						/>
						{t('memory.enabled')}
					</label>
				</div>

				<div style={styles.field}>
					<label style={styles.label}>{t('memory.aiModel')}</label>
					<select
						style={styles.select}
						value={local.aiModel}
						onChange={e => update('aiModel', e.target.value)}
					>
						{modelOptions.map(model => (
							<option key={model.id} value={model.id}>{model.name}</option>
						))}
					</select>
				</div>

				<div style={styles.field}>
					<label style={styles.label}>{t('memory.analysisDepth')}</label>
					<select
						style={styles.select}
						value={local.analysisDepth}
						onChange={e => update('analysisDepth', e.target.value as MemoryAnalysisDepth)}
					>
						<option value="minimal">Minimal</option>
						<option value="standard">Standard</option>
						<option value="deep">Deep</option>
					</select>
				</div>

				<div style={styles.field}>
					<label style={styles.label}>{t('memory.diffLimit')}</label>
					<input
						type="number"
						style={styles.input}
						value={local.diffLimit}
						onChange={e => update('diffLimit', Number(e.target.value))}
						min={1000}
						max={50000}
					/>
				</div>

				<div style={styles.field}>
					<label style={styles.label}>{t('memory.httpPort')}</label>
					<input
						type="number"
						style={styles.input}
						value={local.httpPort}
						onChange={e => update('httpPort', Number(e.target.value))}
						min={0}
						max={65535}
					/>
					<span style={styles.hint}>{t('memory.httpPortHint')}</span>
				</div>
			</div>

			{/* Data management */}
			<div style={styles.section}>
				<h4 style={styles.sectionTitle}>{t('memory.settingsData')}</h4>

				<div style={styles.field}>
					<label style={styles.label}>{t('memory.maxRecords')}</label>
					<input
						type="number"
						style={styles.input}
						value={local.maxRecords}
						onChange={e => update('maxRecords', Number(e.target.value))}
						min={100}
						max={100000}
					/>
				</div>

				<div style={styles.field}>
					<label style={styles.label}>{t('memory.retentionDays')}</label>
					<input
						type="number"
						style={styles.input}
						value={local.retentionDays}
						onChange={e => update('retentionDays', Number(e.target.value))}
						min={7}
						max={3650}
					/>
				</div>

				<div style={styles.field}>
					<label style={styles.label}>{t('memory.shortTermLimit')}</label>
					<input
						type="number"
						style={styles.input}
						value={local.shortTermLimit}
						onChange={e => update('shortTermLimit', Number(e.target.value))}
						min={10}
						max={500}
					/>
				</div>

				<div style={styles.field}>
					<label style={styles.label}>{t('memory.historyAnalysisLimit')}</label>
					<input
						type="number"
						style={styles.input}
						value={local.historyAnalysisLimit}
						onChange={e => update('historyAnalysisLimit', Number(e.target.value))}
						min={1}
						max={500}
					/>
				</div>

				<div style={styles.field}>
					<label style={styles.label}>
						<input
							type="checkbox"
							checked={local.autoCleanup}
							onChange={e => update('autoCleanup', e.target.checked)}
						/>
						{t('memory.autoCleanup')}
					</label>
				</div>
			</div>

			{/* Notifications */}
			<div style={styles.section}>
				<h4 style={styles.sectionTitle}>{t('memory.settingsNotifications')}</h4>

				<div style={styles.field}>
					<label style={styles.label}>
						<input
							type="checkbox"
							checked={local.notificationsEnabled}
							onChange={e => update('notificationsEnabled', e.target.checked)}
						/>
						{t('memory.notificationsEnabled')}
					</label>
				</div>

				<div style={styles.field}>
					<label style={styles.label}>{t('memory.notificationType')}</label>
					<select
						style={styles.select}
						value={local.notificationType}
						onChange={e => update('notificationType', e.target.value as MemoryNotificationType)}
					>
						<option value="info">Info popup</option>
						<option value="statusbar">Status bar</option>
						<option value="silent">Silent (log only)</option>
					</select>
				</div>
			</div>

			{/* Embeddings */}
			<div style={styles.section}>
				<h4 style={styles.sectionTitle}>{t('memory.settingsEmbeddings')}</h4>

				<div style={styles.field}>
					<label style={styles.label}>
						<input
							type="checkbox"
							checked={local.embeddingsEnabled}
							onChange={e => update('embeddingsEnabled', e.target.checked)}
						/>
						{t('memory.embeddingsEnabled')}
					</label>
				</div>

				<div style={styles.field}>
					<label style={styles.label}>
						<input
							type="checkbox"
							checked={local.knowledgeGraphEnabled}
							onChange={e => update('knowledgeGraphEnabled', e.target.checked)}
						/>
						{t('memory.knowledgeGraphEnabled')}
					</label>
				</div>
			</div>
		</div>
	);
};

const styles: Record<string, React.CSSProperties> = {
	container: { padding: '16px', overflow: 'auto', height: '100%' },
	loading: {
		display: 'flex', alignItems: 'center', justifyContent: 'center',
		height: '100%', color: 'var(--vscode-descriptionForeground)',
	},
	actions: { display: 'flex', gap: '8px', marginBottom: '16px' },
	section: {
		marginBottom: '16px', padding: '12px',
		background: 'var(--vscode-editor-background)',
		border: '1px solid var(--vscode-panel-border)', borderRadius: '4px',
	},
	sectionTitle: { margin: '0 0 10px 0', fontSize: '13px' },
	field: { marginBottom: '10px' },
	label: {
		display: 'flex', alignItems: 'center', gap: '6px',
		fontSize: '12px', marginBottom: '4px',
	},
	input: {
		display: 'block', width: '100%', maxWidth: '300px',
		padding: '4px 8px',
		background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
		border: '1px solid var(--vscode-input-border)', borderRadius: '3px', fontSize: '12px',
	},
	select: {
		display: 'block', width: '100%', maxWidth: '300px',
		padding: '4px 8px',
		background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
		border: '1px solid var(--vscode-input-border)', borderRadius: '3px', fontSize: '12px',
	},
	hint: { fontSize: '10px', color: 'var(--vscode-descriptionForeground)', marginLeft: '4px' },
};
