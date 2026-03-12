import test from 'node:test';
import assert from 'node:assert/strict';

import { buildKnowledgeGraphData, inferLayerFromPath } from '../src/utils/knowledgeGraph.js';
import type { RawKnowledgeGraphCommitFile, RawKnowledgeGraphRecord } from '../src/utils/knowledgeGraph.js';

test('inferLayerFromPath maps common project folders to architecture layers', () => {
	assert.equal(inferLayerFromPath('src/controllers/promptController.ts'), 'controller');
	assert.equal(inferLayerFromPath('src/services/promptService.ts'), 'service');
	assert.equal(inferLayerFromPath('src/shared/helpers/slug.ts'), 'util');
	assert.equal(inferLayerFromPath('README.md'), 'other');
});

test('buildKnowledgeGraphData builds layered file and component graph with summary metadata', () => {
	const rows: RawKnowledgeGraphRecord[] = [
		{
			sourceComponent: 'PromptController',
			targetComponent: 'PromptService',
			relationType: 'calls',
			commitSha: 'c1',
			repository: 'prompt-manager',
			commitDate: '2026-03-12T10:00:00.000Z',
			sourceKind: 'component',
			targetKind: 'component',
			sourceLayer: 'controller',
			targetLayer: 'service',
			sourceFilePath: 'src/controllers/promptController.ts',
			targetFilePath: 'src/services/promptService.ts',
			relationStrength: 8,
			architectureImpactScore: 6,
			analysisCategories: ['backend', 'api'],
			analysisBusinessDomains: ['prompts'],
			isBreakingChange: true,
		},
		{
			sourceComponent: 'PromptController',
			targetComponent: 'PromptService',
			relationType: 'calls',
			commitSha: 'c2',
			repository: 'prompt-manager',
			commitDate: '2026-03-13T12:00:00.000Z',
			sourceKind: 'component',
			targetKind: 'component',
			sourceLayer: 'controller',
			targetLayer: 'service',
			sourceFilePath: 'src/controllers/promptController.ts',
			targetFilePath: 'src/services/promptService.ts',
			relationStrength: 4,
			architectureImpactScore: 3,
			analysisCategories: ['backend'],
			analysisBusinessDomains: ['prompts'],
			isBreakingChange: false,
		},
	];
	const commitFiles: RawKnowledgeGraphCommitFile[] = [
		{ commitSha: 'c1', repository: 'prompt-manager', filePath: 'src/controllers/promptController.ts' },
		{ commitSha: 'c1', repository: 'prompt-manager', filePath: 'src/services/promptService.ts' },
		{ commitSha: 'c2', repository: 'prompt-manager', filePath: 'src/controllers/promptController.ts' },
		{ commitSha: 'c2', repository: 'prompt-manager', filePath: 'src/services/promptService.ts' },
	];

	const graph = buildKnowledgeGraphData(rows, commitFiles);

	assert.equal(graph.nodes.length, 6);
	assert.equal(graph.edges.length, 5);
	assert.deepEqual(graph.summary.nodeCounts, {
		layer: 2,
		file: 2,
		component: 2,
	});
	assert.deepEqual(graph.summary.layers, ['controller', 'service']);
	assert.deepEqual(graph.summary.relationTypes, ['calls', 'contains', 'implements']);
	assert.deepEqual(graph.summary.repositories, ['prompt-manager']);

	const controllerNode = graph.nodes.find((node) => node.id === 'component:prompt-manager:PromptController');
	assert.ok(controllerNode);
	assert.equal(controllerNode.commitCount, 2);
	assert.equal(controllerNode.impactScore, 9);
	assert.equal(controllerNode.breakingChangeCount, 1);
	assert.deepEqual(controllerNode.businessDomains, ['prompts']);
	assert.deepEqual(controllerNode.categories, ['api', 'backend']);
	assert.deepEqual(controllerNode.relatedFiles, ['src/controllers/promptController.ts']);

	const callsEdge = graph.edges.find((edge) => edge.id === 'component:prompt-manager:PromptController=>component:prompt-manager:PromptService:calls');
	assert.ok(callsEdge);
	assert.equal(callsEdge.weight, 2);
	assert.equal(callsEdge.commitCount, 2);
	assert.equal(callsEdge.strength, 6);
	assert.deepEqual(callsEdge.layers, ['controller', 'service']);
	assert.deepEqual(callsEdge.repositories, ['prompt-manager']);
	assert.deepEqual(callsEdge.relatedFiles, ['src/controllers/promptController.ts', 'src/services/promptService.ts']);

	const fileToComponentEdge = graph.edges.find((edge) => edge.id === 'file:prompt-manager:src/controllers/promptController.ts=>component:prompt-manager:PromptController:implements');
	assert.ok(fileToComponentEdge);
	assert.equal(fileToComponentEdge.weight, 2);

	const layerToFileEdge = graph.edges.find((edge) => edge.id === 'layer:prompt-manager:controller=>file:prompt-manager:src/controllers/promptController.ts:contains');
	assert.ok(layerToFileEdge);
	assert.equal(layerToFileEdge.weight, 2);
	assert.equal(graph.summary.maxEdgeWeight, 2);
	assert.equal(graph.summary.maxNodeWeight, 4);
	assert.equal(graph.summary.totalImpact, 54);
});

test('buildKnowledgeGraphData respects explicit file-kind nodes without creating duplicate components', () => {
	const rows: RawKnowledgeGraphRecord[] = [
		{
			sourceComponent: 'src/webview/memory/MemoryApp.tsx',
			targetComponent: 'KnowledgeGraph',
			relationType: 'imports',
			commitSha: 'c3',
			repository: 'prompt-manager',
			commitDate: '2026-03-14T08:00:00.000Z',
			sourceKind: 'file',
			targetKind: 'component',
			sourceLayer: 'view',
			targetLayer: 'component',
			sourceFilePath: 'src/webview/memory/MemoryApp.tsx',
			targetFilePath: 'src/webview/memory/components/KnowledgeGraph.tsx',
			relationStrength: 7,
			analysisCategories: ['frontend'],
		},
	];

	const graph = buildKnowledgeGraphData(rows, []);

	assert.ok(graph.nodes.some((node) => node.id === 'file:prompt-manager:src/webview/memory/MemoryApp.tsx'));
	assert.ok(!graph.nodes.some((node) => node.id === 'component:prompt-manager:src/webview/memory/MemoryApp.tsx'));
	assert.ok(graph.edges.some((edge) => edge.id === 'file:prompt-manager:src/webview/memory/MemoryApp.tsx=>component:prompt-manager:KnowledgeGraph:imports'));
	assert.deepEqual(graph.summary.nodeCounts, {
		layer: 2,
		file: 2,
		component: 1,
	});
	assert.equal(graph.summary.totalImpact, 0);
	assert.deepEqual(graph.summary.relationTypes, ['contains', 'implements', 'imports']);
	assert.equal(graph.edges.find((edge) => edge.type === 'imports')?.strength, 7);
	assert.equal(graph.edges.find((edge) => edge.type === 'imports')?.weight, 1);
	assert.equal(graph.nodes.find((node) => node.id === 'component:prompt-manager:KnowledgeGraph')?.filePath, 'src/webview/memory/components/KnowledgeGraph.tsx');
	assert.deepEqual(graph.nodes.find((node) => node.id === 'component:prompt-manager:KnowledgeGraph')?.relatedFiles, ['src/webview/memory/components/KnowledgeGraph.tsx']);
	assert.deepEqual(graph.nodes.find((node) => node.id === 'component:prompt-manager:KnowledgeGraph')?.categories, ['frontend']);
});