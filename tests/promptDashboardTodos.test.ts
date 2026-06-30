import test from 'node:test';
import assert from 'node:assert/strict';

import {
	buildPromptDashboardTodosData,
	extractPromptDashboardTodoMarkers,
	filterPromptDashboardTodosDataByFileTypes,
	flattenPromptDashboardTodoMarkers,
	formatPromptDashboardTodoFileTypeLabel,
	normalizePromptDashboardTodoFileType,
	normalizePromptDashboardTodoPath,
} from '../src/utils/promptDashboardTodos.js';

test('normalizePromptDashboardTodoPath keeps project-relative paths stable', () => {
	assert.equal(normalizePromptDashboardTodoPath('./src\\feature//todo.ts'), 'src/feature/todo.ts');
	assert.equal(normalizePromptDashboardTodoPath('/src/app.ts'), 'src/app.ts');
});

test('normalizePromptDashboardTodoFileType resolves extensions and extensionless files', () => {
	assert.equal(normalizePromptDashboardTodoFileType('src/App.TSX'), 'tsx');
	assert.equal(normalizePromptDashboardTodoFileType('Dockerfile'), 'dockerfile');
	assert.equal(normalizePromptDashboardTodoFileType('README'), 'other');
	assert.equal(formatPromptDashboardTodoFileTypeLabel('tsx'), '.tsx');
	assert.equal(formatPromptDashboardTodoFileTypeLabel('other'), 'other');
});

test('extractPromptDashboardTodoMarkers finds todo and custom markers with line links', () => {
	const result = extractPromptDashboardTodoMarkers({
		project: 'prompt-manager',
		filePath: 'src/example.ts',
		content: [
			'const ready = true;',
			'// TODO: finish the widget',
			'const marker = "//?!? inspect this";',
		].join('\n'),
	});

	assert.equal(result.truncated, false);
	assert.equal(result.markers.length, 2);
	assert.deepEqual(result.markers.map(marker => marker.marker), ['todo', 'custom']);
	assert.deepEqual(result.markers.map(marker => marker.line), [2, 3]);
	assert.equal(result.markers[0].column, 4);
	assert.equal(result.markers[1].fileType, 'ts');
});

test('extractPromptDashboardTodoMarkers respects max marker limit', () => {
	const result = extractPromptDashboardTodoMarkers({
		project: 'prompt-manager',
		filePath: 'src/example.ts',
		content: 'todo one\ntodo two\ntodo three',
		maxMarkers: 2,
	});

	assert.equal(result.truncated, true);
	assert.equal(result.markers.length, 2);
});

test('buildPromptDashboardTodosData groups markers by project type and file', () => {
	const first = extractPromptDashboardTodoMarkers({
		project: 'api',
		filePath: 'src/a.ts',
		content: 'todo api',
	}).markers;
	const second = extractPromptDashboardTodoMarkers({
		project: 'web',
		filePath: 'docs/readme.md',
		content: '//?!? web docs',
	}).markers;
	const data = buildPromptDashboardTodosData({
		markers: [...second, ...first],
		scannedFileCount: 2,
		skippedFileCount: 1,
		maxResults: 50,
		truncated: false,
		generatedAt: '2026-06-29T00:00:00.000Z',
	});

	assert.equal(data.markerCount, 2);
	assert.equal(data.fileCount, 2);
	assert.deepEqual(data.projects.map(project => project.project), ['api', 'web']);
	assert.deepEqual(data.fileTypes.map(type => type.fileType), ['md', 'ts']);
	assert.equal(data.projects[0].fileTypes[0].files[0].fileName, 'a.ts');
});

test('filterPromptDashboardTodosDataByFileTypes keeps metadata and selected markers', () => {
	const markers = [
		...extractPromptDashboardTodoMarkers({
			project: 'api',
			filePath: 'src/a.ts',
			content: 'todo api',
		}).markers,
		...extractPromptDashboardTodoMarkers({
			project: 'api',
			filePath: 'docs/a.md',
			content: 'todo docs',
		}).markers,
	];
	const data = buildPromptDashboardTodosData({
		markers,
		scannedFileCount: 10,
		skippedFileCount: 2,
		maxResults: 50,
		truncated: true,
	});

	const filtered = filterPromptDashboardTodosDataByFileTypes(data, ['md']);

	assert.equal(filtered.scannedFileCount, 10);
	assert.equal(filtered.skippedFileCount, 2);
	assert.equal(filtered.truncated, true);
	assert.deepEqual(flattenPromptDashboardTodoMarkers(filtered).map(marker => marker.filePath), ['docs/a.md']);
});