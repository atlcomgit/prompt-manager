import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import type { BashScriptEntry, BashScriptsRequest } from '../src/types/bashScripts.js';

function script(id: string, projectRoot?: string, scope: BashScriptEntry['scope'] = 'project'): BashScriptEntry {
	const path = 'scripts/' + id + '.sh';
	return { id, scope, name: id, path, absolutePath: (projectRoot ?? '/outside') + '/' + path, available: true, history: [],
		project: projectRoot ? { root: projectRoot, name: 'Сервис', relativePath: path } : undefined };
}

test('project groups separate identical names, include global files by location and keep filtered counts', async () => {
	const { groupBashScripts, filterBashScripts } = await import('../src/webview/editor/components/bashScripts/BashScriptsWidget.js');
	const entries = [script('beta', '/two'), script('alpha', '/one', 'global'), script('third', '/one'), script('outside'), script('global', undefined, 'global')];
	const groups = groupBashScripts(filterBashScripts(entries, '', 'all', 'all'));
	assert.deepEqual(groups.map(group => [group.key, group.entries.map(entry => entry.id)]), [
		['project:/one', ['alpha', 'third']], ['project:/two', ['beta']], ['outside:project', ['outside']], ['outside:global', ['global']],
	]);
	assert.deepEqual(filterBashScripts(entries, ' СЕРВИС ', 'global', 'all'), [entries[1]]);
});

