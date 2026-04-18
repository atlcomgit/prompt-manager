/**
 * CustomGroupsService — управляет справочником пользовательских групп промптов.
 *
 * Группы хранятся в `.vscode/prompt-manager/custom-groups.json` рядом с другими
 * данными расширения. Файл версионируется в git вместе с проектом, что позволяет
 * команде разработчиков шарить общие группы. Сервис кэширует список в памяти,
 * чтобы избежать лишних чтений с диска при частых обращениях из webview.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import {
	type PromptCustomGroup,
	normalizePromptCustomGroup,
	sortPromptCustomGroups,
} from '../types/prompt.js';

/** Имя файла справочника групп в каталоге расширения */
const CUSTOM_GROUPS_FILE = 'custom-groups.json';

/** Корневой каталог хранилища расширения внутри workspace */
const STORAGE_DIR = '.vscode/prompt-manager';

/** Полезная нагрузка файла custom-groups.json (с версионированием на будущее) */
interface CustomGroupsFilePayload {
	version: 1;
	groups: PromptCustomGroup[];
}

/** Сервис управления справочником пользовательских групп промптов */
export class CustomGroupsService {
	/** In-memory кэш справочника, заполняется лениво */
	private cache: PromptCustomGroup[] | null = null;

	/** Эмиттер изменений справочника для подписчиков (sidebar/editor) */
	private readonly _onDidChangeGroups = new vscode.EventEmitter<PromptCustomGroup[]>();

	/** Публичное событие изменения справочника */
	public readonly onDidChangeGroups = this._onDidChangeGroups.event;

	constructor(private readonly workspaceRoot: string) { }

	/** Полный путь до файла custom-groups.json в текущем workspace */
	private get filePath(): string {
		return path.join(this.workspaceRoot, STORAGE_DIR, CUSTOM_GROUPS_FILE);
	}

	/** Освобождение ресурсов сервиса (вызывается при деактивации расширения) */
	public dispose(): void {
		this._onDidChangeGroups.dispose();
	}

	/**
	 * Получить актуальный справочник групп. Использует кэш, если доступен;
	 * иначе читает файл с диска и нормализует записи.
	 */
	public async listGroups(): Promise<PromptCustomGroup[]> {
		if (this.cache) {
			return this.cloneGroups(this.cache);
		}

		const groups = await this.readFromDisk();
		this.cache = groups;
		return this.cloneGroups(groups);
	}

	/** Создать новую группу. Возвращает созданную группу с присвоенным id. */
	public async createGroup(input: { name: string; color?: string; order?: number }): Promise<PromptCustomGroup> {
		const name = (input.name || '').trim();
		if (!name) {
			throw new Error('Group name must not be empty');
		}

		const groups = await this.listGroups();
		const now = new Date().toISOString();
		const nextOrder = typeof input.order === 'number'
			? input.order
			: this.computeNextOrder(groups);

		const created: PromptCustomGroup = {
			id: crypto.randomUUID(),
			name,
			color: (input.color || '').trim(),
			order: nextOrder,
			createdAt: now,
			updatedAt: now,
		};

		const next = sortPromptCustomGroups([...groups, created]);
		await this.persist(next);
		return created;
	}

	/** Обновить существующую группу. Игнорирует попытку обновить несуществующий id. */
	public async updateGroup(
		id: string,
		patch: Partial<Pick<PromptCustomGroup, 'name' | 'color' | 'order'>>,
	): Promise<PromptCustomGroup | null> {
		const groups = await this.listGroups();
		const index = groups.findIndex(group => group.id === id);
		if (index < 0) {
			return null;
		}

		const target = groups[index];
		const trimmedName = typeof patch.name === 'string' ? patch.name.trim() : target.name;
		if (!trimmedName) {
			throw new Error('Group name must not be empty');
		}

		const updated: PromptCustomGroup = {
			...target,
			name: trimmedName,
			color: typeof patch.color === 'string' ? patch.color.trim() : target.color,
			order: typeof patch.order === 'number' && Number.isFinite(patch.order) ? patch.order : target.order,
			updatedAt: new Date().toISOString(),
		};

		const next = sortPromptCustomGroups([...groups.slice(0, index), updated, ...groups.slice(index + 1)]);
		await this.persist(next);
		return updated;
	}

	/** Удалить группу по id. Возвращает true, если группа была удалена. */
	public async deleteGroup(id: string): Promise<boolean> {
		const groups = await this.listGroups();
		const next = groups.filter(group => group.id !== id);
		if (next.length === groups.length) {
			return false;
		}

		await this.persist(next);
		return true;
	}

	/**
	 * Перезаписать весь справочник целиком (используется при импорте/массовом редактировании
	 * через модальное окно управления группами).
	 */
	public async replaceAll(rawGroups: Array<Partial<PromptCustomGroup>>): Promise<PromptCustomGroup[]> {
		const normalized: PromptCustomGroup[] = [];
		const seenIds = new Set<string>();
		for (const raw of rawGroups) {
			const group = normalizePromptCustomGroup(raw);
			if (!group || seenIds.has(group.id)) {
				continue;
			}
			seenIds.add(group.id);
			normalized.push(group);
		}

		const sorted = sortPromptCustomGroups(normalized);
		await this.persist(sorted);
		return this.cloneGroups(sorted);
	}

	/** Сбросить кэш (например, при ручном изменении файла на диске) */
	public invalidateCache(): void {
		this.cache = null;
	}

	/** Определить order для новой группы (последний + 10) */
	private computeNextOrder(groups: PromptCustomGroup[]): number {
		if (groups.length === 0) {
			return 0;
		}
		const maxOrder = groups.reduce((acc, group) => Math.max(acc, group.order), -Infinity);
		return Number.isFinite(maxOrder) ? maxOrder + 10 : 0;
	}

	/** Прочитать справочник групп с диска и нормализовать */
	private async readFromDisk(): Promise<PromptCustomGroup[]> {
		try {
			const uri = vscode.Uri.file(this.filePath);
			const raw = await vscode.workspace.fs.readFile(uri);
			const parsed = JSON.parse(Buffer.from(raw).toString('utf-8'));

			const groupsRaw: Array<Partial<PromptCustomGroup>> = Array.isArray(parsed)
				? parsed
				: Array.isArray(parsed?.groups) ? parsed.groups : [];

			const normalized: PromptCustomGroup[] = [];
			const seen = new Set<string>();
			for (const item of groupsRaw) {
				const group = normalizePromptCustomGroup(item);
				if (!group || seen.has(group.id)) {
					continue;
				}
				seen.add(group.id);
				normalized.push(group);
			}

			return sortPromptCustomGroups(normalized);
		} catch {
			return [];
		}
	}

	/** Сохранить справочник на диск, обновить кэш и сообщить подписчикам */
	private async persist(groups: PromptCustomGroup[]): Promise<void> {
		this.cache = groups;
		const payload: CustomGroupsFilePayload = { version: 1, groups };
		const dir = path.dirname(this.filePath);
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
		const json = JSON.stringify(payload, null, 2) + '\n';
		await vscode.workspace.fs.writeFile(
			vscode.Uri.file(this.filePath),
			Buffer.from(json, 'utf-8'),
		);
		this._onDidChangeGroups.fire(this.cloneGroups(groups));
	}

	/** Глубокое копирование массива групп для безопасной передачи наружу */
	private cloneGroups(groups: PromptCustomGroup[]): PromptCustomGroup[] {
		return groups.map(group => ({ ...group }));
	}
}
