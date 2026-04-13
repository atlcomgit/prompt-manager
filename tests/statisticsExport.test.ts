import test from 'node:test';
import assert from 'node:assert/strict';

import {
	buildStatisticsWordSection,
	buildStatisticsMarkdownWithReport,
	calculateStatisticsExportTargetHours,
	getStatisticsStatusPercent,
	summarizePromptReport,
} from '../src/utils/statisticsExport.js';
import {
	buildStatisticsExportHtmlDocument,
	buildStatisticsExportHtmlPreview,
	buildStatisticsExportMarkdownDocument,
} from '../src/utils/statisticsDocumentTemplate.js';

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
	assert.ok(summary.length <= 500);
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
	const summary = summarizePromptReport('a'.repeat(560));
	assert.equal(summary.length, 500);
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
			hours: 15,
			reportSummary: 'Добавлен новый формат markdown.',
			status: 'review',
		},
		{
			taskNumber: '',
			title: 'Подготовить отчёт',
			hours: 5,
			reportSummary: '',
			status: 'cancelled',
		},
	], 165, 1743, 'ru');

	assert.match(markdown, /Номер задачи: 123/);
	assert.match(markdown, /Название: Исправить экспорт/);
	assert.match(markdown, /Часы: 15/);
	assert.match(markdown, /Сумма:/);
	assert.match(markdown, /Что сделано: Добавлен новый формат markdown\./);
	assert.match(markdown, /Статус: 90%/);
	assert.match(markdown, /Ставка часа:/);
	assert.match(markdown, /Итоговая сумма:/);
	assert.match(markdown, /## Word/);
	assert.match(markdown, /№\tНомер задачи: Название\tКоличество часов\tч\.\tСтоимость часа\tСумма/);
	assert.match(markdown, /Номер задачи: —/);
	assert.match(markdown, /Статус: 0%/);
	assert.ok(!markdown.includes('| № задачи |'));
});

test('buildStatisticsWordSection renders tab-separated rows for Word tables', () => {
	const section = buildStatisticsWordSection([
		{
			taskNumber: '52',
			title: 'Добавить часы и ставку в экспорт',
			hours: 12,
		},
		{
			taskNumber: '',
			title: 'Подготовить отчёт',
			hours: 5.5,
		},
	], 1743, 'ru');

	const lines = section.split('\n');
	assert.equal(lines[0], '## Word');
	assert.equal(lines[2], '№\tНомер задачи: Название\tКоличество часов\tч.\tСтоимость часа\tСумма');
	assert.equal(lines[3], '1\t52: Добавить часы и ставку в экспорт\t12\tч.\t1743\t20916');
	assert.equal(lines[4], '2\t—: Подготовить отчёт\t5,50\tч.\t1743\t9586,50');
});

test('buildStatisticsWordSection hides cost columns when hourly rate data should be omitted', () => {
	const section = buildStatisticsWordSection([
		{
			taskNumber: '52',
			title: 'Добавить часы без стоимости',
			hours: 12,
		},
	], 1743, 'ru', { showHours: true, showCost: false });

	const lines = section.split('\n');
	assert.equal(lines[2], '№\tНомер задачи: Название\tКоличество часов\tч.');
	assert.equal(lines[3], '1\t52: Добавить часы без стоимости\t12\tч.');
	assert.ok(!section.includes('Стоимость часа'));
	assert.ok(!section.includes('Сумма'));
});

test('buildStatisticsMarkdownWithReport omits hours and cost data when both are hidden', () => {
	const markdown = buildStatisticsMarkdownWithReport([
		{
			taskNumber: '123',
			title: 'Исправить экспорт',
			hours: 15,
			reportSummary: 'Добавлен новый формат markdown.',
			status: 'review',
		},
	], 0, 1743, 'ru', { showHours: false, showCost: false });

	assert.match(markdown, /Номер задачи: 123/);
	assert.match(markdown, /Название: Исправить экспорт/);
	assert.match(markdown, /Что сделано: Добавлен новый формат markdown\./);
	assert.match(markdown, /Статус: 90%/);
	assert.ok(!markdown.includes('Итого часов'));
	assert.ok(!markdown.includes('Ставка часа'));
	assert.ok(!markdown.includes('Итоговая сумма'));
	assert.ok(!markdown.includes('Часы:'));
	assert.ok(!markdown.includes('Сумма:'));
	assert.ok(!markdown.includes('Количество часов'));
	assert.ok(!markdown.includes('Стоимость часа'));
});

