import type {
	KnowledgeGraphData,
	KnowledgeGraphEdge,
	KnowledgeGraphLayer,
	KnowledgeGraphNode,
	KnowledgeGraphNodeKind,
	MemoryCategory,
	MemoryLayer,
} from '../types/memory.js';

export interface RawKnowledgeGraphRecord {
	sourceComponent: string;
	targetComponent: string;
	relationType: string;
	commitSha: string;
	repository: string;
	commitDate?: string;
	sourceKind?: string;
	targetKind?: string;
	sourceLayer?: string;
	targetLayer?: string;
	sourceFilePath?: string;
	targetFilePath?: string;
	relationStrength?: number;
	confidence?: number;
	architectureImpactScore?: number;
	analysisLayers?: string[];
	analysisCategories?: string[];
	analysisBusinessDomains?: string[];
	analysisComponents?: string[];
	isBreakingChange?: boolean;
}

export interface RawKnowledgeGraphCommitFile {
	commitSha: string;
	repository: string;
	filePath: string;
}

interface EndpointMeta {
	primaryId: string;
	kind: KnowledgeGraphNodeKind;
	label: string;
	layer: KnowledgeGraphLayer;
	filePath?: string;
	relatedFiles: string[];
}

interface NodeAccumulator {
	node: KnowledgeGraphNode;
	commitShas: Set<string>;
	businessDomains: Set<string>;
	categories: Set<MemoryCategory>;
	relatedFiles: Set<string>;
	relatedComponents: Set<string>;
	firstSeenAt?: string;
	lastSeenAt?: string;
}

interface EdgeAccumulator {
	edge: KnowledgeGraphEdge;
	commitShas: Set<string>;
	repositories: Set<string>;
	categories: Set<MemoryCategory>;
	layers: Set<KnowledgeGraphLayer>;
	relatedFiles: Set<string>;
	firstSeenAt?: string;
	lastSeenAt?: string;
	strengthTotal: number;
	strengthSamples: number;
}

const LAYER_ALIASES: Array<{ pattern: RegExp; layer: MemoryLayer }> = [
	{ pattern: /controller/i, layer: 'controller' },
	{ pattern: /service/i, layer: 'service' },
	{ pattern: /repositor/i, layer: 'repository' },
	{ pattern: /model|entity|schema/i, layer: 'model' },
	{ pattern: /middleware/i, layer: 'middleware' },
	{ pattern: /migrations?/i, layer: 'migration' },
	{ pattern: /config/i, layer: 'config' },
	{ pattern: /util|helper|shared/i, layer: 'util' },
	{ pattern: /view|screen|page/i, layer: 'view' },
	{ pattern: /component/i, layer: 'component' },
];

function normalizeKind(value?: string): KnowledgeGraphNodeKind {
	if (value === 'layer' || value === 'file' || value === 'component') {
		return value;
	}
	return 'component';
}

function normalizeCategory(value: string): MemoryCategory | null {
	const categories = new Set<MemoryCategory>([
		'frontend', 'backend', 'api', 'database', 'devops', 'documentation', 'tests', 'other',
	]);
	return categories.has(value as MemoryCategory) ? (value as MemoryCategory) : null;
}

export function normalizeLayer(value?: string): KnowledgeGraphLayer | undefined {
	if (!value) {
		return undefined;
	}
	if (value === 'mixed') {
		return 'mixed';
	}
	const layers = new Set<MemoryLayer>([
		'controller', 'service', 'repository', 'model', 'middleware',
		'migration', 'config', 'util', 'view', 'component', 'other',
	]);
	return layers.has(value as MemoryLayer) ? (value as MemoryLayer) : undefined;
}

export function inferLayerFromPath(filePath?: string): KnowledgeGraphLayer {
	if (!filePath) {
		return 'other';
	}
	for (const alias of LAYER_ALIASES) {
		if (alias.pattern.test(filePath)) {
			return alias.layer;
		}
	}
	return 'other';
}

function createEmptySummary(): KnowledgeGraphData['summary'] {
	return {
		nodeKinds: [],
		layers: [],
		relationTypes: [],
		repositories: [],
		maxNodeWeight: 0,
		maxEdgeWeight: 0,
		totalImpact: 0,
		nodeCounts: {
			layer: 0,
			file: 0,
			component: 0,
		},
	};
}

