import test from 'node:test';
import assert from 'node:assert/strict';

import {
	decideFileReportSync,
	isLatestPersistedReport,
	shouldFlushReportEditorOnUnmount,
	shouldIgnoreReportEditorExternalUpdate,
} from '../src/utils/reportSync.js';

test('decideFileReportSync skips identical file content', () => {
	const decision = decideFileReportSync({
		previousSyncedReport: '123',
		incomingReport: '123',
		baseReport: '123',
		localReport: '123',
	});

	assert.equal(decision, 'skip-same-content');
});

test('decideFileReportSync protects newer local unsaved report from stale file content', () => {
	const decision = decideFileReportSync({
		previousSyncedReport: '1',
		incomingReport: '',
		baseReport: '',
		localReport: '123',
	});

	assert.equal(decision, 'skip-local-changes');
});

test('decideFileReportSync applies incoming report when local state matches incoming value', () => {
	const decision = decideFileReportSync({
		previousSyncedReport: '1',
		incomingReport: '123',
		baseReport: '',
		localReport: '123',
	});

	assert.equal(decision, 'apply');
});

test('shouldIgnoreReportEditorExternalUpdate ignores stale external updates while local editor is ahead', () => {
	const ignored = shouldIgnoreReportEditorExternalUpdate({
		hasUnsyncedLocalChanges: true,
		incomingReport: '1',
		currentReport: '123',
	});

	assert.equal(ignored, true);
});

test('shouldIgnoreReportEditorExternalUpdate accepts synced updates when local editor is not ahead', () => {
	const ignored = shouldIgnoreReportEditorExternalUpdate({
		hasUnsyncedLocalChanges: false,
		incomingReport: '123',
		currentReport: '12',
	});

	assert.equal(ignored, false);
});

test('shouldIgnoreReportEditorExternalUpdate accepts no-op updates even with unsynced local flag', () => {
	const ignored = shouldIgnoreReportEditorExternalUpdate({
		hasUnsyncedLocalChanges: true,
		incomingReport: '123',
		currentReport: '123',
	});

	assert.equal(ignored, false);
});

test('shouldFlushReportEditorOnUnmount flushes when a manual save cleared the timer but local changes are still unsynced', () => {
	const shouldFlush = shouldFlushReportEditorOnUnmount({
		hasPendingFlush: false,
		hasUnsyncedLocalChanges: true,
	});

	assert.equal(shouldFlush, true);
});

test('shouldFlushReportEditorOnUnmount skips flush when nothing is pending and local state is already synced', () => {
	const shouldFlush = shouldFlushReportEditorOnUnmount({
		hasPendingFlush: false,
		hasUnsyncedLocalChanges: false,
	});

	assert.equal(shouldFlush, false);
});

test('isLatestPersistedReport returns true for current persisted report', () => {
	assert.equal(
		isLatestPersistedReport({
			currentReport: '123',
			persistedReport: '123',
		}),
		true,
	);
});

test('isLatestPersistedReport returns false for stale persisted report', () => {
	assert.equal(
		isLatestPersistedReport({
			currentReport: '123',
			persistedReport: '1',
		}),
		false,
	);
});