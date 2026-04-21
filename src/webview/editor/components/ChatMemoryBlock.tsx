import React from 'react';
import type {
  ChatMemoryCodemapInstructionSummary,
  ChatMemoryInstructionFile,
  ChatMemorySummary,
  PromptContextFileCard,
} from '../../../types/prompt';
import { getLocale, useT } from '../../shared/i18n';

interface Props {
  summary: ChatMemorySummary;
}

interface MetricCardProps {
  accentGroup: MemoryAccentGroup;
  label: string;
  value: string;
  secondary?: string;
}

interface SectionProps {
  accentGroup: MemoryAccentGroup;
  title: string;
  children: React.ReactNode;
}

type MemoryAccentGroup = 'snapshot' | 'instructions' | 'history' | 'context' | 'codemap';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}

function formatChars(count: number): string {
  if (!Number.isFinite(count) || count <= 0) {
    return '0';
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(count);
}

function formatDate(value: string | undefined, locale: string): string {
  if (!value) {
    return '-';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(locale.startsWith('ru') ? 'ru-RU' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

const MetricCard: React.FC<MetricCardProps> = ({ accentGroup, label, value, secondary }) => (
  <div style={{ ...styles.metricCard, ...getFirstLevelAccentStyle(accentGroup) }}>
    <div style={styles.metricLabel}>{label}</div>
    <div style={styles.metricValue}>{value}</div>
    {secondary ? <div style={styles.metricSecondary}>{secondary}</div> : null}
  </div>
);

const Section: React.FC<SectionProps> = ({ accentGroup, title, children }) => (
  <section style={{ ...styles.sectionCard, ...getFirstLevelAccentStyle(accentGroup) }}>
    <div style={styles.sectionTitle}>{title}</div>
    <div style={styles.sectionBody}>{children}</div>
  </section>
);

function renderInstructionStatus(t: ReturnType<typeof useT>, file: ChatMemoryInstructionFile): string {
  if (!file.exists) {
    return t('editor.memoryBlockMissing');
  }
  return t('editor.memoryBlockReady');
}

function renderCodemapSectionStatus(t: ReturnType<typeof useT>, section: ChatMemoryCodemapInstructionSummary): string {
  if (section.queuedRefresh) {
    return t('editor.memoryBlockQueued');
  }
  if (!section.exists) {
    return t('editor.memoryBlockMissing');
  }
  return t('editor.memoryBlockReady');
}

function renderContextFileStatus(t: ReturnType<typeof useT>, file: PromptContextFileCard): string {
  return file.exists ? t('editor.memoryBlockReady') : t('editor.memoryBlockMissing');
}

export const ChatMemoryBlock: React.FC<Props> = ({ summary }) => {
  const t = useT();
  const locale = getLocale();
  const hasAnyData = summary.totalChars > 0
    || summary.instructionFiles.length > 0
    || summary.contextFiles.totalCount > 0
    || (summary.codemap?.repositoryCount || 0) > 0;

  if (!hasAnyData) {
    return <div style={styles.emptyState}>{t('editor.memoryBlockEmpty')}</div>;
  }

  const codemapValue = summary.codemap && (summary.codemap.repositoryCount > 0 || summary.codemap.instructionCount > 0)
    ? String(summary.codemap.describedFilesCount)
    : t('editor.memoryBlockMetricNotIncluded');
  const codemapSecondary = summary.codemap && (summary.codemap.repositoryCount > 0 || summary.codemap.instructionCount > 0)
    ? `${summary.codemap.describedMethodLikeCount} ${t('editor.memoryBlockDescribedMethods').toLowerCase()} · ${summary.codemap.repositoryCount} ${t('editor.memoryBlockRepositories').toLowerCase()}`
    : undefined;

  return (
    <div style={styles.container}>
      <div style={styles.metricGrid}>
        <MetricCard
          accentGroup="snapshot"
          label={t('editor.memoryBlockMetricSnapshot')}
          value={`${formatChars(summary.totalChars)} ${t('editor.memoryBlockChars').toLowerCase()}`}
          secondary={`${t('editor.memoryBlockGeneratedAt')}: ${formatDate(summary.generatedAt, locale)}`}
        />
        <MetricCard
          accentGroup="instructions"
          label={t('editor.memoryBlockMetricAttachments')}
          value={String(summary.totals.attachedFilesCount)}
          secondary={`${formatBytes(summary.totals.totalSizeBytes)} · ${summary.totals.instructionFilesCount} ${t('editor.memoryBlockInstructionFiles').toLowerCase()}`}
        />
        <MetricCard
          accentGroup="history"
          label={t('editor.memoryBlockMetricHistory')}
          value={`${summary.shortTermCommits} / ${summary.longTermSummaries}`}
          secondary={`${summary.hasProjectMap ? t('editor.memoryBlockIncluded') : t('editor.memoryBlockNotIncluded')} · ${summary.uncommittedProjects} ${t('editor.memoryBlockProjects').toLowerCase()}`}
        />
        <MetricCard
          accentGroup="context"
          label={t('editor.memoryBlockMetricContext')}
          value={`${summary.contextFiles.existingCount}/${summary.contextFiles.totalCount}`}
          secondary={`${formatBytes(summary.contextFiles.totalSizeBytes)} · ${summary.contextFiles.missingCount} ${t('editor.memoryBlockMissingFiles').toLowerCase()}`}
        />
        <MetricCard
          accentGroup="codemap"
          label={t('editor.memoryBlockMetricCodemap')}
          value={codemapValue}
          secondary={codemapSecondary}
        />
      </div>

      <Section accentGroup="history" title={t('editor.memoryBlockHistory')}>
        <div style={styles.keyValueGrid}>
          <div>{t('editor.memoryBlockCommits')}</div>
          <div>{summary.shortTermCommits}</div>
          <div>{t('editor.memoryBlockSummaries')}</div>
          <div>{summary.longTermSummaries}</div>
          <div>{t('editor.memoryBlockProjectMap')}</div>
          <div>{summary.hasProjectMap ? t('editor.memoryBlockIncluded') : t('editor.memoryBlockNotIncluded')}</div>
          <div>{t('editor.memoryBlockUncommitted')}</div>
          <div>{summary.uncommittedProjects} {t('editor.memoryBlockProjects').toLowerCase()}</div>
          <div>{t('editor.memoryBlockVolume')}</div>
          <div>{formatChars(summary.totalChars)} {t('editor.memoryBlockChars').toLowerCase()}</div>
          <div>{t('editor.memoryBlockTotalSize')}</div>
          <div>{formatBytes(summary.totals.totalSizeBytes)}</div>
        </div>
      </Section>

      <Section accentGroup="instructions" title={t('editor.memoryBlockInstructionSources')}>
        {summary.instructionFiles.length === 0 ? (
          <div style={styles.emptyInline}>{t('editor.memoryBlockNoInstructionFiles')}</div>
        ) : (
          <div style={styles.stack}>
            {summary.instructionFiles.map((file) => (
              <article
                key={`${file.sourceKind}:${file.fileName}`}
                style={{ ...styles.itemCard, ...getSecondLevelAccentStyle('instructions') }}
              >
                <div style={styles.itemHeader}>
                  <div>
                    <div style={styles.itemTitle}>{file.label}</div>
                    <div style={styles.itemSubtitle}>{file.description}</div>
                  </div>
                  <div style={styles.itemMetaWrap}>
                    <span style={styles.sourceBadge}>{file.sourceKind}</span>
                    <span style={{ ...styles.statusBadge, ...(file.exists ? styles.statusReady : styles.statusMissing) }}>
                      {renderInstructionStatus(t, file)}
                    </span>
                  </div>
                </div>
                <div style={styles.metaRow}>
                  <span style={styles.metaChip}>{file.fileName}</span>
                  <span style={styles.metaChip}>{file.sizeLabel}</span>
                  {file.modifiedAt ? <span style={styles.metaChip}>{formatDate(file.modifiedAt, locale)}</span> : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </Section>

      <Section accentGroup="context" title={t('editor.memoryBlockContextFiles')}>
        {summary.contextFiles.totalCount === 0 ? (
          <div style={styles.emptyInline}>{t('editor.memoryBlockNoContextFiles')}</div>
        ) : (
          <div style={styles.stack}>
            <div style={styles.metaRow}>
              <span style={styles.metaChip}>{t('editor.memoryBlockAttachedFiles')}: {summary.contextFiles.existingCount}</span>
              <span style={styles.metaChip}>{t('editor.memoryBlockMissingFiles')}: {summary.contextFiles.missingCount}</span>
              <span style={styles.metaChip}>{t('editor.memoryBlockTotalSize')}: {summary.contextFiles.totalSizeLabel}</span>
              {summary.contextFiles.kindBreakdown.map((kind) => (
                <span key={kind.kind} style={styles.metaChip}>{kind.label}: {kind.count}</span>
              ))}
            </div>

            {summary.contextFiles.files.map((file) => (
              <article key={file.path} style={{ ...styles.itemCard, ...getSecondLevelAccentStyle('context') }}>
                <div style={styles.itemHeader}>
                  <div>
                    <div style={styles.itemTitle}>{file.displayName}</div>
                    <div style={styles.itemSubtitle}>{file.directoryLabel || '/'}</div>
                  </div>
                  <span style={{ ...styles.statusBadge, ...(file.exists ? styles.statusReady : styles.statusMissing) }}>
                    {renderContextFileStatus(t, file)}
                  </span>
                </div>
                <div style={styles.metaRow}>
                  <span style={styles.metaChip}>{file.typeLabel}</span>
                  <span style={styles.metaChip}>{file.sizeLabel}</span>
                  {file.modifiedAt ? <span style={styles.metaChip}>{formatDate(file.modifiedAt, locale)}</span> : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </Section>

      <Section accentGroup="codemap" title={t('editor.memoryBlockCodemap')}>
        {!summary.codemap || summary.codemap.repositoryCount === 0 ? (
          <div style={styles.emptyInline}>{t('editor.memoryBlockNoCodemap')}</div>
        ) : (
          <div style={styles.stack}>
            <div style={styles.metaRow}>
              <span style={styles.metaChip}>{t('editor.memoryBlockRepositories')}: {summary.codemap.repositoryCount}</span>
              <span style={styles.metaChip}>{t('editor.memoryBlockSections')}: {summary.codemap.instructionCount}</span>
              <span style={styles.metaChip}>{t('editor.memoryBlockDescribedFiles')}: {summary.codemap.describedFilesCount}</span>
              <span style={styles.metaChip}>{t('editor.memoryBlockDescribedSymbols')}: {summary.codemap.describedSymbolsCount}</span>
              <span style={styles.metaChip}>{t('editor.memoryBlockDescribedMethods')}: {summary.codemap.describedMethodLikeCount}</span>
              <span style={styles.metaChip}>{t('editor.memoryBlockTotalSize')}: {formatBytes(summary.codemap.totalSizeBytes)}</span>
            </div>

            {summary.codemap.repositories.map((repository) => (
              <article
                key={`${repository.repository}:${repository.currentBranch}`}
                style={{ ...styles.itemCard, ...getSecondLevelAccentStyle('codemap') }}
              >
                <div style={styles.itemHeader}>
                  <div>
                    <div style={styles.itemTitle}>{repository.repository}</div>
                    <div style={styles.itemSubtitle}>
                      {repository.currentBranch} · {repository.resolvedBranchName}
                    </div>
                  </div>
                </div>
                <div style={styles.stackCompact}>
                  {repository.sections.map((section) => (
                    <div key={`${repository.repository}:${section.branchName}:${section.instructionKind}`} style={styles.subCard}>
                      <div style={styles.itemHeader}>
                        <div style={styles.itemTitleSmall}>
                          {section.instructionKind === 'base' ? t('editor.memoryBlockBase') : t('editor.memoryBlockDelta')} · {section.branchName}
                        </div>
                        <span style={{
                          ...styles.statusBadge,
                          ...(section.exists ? styles.statusReady : section.queuedRefresh ? styles.statusQueued : styles.statusMissing),
                        }}>
                          {renderCodemapSectionStatus(t, section)}
                        </span>
                      </div>
                      <div style={styles.metaRow}>
                        <span style={styles.metaChip}>{t('editor.memoryBlockFiles')}: {section.fileCount}</span>
                        <span style={styles.metaChip}>{t('editor.memoryBlockDescribedFiles')}: {section.describedFilesCount}</span>
                        <span style={styles.metaChip}>{t('editor.memoryBlockDescribedSymbols')}: {section.describedSymbolsCount}</span>
                        <span style={styles.metaChip}>{t('editor.memoryBlockDescribedMethods')}: {section.describedMethodLikeCount}</span>
                        <span style={styles.metaChip}>{formatBytes(section.sizeBytes)}</span>
                        {section.generatedAt ? <span style={styles.metaChip}>{formatDate(section.generatedAt, locale)}</span> : null}
                      </div>
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
};

const MEMORY_BLOCK_ACCENT_COLORS: Record<MemoryAccentGroup, string> = {
  snapshot: 'color-mix(in srgb, var(--vscode-textLink-foreground) 72%, var(--vscode-focusBorder) 28%)',
  instructions: 'color-mix(in srgb, var(--vscode-testing-iconPassed) 72%, var(--vscode-terminal-ansiGreen) 28%)',
  history: 'color-mix(in srgb, var(--vscode-terminal-ansiYellow) 70%, var(--vscode-terminal-ansiRed) 30%)',
  context: 'color-mix(in srgb, var(--vscode-terminal-ansiYellow) 74%, var(--vscode-textLink-foreground) 26%)',
  codemap: 'color-mix(in srgb, var(--vscode-terminal-ansiCyan) 72%, var(--vscode-textLink-foreground) 28%)',
};

function getFirstLevelAccentStyle(group: MemoryAccentGroup): React.CSSProperties {
  return {
    borderTop: `3px solid ${MEMORY_BLOCK_ACCENT_COLORS[group]}`,
  };
}

function getSecondLevelAccentStyle(group: MemoryAccentGroup): React.CSSProperties {
  return {
    borderLeft: `3px solid ${MEMORY_BLOCK_ACCENT_COLORS[group]}`,
  };
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  metricGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: '10px',
  },
  metricCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '10px 12px',
    borderRadius: '8px',
    border: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-editor-background)',
  },
  metricLabel: {
    fontSize: '10px',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: 'var(--vscode-descriptionForeground)',
    fontWeight: 700,
  },
  metricValue: {
    fontSize: '18px',
    fontWeight: 700,
    lineHeight: 1.1,
    color: 'var(--vscode-foreground)',
  },
  metricSecondary: {
    fontSize: '11px',
    lineHeight: 1.5,
    color: 'var(--vscode-descriptionForeground)',
  },
  sectionCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '12px',
    borderRadius: '8px',
    border: '1px solid var(--vscode-panel-border)',
    background: 'color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-sideBar-background))',
  },
  sectionTitle: {
    fontSize: '12px',
    fontWeight: 700,
    color: 'var(--vscode-foreground)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  sectionBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  keyValueGrid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(130px, 180px) minmax(0, 1fr)',
    gap: '8px 12px',
    fontSize: '12px',
    lineHeight: 1.5,
  },
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  stackCompact: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  itemCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '10px 12px',
    borderRadius: '8px',
    background: 'var(--vscode-editor-background)',
    border: '1px solid color-mix(in srgb, var(--vscode-panel-border) 85%, transparent)',
  },
  subCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '8px 10px',
    borderRadius: '6px',
    background: 'color-mix(in srgb, var(--vscode-sideBar-background) 70%, var(--vscode-editor-background))',
    border: '1px solid color-mix(in srgb, var(--vscode-panel-border) 80%, transparent)',
  },
  itemHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '10px',
  },
  itemTitle: {
    fontSize: '13px',
    fontWeight: 700,
    color: 'var(--vscode-foreground)',
    lineHeight: 1.3,
  },
  itemTitleSmall: {
    fontSize: '12px',
    fontWeight: 700,
    color: 'var(--vscode-foreground)',
    lineHeight: 1.3,
  },
  itemSubtitle: {
    fontSize: '11px',
    lineHeight: 1.5,
    color: 'var(--vscode-descriptionForeground)',
    wordBreak: 'break-word',
  },
  itemMetaWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  sourceBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2px 8px',
    borderRadius: '999px',
    fontSize: '10px',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: 'var(--vscode-descriptionForeground)',
    background: 'color-mix(in srgb, var(--vscode-descriptionForeground) 10%, transparent)',
  },
  statusBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2px 8px',
    borderRadius: '999px',
    fontSize: '10px',
    fontWeight: 700,
    whiteSpace: 'nowrap',
  },
  statusReady: {
    color: 'var(--vscode-testing-iconPassed)',
    background: 'color-mix(in srgb, var(--vscode-testing-iconPassed) 12%, transparent)',
  },
  statusMissing: {
    color: 'var(--vscode-errorForeground)',
    background: 'color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent)',
  },
  statusQueued: {
    color: 'var(--vscode-terminal-ansiYellow)',
    background: 'color-mix(in srgb, var(--vscode-terminal-ansiYellow) 16%, transparent)',
  },
  metaRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
  },
  metaChip: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '2px 8px',
    borderRadius: '999px',
    fontSize: '11px',
    lineHeight: 1.5,
    color: 'var(--vscode-foreground)',
    background: 'color-mix(in srgb, var(--vscode-foreground) 6%, transparent)',
  },
  emptyState: {
    fontSize: '12px',
    lineHeight: 1.6,
    color: 'var(--vscode-descriptionForeground)',
    padding: '4px 0',
  },
  emptyInline: {
    fontSize: '12px',
    lineHeight: 1.6,
    color: 'var(--vscode-descriptionForeground)',
  },
};