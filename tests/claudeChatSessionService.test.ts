import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ClaudeChatSessionService, ClaudeChatSessionError } from '../src/services/claudeChatSessionService.js';
import type { ClaudeChatSdkAdapter, ClaudeChatSessionBinding, ClaudeChatSessionInfo } from '../src/types/claudeChat.js';
import { createClaudeChatLaunchMarker, encodeClaudeChatProjectPath } from '../src/utils/claudeChat.js';

/** Все записи принадлежат исключительно синтетической тестовой сессии. */
const SESSION = '20000000-0000-0000-0000-000000000000';
const OTHER = '30000000-0000-0000-0000-000000000000';
const USER = '40000000-0000-0000-0000-000000000000';
const END = '50000000-0000-0000-0000-000000000000';
const BASE = Date.parse('2026-10-12T12:00:00.000Z');
const MARKER = createClaudeChatLaunchMarker(SESSION);

/** Ресурсы одной проверки не разделяются с другими тестами и реальной установкой Claude. */
interface Fixture {
	/** Все пути находятся в собственной подпапке /tmp/kilo. */
	root: string;
	configDir: string;
	project: string;
	directory: string;
	file: string;
	/** Привязка содержит только фиктивный UUID. */
	binding: ClaudeChatSessionBinding;
}

/** Создаёт только изолированные файловые данные и удаляет именно возвращённый mkdtemp каталог. */
async function withFixture(action: (fixture: Fixture) => Promise<void>, projectDirName?: string): Promise<void> {
	const root = await mkdtemp('/tmp/kilo/claude-chat-testing-');
	try {
		const configDir = join(root, 'config');
		const project = join(root, 'project');
		const directory = join(configDir, 'projects', projectDirName ?? encodeClaudeChatProjectPath(project));
		await mkdir(directory, { recursive: true });
		await mkdir(project);
		await action({ root, configDir, project, directory, file: join(directory, `${SESSION}.jsonl`),
			binding: { sessionId: SESSION, projectPath: project, accountedMs: 0 } });
	} finally {
		assert.ok(root.startsWith('/tmp/kilo/claude-chat-testing-'));
		await rm(root, { recursive: true, force: true });
	}
}

/** Генерирует сообщения без обращения к установленному CLI, настройкам и учётным записям. */
function transcript(project: string, sessionId = SESSION, extra: Record<string, unknown> = {}): string {
	return [
		{ type: 'user', uuid: USER, parentUuid: null, sessionId, cwd: project,
			timestamp: new Date(BASE + 1_000).toISOString(), message: { role: 'user', content: `${MARKER}\nТест` }, ...extra },
		{ type: 'system', subtype: 'turn_duration', uuid: END, parentUuid: USER, sessionId,
			timestamp: new Date(BASE + 3_000).toISOString(), durationMs: 1_200 },
	].map(record => JSON.stringify(record)).join('\n') + '\n';
}

/** Подмена SDK хранит только заданные метаданные; незаявленные мутации тест сразу отклоняет. */
function adapter(sessions: ClaudeChatSessionInfo[] = []): ClaudeChatSdkAdapter {
	return {
		/** Возвращает заранее известный список вместо чтения настоящего ~/.claude. */
		listSessions: async () => sessions,
		/** Проверки чтения не должны случайно переименовывать даже тестовые данные. */
		renameSession: async () => { throw new Error('Непредусмотренное переименование'); },
	};
}

/** Сопоставляет машинный код безопасной диагностики, не читая исходный текст transcript. */
function code(expected: ClaudeChatSessionError['code']): (error: unknown) => boolean {
	return error => error instanceof ClaudeChatSessionError && error.code === expected;
}

/** Чтение ограничено конкретным UUID; изменение stat отменяет кэш, копия результата не меняет кэш. */
test('Claude session reader refreshes changed metadata and isolates returned snapshots', async () => {
	await withFixture(async fixture => {
		const service = new ClaudeChatSessionService({ configDir: fixture.configDir }, adapter());
		try {
			assert.equal(await service.readSession(fixture.binding), undefined);
			await writeFile(fixture.file, transcript(fixture.project));
			const first = await service.readSession(fixture.binding);
			assert.equal(first?.totalElapsedMs, 1_200);
			first!.totalElapsedMs = 999;
			assert.equal((await service.readSession(fixture.binding))?.totalElapsedMs, 1_200);
			await appendFile(fixture.file, JSON.stringify({ type: 'custom-title', sessionId: SESSION, customTitle: 'Новое имя' }) + '\n');
			assert.equal((await service.readSession(fixture.binding))?.customTitle, 'Новое имя');
			await appendFile(fixture.file, '{"type":"user"');
			assert.equal((await service.readSession(fixture.binding))?.completed, false);
		} finally { service.dispose(); }
	});
});