function shortenLabel(label: string): string {
	if (label.length <= 28) {
		return label;
	}
	return `${label.slice(0, 25)}...`;
}

function nodeId(kind: KnowledgeGraphNodeKind, repository: string, value: string): string {
	return `${kind}:${repository}:${value}`;
}

function edgeId(source: string, target: string, relation: string): string {
	return `${source}=>${target}:${relation}`;
}

function dateMin(current: string | undefined, next: string | undefined): string | undefined {
	if (!next) {
		return current;
	}
	if (!current || next < current) {
		return next;
	}
	return current;
}

function dateMax(current: string | undefined, next: string | undefined): string | undefined {
	if (!next) {
		return current;
	}
	if (!current || next > current) {
		return next;
	}
	return current;
}

function chooseCandidateFiles(componentName: string, files: string[]): string[] {
	if (files.length === 0) {
		return [];
	}
	const normalizedName = componentName.toLowerCase().replace(/[^a-z0-9]/g, '');
	const matched = files.filter(file => {
		const normalizedFile = file.toLowerCase().replace(/[^a-z0-9]/g, '');
		return normalizedName.length > 2 && normalizedFile.includes(normalizedName);
	});
	if (matched.length > 0) {
		return matched.slice(0, 2);
	}
	return files.slice(0, 1);
}

function ensureNode(
	map: Map<string, NodeAccumulator>,
	input: Pick<KnowledgeGraphNode, 'id' | 'label' | 'shortLabel' | 'kind' | 'type' | 'repository' | 'layer' | 'filePath' | 'group' | 'color'>,
): NodeAccumulator {
	const existing = map.get(input.id);
	if (existing) {
		return existing;
	}
	const next: NodeAccumulator = {
		node: {
			...input,
			weight: 0,
			val: 1,
			impactScore: 0,
			commitCount: 0,
			breakingChangeCount: 0,
			businessDomains: [],
			categories: [],
			relatedFiles: [],
			relatedComponents: [],
		},
		commitShas: new Set<string>(),
		businessDomains: new Set<string>(),
		categories: new Set<MemoryCategory>(),
		relatedFiles: new Set<string>(),
		relatedComponents: new Set<string>(),
	};
	map.set(input.id, next);
	return next;
}

function touchNode(
	acc: NodeAccumulator,
	row: RawKnowledgeGraphRecord,
	meta: { relatedFiles: string[]; relatedComponents: string[]; weight: number },
): void {
	acc.node.weight += meta.weight;
	acc.node.impactScore += row.architectureImpactScore ?? 0;
	acc.commitShas.add(row.commitSha);
	if (row.isBreakingChange) {
		acc.node.breakingChangeCount += 1;
	}
	for (const value of row.analysisBusinessDomains || []) {
		if (value) {
			acc.businessDomains.add(value);
		}
	}
	for (const value of row.analysisCategories || []) {
		const normalized = normalizeCategory(value);
		if (normalized) {
			acc.categories.add(normalized);
		}
	}
	for (const filePath of meta.relatedFiles) {
		if (filePath) {
			acc.relatedFiles.add(filePath);
		}
	}
	for (const component of meta.relatedComponents) {
		if (component) {
			acc.relatedComponents.add(component);
		}
	}
	acc.firstSeenAt = dateMin(acc.firstSeenAt, row.commitDate);
	acc.lastSeenAt = dateMax(acc.lastSeenAt, row.commitDate);
}

function ensureEdge(
	map: Map<string, EdgeAccumulator>,
	source: string,
	target: string,
	relation: string,
	color?: string,
): EdgeAccumulator {
	const id = edgeId(source, target, relation);
	const existing = map.get(id);
	if (existing) {
		return existing;
	}
	const next: EdgeAccumulator = {
		edge: {
			id,
			source,
			target,
			type: relation,
			weight: 0,
			strength: 0,
			commitCount: 0,
			directionality: 'directed',
			repositories: [],
			categories: [],
			layers: [],
			relatedFiles: [],
			color,
		},
		commitShas: new Set<string>(),
		repositories: new Set<string>(),
		categories: new Set<MemoryCategory>(),
		layers: new Set<KnowledgeGraphLayer>(),
		relatedFiles: new Set<string>(),
		strengthTotal: 0,
		strengthSamples: 0,
	};
	map.set(id, next);
	return next;
}

