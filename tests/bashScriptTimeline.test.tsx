import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BashScriptRow } from '../src/webview/editor/components/bashScripts/BashScriptRow.js';
import type { BashScriptRun } from '../src/types/bashScripts.js';

/** Первая запись каталога соответствует фактическому последнему запуску. */
function scriptRow(history: BashScriptRun[], open = true, activeRunIds?: string[]) {
	const noop = () => {};
	return <BashScriptRow entry={{ name: 'build.sh', id: '1', scope: 'project', path: 'scripts/build.sh',
		absolutePath: '/internal/build/scripts/build.sh', project: { name: 'build', root: '/internal/build', relativePath: 'scripts/build.sh' },
		available: true, history, activeRunIds }} busy={false} historyOpen={open} hideTarget={null} onRun={noop} onEdit={noop}
		favorite={false} onToggleFavorite={noop} onHistory={noop} onHide={noop} confirmHide={noop} />;
}

function renderRow(history: BashScriptRun[], open = true) {
	return renderToStaticMarkup(scriptRow(history, open));
}

/** A narrow row has its own presentation; history and assistive technology keep the full duration. */
test('Bash rows offer minute abbreviations and clock durations, including multi-hour runs', () => {
	const startedAt = '2026-02-01T10:00:00Z';
	for (const [finishedAt, full, short, clock] of [
		['2026-02-01T10:02:40Z', '2 мин 40 с', '2 м 40 с', '02:40'],
		['2026-02-01T11:02:03Z', '1 ч 2 мин', '1 ч 2 м', '1:02:03'],
	]) {
		const [row, history] = renderRow([{ id: 'a', startedAt, finishedAt, exitCode: 0 }]).split('role="region"');
		assert.ok(row.includes(`aria-description="Успешно · ${full}"`));
		for (const [kind, value] of [['full', full], ['short', short], ['clock', clock]]) {
			assert.ok(row.includes(`class="pm-bs-duration-${kind}">${value}</span>`));
		}
		assert.ok(history.includes(`class="pm-bs-duration">${full}</span>`));
	}
});