/** Метаданные SDK недостаточны: подтверждается маркер, дата и cwd внутри именно найденного transcript. */
test('Claude discovery requires a unique new exact marker and rejects ambiguity', async () => {
	await withFixture(async fixture => {
		const sessions = [{ sessionId: SESSION, firstPrompt: `${MARKER} Тест` }];
		const service = new ClaudeChatSessionService({ configDir: fixture.configDir }, adapter(sessions));
		const pending = { marker: MARKER, startedAt: BASE, projectPaths: [fixture.project] };
		try {
			await writeFile(fixture.file, transcript(fixture.project));
			assert.deepEqual(await service.findSession(pending), fixture.binding);
			assert.equal(await service.findSession({ ...pending, startedAt: BASE + 2_000 }), undefined);
			sessions.push({ sessionId: OTHER, firstPrompt: `${MARKER} Тест` });
			await writeFile(join(fixture.directory, `${OTHER}.jsonl`), transcript(fixture.project, OTHER));
			await assert.rejects(service.findSession(pending), code('ambiguous-session'));
			await writeFile(join(fixture.directory, `${OTHER}.jsonl`), transcript(fixture.project, OTHER,
				{ forkedFrom: { sessionId: SESSION, messageUuid: USER } }));
			assert.deepEqual(await service.findSession(pending), fixture.binding);
		} finally { service.dispose(); }
	});
});

/** Поиск не принимает совпавший summary, вложенную цитату, чужой cwd или подменённый sessionId. */
test('Claude discovery verifies transcript identity rather than trusting SDK metadata', async () => {
	await withFixture(async fixture => {
		const sessions = [{ sessionId: SESSION, firstPrompt: `Цитата ${MARKER}` }];
		const service = new ClaudeChatSessionService({ configDir: fixture.configDir }, adapter(sessions));
		const pending = { marker: MARKER, startedAt: BASE, projectPaths: [fixture.project] };
		try {
			await writeFile(fixture.file, transcript(fixture.project));
			assert.equal(await service.findSession(pending), undefined);
			sessions[0].firstPrompt = MARKER;
			await writeFile(fixture.file, transcript(join(fixture.root, 'other-project')));
			assert.equal(await service.findSession(pending), undefined);
			await writeFile(fixture.file, transcript(fixture.project, OTHER));
			await assert.rejects(service.findSession(pending), code('unsafe-path'));
		} finally { service.dispose(); }
	});
});

/** Reopen и rename проверяют существование независимо от неподдержанной компактации длительностей. */
test('Claude existence and SDK-only rename remain available when timing is unsupported', async () => {
	await withFixture(async fixture => {
		const renamed: unknown[][] = [];
		const sdk = adapter();
		// Подмена только фиксирует штатный вызов; сервис не должен самостоятельно записать custom-title.
		sdk.renameSession = async (...args) => { renamed.push(args); };
		const service = new ClaudeChatSessionService({ configDir: fixture.configDir }, sdk);
		try {
			const original = transcript(fixture.project) + JSON.stringify({ type: 'system', subtype: 'compact_boundary' }) + '\n';
			await writeFile(fixture.file, original);
			await assert.rejects(service.readSession(fixture.binding), code('unsupported-transcript'));
			assert.equal(await service.hasSession(fixture.binding), true);
			await service.renameSession(fixture.binding, '  Проверенное имя  ');
			assert.deepEqual(renamed, [[SESSION, 'Проверенное имя', { dir: fixture.project }]]);
			assert.equal(await readFile(fixture.file, 'utf8'), original);
		} finally { service.dispose(); }
	});
});

