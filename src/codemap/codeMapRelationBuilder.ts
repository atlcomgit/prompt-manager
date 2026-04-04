import path from 'path';
import type {
	CodeMapFileSummary as FileSummary,
	CodeMapRelationBlock,
	CodeMapRelationEdge,
	CodeMapRelationKind,
} from '../types/codemap.js';

const RESOLVABLE_EXTENSIONS = [
	'',
	'.ts',
	'.tsx',
	'.js',
	'.jsx',
	'.mjs',
	'.cjs',
	'.vue',
	'.json',
	'.php',
	'.blade.php',
];
const MAX_FLOW_ITEMS = 8;
const MAX_DIAGRAM_LINES = 18;
const MAX_FILE_LINKS = 14;
const MAX_UI_LINKS = 10;
const MAX_SYMBOL_LINKS = 12;
const MAX_LEGACY_RELATIONS = 24;

interface BuildCodeMapRelationBlockInput {
	files: string[];
	fileSummaries: FileSummary[];
	fileTexts: ReadonlyMap<string, string>;
	locale: string;
}

interface ParsedImportBinding {
	kind: Extract<CodeMapRelationKind, 'import' | 'reexport' | 'dynamic-import'>;
	sourcePath: string;
	targetPath: string;
	importedName: string;
	localName: string;
}

interface AggregatedRelation {
	kind: CodeMapRelationEdge['kind'];
	sourcePath: string;
	targetPath: string;
	details: string[];
	weight: number;
	sourceLayer: string;
	targetLayer: string;
	sourceSymbol?: string;
	targetSymbol?: string;
}

export function buildCodeMapRelationBlock(input: BuildCodeMapRelationBlockInput): CodeMapRelationBlock {
	const isRussianLocale = input.locale.toLowerCase().startsWith('ru');
	const availableFiles = new Set(input.files.map(normalizeProjectPath).filter(Boolean));
	const fileSummaries = input.fileSummaries
		.map(summary => ({ ...summary, path: normalizeProjectPath(summary.path) }))
		.filter(summary => Boolean(summary.path));
	const fileSummaryByPath = new Map(fileSummaries.map(summary => [summary.path, summary]));
	const summaryImportBindings = fileSummaries.flatMap(summary => resolveSummaryImportBindings(summary, availableFiles));
	const parsedImports = fileSummaries.flatMap((summary) => parseResolvedImportBindings(
		summary.path,
		input.fileTexts.get(summary.path) || '',
		availableFiles,
	));
	const importBindingIndex = buildImportBindingIndex(parsedImports);
	const rawFileLinks = aggregateImportEdges([...summaryImportBindings, ...parsedImports], isRussianLocale);
	const rawUiDataLinks = buildFrontendRelationEdges(fileSummaries, importBindingIndex, isRussianLocale);
	const rawSymbolLinks = buildSymbolRelationEdges(fileSummaries, fileSummaryByPath, importBindingIndex, isRussianLocale);
	const layerFlows = buildLayerFlows([...rawFileLinks, ...rawUiDataLinks], isRussianLocale);
	const diagramLines = buildDiagramLines(layerFlows).slice(0, MAX_DIAGRAM_LINES);
	const fileLinks = rawFileLinks.slice(0, MAX_FILE_LINKS);
	const uiDataLinks = rawUiDataLinks.slice(0, MAX_UI_LINKS);
	const symbolLinks = rawSymbolLinks.slice(0, MAX_SYMBOL_LINKS);

	return {
		summary: buildSummaryLines({
			fileSummaries,
			rawFileLinks,
			rawUiDataLinks,
			rawSymbolLinks,
			layerFlows,
			isRussianLocale,
		}),
		diagramLines,
		architectureFlows: layerFlows.slice(0, MAX_FLOW_ITEMS).map(flow => flow.label),
		fileLinks,
		uiDataLinks,
		symbolLinks,
	};
}

export function buildLegacyRelationsFromRelationBlock(
	relationBlock: CodeMapRelationBlock | null | undefined,
	isRussianLocale: boolean,
): string[] {
	if (!relationBlock) {
		return [];
	}

	return [
		...relationBlock.fileLinks,
		...relationBlock.uiDataLinks,
		...relationBlock.symbolLinks,
	]
		.map(edge => edge.label || formatRelationLabel(edge, isRussianLocale))
		.filter(Boolean)
		.slice(0, MAX_LEGACY_RELATIONS);
}

