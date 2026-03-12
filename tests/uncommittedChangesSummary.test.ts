import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeUncommittedProjects } from '../src/utils/uncommittedChangesSummary.js';
import type { UncommittedProjectData } from '../src/services/gitService.js';

test('summarizeUncommittedProjects keeps staged and unstaged state for the same file', () => {
	const summary = summarizeUncommittedProjects([
		{
			project: 'prompt-manager',
			projectPath: '/repo',
			branch: 'feature/task-37',
			stagedFiles: [{ status: 'M', path: 'src/services/memoryContextService.ts' }],
			unstagedFiles: [{ status: 'M', path: 'src/services/memoryContextService.ts' }],
			untrackedFiles: [],
			stagedStat: '',
			unstagedStat: '',
			stagedDiff: [
				'diff --git a/src/services/memoryContextService.ts b/src/services/memoryContextService.ts',
				'@@ -1,3 +1,7 @@ export class MemoryContextService {',
				'+\tprivate buildUncommittedChangesContext(): string {',
				'+\t\treturn "";',
				'+\t}',
			].join('\n'),
			unstagedDiff: [
				'diff --git a/src/services/memoryContextService.ts b/src/services/memoryContextService.ts',
				'@@ -10,3 +10,5 @@ async getContextForChat(',
				'+\tconst uncommittedBlock = this.buildUncommittedChangesContext();',
			].join('\n'),
			untrackedDiff: '',
		},
	]);

	assert.equal(summary.projects.length, 1);
	assert.equal(summary.projects[0]?.counts.staged, 1);
	assert.equal(summary.projects[0]?.counts.unstaged, 1);
	assert.deepEqual(summary.projects[0]?.files[0]?.scopes, ['staged', 'unstaged']);
	assert.equal(summary.projects[0]?.files[0]?.symbols.includes('buildUncommittedChangesContext'), true);
	assert.deepEqual(summary.projects[0]?.files[0]?.areas, ['export class MemoryContextService {', 'async getContextForChat(']);
});

test('summarizeUncommittedProjects detects new, renamed and deleted files', () => {
	const project: UncommittedProjectData = {
		project: 'prompt-manager',
		projectPath: '/repo',
		branch: 'feature/task-37',
		stagedFiles: [
			{ status: 'R', path: 'src/newName.ts', previousPath: 'src/oldName.ts' },
			{ status: 'D', path: 'src/removed.ts' },
		],
		unstagedFiles: [],
		untrackedFiles: [{ status: 'A', path: 'src/utils/uncommittedChangesSummary.ts' }],
		stagedStat: '',
		unstagedStat: '',
		stagedDiff: [
			'diff --git a/src/oldName.ts b/src/newName.ts',
			'rename from src/oldName.ts',
			'rename to src/newName.ts',
			'diff --git a/src/removed.ts b/src/removed.ts',
			'deleted file mode 100644',
		].join('\n'),
		unstagedDiff: '',
		untrackedDiff: [
			'diff --git a/src/utils/uncommittedChangesSummary.ts b/src/utils/uncommittedChangesSummary.ts',
			'new file mode 100644',
			'+export function summarizeUncommittedProjects() {',
		].join('\n'),
	};

	const summary = summarizeUncommittedProjects([project], { maxFilesPerProject: 10 });
	const files = summary.projects[0]?.files || [];

	assert.equal(summary.projects[0]?.counts.renamed, 1);
	assert.equal(summary.projects[0]?.counts.deleted, 1);
	assert.equal(files.find((file) => file.path === 'src/newName.ts')?.previousPath, 'src/oldName.ts');
	assert.equal(files.find((file) => file.path === 'src/removed.ts')?.isDeleted, true);
	assert.equal(files.find((file) => file.path === 'src/utils/uncommittedChangesSummary.ts')?.isNewFile, true);
	assert.deepEqual(files.find((file) => file.path === 'src/utils/uncommittedChangesSummary.ts')?.symbols, ['summarizeUncommittedProjects']);
});

test('summarizeUncommittedProjects truncates file and project lists deterministically', () => {
	const makeProject = (project: string, filePath: string): UncommittedProjectData => ({
		project,
		projectPath: `/repo/${project}`,
		branch: 'feature/task-37',
		stagedFiles: [{ status: 'M', path: filePath }],
		unstagedFiles: [],
		untrackedFiles: [],
		stagedStat: '',
		unstagedStat: '',
		stagedDiff: `diff --git a/${filePath} b/${filePath}`,
		unstagedDiff: '',
		untrackedDiff: '',
	});

	const summary = summarizeUncommittedProjects([
		makeProject('a', 'src/a.ts'),
		makeProject('b', 'src/b.ts'),
		makeProject('c', 'src/c.ts'),
		makeProject('d', 'src/d.ts'),
	], { maxProjects: 2, maxFilesPerProject: 1 });

	assert.equal(summary.projects.length, 2);
	assert.equal(summary.hiddenProjects, 2);
	assert.equal(summary.projects[0]?.files.length, 1);
	assert.equal(summary.projects[0]?.hiddenFiles, 0);
	assert.equal(summary.projects[1]?.files.length, 1);
	assert.equal(summary.projects[1]?.hiddenFiles, 0);
	assert.equal(summary.projects[0]?.project, 'a');
	assert.equal(summary.projects[1]?.project, 'b');
});