/** Ни ссылка файла, ни ссылка каталога проекта не даёт читать данные за пределами выбранного scope. */
test('Claude reader refuses symlink escapes, traversal and invalid configuration', async () => {
	await withFixture(async fixture => {
		const outside = join(fixture.root, 'outside.jsonl');
		await writeFile(outside, transcript(fixture.project));
		const service = new ClaudeChatSessionService({ configDir: fixture.configDir }, adapter());
		try {
			await symlink(outside, fixture.file);
			await assert.rejects(service.readSession(fixture.binding), code('unsafe-path'));
			await rm(fixture.file);
			await rm(fixture.directory, { recursive: true });
			await symlink(fixture.root, fixture.directory, 'dir');
			await assert.rejects(service.hasSession(fixture.binding), code('unsafe-path'));
			await assert.rejects(service.readSession({ ...fixture.binding, sessionId: '../outside' }), code('invalid-state'));
			await assert.rejects(service.readSession({ ...fixture.binding, projectPath: '/testing/../outside' }), code('invalid-state'));
			assert.throws(() => new ClaudeChatSessionService({ configDir: fixture.configDir, projectDirName: '../outside' }), code('invalid-state'));
		} finally { service.dispose(); }
	});
});

/** Явное имя проекта меняет только каталог хранения, не cwd и не глобальное окружение. */
test('Claude reader supports configured project directory names and disposal', async () => {
	await withFixture(async fixture => {
		const service = new ClaudeChatSessionService({ configDir: fixture.configDir, projectDirName: 'testing-scope' }, adapter());
		try {
			await writeFile(fixture.file, transcript(fixture.project));
			assert.equal((await service.readSession(fixture.binding))?.totalElapsedMs, 1_200);
		} finally { service.dispose(); }
		await assert.rejects(service.hasSession(fixture.binding), code('disposed'));
	}, 'testing-scope');
});

/** Ограниченный наблюдатель замечает создание storage без polling и закрывается раньше удаления fixture. */
test('Claude watchers observe new directories and transcript writes without polling', async () => {
	await withFixture(async fixture => {
		await rm(fixture.directory, { recursive: true });
		const service = new ClaudeChatSessionService({ configDir: fixture.configDir }, adapter());
		let next: ((error?: Error) => void) | undefined;
		/** Одна проверка ждёт только настоящее событие и имеет собственный ограниченный таймаут. */
		const event = (action?: () => Promise<void>): Promise<void> => new Promise((resolve, reject) => {
			const timer = setTimeout(() => { next = undefined; reject(new Error('Нет ожидаемого события watcher')); }, 5_000);
			next = error => { clearTimeout(timer); next = undefined; if (error) reject(error); else resolve(); };
			if (action) void action().catch(error => { clearTimeout(timer); next = undefined; reject(error); });
		});
		const ready = event();
		const subscription = service.watch([fixture.project], error => next?.(error));
		try {
			await ready;
			await event(() => mkdir(fixture.directory));
			await event(() => writeFile(fixture.file, transcript(fixture.project)));
			assert.equal(await service.hasSession(fixture.binding), true);
			// Меняем inode за один debounce, затем проверяем самостоятельное событие нового каталога.
			await event(async () => {
				await rename(fixture.directory, `${fixture.directory}-old`);
				await mkdir(fixture.directory);
			});
			await event(() => writeFile(fixture.file, transcript(fixture.project)));
			assert.equal(await service.hasSession(fixture.binding), true);
		} finally { subscription.dispose(); service.dispose(); }
	});
});

/** Реальный публичный SDK работает только с fixture; worker не наследует scope соседнего экземпляра сервиса. */
test('Claude SDK worker reads and renames synthetic data without mutating process environment', async () => {
	await withFixture(async fixture => {
		const before = process.env.CLAUDE_CONFIG_DIR;
		const beforeName = process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
		const service = new ClaudeChatSessionService({ configDir: fixture.configDir, projectDirName: 'testing-sdk' });
		try {
			await writeFile(fixture.file, transcript(fixture.project));
			const found = await service.findSession({ marker: MARKER, startedAt: BASE, projectPaths: [fixture.project] });
			assert.deepEqual(found, fixture.binding);
			await service.renameSession(fixture.binding, 'SDK fixture title');
			assert.equal((await service.readSession(fixture.binding))?.customTitle, 'SDK fixture title');
			assert.equal(process.env.CLAUDE_CONFIG_DIR, before);
			assert.equal(process.env.CLAUDE_CODE_PROJECT_DIR_NAME, beforeName);
		} finally { service.dispose(); }
	}, 'testing-sdk');
});
