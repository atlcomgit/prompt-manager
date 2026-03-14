import { execFile } from 'child_process';
import { promisify } from 'util';
import { buildAsciiTree, type AsciiTreeItem } from '../utils/asciiTree.js';
import type { CodeMapBranchResolution, CodeMapInstructionKind, CodeMapInstructionRecord } from '../types/codemap.js';
import type { AiService } from '../services/aiService.js';
import { getCodeMapSettings } from './codeMapConfig.js';

const execFileAsync = promisify(execFile);
const MAX_TREE_ITEMS = 400;
const MAX_DEPENDENCY_ITEMS = 20;
const MAX_SCRIPT_ITEMS = 12;
const MAX_AREA_COUNT = 6;
const MAX_FILES_PER_AREA = 3;
const MAX_SYMBOLS_PER_AREA = 6;
const MAX_FILE_SNIPPET_BYTES = 12 * 1024;
const MAX_SYMBOLS_PER_FILE = 10;
const MAX_RELATIONS = 24;
const MAX_RECENT_CHANGES = 10;
const MAX_FILE_SUMMARY_COUNT = 36;
const ANONYMOUS_CLASS_SYMBOL_NAME = '__anonymous_class__';

interface PackageManifest {
	name?: string;
	description?: string;
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

interface ComposerManifest {
	name?: string;
	description?: string;
	scripts?: Record<string, string | string[]>;
	require?: Record<string, string>;
	requireDev?: Record<string, string>;
}

interface CodeAreaSummary {
	area: string;
	fileCount: number;
	description: string;
	representativeFiles: string[];
	symbols: string[];
}

export interface CodeMapAreaDescriptionBatchItem {
	id: string;
	area: string;
	manifestDescription?: string;
	representativeFiles: string[];
	symbols: string[];
	snippets: Array<{ filePath: string; snippet: string }>;
}

interface PreparedCodeMapAreaDescription extends CodeMapAreaDescriptionBatchItem {
	fileCount: number;
	fallback: string;
}

interface FileSymbolSummary {
	kind: string;
	name: string;
	signature: string;
	line: number;
	column: number;
	description: string;
}

interface FileSummary {
	path: string;
	lineCount: number;
	role: string;
	symbols: FileSymbolSummary[];
	imports: string[];
}

interface ProjectCodeDescription {
	projectEssence: string[];
	architectureSummary: string[];
	patterns: string[];
	entryPoints: string[];
	areas: CodeAreaSummary[];
	fileSummaries: FileSummary[];
	relations: string[];
	recentChanges: string[];
}

interface CodeMapGenerationProgress {
	stage: string;
	detail?: string;
	completed?: number;
	total?: number;
}

export class CodeMapInstructionService {
	constructor(private readonly aiService?: AiService) { }

	async generateInstruction(
		resolution: CodeMapBranchResolution,
		instructionKind: CodeMapInstructionKind,
		locale: string,
		aiModel: string,
		onProgress?: (progress: CodeMapGenerationProgress) => void,
	): Promise<CodeMapInstructionRecord> {
		const isRussianLocale = locale.toLowerCase().startsWith('ru');
		const branchName = instructionKind === 'base'
			? resolution.resolvedBranchName
			: resolution.currentBranch;
		const headSha = instructionKind === 'base'
			? resolution.resolvedHeadSha
			: resolution.currentHeadSha;
		onProgress?.({
			stage: 'collecting-files',
			detail: isRussianLocale
				? `Подготавливается git-снимок ${resolution.repository}:${branchName}`
				: `Preparing git snapshot for ${resolution.repository}:${branchName}`,
		});
		const files = await this.getFilesAtRef(resolution.projectPath, branchName);
		const manifest = await this.readJsonAtRef<PackageManifest>(resolution.projectPath, branchName, 'package.json');
		const composerManifest = await this.readJsonAtRef<ComposerManifest>(resolution.projectPath, branchName, 'composer.json');
		const analysisFiles = selectFilesForAnalysis(files);
		onProgress?.({
			stage: 'collecting-files',
			detail: isRussianLocale
				? `Найдено ${files.length} файлов, к анализу отобрано ${analysisFiles.length}`
				: `Discovered ${files.length} files, selected ${analysisFiles.length} for analysis`,
		});
		onProgress?.({
			stage: 'describing-areas',
			detail: isRussianLocale
				? `Подготавливаются области кода для ${resolution.repository}:${branchName}`
				: `Preparing code areas for ${resolution.repository}:${branchName}`,
			completed: 0,
			total: Math.max(1, Math.min(MAX_AREA_COUNT, buildAreaEntries(selectFilesForAnalysis(files)).length)),
		});
		const codeDescription = await this.describeProjectCode(resolution.projectPath, branchName, files, manifest, composerManifest, locale, aiModel, onProgress);
		const generatedAt = new Date().toISOString();
		onProgress?.({
			stage: 'assembling-instruction',
			detail: isRussianLocale
				? 'Собираются итоговые разделы инструкции и дерево структуры проекта'
				: 'Assembling final instruction sections and the project structure tree',
		});
		const content = buildCodeMapProjectInstruction({
			repository: resolution.repository,
			branchName,
			resolvedBranchName: resolution.resolvedBranchName,
			baseBranchName: resolution.baseBranchName,
			instructionKind,
			branchRole: instructionKind === 'base' ? resolution.branchRole : 'current',
			generatedAt,
			headSha,
			locale,
			files,
			manifest,
			composerManifest,
			codeDescription,
		});

		return {
			repository: resolution.repository,
			branchName,
			resolvedBranchName: resolution.resolvedBranchName,
			baseBranchName: resolution.baseBranchName,
			branchRole: instructionKind === 'base' ? resolution.branchRole : 'current',
			instructionKind,
			locale,
			aiModel,
			content,
			contentHash: '',
			generatedAt,
			sourceCommitSha: headSha,
			fileCount: files.length,
			metadata: {
				manifestName: manifest?.name || composerManifest?.name || '',
				fileGroups: codeDescription.areas.map(area => ({ group: area.area, count: area.fileCount })),
				generatedBy: 'codemap-bootstrap',
			},
		};
	}

	private async getFilesAtRef(projectPath: string, ref: string): Promise<string[]> {
		try {
			const { stdout } = await execFileAsync('git', ['ls-tree', '-r', '--name-only', ref], { cwd: projectPath, maxBuffer: 8 * 1024 * 1024 });
			return stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
		} catch {
			return [];
		}
	}

	private async readJsonAtRef<T>(projectPath: string, ref: string, filePath: string): Promise<T | null> {
		try {
			const { stdout } = await execFileAsync('git', ['show', `${ref}:${filePath}`], { cwd: projectPath, maxBuffer: 2 * 1024 * 1024 });
			return JSON.parse(stdout) as T;
		} catch {
			return null;
		}
	}

	private async describeProjectCode(
		projectPath: string,
		ref: string,
		files: string[],
		manifest: PackageManifest | null,
		composerManifest: ComposerManifest | null,
		locale: string,
		aiModel: string,
		onProgress?: (progress: CodeMapGenerationProgress) => void,
	): Promise<ProjectCodeDescription> {
		const isRussianLocale = locale.toLowerCase().startsWith('ru');
		const settings = getCodeMapSettings();
		const analysisFiles = selectFilesForAnalysis(files);
		const areaEntries = buildAreaEntries(analysisFiles).slice(0, MAX_AREA_COUNT);
		const fileTexts = await this.readFileTexts(projectPath, ref, analysisFiles);
		const manifestDescription = resolveProjectDescription(manifest, composerManifest, isRussianLocale, '');
		const preparedAreas: PreparedCodeMapAreaDescription[] = areaEntries.map((areaEntry, index) => {
			const representativeFiles = areaEntry.files.slice(0, MAX_FILES_PER_AREA);
			const symbols = Array.from(new Set(representativeFiles.flatMap(filePath => extractSymbolNames(filePath, fileTexts.get(filePath) || '')))).slice(0, MAX_SYMBOLS_PER_AREA);
			return {
				id: `area-${index + 1}`,
				area: areaEntry.area,
				fileCount: areaEntry.files.length,
				manifestDescription,
				representativeFiles,
				symbols,
				snippets: representativeFiles
					.slice(0, 2)
					.map(filePath => ({
						filePath,
						snippet: trimSnippet(fileTexts.get(filePath) || ''),
					}))
					.filter(item => item.snippet.trim().length > 0),
				fallback: describeArea(areaEntry.area, representativeFiles, symbols, isRussianLocale),
			};
		});
		const areaBatches = buildAreaDescriptionBatches(preparedAreas, settings.batchContextMaxChars);
		onProgress?.({
			stage: 'describing-areas',
			detail: formatAreaPreparationDetail(isRussianLocale, preparedAreas.length, analysisFiles.length, areaBatches.length, aiModel),
			completed: 0,
			total: Math.max(1, preparedAreas.length),
		});
		const descriptionsById = await this.buildAreaDescriptions({
			projectPath,
			ref,
			locale,
			aiModel,
			mode: settings.blockDescriptionMode,
			maxChars: settings.blockMaxChars,
			batchContextMaxChars: settings.batchContextMaxChars,
			areas: preparedAreas,
			onProgress,
		});
		const areaSummaries: CodeAreaSummary[] = preparedAreas.map(area => ({
			area: area.area,
			fileCount: area.fileCount,
			description: descriptionsById.get(area.id) || area.fallback,
			representativeFiles: area.representativeFiles,
			symbols: area.symbols,
		}));

		const detailFiles = selectFilesForDetailedSummary(analysisFiles);
		const fileSummaries: FileSummary[] = [];
		if (detailFiles.length > 0) {
			onProgress?.({
				stage: 'describing-files',
				detail: isRussianLocale
					? `Подготавливаются описания ${detailFiles.length} ключевых файлов`
					: `Preparing summaries for ${detailFiles.length} key files`,
				completed: 0,
				total: detailFiles.length,
			});
		}
		for (const [index, filePath] of detailFiles.entries()) {
			fileSummaries.push(buildFileSummary(filePath, fileTexts.get(filePath) || '', isRussianLocale));
			onProgress?.({
				stage: 'describing-files',
				detail: isRussianLocale
					? `Файл ${index + 1}/${detailFiles.length}: ${filePath}`
					: `File ${index + 1}/${detailFiles.length}: ${filePath}`,
				completed: index + 1,
				total: detailFiles.length,
			});
		}
		const relations = buildRelations(fileSummaries, isRussianLocale);
		onProgress?.({
			stage: 'collecting-history',
			detail: isRussianLocale
				? `Читается git history для ${ref}`
				: `Collecting git history for ${ref}`,
		});
		const recentChanges = await this.readRecentChanges(projectPath, ref, isRussianLocale);

		return {
			projectEssence: buildProjectEssence(analysisFiles, manifest, composerManifest, isRussianLocale),
			architectureSummary: buildArchitectureSummary(analysisFiles, manifest, composerManifest, isRussianLocale),
			patterns: detectPatterns(analysisFiles, manifest, composerManifest, isRussianLocale),
			entryPoints: findEntryPoints(analysisFiles, isRussianLocale),
			areas: areaSummaries,
			fileSummaries,
			relations,
			recentChanges,
		};
	}

