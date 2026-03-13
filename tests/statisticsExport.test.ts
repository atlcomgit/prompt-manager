import test from 'node:test';
import assert from 'node:assert/strict';

import {
	buildStatisticsMarkdownWithReport,
	calculateStatisticsExportTargetHours,
	getStatisticsStatusPercent,
	summarizePromptReport,
} from '../src/utils/statisticsExport.js';

test('calculateStatisticsExportTargetHours uses fallback when period is not selected', () => {
	assert.equal(calculateStatisticsExportTargetHours({ dateFrom: null, dateTo: null }), 165);
});

test('calculateStatisticsExportTargetHours returns 165 for one full calendar month', () => {
	assert.equal(calculateStatisticsExportTargetHours({ dateFrom: '2026-03-01', dateTo: '2026-03-31' }), 165);
});

test('calculateStatisticsExportTargetHours multiplies 165 by count of full months in range', () => {
	assert.equal(calculateStatisticsExportTargetHours({ dateFrom: '2026-02-01', dateTo: '2026-03-31' }), 330);
});

test('calculateStatisticsExportTargetHours uses working days times eight for arbitrary range', () => {
	assert.equal(calculateStatisticsExportTargetHours({ dateFrom: '2026-03-02', dateTo: '2026-03-06' }), 40);
});

test('summarizePromptReport strips html and limits output length', () => {
	const summary = summarizePromptReport('<p><strong>Сделано:</strong> Исправлен экспорт <br/> и добавлен чекбокс.</p>');
	assert.equal(summary, 'Исправлен экспорт и добавлен чекбокс.');
	assert.ok(summary.length <= 200);
});

test('summarizePromptReport extracts only the done section without repeating its title', () => {
	const summary = summarizePromptReport([
		'- **Что сделано**.',
		'  Добавлен GET /hello и обновлен экспорт.',
		'- **Как протестировать**.',
		'  Открыть страницу и проверить ответ.',
	].join('\n'));

	assert.equal(summary, 'Добавлен GET /hello и обновлен экспорт.');
	assert.ok(!summary.includes('Что сделано'));
	assert.ok(!summary.includes('Как протестировать'));
});

test('summarizePromptReport truncates long content with ellipsis', () => {
	const summary = summarizePromptReport('a'.repeat(260));
	assert.equal(summary.length, 200);
	assert.ok(summary.endsWith('…'));
});

test('getStatisticsStatusPercent maps prompt statuses to requested percentages', () => {
	assert.equal(getStatisticsStatusPercent('draft'), 10);
	assert.equal(getStatisticsStatusPercent('closed'), 100);
	assert.equal(getStatisticsStatusPercent('in-progress'), 50);
	assert.equal(getStatisticsStatusPercent('stopped'), 60);
	assert.equal(getStatisticsStatusPercent('cancelled'), 0);
	assert.equal(getStatisticsStatusPercent('completed'), 70);
	assert.equal(getStatisticsStatusPercent('report'), 80);
	assert.equal(getStatisticsStatusPercent('review'), 90);
});

test('buildStatisticsMarkdownWithReport renders task blocks with summary and status percent', () => {
	const markdown = buildStatisticsMarkdownWithReport([
		{
			taskNumber: '123',
			title: 'Исправить экспорт',
			reportSummary: 'Добавлен новый формат markdown.',
			status: 'review',
		},
		{
			taskNumber: '',
			title: 'Подготовить отчёт',
			reportSummary: '',
			status: 'cancelled',
		},
	], 165, 'ru');

	assert.match(markdown, /Номер задачи: 123/);
	assert.match(markdown, /Название: Исправить экспорт/);
	assert.match(markdown, /Что сделано: Добавлен новый формат markdown\./);
	assert.match(markdown, /Статус: 90%/);
	assert.match(markdown, /Номер задачи: —/);
	assert.match(markdown, /Статус: 0%/);
	assert.ok(!markdown.includes('| № задачи |'));
});