function parseResolvedImportBindings(
	sourcePath: string,
	source: string,
	availableFiles: ReadonlySet<string>,
): ParsedImportBinding[] {
	if (!source.trim()) {
		return [];
	}

	const bindings: ParsedImportBinding[] = [];
	for (const match of source.matchAll(/(?:^|\n)\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
		const clause = String(match[1] || '').trim();
		const specifier = String(match[2] || '').trim();
		const targetPath = resolveImportTargetPath(sourcePath, specifier, availableFiles);
		if (!targetPath) {
			continue;
		}
		const clauseBindings = parseImportClauseBindings(clause);
		if (clauseBindings.length === 0) {
			bindings.push({
				kind: 'import',
				sourcePath,
				targetPath,
				importedName: '',
				localName: '',
			});
			continue;
		}
		for (const binding of clauseBindings) {
			bindings.push({
				kind: 'import',
				sourcePath,
				targetPath,
				importedName: binding.importedName,
				localName: binding.localName,
			});
		}
	}

	for (const match of source.matchAll(/(?:^|\n)\s*export\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
		const clause = String(match[1] || '').trim();
		const specifier = String(match[2] || '').trim();
		const targetPath = resolveImportTargetPath(sourcePath, specifier, availableFiles);
		if (!targetPath) {
			continue;
		}
		const clauseBindings = parseExportClauseBindings(clause);
		if (clauseBindings.length === 0) {
			bindings.push({
				kind: 'reexport',
				sourcePath,
				targetPath,
				importedName: '*',
				localName: '*',
			});
			continue;
		}
		for (const binding of clauseBindings) {
			bindings.push({
				kind: 'reexport',
				sourcePath,
				targetPath,
				importedName: binding.importedName,
				localName: binding.localName,
			});
		}
	}

	for (const match of source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
		const specifier = String(match[1] || '').trim();
		const targetPath = resolveImportTargetPath(sourcePath, specifier, availableFiles);
		if (!targetPath) {
			continue;
		}
		bindings.push({
			kind: 'dynamic-import',
			sourcePath,
			targetPath,
			importedName: '',
			localName: '',
		});
	}

	return bindings;
}

function resolveSummaryImportBindings(summary: FileSummary, availableFiles: ReadonlySet<string>): ParsedImportBinding[] {
	const bindings: ParsedImportBinding[] = [];
	for (const specifier of summary.imports || []) {
		const targetPath = resolveImportTargetPath(summary.path, specifier, availableFiles);
		if (!targetPath) {
			continue;
		}
		bindings.push({
			kind: 'import' as const,
			sourcePath: summary.path,
			targetPath,
			importedName: '',
			localName: '',
		});
	}
	return bindings;
}

function buildImportBindingIndex(bindings: ParsedImportBinding[]): Map<string, Map<string, ParsedImportBinding[]>> {
	const result = new Map<string, Map<string, ParsedImportBinding[]>>();
	for (const binding of bindings) {
		if (!binding.localName) {
			continue;
		}
		let fileBindings = result.get(binding.sourcePath);
		if (!fileBindings) {
			fileBindings = new Map<string, ParsedImportBinding[]>();
			result.set(binding.sourcePath, fileBindings);
		}
		const current = fileBindings.get(binding.localName) || [];
		current.push(binding);
		fileBindings.set(binding.localName, current);
		if (binding.importedName && binding.importedName !== binding.localName) {
			const importedCurrent = fileBindings.get(binding.importedName) || [];
			importedCurrent.push(binding);
			fileBindings.set(binding.importedName, importedCurrent);
		}
	}
	return result;
}

function aggregateImportEdges(bindings: ParsedImportBinding[], isRussianLocale: boolean): CodeMapRelationEdge[] {
	const groups = new Map<string, AggregatedRelation>();
	for (const binding of bindings) {
		const key = [binding.kind, binding.sourcePath, binding.targetPath].join('::');
		const current = groups.get(key) || {
			kind: binding.kind,
			sourcePath: binding.sourcePath,
			targetPath: binding.targetPath,
			details: [],
			weight: 0,
			sourceLayer: inferLayer(binding.sourcePath),
			targetLayer: inferLayer(binding.targetPath),
		};
		const detail = binding.localName || binding.importedName;
		if (detail) {
			current.details.push(detail);
		}
		current.weight += 1;
		groups.set(key, current);
	}

	return Array.from(groups.values())
		.map(item => toRelationEdge(item, isRussianLocale))
		.sort(compareRelationEdges);
}

function buildFrontendRelationEdges(
	fileSummaries: FileSummary[],
	importBindingIndex: ReadonlyMap<string, Map<string, ParsedImportBinding[]>>,
	isRussianLocale: boolean,
): CodeMapRelationEdge[] {
	const groups = new Map<string, AggregatedRelation>();
	for (const file of fileSummaries) {
		const fileBindings = importBindingIndex.get(file.path);
		if (!fileBindings) {
			continue;
		}
		for (const block of file.frontendBlocks || []) {
			for (const componentName of block.childComponents || []) {
				for (const binding of fileBindings.get(componentName) || []) {
					pushAggregatedRelation(groups, {
						kind: 'frontend-component',
						sourcePath: file.path,
						targetPath: binding.targetPath,
						details: [componentName],
						weight: 1,
						sourceLayer: inferLayer(file.path),
						targetLayer: inferLayer(binding.targetPath),
					});
				}
			}

			for (const token of extractLookupTokens([...block.dataSources, ...block.routes])) {
				for (const binding of fileBindings.get(token) || []) {
					pushAggregatedRelation(groups, {
						kind: 'frontend-data',
						sourcePath: file.path,
						targetPath: binding.targetPath,
						details: [token],
						weight: 1,
						sourceLayer: inferLayer(file.path),
						targetLayer: inferLayer(binding.targetPath),
					});
				}
			}
		}
	}

	return Array.from(groups.values())
		.map(item => toRelationEdge(item, isRussianLocale))
		.sort(compareRelationEdges);
}

function buildSymbolRelationEdges(
	fileSummaries: FileSummary[],
	fileSummaryByPath: ReadonlyMap<string, FileSummary>,
	importBindingIndex: ReadonlyMap<string, Map<string, ParsedImportBinding[]>>,
	isRussianLocale: boolean,
): CodeMapRelationEdge[] {
	const groups = new Map<string, AggregatedRelation>();
	for (const file of fileSummaries) {
		const fileBindings = importBindingIndex.get(file.path);
		if (!fileBindings) {
			continue;
		}
		for (const [, bindings] of fileBindings) {
			for (const binding of bindings) {
				if (!binding.importedName || binding.importedName === 'default' || binding.importedName === '*' || !binding.localName) {
					continue;
				}
				const targetSummary = fileSummaryByPath.get(binding.targetPath);
				if (!targetSummary || !(targetSummary.symbols || []).some(symbol => symbol.name === binding.importedName)) {
					continue;
				}
				pushAggregatedRelation(groups, {
					kind: 'symbol-ref',
					sourcePath: file.path,
					targetPath: binding.targetPath,
					details: [`${binding.localName} -> ${binding.importedName}`],
					weight: 1,
					sourceLayer: inferLayer(file.path),
					targetLayer: inferLayer(binding.targetPath),
					sourceSymbol: binding.localName,
					targetSymbol: binding.importedName,
				});
			}
		}
	}

	return Array.from(groups.values())
		.map(item => toRelationEdge(item, isRussianLocale))
		.sort(compareRelationEdges);
}

function buildLayerFlows(edges: CodeMapRelationEdge[], isRussianLocale: boolean): Array<{ label: string; sourceLayer: string; targetLayer: string; weight: number }> {
	const groups = new Map<string, { sourceLayer: string; targetLayer: string; weight: number }>();
	for (const edge of edges) {
		if (!edge.sourceLayer || !edge.targetLayer || edge.sourceLayer === edge.targetLayer) {
			continue;
		}
		const key = `${edge.sourceLayer}::${edge.targetLayer}`;
		const current = groups.get(key) || {
			sourceLayer: edge.sourceLayer,
			targetLayer: edge.targetLayer,
			weight: 0,
		};
		current.weight += edge.weight || 1;
		groups.set(key, current);
	}

	return Array.from(groups.values())
		.sort((left, right) => right.weight - left.weight || left.sourceLayer.localeCompare(right.sourceLayer) || left.targetLayer.localeCompare(right.targetLayer))
		.map(item => ({
			...item,
			label: isRussianLocale
				? `${item.sourceLayer} -> ${item.targetLayer} (${item.weight} ${pluralizeRu(item.weight, 'связь', 'связи', 'связей')})`
				: `${item.sourceLayer} -> ${item.targetLayer} (${item.weight} ${item.weight === 1 ? 'link' : 'links'})`,
		}));
}

function buildDiagramLines(flows: Array<{ sourceLayer: string; targetLayer: string }>): string[] {
	const groups = new Map<string, string[]>();
	for (const flow of flows.slice(0, MAX_FLOW_ITEMS)) {
		const current = groups.get(flow.sourceLayer) || [];
		if (!current.includes(flow.targetLayer)) {
			current.push(flow.targetLayer);
		}
		groups.set(flow.sourceLayer, current);
	}

	const entries = Array.from(groups.entries());
	return entries.flatMap(([sourceLayer, targets], index) => {
		const sourcePrefix = index === entries.length - 1 ? '└─' : '├─';
		const targetIndent = index === entries.length - 1 ? '   ' : '│  ';
		return [
			`${sourcePrefix} ${sourceLayer}`,
			...targets.map(target => `${targetIndent}-> ${target}`),
		];
	});
}

function buildSummaryLines(input: {
	fileSummaries: FileSummary[];
	rawFileLinks: CodeMapRelationEdge[];
	rawUiDataLinks: CodeMapRelationEdge[];
	rawSymbolLinks: CodeMapRelationEdge[];
	layerFlows: Array<{ label: string }>;
	isRussianLocale: boolean;
}): string[] {
	const { fileSummaries, rawFileLinks, rawUiDataLinks, rawSymbolLinks, layerFlows, isRussianLocale } = input;
	const lines = [
		isRussianLocale
			? `Разрешено ${rawFileLinks.length} межфайловых связей между ${fileSummaries.length} сигнальными файлами.`
			: `Resolved ${rawFileLinks.length} inter-file links across ${fileSummaries.length} informative files.`,
	];

	if (layerFlows.length > 0) {
		lines.push(isRussianLocale
			? `Основные переходы между слоями: ${layerFlows.slice(0, 4).map(item => item.label.replace(/ \(.+\)$/, '')).join(', ')}.`
			: `Primary layer transitions: ${layerFlows.slice(0, 4).map(item => item.label.replace(/ \(.+\)$/, '')).join(', ')}.`);
	}
	if (rawUiDataLinks.length > 0) {
		lines.push(isRussianLocale
			? `UI и данные привязаны к импортам в ${rawUiDataLinks.length} подтверждённых связях.`
			: `UI and data were matched to imports in ${rawUiDataLinks.length} confirmed links.`);
	}
	if (rawSymbolLinks.length > 0) {
		lines.push(isRussianLocale
			? 'Символьные связи построены только по явным import/re-export binding без эвристического call graph.'
			: 'Symbol links are built only from explicit import/re-export bindings without a heuristic call graph.');
	}

	return lines;
}

function pushAggregatedRelation(groups: Map<string, AggregatedRelation>, relation: AggregatedRelation): void {
	const key = [
		relation.kind,
		relation.sourcePath,
		relation.targetPath,
		relation.sourceSymbol || '',
		relation.targetSymbol || '',
	].join('::');
	const current = groups.get(key) || {
		...relation,
		details: [],
		weight: 0,
	};
	current.details.push(...relation.details);
	current.weight += relation.weight || 1;
	groups.set(key, current);
}

function toRelationEdge(relation: AggregatedRelation, isRussianLocale: boolean): CodeMapRelationEdge {
	const details = uniqueStrings(relation.details);
	return {
		kind: relation.kind,
		sourcePath: relation.sourcePath,
		targetPath: relation.targetPath,
		label: formatRelationLabel({
			kind: relation.kind,
			sourcePath: relation.sourcePath,
			targetPath: relation.targetPath,
			details,
			weight: relation.weight,
			sourceLayer: relation.sourceLayer,
			targetLayer: relation.targetLayer,
			sourceSymbol: relation.sourceSymbol,
			targetSymbol: relation.targetSymbol,
		}, isRussianLocale),
		weight: relation.weight,
		details,
		sourceLayer: relation.sourceLayer,
		targetLayer: relation.targetLayer,
		sourceSymbol: relation.sourceSymbol,
		targetSymbol: relation.targetSymbol,
	};
}

function formatRelationLabel(edge: Omit<CodeMapRelationEdge, 'label'>, isRussianLocale: boolean): string {
	const relationKind = (() => {
		switch (edge.kind) {
			case 'reexport':
				return isRussianLocale ? 'реэкспорт' : 're-export';
			case 'dynamic-import':
				return isRussianLocale ? 'dynamic import' : 'dynamic import';
			case 'frontend-component':
				return isRussianLocale ? 'UI-компонент' : 'UI component';
			case 'frontend-data':
				return isRussianLocale ? 'источник данных' : 'data source';
			case 'symbol-ref':
				return isRussianLocale ? 'символ' : 'symbol';
			default:
				return isRussianLocale ? 'импорт' : 'import';
		}
	})();
	const details = edge.details.length > 0 ? edge.details.join(', ') : relationKind;
	const suffix = edge.kind === 'symbol-ref' && edge.targetSymbol
		? `${relationKind}: ${edge.targetSymbol}${edge.sourceSymbol && edge.sourceSymbol !== edge.targetSymbol ? ` <- ${edge.sourceSymbol}` : ''}`
		: `${relationKind}: ${details}`;
	return `${edge.sourcePath} -> ${edge.targetPath} (${suffix})`;
}

function parseImportClauseBindings(clause: string): Array<{ importedName: string; localName: string }> {
	const normalized = clause.replace(/\btype\s+/g, '').trim();
	if (!normalized) {
		return [];
	}

	const result: Array<{ importedName: string; localName: string }> = [];
	const braceStart = normalized.indexOf('{');
	if (braceStart >= 0) {
		const defaultPart = normalized.slice(0, braceStart).replace(/,$/, '').trim();
		if (defaultPart) {
			result.push({ importedName: 'default', localName: defaultPart });
		}
		const braceEnd = normalized.lastIndexOf('}');
		const namedPart = braceEnd > braceStart ? normalized.slice(braceStart + 1, braceEnd) : '';
		result.push(...parseNamedBindings(namedPart));
		const namespaceMatch = normalized.slice(braceEnd + 1).match(/\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
		if (namespaceMatch?.[1]) {
			result.push({ importedName: '*', localName: namespaceMatch[1] });
		}
		return uniqueBindingPairs(result);
	}

	const namespaceMatch = normalized.match(/\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
	if (namespaceMatch?.[1]) {
		return [{ importedName: '*', localName: namespaceMatch[1] }];
	}

	return [{ importedName: 'default', localName: normalized.replace(/,$/, '').trim() }].filter(binding => Boolean(binding.localName));
}

function parseExportClauseBindings(clause: string): Array<{ importedName: string; localName: string }> {
	const normalized = clause.replace(/\btype\s+/g, '').trim();
	if (!normalized || normalized === '*') {
		return [];
	}
	if (normalized.startsWith('{')) {
		return uniqueBindingPairs(parseNamedBindings(normalized.slice(1, normalized.lastIndexOf('}'))));
	}
	if (normalized.startsWith('*')) {
		return [];
	}
	return [{ importedName: normalized, localName: normalized }];
}

function parseNamedBindings(input: string): Array<{ importedName: string; localName: string }> {
	return String(input || '')
		.split(',')
		.map(item => item.trim())
		.filter(Boolean)
		.map((item) => {
			const match = item.match(/^([A-Za-z_$][A-Za-z0-9_$]*|default)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/);
			if (!match?.[1]) {
				return null;
			}
			return {
				importedName: match[1],
				localName: match[2] || match[1],
			};
		})
		.filter((item): item is { importedName: string; localName: string } => Boolean(item));
}

function resolveImportTargetPath(sourcePath: string, specifier: string, availableFiles: ReadonlySet<string>): string {
	const normalizedSpecifier = String(specifier || '').trim();
	if (!normalizedSpecifier || (!normalizedSpecifier.startsWith('.') && !normalizedSpecifier.startsWith('@/') && !normalizedSpecifier.startsWith('src/'))) {
		return '';
	}

	const baseCandidates = getImportBaseCandidates(sourcePath, normalizedSpecifier);
	for (const baseCandidate of baseCandidates) {
		for (const candidate of expandImportCandidates(baseCandidate)) {
			if (availableFiles.has(candidate)) {
				return candidate;
			}
		}
	}

	return '';
}

function getImportBaseCandidates(sourcePath: string, specifier: string): string[] {
	if (specifier.startsWith('.')) {
		return [normalizeProjectPath(path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), specifier)))];
	}
	if (specifier.startsWith('@/')) {
		return [normalizeProjectPath(`src/${specifier.slice(2)}`), normalizeProjectPath(specifier.slice(2))];
	}
	return [normalizeProjectPath(specifier)];
}

function expandImportCandidates(basePath: string): string[] {
	const normalized = normalizeProjectPath(basePath);
	if (!normalized) {
		return [];
	}

	const baseWithoutExtension = normalized.replace(/\.(?:[cm]?[jt]sx?|vue|json|php)$/i, '');
	const candidates = new Set<string>([normalized]);
	for (const extension of RESOLVABLE_EXTENSIONS) {
		candidates.add(`${baseWithoutExtension}${extension}`);
		candidates.add(normalizeProjectPath(path.posix.join(baseWithoutExtension, `index${extension}`)));
	}
	return Array.from(candidates).filter(Boolean);
}

function extractLookupTokens(values: string[]): string[] {
	const tokens = new Set<string>();
	for (const value of values) {
		for (const match of String(value || '').matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
			const token = String(match[1] || '').trim();
			if (token.length >= 3) {
				tokens.add(token);
			}
		}
	}
	return Array.from(tokens);
}

function inferLayer(filePath: string): string {
	if (filePath === 'src/extension.ts') {
		return 'extension';
	}
	if (filePath.startsWith('src/providers/')) {
		return 'providers';
	}
	if (filePath.startsWith('src/services/')) {
		return 'services';
	}
	if (filePath.startsWith('src/codemap/')) {
		return 'codemap';
	}
	if (filePath.startsWith('src/webview/shared/')) {
		return 'webview/shared';
	}
	if (filePath.startsWith('src/webview/')) {
		return 'webview';
	}
	if (filePath.startsWith('src/utils/')) {
		return 'utils';
	}
	if (filePath.startsWith('src/types/')) {
		return 'types';
	}
	if (filePath.startsWith('src/constants/')) {
		return 'constants';
	}
	if (filePath.startsWith('tests/')) {
		return 'tests';
	}
	if (filePath.startsWith('src/')) {
		return filePath.split('/')[1] || 'src';
	}
	return 'root';
}

function normalizeProjectPath(filePath: string): string {
	return String(filePath || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values.map(value => String(value || '').trim()).filter(Boolean)));
}

function uniqueBindingPairs(values: Array<{ importedName: string; localName: string }>): Array<{ importedName: string; localName: string }> {
	const seen = new Set<string>();
	return values.filter((value) => {
		const key = `${value.importedName}::${value.localName}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

function compareRelationEdges(left: CodeMapRelationEdge, right: CodeMapRelationEdge): number {
	return (right.weight || 0) - (left.weight || 0)
		|| left.sourcePath.localeCompare(right.sourcePath)
		|| left.targetPath.localeCompare(right.targetPath)
		|| left.kind.localeCompare(right.kind);
}

function pluralizeRu(value: number, one: string, few: string, many: string): string {
	const absValue = Math.abs(value) % 100;
	const lastDigit = absValue % 10;
	if (absValue > 10 && absValue < 20) {
		return many;
	}
	if (lastDigit > 1 && lastDigit < 5) {
		return few;
	}
	if (lastDigit === 1) {
		return one;
	}
	return many;
}