	private async buildAreaDescriptions(input: {
		projectPath: string;
		ref: string;
		locale: string;
		aiModel: string;
		mode: 'short' | 'medium' | 'long';
		maxChars: number;
		batchContextMaxChars: number;
		areas: PreparedCodeMapAreaDescription[];
		onProgress?: (progress: CodeMapGenerationProgress) => void;
	}): Promise<Map<string, string>> {
		const descriptions = new Map<string, string>();
		if (input.areas.length === 0) {
			return descriptions;
		}

		if (!this.aiService) {
			for (const [index, area] of input.areas.entries()) {
				descriptions.set(area.id, area.fallback);
				input.onProgress?.({
					stage: 'describing-areas',
					detail: area.area,
					completed: index + 1,
					total: input.areas.length,
				});
			}
			return descriptions;
		}

		const batches = buildAreaDescriptionBatches(input.areas, input.batchContextMaxChars);
		let completed = 0;

		for (const [batchIndex, batch] of batches.entries()) {
			input.onProgress?.({
				stage: 'describing-areas',
				detail: formatAreaBatchStartDetail(input.locale.toLowerCase().startsWith('ru'), batchIndex, batches.length, batch),
				completed,
				total: input.areas.length,
			});
			let parsedDescriptions: Record<string, string> = {};
			let usedFallback = false;
			try {
				const response = await this.aiService.generateCodeMapAreaDescriptionsBatch({
					repository: pathBasename(input.projectPath),
					branchName: input.ref,
					locale: input.locale,
					mode: input.mode,
					maxChars: input.maxChars,
					manifestDescription: batch[0]?.manifestDescription,
					areas: batch.map(area => ({
						id: area.id,
						area: area.area,
						repository: pathBasename(input.projectPath),
						branchName: input.ref,
						locale: input.locale,
						mode: input.mode,
						maxChars: input.maxChars,
						manifestDescription: area.manifestDescription,
						representativeFiles: area.representativeFiles,
						symbols: area.symbols,
						snippets: area.snippets,
					})),
				}, input.aiModel);
				parsedDescriptions = parseCodeMapAreaBatchResponse(response);
			} catch {
				parsedDescriptions = {};
				usedFallback = true;
			}

			for (const area of batch) {
				const normalized = normalizeAreaDescription(parsedDescriptions[area.id] || '', input.maxChars);
				descriptions.set(area.id, normalized || area.fallback);
				completed += 1;
				input.onProgress?.({
					stage: 'describing-areas',
					detail: formatAreaCompletionDetail(input.locale.toLowerCase().startsWith('ru'), completed, input.areas.length, area.area, usedFallback || !normalized),
					completed,
					total: input.areas.length,
				});
			}
		}

		return descriptions;
	}

	private async readFileTexts(projectPath: string, ref: string, files: string[]): Promise<Map<string, string>> {
		const texts = new Map<string, string>();
		for (const filePath of files) {
			if (isBinaryLikeFile(filePath)) {
				texts.set(filePath, '');
				continue;
			}

			texts.set(filePath, await this.readTextAtRef(projectPath, ref, filePath));
		}

		return texts;
	}

	private async readRecentChanges(projectPath: string, ref: string, isRussianLocale: boolean): Promise<string[]> {
		try {
			const { stdout } = await execFileAsync(
				'git',
				['log', '--date=iso', `-n${MAX_RECENT_CHANGES}`, '--format=%H\t%ad\t%s', '--name-only', ref],
				{ cwd: projectPath, maxBuffer: 4 * 1024 * 1024 },
			);
			return parseRecentChanges(stdout, isRussianLocale);
		} catch {
			return [];
		}
	}

