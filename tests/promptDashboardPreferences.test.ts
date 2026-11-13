import test from 'node:test';
import assert from 'node:assert/strict';
import {
	normalizePromptDashboardDockerWidgetState,
	normalizePromptDashboardPreferences,
	normalizePromptDashboardTodosWidgetState,
} from '../src/types/promptDashboardPreferences.js';

/** Повреждённые значения не становятся настройками или унаследованными флагами. */
test('dashboard preferences reject malformed and inherited settings', () => {
	const defaults = normalizePromptDashboardPreferences(undefined);
	for (const value of [null, false, 42, 'settings', [], Object.create({ showAllBranchProjects: true })]) {
		assert.deepEqual(normalizePromptDashboardPreferences(value), defaults);
	}
	assert.deepEqual(normalizePromptDashboardDockerWidgetState({
		viewMode: 'invalid', statusFilter: true, sortBy: [], search: 12,
		expandedContainerIds: ['', '  ', false, 'container-a', 'container-a'],
	}), { statusFilter: 'all', search: '', sortBy: 'status', expandedContainerIds: ['container-a'] });
	assert.deepEqual(normalizePromptDashboardTodosWidgetState({
		selectedFileTypes: [' TS ', 'ts', 'PHP', false, {}, 42, ''], search: null,
	}), { selectedFileTypes: ['ts', 'php'], search: '' });
});

/** Явно закрытые узлы и пустые карты не заменяются прежними раскрытиями Docker. */
test('dashboard preferences keep false disclosures and explicit empty values', () => {
	const value = {
		docker: { viewMode: 'table', statusFilter: 'stopped', search: '', sortBy: 'memory',
			expandedContainerIds: ['docker:legacy'] },
		todos: { selectedFileTypes: [], search: '' },
		expanded: { 'project:api': false, 'branch:main': true },
		showAllBranchProjects: true,
	};
	assert.deepEqual(normalizePromptDashboardPreferences(value), value);
	assert.deepEqual(normalizePromptDashboardPreferences({ ...value, expanded: {} }).expanded, {});
	const normalized = normalizePromptDashboardPreferences(value);
	normalized.expanded['project:api'] = true;
	normalized.docker.expandedContainerIds.push('other');
	assert.equal(value.expanded['project:api'], false);
	assert.deepEqual(value.docker.expandedContainerIds, ['docker:legacy']);
});

/** JSON с прототипными ключами не меняет прототип результата и сохраняет безопасные записи. */
test('dashboard preferences ignore prototype keys and invalid disclosure flags', () => {
	const value = JSON.parse('{"expanded":{"__proto__":true,"constructor":false,"prototype":true,'
		+ '"project:api":false,"branch:main":true,"invalid":"true","":false}}');
	const normalized = normalizePromptDashboardPreferences(value);
	assert.deepEqual(normalized.expanded, { 'project:api': false, 'branch:main': true });
	assert.equal(Object.getPrototypeOf(normalized.expanded), Object.prototype);
	assert.equal(Object.hasOwn(normalized.expanded, '__proto__'), false);
});

/** Валидное большое состояние не обрезается произвольными лимитами нормализатора. */
test('dashboard preferences preserve all valid search text and disclosure keys', () => {
	const search = 'search '.repeat(2000);
	const expanded = Object.fromEntries(Array.from({ length: 1500 }, (_, index) => [`project:${index}`, false]));
	const normalized = normalizePromptDashboardPreferences({
		docker: { search, expandedContainerIds: Object.keys(expanded) },
		todos: { search }, expanded,
	});
	assert.equal(normalized.docker.search, search);
	assert.equal(normalized.todos.search, search);
	assert.deepEqual(normalized.expanded, expanded);
	assert.deepEqual(normalized.docker.expandedContainerIds, Object.keys(expanded));
});
