import React, { useEffect, useMemo, useState } from 'react';
import type { MemoryAvailableModel } from '../../../types/memory';
import type {
	CodeMapActivity,
	CodeMapInstructionDetail,
	CodeMapInstructionListItem,
	CodeMapRuntimePhase,
	CodeMapRuntimeTask,
	CodeMapSettings,
	CodeMapStatistics,
} from '../../../types/codemap';
import { memoryButtonStyles } from './buttonStyles';

type InstructionTab = 'browse' | 'update' | 'statistics' | 'settings';

interface Props {
	instructions: CodeMapInstructionListItem[];
	selectedInstructionId: number | null;
	detail: CodeMapInstructionDetail | null;
	statistics: CodeMapStatistics | null;
	activity: CodeMapActivity | null;
	settings: CodeMapSettings | null;
	availableModels: MemoryAvailableModel[];
	onSelectInstruction: (id: number) => void;
	onRefreshInstructions: () => void;
	onRefreshWorkspace: () => void;
	onRefreshInstruction: (id: number) => void;
	onRefreshStatistics: () => void;
	onRefreshActivity: () => void;
	onRefreshSettings: () => void;
	onSaveSettings: (settings: Partial<CodeMapSettings>) => void;
	onDeleteInstruction: (id: number) => void;
	onDeleteObsolete: () => void;
	isRefreshing: boolean;
	t: (key: string) => string;
	initialActiveTab?: InstructionTab;
}

const PIPELINE_PHASES: CodeMapRuntimePhase[] = [
	'queued',
	'collecting-files',
	'describing-areas',
	'describing-files',
	'collecting-history',
	'assembling-instruction',
	'persisting-instruction',
];

function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value?: string): string {
	if (!value) {
		return '—';
	}

	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}

	return date.toLocaleString();
}

function formatDuration(ms?: number): string {
	if (!ms || ms <= 0) {
		return '—';
	}
	if (ms < 1000) {
		return `${ms} ms`;
	}
	if (ms < 60_000) {
		return `${(ms / 1000).toFixed(1)} s`;
	}
	return `${(ms / 60_000).toFixed(1)} min`;
}