/** Различает подтверждение Shell, старый код и закрытие терминала независимо от записанной отметки времени. */
test('Bash timeline scales only confirmed durations and shows the latest run duration next to history', () => {
	const start = '2026-02-01T10:00:00.000Z';
	const runs: BashScriptRun[] = [
		{ id: 'a', startedAt: start, finishedAt: '2026-02-01T10:00:05Z', endedBy: 'shell' },
		{ id: 'b', startedAt: start, finishedAt: '2026-02-01T10:00:20Z', exitCode: 9 },
		{ id: 'c', startedAt: start, finishedAt: '2026-02-01T11:00:00Z', endedBy: 'terminal' },
		{ id: 'd', startedAt: start, finishedAt: '2026-02-01T13:00:00Z' },
		{ id: 'e', startedAt: start },
		{ id: 'f', startedAt: start, finishedAt: start, exitCode: 0 },
	];
	const html = renderRow(runs);
	const [row, history] = html.split('role="region"');
	assert.match(row, /class="pm-bs-last-run"[^>]*><span>5 с<\/span><svg\b[^>]*>/);
	assert.doesNotMatch(row, /<time/);
	assert.match(row, /class="pm-bs-path-hint" title="\/internal\/build\/scripts\/build.sh"><bdi>scripts\/build.sh<\/bdi>/);
	assert.doesNotMatch(history, /scripts\/build.sh/);
	assert.deepEqual(Array.from(history.matchAll(/class="pm-bs-bar" style="width:([\d.]+)%"/g), match => match[1]), ['25', '100', '0']);
	assert.equal((history.match(/class="pm-bs-unknown"/g) ?? []).length, 3);
	assert.equal((history.match(/<time /g) ?? []).length, runs.length);
	assert.deepEqual(Array.from(history.matchAll(/<li(?: data-outcome="([^"]+)")?>/g), match => match[1]),
		[undefined, 'error', undefined, undefined, undefined, 'success']);
	for (const expected of ['Завершён без кода', 'Код 9', 'Терминал закрыт', 'Результат неизвестен', 'Запуск зарегистрирован', 'Успешно']) {
		assert.ok(history.includes(expected), expected);
	}
	const closed = renderRow([runs[2]], false);
	assert.match(closed, /<span>—<\/span>/);
	assert.doesNotMatch(closed, /class="pm-bs-history"/);
});

test('The row skips unknown durations while each history entry keeps its own measurement', () => {
	const unknown: BashScriptRun = { id: 'recent', startedAt: '2026-02-04', finishedAt: '2026-02-05', endedBy: 'terminal' };
	const untracked: BashScriptRun = { id: 'untracked', startedAt: '2026-02-03' };
	const measured: BashScriptRun = { id: 'measured', startedAt: '2026-02-02', finishedAt: '2026-02-02T00:00:20Z', exitCode: 9 };
	const older: BashScriptRun = { id: 'older', startedAt: '2026-02-01', finishedAt: '2026-02-01T00:00:50Z', exitCode: 0 };
	const [row, history] = renderRow([unknown, untracked, measured, older]).split('role="region"');
	assert.match(row, /class="pm-bs-last-run" data-outcome="error"[^>]*><span>20 с<\/span>/);
	assert.match(row, /Последний запуск — Терминал закрыт\. Последнее измерение — 20 с \(Код 9\)/);
	assert.deepEqual(Array.from(history.matchAll(/class="pm-bs-(?:unknown|duration)">([^<]+)</g), m => m[1]),
		['Длительность неизвестна', 'Длительность неизвестна', '20 с', '50 с']);
	const zero = renderRow([unknown, { ...measured, finishedAt: measured.startedAt }, older], false);
	assert.match(zero, /<span>0 мс<\/span>/);
});

test('Live duration follows the newest active shell and switches to the final result when it ends', async t => {
	const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
	GlobalRegistrator.register();
	Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
	const { createRoot } = await import('react-dom/client');
	const root = createRoot(document.body.appendChild(document.createElement('div')));
	t.after(async () => {
		await React.act(async () => root.unmount());
		Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
		await GlobalRegistrator.unregister();
	});
	const start = Date.parse('2026-02-01T10:00:00.000Z');
	let now = start + 5000;
	t.mock.method(Date, 'now', () => now);
	let tick: (() => void) | undefined;
	const clock = t.mock.method(window, 'setInterval', (callback: () => void) => { tick = callback; return 27; });
	const stop = t.mock.method(window, 'clearInterval', () => {});
	const rowTime = () => document.querySelector('.pm-bs-last-run')!;
	const play = () => document.querySelector<HTMLButtonElement>('.pm-bs-play')!;
	const older: BashScriptRun = { id: 'older', startedAt: new Date(start).toISOString() };
	const newer: BashScriptRun = { id: 'newer', startedAt: new Date(start + 1000).toISOString() };
	const history: BashScriptRun[] = [
		{ id: 'zero', startedAt: new Date(start - 2000).toISOString(), finishedAt: new Date(start - 2000).toISOString(), exitCode: 0 },
		{ id: 'unknown', startedAt: new Date(start - 3000).toISOString() },
		{ id: 'previous', startedAt: new Date(start - 15000).toISOString(), finishedAt: new Date(start - 5000).toISOString(), exitCode: 7 },
		{ id: 'longest', startedAt: new Date(start - 60000).toISOString(), finishedAt: new Date(start - 20000).toISOString(), exitCode: 0 },
	];
	const progress = () => Array.from(document.querySelectorAll('[role=progressbar]'), element => element.getAttribute('aria-valuenow'));
	await React.act(async () => root.render(scriptRow([newer, ...history.slice(0, 2)], false, ['newer'])));
	assert.deepEqual(progress(), [null], 'первый измеряемый запуск виден и при закрытой истории');
	await React.act(async () => root.render(scriptRow([newer, older, ...history], true, ['older', 'newer'])));
	assert.deepEqual(progress(), ['40', '40', '50']);
	assert.equal(rowTime().textContent, '4 с');
	assert.equal(rowTime().getAttribute('data-outcome'), 'running');
	assert.equal(play().disabled, true);
	assert.ok(play().querySelector('.pm-qn-spin'));
	assert.equal(clock.mock.callCount(), 1);
	now += 2000;
	await React.act(async () => tick!());
	assert.equal(rowTime().textContent, '6 с');
	assert.deepEqual(progress(), ['60', '60', '70']);
	const finished = { ...newer, finishedAt: new Date(now).toISOString(), exitCode: 7 };
	await React.act(async () => root.render(scriptRow([finished, older, ...history], true, ['older'])));
	assert.equal(rowTime().textContent, '7 с');
	assert.deepEqual(progress(), ['70', '70'], 'более новый запуск, завершившийся позже старта команды, не меняет её шкалу');
	assert.equal(play().disabled, true);
	now += 40000;
	await React.act(async () => tick!());
	assert.deepEqual(progress(), ['100', '100']);
	assert.equal(rowTime().textContent, '47 с');
	assert.equal(document.querySelector<HTMLElement>('.pm-bs-history li:last-child .pm-bs-bar')!.style.width, '100%');
	await React.act(async () => root.render(scriptRow([finished, older], true, [])));
	assert.equal(stop.mock.callCount(), 1);
	assert.equal(play().disabled, false);
	assert.equal(play().querySelector('.pm-qn-spin'), null);
	assert.equal(rowTime().getAttribute('data-outcome'), 'error');
	assert.equal(rowTime().textContent, '6 с');
	assert.equal(document.querySelector('.pm-bs-history li:last-child')?.getAttribute('data-outcome'), null);
	await React.act(async () => root.render(scriptRow([{ ...finished, exitCode: 0 }], true)));
	assert.equal(rowTime().getAttribute('data-outcome'), 'success');
});

/** Некорректные даты, нулевой масштаб и пустая история не создают мнимую полосу прогресса. */
test('Bash timeline handles invalid timestamps, empty history and a confirmed zero-duration run', () => {
	const start = '2026-02-01T10:00:00Z';
	const html = renderRow([
		{ id: 'bad-start', startedAt: 'bad timestamp', finishedAt: start, endedBy: 'shell' },
		{ id: 'bad-finish', startedAt: start, finishedAt: 'bad timestamp', exitCode: 0 },
		{ id: 'negative', startedAt: start, finishedAt: '2026-02-01T09:59:59Z', exitCode: 0 },
		{ id: 'instant', startedAt: start, finishedAt: start, exitCode: 0 },
	]);
	assert.equal((html.match(/class="pm-bs-unknown"/g) ?? []).length, 3);
	assert.equal((html.match(/class="pm-bs-bar"/g) ?? []).length, 1);
	assert.match(html, /class="pm-bs-bar" style="width:0%"/);
	assert.match(html, /0 мс/);
	assert.match(html, /Время запуска неизвестно/);
	assert.doesNotMatch(html, /NaN|Infinity|bad timestamp/);
	const empty = renderRow([]);
	assert.match(empty, /Запусков пока нет/);
	assert.doesNotMatch(empty, /class="pm-bs-track"/);
});
