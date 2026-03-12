import type {
	ManualAnalysisCommitRow,
	ManualAnalysisCommitStatus,
	ManualAnalysisRunStatus,
} from '../types/memory.js';

export const MANUAL_ANALYSIS_EVENT_LIMIT = 40;

export function computeManualAnalysisThroughput(processed: number, elapsedMs: number): number {
	if (processed <= 0 || elapsedMs <= 0) {
		return 0;
	}

	return Number(((processed / elapsedMs) * 60000).toFixed(2));
}

export function computeManualAnalysisEta(remaining: number, throughputPerMinute: number): number | undefined {
	if (remaining <= 0 || throughputPerMinute <= 0) {
		return undefined;
	}

	return Math.round((remaining / throughputPerMinute) * 60000);
}

export function isManualAnalysisBusy(status: ManualAnalysisRunStatus): boolean {
	return status === 'running' || status === 'pausing' || status === 'paused' || status === 'stopping';
}

export function isManualAnalysisTerminal(status: ManualAnalysisRunStatus): boolean {
	return status === 'completed' || status === 'stopped' || status === 'idle';
}

export function filterManualAnalysisRows(
	rows: ManualAnalysisCommitRow[],
	status: ManualAnalysisCommitStatus | 'all',
	repository: string,
): ManualAnalysisCommitRow[] {
	return rows.filter((row) => {
		if (status !== 'all' && row.status !== status) {
			return false;
		}

		if (repository && repository !== 'all' && row.repository !== repository) {
			return false;
		}

		return true;
	});
}