function formatPercent(value: number): string {
	if (!Number.isFinite(value)) {
		return '0%';
	}
	return `${Math.round(value)}%`;
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
			<div>
				<div style={styles.infoPrimary}>{label}</div>
				<div style={styles.infoSecondary}>{description}</div>
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

// Render a checkbox setting with a secondary helper description.
const CheckboxSetting: React.FC<CheckboxSettingProps> = ({ label, description, checked, onChange }) => (
	<div style={styles.settingBlock}>
		<label style={styles.checkboxLabel}>
			<input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />
			{label}
		</label>
		<div style={styles.settingCheckboxDescription}>{description}</div>
	</div>
);

type ControlSettingProps = {
	label: string;
	description: string;
	children: React.ReactNode;
	multiline?: boolean;
};

// Render an input/select/textarea setting with a label and helper text.
const ControlSetting: React.FC<ControlSettingProps> = ({ label, description, children, multiline = false }) => (
	<div style={multiline ? styles.settingBlock : styles.settingRow}>
		<div style={styles.settingText}>
			<div style={styles.infoPrimary}>{label}</div>
			<div style={styles.infoSecondary}>{description}</div>
		</div>
		<div style={multiline ? styles.settingControlStack : styles.settingControl}>{children}</div>
	</div>
);

function resolveBatchPreset(value: number, conservativeMax: number, balancedMax: number): BatchPreset {
	if (value <= conservativeMax) {
		return 'conservative';
	}
	if (value <= balancedMax) {
		return 'balanced';
	}
	return 'aggressive';
}

function formatShortSha(value?: string): string {
	if (!value) {
		return '—';
	}
	return value.slice(0, 7);
}

function formatProgressDetails(task: CodeMapRuntimeTask | undefined): string {
	if (!task || !task.progressTotal || task.progressTotal <= 0 || task.progressCurrent === undefined) {
		return '—';
	}
	const percent = Math.max(0, Math.min(100, (task.progressCurrent / task.progressTotal) * 100));
	return `${task.progressCurrent}/${task.progressTotal} · ${formatPercent(percent)}`;
}

function getPhaseLabel(phase: CodeMapRuntimePhase | undefined, t: Props['t']): string {
	if (!phase) {
		return t('memory.instructions.phase.idle');
	}
	return t(`memory.instructions.phase.${phase}`);
}

function getTaskProgress(task: CodeMapRuntimeTask | undefined): number | null {
	if (!task || !task.progressTotal || task.progressTotal <= 0 || task.progressCurrent === undefined) {
		return null;
	}
	return Math.max(0, Math.min(100, (task.progressCurrent / task.progressTotal) * 100));
}

const MetricCard: React.FC<{ label: string; value: string; secondary?: string; compact?: boolean }> = ({ label, value, secondary, compact }) => (
	<div style={styles.metricCard}>
		<div style={styles.metricLabel}>{label}</div>
		<div style={compact ? styles.metricValueCompact : styles.metricValue}>{value}</div>
		{secondary ? <div style={styles.metricSecondary}>{secondary}</div> : null}
	</div>
);

export const InstructionsPanel: React.FC<Props> = ({
	instructions,
	selectedInstructionId,
	detail,
	statistics,
	activity,
	settings,
	availableModels,
	onSelectInstruction,
	onRefreshInstructions,
	onRefreshWorkspace,
	onRefreshInstruction,
	onRefreshStatistics,
	onRefreshActivity,
	onRefreshSettings,
	onSaveSettings,
	onDeleteInstruction,
	onDeleteObsolete,
	isRefreshing,
	t,
	initialActiveTab,
}) => {
	const [activeTab, setActiveTab] = useState<InstructionTab>(initialActiveTab || 'browse');
	const [localSettings, setLocalSettings] = useState<CodeMapSettings | null>(settings);

	useEffect(() => {
		if (settings) {
			setLocalSettings({ ...settings });
		}
	}, [settings]);

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

	const selectedInstruction = useMemo(() => (
		instructions.find(item => item.id === selectedInstructionId) || null
	), [instructions, selectedInstructionId]);
	const isInstructionListEmpty = instructions.length === 0;
	const browseRefreshLabel = isInstructionListEmpty
		? t('memory.instructions.refreshWorkspace')
		: t('memory.refresh');
	const handleBrowseRefresh = isInstructionListEmpty
		? onRefreshWorkspace
		: onRefreshInstructions;

	const runtime = activity?.runtime;
	const currentTask = runtime?.currentTask;
	const queuedTasks = runtime?.queuedTasks || [];
	const scheduledRealtimeRefreshes = runtime?.scheduledRealtimeRefreshes || [];
	const recentEvents = runtime?.recentEvents || [];
	const recentJobs = activity?.recentJobs || [];
	const taskProgress = getTaskProgress(currentTask);
	const cycle = runtime?.cycle;
	const cycleTotal = cycle?.queuedTotal || 0;
	const cycleFinished = (cycle?.completedTotal || 0) + (cycle?.failedTotal || 0);
	const cycleProgress = cycleTotal > 0 ? (cycleFinished / cycleTotal) * 100 : 0;
	const totalFinishedJobs = (statistics?.completedJobs || 0) + (statistics?.failedJobs || 0);
	const successRate = totalFinishedJobs > 0 ? ((statistics?.completedJobs || 0) / totalFinishedJobs) * 100 : 0;
	const repositoriesText = statistics?.repositories.join(', ') || '—';
	const branchesText = statistics?.branches.join(', ') || '—';
	const modelOptions = useMemo(() => [...availableModels], [availableModels]);
	const selectedModel = localSettings && modelOptions.some(item => item.id === localSettings.aiModel)
		? localSettings.aiModel
		: (modelOptions[0]?.id || '');
	const charsUnit = t('memory.instructions.unit.chars');
	const areasUnit = t('memory.instructions.unit.areas');
	const symbolsUnit = t('memory.instructions.unit.symbols');
	const filesUnit = t('memory.instructions.unit.files');

	const updateSetting = <K extends keyof CodeMapSettings>(key: K, value: CodeMapSettings[K]) => {
		setLocalSettings(prev => prev ? { ...prev, [key]: value } : prev);
	};

	const getBatchRecommendation = (preset: BatchPreset): string => t(`memory.instructions.recommendation.${preset}`);

	const resolveModelName = (modelId?: string): string => {
		if (!modelId) {
			return '—';
		}
		return availableModels.find(item => item.id === modelId)?.name || modelId;
	};
	const currentTaskModelName = currentTask ? resolveModelName(currentTask.aiModel) : '—';
	const currentTaskEvents = useMemo(() => {
		if (!currentTask) {
			return [];
		}
		return recentEvents.filter(event => event.jobId === currentTask.jobId).slice(0, 6);
	}, [currentTask, recentEvents]);
	const heroDescription = currentTask
		? `${getPhaseLabel(currentTask.phase, t)} · ${currentTaskModelName}${currentTask.detail ? ` · ${currentTask.detail}` : ''}`
		: scheduledRealtimeRefreshes.length > 0
			? t('memory.instructions.realtimePendingHint')
			: t('memory.instructions.progressIdle');

	const saveSettings = () => {
		if (!localSettings) {
			return;
		}

		onSaveSettings({
			...localSettings,
			trackedBranches: localSettings.trackedBranches.map(item => item.trim()).filter(Boolean),
			excludedPaths: localSettings.excludedPaths.map(item => item.trim()).filter(Boolean),
		});
	};

	return (
		<div style={styles.container}>
			<div style={styles.tabs}>
				{(['browse', 'update', 'statistics', 'settings'] as InstructionTab[]).map(tab => (
					<button
						key={tab}
						style={{
							...memoryButtonStyles.tab,
							...(activeTab === tab ? memoryButtonStyles.tabActive : {}),
						}}
						onClick={() => setActiveTab(tab)}
					>
						{t(`memory.instructions.tab.${tab}`)}
					</button>
				))}
			</div>

			{activeTab === 'browse' && (
				<div style={styles.tabContent}>
					<div style={styles.browseLayout}>
						<div style={styles.sidebar}>
							<div style={styles.listHeader}>
								<span style={styles.count}>
									{t('memory.instructions.totalInstructions')}: {instructions.length}
								</span>
								<div style={styles.listHeaderActions}>
									<button style={memoryButtonStyles.secondary} onClick={handleBrowseRefresh}>
										↻ {browseRefreshLabel}
									</button>
									<button style={memoryButtonStyles.danger} onClick={onDeleteObsolete}>
										🗑 {t('memory.instructions.deleteObsolete')}
									</button>
								</div>
							</div>
							<div style={styles.list}>
								{instructions.length === 0 ? (
									<div style={styles.emptyState}>
										<div style={styles.emptyText}>{t('memory.instructions.empty')}</div>
										<div style={styles.emptyInline}>{t('memory.instructions.emptyHint')}</div>
										<div style={styles.emptyActions}>
											<button style={memoryButtonStyles.primary} onClick={onRefreshWorkspace}>
												↻ {t('memory.instructions.refreshWorkspace')}
											</button>
										</div>
									</div>
								) : instructions.map(item => (
									<button
										key={item.id}
										style={{
											...styles.listItem,
											...(selectedInstructionId === item.id ? styles.listItemActive : {}),
										}}
										onClick={() => onSelectInstruction(item.id)}
									>
										<div style={styles.listItemHeader}>
											<span style={styles.listItemSha}>{formatShortSha(item.sourceCommitSha)}</span>
											<span style={styles.listItemBadge}>{item.instructionKind}</span>
											{item.isObsolete ? <span style={styles.obsoleteBadge}>{t('memory.instructions.obsolete')}</span> : null}
											<span style={styles.listItemDate}>{formatDate(item.updatedAt)}</span>
										</div>
										<div style={styles.listItemTitle}>{item.repository}</div>
										<div style={styles.listItemMeta}>{item.branchName} · {item.branchRole}</div>
									</button>
								))}
							</div>
						</div>

						<div style={styles.detailPane}>
							{detail ? (
								<div style={styles.detailContent}>
									<div style={styles.detailHeader}>
										<div>
											<h3 style={styles.detailTitle}>{detail.instruction.repository}</h3>
											<div style={styles.detailSubtitle}>{detail.instruction.branchName} · {detail.instruction.instructionKind} · {detail.instruction.branchRole}</div>
										</div>
										{selectedInstruction ? (
											<div style={styles.actions}>
												<button style={memoryButtonStyles.primary} onClick={() => onRefreshInstruction(selectedInstruction.id)}>
													↻ {t('memory.instructions.refreshSelected')}
												</button>
												<button style={memoryButtonStyles.danger} onClick={() => onDeleteInstruction(selectedInstruction.id)}>
													🗑 {t('memory.instructions.deleteSelected')}
												</button>
											</div>
										) : null}
									</div>

									<div style={styles.metricRow}>
										<MetricCard label={t('memory.instructions.fileCount')} value={String(detail.instruction.fileCount)} />
										<MetricCard label={t('memory.instructions.versions')} value={String(detail.instruction.versionCount)} />
										<MetricCard label={t('memory.instructions.compressedSize')} value={formatBytes(detail.instruction.compressedSize)} />
									</div>

									<div style={styles.section}>
										<h4 style={styles.sectionTitle}>{t('memory.instructions.summary')}</h4>
										<div style={styles.keyValueGrid}>
											<div>{t('memory.instructions.resolvedBranch')}</div>
											<div>{detail.instruction.resolvedBranchName}</div>
											<div>{t('memory.instructions.baseBranch')}</div>
											<div>{detail.instruction.baseBranchName}</div>
											<div>{t('memory.instructions.generatedAt')}</div>
											<div>{formatDate(detail.instruction.generatedAt)}</div>
											<div>{t('memory.aiModel')}</div>
											<div>{resolveModelName(detail.instruction.aiModel)}</div>
											<div>{t('memory.instructions.sourceCommit')}</div>
											<div style={styles.mono}>{detail.instruction.sourceCommitSha}</div>
										</div>
									</div>

									<div style={{ ...styles.section, ...styles.contentSection }}>
										<h4 style={styles.sectionTitle}>{t('memory.instructions.content')}</h4>
										<pre style={styles.contentBox}>{detail.instruction.content}</pre>
									</div>

									<div style={styles.twoColumn}>
										<div style={{ ...styles.section, ...styles.compactSection }}>
											<h4 style={styles.sectionTitle}>{t('memory.instructions.recentVersions')}</h4>
											<div style={styles.compactSectionBody}>
												{detail.versions.length === 0 ? (
													<div style={styles.emptyInline}>{t('memory.instructions.noVersions')}</div>
												) : (
													<div style={styles.listStack}>
														{detail.versions.map(version => (
															<div key={version.id} style={styles.infoRow}>
																<div style={styles.infoPrimary}>{formatDate(version.generatedAt)}</div>
																<div style={styles.monoSmall}>{version.contentHash}</div>
															</div>
														))}
													</div>
												)}
											</div>
										</div>

										<div style={{ ...styles.section, ...styles.compactSection }}>
											<h4 style={styles.sectionTitle}>{t('memory.instructions.recentJobs')}</h4>
											<div style={styles.compactSectionBody}>
												{detail.recentJobs.length === 0 ? (
													<div style={styles.emptyInline}>{t('memory.instructions.noJobs')}</div>
												) : (
													<div style={styles.listStack}>
														{detail.recentJobs.map(job => (
															<div key={job.id} style={styles.infoRow}>
																<div>
																	<div style={styles.infoPrimary}>{job.status} · {job.triggerType}</div>
																	<div style={styles.infoSecondary}>{resolveModelName(typeof job.payload.aiModel === 'string' ? job.payload.aiModel : '')} · {formatDate(job.finishedAt || job.requestedAt)}</div>
																</div>
																<div>{formatDuration(job.totalDurationMs)}</div>
															</div>
														))}
													</div>
												)}
											</div>
										</div>
									</div>
								</div>
							) : (
								<div style={styles.emptyPane}>{t('memory.instructions.selectInstruction')}</div>
							)}
						</div>
					</div>
				</div>
			)}

			{activeTab === 'update' && (
				<div style={styles.scrollContent}>
					<div style={styles.pageStack}>
						<div style={{ ...styles.heroCard, ...(isRefreshing ? styles.heroCardActive : {}) }}>
							<div style={styles.heroHeader}>
								<div>
									<div style={styles.heroEyebrow}>{t('memory.instructions.progressTitle')}</div>
									<h3 style={styles.heroTitle}>{currentTask ? `${currentTask.repository} · ${currentTask.branchName}` : t('memory.instructions.phase.idle')}</h3>
									<div style={styles.heroDescription}>{heroDescription}</div>
								</div>
								<button style={memoryButtonStyles.secondary} onClick={onRefreshActivity}>
									↻ {t('memory.refresh')}
								</button>
							</div>

							<div style={styles.metricRow}>
								<MetricCard label={t('memory.instructions.liveQueued')} value={String(runtime?.queuedCount || 0)} />
								<MetricCard label={t('memory.instructions.liveRunning')} value={String(runtime?.runningCount || 0)} />
								<MetricCard label={t('memory.instructions.liveCycleProgress')} value={cycleTotal > 0 ? `${cycleFinished}/${cycleTotal}` : '0/0'} secondary={formatPercent(cycleProgress)} />
								<MetricCard label={t('memory.instructions.lastActivityAt')} value={formatDate(runtime?.lastActivityAt)} compact />
							</div>

							<div style={styles.progressBarShell}>
								<div style={{ ...styles.progressBarFill, width: `${Math.max(isRefreshing ? 10 : 0, cycleProgress)}%` }} />
							</div>
						</div>

						<div style={styles.pipelineGrid}>
							{PIPELINE_PHASES.map((phase, index) => {
								const currentIndex = currentTask ? PIPELINE_PHASES.indexOf(currentTask.phase) : -1;
								const isDone = currentTask ? index < currentIndex : false;
								const isActive = currentTask ? index === currentIndex : false;
								return (
									<div
										key={phase}
										style={{
											...styles.pipelineStep,
											...(isDone ? styles.pipelineStepDone : {}),
											...(isActive ? styles.pipelineStepActive : {}),
										}}
									>
										<div style={styles.pipelineIndex}>{index + 1}</div>
										<div style={styles.pipelineLabel}>{getPhaseLabel(phase, t)}</div>
									</div>
								);
							})}
						</div>

						<div style={styles.twoColumn}>
							<div style={styles.pageStack}>
								<div style={styles.section}>
									<h4 style={styles.sectionTitle}>{t('memory.instructions.currentTask')}</h4>
									{currentTask ? (
										<>
											<div style={styles.currentTaskHeader}>
												<div>
													<div style={styles.infoPrimary}>{currentTask.repository} · {currentTask.branchName}</div>
													<div style={styles.infoSecondary}>{currentTask.instructionKind} · {currentTask.trigger} · {currentTask.priority} · {currentTaskModelName}</div>
												</div>
												<div style={styles.phaseBadge}>{getPhaseLabel(currentTask.phase, t)}</div>
											</div>
											<div style={styles.keyValueGrid}>
												<div>{t('memory.instructions.phase')}</div>
												<div>{getPhaseLabel(currentTask.phase, t)}</div>
												<div>{t('memory.aiModel')}</div>
												<div>{currentTaskModelName}</div>
												<div>{t('memory.instructions.liveTaskProgress')}</div>
												<div>{formatProgressDetails(currentTask)}</div>
												<div>{t('memory.instructions.liveTaskRequestedAt')}</div>
												<div>{formatDate(currentTask.requestedAt)}</div>
												<div>{t('memory.instructions.liveTaskStartedAt')}</div>
												<div>{formatDate(currentTask.startedAt)}</div>
												<div>{t('memory.instructions.updatedAt')}</div>
												<div>{formatDate(currentTask.updatedAt)}</div>
												<div>{t('memory.instructions.liveTaskDetail')}</div>
												<div>{currentTask.detail || '—'}</div>
											</div>
											{taskProgress !== null ? (
												<>
													<div style={styles.progressBarShell}>
														<div style={{ ...styles.progressBarFill, width: `${Math.max(8, taskProgress)}%` }} />
													</div>
													<div style={styles.progressCaption}>{formatPercent(taskProgress)} · {currentTask.progressCurrent}/{currentTask.progressTotal}</div>
												</>
											) : null}
											<div style={styles.sectionSubtleTitle}>{t('memory.instructions.liveTaskMessages')}</div>
											{currentTaskEvents.length === 0 ? (
												<div style={styles.emptyInline}>{t('memory.instructions.noTaskMessages')}</div>
											) : (
												<div style={styles.listStack}>
													{currentTaskEvents.map(event => (
														<div key={event.id} style={styles.infoRow}>
															<div>
																<div style={styles.infoPrimary}>{event.message}</div>
																<div style={styles.infoSecondary}>{[event.phase ? getPhaseLabel(event.phase, t) : '', formatDate(event.at)].filter(Boolean).join(' · ')}</div>
															</div>
														</div>
													))}
												</div>
											)}
										</>
									) : (
										<div style={styles.emptyInline}>{t('memory.instructions.noCurrentTask')}</div>
									)}
								</div>

								<div style={styles.section}>
									<div style={styles.sectionHeader}>
										<h4 style={styles.sectionTitle}>{t('memory.instructions.realtimePendingTitle')}</h4>
										<div style={styles.sectionMeta}>{scheduledRealtimeRefreshes.length}</div>
									</div>
									<div style={styles.sectionMeta}>{t('memory.instructions.realtimePendingHint')}</div>
									{scheduledRealtimeRefreshes.length === 0 ? (
										<div style={styles.emptyInline}>{t('memory.instructions.noRealtimePending')}</div>
									) : (
										<div style={styles.listStack}>
											{scheduledRealtimeRefreshes.map(item => (
												<div key={`${item.repository}-${item.dueAt}`} style={styles.infoRow}>
													<div>
														<div style={styles.infoPrimary}>{item.repository}</div>
														<div style={styles.infoSecondary}>
															{t('memory.instructions.realtimeChangedAt')}: {formatDate(item.changedAt)} · {t('memory.instructions.realtimeDueAt')}: {formatDate(item.dueAt)}
														</div>
													</div>
												</div>
											))}
										</div>
									)}
								</div>

								<div style={styles.section}>
									<div style={styles.sectionHeader}>
										<h4 style={styles.sectionTitle}>{t('memory.instructions.queuePreview')}</h4>
										<div style={styles.sectionMeta}>{queuedTasks.length}</div>
									</div>
									{queuedTasks.length === 0 ? (
										<div style={styles.emptyInline}>{t('memory.instructions.noQueuedTasks')}</div>
									) : (
										<div style={styles.listStack}>
											{queuedTasks.map(task => (
												<div key={task.jobId} style={styles.infoRow}>
													<div>
														<div style={styles.infoPrimary}>{task.repository} · {task.branchName}</div>
														<div style={styles.infoSecondary}>{task.instructionKind} · {task.trigger} · {task.priority} · {resolveModelName(task.aiModel)}</div>
													</div>
													<div>{formatDate(task.requestedAt)}</div>
												</div>
											))}
										</div>
									)}
								</div>
							</div>

							<div style={styles.pageStack}>
								<div style={styles.section}>
									<h4 style={styles.sectionTitle}>{t('memory.instructions.eventLog')}</h4>
									{recentEvents.length === 0 ? (
										<div style={styles.emptyInline}>{t('memory.instructions.noEvents')}</div>
									) : (
										<div style={styles.listStack}>
											{recentEvents.map(event => (
												<div key={event.id} style={styles.eventRow}>
													<div style={{ ...styles.eventMarker, ...(event.level === 'success' ? styles.eventSuccess : event.level === 'error' ? styles.eventError : styles.eventInfo) }} />
													<div style={styles.eventBody}>
														<div style={styles.infoPrimary}>{event.message}</div>
														<div style={styles.infoSecondary}>{[
															event.phase ? getPhaseLabel(event.phase, t) : '',
															event.repository && event.branchName ? `${event.repository} · ${event.branchName}` : '',
															formatDate(event.at),
														].filter(Boolean).join(' · ')}</div>
													</div>
												</div>
											))}
										</div>
									)}
								</div>

								<div style={styles.section}>
									<h4 style={styles.sectionTitle}>{t('memory.instructions.actionsTitle')}</h4>
									<div style={styles.actionGrid}>
										<div style={styles.actionCard}>
											<div style={styles.infoPrimary}>{t('memory.instructions.updateWorkspace')}</div>
											<div style={styles.infoSecondary}>{t('memory.instructions.updateWorkspaceHint')}</div>
											<button style={memoryButtonStyles.primary} onClick={onRefreshWorkspace}>
												↻ {t('memory.instructions.refreshWorkspace')}
											</button>
										</div>
										<div style={styles.actionCard}>
											<div style={styles.infoPrimary}>{t('memory.instructions.updateSelected')}</div>
											<div style={styles.infoSecondary}>{selectedInstruction ? `${selectedInstruction.repository} · ${selectedInstruction.branchName}` : t('memory.instructions.selectInstruction')}</div>
											<button
												style={{
													...memoryButtonStyles.secondary,
													...(selectedInstruction ? {} : memoryButtonStyles.disabled),
												}}
												onClick={() => selectedInstruction && onRefreshInstruction(selectedInstruction.id)}
											>
												↻ {t('memory.instructions.refreshSelected')}
											</button>
										</div>
									</div>
								</div>
							</div>
						</div>
					</div>
				</div>
			)}

			{activeTab === 'statistics' && (
				<div style={styles.scrollContent}>
					<div style={styles.pageStack}>
						<div style={styles.actions}>
							<button style={memoryButtonStyles.secondary} onClick={onRefreshStatistics}>
								↻ {t('memory.refresh')}
							</button>
						</div>

						{statistics ? (
							<>
								<div style={styles.heroCard}>
									<div style={styles.heroEyebrow}>{t('memory.instructions.statisticsOverview')}</div>
									<h3 style={styles.heroTitle}>{t('memory.instructions.statisticsHeadline')}</h3>
									<div style={styles.heroDescription}>
										{t('memory.instructions.statisticsSummary')
											.replace('{repositories}', String(statistics.repositories.length))
											.replace('{branches}', String(statistics.branches.length))
											.replace('{instructions}', String(statistics.totalInstructions))}
									</div>
								</div>

								<div style={styles.metricRow}>
									<MetricCard label={t('memory.instructions.totalInstructions')} value={String(statistics.totalInstructions)} secondary={`${statistics.repositories.length} ${t('memory.instructions.repositories').toLowerCase()}`} />
									<MetricCard label={t('memory.instructions.statisticsSuccessRate')} value={formatPercent(successRate)} secondary={`${statistics.completedJobs}/${totalFinishedJobs || 0}`} />
									<MetricCard label={t('memory.instructions.avgDuration')} value={formatDuration(statistics.avgDurationMs)} />
									<MetricCard label={t('memory.instructions.avgGenerationDuration')} value={formatDuration(statistics.avgGenerationDurationMs)} />
								</div>

								<div style={styles.metricRow}>
									<MetricCard label={t('memory.instructions.liveBacklog')} value={String((runtime?.queuedCount || 0) + (runtime?.runningCount || 0))} secondary={t('memory.instructions.liveBacklogHint')} />
									<MetricCard label={t('memory.instructions.maxDuration')} value={formatDuration(statistics.maxDurationMs)} />
									<MetricCard label={t('memory.instructions.peakHeap')} value={formatBytes(statistics.peakHeapUsedBytes)} />
									<MetricCard label={t('memory.instructions.dbSize')} value={formatBytes(statistics.dbSizeBytes)} secondary={formatDate(statistics.latestUpdatedAt)} compact />
								</div>

								<div style={styles.twoColumn}>
									<div style={styles.pageStack}>
										<div style={styles.section}>
											<h4 style={styles.sectionTitle}>{t('memory.instructions.scope')}</h4>
											<div style={styles.keyValueGrid}>
												<div>{t('memory.instructions.repositories')}</div>
												<div>{repositoriesText}</div>
												<div>{t('memory.instructions.branches')}</div>
												<div>{branchesText}</div>
												<div>{t('memory.instructions.latestUpdatedAt')}</div>
												<div>{formatDate(statistics.latestUpdatedAt)}</div>
											</div>
										</div>

										<div style={styles.section}>
											<h4 style={styles.sectionTitle}>{t('memory.instructions.repositoryStatsTitle')}</h4>
											{statistics.repositoryStats.length === 0 ? (
												<div style={styles.emptyInline}>{t('memory.instructions.noJobs')}</div>
											) : (
												<div style={styles.listStack}>
													{statistics.repositoryStats.map(item => (
														<div key={item.repository} style={styles.infoRow}>
															<div>
																<div style={styles.infoPrimary}>{item.repository}</div>
																<div style={styles.infoSecondary}>{t('memory.instructions.statisticsCompleted')}: {item.completed} · {t('memory.instructions.statisticsFailed')}: {item.failed}</div>
															</div>
															<div>{formatDuration(item.avgDurationMs)}</div>
														</div>
													))}
												</div>
											)}
										</div>

										<div style={styles.section}>
											<h4 style={styles.sectionTitle}>{t('memory.instructions.aiModelsTitle')}</h4>
											{statistics.aiModels.length === 0 ? (
												<div style={styles.emptyInline}>{t('memory.instructions.noJobs')}</div>
											) : (
												<div style={styles.listStack}>
													{statistics.aiModels.map(item => (
														<div key={item.model} style={styles.infoRow}>
															<div style={styles.infoPrimary}>{resolveModelName(item.model)}</div>
															<div>{item.count}</div>
														</div>
													))}
												</div>
											)}
										</div>
									</div>

									<div style={styles.pageStack}>
										<div style={styles.section}>
											<h4 style={styles.sectionTitle}>{t('memory.instructions.triggerStatsTitle')}</h4>
											{statistics.triggerStats.length === 0 ? (
												<div style={styles.emptyInline}>{t('memory.instructions.noJobs')}</div>
											) : (
												<div style={styles.triggerGrid}>
													{statistics.triggerStats.map(item => {
														const triggerTotal = item.completed + item.failed;
														const triggerSuccessRate = triggerTotal > 0 ? (item.completed / triggerTotal) * 100 : 0;
														return (
															<div key={item.trigger} style={styles.triggerCard}>
																<div style={styles.triggerTitle}>{item.trigger}</div>
																<div style={styles.triggerValue}>{formatPercent(triggerSuccessRate)}</div>
																<div style={styles.infoSecondary}>{item.total} {t('memory.instructions.totalJobs').toLowerCase()}</div>
																<div style={styles.infoSecondary}>{formatDuration(item.avgDurationMs)} · {formatDuration(item.avgGenerationDurationMs)}</div>
															</div>
														);
													})}
												</div>
											)}
										</div>

										<div style={styles.section}>
											<h4 style={styles.sectionTitle}>{t('memory.instructions.statisticsRecentOutcomes')}</h4>
											{recentJobs.length === 0 ? (
												<div style={styles.emptyInline}>{t('memory.instructions.noJobs')}</div>
											) : (
												<div style={styles.listStack}>
													{recentJobs.map(job => (
														<div key={job.id} style={styles.infoRow}>
															<div>
																<div style={styles.infoPrimary}>{job.repository} · {job.branchName}</div>
																<div style={styles.infoSecondary}>{job.status} · {job.triggerType} · {resolveModelName(typeof job.payload.aiModel === 'string' ? job.payload.aiModel : '')} · {formatDate(job.finishedAt || job.requestedAt)}</div>
															</div>
															<div>{formatDuration(job.totalDurationMs)}</div>
														</div>
													))}
												</div>
											)}
										</div>
									</div>
								</div>
							</>
						) : (
							<div style={styles.empty}>{t('memory.loading')}</div>
						)}
					</div>
				</div>
			)}

			{activeTab === 'settings' && (
				<div style={styles.scrollContent}>
					<div style={styles.pageStack}>
						<div style={styles.actions}>
							<button style={memoryButtonStyles.primary} onClick={saveSettings}>
								💾 {t('memory.saveSettings')}
							</button>
							<button style={memoryButtonStyles.secondary} onClick={onRefreshSettings}>
								↻ {t('memory.refresh')}
							</button>
						</div>

						{localSettings ? (
							<>
								<div style={styles.section}>
									<h4 style={styles.sectionTitle}>{t('memory.settingsGeneral')}</h4>
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
								</div>

								<div style={styles.section}>
									<h4 style={styles.sectionTitle}>{t('memory.instructions.trackedBranches')}</h4>
									<ControlSetting
										label={t('memory.instructions.trackedBranches')}
										description={t('memory.instructions.trackedBranches.help')}
										multiline
									>
										<textarea
											style={styles.textarea}
											value={localSettings.trackedBranches.join('\n')}
											onChange={e => updateSetting('trackedBranches', e.target.value.split('\n'))}
										/>
									</ControlSetting>
								</div>

								<div style={styles.section}>
									<h4 style={styles.sectionTitle}>{t('memory.instructions.excludedPaths')}</h4>
									<div style={styles.sectionMeta}>{t('memory.instructions.excludedPaths.help')}</div>
									<textarea
										style={styles.textarea}
										value={localSettings.excludedPaths.join('\n')}
										onChange={e => updateSetting('excludedPaths', e.target.value.split('\n'))}
									/>
								</div>

								<div style={styles.section}>
									<h4 style={styles.sectionTitle}>{t('memory.instructions.limits')}</h4>
									<ControlSetting
										label={t('memory.instructions.instructionMaxChars')}
										description={t('memory.instructions.instructionMaxChars.help')}
									>
										<input type="number" style={styles.input} value={localSettings.instructionMaxChars} onChange={e => updateSetting('instructionMaxChars', Number(e.target.value))} />
									</ControlSetting>
									<ControlSetting
										label={t('memory.instructions.blockMaxChars')}
										description={t('memory.instructions.blockMaxChars.help')}
									>
										<input type="number" style={styles.input} value={localSettings.blockMaxChars} onChange={e => updateSetting('blockMaxChars', Number(e.target.value))} />
									</ControlSetting>
									<ControlSetting
										label={t('memory.instructions.maxVersions')}
										description={t('memory.instructions.maxVersions.help')}
									>
										<input type="number" style={styles.input} value={localSettings.maxVersionsPerInstruction} onChange={e => updateSetting('maxVersionsPerInstruction', Number(e.target.value))} />
									</ControlSetting>
								</div>

								<div style={styles.section}>
									<h4 style={styles.sectionTitle}>{t('memory.instructions.batching')}</h4>
									<div style={styles.sectionMeta}>{t('memory.instructions.batchingSummary')}</div>
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
								</div>

								<div style={styles.section}>
									<h4 style={styles.sectionTitle}>{t('memory.instructions.ai')}</h4>
									<ControlSetting
										label={t('memory.aiModel')}
										description={t('memory.instructions.aiModel.help')}
									>
										<select
											style={styles.select}
											value={selectedModel}
											disabled={modelOptions.length === 0}
											onChange={e => updateSetting('aiModel', e.target.value)}
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
										<select style={styles.select} value={localSettings.blockDescriptionMode} onChange={e => updateSetting('blockDescriptionMode', e.target.value as CodeMapSettings['blockDescriptionMode'])}>
											<option value="short">short</option>
											<option value="medium">medium</option>
											<option value="long">long</option>
										</select>
									</ControlSetting>
									<ControlSetting
										label={t('memory.instructions.updatePriority')}
										description={t('memory.instructions.updatePriority.help')}
									>
										<select style={styles.select} value={localSettings.updatePriority} onChange={e => updateSetting('updatePriority', e.target.value as CodeMapSettings['updatePriority'])}>
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
										<input type="number" style={styles.input} value={localSettings.aiDelayMs} onChange={e => updateSetting('aiDelayMs', Number(e.target.value))} />
									</ControlSetting>
									<ControlSetting
										label={t('memory.instructions.startupDelayMs')}
										description={t('memory.instructions.startupDelayMs.help')}
									>
										<input type="number" style={styles.input} value={localSettings.startupDelayMs} onChange={e => updateSetting('startupDelayMs', Number(e.target.value))} />
									</ControlSetting>
								</div>
							</>
						) : (
							<div style={styles.empty}>{t('memory.loading')}</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
};

const styles: Record<string, React.CSSProperties> = {
	container: { display: 'flex', flexDirection: 'column', gap: '16px', padding: '16px', overflow: 'hidden', height: '100%' },
	tabs: { display: 'flex', gap: '8px', flexWrap: 'wrap', flexShrink: 0 },
	tabContent: { flex: 1, minHeight: 0, overflow: 'hidden' },
	scrollContent: { flex: 1, minHeight: 0, overflow: 'auto' },
	pageStack: { display: 'flex', flexDirection: 'column', gap: '16px' },
	browseLayout: { display: 'flex', height: '100%', minHeight: 0, border: '1px solid var(--vscode-panel-border)', borderRadius: '10px', overflow: 'hidden', background: 'var(--vscode-editor-background)' },
	twoColumn: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '16px' },
	sidebar: { width: '40%', minWidth: '280px', maxWidth: '420px', borderRight: '1px solid var(--vscode-panel-border)', display: 'flex', flexDirection: 'column', minHeight: 0 },
	detailPane: { flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', padding: '16px' },
	detailContent: { display: 'grid', gridTemplateRows: 'auto auto auto minmax(0, 1fr) auto', gap: '16px', height: '100%', minHeight: 0 },
	actions: { display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' },
	listHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', padding: '8px 12px', borderBottom: '1px solid var(--vscode-panel-border)', flexWrap: 'wrap', flexShrink: 0 },
	listHeaderActions: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
	count: { fontSize: '12px', color: 'var(--vscode-descriptionForeground)' },
	list: { flex: 1, overflow: 'auto' },
	listItem: { display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', background: 'transparent', border: 'none', borderBottom: '1px solid var(--vscode-panel-border)', color: 'var(--vscode-foreground)', cursor: 'pointer', fontFamily: 'var(--vscode-font-family)' },
	listItemActive: { background: 'var(--vscode-list-activeSelectionBackground)' },
	listItemHeader: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' },
	listItemSha: { fontFamily: 'var(--vscode-editor-font-family)', fontSize: '12px', color: 'var(--vscode-textLink-foreground)' },
	listItemBadge: { fontSize: '10px', padding: '1px 4px', borderRadius: '3px', background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)', textTransform: 'uppercase' },
	listItemDate: { fontSize: '11px', color: 'var(--vscode-descriptionForeground)', marginLeft: 'auto' },
	listItemTitle: { fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
	listItemMeta: { fontSize: '11px', color: 'var(--vscode-descriptionForeground)', marginTop: '2px' },
	obsoleteBadge: { padding: '2px 6px', borderRadius: '999px', background: 'var(--vscode-editorWarning-background, var(--vscode-inputValidation-warningBackground))', color: 'var(--vscode-editorWarning-foreground, var(--vscode-inputValidation-warningForeground))', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase' },
	detailHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', marginBottom: '16px' },
	detailTitle: { margin: 0, fontSize: '18px' },
	detailSubtitle: { fontSize: '12px', color: 'var(--vscode-descriptionForeground)', marginTop: '4px' },
	heroCard: { padding: '18px', background: 'linear-gradient(135deg, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-button-background) 12%), var(--vscode-editor-background))', border: '1px solid var(--vscode-panel-border)', borderRadius: '12px' },
	heroCardActive: { borderColor: 'var(--vscode-progressBar-background)' },
	heroHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', marginBottom: '14px' },
	heroEyebrow: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--vscode-descriptionForeground)', marginBottom: '6px' },
	heroTitle: { margin: 0, fontSize: '24px', lineHeight: 1.2 },
	heroDescription: { marginTop: '6px', color: 'var(--vscode-descriptionForeground)', fontSize: '13px' },
	metricRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' },
	metricCard: { padding: '12px', background: 'var(--vscode-editor-background)', border: '1px solid var(--vscode-panel-border)', borderRadius: '8px' },
	metricLabel: { fontSize: '11px', color: 'var(--vscode-descriptionForeground)' },
	metricValue: { fontSize: '22px', fontWeight: 700, marginTop: '6px' },
	metricValueCompact: { fontSize: '13px', fontWeight: 700, marginTop: '6px', wordBreak: 'break-word' },
	metricSecondary: { marginTop: '6px', fontSize: '11px', color: 'var(--vscode-descriptionForeground)' },
	progressBarShell: { height: '12px', background: 'var(--vscode-input-background)', borderRadius: '999px', overflow: 'hidden' },
	progressBarFill: { height: '100%', background: 'linear-gradient(90deg, var(--vscode-progressBar-background), color-mix(in srgb, var(--vscode-progressBar-background) 60%, white 40%))', transition: 'width 180ms ease' },
	pipelineGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px' },
	pipelineStep: { display: 'flex', alignItems: 'center', gap: '10px', padding: '12px', borderRadius: '10px', border: '1px solid var(--vscode-panel-border)', background: 'var(--vscode-editor-background)' },
	pipelineStepDone: { borderColor: 'var(--vscode-testing-iconPassed)', background: 'color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-testing-iconPassed) 12%)' },
	pipelineStepActive: { borderColor: 'var(--vscode-progressBar-background)', background: 'color-mix(in srgb, var(--vscode-editor-background) 86%, var(--vscode-progressBar-background) 14%)' },
	pipelineIndex: { width: '24px', height: '24px', borderRadius: '999px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)', fontSize: '11px', fontWeight: 700 },
	pipelineLabel: { fontSize: '12px', fontWeight: 600 },
	section: { padding: '14px', background: 'var(--vscode-editor-background)', border: '1px solid var(--vscode-panel-border)', borderRadius: '10px' },
	sectionTitle: { margin: '0 0 10px 0', fontSize: '13px' },
	sectionHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginBottom: '10px' },
	sectionMeta: { fontSize: '12px', color: 'var(--vscode-descriptionForeground)' },
	sliderStack: { display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '12px' },
	sliderField: { padding: '12px', borderRadius: '10px', background: 'var(--vscode-sideBar-background)', border: '1px solid var(--vscode-panel-border)' },
	sliderHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', marginBottom: '10px' },
	sliderValue: { fontSize: '12px', fontWeight: 700, whiteSpace: 'nowrap', color: 'var(--vscode-textLink-foreground)' },
	sliderInput: { width: '100%', margin: '2px 0 6px 0' },
	sliderFooter: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', fontSize: '11px', color: 'var(--vscode-descriptionForeground)' },
	sliderRecommendation: { flex: 1, textAlign: 'center' },
	keyValueGrid: { display: 'grid', gridTemplateColumns: '180px 1fr', gap: '8px 12px', fontSize: '12px' },
	mono: { fontFamily: 'var(--vscode-editor-font-family)' },
	monoSmall: { fontFamily: 'var(--vscode-editor-font-family)', fontSize: '11px', wordBreak: 'break-all' },
	contentSection: { display: 'flex', flexDirection: 'column', minHeight: 0 },
	contentBox: { margin: 0, padding: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--vscode-textCodeBlock-background, var(--vscode-input-background))', borderRadius: '8px', fontSize: '12px', fontFamily: 'var(--vscode-editor-font-family)' },
	listStack: { display: 'flex', flexDirection: 'column', gap: '10px' },
	infoRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', paddingBottom: '10px', borderBottom: '1px solid var(--vscode-panel-border)' },
	infoPrimary: { fontSize: '12px', fontWeight: 600 },
	infoSecondary: { fontSize: '11px', color: 'var(--vscode-descriptionForeground)', marginTop: '4px' },
	compactSection: { display: 'flex', flexDirection: 'column', minHeight: '220px', maxHeight: '260px' },
	compactSectionBody: { flex: 1, minHeight: 0, overflow: 'auto' },
	sectionSubtleTitle: { fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--vscode-descriptionForeground)', marginTop: '14px', marginBottom: '8px' },
	currentTaskHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', marginBottom: '12px' },
	phaseBadge: { padding: '4px 8px', borderRadius: '999px', background: 'color-mix(in srgb, var(--vscode-progressBar-background) 18%, transparent)', border: '1px solid var(--vscode-progressBar-background)', fontSize: '11px', fontWeight: 700 },
	progressCaption: { marginTop: '8px', fontSize: '11px', color: 'var(--vscode-descriptionForeground)' },
	eventRow: { display: 'flex', gap: '10px', alignItems: 'flex-start', paddingBottom: '10px', borderBottom: '1px solid var(--vscode-panel-border)' },
	eventMarker: { width: '10px', height: '10px', borderRadius: '999px', marginTop: '4px', flex: '0 0 auto' },
	eventInfo: { background: 'var(--vscode-progressBar-background)' },
	eventSuccess: { background: 'var(--vscode-testing-iconPassed)' },
	eventError: { background: 'var(--vscode-testing-iconFailed)' },
	eventBody: { minWidth: 0 },
	actionGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' },
	actionCard: { padding: '12px', borderRadius: '10px', background: 'var(--vscode-sideBar-background)', border: '1px solid var(--vscode-panel-border)', display: 'flex', flexDirection: 'column', gap: '10px' },
	triggerGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' },
	triggerCard: { padding: '12px', borderRadius: '10px', background: 'var(--vscode-sideBar-background)', border: '1px solid var(--vscode-panel-border)' },
	triggerTitle: { fontSize: '12px', color: 'var(--vscode-descriptionForeground)', marginBottom: '8px' },
	triggerValue: { fontSize: '22px', fontWeight: 700, marginBottom: '4px' },
	empty: { display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--vscode-descriptionForeground)', minHeight: '180px', textAlign: 'center' },
	emptyState: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', color: 'var(--vscode-descriptionForeground)', minHeight: '180px', textAlign: 'center', padding: '20px' },
	emptyText: { fontSize: '13px' },
	emptyActions: { display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' },
	emptyPane: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--vscode-descriptionForeground)', textAlign: 'center' },
	emptyInline: { color: 'var(--vscode-descriptionForeground)', fontSize: '12px' },
	checkboxLabel: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', marginBottom: '10px' },
	settingBlock: { display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' },
	settingRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', marginBottom: '12px' },
	settingText: { display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: 0 },
	settingControl: { flex: '0 0 auto' },
	settingControlStack: { width: '100%' },
	settingCheckboxDescription: { color: 'var(--vscode-descriptionForeground)', fontSize: '11px', lineHeight: 1.4, marginTop: '-6px', marginLeft: '26px', maxWidth: '720px' },
	textarea: { width: '100%', minHeight: '120px', padding: '8px', background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border)', borderRadius: '4px', fontSize: '12px', fontFamily: 'var(--vscode-editor-font-family)' },
	fieldRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '10px', fontSize: '12px' },
	input: { width: '180px', padding: '4px 8px', background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border)', borderRadius: '3px', fontSize: '12px' },
	select: { width: '180px', padding: '4px 8px', background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border)', borderRadius: '3px', fontSize: '12px' },
};
