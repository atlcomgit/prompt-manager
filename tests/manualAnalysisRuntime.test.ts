import test from 'node:test';
import assert from 'node:assert/strict';

import type { ManualAnalysisCommitRow } from '../src/types/memory.js';
import {
	computeManualAnalysisEta,
	computeManualAnalysisThroughput,
	filterManualAnalysisRows,
	isManualAnalysisBusy,
	isManualAnalysisTerminal,
} from '../src/utils/manualAnalysisRuntime.js';

const rows: ManualAnalysisCommitRow[] = [
	{
		id: 'repo:1',
		sha: '1111111',
		repository: 'repo-a',
		branch: 'main',
		message: 'Completed commit',
		status: 'completed',
		fileCount: 3,
		diffBytes: 120,
		categories: ['backend'],
		architectureImpactScore: 2,
		isStored: true,
		sequence: 1,
	},
	{
		id: 'repo:2',
		sha: '2222222',
		repository: 'repo-b',
		branch: 'main',
		message: 'Skipped commit',
		status: 'skipped',
		reason: 'already-analyzed',
		fileCount: 0,
		diffBytes: 0,
		categories: [],
		isStored: true,
		sequence: 2,
	},
	{
		id: 'repo:3',
		sha: '3333333',
		repository: 'repo-a',
		branch: '',
		message: '',
		status: 'queued',
		fileCount: 0,
		diffBytes: 0,
		categories: [],
		isStored: false,
		sequence: 3,
	},
];

test('computeManualAnalysisThroughput returns commits per minute', () => {
	assert.equal(computeManualAnalysisThroughput(6, 120000), 3);
});

test('computeManualAnalysisEta estimates remaining time from throughput', () => {
	assert.equal(computeManualAnalysisEta(6, 3), 120000);
});

test('filterManualAnalysisRows filters by status and repository', () => {
	const filtered = filterManualAnalysisRows(rows, 'completed', 'repo-a');
	assert.equal(filtered.length, 1);
	assert.equal(filtered[0].sha, '1111111');
});

test('isManualAnalysisBusy and isManualAnalysisTerminal reflect runtime states', () => {
	assert.equal(isManualAnalysisBusy('paused'), true);
	assert.equal(isManualAnalysisBusy('completed'), false);
	assert.equal(isManualAnalysisTerminal('stopped'), true);
	assert.equal(isManualAnalysisTerminal('running'), false);
});