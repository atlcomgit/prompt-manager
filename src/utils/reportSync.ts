export type FileReportSyncDecision = 'skip-same-content' | 'skip-local-changes' | 'apply';

export interface FileReportSyncDecisionInput {
	previousSyncedReport: string;
	incomingReport: string;
	baseReport: string;
	localReport: string;
}

export interface ReportEditorExternalUpdateInput {
	hasUnsyncedLocalChanges: boolean;
	incomingReport: string;
	currentReport: string;
}

export interface PersistedReportSyncInput {
	currentReport: string;
	persistedReport: string;
}

export interface ReportEditorUnmountFlushInput {
	hasPendingFlush: boolean;
	hasUnsyncedLocalChanges: boolean;
}

export const decideFileReportSync = ({
	previousSyncedReport,
	incomingReport,
	baseReport,
	localReport,
}: FileReportSyncDecisionInput): FileReportSyncDecision => {
	if (previousSyncedReport === incomingReport) {
		return 'skip-same-content';
	}

	const hasLocalReportChanges = localReport !== baseReport;
	if (hasLocalReportChanges && localReport !== incomingReport) {
		return 'skip-local-changes';
	}

	return 'apply';
};

export const shouldIgnoreReportEditorExternalUpdate = ({
	hasUnsyncedLocalChanges,
	incomingReport,
	currentReport,
}: ReportEditorExternalUpdateInput): boolean => {
	return hasUnsyncedLocalChanges && incomingReport !== currentReport;
};

export const shouldFlushReportEditorOnUnmount = ({
	hasPendingFlush,
	hasUnsyncedLocalChanges,
}: ReportEditorUnmountFlushInput): boolean => {
	return hasPendingFlush || hasUnsyncedLocalChanges;
};

export const isLatestPersistedReport = ({
	currentReport,
	persistedReport,
}: PersistedReportSyncInput): boolean => currentReport === persistedReport;