function touchEdge(
	acc: EdgeAccumulator,
	row: RawKnowledgeGraphRecord,
	meta: { relatedFiles: string[]; layers: KnowledgeGraphLayer[]; weight?: number; relation?: string },
): void {
	acc.edge.weight += meta.weight ?? 1;
	acc.commitShas.add(row.commitSha);
	acc.repositories.add(row.repository);
	for (const value of row.analysisCategories || []) {
		const normalized = normalizeCategory(value);
		if (normalized) {
			acc.categories.add(normalized);
		}
	}
	for (const layer of meta.layers) {
		acc.layers.add(layer);
	}
	for (const filePath of meta.relatedFiles) {
		if (filePath) {
			acc.relatedFiles.add(filePath);
		}
	}
	acc.strengthTotal += Math.max(1, row.relationStrength ?? 1);
	acc.strengthSamples += 1;
	acc.firstSeenAt = dateMin(acc.firstSeenAt, row.commitDate);
	acc.lastSeenAt = dateMax(acc.lastSeenAt, row.commitDate);
}

function inferEndpointMeta(
	row: RawKnowledgeGraphRecord,
	commitFiles: Map<string, string[]>,
	endpoint: 'source' | 'target',
): EndpointMeta {
	const kind = normalizeKind(endpoint === 'source' ? row.sourceKind : row.targetKind);
	const componentName = endpoint === 'source' ? row.sourceComponent : row.targetComponent;
	const explicitLayer = normalizeLayer(endpoint === 'source' ? row.sourceLayer : row.targetLayer);
	const explicitFilePath = (endpoint === 'source' ? row.sourceFilePath : row.targetFilePath) || undefined;
	const commitFileList = commitFiles.get(row.commitSha) || [];
	const guessedFiles = explicitFilePath ? [explicitFilePath] : chooseCandidateFiles(componentName, commitFileList);
	const inferredFileLayer = guessedFiles[0] ? inferLayerFromPath(guessedFiles[0]) : undefined;
	const layer = explicitLayer || inferredFileLayer || normalizeLayer(row.analysisLayers?.[0]) || 'other';

	if (kind === 'layer') {
		const label = componentName || String(layer);
		return {
			primaryId: nodeId('layer', row.repository, label),
			kind,
			label,
			layer,
			relatedFiles: guessedFiles,
		};
	}

	if (kind === 'file') {
		const filePath = explicitFilePath || componentName;
		return {
			primaryId: nodeId('file', row.repository, filePath),
			kind,
			label: filePath,
			layer,
			filePath,
			relatedFiles: filePath ? [filePath] : guessedFiles,
		};
	}

	return {
		primaryId: nodeId('component', row.repository, componentName),
		kind,
		label: componentName,
		layer,
		filePath: explicitFilePath || guessedFiles[0],
		relatedFiles: explicitFilePath ? [explicitFilePath] : guessedFiles,
	};
}

function hierarchyColor(kind: KnowledgeGraphNodeKind): string {
	switch (kind) {
		case 'layer':
			return 'var(--vscode-charts-orange)';
		case 'file':
			return 'var(--vscode-charts-blue)';
		default:
			return 'var(--vscode-charts-green)';
	}
}

