import test from 'node:test';
import assert from 'node:assert/strict';

import { TimeTrackingService } from '../src/services/timeTrackingService.js';

test('applyElapsedBeforeStatusChange keeps elapsed time in the previous task bucket', () => {
	const updated = TimeTrackingService.applyElapsedBeforeStatusChange({
		status: 'in-progress' as const,
		timeSpentWriting: 1000,
		timeSpentOnTask: 2000,
	}, 'closed', 3000);

	assert.deepEqual(updated, {
		status: 'closed',
		timeSpentWriting: 1000,
		timeSpentOnTask: 5000,
	});
});

test('applyElapsedBeforeStatusChange keeps elapsed time in the previous writing bucket', () => {
	const updated = TimeTrackingService.applyElapsedBeforeStatusChange({
		status: 'draft' as const,
		timeSpentWriting: 400,
		timeSpentOnTask: 0,
	}, 'report', 600);

	assert.deepEqual(updated, {
		status: 'report',
		timeSpentWriting: 1000,
		timeSpentOnTask: 0,
	});
});