	private async readTextAtRef(projectPath: string, ref: string, filePath: string): Promise<string> {
		try {
			const { stdout } = await execFileAsync('git', ['show', `${ref}:${filePath}`], { cwd: projectPath, maxBuffer: MAX_FILE_SNIPPET_BYTES });
			return stdout;
		} catch {
			return '';
		}
	}
}

export function buildCodeMapProjectInstruction(input: {
	repository: string;
	branchName: string;
	resolvedBranchName: string;
	baseBranchName: string;
	instructionKind: CodeMapInstructionKind;
	branchRole: CodeMapBranchResolution['branchRole'];
	generatedAt: string;
	headSha: string;
	locale: string;
	files: string[];
	manifest: PackageManifest | null;
	composerManifest?: ComposerManifest | null;
	codeDescription?: ProjectCodeDescription;
}): string {
	const isRussianLocale = input.locale.toLowerCase().startsWith('ru');
	const files = input.files;
	const analysisFiles = selectFilesForAnalysis(files);
	const treeSourceFiles = analysisFiles.length > 0 ? analysisFiles : files.filter(filePath => !isBinaryLikeFile(filePath));
	const limitedFiles = treeSourceFiles.slice(0, MAX_TREE_ITEMS);
	const treeItems: AsciiTreeItem[] = limitedFiles.map(filePath => ({
		path: `${input.repository}/${filePath}`,
		kind: 'file',
	}));
	const tree = treeItems.length > 0 ? buildAsciiTree(treeItems) : '';
	const languages = summarizeExtensions(analysisFiles);
	const frameworks = detectFrameworks(input.manifest, input.composerManifest || null, analysisFiles);
	const scripts = collectProjectScripts(input.manifest, input.composerManifest || null).slice(0, MAX_SCRIPT_ITEMS);
	const dependencies = collectProjectDependencies(input.manifest, input.composerManifest || null).slice(0, MAX_DEPENDENCY_ITEMS);
	const heading = isRussianLocale
		? `# Code Map проекта ${input.repository} для ветки ${input.branchName}`
		: `# Project Code Map for ${input.repository} branch ${input.branchName}`;
	const overviewTitle = isRussianLocale ? '## Обзор' : '## Overview';
	const essenceTitle = isRussianLocale ? '## Суть проекта' : '## Project Essence';
	const technologiesTitle = isRussianLocale ? '## Технологии и сигналы проекта' : '## Technologies and Project Signals';
	const codeDescriptionTitle = isRussianLocale ? '## Описание кода' : '## Code Description';
	const fileDetailsTitle = isRussianLocale ? '## Ключевые файлы и элементы' : '## Key Files and Elements';
	const relationsTitle = isRussianLocale ? '## Связи между частями кода' : '## Code Relationships';
	const timelineTitle = isRussianLocale ? '## Временные метки изменений в коде' : '## Code Change Timeline';
	const structureTitle = isRussianLocale ? '## Структура файлов' : '## File Structure';
	const notesTitle = isRussianLocale ? '## Примечания текущей реализации' : '## Current Implementation Notes';
	const manifestDescription = resolveProjectDescription(input.manifest, input.composerManifest || null, isRussianLocale, isRussianLocale ? 'Описание проекта в package.json/composer.json не найдено.' : 'No project description found in package.json/composer.json.');
	const implementationNote = isRussianLocale
		? 'Codemap теперь старается показывать только сигнальные для ИИ файлы: временные, кэшированные и служебно-сгенерированные артефакты исключаются из аналитической части, чтобы инструкция оставалась полезной для навигации.'
		: 'Codemap now focuses on files that carry architectural signal for AI navigation: temporary, cached, and generated artifacts are excluded from the analytical sections to keep the instruction useful.';
	const codeDescription = input.codeDescription || buildFallbackCodeDescription(files, input.manifest, input.composerManifest || null, isRussianLocale);
	const detailedFileOmissions = Math.max(0, analysisFiles.length - codeDescription.fileSummaries.length);
	const filteredTreeOmissions = Math.max(0, files.length - limitedFiles.length);

	return [
		heading,
		'',
		overviewTitle,
		`- ${isRussianLocale ? 'Репозиторий' : 'Repository'}: ${input.repository}`,
		`- ${isRussianLocale ? 'Ветка' : 'Branch'}: ${input.branchName}`,
		`- ${isRussianLocale ? 'Разрешённая ветка' : 'Resolved branch'}: ${input.resolvedBranchName}`,
		`- ${isRussianLocale ? 'Базовая ветка' : 'Base branch'}: ${input.baseBranchName}`,
		`- ${isRussianLocale ? 'Тип инструкции' : 'Instruction kind'}: ${input.instructionKind}`,
		`- ${isRussianLocale ? 'Роль ветки' : 'Branch role'}: ${input.branchRole}`,
		`- ${isRussianLocale ? 'Коммит HEAD' : 'Head commit'}: ${input.headSha || (isRussianLocale ? 'неизвестно' : 'unknown')}`,
		`- ${isRussianLocale ? 'Сгенерировано' : 'Generated at'}: ${input.generatedAt}`,
		`- ${isRussianLocale ? 'Всего файлов' : 'File count'}: ${files.length}`,
		`- ${isRussianLocale ? 'Файлов в анализе' : 'Analysed files'}: ${analysisFiles.length}`,
		`- ${isRussianLocale ? 'Пакет' : 'Package'}: ${resolveProjectName(input.manifest, input.composerManifest || null, input.repository)}`,
		`- ${isRussianLocale ? 'Описание' : 'Description'}: ${manifestDescription}`,
		'',
		essenceTitle,
		...codeDescription.projectEssence.map(item => `- ${item}`),
		'',
		technologiesTitle,
		`- ${isRussianLocale ? 'Языки' : 'Languages'}: ${languages.length > 0 ? languages.join(', ') : (isRussianLocale ? 'не определены' : 'unknown')}`,
		`- ${isRussianLocale ? 'Фреймворки и библиотеки' : 'Frameworks/Libraries'}: ${frameworks.length > 0 ? frameworks.join(', ') : (isRussianLocale ? 'не определены' : 'not detected')}`,
		`- ${isRussianLocale ? 'Скрипты' : 'Scripts'}: ${scripts.length > 0 ? scripts.join(', ') : (isRussianLocale ? 'не определены' : 'not detected')}`,
		`- ${isRussianLocale ? 'Зависимости' : 'Dependencies'}: ${dependencies.length > 0 ? dependencies.join(', ') : (isRussianLocale ? 'не определены' : 'not detected')}`,
		...(codeDescription.patterns.length > 0 ? ['', isRussianLocale ? '### Паттерны и организационные сигналы' : '### Patterns and Organizational Signals'] : []),
		...codeDescription.patterns.map(item => `- ${item}`),
		'',
		codeDescriptionTitle,
		...codeDescription.architectureSummary.map(item => `- ${item}`),
		...(codeDescription.entryPoints.length > 0 ? ['', isRussianLocale ? '### Точки входа и управляющие файлы' : '### Entry Points and Control Files'] : []),
		...codeDescription.entryPoints.map(item => `- ${item}`),
		...(codeDescription.areas.length > 0 ? ['', isRussianLocale ? '### Области кода' : '### Code Areas'] : []),
		...codeDescription.areas.flatMap(area => {
			const areaLines = [
				`#### ${area.area}`,
				`- ${isRussianLocale ? 'Описание' : 'Description'}: ${area.description}`,
				'',
			];

			if (area.representativeFiles.length > 0) {
				areaLines.push(`- ${isRussianLocale ? 'Файлы' : 'Files'}: ${area.representativeFiles.join(', ')}`);
				areaLines.push('');
			}

			if (area.symbols.length > 0) {
				areaLines.push(`- ${isRussianLocale ? 'Ключевые элементы' : 'Key elements'}: ${area.symbols.join(', ')}`);
				areaLines.push('');
			}

			return areaLines;
		}),
		'',
		fileDetailsTitle,
		...(detailedFileOmissions > 0
			? [isRussianLocale
				? `- Показаны ${codeDescription.fileSummaries.length} наиболее сигнальных файлов; ещё ${detailedFileOmissions} файлов опущены как второстепенные или служебные.`
				: `- Showing ${codeDescription.fileSummaries.length} most informative files; ${detailedFileOmissions} additional files were omitted as secondary or operational artifacts.`]
			: []),
		...codeDescription.fileSummaries.flatMap(file => {
			const lines = [
				`### ${file.path}`,
				`- ${isRussianLocale ? 'Роль' : 'Role'}: ${file.role}`,
				`- ${isRussianLocale ? 'Строк в файле' : 'Line count'}: ${file.lineCount}`,
				'',
			];

			if (file.imports.length > 0) {
				lines.push(`- ${isRussianLocale ? 'Внутренние импорты' : 'Internal imports'}: ${file.imports.join(', ')}`);
				lines.push('');
			}

			if (file.symbols.length > 0) {
				lines.push(`- ${isRussianLocale ? 'Элементы файла' : 'File elements'}:`);
				for (const symbol of file.symbols) {
					lines.push('');
					lines.push(`  - ${formatFileElementHeading(symbol, file.path, isRussianLocale)}`);
					lines.push(`    ${isRussianLocale ? 'Сигнатура' : 'Signature'}: ${symbol.signature}`);
					lines.push(`    ${isRussianLocale ? 'Описание' : 'Description'}: ${symbol.description}`);
				}
			}

			lines.push('');

			return lines;
		}),
		'',
		relationsTitle,
		...(codeDescription.relations.length > 0
			? codeDescription.relations.map(item => `- ${item}`)
			: [isRussianLocale ? '- Явные связи между файлами не обнаружены.' : '- No explicit file relationships were detected.']),
		'',
		timelineTitle,
		...(codeDescription.recentChanges.length > 0
			? codeDescription.recentChanges.map(item => `- ${item}`)
			: [isRussianLocale ? '- История изменений для ветки не получена.' : '- No recent change timeline was collected for the branch.']),
		'',
		structureTitle,
		...(filteredTreeOmissions > 0
			? [isRussianLocale
				? `- Дерево ниже показывает ${limitedFiles.length} релевантных файлов; временные, бинарные и сгенерированные артефакты исключены.`
				: `- The tree below shows ${limitedFiles.length} relevant files; temporary, binary, and generated artifacts are excluded.`]
			: []),
		tree ? '```text' : (isRussianLocale ? 'Структура файлов не обнаружена.' : 'No file structure detected.'),
		tree || '',
		tree ? '```' : '',
		files.length > limitedFiles.length ? (isRussianLocale ? `... ещё ${files.length - limitedFiles.length} файлов скрыто` : `... ${files.length - limitedFiles.length} more files omitted`) : '',
		'',
		notesTitle,
		implementationNote,
	].filter(line => line !== undefined && line !== null).join('\n');
}

function buildFallbackCodeDescription(files: string[], manifest: PackageManifest | null, composerManifest: ComposerManifest | null, isRussianLocale: boolean): ProjectCodeDescription {
	const analysisFiles = selectFilesForAnalysis(files);
	const detailFiles = selectFilesForDetailedSummary(analysisFiles);
	const areas = buildAreaEntries(analysisFiles).slice(0, MAX_AREA_COUNT).map(area => ({
		area: area.area,
		fileCount: area.files.length,
		description: describeArea(area.area, area.files.slice(0, MAX_FILES_PER_AREA), [], isRussianLocale),
		representativeFiles: area.files.slice(0, MAX_FILES_PER_AREA),
		symbols: [],
	}));

	return {
		projectEssence: buildProjectEssence(analysisFiles, manifest, composerManifest, isRussianLocale),
		architectureSummary: buildArchitectureSummary(analysisFiles, manifest, composerManifest, isRussianLocale),
		patterns: detectPatterns(analysisFiles, manifest, composerManifest, isRussianLocale),
		entryPoints: findEntryPoints(analysisFiles, isRussianLocale),
		areas,
		fileSummaries: detailFiles.map(filePath => buildFileSummary(filePath, '', isRussianLocale)),
		relations: [],
		recentChanges: [],
	};
}

function buildProjectEssence(files: string[], manifest: PackageManifest | null, composerManifest: ComposerManifest | null, isRussianLocale: boolean): string[] {
	const lines: string[] = [];
	const description = manifest?.description?.trim() || composerManifest?.description?.trim();
	if (description) {
		lines.push(isRussianLocale ? `Заявленная цель проекта: ${description}` : `Declared project purpose: ${description}`);
	}

	if (isLaravelProject(files, composerManifest)) {
		lines.push(isRussianLocale
			? 'Это Laravel-приложение или пакет: видны HTTP-контроллеры, маршруты, миграции, модели и тесты вокруг прикладных сценариев.'
			: 'This looks like a Laravel application or package with HTTP controllers, routes, migrations, models, and tests around application scenarios.');
	}

	if (files.some(filePath => filePath.startsWith('src/providers/')) && files.some(filePath => filePath.startsWith('src/webview/'))) {
		lines.push(isRussianLocale
			? 'Проект управляет UI-панелями и webview-сценариями, синхронизируя их с extension host и состоянием workspace.'
			: 'The project manages UI panels and webview flows, synchronizing them with the extension host and workspace state.');
	}

	if (files.some(filePath => filePath.startsWith('src/codemap/'))) {
		lines.push(isRussianLocale
			? 'В кодовой базе есть отдельный слой codemap для построения и хранения инструкций по структуре кода.'
			: 'The codebase contains a dedicated codemap layer for building and persisting code-structure instructions.');
	}

	if (lines.length === 0) {
		lines.push(isRussianLocale
			? 'Суть проекта выводится из структуры файлов, основных зависимостей и точек входа.'
			: 'The project purpose is inferred from file structure, primary dependencies, and entry points.');
	}

	return lines;
}

function detectPatterns(files: string[], manifest: PackageManifest | null, composerManifest: ComposerManifest | null, isRussianLocale: boolean): string[] {
	const patterns: string[] = [];
	if (files.some(filePath => filePath.startsWith('src/services/'))) {
		patterns.push(isRussianLocale ? 'service layer для доменной и интеграционной логики' : 'service layer for domain and integration logic');
	}
	if (files.some(filePath => filePath.startsWith('src/providers/'))) {
		patterns.push(isRussianLocale ? 'provider/manager pattern для связывания VS Code API и UI' : 'provider/manager pattern for connecting VS Code API and UI');
	}
	if (files.some(filePath => filePath.startsWith('src/webview/'))) {
		patterns.push(isRussianLocale ? 'разделение extension host и client-side webview' : 'extension-host and client-side webview separation');
	}
	if (manifest?.dependencies?.react || manifest?.devDependencies?.react) {
		patterns.push(isRussianLocale ? 'component-based UI на React' : 'component-based UI with React');
	}
	if (isLaravelProject(files, composerManifest)) {
		patterns.push(isRussianLocale ? 'MVC-слои Laravel: маршруты, контроллеры, модели и миграции' : 'Laravel MVC layering with routes, controllers, models, and migrations');
	}
	if (files.some(filePath => filePath.startsWith('database/migrations/'))) {
		patterns.push(isRussianLocale ? 'схема БД версионируется миграциями' : 'database schema is versioned via migrations');
	}
	if (files.some(filePath => filePath.startsWith('tests/Feature/')) && files.some(filePath => filePath.startsWith('tests/Unit/'))) {
		patterns.push(isRussianLocale ? 'разделение unit и feature/integration тестов' : 'separate unit and feature/integration test layers');
	}
	return patterns;
}

export function buildFileSummary(filePath: string, source: string, isRussianLocale: boolean): FileSummary {
	const imports = extractInternalImports(source);
	const role = describeFileRole(filePath, isRussianLocale);
	return {
		path: filePath,
		lineCount: source ? source.split(/\r?\n/).length : 0,
		role,
		symbols: extractDetailedSymbols(filePath, source, role, isRussianLocale).slice(0, MAX_SYMBOLS_PER_FILE),
		imports,
	};
}

function describeFileRole(filePath: string, isRussianLocale: boolean): string {
	const lower = filePath.toLowerCase();
	if (/^app\/http\/controllers\//.test(lower)) {
		return isRussianLocale ? 'HTTP-контроллеры и обработчики маршрутов' : 'HTTP controllers and route handlers';
	}
	if (/^app\/models\//.test(lower)) {
		return isRussianLocale ? 'модели данных и слой ORM' : 'data models and ORM layer';
	}
	if (/^app\/jobs\//.test(lower)) {
		return isRussianLocale ? 'фоновые задания и очередь' : 'background jobs and queue workload';
	}
	if (/^app\/providers\//.test(lower)) {
		return isRussianLocale ? 'провайдеры приложения и bootstrap сервисов' : 'application providers and service bootstrap';
	}
	if (/^app\/(dto|data)\//.test(lower)) {
		return isRussianLocale ? 'DTO и структуры входных данных' : 'DTOs and input data structures';
	}
	if (/^app\/services\//.test(lower)) {
		return isRussianLocale ? 'сервисная логика приложения' : 'application service logic';
	}
	if (lower.includes('/services/')) {
		return isRussianLocale ? 'сервисная логика и интеграции' : 'service logic and integrations';
	}
	if (lower.includes('/providers/')) {
		return isRussianLocale ? 'слой провайдеров и регистрации зависимостей' : 'provider layer and dependency registration';
	}
	if (lower.includes('/webview/')) {
		return isRussianLocale ? 'клиентская часть webview UI' : 'client-side webview UI';
	}
	if (lower.includes('/types/')) {
		return isRussianLocale ? 'контракты и типы данных' : 'shared contracts and data types';
	}
	if (lower.includes('/utils/')) {
		return isRussianLocale ? 'утилиты и чистые вычисления' : 'utility and pure computation helpers';
	}
	if (/^database\/migrations\//.test(lower)) {
		return isRussianLocale ? 'миграции и версия схемы базы данных' : 'database migrations and schema versioning';
	}
	if (/^database\/factories\//.test(lower)) {
		return isRussianLocale ? 'фабрики моделей для тестов и seed-данных' : 'model factories for tests and seed data';
	}
	if (/^database\/seeders\//.test(lower)) {
		return isRussianLocale ? 'заполнение базы начальными данными' : 'database seeders and initial data setup';
	}
	if (/^routes\//.test(lower)) {
		return isRussianLocale ? 'маршруты и карта HTTP/CLI-точек входа' : 'route declarations and HTTP/CLI entry mapping';
	}
	if (/^resources\/views\//.test(lower)) {
		return isRussianLocale ? 'шаблоны представлений и серверный UI' : 'view templates and server-rendered UI';
	}
	if (/^resources\/(js|ts|css|scss)\//.test(lower)) {
		return isRussianLocale ? 'frontend-ассеты и клиентские точки входа' : 'frontend assets and client entry points';
	}
	if (/^config\//.test(lower)) {
		return isRussianLocale ? 'конфигурация приложения и окружения' : 'application and environment configuration';
	}
	if (/^bootstrap\//.test(lower)) {
		return isRussianLocale ? 'bootstrap и запуск приложения' : 'bootstrap and application startup';
	}
	if (/^public\//.test(lower)) {
		return isRussianLocale ? 'публичные web-ассеты и входная точка HTTP' : 'public web assets and HTTP entry point';
	}
	if (/^storage\/framework\//.test(lower)) {
		return isRussianLocale ? 'сгенерированные runtime-артефакты фреймворка' : 'generated framework runtime artifacts';
	}
	if (/^storage\//.test(lower)) {
		return isRussianLocale ? 'runtime-хранилище, логи и временные данные' : 'runtime storage, logs, and temporary data';
	}
	if (/^artisan$/.test(lower)) {
		return isRussianLocale ? 'CLI-точка входа Laravel' : 'Laravel CLI entry point';
	}
	if (/composer\.json$/.test(lower)) {
		return isRussianLocale ? 'PHP-манифест зависимостей и автозагрузки' : 'PHP dependency and autoload manifest';
	}
	if (/package\.json$/.test(lower)) {
		return isRussianLocale ? 'манифест зависимостей и скриптов' : 'dependency and script manifest';
	}
	if (/phpunit\.xml$/.test(lower)) {
		return isRussianLocale ? 'конфигурация тестового раннера PHPUnit' : 'PHPUnit test runner configuration';
	}
	if (/docker-compose\.ya?ml$/.test(lower)) {
		return isRussianLocale ? 'docker-оркестрация локального окружения' : 'Docker orchestration for local environment';
	}
	if (/readme\.md$/.test(lower)) {
		return isRussianLocale ? 'документация проекта' : 'project documentation';
	}
	if (/test|spec/.test(lower)) {
		if (/^tests\/feature\//.test(lower)) {
			return isRussianLocale ? 'feature/integration тесты прикладных сценариев' : 'feature/integration tests for application scenarios';
		}
		if (/^tests\/unit\//.test(lower)) {
			return isRussianLocale ? 'unit-тесты отдельных компонентов и утилит' : 'unit tests for isolated components and utilities';
		}
		return isRussianLocale ? 'автотесты' : 'automated tests';
	}
	return isRussianLocale ? 'файл структуры проекта' : 'project structure file';
}

function extractDetailedSymbols(filePath: string, source: string, role: string, isRussianLocale: boolean): FileSymbolSummary[] {
	if (!source) {
		return [];
	}

	const isPhpLike = /\.php$/i.test(filePath);
	const isScriptLike = /\.(ts|tsx|js|jsx|mjs|cjs|vue)$/i.test(filePath);
	const symbols: FileSymbolSummary[] = [];
	const classPattern = /(?<!:)\b(?:export\s+)?(?:abstract\s+)?class(?:\s+([A-Za-z0-9_]+))?(?:\s+extends\s+[^{\n]+)?/g;
	for (const match of source.matchAll(classPattern)) {
		const rawClassName = match[1]?.trim();
		const className = !rawClassName || rawClassName.toLowerCase() === 'extends'
			? ANONYMOUS_CLASS_SYMBOL_NAME
			: rawClassName;
		const classIndex = match.index || 0;
		const location = getLocation(source, classIndex);
		const classBody = extractBraceBlock(source, classIndex);
		symbols.push({
			kind: 'class',
			name: className,
			signature: match[0].trim(),
			line: location.line,
			column: location.column,
			description: describeClassSymbol(filePath, className, match[0].trim(), role, isRussianLocale),
		});
		for (const method of extractClassMethods(filePath, classBody, role, isRussianLocale)) {
			symbols.push({
				...method,
				line: location.line + method.line - 1,
			});
		}
	}

	const patterns: Array<{ kind: string; regex: RegExp; enabled: boolean; describe: (name: string, signature: string) => string }> = [
		{
			kind: 'function',
			regex: /(^|\n)\s*(?:export\s+)?function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/g,
			enabled: isScriptLike || isPhpLike,
			describe: (name, signature) => describeRoutineSymbol(filePath, 'function', name, signature, role, isRussianLocale),
		},
		{
			kind: 'const',
			regex: isPhpLike
				? /\bconst\s+([A-Za-z0-9_]+)\s*=\s*([^\n;]+)/g
				: /(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*([^\n;]+)/g,
			enabled: isScriptLike || isPhpLike,
			describe: (name, signature) => describeConstantSymbol(name, signature, isRussianLocale),
		},
		{
			kind: 'interface',
			regex: /(?:export\s+)?interface\s+([A-Za-z0-9_]+)/g,
			enabled: isScriptLike,
			describe: (name) => describeInterfaceSymbol(name, isRussianLocale),
		},
		{
			kind: 'type',
			regex: /(?:export\s+)?type\s+([A-Za-z0-9_]+)/g,
			enabled: isScriptLike,
			describe: (name) => describeTypeSymbol(name, isRussianLocale),
		},
		{
			kind: 'enum',
			regex: /(?:export\s+)?enum\s+([A-Za-z0-9_]+)/g,
			enabled: isScriptLike,
			describe: (name) => describeEnumSymbol(name, isRussianLocale),
		},
	];

	for (const pattern of patterns) {
		if (!pattern.enabled) {
			continue;
		}
		for (const match of source.matchAll(pattern.regex)) {
			const name = pattern.kind === 'function' ? match[2] : match[1];
			const signature = match[0].trim();
			const symbolIndex = pattern.kind === 'function'
				? (match.index || 0) + (match[1]?.length || 0)
				: (match.index || 0);
			const location = getLocation(source, symbolIndex);
			if (symbols.some(item => item.kind === pattern.kind && item.name === name && item.line === location.line)) {
				continue;
			}
			symbols.push({
				kind: pattern.kind,
				name,
				signature,
				line: location.line,
				column: location.column,
				description: pattern.describe(name, signature),
			});
		}
	}

	return symbols.sort((left, right) => left.line - right.line || left.column - right.column);
}

function extractClassMethods(filePath: string, classBody: string, role: string, isRussianLocale: boolean): FileSymbolSummary[] {
	const methods: FileSymbolSummary[] = [];
	if (!classBody) {
		return methods;
	}

	const reservedWords = new Set(['if', 'for', 'while', 'switch', 'catch', 'return']);
	const patterns = [
		/(^|\n)\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?::\s*([^\s{]+))?/g,
		/(^|\n)\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|override\s+)*(?:get\s+|set\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)\s*(?::\s*([^\n{]+))?\s*\{/g,
	];

	for (const pattern of patterns) {
		for (const match of classBody.matchAll(pattern)) {
			const name = match[2];
			if (!name || reservedWords.has(name)) {
				continue;
			}
			const index = (match.index || 0) + (match[1]?.length || 0);
			const location = getLocation(classBody, index);
			const params = (match[3] || '').trim();
			const returnType = (match[4] || '').trim();
			const signature = `${name}(${params})${returnType ? `: ${returnType}` : ''}`;
			if (methods.some(item => item.name === name && item.line === location.line)) {
				continue;
			}
			methods.push({
				kind: 'method',
				name,
				signature,
				line: location.line,
				column: location.column,
				description: describeRoutineSymbol(filePath, 'method', name, signature, role, isRussianLocale),
			});
		}
	}

	return methods;
}

function extractBraceBlock(source: string, startIndex: number): string {
	const openIndex = source.indexOf('{', startIndex);
	if (openIndex < 0) {
		return '';
	}
	let depth = 0;
	for (let index = openIndex; index < source.length; index += 1) {
		const character = source[index];
		if (character === '{') {
			depth += 1;
		} else if (character === '}') {
			depth -= 1;
			if (depth === 0) {
				return source.slice(openIndex + 1, index);
			}
		}
	}
	return source.slice(openIndex + 1);
}

function getLocation(source: string, index: number): { line: number; column: number } {
	const prefix = source.slice(0, index);
	const lines = prefix.split(/\r?\n/);
	return {
		line: lines.length,
		column: (lines[lines.length - 1]?.length || 0) + 1,
	};
}

function extractInternalImports(source: string): string[] {
	if (!source) {
		return [];
	}
	const imports = new Set<string>();
	for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
		const target = match[1]?.trim();
		if (target && (target.startsWith('.') || target.startsWith('@/') || target.startsWith('src/'))) {
			imports.add(target);
		}
	}
	for (const match of source.matchAll(/\buse\s+([A-Za-z0-9_\\]+)\s*;/g)) {
		const target = match[1]?.trim();
		if (target && /^(App|Tests|Database)\\/.test(target)) {
			imports.add(target);
		}
	}
	return Array.from(imports).slice(0, 8);
}

function buildRelations(fileSummaries: FileSummary[], isRussianLocale: boolean): string[] {
	const relations: string[] = [];
	for (const file of fileSummaries) {
		for (const imported of file.imports) {
			relations.push(isRussianLocale
				? `${file.path} использует ${imported}`
				: `${file.path} depends on ${imported}`);
		}
	}
	return relations.slice(0, MAX_RELATIONS);
}

function parseRecentChanges(stdout: string, isRussianLocale: boolean): string[] {
	const lines = stdout.split(/\r?\n/);
	const result: string[] = [];
	let currentHeader = '';
	let currentFiles: string[] = [];

	const flush = () => {
		if (!currentHeader) {
			return;
		}
		const fileSuffix = currentFiles.length > 0 ? ` (${currentFiles.slice(0, 4).join(', ')}${currentFiles.length > 4 ? ', ...' : ''})` : '';
		result.push(`${currentHeader}${fileSuffix}`);
		currentHeader = '';
		currentFiles = [];
	};

	for (const line of lines) {
		if (!line.trim()) {
			flush();
			continue;
		}

		if (line.includes('\t')) {
			flush();
			const [sha, date, message] = line.split('\t');
			currentHeader = isRussianLocale
				? `${date}: ${message} [${sha.slice(0, 7)}]`
				: `${date}: ${message} [${sha.slice(0, 7)}]`;
			continue;
		}

		currentFiles.push(line.trim());
	}

	flush();
	return result;
}

function isBinaryLikeFile(filePath: string): boolean {
	return /\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|pdf|zip|gz|wasm|lock)$/i.test(filePath);
}

function trimSnippet(source: string): string {
	const normalized = source.replace(/\r/g, '').trim();
	if (!normalized) {
		return '';
	}
	return normalized.slice(0, 1800);
}

function estimateAreaBatchItemChars(item: CodeMapAreaDescriptionBatchItem): number {
	const filesChars = item.representativeFiles.join(', ').length;
	const symbolsChars = item.symbols.join(', ').length;
	const snippetsChars = item.snippets.reduce((total, snippet) => total + snippet.filePath.length + snippet.snippet.length + 32, 0);
	return item.id.length
		+ item.area.length
		+ (item.manifestDescription?.length || 0)
		+ filesChars
		+ symbolsChars
		+ snippetsChars
		+ 256;
}

export function buildAreaDescriptionBatches<T extends CodeMapAreaDescriptionBatchItem>(
	items: T[],
	maxChars: number,
): T[][] {
	const limit = Math.max(4000, Math.floor(maxChars || 0));
	const batches: T[][] = [];
	let currentBatch: T[] = [];
	let currentChars = 0;

	for (const item of items) {
		const itemChars = estimateAreaBatchItemChars(item);
		if (currentBatch.length > 0 && currentChars + itemChars > limit) {
			batches.push(currentBatch);
			currentBatch = [];
			currentChars = 0;
		}

		currentBatch.push(item);
		currentChars += itemChars;
	}

	if (currentBatch.length > 0) {
		batches.push(currentBatch);
	}

	return batches;
}

function extractJsonCandidate(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		return '';
	}

	const withoutFences = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
	if (withoutFences.startsWith('{') || withoutFences.startsWith('[')) {
		return withoutFences;
	}

	const objectStart = withoutFences.indexOf('{');
	const objectEnd = withoutFences.lastIndexOf('}');
	if (objectStart >= 0 && objectEnd > objectStart) {
		return withoutFences.slice(objectStart, objectEnd + 1);
	}

	const arrayStart = withoutFences.indexOf('[');
	const arrayEnd = withoutFences.lastIndexOf(']');
	if (arrayStart >= 0 && arrayEnd > arrayStart) {
		return withoutFences.slice(arrayStart, arrayEnd + 1);
	}

	return withoutFences;
}

export function parseCodeMapAreaBatchResponse(value: string): Record<string, string> {
	const candidate = extractJsonCandidate(value);
	if (!candidate) {
		return {};
	}

	try {
		const parsed = JSON.parse(candidate) as unknown;
		const result: Record<string, string> = {};
		const collect = (entries: unknown[]) => {
			for (const entry of entries) {
				if (!entry || typeof entry !== 'object') {
					continue;
				}
				const record = entry as Record<string, unknown>;
				const id = String(record.id || '').trim();
				const description = String(record.description || '').trim();
				if (id) {
					result[id] = description;
				}
			}
		};

		if (Array.isArray(parsed)) {
			collect(parsed);
			return result;
		}

		if (!parsed || typeof parsed !== 'object') {
			return {};
		}

		const record = parsed as Record<string, unknown>;
		if (Array.isArray(record.areas)) {
			collect(record.areas);
			return result;
		}

		for (const [key, entryValue] of Object.entries(record)) {
			if (typeof entryValue === 'string') {
				result[key] = entryValue;
			}
		}

		return result;
	} catch {
		return {};
	}
}

function normalizeAreaDescription(value: string, maxChars: number): string {
	const normalized = value
		.replace(/```[\s\S]*?```/g, '')
		.replace(/^[\-*]\s+/gm, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!normalized) {
		return '';
	}
	return normalized.slice(0, Math.max(200, maxChars));
}

function pathBasename(projectPath: string): string {
	const parts = projectPath.split('/').filter(Boolean);
	return parts[parts.length - 1] || projectPath;
}

function buildAreaEntries(files: string[]): Array<{ area: string; files: string[] }> {
	const groups = new Map<string, string[]>();

	for (const filePath of files) {
		const area = detectAreaKey(filePath);
		if (!groups.has(area)) {
			groups.set(area, []);
		}
		groups.get(area)!.push(filePath);
	}

	return Array.from(groups.entries())
		.map(([area, groupFiles]) => ({
			area,
			files: groupFiles.sort((left, right) => scoreRepresentativeFile(right) - scoreRepresentativeFile(left)),
		}))
		.sort((left, right) => {
			const scoreDiff = scoreArea(left.area, left.files.length) - scoreArea(right.area, right.files.length);
			if (scoreDiff !== 0) {
				return scoreDiff;
			}

			return right.files.length - left.files.length;
		});
}

function detectAreaKey(filePath: string): string {
	const parts = filePath.split('/').filter(Boolean);
	if (parts.length === 0) {
		return '.';
	}

	if (parts[0] === 'src' && parts.length >= 2) {
		return `src/${parts[1]}`;
	}

	if (parts[0] === 'webview' && parts.length >= 2) {
		return `webview/${parts[1]}`;
	}

	return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
}

function scoreArea(area: string, fileCount: number): number {
	const priorityMap: Record<string, number> = {
		'app/Http': 98,
		'app/Models': 95,
		'app/Services': 94,
		'app/Providers': 93,
		'database/migrations': 90,
		'routes/api-testing.php': 88,
		'routes': 87,
		'tests/Feature': 84,
		'tests/Unit': 82,
		'src/services': 100,
		'src/providers': 96,
		'src/webview': 92,
		'src/types': 88,
		'src/utils': 86,
		'src': 84,
		'tests': 60,
		'scripts': 58,
		'media': 40,
	};

	for (const [prefix, weight] of Object.entries(priorityMap)) {
		if (area === prefix || area.startsWith(`${prefix}/`)) {
			return -(weight + fileCount / 100);
		}
	}

	return -(fileCount / 100);
}

function scoreRepresentativeFile(filePath: string): number {
	let score = 0;
	if (/^artisan$/.test(filePath)) { score += 130; }
	if (/^bootstrap\/app\.php$/.test(filePath)) { score += 120; }
	if (/^routes\//.test(filePath)) { score += 95; }
	if (/^app\/Http\/Controllers\//.test(filePath)) { score += 90; }
	if (/^app\/(Models|Services|Providers|Jobs|Dto)\//.test(filePath)) { score += 80; }
	if (/^database\/migrations\//.test(filePath)) { score += 75; }
	if (/^tests\/(Feature|Unit)\//.test(filePath)) { score += 70; }
	if (/extension\.[jt]s$/.test(filePath)) { score += 120; }
	if (/index\.[jt]s$/.test(filePath)) { score += 80; }
	if (/App\.[jt]sx?$/.test(filePath)) { score += 70; }
	if (/service|provider|manager|panel|controller|router|store/i.test(filePath)) { score += 60; }
	if (/types?|schema|model/i.test(filePath)) { score += 35; }
	if (/test|spec/i.test(filePath)) { score -= /^tests\//.test(filePath) ? 0 : 30; }
	return score - filePath.length / 1000;
}

function buildArchitectureSummary(files: string[], manifest: PackageManifest | null, composerManifest: ComposerManifest | null, isRussianLocale: boolean): string[] {
	const lines: string[] = [];
	const hasExtensionEntry = files.includes('src/extension.ts') || files.includes('src/extension.js');
	const hasWebview = files.some(filePath => filePath.startsWith('src/webview/') || filePath.startsWith('webview/'));
	const hasServices = files.some(filePath => /(^|\/)services\//.test(filePath));
	const hasProviders = files.some(filePath => /(^|\/)providers\//.test(filePath));
	const hasTests = files.some(filePath => /(^|\/)(tests|__tests__)\//.test(filePath));
	const dependencies = collectProjectDependencies(manifest, composerManifest).map(value => value.toLowerCase());

	if (dependencies.includes('vscode') || hasExtensionEntry) {
		lines.push(isRussianLocale
			? 'Проект выглядит как VS Code extension: есть extension host точка входа и команды редактора.'
			: 'The project looks like a VS Code extension with an extension-host entry point and editor commands.');
	}

	if (hasProviders && hasWebview) {
		lines.push(isRussianLocale
			? 'UI отделён от extension host: провайдеры и panel manager-ы управляют webview, а клиентские компоненты живут отдельно.'
			: 'UI is separated from the extension host: providers and panel managers control webviews while client components live separately.');
	}

	if (hasServices) {
		lines.push(isRussianLocale
			? 'Сервисный слой собирает интеграции и доменную логику; по именам каталогов видно разделение на storage/git/AI/memory/codemap задачи.'
			: 'The service layer concentrates integrations and domain logic, with folders suggesting storage/git/AI/memory/codemap responsibilities.');
	}

	if (isLaravelProject(files, composerManifest)) {
		lines.push(isRussianLocale
			? 'HTTP-поток строится по типичной схеме Laravel: routes направляют запросы в controllers, модели и сервисы обслуживают бизнес-логику, а миграции фиксируют схему БД.'
			: 'The HTTP flow follows a typical Laravel shape: routes send requests into controllers, models and services handle business logic, and migrations version the database schema.');
	}

	if (hasTests) {
		lines.push(isRussianLocale
			? 'В проекте есть отдельный набор автотестов, что позволяет проверять утилиты и генерацию инструкций отдельно от runtime расширения.'
			: 'The project includes a dedicated automated test suite, so utilities and instruction generation can be validated outside the extension runtime.');
	}

	if (lines.length === 0) {
		lines.push(isRussianLocale
			? 'Архитектура определяется в основном по структуре каталогов и ключевым конфигурационным файлам.'
			: 'Architecture is currently inferred mainly from folder structure and key configuration files.');
	}

	return lines;
}

function findEntryPoints(files: string[], isRussianLocale: boolean): string[] {
	const candidates = files
		.filter(filePath =>
			/(^|\/)(extension|index|main|app|server|cli)\.[jt]sx?$/.test(filePath)
			|| /^bootstrap\/app\.php$/.test(filePath)
			|| /^public\/index\.php$/.test(filePath)
			|| /^artisan$/.test(filePath)
			|| /^routes\/(web|api|console)(-testing)?\.php$/.test(filePath),
		)
		.sort((left, right) => scoreRepresentativeFile(right) - scoreRepresentativeFile(left))
		.slice(0, 8);
	return candidates.map(filePath => {
		const hint = describeEntryPoint(filePath, isRussianLocale);
		return `${filePath}${hint ? ` — ${hint}` : ''}`;
	});
}

function describeEntryPoint(filePath: string, isRussianLocale: boolean): string {
	if (/extension\.[jt]s$/.test(filePath)) {
		return isRussianLocale ? 'основная точка входа extension host' : 'main extension-host entry point';
	}
	if (/index\.[jt]s$/.test(filePath)) {
		return isRussianLocale ? 'точка сборки или публичный экспорт модуля' : 'module export or package entry point';
	}
	if (/App\.[jt]sx?$/.test(filePath) || /app\.[jt]sx?$/.test(filePath)) {
		return isRussianLocale ? 'корневой UI-компонент' : 'root UI component';
	}
	if (/^bootstrap\/app\.php$/.test(filePath)) {
		return isRussianLocale ? 'bootstrap приложения и сборка контейнера Laravel' : 'application bootstrap and Laravel container wiring';
	}
	if (/^public\/index\.php$/.test(filePath)) {
		return isRussianLocale ? 'публичная HTTP-точка входа приложения' : 'public HTTP entry point of the application';
	}
	if (/^artisan$/.test(filePath)) {
		return isRussianLocale ? 'CLI-вход для artisan-команд' : 'CLI entry for artisan commands';
	}
	if (/^routes\/web\.php$/.test(filePath)) {
		return isRussianLocale ? 'web-маршруты пользовательского интерфейса' : 'web route declarations';
	}
	if (/^routes\/api(-testing)?\.php$/.test(filePath)) {
		return isRussianLocale ? 'API-маршруты и тестовые HTTP-сценарии' : 'API routes and test HTTP scenarios';
	}
	if (/^routes\/console\.php$/.test(filePath)) {
		return isRussianLocale ? 'консольные команды и scheduled hooks' : 'console commands and scheduled hooks';
	}
	if (/server|cli|main/i.test(filePath)) {
		return isRussianLocale ? 'управляющий исполняемый файл' : 'control or executable entry file';
	}
	return '';
}

function describeArea(area: string, files: string[], symbols: string[], isRussianLocale: boolean): string {
	const lower = area.toLowerCase();
	const fileHint = files.slice(0, 2).join(', ');
	const symbolHint = symbols.length > 0 ? symbols.join(', ') : '';

	if (lower.includes('services')) {
		return isRussianLocale
			? `Сервисный слой с прикладной логикой и интеграциями. Видны основные точки поведения: ${symbolHint || fileHint}.`
			: `Service layer for application logic and integrations. Main behavior points visible here: ${symbolHint || fileHint}.`;
	}

	if (lower.includes('providers')) {
		return isRussianLocale
			? `Слой провайдеров и manager-классов, который связывает VS Code API, webview и команды. Репрезентативные элементы: ${symbolHint || fileHint}.`
			: `Provider and manager layer that connects the VS Code API, webviews, and commands. Representative elements: ${symbolHint || fileHint}.`;
	}

	if (lower.includes('webview')) {
		return isRussianLocale
			? `Клиентская UI-часть webview. Здесь находятся экраны, панели и визуальные компоненты: ${symbolHint || fileHint}.`
			: `Client-side webview UI. Screens, panels, and visual components live here: ${symbolHint || fileHint}.`;
	}

	if (lower.includes('types')) {
		return isRussianLocale
			? `Контракты данных и типы, которыми обмениваются сервисы, UI и extension host. Ключевые определения: ${symbolHint || fileHint}.`
			: `Data contracts and types shared between services, UI, and the extension host. Key definitions: ${symbolHint || fileHint}.`;
	}

	if (lower.includes('utils')) {
		return isRussianLocale
			? `Утилиты и чистые функции для вычислений, форматирования и вспомогательной логики. Наиболее заметные элементы: ${symbolHint || fileHint}.`
			: `Utilities and pure helpers for calculations, formatting, and support logic. Notable elements: ${symbolHint || fileHint}.`;
	}

	if (lower.includes('test')) {
		if (lower.includes('tests/feature')) {
			return isRussianLocale
				? `Feature/integration тесты проверяют сквозные сценарии через HTTP, контейнер приложения или БД. Репрезентативные элементы: ${symbolHint || fileHint}.`
				: `Feature/integration tests validate end-to-end scenarios through HTTP, the application container, or the database. Representative elements: ${symbolHint || fileHint}.`;
		}
		if (lower.includes('tests/unit')) {
			return isRussianLocale
				? `Unit-тесты изолированно проверяют методы, хелперы и небольшие сервисы. Репрезентативные элементы: ${symbolHint || fileHint}.`
				: `Unit tests validate methods, helpers, and small services in isolation. Representative elements: ${symbolHint || fileHint}.`;
		}
		return isRussianLocale
			? `Автотесты, фиксирующие ожидаемое поведение ключевых утилит и генераторов. Покрываемые файлы: ${fileHint}.`
			: `Automated tests that lock expected behavior for core utilities and generators. Covered files include ${fileHint}.`;
	}

	if (lower.includes('database/migrations')) {
		return isRussianLocale
			? `Миграции описывают создание, изменение и откат структуры базы данных. Основные файлы: ${fileHint}.`
			: `Migrations define database schema creation, change, and rollback steps. Main files: ${fileHint}.`;
	}

	if (lower.includes('app/http')) {
		return isRussianLocale
			? `HTTP-слой принимает запросы, валидирует входные данные и делегирует работу модели или сервисам. Репрезентативные элементы: ${symbolHint || fileHint}.`
			: `The HTTP layer accepts requests, validates input, and delegates work to models or services. Representative elements: ${symbolHint || fileHint}.`;
	}

	if (lower.includes('app/models')) {
		return isRussianLocale
			? `Модели описывают доменные сущности и их связь с хранилищем данных. Репрезентативные элементы: ${symbolHint || fileHint}.`
			: `Models describe domain entities and their relationship to persistent storage. Representative elements: ${symbolHint || fileHint}.`;
	}

	if (lower.includes('routes')) {
		return isRussianLocale
			? `Маршруты связывают URL или консольные команды с контроллерами и обработчиками. Основные файлы: ${fileHint}.`
			: `Routes connect URLs or console commands to controllers and handlers. Main files: ${fileHint}.`;
	}

	if (lower.includes('config')) {
		return isRussianLocale
			? `Конфигурационный слой задаёт поведение окружения, сервисов и фреймворка. Основные файлы: ${fileHint}.`
			: `Configuration defines environment, service, and framework behavior. Main files: ${fileHint}.`;
	}

	if (lower.includes('scripts')) {
		return isRussianLocale
			? `Служебные скрипты для сборки, синхронизации метаданных и операционных задач. Основные файлы: ${fileHint}.`
			: `Operational scripts for build flow, metadata synchronization, and maintenance tasks. Main files: ${fileHint}.`;
	}

	if (lower.includes('media')) {
		return isRussianLocale
			? `Статические ресурсы и ассеты интерфейса. Используются extension UI и webview.`
			: `Static assets used by the extension UI and webviews.`;
	}

	return isRussianLocale
		? `Область ${area} собирает связанные файлы вокруг одной ответственности. Репрезентативные элементы: ${symbolHint || fileHint}.`
		: `Area ${area} groups related files around a shared responsibility. Representative elements: ${symbolHint || fileHint}.`;
}

function extractSymbolNames(filePath: string, source: string): string[] {
	return Array.from(new Set(extractDetailedSymbols(filePath, source, '', false).map(symbol => symbol.name)));
}

function summarizeExtensions(files: string[]): string[] {
	const counts = new Map<string, number>();
	for (const filePath of files) {
		const extension = normalizeLanguageLabel(filePath);
		if (!extension) {
			continue;
		}
		counts.set(extension, (counts.get(extension) || 0) + 1);
	}

	return Array.from(counts.entries())
		.sort((left, right) => right[1] - left[1])
		.slice(0, 8)
		.map(([extension]) => extension);
}

function detectFrameworks(manifest: PackageManifest | null, composerManifest: ComposerManifest | null, files: string[]): string[] {
	const dependencies = collectProjectDependencies(manifest, composerManifest).map(value => value.toLowerCase());
	const detected: string[] = [];
	const signals: Array<[string, string]> = [
		['vscode', 'VS Code Extension'],
		['laravel/framework', 'Laravel'],
		['illuminate/', 'Laravel'],
		['phpunit/phpunit', 'PHPUnit'],
		['react', 'React'],
		['vue', 'Vue'],
		['next', 'Next.js'],
		['express', 'Express'],
		['nestjs', 'NestJS'],
		['tailwindcss', 'Tailwind CSS'],
		['vite', 'Vite'],
		['typescript', 'TypeScript'],
		['sql.js', 'sql.js'],
	];

	for (const [needle, label] of signals) {
		if (dependencies.some(value => value === needle || value.includes(needle))) {
			detected.push(label);
		}
	}

	if (detected.length === 0 && isLaravelProject(files, composerManifest)) {
		detected.push('Laravel');
	}

	return Array.from(new Set(detected));
}

function normalizeLanguageLabel(filePath: string): string | null {
	const lower = filePath.toLowerCase();
	if (lower.endsWith('.blade.php')) { return 'blade'; }
	if (lower.endsWith('.php')) { return 'php'; }
	if (lower.endsWith('.ts')) { return 'ts'; }
	if (lower.endsWith('.tsx')) { return 'tsx'; }
	if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) { return 'js'; }
	if (lower.endsWith('.jsx')) { return 'jsx'; }
	if (lower.endsWith('.json')) { return 'json'; }
	if (lower.endsWith('.md')) { return 'md'; }
	if (lower.endsWith('.yml') || lower.endsWith('.yaml')) { return 'yaml'; }
	if (lower.endsWith('.xml')) { return 'xml'; }
	if (lower.endsWith('.css')) { return 'css'; }
	if (lower.endsWith('.scss')) { return 'scss'; }
	if (lower.endsWith('.sql')) { return 'sql'; }
	if (lower.endsWith('.sh')) { return 'sh'; }
	if (lower === 'artisan') { return 'php'; }
	if (lower.startsWith('.env')) { return 'env'; }
	return null;
}

function collectProjectScripts(manifest: PackageManifest | null, composerManifest: ComposerManifest | null): string[] {
	return Array.from(new Set([
		...Object.keys(manifest?.scripts || {}),
		...Object.keys(composerManifest?.scripts || {}),
	])).filter(Boolean);
}

function collectProjectDependencies(manifest: PackageManifest | null, composerManifest: ComposerManifest | null): string[] {
	return Array.from(new Set([
		...Object.keys(manifest?.dependencies || {}),
		...Object.keys(manifest?.devDependencies || {}),
		...Object.keys(composerManifest?.require || {}),
		...Object.keys(composerManifest?.requireDev || {}),
	].filter(name => name && name !== 'php' && !name.startsWith('ext-'))));
}

function resolveProjectName(manifest: PackageManifest | null, composerManifest: ComposerManifest | null, repository: string): string {
	return manifest?.name || composerManifest?.name || repository;
}

function resolveProjectDescription(manifest: PackageManifest | null, composerManifest: ComposerManifest | null, isRussianLocale: boolean, fallback: string): string {
	return manifest?.description?.trim() || composerManifest?.description?.trim() || fallback || (isRussianLocale ? 'Описание проекта не найдено.' : 'Project description was not found.');
}

function isLaravelProject(files: string[], composerManifest: ComposerManifest | null): boolean {
	const dependencies = [
		...Object.keys(composerManifest?.require || {}),
		...Object.keys(composerManifest?.requireDev || {}),
	].map(value => value.toLowerCase());
	return dependencies.some(value => value === 'laravel/framework' || value.startsWith('illuminate/'))
		|| (files.some(filePath => filePath.startsWith('app/Http/Controllers/'))
			&& files.some(filePath => filePath.startsWith('routes/'))
			&& files.some(filePath => filePath.startsWith('database/migrations/')));
}

function isAnalysisNoiseFile(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	return lower.endsWith('.swp')
		|| lower.endsWith('.swo')
		|| lower.endsWith('~')
		|| lower === '.gitignore'
		|| lower === '.gitattributes'
		|| lower === '.editorconfig'
		|| /\/\.gitignore$/.test(lower)
		|| /^storage\/framework\//.test(lower)
		|| /^bootstrap\/cache\//.test(lower)
		|| /^vendor\//.test(lower)
		|| /^node_modules\//.test(lower)
		|| /(^|\/)\.ds_store$/.test(lower)
		|| /composer\.lock$/.test(lower)
		|| /package-lock\.json$/.test(lower)
		|| /pnpm-lock\.ya?ml$/.test(lower)
		|| /yarn\.lock$/.test(lower)
		|| /^public\/favicon\.ico$/.test(lower)
		|| isBinaryLikeFile(filePath);
}

function selectFilesForAnalysis(files: string[]): string[] {
	const relevant = files.filter(filePath => !isAnalysisNoiseFile(filePath));
	return relevant.length > 0 ? relevant : files.filter(filePath => !isBinaryLikeFile(filePath));
}

function selectFilesForDetailedSummary(files: string[]): string[] {
	return files
		.filter(filePath => !/^storage\//.test(filePath.toLowerCase()))
		.sort((left, right) => scoreDetailedFile(right) - scoreDetailedFile(left))
		.slice(0, MAX_FILE_SUMMARY_COUNT)
		.sort((left, right) => left.localeCompare(right));
}

function scoreDetailedFile(filePath: string): number {
	let score = scoreRepresentativeFile(filePath);
	const lower = filePath.toLowerCase();
	if (/^config\//.test(lower)) { score += 50; }
	if (/^resources\/views\//.test(lower)) { score += 40; }
	if (/^resources\/(js|ts|css|scss)\//.test(lower)) { score += 45; }
	if (/^database\/(migrations|factories|seeders)\//.test(lower)) { score += 55; }
	if (/^tests\/(feature|unit)\//.test(lower)) { score += 35; }
	if (/^README\.md$/i.test(filePath)) { score += 20; }
	if (/^package\.json$|^composer\.json$|^phpunit\.xml$|^artisan$/i.test(filePath)) { score += 65; }
	if (/\.example$/.test(lower)) { score -= 25; }
	return score;
}

function describeClassSymbol(filePath: string, className: string, signature: string, role: string, isRussianLocale: boolean): string {
	const lower = filePath.toLowerCase();
	const extendsMatch = signature.match(/extends\s+([A-Za-z0-9_\\]+)/);
	const baseClass = extendsMatch?.[1];
	const displayName = className === ANONYMOUS_CLASS_SYMBOL_NAME
		? (isRussianLocale ? 'анонимный класс' : 'anonymous class')
		: className;

	if (/^tests\//.test(lower)) {
		return isRussianLocale
			? `Тестовый класс ${displayName} группирует сценарии проверки для области «${role}».${baseClass ? ` Наследуется от ${baseClass}.` : ''}`
			: `Test class ${displayName} groups verification scenarios for the “${role}” area.${baseClass ? ` It extends ${baseClass}.` : ''}`;
	}
	if (/^app\/http\/controllers\//.test(lower)) {
		return isRussianLocale
			? `Класс ${displayName} обрабатывает HTTP-сценарии этой области и координирует ответ клиенту.${baseClass ? ` Базовый класс: ${baseClass}.` : ''}`
			: `Class ${displayName} handles HTTP scenarios in this area and coordinates responses back to the client.${baseClass ? ` Base class: ${baseClass}.` : ''}`;
	}
	if (/^app\/models\//.test(lower)) {
		return isRussianLocale
			? `Класс ${displayName} представляет доменную модель и поведение, связанное с хранением данных.${baseClass ? ` Наследуется от ${baseClass}.` : ''}`
			: `Class ${displayName} represents a domain model and behavior tied to persistent data.${baseClass ? ` It extends ${baseClass}.` : ''}`;
	}
	if (/^app\/providers\//.test(lower)) {
		return isRussianLocale
			? `Класс ${displayName} отвечает за регистрацию и bootstrap зависимостей приложения.${baseClass ? ` Наследуется от ${baseClass}.` : ''}`
			: `Class ${displayName} is responsible for dependency registration and application bootstrap.${baseClass ? ` It extends ${baseClass}.` : ''}`;
	}
	if (/^app\/jobs\//.test(lower)) {
		return isRussianLocale
			? `Класс ${displayName} описывает фоновую задачу или единицу работы для очереди.${baseClass ? ` Наследуется от ${baseClass}.` : ''}`
			: `Class ${displayName} describes a background job or queue work item.${baseClass ? ` It extends ${baseClass}.` : ''}`;
	}
	if (/^app\/(services|dto)\//.test(lower) || /\/services\//.test(lower)) {
		return isRussianLocale
			? `Класс ${displayName} концентрирует ответственность области «${role}».${baseClass ? ` Наследуется от ${baseClass}.` : ''}`
			: `Class ${displayName} concentrates the responsibility of the “${role}” area.${baseClass ? ` It extends ${baseClass}.` : ''}`;
	}

	return isRussianLocale
		? `Класс ${displayName} является основным объектом этого файла и задаёт его публичную ответственность.${baseClass ? ` Наследуется от ${baseClass}.` : ''}`
		: `Class ${displayName} is the main object in this file and defines its public responsibility.${baseClass ? ` It extends ${baseClass}.` : ''}`;
}

function describeRoutineSymbol(filePath: string, kind: 'function' | 'method', name: string, signature: string, role: string, isRussianLocale: boolean): string {
	const lower = filePath.toLowerCase();
	const normalizedName = name.toLowerCase();
	const subject = kind === 'method'
		? (isRussianLocale ? 'Метод' : 'Method')
		: (isRussianLocale ? 'Функция' : 'Function');

	if (normalizedName === '__construct' || normalizedName === 'constructor') {
		return isRussianLocale
			? `${subject} ${name} инициализирует объект, зависимости или исходную конфигурацию.`
			: `${subject} ${name} initializes the object, its dependencies, or starting configuration.`;
	}
	if (normalizedName === 'setup') {
		return isRussianLocale
			? `${subject} ${name} подготавливает тестовое окружение перед выполнением сценариев.`
			: `${subject} ${name} prepares the test environment before scenarios run.`;
	}
	if (normalizedName === 'teardown') {
		return isRussianLocale
			? `${subject} ${name} очищает временное состояние после завершения тестов.`
			: `${subject} ${name} cleans temporary state after the tests finish.`;
	}
	if (normalizedName === 'up' && /^database\/migrations\//.test(lower)) {
		return isRussianLocale
			? `${subject} ${name} применяет изменения схемы базы данных для этой миграции.`
			: `${subject} ${name} applies the database schema changes for this migration.`;
	}
	if (normalizedName === 'down' && /^database\/migrations\//.test(lower)) {
		return isRussianLocale
			? `${subject} ${name} откатывает изменения схемы базы данных, сделанные миграцией.`
			: `${subject} ${name} rolls back the schema changes made by this migration.`;
	}
	if (normalizedName === 'register' && /provider/.test(lower)) {
		return isRussianLocale
			? `${subject} ${name} регистрирует сервисы и зависимости в контейнере приложения.`
			: `${subject} ${name} registers services and dependencies in the application container.`;
	}
	if (normalizedName === 'boot' && /provider/.test(lower)) {
		return isRussianLocale
			? `${subject} ${name} завершает bootstrap области и подключает runtime-поведение.`
			: `${subject} ${name} finalizes bootstrap for the area and attaches runtime behavior.`;
	}
	if (normalizedName === 'handle') {
		return isRussianLocale
			? `${subject} ${name} служит основной точкой выполнения для команды, middleware или фоновой задачи.`
			: `${subject} ${name} acts as the main execution entry for a command, middleware, or background job.`;
	}
	if (normalizedName === 'render') {
		return isRussianLocale
			? `${subject} ${name} преобразует внутреннее состояние в HTTP- или UI-представление.`
			: `${subject} ${name} transforms internal state into an HTTP or UI representation.`;
	}
	if (normalizedName === 'toarray') {
		return isRussianLocale
			? `${subject} ${name} сериализует объект в структуру данных для ответа или хранения.`
			: `${subject} ${name} serializes the object into a data structure for responses or storage.`;
	}
	if (normalizedName === 'definition') {
		return isRussianLocale
			? `${subject} ${name} задаёт шаблон данных для фабрики и генерации тестовых записей.`
			: `${subject} ${name} defines the data template for a factory and generated test records.`;
	}
	if (normalizedName === 'rules') {
		return isRussianLocale
			? `${subject} ${name} возвращает правила валидации входных данных.`
			: `${subject} ${name} returns validation rules for incoming data.`;
	}
	if (normalizedName === 'casts') {
		return isRussianLocale
			? `${subject} ${name} описывает преобразования типов для полей модели или DTO.`
			: `${subject} ${name} defines type casts for model or DTO fields.`;
	}
	if (normalizedName === 'response') {
		return isRussianLocale
			? `${subject} ${name} формирует унифицированный ответ для вызывающего кода.`
			: `${subject} ${name} builds a normalized response for the caller.`;
	}
	if (isTestLikeName(name) || /^tests\//.test(lower)) {
		return isRussianLocale
			? `${subject} ${name} проверяет отдельный сценарий этой области.`
			: `${subject} ${name} verifies the scenario: ${humanizeSymbolName(name, isRussianLocale)}.`;
	}
	if (/^app\/http\/controllers\//.test(lower)) {
		return isRussianLocale
			? `${subject} ${name} обслуживает HTTP-сценарий этой области и управляет ответом клиенту.`
			: `${subject} ${name} serves an HTTP scenario in this area and manages the response to the client.`;
	}
	if (/^app\/services\//.test(lower) || /\/services\//.test(lower)) {
		return isRussianLocale
			? `${subject} ${name} реализует часть сервисной логики области «${role || 'сервисы'}».`
			: `${subject} ${name} implements part of the service logic in the “${role || 'services'}” area.`;
	}

	return isRussianLocale
		? `${subject} ${name} выполняет действие своей области согласно контексту использования.`
		: `${subject} ${name} performs the action expressed by its name: ${humanizeSymbolName(name, false)}.`;
}

function describeConstantSymbol(name: string, signature: string, isRussianLocale: boolean): string {
	return isRussianLocale
		? `Константа ${name} фиксирует переиспользуемое значение или настройку. Сигнатура: ${signature}.`
		: `Constant ${name} defines a reusable value or setting. Signature: ${signature}.`;
}

function describeInterfaceSymbol(name: string, isRussianLocale: boolean): string {
	return isRussianLocale
		? `Интерфейс ${name} описывает контракт взаимодействия между компонентами.`
		: `Interface ${name} describes a contract between components.`;
}

function describeTypeSymbol(name: string, isRussianLocale: boolean): string {
	return isRussianLocale
		? `Тип ${name} задаёт форму данных и ожидаемые ограничения.`
		: `Type ${name} defines the expected data shape and constraints.`;
}

function describeEnumSymbol(name: string, isRussianLocale: boolean): string {
	return isRussianLocale
		? `Перечисление ${name} ограничивает набор допустимых состояний или вариантов.`
		: `Enum ${name} constrains the allowed set of states or variants.`;
}

function formatAreaPreparationDetail(
	isRussianLocale: boolean,
	areaCount: number,
	analysisFileCount: number,
	batchCount: number,
	aiModel: string,
): string {
	return isRussianLocale
		? `Подготовлено ${areaCount} областей из ${analysisFileCount} файлов. AI-батчей: ${batchCount}. Модель: ${aiModel}`
		: `Prepared ${areaCount} areas from ${analysisFileCount} files. AI batches: ${batchCount}. Model: ${aiModel}`;
}

function formatAreaBatchStartDetail(
	isRussianLocale: boolean,
	batchIndex: number,
	batchCount: number,
	batch: PreparedCodeMapAreaDescription[],
): string {
	const areaPreview = batch.map(item => item.area).slice(0, 3).join(', ');
	return isRussianLocale
		? `AI-батч ${batchIndex + 1}/${batchCount}: ${batch.length} областей${areaPreview ? ` (${areaPreview})` : ''}`
		: `AI batch ${batchIndex + 1}/${batchCount}: ${batch.length} areas${areaPreview ? ` (${areaPreview})` : ''}`;
}

function formatAreaCompletionDetail(
	isRussianLocale: boolean,
	completed: number,
	total: number,
	areaName: string,
	usedFallback: boolean,
): string {
	return isRussianLocale
		? `Готово ${completed}/${total}: ${areaName}${usedFallback ? ' (локальное описание)' : ''}`
		: `Completed ${completed}/${total}: ${areaName}${usedFallback ? ' (local fallback)' : ''}`;
}

function formatFileElementHeading(symbol: FileSymbolSummary, filePath: string, isRussianLocale: boolean): string {
	const kind = localizeSymbolKind(symbol.kind, isRussianLocale);
	const location = `${filePath}:${symbol.line}:${symbol.column}`;
	if (symbol.kind === 'class' && symbol.name === ANONYMOUS_CLASS_SYMBOL_NAME) {
		return `${kind} (${location})`;
	}
	return `${kind} ${symbol.name} (${location})`;
}

function localizeSymbolKind(kind: string, isRussianLocale: boolean): string {
	if (!isRussianLocale) {
		return kind;
	}
	switch (kind) {
		case 'class':
			return 'Класс';
		case 'method':
			return 'Метод';
		case 'function':
			return 'Функция';
		case 'const':
			return 'Константа';
		case 'interface':
			return 'Интерфейс';
		case 'type':
			return 'Тип';
		case 'enum':
			return 'Перечисление';
		default:
			return kind;
	}
}

function isTestLikeName(name: string): boolean {
	return /^(test|should|can|it_|it[A-Z])/.test(name);
}

function humanizeSymbolName(name: string, isRussianLocale: boolean): string {
	const withoutPrefix = name
		.replace(/^(test|should|can|it|when|then)/i, '')
		.replace(/^_+/, '');
	const words = withoutPrefix
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/[_-]+/g, ' ')
		.trim()
		.toLowerCase();
	if (!words) {
		return isRussianLocale ? 'внутренняя операция области' : 'an internal area operation';
	}
	return words;
}