import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { getVsCodeApi } from '../../shared/vscodeApi';
import type {
	KnowledgeGraphData,
	KnowledgeGraphEdge,
	KnowledgeGraphLayer,
	KnowledgeGraphNode,
	KnowledgeGraphNodeKind,
} from '../../../types/memory';
import { memoryButtonStyles } from './buttonStyles';

interface Props {
	data: KnowledgeGraphData | null;
	repositories: string[];
	onRequestGraph: (repository?: string) => void;
	t: (key: string) => string;
}

type LabelsMode = 'focus' | 'dense' | 'off';
type FocusDepth = 0 | 1 | 2;
type KindFilter = 'all' | KnowledgeGraphNodeKind;
type LayerFilter = 'all' | KnowledgeGraphLayer;
type ClusterMode = 'none' | 'layer' | 'repository' | 'kind';
type ColorMode = 'kind' | 'risk' | 'impact';
type GraphRenderMode = '3d' | '2d';

interface GraphViewState {
	selectedRepo: string;
	searchQuery: string;
	kindFilter: KindFilter;
	layerFilter: LayerFilter;
	relationFilter: string;
	minWeight: number;
	labelsMode: LabelsMode;
	focusDepth: FocusDepth;
	renderMode: GraphRenderMode;
	leftDragSensitivity: number;
	rightDragSensitivity: number;
	middleDragSensitivity: number;
	zoomSensitivity: number;
	lightweightMode: boolean;
	pinnedNodes: Record<string, { x: number; y: number; z: number }>;
	traceAnchorId?: string;
	selectedNodeId?: string;
	selectedEdgeId?: string;
	timelineStartIndex: number;
	timelineEndIndex: number;
	timelineOnlyNew: boolean;
	timelineAutoplay: boolean;
	clusterMode: ClusterMode;
	colorMode: ColorMode;
	overviewMode: boolean;
	minimapVisible: boolean;
	cameraState?: {
		position: { x: number; y: number; z: number };
		target: { x: number; y: number; z: number };
	};
}

interface SavedGraphView {
	id: string;
	name: string;
	createdAt: string;
	state: Partial<GraphViewState>;
}

interface PersistedKnowledgeGraphState {
	viewState?: Partial<GraphViewState>;
	savedViews?: SavedGraphView[];
}

interface TimelinePoint {
	value: string;
	label: string;
}

interface MinimapPoint {
	id: string;
	x: number;
	y: number;
	node: KnowledgeGraphNode;
}

interface Graph2DViewportState {
	zoom: number;
	panX: number;
	panY: number;
}

interface Graph2DTransform {
	width: number;
	height: number;
	centerX: number;
	centerZ: number;
	fitScale: number;
	zoom: number;
	panX: number;
	panY: number;
}

interface Graph2DNodePoint {
	id: string;
	x: number;
	y: number;
	radius: number;
	node: KnowledgeGraphNode;
}

interface WindowWithForceGraph3D extends Window {
	ForceGraph3D?: unknown;
}

type GraphSceneStatus = 'idle' | 'waiting-container' | 'initializing' | 'ready' | 'error';

const vscode = getVsCodeApi();

function sendGraphDebugLog(scope: string, payload?: unknown): void {
	console.log(`[PromptManager/MemoryGraph/Webview] ${scope}`, payload ?? '');
	vscode.postMessage({ type: 'memoryDebugLog', scope, payload });
}

function isGraphApi(value: unknown): value is {
	backgroundColor: (color: string) => void;
	showNavInfo: (show: boolean) => void;
} {
	return Boolean(
		value
		&& (typeof value === 'object' || typeof value === 'function')
		&& 'backgroundColor' in value
		&& 'showNavInfo' in value,
	);
}

function describeRuntimeValue(value: unknown): Record<string, unknown> {
	const objectValue = Object(value);
	return {
		type: typeof value,
		hasBackgroundColor: 'backgroundColor' in objectValue,
		hasShowNavInfo: 'showNavInfo' in objectValue,
		hasGraphData: 'graphData' in objectValue,
		hasResetProps: 'resetProps' in objectValue,
		ownKeys: Object.getOwnPropertyNames(objectValue).slice(0, 12),
	};
}

