import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCodeMapRelationBlock, buildLegacyRelationsFromRelationBlock } from '../src/codemap/codeMapRelationBuilder.js';

test('buildCodeMapRelationBlock resolves imports, frontend links, and symbol refs', () => {
	const relationBlock = buildCodeMapRelationBlock({
		files: [
			'src/webview/pages/OrdersPage.vue',
			'src/webview/components/StatusSelect.vue',
			'src/services/orders.ts',
			'src/services/orderService.ts',
		],
		fileTexts: new Map([
			['src/webview/pages/OrdersPage.vue', `<template>
	<main>
		<StatusSelect />
	</main>
</template>
<script setup lang="ts">
import StatusSelect from '../components/StatusSelect.vue';
import { useOrdersStore } from '../../services/orders';
import { loadOrders } from '../../services/orderService';
</script>`],
			['src/services/orders.ts', 'export function useOrdersStore() { return {}; }'],
			['src/services/orderService.ts', 'export function loadOrders() { return []; }'],
		]),
		locale: 'ru',
		fileSummaries: [
			{
				path: 'src/webview/pages/OrdersPage.vue',
				lineCount: 10,
				description: '',
				role: 'frontend-компоненты и страницы интерфейса',
				imports: ['../components/StatusSelect.vue', '../../services/orders', '../../services/orderService'],
				frontendContract: [],
				frontendBlocks: [{
					kind: 'filters',
					name: 'OrdersFilters',
					line: 1,
					column: 1,
					description: 'Фильтры страницы заказов.',
					purpose: 'Управление фильтрами.',
					stateDeps: [],
					eventHandlers: [],
					dataSources: ['useOrdersStore'],
					childComponents: ['StatusSelect'],
					conditions: [],
					routes: [],
					forms: [],
				}],
				symbols: [],
			},
			{
				path: 'src/webview/components/StatusSelect.vue',
				lineCount: 5,
				description: '',
				role: 'frontend-компоненты и страницы интерфейса',
				imports: [],
				frontendContract: [],
				frontendBlocks: [],
				symbols: [{
					kind: 'component',
					name: 'StatusSelect',
					signature: 'StatusSelect()',
					line: 1,
					column: 1,
					description: 'Компонент выбора статуса.',
				}],
			},
			{
				path: 'src/services/orders.ts',
				lineCount: 4,
				description: '',
				role: 'сервисный слой',
				imports: [],
				frontendContract: [],
				frontendBlocks: [],
				symbols: [{
					kind: 'function',
					name: 'useOrdersStore',
					signature: 'useOrdersStore(): object',
					line: 1,
					column: 1,
					description: 'Возвращает store заказов.',
				}],
			},
			{
				path: 'src/services/orderService.ts',
				lineCount: 4,
				description: '',
				role: 'сервисный слой',
				imports: [],
				frontendContract: [],
				frontendBlocks: [],
				symbols: [{
					kind: 'function',
					name: 'loadOrders',
					signature: 'loadOrders(): array',
					line: 1,
					column: 1,
					description: 'Загружает список заказов.',
				}],
			},
		],
	});

	assert.ok(relationBlock.summary.some(item => /Разрешено \d+ межфайловых связей/.test(item)));
	assert.ok(relationBlock.architectureFlows.some(item => /webview -> services/.test(item)));
	assert.ok(relationBlock.fileLinks.some(edge => /src\/webview\/pages\/OrdersPage\.vue -> src\/webview\/components\/StatusSelect\.vue/.test(edge.label)));
	assert.ok(relationBlock.uiDataLinks.some(edge => /UI-компонент: StatusSelect/.test(edge.label)));
	assert.ok(relationBlock.uiDataLinks.some(edge => /источник данных: useOrdersStore/.test(edge.label)));
	assert.ok(relationBlock.symbolLinks.some(edge => /символ: useOrdersStore/.test(edge.label)));

	const legacyRelations = buildLegacyRelationsFromRelationBlock(relationBlock, true);
	assert.ok(legacyRelations.some(item => /StatusSelect/.test(item)));
	assert.ok(legacyRelations.some(item => /useOrdersStore/.test(item)));
});