import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAsciiTree } from '../src/utils/asciiTree.js';

test('buildAsciiTree renders nested tree with directories before files', () => {
	const tree = buildAsciiTree([
		{ path: 'repo/package.json', kind: 'file' },
		{ path: 'repo/src/utils/index.ts', kind: 'file' },
		{ path: 'repo/src/extension.ts', kind: 'file' },
		{ path: 'repo/README.md', kind: 'file' },
	]);

	assert.equal(
		tree,
		[
			'└── 🗁 repo',
			'    ├── 🗁 src',
			'    │   ├── 🗁 utils',
			'    │   │   └── 🗋 index.ts',
			'    │   └── 🗋 extension.ts',
			'    ├── 🗋 package.json',
			'    └── 🗋 README.md',
		].join('\n'),
	);
});

test('buildAsciiTree preserves custom leaf labels', () => {
	const tree = buildAsciiTree([
		{ path: 'src/services/memoryContextService.ts', kind: 'file', label: 'memoryContextService.ts [M]' },
		{ path: 'src/webview/memory/components/CommitDetail.tsx', kind: 'file', label: 'CommitDetail.tsx [A]' },
	]);

	assert.equal(
		tree,
		[
			'└── 🗁 src',
			'    ├── 🗁 services',
			'    │   └── 🗋 memoryContextService.ts [M]',
			'    └── 🗁 webview',
			'        └── 🗁 memory',
			'            └── 🗁 components',
			'                └── 🗋 CommitDetail.tsx [A]',
		].join('\n'),
	);
});