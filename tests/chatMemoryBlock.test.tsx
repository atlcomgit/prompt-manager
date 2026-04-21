import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ChatMemorySummary } from '../src/types/prompt.js';
import { ChatMemoryBlock } from '../src/webview/editor/components/ChatMemoryBlock.js';
import { withLocale } from './testLocale.js';

function createSummary(overrides: Partial<ChatMemorySummary> = {}): ChatMemorySummary {
  return {
    totalChars: 3200,
    shortTermCommits: 4,
    longTermSummaries: 2,
    hasProjectMap: true,
    uncommittedProjects: 1,
    generatedAt: '2026-04-13T12:00:00.000Z',
    instructionFiles: [
      {
        label: 'Global agent instructions',
        fileName: 'prompt-manager.instructions.md',
        sourceKind: 'global',
        description: 'Core agent rules and defaults.',
        exists: true,
        sizeBytes: 1536,
        sizeLabel: '1.5 KB',
        modifiedAt: '2026-04-13T11:59:00.000Z',
      },
      {
        label: 'Project instructions',
        fileName: 'feature.instructions.md',
        sourceKind: 'project',
        description: 'Workspace-specific guidance.',
        exists: false,
        sizeBytes: 0,
        sizeLabel: '-',
      },
    ],
    contextFilesCount: 2,
    contextFiles: {
      files: [
        {
          path: '/workspace/src/services/memory.ts',
          displayName: 'memory.ts',
          directoryLabel: 'src/services',
          extension: '.ts',
          tileLabel: 'TS',
          kind: 'code',
          typeLabel: 'TypeScript',
          exists: true,
          sizeBytes: 2048,
          sizeLabel: '2 KB',
          modifiedAt: '2026-04-13T11:58:00.000Z',
        },
        {
          path: '/workspace/docs/missing.md',
          displayName: 'missing.md',
          directoryLabel: 'docs',
          extension: '.md',
          tileLabel: 'MD',
          kind: 'text',
          typeLabel: 'Markdown',
          exists: false,
          sizeBytes: 0,
          sizeLabel: '-',
        },
      ],
      totalCount: 2,
      existingCount: 1,
      missingCount: 1,
      totalSizeBytes: 2048,
      totalSizeLabel: '2 KB',
      kindBreakdown: [
        { kind: 'code', label: 'Code', count: 1 },
      ],
    },
    codemap: {
      repositoryCount: 1,
      instructionCount: 2,
      queuedRefreshCount: 1,
      totalFileCount: 9,
      describedFilesCount: 7,
      describedSymbolsCount: 22,
      describedMethodLikeCount: 13,
      totalSizeBytes: 8192,
      totalCompressedSizeBytes: 4096,
      repositories: [
        {
          repository: 'prompt-manager',
          currentBranch: 'feature/memory-block',
          resolvedBranchName: 'main',
          baseBranchName: 'main',
          sections: [
            {
              branchName: 'main',
              resolvedBranchName: 'main',
              instructionKind: 'base',
              exists: true,
              queuedRefresh: false,
              fileCount: 6,
              describedFilesCount: 5,
              describedSymbolsCount: 14,
              describedMethodLikeCount: 8,
              sizeBytes: 4096,
              compressedSizeBytes: 2048,
              generatedAt: '2026-04-13T11:55:00.000Z',
              sourceCommitSha: 'abc123',
            },
            {
              branchName: 'feature/memory-block',
              resolvedBranchName: 'main',
              instructionKind: 'delta',
              exists: true,
              queuedRefresh: true,
              fileCount: 3,
              describedFilesCount: 2,
              describedSymbolsCount: 8,
              describedMethodLikeCount: 5,
              sizeBytes: 4096,
              compressedSizeBytes: 2048,
              generatedAt: '2026-04-13T11:56:00.000Z',
              sourceCommitSha: 'def456',
            },
          ],
        },
      ],
    },
    totals: {
      attachedFilesCount: 2,
      instructionFilesCount: 1,
      contextFilesCount: 2,
      contextExistingCount: 1,
      totalSizeBytes: 3584,
      instructionSizeBytes: 1536,
      contextSizeBytes: 2048,
      describedFilesCount: 7,
      describedSymbolsCount: 22,
      describedMethodLikeCount: 13,
    },
    ...overrides,
  };
}

test('ChatMemoryBlock renders detailed snapshot metrics and codemap coverage', () => {
  const markup = withLocale('en', () => renderToStaticMarkup(React.createElement(ChatMemoryBlock, {
    summary: createSummary(),
  })));

  assert.match(markup, />Snapshot</);
  assert.match(markup, />Instruction sources</);
  assert.match(markup, /Global agent instructions/);
  assert.match(markup, /Workspace-specific guidance/);
  assert.match(markup, />Context files</);
  assert.match(markup, /memory\.ts/);
  assert.match(markup, />Missing</);
  assert.match(markup, />Code map coverage</);
  assert.match(markup, /Described files: 7/);
  assert.match(markup, /Base · main/);
  assert.match(markup, /Delta · feature\/memory-block/);
});

test('ChatMemoryBlock shows empty state when no snapshot data was attached', () => {
  const markup = withLocale('en', () => renderToStaticMarkup(React.createElement(ChatMemoryBlock, {
    summary: createSummary({
      totalChars: 0,
      shortTermCommits: 0,
      longTermSummaries: 0,
      hasProjectMap: false,
      uncommittedProjects: 0,
      instructionFiles: [],
      contextFilesCount: 0,
      contextFiles: {
        files: [],
        totalCount: 0,
        existingCount: 0,
        missingCount: 0,
        totalSizeBytes: 0,
        totalSizeLabel: '0 B',
        kindBreakdown: [],
      },
      codemap: null,
      totals: {
        attachedFilesCount: 0,
        instructionFilesCount: 0,
        contextFilesCount: 0,
        contextExistingCount: 0,
        totalSizeBytes: 0,
        instructionSizeBytes: 0,
        contextSizeBytes: 0,
        describedFilesCount: 0,
        describedSymbolsCount: 0,
        describedMethodLikeCount: 0,
      },
    }),
  })));

  assert.match(markup, /Memory context was not generated for this session\./);
});