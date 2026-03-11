export type AsciiTreeNodeKind = 'file' | 'directory';

export interface AsciiTreeItem {
	path: string;
	kind?: AsciiTreeNodeKind;
	label?: string;
}

export interface AsciiTreeLine {
	text: string;
	prefix: string;
	connector: string;
	label: string;
	kind: AsciiTreeNodeKind;
	depth: number;
	path: string;
	guideColumns: boolean[];
	connectorType: 'none' | 'branch' | 'last';
}

interface TreeNode {
	name: string;
	path: string;
	kind: AsciiTreeNodeKind;
	label?: string;
	children: Map<string, TreeNode>;
}

function normalizePath(value: string): string[] {
	return value
		.replace(/\\/g, '/')
		.split('/')
		.map(segment => segment.trim())
		.filter(Boolean);
}

/** Иконка типа узла: 🗁 для директорий, 🗋 для файлов */
function getNodeIcon(kind: AsciiTreeNodeKind): string {
	return kind === 'directory' ? '🗁 ' : '🗋 ';
}

function getDefaultLabel(node: TreeNode): string {
	return `${getNodeIcon(node.kind)}${node.name}`;
}

function sortNodes(a: TreeNode, b: TreeNode): number {
	if (a.kind !== b.kind) {
		return a.kind === 'directory' ? -1 : 1;
	}

	return a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' });
}

function renderNodes(
	nodes: TreeNode[],
	prefix: string,
	depth: number,
	guideColumns: boolean[],
): AsciiTreeLine[] {
	const lines: AsciiTreeLine[] = [];

	nodes.forEach((node, index) => {
		const isLast = index === nodes.length - 1;
		// Используем стандартный формат утилиты tree: ── (двойной дефис)
		const connector = isLast ? '└── ' : '├── ';
		const connectorType: AsciiTreeLine['connectorType'] = isLast ? 'last' : 'branch';
		// Иконка добавляется ко всем узлам — и к стандартным, и к пользовательским меткам
		const label = node.label
			? `${getNodeIcon(node.kind)}${node.label}`
			: getDefaultLabel(node);
		// Отступ дочерних: 4 символа для соответствия ширине коннектора ──
		const childPrefix = `${prefix}${isLast ? '    ' : '│   '}`;
		lines.push({
			text: `${prefix}${connector}${label}`,
			prefix,
			connector,
			label,
			kind: node.kind,
			depth,
			path: node.path,
			guideColumns,
			connectorType,
		});

		const children = Array.from(node.children.values()).sort(sortNodes);
		if (children.length > 0) {
			lines.push(...renderNodes(children, childPrefix, depth + 1, [...guideColumns, !isLast]));
		}
	});

	return lines;
}

export function renderAsciiTreeLines(items: AsciiTreeItem[]): AsciiTreeLine[] {
	const root = new Map<string, TreeNode>();

	for (const item of items) {
		const segments = normalizePath(item.path);
		if (segments.length === 0) {
			continue;
		}

		let siblings = root;
		let currentNode: TreeNode | undefined;

		segments.forEach((segment, index) => {
			const isLeaf = index === segments.length - 1;
			const kind: AsciiTreeNodeKind = isLeaf
				? (item.kind || 'file')
				: 'directory';
			const existing = siblings.get(segment);
			const currentPath = segments.slice(0, index + 1).join('/');

			if (existing) {
				if (existing.kind !== 'directory' && kind === 'directory') {
					existing.kind = 'directory';
				}
				currentNode = existing;
			} else {
				currentNode = {
					name: segment,
					path: currentPath,
					kind,
					children: new Map<string, TreeNode>(),
				};
				siblings.set(segment, currentNode);
			}

			if (isLeaf && item.label) {
				currentNode.label = item.label;
			}

			siblings = currentNode.children;
		});
	}

	const topLevelNodes = Array.from(root.values()).sort(sortNodes);
	if (topLevelNodes.length === 0) {
		return [];
	}

	// Корневые узлы рендерятся через renderNodes так же, как и все дочерние —
	// с коннекторами ├──/└── и направляющими линиями. Это обеспечивает
	// единообразное отображение на всех уровнях вложенности.
	return renderNodes(topLevelNodes, '', 0, []);
}

export function buildAsciiTree(items: AsciiTreeItem[]): string {
	return renderAsciiTreeLines(items)
		.map(line => line.text)
		.join('\n')
		.trim();
}