export function buildKnowledgeGraphData(
	rows: RawKnowledgeGraphRecord[],
	commitFilesInput: RawKnowledgeGraphCommitFile[],
): KnowledgeGraphData {
	if (rows.length === 0) {
		return { nodes: [], edges: [], summary: createEmptySummary() };
	}

	const commitFiles = new Map<string, string[]>();
	for (const item of commitFilesInput) {
		const next = commitFiles.get(item.commitSha) || [];
		next.push(item.filePath);
		commitFiles.set(item.commitSha, next);
	}

	const nodes = new Map<string, NodeAccumulator>();
	const edges = new Map<string, EdgeAccumulator>();

	for (const row of rows) {
		const sourceMeta = inferEndpointMeta(row, commitFiles, 'source');
		const targetMeta = inferEndpointMeta(row, commitFiles, 'target');

		const sourceLayerId = nodeId('layer', row.repository, sourceMeta.layer);
		const sourceLayerNode = ensureNode(nodes, {
			id: sourceLayerId,
			label: sourceMeta.layer,
			shortLabel: sourceMeta.layer,
			kind: 'layer',
			type: 'layer',
			repository: row.repository,
			layer: sourceMeta.layer,
			group: `layer:${sourceMeta.layer}`,
			color: hierarchyColor('layer'),
		});
		touchNode(sourceLayerNode, row, { relatedFiles: sourceMeta.relatedFiles, relatedComponents: [row.sourceComponent], weight: 1 });

		const targetLayerId = nodeId('layer', row.repository, targetMeta.layer);
		const targetLayerNode = ensureNode(nodes, {
			id: targetLayerId,
			label: targetMeta.layer,
			shortLabel: targetMeta.layer,
			kind: 'layer',
			type: 'layer',
			repository: row.repository,
			layer: targetMeta.layer,
			group: `layer:${targetMeta.layer}`,
			color: hierarchyColor('layer'),
		});
		touchNode(targetLayerNode, row, { relatedFiles: targetMeta.relatedFiles, relatedComponents: [row.targetComponent], weight: 1 });

		let sourcePrimary = sourceMeta.primaryId;
		let targetPrimary = targetMeta.primaryId;

		if (sourceMeta.filePath) {
			const sourceFileNode = ensureNode(nodes, {
				id: nodeId('file', row.repository, sourceMeta.filePath),
				label: sourceMeta.filePath,
				shortLabel: shortenLabel(sourceMeta.filePath.split('/').pop() || sourceMeta.filePath),
				kind: 'file',
				type: 'file',
				repository: row.repository,
				layer: sourceMeta.layer,
				filePath: sourceMeta.filePath,
				group: `file:${sourceMeta.layer}`,
				color: hierarchyColor('file'),
			});
			touchNode(sourceFileNode, row, { relatedFiles: [sourceMeta.filePath], relatedComponents: [row.sourceComponent], weight: 1 });
			touchEdge(ensureEdge(edges, sourceLayerId, sourceFileNode.node.id, 'contains', 'var(--vscode-charts-orange)'), row, {
				relatedFiles: [sourceMeta.filePath],
				layers: [sourceMeta.layer],
				relation: 'contains',
			});
			if (sourceMeta.kind === 'file') {
				sourcePrimary = sourceFileNode.node.id;
			}
		}

		if (targetMeta.filePath) {
			const targetFileNode = ensureNode(nodes, {
				id: nodeId('file', row.repository, targetMeta.filePath),
				label: targetMeta.filePath,
				shortLabel: shortenLabel(targetMeta.filePath.split('/').pop() || targetMeta.filePath),
				kind: 'file',
				type: 'file',
				repository: row.repository,
				layer: targetMeta.layer,
				filePath: targetMeta.filePath,
				group: `file:${targetMeta.layer}`,
				color: hierarchyColor('file'),
			});
			touchNode(targetFileNode, row, { relatedFiles: [targetMeta.filePath], relatedComponents: [row.targetComponent], weight: 1 });
			touchEdge(ensureEdge(edges, targetLayerId, targetFileNode.node.id, 'contains', 'var(--vscode-charts-orange)'), row, {
				relatedFiles: [targetMeta.filePath],
				layers: [targetMeta.layer],
				relation: 'contains',
			});
			if (targetMeta.kind === 'file') {
				targetPrimary = targetFileNode.node.id;
			}
		}

		if (sourceMeta.kind === 'component') {
			const sourceComponentNode = ensureNode(nodes, {
				id: nodeId('component', row.repository, row.sourceComponent),
				label: row.sourceComponent,
				shortLabel: shortenLabel(row.sourceComponent),
				kind: 'component',
				type: sourceMeta.layer,
				repository: row.repository,
				layer: sourceMeta.layer,
				filePath: sourceMeta.filePath,
				group: `component:${sourceMeta.layer}`,
				color: hierarchyColor('component'),
			});
			touchNode(sourceComponentNode, row, { relatedFiles: sourceMeta.relatedFiles, relatedComponents: [row.targetComponent], weight: 2 });
			sourcePrimary = sourceComponentNode.node.id;
			if (sourceMeta.filePath) {
				touchEdge(ensureEdge(edges, nodeId('file', row.repository, sourceMeta.filePath), sourcePrimary, 'implements', 'var(--vscode-charts-blue)'), row, {
					relatedFiles: [sourceMeta.filePath],
					layers: [sourceMeta.layer],
					relation: 'implements',
				});
			}
		}

		if (targetMeta.kind === 'component') {
			const targetComponentNode = ensureNode(nodes, {
				id: nodeId('component', row.repository, row.targetComponent),
				label: row.targetComponent,
				shortLabel: shortenLabel(row.targetComponent),
				kind: 'component',
				type: targetMeta.layer,
				repository: row.repository,
				layer: targetMeta.layer,
				filePath: targetMeta.filePath,
				group: `component:${targetMeta.layer}`,
				color: hierarchyColor('component'),
			});
			touchNode(targetComponentNode, row, { relatedFiles: targetMeta.relatedFiles, relatedComponents: [row.sourceComponent], weight: 2 });
			targetPrimary = targetComponentNode.node.id;
			if (targetMeta.filePath) {
				touchEdge(ensureEdge(edges, nodeId('file', row.repository, targetMeta.filePath), targetPrimary, 'implements', 'var(--vscode-charts-blue)'), row, {
					relatedFiles: [targetMeta.filePath],
					layers: [targetMeta.layer],
					relation: 'implements',
				});
			}
		}

		touchEdge(ensureEdge(edges, sourcePrimary, targetPrimary, row.relationType, undefined), row, {
			relatedFiles: Array.from(new Set([...sourceMeta.relatedFiles, ...targetMeta.relatedFiles])),
			layers: [sourceMeta.layer, targetMeta.layer],
		});
	}

	const resultNodes = Array.from(nodes.values()).map(acc => {
		acc.node.commitCount = acc.commitShas.size;
		acc.node.businessDomains = Array.from(acc.businessDomains).sort();
		acc.node.categories = Array.from(acc.categories).sort();
		acc.node.relatedFiles = Array.from(acc.relatedFiles).sort();
		acc.node.relatedComponents = Array.from(acc.relatedComponents).sort();
		acc.node.firstSeenAt = acc.firstSeenAt;
		acc.node.lastSeenAt = acc.lastSeenAt;
		acc.node.val = Math.max(1, Math.round(Math.sqrt(acc.node.weight + acc.node.impactScore / 2)));
		return acc.node;
	});

	const resultEdges = Array.from(edges.values()).map(acc => {
		acc.edge.commitCount = acc.commitShas.size;
		acc.edge.repositories = Array.from(acc.repositories).sort();
		acc.edge.categories = Array.from(acc.categories).sort();
		acc.edge.layers = Array.from(acc.layers).sort();
		acc.edge.relatedFiles = Array.from(acc.relatedFiles).sort();
		acc.edge.firstSeenAt = acc.firstSeenAt;
		acc.edge.lastSeenAt = acc.lastSeenAt;
		acc.edge.strength = acc.strengthSamples > 0
			? Number((acc.strengthTotal / acc.strengthSamples).toFixed(2))
			: 1;
		return acc.edge;
	});

	const summary = createEmptySummary();
	for (const node of resultNodes) {
		if (!summary.nodeKinds.includes(node.kind)) {
			summary.nodeKinds.push(node.kind);
		}
		if (node.layer && !summary.layers.includes(node.layer)) {
			summary.layers.push(node.layer);
		}
		if (node.repository && !summary.repositories.includes(node.repository)) {
			summary.repositories.push(node.repository);
		}
		summary.maxNodeWeight = Math.max(summary.maxNodeWeight, node.weight);
		summary.totalImpact += node.impactScore;
		summary.nodeCounts[node.kind] += 1;
	}
	for (const edge of resultEdges) {
		if (!summary.relationTypes.includes(edge.type)) {
			summary.relationTypes.push(edge.type);
		}
		summary.maxEdgeWeight = Math.max(summary.maxEdgeWeight, edge.weight);
		for (const repository of edge.repositories) {
			if (!summary.repositories.includes(repository)) {
				summary.repositories.push(repository);
			}
		}
		for (const layer of edge.layers) {
			if (!summary.layers.includes(layer)) {
				summary.layers.push(layer);
			}
		}
	}

	summary.nodeKinds.sort();
	summary.layers.sort();
	summary.relationTypes.sort();
	summary.repositories.sort();

	return {
		nodes: resultNodes,
		edges: resultEdges,
		summary,
	};
}