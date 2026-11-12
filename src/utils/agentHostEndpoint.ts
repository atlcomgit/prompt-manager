import { lstat, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

/** Опубликованный локальный endpoint VS Code; token используется только при соединении. */
export interface AgentHostEndpoint {
	pid: number;
	connectionToken: string;
	endpoint: { type: 'tcp'; host: string; port: number } | { type: 'socket'; path: string };
}

/** Не допускает удалённые адреса и некорректные записи discovery; тесты: agentHostEndpoint.test.ts. */
export function parseAgentHostEndpoint(value: unknown): AgentHostEndpoint | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const item = value as Record<string, unknown>;
	if (item.schemaVersion !== 2 || !Number.isSafeInteger(item.pid) || Number(item.pid) <= 0
		|| typeof item.connectionToken !== 'string' || !item.connectionToken
		|| !item.endpoint || typeof item.endpoint !== 'object') return undefined;
	const endpoint = item.endpoint as Record<string, unknown>;
	if (endpoint.type === 'tcp' && ['127.0.0.1', '::1'].includes(String(endpoint.host))
		&& Number.isInteger(endpoint.port) && Number(endpoint.port) > 0 && Number(endpoint.port) <= 65535) {
		return { pid: Number(item.pid), connectionToken: item.connectionToken,
			endpoint: { type: 'tcp', host: String(endpoint.host), port: Number(endpoint.port) } };
	}
	if (endpoint.type === 'socket' && typeof endpoint.path === 'string' && path.isAbsolute(endpoint.path)) {
		return { pid: Number(item.pid), connectionToken: item.connectionToken,
			endpoint: { type: 'socket', path: endpoint.path } };
	}
	return undefined;
}

/** Выбирает host текущего дерева процессов без случайного выбора; тесты: agentHostEndpoint.test.ts. */
export function selectRelatedAgentHostEndpoint(
	items: Array<{ endpoint: AgentHostEndpoint; parentPid?: number }>,
	ancestors: number[],
): AgentHostEndpoint | undefined {
	// Ближайший прямой предок приоритетнее соседнего процесса Agent Host того же окна VS Code.
	const ranked = items.map(item => {
		const direct = ancestors.indexOf(item.endpoint.pid);
		const sibling = item.parentPid === undefined ? -1 : ancestors.indexOf(item.parentPid);
		return { endpoint: item.endpoint, rank: direct >= 0 ? direct : sibling >= 0 ? sibling + 0.5 : Infinity };
	}).filter(item => Number.isFinite(item.rank)).sort((left, right) => left.rank - right.rank);
	return ranked.length && (ranked.length === 1 || ranked[0].rank < ranked[1].rank) ? ranked[0].endpoint : undefined;
}

/** Читает только PPid, без аргументов запуска, окружения или секретов другого процесса. */
async function readParentPid(pid: number): Promise<number | undefined> {
	try {
		const text = await readFile(`/proc/${pid}/status`, 'utf8');
		const match = /^PPid:\s+(\d+)$/m.exec(text);
		return match ? Number(match[1]) : undefined;
	} catch { return undefined; }
}

/** Находит опубликованный endpoint текущего Linux VS Code/tunnel, не выбирая соседнее окно или сервер. */
export async function discoverAgentHostEndpoint(globalStoragePath?: string): Promise<AgentHostEndpoint> {
	// Discovery использует дерево процессов Linux; неподдерживаемая платформа получает явную ошибку.
	if (process.platform !== 'linux') throw new Error('Автоматический Full Access пока поддерживается только в Linux.');
	const ancestors: number[] = [];
	let pid: number | undefined = process.pid;
	while (pid && ancestors.length < 32 && !ancestors.includes(pid)) {
		ancestors.push(pid);
		pid = await readParentPid(pid);
	}
	const roots = new Set(['Code', 'Code - Insiders', 'VSCodium'].map(name => path.join(homedir(), '.config', name)));
	if (globalStoragePath) {
		let directory = path.resolve(globalStoragePath);
		for (let depth = 0; depth < 8; depth++) {
			if (path.basename(directory) === 'User') { roots.add(path.dirname(directory)); break; }
			directory = path.dirname(directory);
		}
	}
	const candidates: Array<{ endpoint: AgentHostEndpoint; parentPid?: number }> = [];
	for (const root of roots) {
		const directory = path.join(root, 'agent-host', 'local-endpoint', 'entries');
		try {
			const parent = await lstat(directory);
			if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077)) continue;
			for (const file of (await readdir(directory)).filter(name => name.endsWith('.json')).slice(0, 64)) {
				try {
					const filename = path.join(directory, file);
					const stat = await lstat(filename);
					if (!stat.isFile() || stat.uid !== parent.uid || (stat.mode & 0o077) || stat.size > 65536) continue;
					const endpoint = parseAgentHostEndpoint(JSON.parse(await readFile(filename, 'utf8')));
					if (!endpoint) continue;
					process.kill(endpoint.pid, 0);
					candidates.push({ endpoint, parentPid: await readParentPid(endpoint.pid) });
				} catch { /* Исчезнувшая или устаревшая запись не является работающим endpoint. */ }
			}
		} catch { /* У этого пользовательского каталога может не быть Agent Host. */ }
	}
	const selected = selectRelatedAgentHostEndpoint(candidates, ancestors);
	if (!selected) throw new Error('Не найден однозначный локальный Agent Host текущего VS Code для Full Access.');
	return selected;
}
