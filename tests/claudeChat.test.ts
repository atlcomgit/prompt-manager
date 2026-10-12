import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ClaudeChatSessionError, ClaudeChatTranscriptAccumulator, createClaudeChatLaunchMarker,
	encodeClaudeChatProjectPath, hasClaudeChatLaunchMarker, normalizeClaudeChatState,
} from '../src/utils/claudeChat.js';

/** Синтетические UUID и даты не связаны с пользовательскими сессиями. */
const SESSION = '10000000-0000-0000-0000-000000000000';
const BASE = Date.parse('2026-10-12T12:00:00.000Z');

/** Создаёт детерминированный UUID только для графа тестовой переписки. */
function uuid(index: number): string {
	return `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
}

/** Собирает минимальную запись текущего формата без настоящих сообщений и ответов. */
function row(type: string, index: number, parent: number | null, extra: Record<string, unknown> = {}) {
	return {
		type, uuid: uuid(index), parentUuid: parent === null ? null : uuid(parent), sessionId: SESSION,
		timestamp: new Date(BASE + index * 1_000).toISOString(), cwd: '/testing/project',
		...(type === 'user' ? { message: { role: 'user', content: 'Тестовый запрос' } } : {}), ...extra,
	};
}

/** Заканчивает поток синтетических записей тем же чистым разбором, что используется сервисом. */
function analyze(rows: unknown[], incomplete = false) {
	const parser = new ClaudeChatTranscriptAccumulator(SESSION);
	for (const item of rows) parser.add(item);
	return parser.finish(incomplete);
}

/** Проверяет код ошибки, не связывая тест с текстом пользовательской диагностики. */
function unsupported(error: unknown): boolean {
	return error instanceof ClaudeChatSessionError && error.code === 'unsupported-transcript';
}

/** Маркер соответствует только полному началу нового запроса, а не цитате или совпавшему префиксу. */
test('Claude launch marker uses a complete UUID and exact first-text boundary', () => {
	const marker = createClaudeChatLaunchMarker(SESSION);
	assert.ok(marker.length < 200);
	assert.ok(hasClaudeChatLaunchMarker(`${marker}\nЗапрос`, marker));
	assert.ok(hasClaudeChatLaunchMarker(marker, marker));
	assert.equal(hasClaudeChatLaunchMarker(`Цитата ${marker}`, marker), false);
	assert.equal(hasClaudeChatLaunchMarker(`${marker}extra`, marker), false);
	assert.throws(() => createClaudeChatLaunchMarker('../session'));
});

/** Нормализация не обнуляет подтверждённое время и однократно обработанный момент завершения. */
test('Claude state normalizes duplicates without losing accounted time or completion handling', () => {
	const marker = createClaudeChatLaunchMarker(SESSION);
	assert.deepEqual(normalizeClaudeChatState({
		sessions: [
			{ sessionId: SESSION, projectPath: '/testing//project/', accountedMs: 300, completionHandledAt: 1_000 },
			{ sessionId: SESSION, projectPath: '/testing/project', accountedMs: 200 },
			{ sessionId: uuid(2), projectPath: '../escape', accountedMs: 5 },
			{ sessionId: uuid(3), projectPath: '/testing/project', accountedMs: NaN },
		],
		pendingLaunch: { marker, startedAt: BASE, projectPaths: ['/testing/project', '/testing/project/'] },
	}), {
		sessions: [{ sessionId: SESSION, projectPath: '/testing/project', accountedMs: 300, completionHandledAt: 1_000 }],
		pendingLaunch: { marker, startedAt: BASE, projectPaths: ['/testing/project'] },
	});
	assert.equal(normalizeClaudeChatState(null), undefined);
	assert.equal(normalizeClaudeChatState({ sessions: [], copilotAccountedMs: 1_200 })?.copilotAccountedMs, 1_200);
	assert.equal(normalizeClaudeChatState({ sessions: [], copilotAccountedMs: -1 })?.copilotAccountedMs, undefined);
	assert.deepEqual(normalizeClaudeChatState({ sessions: [], pendingLaunch: { marker: 'random' } }), { sessions: [] });
});

/** Один UUID в разных scope нельзя молча выбрать или начислить дважды. */
test('Claude state rejects conflicting project bindings and unsafe pending paths', () => {
	assert.deepEqual(normalizeClaudeChatState({ sessions: [
		{ sessionId: SESSION, projectPath: '/testing/first', accountedMs: 1 },
		{ sessionId: SESSION, projectPath: '/testing/second', accountedMs: 1 },
	], pendingLaunch: { marker: createClaudeChatLaunchMarker(SESSION), startedAt: -1, projectPaths: ['/testing/../outside'] } }),
	{ sessions: [] });
});

/** Длинное имя хранит префикс cwd и штатный 31-based hash, а не случайный slug. */
test('Claude project encoding follows the installed CLI long-path contract', () => {
	assert.equal(encodeClaudeChatProjectPath('/home/test/my_repo'), '-home-test-my-repo');
	const project = `/${'a'.repeat(210)}`;
	let hash = 0;
	for (const character of project) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
	assert.equal(encodeClaudeChatProjectPath(project), `${'-' + 'a'.repeat(199)}-${Math.abs(hash).toString(36)}`);
});

/** Tool results и параллельные блоки assistant не создают дополнительных пользовательских запросов. */
test('Claude transcript sums final durations on the main user ancestry', () => {
	const result = analyze([
		row('user', 1, null), row('assistant', 2, 1),
		row('user', 3, 2, { message: { content: [{ type: 'tool_result', content: 'Синтетический результат' }] } }),
		row('assistant', 4, 3), row('system', 5, 4, { subtype: 'turn_duration', durationMs: 2_500 }),
		row('user', 6, 4), row('assistant', 7, 6),
		row('system', 8, 7, { subtype: 'turn_duration', durationMs: 1_000 }),
		{ type: 'custom-title', sessionId: SESSION, customTitle: 'Тестовая сессия' },
	]);
	assert.deepEqual(result.snapshot, {
		totalElapsedMs: 3_500, completed: true, lastRequestStarted: BASE + 6_000,
		lastRequestEnded: BASE + 8_000, customTitle: 'Тестовая сессия',
	});
});

/** Финальный PCr-интервал уже включает ожидание фоновых работ, промежуточные значения не складываются. */
test('Claude transcript replaces pending background durations with the single terminal interval', () => {
	const start = [row('user', 1, null), row('assistant', 2, 1),
		row('system', 3, 2, { subtype: 'turn_duration', durationMs: 1_000, pendingBackgroundAgentCount: 1 }),
		row('system', 4, 2, { subtype: 'turn_duration', durationMs: 2_000, pendingWorkflowCount: 1 })];
	assert.equal(analyze(start).snapshot.totalElapsedMs, 0);
	assert.equal(analyze(start).snapshot.completed, false);
	const end = row('system', 8, 2, { subtype: 'turn_duration', durationMs: 6_000 });
	assert.equal(analyze([...start, end, end]).snapshot.totalElapsedMs, 6_000);
	assert.equal(analyze([...start, end], true).snapshot.completed, false);
});

/** Текущий незавершённый запрос не отменяет точные интервалы уже завершённых запросов. */
test('Claude transcript preserves finished time while the next request is running', () => {
	const result = analyze([row('user', 1, null), row('assistant', 2, 1),
		row('system', 3, 2, { subtype: 'turn_duration', durationMs: 500 }), row('user', 4, 2)]);
	assert.deepEqual(result.snapshot, { totalElapsedMs: 500, completed: false, lastRequestStarted: BASE + 4_000 });
});

/** Длительность не угадывается при повреждении цепочки, нескольких финалах или незавершённом прошлом запросе. */
test('Claude transcript reports unsupported ambiguous or incomplete timing histories', () => {
	const cases = [
		[row('user', 1, null), row('user', 2, null)],
		[row('user', 1, null), row('user', 2, 1)],
		[row('user', 1, null), row('system', 3, 9, { subtype: 'turn_duration', durationMs: 1 })],
		[row('user', 1, null), row('system', 3, 1, { subtype: 'turn_duration', durationMs: 1 }),
			row('system', 4, 1, { subtype: 'turn_duration', durationMs: 2 })],
		[row('user', 1, null), row('system', 3, 1, { subtype: 'turn_duration', durationMs: 1 }),
			row('assistant', 4, 1)],
		[row('user', 1, null), row('system', 3, 1, { subtype: 'turn_duration', duration_ms: 1 })],
		[row('user', 1, null), row('system', 2, 1, { subtype: 'compact_boundary' })],
		[row('user', 1, null), row('user', 2, 1, { isMeta: true }),
			row('system', 3, 2, { subtype: 'turn_duration', durationMs: 1 })],
		[row('user', 1, null), row('attachment', 2, 1, { attachment: { type: 'queued_command' } })],
	];
	for (const rows of cases) assert.throws(() => analyze(rows), unsupported);
});

/** Fork и sidechain никогда не подтверждают новый самостоятельный запуск с тем же текстовым маркером. */
test('Claude transcript rejects forks and isolated subagent transcripts', () => {
	for (const extra of [{ forkedFrom: { sessionId: uuid(9) } }, { isSidechain: true }, { teamName: 'testing' }]) {
		assert.throws(() => analyze([row('user', 1, null, extra)]),
			(error: unknown) => error instanceof ClaudeChatSessionError && error.code === 'not-main-session');
	}
	assert.throws(() => analyze([row('user', 1, null, { sessionId: uuid(9) })]),
		(error: unknown) => error instanceof ClaudeChatSessionError && error.code === 'unsafe-path');
});