function createForceGraphInstance(container: HTMLDivElement): { graph: any; mode: string } {
	const moduleValue = (window as WindowWithForceGraph3D).ForceGraph3D as any;
	if (!moduleValue) {
		throw new Error('window.ForceGraph3D is not available');
	}
	const errors: string[] = [];
		let currentFactory: any = moduleValue;
		for (let depth = 0; depth <= 5; depth += 1) {
			if (typeof currentFactory !== 'function') {
				errors.push(`depth-${depth}: factory is ${typeof currentFactory}`);
				break;
			}

			const candidates: Array<{ mode: string; create: () => unknown }> = [
				{ mode: `depth-${depth}:constructor`, create: () => new currentFactory(container) },
				{ mode: `depth-${depth}:call-with-container`, create: () => currentFactory(container) },
			];

			for (const candidate of candidates) {
				try {
					const instance = candidate.create();
					if (isGraphApi(instance)) {
						return { graph: instance, mode: candidate.mode };
					}
					errors.push(`${candidate.mode}: ${JSON.stringify(describeRuntimeValue(instance))}`);
				} catch (error) {
					errors.push(`${candidate.mode}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}

			try {
				const nextFactory = currentFactory();
				errors.push(`depth-${depth}:next-factory ${JSON.stringify(describeRuntimeValue(nextFactory))}`);
				currentFactory = nextFactory;
			} catch (error) {
				errors.push(`depth-${depth}:next-factory ${error instanceof Error ? error.message : String(error)}`);
				break;
			}
		}

	throw new Error(`Unable to initialize 3d-force-graph. Attempts: ${errors.join(' | ')}`);
}

const DEFAULT_VIEW_STATE: GraphViewState = {
	selectedRepo: '',
	searchQuery: '',
	kindFilter: 'all',
	layerFilter: 'all',
	relationFilter: 'all',
	minWeight: 1,
	labelsMode: 'focus',
	focusDepth: 0,
	renderMode: '2d',
	leftDragSensitivity: 1.2,
	rightDragSensitivity: 1.15,
	middleDragSensitivity: 1.2,
	zoomSensitivity: 1.65,
	lightweightMode: true,
	pinnedNodes: {},
	timelineStartIndex: 0,
	timelineEndIndex: 0,
	timelineOnlyNew: false,
	timelineAutoplay: false,
	clusterMode: 'layer',
	colorMode: 'kind',
	overviewMode: true,
	minimapVisible: true,
};

function endpointId(value: string | KnowledgeGraphNode): string {
	return typeof value === 'string' ? value : value.id;
}

function shortestPath(edges: KnowledgeGraphEdge[], sourceId: string, targetId: string): string[] {
	if (sourceId === targetId) {
		return [sourceId];
	}
	const adjacency = new Map<string, string[]>();
	for (const edge of edges) {
		const source = endpointId(edge.source);
		const target = endpointId(edge.target);
		adjacency.set(source, [...(adjacency.get(source) || []), target]);
		adjacency.set(target, [...(adjacency.get(target) || []), source]);
	}
	const visited = new Set<string>([sourceId]);
	const queue: Array<{ id: string; path: string[] }> = [{ id: sourceId, path: [sourceId] }];
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) {
			continue;
		}
		for (const next of adjacency.get(current.id) || []) {
			if (visited.has(next)) {
				continue;
			}
			const nextPath = [...current.path, next];
			if (next === targetId) {
				return nextPath;
			}
			visited.add(next);
			queue.push({ id: next, path: nextPath });
		}
	}
	return [];
}

function neighborhood(edges: KnowledgeGraphEdge[], seedId: string, depth: FocusDepth): Set<string> {
	if (depth === 0) {
		return new Set<string>();
	}
	const visited = new Set<string>([seedId]);
	let frontier = new Set<string>([seedId]);
	for (let hop = 0; hop < depth; hop++) {
		const next = new Set<string>();
		for (const edge of edges) {
			const source = endpointId(edge.source);
			const target = endpointId(edge.target);
			if (frontier.has(source) && !visited.has(target)) {
				visited.add(target);
				next.add(target);
			}
			if (frontier.has(target) && !visited.has(source)) {
				visited.add(source);
				next.add(source);
			}
		}
		frontier = next;
		if (frontier.size === 0) {
			break;
		}
	}
	return visited;
}

function resolveColor(name: string, fallback: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function parseCssColor(value: string): { r: number; g: number; b: number } | null {
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	if (trimmed.startsWith('#')) {
		const hex = trimmed.slice(1);
		if (hex.length === 3) {
			return {
				r: Number.parseInt(hex[0] + hex[0], 16),
				g: Number.parseInt(hex[1] + hex[1], 16),
				b: Number.parseInt(hex[2] + hex[2], 16),
			};
		}
		if (hex.length >= 6) {
			return {
				r: Number.parseInt(hex.slice(0, 2), 16),
				g: Number.parseInt(hex.slice(2, 4), 16),
				b: Number.parseInt(hex.slice(4, 6), 16),
			};
		}
	}
	const rgbMatch = trimmed.match(/rgba?\(([^)]+)\)/i);
	if (!rgbMatch) {
		return null;
	}
	const [r, g, b] = rgbMatch[1].split(',').slice(0, 3).map(part => Number.parseFloat(part.trim()));
	if ([r, g, b].some(item => Number.isNaN(item))) {
		return null;
	}
	return { r, g, b };
}

function getGraphLabelTextColor(): string {
	const background = parseCssColor(resolveColor('--vscode-editor-background', '#111827'));
	if (!background) {
		return '#f8fafc';
	}
	const luminance = ((background.r * 299) + (background.g * 587) + (background.b * 114)) / 1000;
	return luminance >= 160 ? '#111111' : '#f8fafc';
}

function createSelectedNodeOutline(): THREE.Group {
	const group = new THREE.Group();
	const inner = new THREE.Mesh(
		new THREE.SphereGeometry(5.8, 18, 18),
		new THREE.MeshBasicMaterial({ color: '#ffffff', wireframe: true, transparent: true, opacity: 0.95 }),
	);
	const outer = new THREE.Mesh(
		new THREE.SphereGeometry(7.1, 18, 18),
		new THREE.MeshBasicMaterial({ color: '#f97316', wireframe: true, transparent: true, opacity: 0.95 }),
	);
	group.add(inner);
	group.add(outer);
	return group;
}

function drawRoundedRect(
	context: CanvasRenderingContext2D,
	x: number,
	y: number,
	width: number,
	height: number,
	radius: number,
): void {
	const safeRadius = Math.min(radius, width / 2, height / 2);
	context.beginPath();
	context.moveTo(x + safeRadius, y);
	context.lineTo(x + width - safeRadius, y);
	context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
	context.lineTo(x + width, y + height - safeRadius);
	context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
	context.lineTo(x + safeRadius, y + height);
	context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
	context.lineTo(x, y + safeRadius);
	context.quadraticCurveTo(x, y, x + safeRadius, y);
	context.closePath();
}

function createTextSprite(text: string, color: string): THREE.Sprite {
	const canvas = document.createElement('canvas');
	const context = canvas.getContext('2d');
	if (!context) {
		return new THREE.Sprite();
	}
	const fontFamily = getComputedStyle(document.body).fontFamily || 'sans-serif';
	const fontSize = 32;
	context.font = `600 ${fontSize}px ${fontFamily}`;
	const metrics = context.measureText(text);
	const paddingX = 16;
	const paddingY = 6;
	canvas.width = Math.ceil(metrics.width + paddingX * 2);
	canvas.height = fontSize + paddingY * 2 + 4;
	context.clearRect(0, 0, canvas.width, canvas.height);
	context.font = `600 ${fontSize}px ${fontFamily}`;
	context.fillStyle = color;
	context.textBaseline = 'middle';
	context.fillText(text, paddingX, canvas.height / 2);
	const texture = new THREE.CanvasTexture(canvas);
	texture.needsUpdate = true;
	const material = new THREE.SpriteMaterial({ map: texture, depthWrite: false, depthTest: false, transparent: true });
	const sprite = new THREE.Sprite(material);
	sprite.scale.set(canvas.width / 7.2, canvas.height / 7.2, 1);
	sprite.position.set(0, 18, 0);
	return sprite;
}

function buildTimelinePoints(data: KnowledgeGraphData | null): TimelinePoint[] {
	if (!data) {
		return [];
	}
	const dates = new Set<string>();
	for (const node of data.nodes) {
		if (node.firstSeenAt) {
			dates.add(node.firstSeenAt);
		}
		if (node.lastSeenAt) {
			dates.add(node.lastSeenAt);
		}
	}
	for (const edge of data.edges) {
		if (edge.firstSeenAt) {
			dates.add(edge.firstSeenAt);
		}
		if (edge.lastSeenAt) {
			dates.add(edge.lastSeenAt);
		}
	}
	return Array.from(dates)
		.sort()
		.map(value => ({ value, label: new Date(value).toLocaleDateString() }));
}

function hashString(value: string): number {
	let hash = 0;
	for (let index = 0; index < value.length; index++) {
		hash = ((hash << 5) - hash) + value.charCodeAt(index);
		hash |= 0;
	}
	return Math.abs(hash);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function mixColors(start: string, end: string, ratio: number): string {
	const normalized = clamp(ratio, 0, 1);
	const parse = (value: string) => {
		const cleaned = value.replace('#', '');
		return {
			r: Number.parseInt(cleaned.slice(0, 2), 16),
			g: Number.parseInt(cleaned.slice(2, 4), 16),
			b: Number.parseInt(cleaned.slice(4, 6), 16),
		};
	};
	const from = parse(start);
	const to = parse(end);
	const r = Math.round(from.r + (to.r - from.r) * normalized);
	const g = Math.round(from.g + (to.g - from.g) * normalized);
	const b = Math.round(from.b + (to.b - from.b) * normalized);
	return `#${[r, g, b].map(item => item.toString(16).padStart(2, '0')).join('')}`;
}

function heatColor(score: number): string {
	const normalized = clamp(score, 0, 1);
	if (normalized < 0.5) {
		return mixColors('#22c55e', '#facc15', normalized / 0.5);
	}
	return mixColors('#facc15', '#ef4444', (normalized - 0.5) / 0.5);
}

function scoreNodeRisk(node: KnowledgeGraphNode, summary: KnowledgeGraphData['summary']): number {
	const maxImpact = Math.max(summary.totalImpact, 1);
	const maxWeight = Math.max(summary.maxNodeWeight, 1);
	const impactPart = node.impactScore / maxImpact;
	const weightPart = node.weight / maxWeight;
	const changePart = clamp((node.commitCount + (node.breakingChangeCount * 3)) / 20, 0, 1);
	return clamp((impactPart * 0.45) + (weightPart * 0.2) + (changePart * 0.35), 0, 1);
}

function scoreEdgeRisk(edge: KnowledgeGraphEdge, summary: KnowledgeGraphData['summary']): number {
	const maxWeight = Math.max(summary.maxEdgeWeight, 1);
	const weightPart = edge.weight / maxWeight;
	const strengthPart = clamp(edge.strength / 10, 0, 1);
	const changePart = clamp(edge.commitCount / 12, 0, 1);
	return clamp((weightPart * 0.35) + (strengthPart * 0.35) + (changePart * 0.3), 0, 1);
}

function clusterKey(node: KnowledgeGraphNode, clusterMode: ClusterMode): string {
	switch (clusterMode) {
		case 'layer':
			return node.layer || 'other';
		case 'repository':
			return node.repository || 'workspace';
		case 'kind':
			return node.kind;
		default:
			return 'all';
	}
}

function seedClusterPosition(node: KnowledgeGraphNode, clusterMode: ClusterMode, keys: string[]): { x: number; y: number; z: number } {
	if (clusterMode === 'none' || keys.length === 0) {
		const base = hashString(node.id);
		return {
			x: ((base % 23) - 11) * 12,
			y: (((base >> 3) % 17) - 8) * 10,
			z: (((base >> 5) % 23) - 11) * 12,
		};
	}
	const groupIndex = Math.max(0, keys.indexOf(clusterKey(node, clusterMode)));
	const band = Math.floor(groupIndex / 6);
	const angle = (Math.PI * 2 * (groupIndex % 6)) / Math.max(1, Math.min(keys.length, 6));
	const radius = 220 + (band * 130);
	const centerX = Math.cos(angle) * radius;
	const centerZ = Math.sin(angle) * radius;
	const centerY = ((groupIndex % 5) - 2) * 80;
	const jitter = hashString(node.id);
	return {
		x: centerX + (((jitter % 17) - 8) * 8),
		y: centerY + ((((jitter >> 2) % 13) - 6) * 8),
		z: centerZ + ((((jitter >> 4) % 17) - 8) * 8),
	};
}

function laneY(kind: KnowledgeGraphNodeKind): number {
	switch (kind) {
		case 'layer':
			return 150;
		case 'file':
			return 0;
		default:
			return -150;
	}
}

function laneZ(kind: KnowledgeGraphNodeKind): number {
	switch (kind) {
		case 'layer':
			return -120;
		case 'file':
			return 0;
		default:
			return 120;
	}
}

function buildStaticLayout(
	nodes: KnowledgeGraphNode[],
	clusterMode: ClusterMode,
	keys: string[],
): Record<string, { x: number; y: number; z: number }> {
	const layout: Record<string, { x: number; y: number; z: number }> = {};
	if (nodes.length === 0) {
		return layout;
	}

	const orderedNodes = [...nodes].sort((left, right) => {
		const clusterCompare = clusterKey(left, clusterMode).localeCompare(clusterKey(right, clusterMode));
		if (clusterCompare !== 0) {
			return clusterCompare;
		}
		const kindCompare = left.kind.localeCompare(right.kind);
		if (kindCompare !== 0) {
			return kindCompare;
		}
		const impactCompare = right.impactScore - left.impactScore;
		if (impactCompare !== 0) {
			return impactCompare;
		}
		return (left.shortLabel || left.label).localeCompare(right.shortLabel || right.label);
	});

	const clusterIds = clusterMode === 'none'
		? ['all']
		: (keys.length > 0 ? keys : Array.from(new Set(orderedNodes.map(node => clusterKey(node, clusterMode)))));
	const clusterColumns = Math.max(1, Math.ceil(Math.sqrt(clusterIds.length)));
	const clusterSpacingX = clusterMode === 'none' ? 0 : 460;
	const clusterSpacingZ = clusterMode === 'none' ? 0 : 360;
	const nodeSpacingX = 92;
	const nodeSpacingZ = 78;
	const kindOrder: KnowledgeGraphNodeKind[] = ['layer', 'file', 'component'];

	for (const [clusterIndex, clusterId] of clusterIds.entries()) {
		const column = clusterIndex % clusterColumns;
		const row = Math.floor(clusterIndex / clusterColumns);
		const clusterCenterX = (column - ((clusterColumns - 1) / 2)) * clusterSpacingX;
		const clusterCenterZ = (row - ((Math.ceil(clusterIds.length / clusterColumns) - 1) / 2)) * clusterSpacingZ;
		const clusterNodes = orderedNodes.filter(node => clusterKey(node, clusterMode) === clusterId || clusterMode === 'none');

		for (const kind of kindOrder) {
			const bucket = clusterNodes.filter(node => node.kind === kind);
			if (bucket.length === 0) {
				continue;
			}

			const columns = Math.max(1, Math.ceil(Math.sqrt(bucket.length)));
			const rows = Math.max(1, Math.ceil(bucket.length / columns));

			bucket.forEach((node, index) => {
				const localColumn = index % columns;
				const localRow = Math.floor(index / columns);
				layout[node.id] = {
					x: clusterCenterX + ((localColumn - ((columns - 1) / 2)) * nodeSpacingX),
					y: laneY(kind),
					z: clusterCenterZ + laneZ(kind) + ((localRow - ((rows - 1) / 2)) * nodeSpacingZ),
				};
			});
		}
	}

	return layout;
}

function build2DTransform(
	nodes: KnowledgeGraphNode[],
	layout: Record<string, { x: number; y: number; z: number }>,
	width: number,
	height: number,
	viewport: Graph2DViewportState,
): Graph2DTransform | null {
	if (nodes.length === 0 || width <= 0 || height <= 0) {
		return null;
	}
	const positions = nodes
		.map(node => layout[node.id])
		.filter((position): position is { x: number; y: number; z: number } => Boolean(position));
	if (positions.length === 0) {
		return null;
	}
	const padding = 54;
	const xValues = positions.map(position => position.x);
	const zValues = positions.map(position => position.z);
	const minX = Math.min(...xValues);
	const maxX = Math.max(...xValues);
	const minZ = Math.min(...zValues);
	const maxZ = Math.max(...zValues);
	const spanX = Math.max(maxX - minX, 1);
	const spanZ = Math.max(maxZ - minZ, 1);
	const fitScale = Math.max(0.08, Math.min((width - (padding * 2)) / spanX, (height - (padding * 2)) / spanZ));
	return {
		width,
		height,
		centerX: (minX + maxX) / 2,
		centerZ: (minZ + maxZ) / 2,
		fitScale,
		zoom: viewport.zoom,
		panX: viewport.panX,
		panY: viewport.panY,
	};
}

function project2DPoint(position: { x: number; y: number; z: number }, transform: Graph2DTransform): { x: number; y: number } {
	const scale = transform.fitScale * transform.zoom;
	return {
		x: ((position.x - transform.centerX) * scale) + (transform.width / 2) + transform.panX,
		y: ((position.z - transform.centerZ) * scale) + (transform.height / 2) + transform.panY,
	};
}

function unproject2DPoint(canvasX: number, canvasY: number, transform: Graph2DTransform): { x: number; z: number } {
	const scale = transform.fitScale * transform.zoom;
	return {
		x: ((canvasX - (transform.width / 2) - transform.panX) / scale) + transform.centerX,
		z: ((canvasY - (transform.height / 2) - transform.panY) / scale) + transform.centerZ,
	};
}

function drawCanvasLabel(
	context: CanvasRenderingContext2D,
	text: string,
	x: number,
	y: number,
	emphasized: boolean,
): void {
	const fontSize = emphasized ? 15 : 13;
	context.font = `600 ${fontSize}px ${getComputedStyle(document.body).fontFamily || 'sans-serif'}`;
	const metrics = context.measureText(text);
	context.fillStyle = getGraphLabelTextColor();
	context.textBaseline = 'middle';
	context.fillText(text, x - (metrics.width / 2), y - fontSize - 4);
}

function sensitivityForPointerButton(button: number, viewState: GraphViewState): number {
	switch (button) {
		case 1:
			return viewState.middleDragSensitivity;
		case 2:
			return viewState.rightDragSensitivity;
		default:
			return viewState.leftDragSensitivity;
	}
}

function sanitizeViewStateForSave(viewState: GraphViewState): Partial<GraphViewState> {
	return {
		selectedRepo: viewState.selectedRepo,
		searchQuery: viewState.searchQuery,
		kindFilter: viewState.kindFilter,
		layerFilter: viewState.layerFilter,
		relationFilter: viewState.relationFilter,
		minWeight: viewState.minWeight,
		labelsMode: viewState.labelsMode,
		focusDepth: viewState.focusDepth,
		renderMode: viewState.renderMode,
		leftDragSensitivity: viewState.leftDragSensitivity,
		rightDragSensitivity: viewState.rightDragSensitivity,
		middleDragSensitivity: viewState.middleDragSensitivity,
		zoomSensitivity: viewState.zoomSensitivity,
		lightweightMode: viewState.lightweightMode,
		pinnedNodes: viewState.pinnedNodes,
		timelineStartIndex: viewState.timelineStartIndex,
		timelineEndIndex: viewState.timelineEndIndex,
		timelineOnlyNew: viewState.timelineOnlyNew,
		clusterMode: viewState.clusterMode,
		colorMode: viewState.colorMode,
		overviewMode: viewState.overviewMode,
		minimapVisible: viewState.minimapVisible,
		cameraState: viewState.cameraState,
	};
}

function loadPersistedState(): PersistedKnowledgeGraphState {
	const saved = vscode.getState() as Partial<GraphViewState> | PersistedKnowledgeGraphState | undefined;
	if (!saved) {
		return {};
	}
	if ('viewState' in saved || 'savedViews' in saved) {
		return saved as PersistedKnowledgeGraphState;
	}
	return { viewState: saved as Partial<GraphViewState>, savedViews: [] };
}

function visibilityByTimeline(
	item: { firstSeenAt?: string; lastSeenAt?: string },
	startDate: string | undefined,
	endDate: string | undefined,
	onlyNew: boolean,
): boolean {
	if (!startDate || !endDate) {
		return true;
	}
	const first = item.firstSeenAt || item.lastSeenAt;
	const last = item.lastSeenAt || item.firstSeenAt;
	if (!first && !last) {
		return true;
	}
	if (onlyNew) {
		return Boolean(first && first >= startDate && first <= endDate);
	}
	if (first && first > endDate) {
		return false;
	}
	if (last && last < startDate) {
		return false;
	}
	return true;
}

export const KnowledgeGraph: React.FC<Props> = ({ data, repositories, onRequestGraph, t }) => {
	const persisted = useMemo(() => loadPersistedState(), []);
	const sceneWrapRef = useRef<HTMLDivElement>(null);
	const graphContainerRef = useRef<HTMLDivElement>(null);
	const graph2DCanvasRef = useRef<HTMLCanvasElement>(null);
	const [graphContainerVersion, setGraphContainerVersion] = useState(0);
	const minimapRef = useRef<HTMLCanvasElement>(null);
	const graphRef = useRef<any>(null);
	const hoverNodeIdRef = useRef<string | null>(null);
	const hoverEdgeIdRef = useRef<string | null>(null);
	const resizeObserverRef = useRef<ResizeObserver | null>(null);
	const controlCleanupRef = useRef<(() => void) | null>(null);
	const minimapPointsRef = useRef<MinimapPoint[]>([]);
	const graph2DNodePointsRef = useRef<Graph2DNodePoint[]>([]);
	const graph2DTransformRef = useRef<Graph2DTransform | null>(null);
	const graph2DViewportFrameRef = useRef<number | null>(null);
	const graph2DQueuedViewportRef = useRef<Graph2DViewportState | null>(null);
	const saveViewNameInputRef = useRef<HTMLInputElement>(null);
	const graph2DPointerRef = useRef<{ dragging: boolean; moved: boolean; startX: number; startY: number; startPanX: number; startPanY: number; button?: number; }>({
		dragging: false,
		moved: false,
		startX: 0,
		startY: 0,
		startPanX: 0,
		startPanY: 0,
	});
	const minimapDrawRef = useRef<(() => void) | null>(null);
	const labelCacheRef = useRef<Map<string, THREE.Object3D>>(new Map());
	const positionCacheRef = useRef<Record<string, { x: number; y: number; z: number }>>({});
	const lastDebugSignatureRef = useRef('');
	const shouldAutoFitRef = useRef(true);
	const timelineInitializedRef = useRef(false);
	const autoResetHiddenStateRef = useRef(false);
	const [savedViews, setSavedViews] = useState<SavedGraphView[]>(persisted.savedViews || []);
	const [selectedSavedViewId, setSelectedSavedViewId] = useState('');
	const [isSaveViewDialogOpen, setIsSaveViewDialogOpen] = useState(false);
	const [saveViewName, setSaveViewName] = useState('');
	const [sceneStatus, setSceneStatus] = useState<GraphSceneStatus>('idle');
	const [sceneSize, setSceneSize] = useState({ width: 0, height: 560 });
	const [graph2DViewport, setGraph2DViewport] = useState<Graph2DViewportState>({ zoom: 1, panX: 0, panY: 0 });
	const [viewState, setViewState] = useState<GraphViewState>(() => ({
		...DEFAULT_VIEW_STATE,
		...persisted.viewState,
		pinnedNodes: persisted.viewState?.pinnedNodes || {},
	}));
	const [webglError, setWebglError] = useState('');
	const deferredSearch = useDeferredValue(viewState.searchQuery.trim().toLowerCase());

	const scheduleGraph2DViewport = useCallback((nextViewport: Graph2DViewportState) => {
		graph2DQueuedViewportRef.current = nextViewport;
		if (graph2DViewportFrameRef.current !== null) {
			return;
		}
		graph2DViewportFrameRef.current = window.requestAnimationFrame(() => {
			graph2DViewportFrameRef.current = null;
			if (graph2DQueuedViewportRef.current) {
				setGraph2DViewport(graph2DQueuedViewportRef.current);
				graph2DQueuedViewportRef.current = null;
			}
		});
	}, []);

	const setGraph2DCursor = useCallback((cursor: string) => {
		const canvas = graph2DCanvasRef.current;
		if (canvas && canvas.style.cursor !== cursor) {
			canvas.style.cursor = cursor;
		}
	}, []);

	const setGraph3DCursor = useCallback((cursor: string) => {
		const renderer = graphRef.current?.renderer?.();
		const element = (renderer?.domElement as HTMLCanvasElement | undefined) || graphContainerRef.current;
		if (element && element.style.cursor !== cursor) {
			element.style.cursor = cursor;
		}
	}, []);

	const setGraphContainerElement = useCallback((element: HTMLDivElement | null) => {
		graphContainerRef.current = element;
		setGraphContainerVersion(current => current + 1);
		sendGraphDebugLog('knowledgeGraph:containerRef', {
			attached: Boolean(element),
			width: element?.clientWidth ?? 0,
			height: element?.clientHeight ?? 0,
		});
	}, []);

	useEffect(() => {
		vscode.setState({ viewState, savedViews });
	}, [savedViews, viewState]);

	useEffect(() => {
		if (!isSaveViewDialogOpen) {
			return;
		}

		const focusTimer = window.requestAnimationFrame(() => {
			saveViewNameInputRef.current?.focus();
			saveViewNameInputRef.current?.select();
		});

		return () => window.cancelAnimationFrame(focusTimer);
	}, [isSaveViewDialogOpen]);

	useEffect(() => {
		if (!selectedSavedViewId) {
			return;
		}

		if (!savedViews.some(item => item.id === selectedSavedViewId)) {
			setSelectedSavedViewId('');
		}
	}, [savedViews, selectedSavedViewId]);

	useEffect(() => () => {
		if (graph2DViewportFrameRef.current !== null) {
			window.cancelAnimationFrame(graph2DViewportFrameRef.current);
		}
	}, []);

	const timelinePoints = useMemo(() => buildTimelinePoints(data), [data]);
	const timelineStartDate = timelinePoints[viewState.timelineStartIndex]?.value;
	const timelineEndDate = timelinePoints[viewState.timelineEndIndex]?.value;

	useEffect(() => {
		if (timelinePoints.length === 0) {
			return;
		}
		setViewState(current => {
			const maxIndex = timelinePoints.length - 1;
			if (!timelineInitializedRef.current) {
				timelineInitializedRef.current = true;
				return {
					...current,
					timelineStartIndex: 0,
					timelineEndIndex: maxIndex,
				};
			}
			const nextStart = clamp(current.timelineStartIndex, 0, maxIndex);
			const nextEnd = clamp(current.timelineEndIndex, nextStart, maxIndex);
			if (nextStart === current.timelineStartIndex && nextEnd === current.timelineEndIndex) {
				return current;
			}
			return {
				...current,
				timelineStartIndex: nextStart,
				timelineEndIndex: nextEnd,
			};
		});
	}, [timelinePoints]);

	useEffect(() => {
		if (!viewState.timelineAutoplay || timelinePoints.length < 2) {
			return;
		}
		const timer = window.setInterval(() => {
			setViewState(current => {
				if (current.timelineEndIndex >= timelinePoints.length - 1) {
					return { ...current, timelineAutoplay: false };
				}
				const nextEnd = current.timelineEndIndex + 1;
				const nextStart = Math.min(current.timelineStartIndex, nextEnd);
				return {
					...current,
					timelineEndIndex: nextEnd,
					timelineStartIndex: nextStart,
				};
			});
		}, 900);
		return () => window.clearInterval(timer);
	}, [timelinePoints.length, viewState.timelineAutoplay]);

	const toggleTimelineAutoplay = useCallback(() => {
		setViewState(current => {
			if (current.timelineAutoplay) {
				return { ...current, timelineAutoplay: false };
			}
			const maxIndex = Math.max(0, timelinePoints.length - 1);
			if (maxIndex < 1) {
				return current;
			}
			if (current.timelineEndIndex >= maxIndex) {
				return {
					...current,
					timelineStartIndex: 0,
					timelineEndIndex: 0,
					timelineAutoplay: true,
				};
			}
			return { ...current, timelineAutoplay: true };
		});
	}, [timelinePoints.length]);

	const selectedNode = useMemo(
		() => data?.nodes.find(node => node.id === viewState.selectedNodeId),
		[data, viewState.selectedNodeId],
	);
	const selectedEdge = useMemo(
		() => data?.edges.find(edge => edge.id === viewState.selectedEdgeId),
		[data, viewState.selectedEdgeId],
	);

	const pathNodeIds = useMemo(() => {
		if (!data || !viewState.traceAnchorId || !viewState.selectedNodeId || viewState.traceAnchorId === viewState.selectedNodeId) {
			return new Set<string>();
		}
		return new Set(shortestPath(data.edges, viewState.traceAnchorId, viewState.selectedNodeId));
	}, [data, viewState.selectedNodeId, viewState.traceAnchorId]);

	const pathEdgeIds = useMemo(() => {
		const result = new Set<string>();
		if (!data || pathNodeIds.size < 2) {
			return result;
		}
		const path = Array.from(pathNodeIds);
		for (let index = 0; index < path.length - 1; index++) {
			const edge = data.edges.find(item => {
				const source = endpointId(item.source);
				const target = endpointId(item.target);
				return (source === path[index] && target === path[index + 1]) || (source === path[index + 1] && target === path[index]);
			});
			if (edge) {
				result.add(edge.id);
			}
		}
		return result;
	}, [data, pathNodeIds]);

	const visibleData = useMemo<KnowledgeGraphData | null>(() => {
		if (!data) {
			return null;
		}

		const minimumVisibleWeight = viewState.overviewMode ? Math.max(2, viewState.minWeight) : viewState.minWeight;

		const visibleEdges = data.edges.filter(edge => {
			if (viewState.selectedRepo && !edge.repositories.includes(viewState.selectedRepo)) {
				return false;
			}
			if (viewState.relationFilter !== 'all' && edge.type !== viewState.relationFilter) {
				return false;
			}
			if (edge.weight < minimumVisibleWeight) {
				return false;
			}
			return visibilityByTimeline(edge, timelineStartDate, timelineEndDate, viewState.timelineOnlyNew);
		});

		const matchedIds = new Set<string>();
		for (const node of data.nodes) {
			if (viewState.selectedRepo && node.repository !== viewState.selectedRepo) {
				continue;
			}
			if (viewState.kindFilter !== 'all' && node.kind !== viewState.kindFilter) {
				continue;
			}
			if (viewState.layerFilter !== 'all' && node.layer !== viewState.layerFilter) {
				continue;
			}
			if (!visibilityByTimeline(node, timelineStartDate, timelineEndDate, viewState.timelineOnlyNew)) {
				continue;
			}
			if (!deferredSearch) {
				matchedIds.add(node.id);
				continue;
			}
			const haystack = [
				node.label,
				node.shortLabel || '',
				node.filePath || '',
				node.layer || '',
				node.repository || '',
				...node.relatedFiles,
				...node.relatedComponents,
				...node.businessDomains,
				...node.categories,
			].join(' ').toLowerCase();
			if (haystack.includes(deferredSearch)) {
				matchedIds.add(node.id);
			}
		}

		const focusIds = viewState.focusDepth > 0 && viewState.selectedNodeId
			? neighborhood(visibleEdges, viewState.selectedNodeId, viewState.focusDepth)
			: null;

		const visibleNodes = data.nodes
			.filter(node => matchedIds.has(node.id))
			.filter(node => {
				if (!viewState.overviewMode || node.kind !== 'component') {
					return true;
				}
				return node.id === viewState.selectedNodeId
					|| node.id === viewState.traceAnchorId
					|| pathNodeIds.has(node.id);
			})
			.filter(node => !focusIds || focusIds.has(node.id));

		const nodeIds = new Set(visibleNodes.map(node => node.id));
		const finalEdges = visibleEdges.filter(edge => nodeIds.has(endpointId(edge.source)) && nodeIds.has(endpointId(edge.target)));
		const summary = {
			...data.summary,
			maxNodeWeight: visibleNodes.reduce((max, node) => Math.max(max, node.weight), 0),
			maxEdgeWeight: finalEdges.reduce((max, edge) => Math.max(max, edge.weight), 0),
			totalImpact: visibleNodes.reduce((sum, node) => sum + node.impactScore, 0),
			nodeCounts: {
				layer: visibleNodes.filter(node => node.kind === 'layer').length,
				file: visibleNodes.filter(node => node.kind === 'file').length,
				component: visibleNodes.filter(node => node.kind === 'component').length,
			},
		};

		return { nodes: visibleNodes, edges: finalEdges, summary };
	}, [
		data,
		deferredSearch,
		pathNodeIds,
		timelineEndDate,
		timelineStartDate,
		viewState.focusDepth,
		viewState.kindFilter,
		viewState.layerFilter,
		viewState.minWeight,
		viewState.overviewMode,
		viewState.relationFilter,
		viewState.selectedNodeId,
		viewState.selectedRepo,
		viewState.timelineOnlyNew,
		viewState.traceAnchorId,
	]);

	const connectedNodeIds = useMemo(() => {
		const result = new Set<string>();
		if (!visibleData) {
			return result;
		}
		if (viewState.selectedNodeId) {
			result.add(viewState.selectedNodeId);
			for (const edge of visibleData.edges) {
				const source = endpointId(edge.source);
				const target = endpointId(edge.target);
				if (source === viewState.selectedNodeId) {
					result.add(target);
				}
				if (target === viewState.selectedNodeId) {
					result.add(source);
				}
			}
		}
		if (viewState.selectedEdgeId) {
			const edge = visibleData.edges.find(item => item.id === viewState.selectedEdgeId);
			if (edge) {
				result.add(endpointId(edge.source));
				result.add(endpointId(edge.target));
			}
		}
		return result;
	}, [viewState.selectedEdgeId, viewState.selectedNodeId, visibleData]);

	const connectedEdgeIds = useMemo(() => {
		const result = new Set<string>();
		if (!visibleData) {
			return result;
		}
		for (const edge of visibleData.edges) {
			const source = endpointId(edge.source);
			const target = endpointId(edge.target);
			if (viewState.selectedNodeId && (source === viewState.selectedNodeId || target === viewState.selectedNodeId)) {
				result.add(edge.id);
			}
			if (viewState.selectedEdgeId === edge.id) {
				result.add(edge.id);
			}
		}
		return result;
	}, [viewState.selectedEdgeId, viewState.selectedNodeId, visibleData]);

	const stats = useMemo(() => {
		if (!data || !visibleData) {
			return { nodes: 0, totalNodes: 0, edges: 0, totalEdges: 0, hiddenNodes: 0 };
		}
		return {
			nodes: visibleData.nodes.length,
			totalNodes: data.nodes.length,
			edges: visibleData.edges.length,
			totalEdges: data.edges.length,
			hiddenNodes: data.nodes.length - visibleData.nodes.length,
		};
	}, [data, visibleData]);

	const graphSummary = visibleData?.summary || data?.summary || {
		nodeKinds: [],
		layers: [],
		relationTypes: [],
		repositories: [],
		maxNodeWeight: 1,
		maxEdgeWeight: 1,
		totalImpact: 1,
		nodeCounts: { layer: 0, file: 0, component: 0 },
	};

	const shouldShowNodeLabel = useCallback((node: KnowledgeGraphNode) => {
		const forceVisible = connectedNodeIds.has(node.id) || pathNodeIds.has(node.id) || viewState.traceAnchorId === node.id;
		if (forceVisible) {
			return true;
		}
		if (viewState.labelsMode === 'off') {
			return false;
		}
		if (viewState.labelsMode === 'dense') {
			return true;
		}
		return hoverNodeIdRef.current === node.id || node.kind === 'layer';
	}, [connectedNodeIds, pathNodeIds, viewState.labelsMode, viewState.traceAnchorId]);

	const resolveNodeGraphColor = useCallback((node: KnowledgeGraphNode) => {
		if (viewState.selectedNodeId === node.id) {
			return '#f97316';
		}
		if (pathNodeIds.has(node.id)) {
			return '#f59e0b';
		}
		if (connectedNodeIds.has(node.id)) {
			return '#facc15';
		}
		if (hoverNodeIdRef.current === node.id) {
			return '#fb923c';
		}
		if (viewState.colorMode === 'risk') {
			return heatColor(scoreNodeRisk(node, graphSummary));
		}
		if (viewState.colorMode === 'impact') {
			return heatColor(clamp(node.impactScore / Math.max(graphSummary.totalImpact, 1), 0, 1));
		}
		if (node.kind === 'layer') {
			return '#fb923c';
		}
		if (node.kind === 'file') {
			return '#38bdf8';
		}
		return node.breakingChangeCount > 0 ? '#f87171' : '#34d399';
	}, [connectedNodeIds, graphSummary, pathNodeIds, viewState.colorMode, viewState.selectedNodeId]);

	const resolveEdgeGraphColor = useCallback((edge: KnowledgeGraphEdge) => {
		if (pathEdgeIds.has(edge.id)) {
			return '#f59e0b';
		}
		if (viewState.selectedEdgeId === edge.id) {
			return '#f97316';
		}
		if (connectedEdgeIds.has(edge.id)) {
			return '#facc15';
		}
		if (hoverEdgeIdRef.current === edge.id) {
			return '#fb923c';
		}
		if (viewState.colorMode === 'risk') {
			return heatColor(scoreEdgeRisk(edge, graphSummary));
		}
		if (viewState.colorMode === 'impact') {
			return heatColor(clamp(edge.weight / Math.max(graphSummary.maxEdgeWeight, 1), 0, 1));
		}
		if (edge.type === 'contains') {
			return '#fbbf24';
		}
		if (edge.type === 'implements') {
			return '#38bdf8';
		}
		return '#94a3b8';
	}, [connectedEdgeIds, graphSummary, pathEdgeIds, viewState.colorMode, viewState.selectedEdgeId]);

	const legendItems = useMemo(() => {
		if (viewState.colorMode === 'risk' || viewState.colorMode === 'impact') {
			return [
				{ color: '#22c55e', label: t('memory.graphLegendLow') },
				{ color: '#facc15', label: t('memory.graphLegendMedium') },
				{ color: '#ef4444', label: t('memory.graphLegendHigh') },
				{ color: '#f97316', label: t('memory.graphLegendSelected') },
				{ color: '#facc15', label: t('memory.graphLegendConnected') },
			];
		}
		return [
			{ color: '#fb923c', label: t('memory.graphLegendLayer') },
			{ color: '#38bdf8', label: t('memory.graphLegendFile') },
			{ color: '#34d399', label: t('memory.graphLegendComponent') },
			{ color: '#f97316', label: t('memory.graphLegendSelected') },
			{ color: '#facc15', label: t('memory.graphLegendConnected') },
			{ color: '#f59e0b', label: t('memory.graphLegendPath') },
		];
	}, [t, viewState.colorMode]);

	useEffect(() => {
		const signature = JSON.stringify({
			hasData: Boolean(data),
			sceneStatus,
			webglError,
			totalNodes: data?.nodes.length || 0,
			totalEdges: data?.edges.length || 0,
			visibleNodes: visibleData?.nodes.length || 0,
			visibleEdges: visibleData?.edges.length || 0,
			selectedRepo: viewState.selectedRepo || null,
			searchQuery: viewState.searchQuery || null,
			kindFilter: viewState.kindFilter,
			layerFilter: viewState.layerFilter,
			relationFilter: viewState.relationFilter,
			minWeight: viewState.minWeight,
			focusDepth: viewState.focusDepth,
			timelineStartDate: timelineStartDate || null,
			timelineEndDate: timelineEndDate || null,
			timelineOnlyNew: viewState.timelineOnlyNew,
			selectedNodeId: viewState.selectedNodeId || null,
			selectedEdgeId: viewState.selectedEdgeId || null,
			traceAnchorId: viewState.traceAnchorId || null,
			filteredOutAllNodes: Boolean(data && visibleData && data.nodes.length > 0 && visibleData.nodes.length === 0),
		});
		if (signature === lastDebugSignatureRef.current) {
			return;
		}
		lastDebugSignatureRef.current = signature;
		sendGraphDebugLog('knowledgeGraph:state', {
			hasData: Boolean(data),
			sceneStatus,
			webglError: webglError || null,
			totalNodes: data?.nodes.length || 0,
			totalEdges: data?.edges.length || 0,
			visibleNodes: visibleData?.nodes.length || 0,
			visibleEdges: visibleData?.edges.length || 0,
			hiddenNodes: stats.hiddenNodes,
			selectedRepo: viewState.selectedRepo || null,
			searchQuery: viewState.searchQuery || null,
			kindFilter: viewState.kindFilter,
			layerFilter: viewState.layerFilter,
			relationFilter: viewState.relationFilter,
			minWeight: viewState.minWeight,
			focusDepth: viewState.focusDepth,
			timelineStartDate: timelineStartDate || null,
			timelineEndDate: timelineEndDate || null,
			timelineOnlyNew: viewState.timelineOnlyNew,
			clusterMode: viewState.clusterMode,
			colorMode: viewState.colorMode,
			selectedNodeId: viewState.selectedNodeId || null,
			selectedEdgeId: viewState.selectedEdgeId || null,
			traceAnchorId: viewState.traceAnchorId || null,
			sampleVisibleNodeIds: visibleData?.nodes.slice(0, 5).map(node => node.id) || [],
			sampleVisibleEdgeIds: visibleData?.edges.slice(0, 5).map(edge => edge.id) || [],
		});
	}, [data, sceneStatus, stats.hiddenNodes, timelineEndDate, timelineStartDate, viewState, visibleData, webglError]);

	useEffect(() => {
		if (!data || !visibleData) {
			return;
		}
		const selectedRepoInvalid = Boolean(viewState.selectedRepo) && !repositories.includes(viewState.selectedRepo);
		const layerInvalid = viewState.layerFilter !== 'all' && !data.summary.layers.includes(viewState.layerFilter);
		const relationInvalid = viewState.relationFilter !== 'all' && !data.summary.relationTypes.includes(viewState.relationFilter);
		const minWeightInvalid = viewState.minWeight > Math.max(1, data.summary.maxEdgeWeight || 1);

		if (!selectedRepoInvalid && !layerInvalid && !relationInvalid && !minWeightInvalid) {
			return;
		}

		setViewState(current => ({
			...current,
			selectedRepo: selectedRepoInvalid ? '' : current.selectedRepo,
			layerFilter: layerInvalid ? 'all' : current.layerFilter,
			relationFilter: relationInvalid ? 'all' : current.relationFilter,
			minWeight: minWeightInvalid ? 1 : current.minWeight,
		}));
	}, [data, repositories, viewState.layerFilter, viewState.minWeight, viewState.relationFilter, viewState.selectedRepo, visibleData]);

	useEffect(() => {
		if (!data || !visibleData || autoResetHiddenStateRef.current) {
			return;
		}
		if (data.nodes.length === 0 || visibleData.nodes.length > 0) {
			return;
		}
		autoResetHiddenStateRef.current = true;
		shouldAutoFitRef.current = true;
		setViewState(current => ({
			...DEFAULT_VIEW_STATE,
			cameraState: current.cameraState,
			timelineEndIndex: Math.max(0, timelinePoints.length - 1),
		}));
	}, [data, timelinePoints.length, visibleData]);

	const clusterKeys = useMemo(() => {
		if (!visibleData) {
			return [] as string[];
		}
		return Array.from(new Set(visibleData.nodes.map(node => clusterKey(node, viewState.clusterMode)))).sort();
	}, [viewState.clusterMode, visibleData]);

	const staticLayout = useMemo(() => {
		if (!visibleData) {
			return {} as Record<string, { x: number; y: number; z: number }>;
		}
		return buildStaticLayout(visibleData.nodes, viewState.clusterMode, clusterKeys);
	}, [clusterKeys, viewState.clusterMode, visibleData]);

	const graph2DTransform = useMemo(
		() => build2DTransform(visibleData?.nodes || [], staticLayout, sceneSize.width, sceneSize.height, graph2DViewport),
		[graph2DViewport, sceneSize.height, sceneSize.width, staticLayout, visibleData],
	);

	const focusNode = useCallback((nodeId: string) => {
		const graph = graphRef.current;
		if (!graph) {
			return;
		}
		const nodes = (graph.graphData()?.nodes || []) as KnowledgeGraphNode[];
		const node = nodes.find(item => item.id === nodeId);
		if (!node || typeof node.x !== 'number' || typeof node.y !== 'number' || typeof node.z !== 'number') {
			return;
		}
		const distance = Math.max(170, 90 + (node.val || 1) * 20);
		graph.cameraPosition(
			{ x: node.x + distance, y: node.y + (distance * 0.35), z: node.z + distance },
			{ x: node.x, y: node.y, z: node.z },
			0,
		);
	}, []);

	const drawMinimap = useCallback(() => {
		if (!viewState.minimapVisible) {
			return;
		}
		const canvas = minimapRef.current;
		if (!canvas) {
			return;
		}
		const context = canvas.getContext('2d');
		if (!context) {
			return;
		}
		const graph = graphRef.current;
		const nodes = ((graph?.graphData()?.nodes || visibleData?.nodes || []) as KnowledgeGraphNode[])
			.filter(node => typeof node.x === 'number' && typeof node.z === 'number');
		const width = canvas.width;
		const height = canvas.height;
		context.clearRect(0, 0, width, height);
		context.fillStyle = resolveColor('--vscode-editorWidget-background', '#1f2937');
		context.fillRect(0, 0, width, height);
		context.strokeStyle = resolveColor('--vscode-panel-border', '#475569');
		context.strokeRect(0.5, 0.5, width - 1, height - 1);
		if (nodes.length === 0) {
			minimapPointsRef.current = [];
			return;
		}
		const xValues = nodes.map(node => node.x as number);
		const zValues = nodes.map(node => node.z as number);
		const minX = Math.min(...xValues);
		const maxX = Math.max(...xValues);
		const minZ = Math.min(...zValues);
		const maxZ = Math.max(...zValues);
		const spanX = Math.max(maxX - minX, 1);
		const spanZ = Math.max(maxZ - minZ, 1);
		const padding = 12;
		const points = nodes.map(node => {
			const x = padding + (((node.x as number) - minX) / spanX) * (width - (padding * 2));
			const y = padding + (((node.z as number) - minZ) / spanZ) * (height - (padding * 2));
			return { id: node.id, x, y, node };
		});
		minimapPointsRef.current = points;
		for (const point of points) {
			const fallbackSummary = visibleData?.summary || data?.summary || {
				nodeKinds: [],
				layers: [],
				relationTypes: [],
				repositories: [],
				maxNodeWeight: 1,
				maxEdgeWeight: 1,
				totalImpact: 1,
				nodeCounts: { layer: 0, file: 0, component: 0 },
			};
			const color = point.id === viewState.selectedNodeId
				? '#f97316'
				: viewState.colorMode === 'risk'
					? heatColor(scoreNodeRisk(point.node, fallbackSummary))
					: point.node.kind === 'layer'
						? '#fb923c'
						: point.node.kind === 'file'
							? '#38bdf8'
							: '#34d399';
			context.beginPath();
			context.fillStyle = color;
			context.arc(point.x, point.y, point.id === viewState.selectedNodeId ? 4 : 2.6, 0, Math.PI * 2);
			context.fill();
		}
	}, [data?.summary, viewState.colorMode, viewState.minimapVisible, viewState.selectedNodeId, visibleData]);

	useEffect(() => {
		minimapDrawRef.current = drawMinimap;
	}, [drawMinimap]);

	useEffect(() => {
		const host = sceneWrapRef.current;
		if (!host) {
			return;
		}
		const updateSceneSize = (width: number, height: number) => {
			setSceneSize(current => (current.width === width && current.height === height ? current : { width, height }));
		};
		updateSceneSize(host.clientWidth, host.clientHeight || 560);
		const observer = new ResizeObserver(entries => {
			const rect = entries[0]?.contentRect;
			if (!rect) {
				return;
			}
			updateSceneSize(rect.width, rect.height);
			const graph = graphRef.current;
			if (graph) {
				graph.width(rect.width);
				graph.height(rect.height);
				graph.refresh();
			}
			minimapDrawRef.current?.();
		});
		observer.observe(host);
		return () => observer.disconnect();
	}, [graphContainerVersion]);

	useEffect(() => {
		if (viewState.renderMode === '3d') {
			setWebglError('');
			setSceneStatus(current => (current === 'error' ? 'idle' : current));
			setGraph3DCursor('grab');
		} else {
			setGraph2DCursor('grab');
		}
	}, [setGraph2DCursor, setGraph3DCursor, viewState.renderMode]);

	useEffect(() => {
		sendGraphDebugLog('knowledgeGraph:init:effectEntered', {
			hasContainer: Boolean(graphContainerRef.current),
			hasGraph: Boolean(graphRef.current),
			containerWidth: graphContainerRef.current?.clientWidth ?? 0,
			containerHeight: graphContainerRef.current?.clientHeight ?? 0,
			containerVersion: graphContainerVersion,
		});
		if (viewState.renderMode !== '3d' && !graphRef.current) {
			return;
		}
		if (!graphContainerRef.current || graphRef.current) {
			if (!graphContainerRef.current) {
				setSceneStatus('waiting-container');
			}
			return;
		}
		try {
			setSceneStatus('initializing');
			setWebglError('');
			const forceGraphGlobal = (window as WindowWithForceGraph3D).ForceGraph3D as any;
			sendGraphDebugLog('knowledgeGraph:init:start', {
				containerWidth: graphContainerRef.current.clientWidth,
				containerHeight: graphContainerRef.current.clientHeight,
				moduleType: typeof forceGraphGlobal,
				moduleKeys: Object.keys(forceGraphGlobal || {}),
			});
			const { graph, mode } = createForceGraphInstance(graphContainerRef.current);
			graphRef.current = graph;
			setSceneStatus('ready');
			graph.width(sceneSize.width || graphContainerRef.current.clientWidth || 800);
			graph.height(sceneSize.height || graphContainerRef.current.clientHeight || 560);
			graph.backgroundColor('rgba(0,0,0,0)');
			graph.showNavInfo(false);
			graph.enablePointerInteraction(true);
			graph.enableNodeDrag(false);
			graph.enableNavigationControls(true);
			graph.nodeRelSize(4);
			graph.linkOpacity(0.28);
			graph.linkWidth((edge: KnowledgeGraphEdge) => Math.max(0.5, Math.min(4.8, edge.weight / 2.4)));
			graph.cooldownTicks(0);
			graph.d3AlphaDecay(1);
			graph.d3VelocityDecay(1);
			graph.d3Force('charge').strength(0);
			graph.onNodeHover((node: KnowledgeGraphNode | null) => {
				hoverNodeIdRef.current = node?.id || null;
				setGraph3DCursor(node || hoverEdgeIdRef.current ? 'pointer' : 'grab');
				graph.refresh();
			});
			graph.onLinkHover((edge: KnowledgeGraphEdge | null) => {
				hoverEdgeIdRef.current = edge?.id || null;
				setGraph3DCursor(edge || hoverNodeIdRef.current ? 'pointer' : 'grab');
				graph.refresh();
			});
			graph.onNodeClick((node: KnowledgeGraphNode) => {
				setViewState(current => ({ ...current, selectedNodeId: node.id, selectedEdgeId: undefined }));
			});
			graph.onLinkClick((edge: KnowledgeGraphEdge) => {
				setViewState(current => ({ ...current, selectedEdgeId: edge.id }));
			});
			graph.onBackgroundClick(() => {
				setViewState(current => ({ ...current, selectedNodeId: undefined, selectedEdgeId: undefined }));
			});
			graph.onEngineTick(() => {
				minimapDrawRef.current?.();
			});
			graph.onEngineStop(() => {
				const currentNodes = (graph.graphData()?.nodes || []) as KnowledgeGraphNode[];
				for (const node of currentNodes) {
					if (typeof node.x === 'number' && typeof node.y === 'number' && typeof node.z === 'number') {
						positionCacheRef.current[node.id] = { x: node.x, y: node.y, z: node.z };
					}
				}
				minimapDrawRef.current?.();
			});

			const renderer = graph.renderer?.();
			if (renderer) {
				renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
			}

			graph.lights([
				new THREE.AmbientLight('#ffffff', 1.15),
				new THREE.DirectionalLight('#ffffff', 0.42),
			]);

			const controls = graph.controls();
			controls.enableDamping = false;
			controls.rotateSpeed = 0.5 * viewState.rightDragSensitivity;
			controls.zoomSpeed = 1.7 * viewState.middleDragSensitivity * viewState.zoomSensitivity;
			controls.panSpeed = 0.72 * viewState.leftDragSensitivity;
			if ('staticMoving' in controls) {
				controls.staticMoving = true;
			}
			if ('dynamicDampingFactor' in controls) {
				controls.dynamicDampingFactor = 1;
			}
			if ('mouseButtons' in controls) {
				controls.mouseButtons = {
					...controls.mouseButtons,
					LEFT: THREE.MOUSE.PAN,
					MIDDLE: THREE.MOUSE.DOLLY,
					RIGHT: THREE.MOUSE.ROTATE,
				};
			}

			const rememberCamera = () => {
				const camera = graph.camera();
				const target = controls.target;
				setViewState(current => ({
					...current,
					cameraState: {
						position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
						target: { x: target.x, y: target.y, z: target.z },
					},
				}));
			};
			controls.addEventListener('end', rememberCamera);
			controlCleanupRef.current = () => controls.removeEventListener('end', rememberCamera);

			sendGraphDebugLog('knowledgeGraph:init:success', {
				mode,
				containerWidth: graphContainerRef.current.clientWidth,
				containerHeight: graphContainerRef.current.clientHeight,
			});
		} catch (error) {
			setSceneStatus('error');
			sendGraphDebugLog('knowledgeGraph:init:error', {
				message: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			setWebglError(error instanceof Error ? error.message : String(error));
		}

		return () => {
			controlCleanupRef.current?.();
		};
	}, [focusNode, graphContainerVersion, sceneSize.height, sceneSize.width, setGraph3DCursor, viewState.leftDragSensitivity, viewState.middleDragSensitivity, viewState.renderMode, viewState.rightDragSensitivity, viewState.zoomSensitivity]);

	useEffect(() => {
		const graph = graphRef.current;
		if (!graph) {
			return;
		}
		if (viewState.renderMode === '2d') {
			graph.pauseAnimation?.();
		} else {
			graph.resumeAnimation?.();
			graph.refresh();
		}
	}, [viewState.renderMode]);

	useEffect(() => {
		const graph = graphRef.current;
		if (!graph) {
			return;
		}
		if (viewState.lightweightMode) {
			graph.linkOpacity(0.22);
		} else {
			graph.linkOpacity(0.3);
		}
		graph.refresh();
	}, [viewState.lightweightMode]);

	useEffect(() => {
		const graph = graphRef.current;
		if (!graph) {
			return;
		}
		const controls = graph.controls?.();
		if (!controls) {
			return;
		}
		controls.rotateSpeed = 0.5 * viewState.rightDragSensitivity;
		controls.zoomSpeed = 1.7 * viewState.middleDragSensitivity * viewState.zoomSensitivity;
		controls.panSpeed = 0.72 * viewState.leftDragSensitivity;
	}, [viewState.leftDragSensitivity, viewState.middleDragSensitivity, viewState.rightDragSensitivity, viewState.zoomSensitivity]);

	useEffect(() => {
		if (!visibleData || !graphRef.current) {
			return;
		}
		const graph = graphRef.current;
		const labelColor = getGraphLabelTextColor();
		const summary = visibleData.summary;

		graph.nodeVal((node: KnowledgeGraphNode) => node.val);
		graph.nodeLabel((node: KnowledgeGraphNode) => {
			const lines = [
				`<strong>${node.label}</strong>`,
				node.kind,
				node.layer ? `Layer: ${node.layer}` : '',
				node.filePath ? `File: ${node.filePath}` : '',
				`Impact: ${node.impactScore}`,
				`Commits: ${node.commitCount}`,
			].filter(Boolean);
			return `<div style="padding:8px 10px;max-width:360px;line-height:1.45">${lines.join('<br/>')}</div>`;
		});
		graph.nodeColor((node: KnowledgeGraphNode) => resolveNodeGraphColor(node));
		graph.nodeOpacity(viewState.lightweightMode ? 0.9 : 0.96);
		graph.nodeThreeObjectExtend(true);
		graph.nodeThreeObject((node: KnowledgeGraphNode) => {
			const shouldShowLabel = shouldShowNodeLabel(node);
			const isSelected = viewState.selectedNodeId === node.id;
			if (!shouldShowLabel && !isSelected) {
				return new THREE.Object3D();
			}
			const cacheKey = `${node.id}:${node.shortLabel || node.label}:${labelColor}:${isSelected ? 'selected' : 'plain'}`;
			const cached = labelCacheRef.current.get(cacheKey);
			if (cached) {
				return cached;
			}
			const group = new THREE.Group();
			if (isSelected) {
				group.add(createSelectedNodeOutline());
			}
			if (shouldShowLabel) {
				group.add(createTextSprite(node.shortLabel || node.label, labelColor));
			}
			labelCacheRef.current.set(cacheKey, group);
			return group;
		});
		graph.linkLabel((edge: KnowledgeGraphEdge) => `${edge.type} · ${edge.weight} · ${edge.commitCount}`);
		graph.linkColor((edge: KnowledgeGraphEdge) => resolveEdgeGraphColor(edge));
		graph.linkOpacity(viewState.lightweightMode ? 0.18 : 0.28);
		graph.linkDirectionalArrowLength((edge: KnowledgeGraphEdge) => {
			if (viewState.lightweightMode && !pathEdgeIds.has(edge.id) && viewState.selectedEdgeId !== edge.id) {
				return 0;
			}
			return pathEdgeIds.has(edge.id) || viewState.selectedEdgeId === edge.id ? 4.5 : 1.6;
		});
		graph.linkDirectionalArrowRelPos(0.88);
		graph.linkDirectionalParticles(() => 0);
		graph.linkDirectionalParticleWidth(1.8);
		graph.linkDirectionalParticleSpeed(0);
		graph.refresh();
		minimapDrawRef.current?.();
	}, [resolveEdgeGraphColor, resolveNodeGraphColor, sceneStatus, shouldShowNodeLabel, pathEdgeIds, pathNodeIds, viewState.colorMode, viewState.labelsMode, viewState.lightweightMode, viewState.renderMode, viewState.selectedEdgeId, viewState.selectedNodeId, visibleData]);

	useEffect(() => {
		const graph = graphRef.current;
		if (!graph || !visibleData) {
			return;
		}
		const nextNodes = visibleData.nodes.map(node => {
			const pinned = viewState.pinnedNodes[node.id];
			const seeded = pinned || staticLayout[node.id] || seedClusterPosition(node, viewState.clusterMode, clusterKeys);
			positionCacheRef.current[node.id] = { x: seeded.x, y: seeded.y, z: seeded.z };
			return {
				...node,
				x: seeded.x,
				y: seeded.y,
				z: seeded.z,
				fx: seeded.x,
				fy: seeded.y,
				fz: seeded.z,
			};
		});
		const nextLinks = visibleData.edges.map(edge => ({ ...edge }));
		graph.graphData({ nodes: nextNodes, links: nextLinks });
		if (shouldAutoFitRef.current) {
			graph.zoomToFit(0, 70);
			shouldAutoFitRef.current = false;
		}
		graph.refresh();
		minimapDrawRef.current?.();
	}, [clusterKeys, sceneStatus, staticLayout, viewState.clusterMode, viewState.pinnedNodes, viewState.renderMode, visibleData]);

	useEffect(() => {
		if (!visibleData || viewState.renderMode !== '2d' || !shouldAutoFitRef.current) {
			return;
		}
		setGraph2DViewport({ zoom: 1, panX: 0, panY: 0 });
		shouldAutoFitRef.current = false;
	}, [viewState.renderMode, visibleData]);

	useEffect(() => {
		const graph = graphRef.current;
		if (!graph || !viewState.cameraState) {
			return;
		}
		const controls = graph.controls();
		const camera = graph.camera();
		const samePosition = Math.abs(camera.position.x - viewState.cameraState.position.x) < 0.5
			&& Math.abs(camera.position.y - viewState.cameraState.position.y) < 0.5
			&& Math.abs(camera.position.z - viewState.cameraState.position.z) < 0.5;
		const sameTarget = Math.abs(controls.target.x - viewState.cameraState.target.x) < 0.5
			&& Math.abs(controls.target.y - viewState.cameraState.target.y) < 0.5
			&& Math.abs(controls.target.z - viewState.cameraState.target.z) < 0.5;
		if (samePosition && sameTarget) {
			return;
		}
		graph.cameraPosition(viewState.cameraState.position, viewState.cameraState.target, 0);
		controls.target.set(viewState.cameraState.target.x, viewState.cameraState.target.y, viewState.cameraState.target.z);
		controls.update();
	}, [viewState.cameraState]);

	useEffect(() => {
		const canvas = graph2DCanvasRef.current;
		if (!canvas || !visibleData || !graph2DTransform) {
			graph2DNodePointsRef.current = [];
			graph2DTransformRef.current = graph2DTransform;
			return;
		}
		graph2DTransformRef.current = graph2DTransform;
		const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
		canvas.width = Math.max(1, Math.floor(graph2DTransform.width * dpr));
		canvas.height = Math.max(1, Math.floor(graph2DTransform.height * dpr));
		const context = canvas.getContext('2d');
		if (!context) {
			return;
		}
		context.setTransform(dpr, 0, 0, dpr, 0, 0);
		context.clearRect(0, 0, graph2DTransform.width, graph2DTransform.height);
		context.fillStyle = resolveColor('--vscode-editor-background', '#0f172a');
		context.fillRect(0, 0, graph2DTransform.width, graph2DTransform.height);

		graph2DNodePointsRef.current = visibleData.nodes
			.map(node => {
				const position = staticLayout[node.id];
				if (!position) {
					return null;
				}
				const projected = project2DPoint(position, graph2DTransform);
				const emphasis = connectedNodeIds.has(node.id) || pathNodeIds.has(node.id) || viewState.selectedNodeId === node.id;
				return {
					id: node.id,
					x: projected.x,
					y: projected.y,
					radius: node.kind === 'layer' ? 10 : node.kind === 'file' ? 7 : 5,
					node,
					emphasis,
				};
			})
			.filter((point): point is Graph2DNodePoint & { emphasis: boolean } => Boolean(point));
		const pointById = new Map(graph2DNodePointsRef.current.map(point => [point.id, point]));

		for (const edge of visibleData.edges) {
			const sourcePoint = pointById.get(endpointId(edge.source));
			const targetPoint = pointById.get(endpointId(edge.target));
			if (!sourcePoint || !targetPoint) {
				continue;
			}
			context.beginPath();
			context.strokeStyle = resolveEdgeGraphColor(edge);
			context.globalAlpha = connectedEdgeIds.has(edge.id) || pathEdgeIds.has(edge.id) || viewState.selectedEdgeId === edge.id ? 0.95 : 0.32;
			context.lineWidth = connectedEdgeIds.has(edge.id) || pathEdgeIds.has(edge.id) || viewState.selectedEdgeId === edge.id ? 2.8 : 1.1;
			context.moveTo(sourcePoint.x, sourcePoint.y);
			context.lineTo(targetPoint.x, targetPoint.y);
			context.stroke();
		}
		context.globalAlpha = 1;

		for (const point of graph2DNodePointsRef.current) {
			context.beginPath();
			context.fillStyle = resolveNodeGraphColor(point.node);
			context.arc(point.x, point.y, point.radius + (point.emphasis ? 1.5 : 0), 0, Math.PI * 2);
			context.fill();
			if (viewState.selectedNodeId === point.id) {
				context.strokeStyle = '#ffffff';
				context.lineWidth = 1.5;
				context.stroke();
				context.beginPath();
				context.arc(point.x, point.y, point.radius + 4.2, 0, Math.PI * 2);
				context.strokeStyle = '#f97316';
				context.lineWidth = 1.5;
				context.stroke();
			} else if (point.emphasis) {
				context.strokeStyle = '#f8fafc';
				context.lineWidth = 1.5;
				context.stroke();
			}
		}

		for (const point of graph2DNodePointsRef.current) {
			if (!shouldShowNodeLabel(point.node)) {
				continue;
			}
			drawCanvasLabel(context, point.node.shortLabel || point.node.label, point.x, point.y, point.emphasis);
		}
	}, [connectedEdgeIds, connectedNodeIds, graph2DTransform, pathEdgeIds, pathNodeIds, resolveEdgeGraphColor, resolveNodeGraphColor, shouldShowNodeLabel, staticLayout, viewState.renderMode, viewState.selectedEdgeId, viewState.selectedNodeId, visibleData]);

	useEffect(() => {
		if (visibleData) {
			minimapDrawRef.current?.();
		}
	}, [visibleData, viewState.selectedNodeId]);

	const openSaveCurrentViewDialog = () => {
		setSaveViewName('');
		setIsSaveViewDialogOpen(true);
	};

	const closeSaveCurrentViewDialog = () => {
		setIsSaveViewDialogOpen(false);
		setSaveViewName('');
	};

	const saveCurrentView = () => {
		const name = saveViewName.trim();
		if (!name) {
			return;
		}
		const nextView: SavedGraphView = {
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			name,
			createdAt: new Date().toISOString(),
			state: sanitizeViewStateForSave(viewState),
		};
		setSavedViews(current => [...current.filter(item => item.name !== name), nextView]);
		setSelectedSavedViewId(nextView.id);
		closeSaveCurrentViewDialog();
	};

	const applySavedView = () => {
		const savedView = savedViews.find(item => item.id === selectedSavedViewId);
		if (!savedView) {
			return;
		}
		setViewState(current => ({
			...current,
			...savedView.state,
			selectedNodeId: undefined,
			selectedEdgeId: undefined,
			traceAnchorId: undefined,
			timelineAutoplay: false,
		}));
		shouldAutoFitRef.current = false;
	};

	const deleteSavedView = () => {
		if (!selectedSavedViewId) {
			return;
		}
		setSavedViews(current => current.filter(item => item.id !== selectedSavedViewId));
		setSelectedSavedViewId('');
	};

	const handleMinimapClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
		const rect = event.currentTarget.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const y = event.clientY - rect.top;
		const nearest = minimapPointsRef.current.reduce<{ point?: MinimapPoint; distance: number }>((closest, point) => {
			const distance = Math.hypot(point.x - x, point.y - y);
			if (distance < closest.distance) {
				return { point, distance };
			}
			return closest;
		}, { distance: Number.POSITIVE_INFINITY });
		if (!nearest.point || nearest.distance > 20) {
			return;
		}
		setViewState(current => ({ ...current, selectedNodeId: nearest.point?.id, selectedEdgeId: undefined }));
	};

	const reset2DViewport = useCallback(() => {
		scheduleGraph2DViewport({ zoom: 1, panX: 0, panY: 0 });
	}, [scheduleGraph2DViewport]);

	const fitGraphView = useCallback(() => {
		if (viewState.renderMode === '2d') {
			reset2DViewport();
			return;
		}
		graphRef.current?.zoomToFit(0, 70);
	}, [reset2DViewport, viewState.renderMode]);

	const handleGraph2DPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		setGraph2DCursor('grabbing');
		graph2DPointerRef.current = {
			dragging: true,
			moved: false,
			startX: event.clientX,
			startY: event.clientY,
			startPanX: graph2DViewport.panX,
			startPanY: graph2DViewport.panY,
			button: event.button,
		};
	};

	const handleGraph2DPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
		if (!graph2DPointerRef.current.dragging) {
			const rect = event.currentTarget.getBoundingClientRect();
			const moveX = event.clientX - rect.left;
			const moveY = event.clientY - rect.top;
			const nearest = graph2DNodePointsRef.current.reduce<{ point?: Graph2DNodePoint; distance: number }>((closest, point) => {
				const distance = Math.hypot(point.x - moveX, point.y - moveY);
				if (distance < closest.distance) {
					return { point, distance };
				}
				return closest;
			}, { distance: Number.POSITIVE_INFINITY });
			setGraph2DCursor(nearest.point && nearest.distance <= Math.max(12, nearest.point.radius + 8) ? 'pointer' : 'grab');
			return;
		}
		const deltaX = event.clientX - graph2DPointerRef.current.startX;
		const deltaY = event.clientY - graph2DPointerRef.current.startY;
		if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
			graph2DPointerRef.current.moved = true;
		}
		const dragSensitivity = sensitivityForPointerButton(graph2DPointerRef.current.button || 0, viewState);
		scheduleGraph2DViewport({
			zoom: graph2DViewport.zoom,
			panX: graph2DPointerRef.current.startPanX + (deltaX * dragSensitivity),
			panY: graph2DPointerRef.current.startPanY + (deltaY * dragSensitivity),
		});
	};

	const handleGraph2DPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
		if (!graph2DPointerRef.current.dragging) {
			return;
		}
		event.currentTarget.releasePointerCapture(event.pointerId);
		const moved = graph2DPointerRef.current.moved;
		graph2DPointerRef.current.dragging = false;
		setGraph2DCursor('grab');
		if (moved) {
			return;
		}
		const rect = event.currentTarget.getBoundingClientRect();
		const clickX = event.clientX - rect.left;
		const clickY = event.clientY - rect.top;
		const nearest = graph2DNodePointsRef.current.reduce<{ point?: Graph2DNodePoint; distance: number }>((closest, point) => {
			const distance = Math.hypot(point.x - clickX, point.y - clickY);
			if (distance < closest.distance) {
				return { point, distance };
			}
			return closest;
		}, { distance: Number.POSITIVE_INFINITY });
		if (nearest.point && nearest.distance <= Math.max(12, nearest.point.radius + 8)) {
			setViewState(current => ({ ...current, selectedNodeId: nearest.point?.id, selectedEdgeId: undefined }));
			return;
		}
		setViewState(current => ({ ...current, selectedNodeId: undefined, selectedEdgeId: undefined }));
	};

	const handleGraph2DWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
		event.preventDefault();
		const transform = graph2DTransformRef.current;
		if (!transform) {
			return;
		}
		const rect = event.currentTarget.getBoundingClientRect();
		const mouseX = event.clientX - rect.left;
		const mouseY = event.clientY - rect.top;
		const worldBefore = unproject2DPoint(mouseX, mouseY, transform);
		const nextZoom = clamp(graph2DViewport.zoom * Math.exp(-event.deltaY * 0.0052 * viewState.zoomSensitivity), 0.35, 6);
		const nextTransform = {
			...transform,
			zoom: nextZoom,
		};
		const projectedAfter = project2DPoint({ x: worldBefore.x, y: 0, z: worldBefore.z }, nextTransform);
		scheduleGraph2DViewport({
			zoom: nextZoom,
			panX: graph2DViewport.panX + (mouseX - projectedAfter.x),
			panY: graph2DViewport.panY + (mouseY - projectedAfter.y),
		});
	};

	const timelineCaption = timelinePoints.length > 0
		? `${timelinePoints[viewState.timelineStartIndex]?.label || '—'} - ${timelinePoints[viewState.timelineEndIndex]?.label || '—'}`
		: t('memory.graphTimelineEmpty');

	const resetGraphFilters = () => {
		shouldAutoFitRef.current = true;
		reset2DViewport();
		setViewState(current => ({
			...DEFAULT_VIEW_STATE,
			cameraState: current.cameraState,
			timelineEndIndex: Math.max(0, timelinePoints.length - 1),
		}));
	};

	if (!data || (data.nodes.length === 0 && data.edges.length === 0)) {
		return <div style={styles.empty}>{t('memory.noGraphData')}</div>;
	}

	if (viewState.renderMode === '3d' && webglError) {
		return <div style={styles.error}>{t('memory.graphWebglError')}: {webglError}</div>;
	}

	const filteredOutAllNodes = Boolean(data && visibleData && data.nodes.length > 0 && visibleData.nodes.length === 0);

	return (
		<div style={styles.shell}>
			<div style={styles.toolbar}>
				<div style={styles.controlsRow}>
					{repositories.length > 1 && (
						<select style={styles.select} value={viewState.selectedRepo} onChange={event => setViewState(current => ({ ...current, selectedRepo: event.target.value }))}>
							<option value="">{t('memory.allRepositories')}</option>
							{repositories.map(repository => <option key={repository} value={repository}>{repository}</option>)}
						</select>
					)}
					<input style={styles.search} value={viewState.searchQuery} placeholder={t('memory.graphSearchPlaceholder')} onChange={event => setViewState(current => ({ ...current, searchQuery: event.target.value }))} />
					<select style={styles.select} value={viewState.kindFilter} onChange={event => setViewState(current => ({ ...current, kindFilter: event.target.value as KindFilter }))}>
						<option value="all">{t('memory.graphKindAll')}</option>
						<option value="layer">{t('memory.graphKindLayer')}</option>
						<option value="file">{t('memory.graphKindFile')}</option>
						<option value="component">{t('memory.graphKindComponent')}</option>
					</select>
					<select style={styles.select} value={viewState.layerFilter} onChange={event => setViewState(current => ({ ...current, layerFilter: event.target.value as LayerFilter }))}>
						<option value="all">{t('memory.graphLayerAll')}</option>
						{data.summary.layers.map(layer => <option key={layer} value={layer}>{layer}</option>)}
					</select>
					<select style={styles.select} value={viewState.relationFilter} onChange={event => setViewState(current => ({ ...current, relationFilter: event.target.value }))}>
						<option value="all">{t('memory.graphRelationAll')}</option>
						{data.summary.relationTypes.map(relation => <option key={relation} value={relation}>{relation}</option>)}
					</select>
				</div>

				<div style={styles.controlsRow}>
					<label style={styles.rangeLabel}>
						<span>{t('memory.graphMinWeight')}: {viewState.minWeight}</span>
						<input type="range" min={1} max={Math.max(1, data.summary.maxEdgeWeight || 1)} value={viewState.minWeight} onChange={event => setViewState(current => ({ ...current, minWeight: Number(event.target.value) }))} />
					</label>
					<select style={styles.select} value={String(viewState.focusDepth)} onChange={event => setViewState(current => ({ ...current, focusDepth: Number(event.target.value) as FocusDepth }))}>
						<option value="0">{t('memory.graphFocusDepthAll')}</option>
						<option value="1">{t('memory.graphFocusDepthOne')}</option>
						<option value="2">{t('memory.graphFocusDepthTwo')}</option>
					</select>
					<select style={styles.select} value={viewState.labelsMode} onChange={event => setViewState(current => ({ ...current, labelsMode: event.target.value as LabelsMode }))}>
						<option value="focus">{t('memory.graphLabelsFocus')}</option>
						<option value="dense">{t('memory.graphLabelsDense')}</option>
						<option value="off">{t('memory.graphLabelsOff')}</option>
					</select>
					<select style={styles.select} value={viewState.clusterMode} onChange={event => setViewState(current => ({ ...current, clusterMode: event.target.value as ClusterMode }))}>
						<option value="none">{t('memory.graphClusterNone')}</option>
						<option value="layer">{t('memory.graphClusterLayer')}</option>
						<option value="repository">{t('memory.graphClusterRepository')}</option>
						<option value="kind">{t('memory.graphClusterKind')}</option>
					</select>
					<select style={styles.select} value={viewState.colorMode} onChange={event => setViewState(current => ({ ...current, colorMode: event.target.value as ColorMode }))}>
						<option value="kind">{t('memory.graphColorKind')}</option>
						<option value="risk">{t('memory.graphColorRisk')}</option>
						<option value="impact">{t('memory.graphColorImpact')}</option>
					</select>
					<select style={styles.select} value={viewState.renderMode} onChange={event => setViewState(current => ({ ...current, renderMode: event.target.value as GraphRenderMode }))}>
						<option value="2d">{t('memory.graphMode2D')}</option>
						<option value="3d">{t('memory.graphMode3D')}</option>
					</select>
					<div style={styles.sensitivityBox}>
						<label style={styles.sensitivityItem}>
							<span>{t('memory.graphSensitivityLMB')}: {viewState.leftDragSensitivity.toFixed(1)}</span>
							<input type="range" min={0.4} max={2.5} step={0.1} value={viewState.leftDragSensitivity} onChange={event => setViewState(current => ({ ...current, leftDragSensitivity: Number(event.target.value) }))} />
						</label>
						<label style={styles.sensitivityItem}>
							<span>{t('memory.graphSensitivityRMB')}: {viewState.rightDragSensitivity.toFixed(1)}</span>
							<input type="range" min={0.4} max={2.5} step={0.1} value={viewState.rightDragSensitivity} onChange={event => setViewState(current => ({ ...current, rightDragSensitivity: Number(event.target.value) }))} />
						</label>
						<label style={styles.sensitivityItem}>
							<span>{t('memory.graphSensitivityMMB')}: {viewState.middleDragSensitivity.toFixed(1)}</span>
							<input type="range" min={0.4} max={2.5} step={0.1} value={viewState.middleDragSensitivity} onChange={event => setViewState(current => ({ ...current, middleDragSensitivity: Number(event.target.value) }))} />
						</label>
						<label style={styles.sensitivityItem}>
							<span>{t('memory.graphSensitivityZoom')}: {viewState.zoomSensitivity.toFixed(1)}</span>
							<input type="range" min={0.4} max={2.8} step={0.1} value={viewState.zoomSensitivity} onChange={event => setViewState(current => ({ ...current, zoomSensitivity: Number(event.target.value) }))} />
						</label>
					</div>
					<button style={memoryButtonStyles.secondary} onClick={() => setViewState(current => ({ ...current, lightweightMode: !current.lightweightMode }))}>
						{viewState.lightweightMode ? t('memory.graphLightweightOn') : t('memory.graphLightweightOff')}
					</button>
					<button style={memoryButtonStyles.secondary} onClick={() => setViewState(current => ({ ...current, overviewMode: !current.overviewMode }))}>
						{viewState.overviewMode ? t('memory.graphOverviewOn') : t('memory.graphOverviewOff')}
					</button>
					<button style={memoryButtonStyles.secondary} onClick={() => setViewState(current => ({ ...current, minimapVisible: !current.minimapVisible }))}>
						{viewState.minimapVisible ? t('memory.graphMinimapOn') : t('memory.graphMinimapOff')}
					</button>
				</div>

				<div style={styles.controlsRow}>
					<div style={styles.timelineBox}>
						<div style={styles.timelineMeta}>{t('memory.graphTimeline')}: {timelineCaption}</div>
						<label style={styles.timelineRangeLabel}>
							<span>{t('memory.graphTimelineStart')}</span>
							<input type="range" min={0} max={Math.max(0, timelinePoints.length - 1)} value={viewState.timelineStartIndex} onChange={event => setViewState(current => ({ ...current, timelineStartIndex: Math.min(Number(event.target.value), current.timelineEndIndex), timelineAutoplay: false }))} />
						</label>
						<label style={styles.timelineRangeLabel}>
							<span>{t('memory.graphTimelineEnd')}</span>
							<input type="range" min={0} max={Math.max(0, timelinePoints.length - 1)} value={viewState.timelineEndIndex} onChange={event => setViewState(current => ({ ...current, timelineEndIndex: Math.max(Number(event.target.value), current.timelineStartIndex), timelineAutoplay: false }))} />
						</label>
						<label style={styles.checkboxLabel}>
							<input type="checkbox" checked={viewState.timelineOnlyNew} onChange={event => setViewState(current => ({ ...current, timelineOnlyNew: event.target.checked }))} />
							<span>{t('memory.graphTimelineNewOnly')}</span>
						</label>
						<button style={memoryButtonStyles.secondary} onClick={toggleTimelineAutoplay} disabled={timelinePoints.length < 2}>
							{viewState.timelineAutoplay ? t('memory.graphTimelinePause') : t('memory.graphTimelinePlay')}
						</button>
					</div>
					<div style={styles.savedViewsBox}>
						<select style={styles.select} value={selectedSavedViewId} onChange={event => setSelectedSavedViewId(event.target.value)}>
							<option value="">{t('memory.graphSavedViews')}</option>
							{savedViews.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
						</select>
						<button style={memoryButtonStyles.secondary} onClick={openSaveCurrentViewDialog}>{t('memory.graphSaveView')}</button>
						<button style={memoryButtonStyles.secondary} onClick={applySavedView} disabled={!selectedSavedViewId}>{t('memory.graphLoadView')}</button>
						<button style={memoryButtonStyles.secondary} onClick={deleteSavedView} disabled={!selectedSavedViewId}>{t('memory.graphDeleteView')}</button>
					</div>
				</div>

				<div style={styles.statusRow}>
					<span>{t('memory.graphVisible')}: {stats.nodes}/{stats.totalNodes}</span>
					<span>{t('memory.graphHidden')}: {stats.hiddenNodes}</span>
					<span>{t('memory.graphEdges')}: {stats.edges}/{stats.totalEdges}</span>
					<span>{t('memory.graphImpact')}: {visibleData?.summary.totalImpact || 0}</span>
					{pathNodeIds.size > 1 && <span>{t('memory.graphPathLength')}: {pathNodeIds.size - 1}</span>}
					<button style={memoryButtonStyles.secondary} onClick={fitGraphView}>{t('memory.graphFit')}</button>
					<button style={memoryButtonStyles.secondary} onClick={() => {
						shouldAutoFitRef.current = true;
						reset2DViewport();
						setViewState(current => ({
							...current,
							searchQuery: '',
							kindFilter: 'all',
							layerFilter: 'all',
							relationFilter: 'all',
							minWeight: 1,
							focusDepth: 0,
							traceAnchorId: undefined,
							selectedNodeId: undefined,
							selectedEdgeId: undefined,
							cameraState: undefined,
							timelineOnlyNew: false,
							timelineAutoplay: false,
							pinnedNodes: {},
						}));
					}}>{t('memory.graphResetView')}</button>
					<button style={memoryButtonStyles.secondary} onClick={() => onRequestGraph(viewState.selectedRepo || undefined)}>↻ {t('memory.refresh')}</button>
				</div>
			</div>

			<div style={viewState.overviewMode ? styles.bodyOverview : styles.body}>
				<div ref={sceneWrapRef} style={styles.sceneWrap}>
					<div style={styles.legendOverlay}>
						<div style={styles.legendTitle}>{t('memory.graphLegendTitle')}</div>
						<div style={styles.legendList}>
							{legendItems.map(item => (
								<div key={`${item.color}-${item.label}`} style={styles.legendItem}>
									<span style={{ ...styles.legendSwatch, background: item.color }} />
									<span>{item.label}</span>
								</div>
							))}
						</div>
					</div>
					<div ref={setGraphContainerElement} style={{ ...styles.scene, display: viewState.renderMode === '3d' ? 'block' : 'none' }} />
					<canvas
						ref={graph2DCanvasRef}
						style={{ ...styles.sceneCanvas2D, display: viewState.renderMode === '2d' ? 'block' : 'none' }}
						onPointerDown={handleGraph2DPointerDown}
						onPointerMove={handleGraph2DPointerMove}
						onPointerUp={handleGraph2DPointerUp}
						onPointerLeave={handleGraph2DPointerUp}
						onWheel={handleGraph2DWheel}
						onContextMenu={event => event.preventDefault()}
					/>
					{viewState.renderMode === '3d' && sceneStatus !== 'ready' && !webglError && (
						<div style={styles.sceneDebugBadge}>
							3D init: {sceneStatus}
						</div>
					)}
					{filteredOutAllNodes && (
						<div style={styles.emptyOverlay}>
							<div style={styles.emptyOverlayCard}>
								<div style={styles.emptyOverlayTitle}>{t('memory.graphNoVisibleNodes')}</div>
								<div style={styles.emptyOverlayText}>{t('memory.graphNoVisibleNodesHint')}</div>
								<button style={memoryButtonStyles.primary} onClick={resetGraphFilters}>{t('memory.graphResetFilters')}</button>
							</div>
						</div>
					)}
					{viewState.minimapVisible && (
						<canvas ref={minimapRef} width={220} height={140} style={styles.minimap} onClick={handleMinimapClick} />
					)}
				</div>
				{!viewState.overviewMode && (
					<div style={styles.inspector}>
						<div style={styles.inspectorHeader}>{t('memory.graphInspector')}</div>
						{selectedNode ? (
							<div style={styles.panelSection}>
								<div style={styles.entityTitle}>{selectedNode.label}</div>
								<div style={styles.badges}>
									<span style={styles.badge}>{selectedNode.kind}</span>
									{selectedNode.layer && <span style={styles.badge}>{selectedNode.layer}</span>}
									<span style={styles.badge}>{t('memory.graphCommits')}: {selectedNode.commitCount}</span>
								</div>
								<div style={styles.inspectorActions}>
									<button style={memoryButtonStyles.secondary} onClick={() => setViewState(current => {
										const pinnedNodes = { ...current.pinnedNodes };
										if (pinnedNodes[selectedNode.id]) {
											delete pinnedNodes[selectedNode.id];
										} else if (typeof selectedNode.x === 'number' && typeof selectedNode.y === 'number' && typeof selectedNode.z === 'number') {
											pinnedNodes[selectedNode.id] = { x: selectedNode.x, y: selectedNode.y, z: selectedNode.z };
										}
										return { ...current, pinnedNodes };
									})}>{viewState.pinnedNodes[selectedNode.id] ? t('memory.graphUnpin') : t('memory.graphPin')}</button>
									<button style={memoryButtonStyles.secondary} onClick={() => setViewState(current => ({ ...current, traceAnchorId: selectedNode.id }))}>{t('memory.graphTraceStart')}</button>
									{viewState.traceAnchorId && <button style={memoryButtonStyles.secondary} onClick={() => setViewState(current => ({ ...current, traceAnchorId: undefined }))}>{t('memory.graphTraceClear')}</button>}
								</div>
								<div style={styles.metaList}>
									<div><strong>{t('memory.graphImpact')}:</strong> {selectedNode.impactScore}</div>
									<div><strong>{t('memory.graphRisk')}:</strong> {Math.round(scoreNodeRisk(selectedNode, visibleData?.summary || data.summary) * 100)}%</div>
									<div><strong>{t('memory.graphBreaking')}:</strong> {selectedNode.breakingChangeCount}</div>
									{selectedNode.repository && <div><strong>{t('memory.graphRepository')}:</strong> {selectedNode.repository}</div>}
									{selectedNode.filePath && <div><strong>{t('memory.graphFile')}:</strong> {selectedNode.filePath}</div>}
									{selectedNode.firstSeenAt && <div><strong>{t('memory.graphFirstSeen')}:</strong> {new Date(selectedNode.firstSeenAt).toLocaleString()}</div>}
									{selectedNode.lastSeenAt && <div><strong>{t('memory.graphLastSeen')}:</strong> {new Date(selectedNode.lastSeenAt).toLocaleString()}</div>}
									{selectedNode.businessDomains.length > 0 && <div><strong>{t('memory.graphDomains')}:</strong> {selectedNode.businessDomains.join(', ')}</div>}
									{selectedNode.categories.length > 0 && <div><strong>{t('memory.graphCategories')}:</strong> {selectedNode.categories.join(', ')}</div>}
								</div>
								{selectedNode.relatedFiles.length > 0 && <div style={styles.listSection}><div style={styles.sectionTitle}>{t('memory.graphRelatedFiles')}</div><div style={styles.pillList}>{selectedNode.relatedFiles.slice(0, 12).map(file => <span key={file} style={styles.pill}>{file}</span>)}</div></div>}
								{selectedNode.relatedComponents.length > 0 && <div style={styles.listSection}><div style={styles.sectionTitle}>{t('memory.graphRelatedComponents')}</div><div style={styles.pillList}>{selectedNode.relatedComponents.slice(0, 12).map(component => <span key={component} style={styles.pill}>{component}</span>)}</div></div>}
							</div>
						) : selectedEdge ? (
							<div style={styles.panelSection}>
								<div style={styles.entityTitle}>{selectedEdge.type}</div>
								<div style={styles.badges}>
									<span style={styles.badge}>{t('memory.graphWeight')}: {selectedEdge.weight}</span>
									<span style={styles.badge}>{t('memory.graphStrength')}: {selectedEdge.strength}</span>
									<span style={styles.badge}>{t('memory.graphCommits')}: {selectedEdge.commitCount}</span>
								</div>
								<div style={styles.metaList}>
									<div><strong>{t('memory.graphRisk')}:</strong> {Math.round(scoreEdgeRisk(selectedEdge, visibleData?.summary || data.summary) * 100)}%</div>
									<div><strong>{t('memory.graphRepositories')}:</strong> {selectedEdge.repositories.join(', ') || '—'}</div>
									<div><strong>{t('memory.graphLayers')}:</strong> {selectedEdge.layers.join(', ') || '—'}</div>
									{selectedEdge.firstSeenAt && <div><strong>{t('memory.graphFirstSeen')}:</strong> {new Date(selectedEdge.firstSeenAt).toLocaleString()}</div>}
									{selectedEdge.lastSeenAt && <div><strong>{t('memory.graphLastSeen')}:</strong> {new Date(selectedEdge.lastSeenAt).toLocaleString()}</div>}
								</div>
								{selectedEdge.relatedFiles.length > 0 && <div style={styles.listSection}><div style={styles.sectionTitle}>{t('memory.graphRelatedFiles')}</div><div style={styles.pillList}>{selectedEdge.relatedFiles.slice(0, 12).map(file => <span key={file} style={styles.pill}>{file}</span>)}</div></div>}
							</div>
						) : (
							<div style={styles.placeholder}>{t('memory.graphSelectionEmpty')}</div>
						)}
						<div style={styles.panelSection}>
							<div style={styles.sectionTitle}>{t('memory.graphQuickActions')}</div>
							<div style={styles.inspectorActions}>
								<button style={memoryButtonStyles.secondary} onClick={() => setViewState(current => ({ ...current, pinnedNodes: {} }))}>{t('memory.graphClearPins')}</button>
								<button style={memoryButtonStyles.secondary} onClick={fitGraphView}>{t('memory.graphFit')}</button>
							</div>
						</div>
					</div>
				)}
			</div>
			{isSaveViewDialogOpen && (
				<div style={styles.dialogBackdrop} onClick={closeSaveCurrentViewDialog}>
					<div style={styles.dialog} onClick={event => event.stopPropagation()}>
						<div style={styles.dialogTitle}>{t('memory.graphSaveView')}</div>
						<div style={styles.dialogText}>{t('memory.graphSaveViewPrompt')}</div>
						<form
							style={styles.dialogForm}
							onSubmit={(event) => {
								event.preventDefault();
								saveCurrentView();
							}}
						>
							<input
								ref={saveViewNameInputRef}
								style={styles.dialogInput}
								value={saveViewName}
								placeholder={t('memory.graphSaveViewPrompt')}
								onChange={event => setSaveViewName(event.target.value)}
							/>
							<div style={styles.dialogActions}>
								<button type="button" style={memoryButtonStyles.secondary} onClick={closeSaveCurrentViewDialog}>{t('common.cancel')}</button>
								<button type="submit" style={{ ...memoryButtonStyles.primary, ...(!saveViewName.trim() ? memoryButtonStyles.disabled : {}) }} disabled={!saveViewName.trim()}>{t('common.save')}</button>
							</div>
						</form>
					</div>
				</div>
			)}
		</div>
	);
};

const panelBorder = '1px solid color-mix(in srgb, var(--vscode-panel-border) 76%, transparent)';

const styles: Record<string, React.CSSProperties> = {
	shell: {
		display: 'flex',
		flexDirection: 'column',
		height: '100%',
		padding: '16px',
		gap: '12px',
		background: 'var(--vscode-editor-background)',
	},
	toolbar: {
		display: 'flex',
		flexDirection: 'column',
		gap: '10px',
		padding: '12px',
		borderRadius: '12px',
		border: panelBorder,
		background: 'var(--vscode-sideBar-background)',
	},
	controlsRow: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' },
	sensitivityBox: {
		display: 'flex',
		gap: '8px',
		flexWrap: 'wrap',
		alignItems: 'stretch',
		padding: '8px 10px',
		borderRadius: '10px',
		border: panelBorder,
		background: 'var(--vscode-editorWidget-background)',
	},
	sensitivityItem: {
		display: 'flex',
		flexDirection: 'column',
		gap: '4px',
		minWidth: '88px',
		fontSize: '11px',
		color: 'var(--vscode-descriptionForeground)',
	},
	statusRow: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center', fontSize: '12px', color: 'var(--vscode-descriptionForeground)' },
	select: {
		background: 'var(--vscode-input-background)',
		color: 'var(--vscode-input-foreground)',
		border: '1px solid var(--vscode-input-border)',
		borderRadius: '8px',
		padding: '7px 10px',
		fontSize: '12px',
		minWidth: '132px',
	},
	search: {
		background: 'var(--vscode-input-background)',
		color: 'var(--vscode-input-foreground)',
		border: '1px solid var(--vscode-input-border)',
		borderRadius: '8px',
		padding: '7px 10px',
		fontSize: '12px',
		minWidth: '180px',
		maxWidth: '320px',
		flex: '0 1 220px',
	},
	rangeLabel: { display: 'flex', alignItems: 'center', gap: '8px', padding: '0 4px', fontSize: '12px', color: 'var(--vscode-descriptionForeground)' },
	checkboxLabel: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--vscode-descriptionForeground)' },
	timelineBox: {
		display: 'grid',
		gridTemplateColumns: 'minmax(150px, auto) minmax(160px, 1fr) minmax(160px, 1fr) auto auto',
		gap: '8px 10px',
		alignItems: 'center',
		flex: '1 1 680px',
		padding: '8px 10px',
		borderRadius: '10px',
		border: panelBorder,
		background: 'var(--vscode-editorWidget-background)',
	},
	timelineHeader: { display: 'contents' },
	timelineMeta: { fontSize: '12px', color: 'var(--vscode-foreground)', whiteSpace: 'nowrap' },
	timelineRangeLabel: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--vscode-descriptionForeground)' },
	savedViewsBox: {
		display: 'flex',
		gap: '8px',
		flexWrap: 'wrap',
		alignItems: 'center',
		padding: '8px 10px',
		borderRadius: '10px',
		border: panelBorder,
		background: 'var(--vscode-editorWidget-background)',
	},
	dialogBackdrop: {
		position: 'absolute',
		inset: 0,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: '20px',
		background: 'color-mix(in srgb, var(--vscode-editor-background) 72%, transparent)',
		backdropFilter: 'blur(4px)',
		zIndex: 30,
	},
	dialog: {
		width: 'min(420px, 100%)',
		display: 'flex',
		flexDirection: 'column',
		gap: '10px',
		padding: '18px',
		borderRadius: '14px',
		border: panelBorder,
		background: 'var(--vscode-editorWidget-background)',
		boxShadow: '0 20px 60px rgba(0, 0, 0, 0.28)',
	},
	dialogTitle: {
		fontSize: '15px',
		fontWeight: 700,
		color: 'var(--vscode-foreground)',
	},
	dialogText: {
		fontSize: '12px',
		color: 'var(--vscode-descriptionForeground)',
	},
	dialogForm: {
		display: 'flex',
		flexDirection: 'column',
		gap: '12px',
	},
	dialogInput: {
		background: 'var(--vscode-input-background)',
		color: 'var(--vscode-input-foreground)',
		border: '1px solid var(--vscode-input-border)',
		borderRadius: '8px',
		padding: '10px 12px',
		fontSize: '13px',
		outline: 'none',
	},
	dialogActions: {
		display: 'flex',
		justifyContent: 'flex-end',
		gap: '8px',
		flexWrap: 'wrap',
	},
	body: { flex: 1, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: '12px', minHeight: 0 },
	bodyOverview: { flex: 1, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '12px', minHeight: 0 },
	sceneWrap: {
		position: 'relative',
		minHeight: 0,
		borderRadius: '14px',
		overflow: 'hidden',
		border: panelBorder,
		background: 'var(--vscode-editor-background)',
	},
	legendOverlay: {
		position: 'absolute',
		left: '14px',
		top: '14px',
		zIndex: 2,
		display: 'flex',
		flexDirection: 'column',
		gap: '8px',
		maxWidth: '220px',
		padding: '10px 12px',
		borderRadius: '12px',
		border: panelBorder,
		background: 'color-mix(in srgb, var(--vscode-editorWidget-background) 88%, transparent)',
		backdropFilter: 'blur(6px)',
		fontSize: '12px',
		color: 'var(--vscode-foreground)',
		pointerEvents: 'none',
	},
	legendTitle: {
		fontSize: '11px',
		fontWeight: 700,
		letterSpacing: '0.04em',
		textTransform: 'uppercase',
		color: 'var(--vscode-descriptionForeground)',
	},
	legendList: {
		display: 'flex',
		flexDirection: 'column',
		gap: '6px',
	},
	legendItem: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		lineHeight: 1.3,
	},
	legendSwatch: {
		width: '10px',
		height: '10px',
		minWidth: '10px',
		borderRadius: '999px',
		boxShadow: '0 0 0 1px rgba(255,255,255,0.2)',
	},
	scene: { position: 'relative', width: '100%', height: '100%', minHeight: '560px' },
	sceneCanvas2D: {
		position: 'absolute',
		inset: 0,
		width: '100%',
		height: '100%',
		minHeight: '560px',
		cursor: 'grab',
		touchAction: 'none',
	},
	emptyOverlay: {
		position: 'absolute',
		inset: 0,
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		background: 'rgba(0, 0, 0, 0.08)',
		pointerEvents: 'auto',
	},
	emptyOverlayCard: {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		gap: '10px',
		maxWidth: '360px',
		padding: '18px 20px',
		borderRadius: '12px',
		border: panelBorder,
		background: 'var(--vscode-editorWidget-background)',
		textAlign: 'center',
	},
	emptyOverlayTitle: { fontSize: '15px', fontWeight: 700 },
	emptyOverlayText: { fontSize: '12px', lineHeight: 1.45, color: 'var(--vscode-descriptionForeground)' },
	minimap: {
		position: 'absolute',
		right: '14px',
		bottom: '14px',
		width: '220px',
		height: '140px',
		borderRadius: '10px',
		border: panelBorder,
		cursor: 'pointer',
		background: 'var(--vscode-editorWidget-background)',
	},
	sceneDebugBadge: {
		position: 'absolute',
		left: '14px',
		top: '14px',
		padding: '6px 10px',
		borderRadius: '999px',
		border: panelBorder,
		background: 'var(--vscode-editorWidget-background)',
		fontSize: '11px',
		lineHeight: 1.2,
		color: 'var(--vscode-descriptionForeground)',
		pointerEvents: 'none',
	},
	inspector: {
		display: 'flex',
		flexDirection: 'column',
		gap: '12px',
		minHeight: 0,
		overflow: 'auto',
		padding: '14px',
		borderRadius: '14px',
		border: panelBorder,
		background: 'var(--vscode-sideBar-background)',
	},
	inspectorHeader: { fontSize: '13px', fontWeight: 700, letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--vscode-descriptionForeground)' },
	panelSection: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px', borderRadius: '12px', border: panelBorder, background: 'var(--vscode-editorWidget-background)' },
	entityTitle: { fontSize: '16px', fontWeight: 700, lineHeight: 1.35, wordBreak: 'break-word' },
	badges: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
	badge: { padding: '4px 8px', borderRadius: '999px', background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)', fontSize: '11px', lineHeight: 1.2 },
	inspectorActions: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
	metaList: { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', lineHeight: 1.45 },
	listSection: { display: 'flex', flexDirection: 'column', gap: '8px' },
	sectionTitle: { fontSize: '12px', fontWeight: 700, color: 'var(--vscode-descriptionForeground)' },
	pillList: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
	pill: { padding: '5px 8px', borderRadius: '999px', background: 'var(--vscode-editor-background)', border: panelBorder, fontSize: '11px', lineHeight: 1.25, maxWidth: '100%', wordBreak: 'break-word' },
	placeholder: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', fontSize: '13px', color: 'var(--vscode-descriptionForeground)', padding: '12px' },
	empty: { height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', color: 'var(--vscode-descriptionForeground)' },
	error: { height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', color: 'var(--vscode-inputValidation-errorForeground)', background: 'var(--vscode-inputValidation-errorBackground)', borderRadius: '12px' },
};