test('script groups remember clicks across mounts and reveal matches without overwriting the saved choice', async t => {
	const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
	GlobalRegistrator.register();
	const { act } = await import('react');
	const { createRoot } = await import('react-dom/client');
	const { Simulate } = await import('react-dom/test-utils');
	const { BashScriptsWidget } = await import('../src/webview/editor/components/bashScripts/BashScriptsWidget.js');
	const requests: BashScriptsRequest[] = [];
	let state: Record<string, unknown> = { unrelated: 'kept', bashScriptGroupChoices: { 'project:/two': false } };
	let preferences: Record<string, boolean> = {};
	const patches: Record<string, boolean>[] = [];
	Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
	Object.defineProperty(globalThis, 'acquireVsCodeApi', { configurable: true, value: () => ({
		postMessage: (message: BashScriptsRequest) => requests.push(message), getState: () => state,
		setState: (next: Record<string, unknown>) => { state = next; },
	}) });
	const root = createRoot(document.body.appendChild(document.createElement('div')));
	t.after(async () => {
		await act(async () => root.unmount());
		Reflect.deleteProperty(globalThis, 'acquireVsCodeApi');
		Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
		await GlobalRegistrator.unregister();
	});
	const entries = Array.from({ length: 11 }, (_, n) => script('check-' + n, n % 2 === 0 ? '/one' : '/two'));
	entries[0].name = entries[2].name = 'Сборка';
	const nestedPaths = ['ci/tools/build/a.sh', 'ci/tools/builder/a.sh', 'ci/tools/build/b.sh', 'ci/tools/main.sh', 'ci/tools/build/c.sh'];
	for (const [index, relativePath] of nestedPaths.entries()) {
		const entry = entries[index * 2 + 1];
		entry.project!.relativePath = entry.path = relativePath;
		entry.absolutePath = '/two/' + relativePath;
	}
	/** Настройки дашборда переживают полное пересоздание панели и её локальной памяти. */
	function Dashboard() {
		const [expanded, setExpanded] = React.useState(preferences);
		return <BashScriptsWidget collapsed={false} onToggleCollapse={() => {}} expandedGroups={expanded}
			onGroupChoicesChange={patch => {
				patches.push(patch);
				preferences = { ...preferences, ...patch };
				setExpanded(preferences);
			}} renderShell={(actions, body) => <section>{actions}{body}</section>} />;
	}
	const mount = async () => {
		await act(async () => root.render(<Dashboard />));
		await act(async () => { window.dispatchEvent(new MessageEvent('message', { data: {
			type: 'bashScriptsResponse', requestId: requests.at(-1)!.requestId, result: { entries },
		} })); });
	};
	const button = (label: string) => document.querySelector<HTMLButtonElement>('button[aria-label="' + label + '"]')!;
	const click = (label: string) => act(async () => { button(label).click(); });
	const search = (query: string) => act(async () => {
		const field = document.querySelector<HTMLInputElement>('[name=bashScriptSearch]')!;
		field.value = query;
		Simulate.change(field);
	});
	await mount();
	assert.equal(document.querySelectorAll('.pm-bs-group').length, 2);
	assert.equal(document.querySelectorAll('.pm-bs-entry').length, 0);
	assert.equal(patches.length, 0);
	await click('Сервис · /one');
	assert.deepEqual(Object.values(preferences).sort(), [false, true]);
	assert.ok(Object.keys(preferences).every(key => /^bashScripts:[a-f0-9]+$/.test(key)));
	assert.equal(document.querySelectorAll('.pm-bs-entry').length, 6);
	const sameNames = Array.from(document.querySelectorAll('.pm-bs-details')).filter(row => row.querySelector('.pm-bs-name')?.textContent === 'Сборка');
	assert.deepEqual(sameNames.map(row => row.querySelector('.pm-bs-path-hint')?.textContent).sort(), ['check-0.sh', 'check-2.sh']);
	assert.equal(document.querySelector('.pm-bs-folder'), null);
	const history = button('История запусков Сборка');
	await act(async () => { history.click(); });
	const detail = document.getElementById(history.getAttribute('aria-controls')!);
	assert.equal(history.closest('li')?.querySelector('.pm-bs-path-hint')?.getAttribute('title'), entries[0].absolutePath);
	assert.ok(!detail?.textContent?.includes(entries[0].absolutePath));
	assert.match(detail?.textContent ?? '', /Запусков пока нет/);
	const searchButton = button('Поиск и фильтры скриптов');
	searchButton.focus();
	const focus = t.mock.method(document, 'hasFocus', () => false);
	await click('Поиск и фильтры скриптов');
	assert.equal(document.activeElement, searchButton, 'Фоновая панель не переводит фокус в поле');
	await click('Поиск и фильтры скриптов');
	focus.mock.mockImplementation(() => true);
	await click('Поиск и фильтры скриптов');
	assert.equal(document.activeElement, document.querySelector('[name=bashScriptSearch]'));
	await search('/two/ci/tools');
	assert.deepEqual(Array.from(document.querySelectorAll('.pm-bs-folder-title'), title => title.textContent), ['build', 'builder', 'ci/tools']);
	assert.deepEqual(Array.from(document.querySelectorAll('ul[aria-label="ci/tools/build"] .pm-bs-path-hint'), hint => hint.textContent), ['a.sh', 'b.sh', 'c.sh']);
	assert.equal(document.querySelector('ul[aria-label="ci/tools/main.sh"]'), null);
	assert.equal(document.querySelector('.pm-bs-path-hint[title="/two/ci/tools/main.sh"]')?.textContent, 'main.sh');
	await search('/two/ci/tools/main.sh');
	assert.equal(document.querySelector('.pm-bs-folder-title')?.textContent, 'ci/tools');
	assert.equal(document.querySelector('ul[aria-label="ci/tools"] .pm-bs-path-hint')?.textContent, 'main.sh');
	await search('/two/ci/tools/builder/a.sh');
	assert.equal(document.querySelector('.pm-bs-folder-title')?.textContent, 'builder');
	assert.equal(document.querySelector('.pm-bs-path-hint')?.getAttribute('title'), '/two/ci/tools/builder/a.sh');
	await search('Сервис');
	assert.equal(document.querySelectorAll('.pm-bs-entry').length, 11);
	await click('Сервис · /one');
	assert.equal(document.querySelectorAll('.pm-bs-entry').length, 5);
	await search('');
	assert.equal(document.querySelectorAll('.pm-bs-entry').length, 6);
	assert.equal(patches.length, 1);
	await act(async () => root.render(null));
	state = { unrelated: 'kept' };
	await mount();
	assert.equal(button('Сервис · /one').getAttribute('aria-expanded'), 'true');
	assert.equal(button('Сервис · /two').getAttribute('aria-expanded'), 'false');
	await click('Свернуть все группы');
	assert.equal(document.querySelectorAll('.pm-bs-entry').length, 0);
	await click('Раскрыть все группы');
	assert.equal(document.querySelectorAll('.pm-bs-entry').length, 11);
	assert.equal(state.unrelated, 'kept');
});