test('buildStatisticsExportHtmlDocument and preview share the same document shell', () => {
	const rows = [
		{
			taskNumber: '55',
			title: 'Выровнять превью документов',
			hours: 12,
			reportSummary: 'Сделан единый HTML-шаблон для preview и export.',
		},
	];

	const fullHtml = buildStatisticsExportHtmlDocument(rows, 12, 'ru', true, 1743);
	const previewHtml = buildStatisticsExportHtmlPreview(rows, 12, 'ru', true, 1743);

	assert.match(fullHtml, /pm-stats-export-page/);
	assert.match(fullHtml, /Отчёт по статистике/);
	assert.match(fullHtml, /Выровнять превью документов/);
	assert.match(fullHtml, /20.?916/);
	assert.match(previewHtml, /pm-stats-export-page/);
	assert.match(previewHtml, /pm-stats-export-table/);
	assert.match(previewHtml, /Prompt Manager/);
	assert.ok(previewHtml.includes('Сделан единый HTML-шаблон для preview и export.'));
	assert.ok(fullHtml.includes('<style>'));
	assert.ok(previewHtml.includes('<style>'));
});

test('buildStatisticsExportHtmlDocument hides money columns and summary when hourly rate is zero', () => {
	const html = buildStatisticsExportHtmlDocument([
		{
			taskNumber: '55',
			title: 'Выровнять превью документов',
			hours: 12,
			reportSummary: 'Сделан единый HTML-шаблон для preview и export.',
		},
	], 12, 'ru', true, 0);

	assert.match(html, /Итого часов/);
	assert.ok(!html.includes('Ставка часа'));
	assert.ok(!html.includes('Итоговая сумма'));
	assert.ok(!html.includes('<th class="pm-stats-export-col-amount-head">'));
	assert.ok(!html.includes('<td class="pm-stats-export-col-amount">'));
});

test('buildStatisticsExportMarkdownDocument renders compact markdown export without summaries', () => {
	const markdown = buildStatisticsExportMarkdownDocument([
		{
			taskNumber: '77',
			title: 'Подготовить шаблон таблиц',
			hours: 8,
		},
	], 8, 'ru', false, 1743);

	assert.match(markdown, /# Отчёт по статистике/);
	assert.match(markdown, /\| № задачи/);
	assert.match(markdown, /Подготовить шаблон таблиц/);
	assert.match(markdown, /## Word/);
	assert.match(markdown, /13944/);
	assert.ok(!markdown.includes('Что сделано:'));
	assert.ok(markdown.endsWith('\n'));
});

test('buildStatisticsExportMarkdownDocument hides hours and cost sections when total hours are zero', () => {
	const markdown = buildStatisticsExportMarkdownDocument([
		{
			taskNumber: '77',
			title: 'Подготовить шаблон таблиц',
			hours: 0,
		},
	], 0, 'ru', false, 1743);

	assert.match(markdown, /# Отчёт по статистике/);
	assert.match(markdown, /\|\s+№ задачи\s+\|\s+Название\s+\|/);
	assert.ok(!markdown.includes('Итого часов'));
	assert.ok(!markdown.includes('Ставка часа'));
	assert.ok(!markdown.includes('Итоговая сумма'));
	assert.ok(!markdown.includes('Количество часов'));
	assert.ok(!markdown.includes('Стоимость часа'));
	assert.ok(!markdown.includes('Подготовить шаблон таблиц |    0'));
	assert.ok(markdown.endsWith('\n'));
});