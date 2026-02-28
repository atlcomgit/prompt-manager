/**
 * Statistics App — Shows prompt usage statistics and reports
 */

import React, { useState, useCallback, useEffect } from 'react';
import { getVsCodeApi } from '../shared/vscodeApi';
import { useMessageListener } from '../shared/useMessageListener';
import { useT } from '../shared/i18n';
import type { PromptStatistics } from '../../types/prompt';

const vscode = getVsCodeApi();

function formatDuration(ms: number): string {
  if (ms < 1000) return '0м';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}ч ${minutes}м`;
  return `${minutes}м`;
}

export const StatisticsApp: React.FC = () => {
  const t = useT();
  const [stats, setStats] = useState<PromptStatistics | null>(null);
  const currentDate = new Date();
  const [selectedMonth, setSelectedMonth] = useState<number>(0); // 0 = all months
  const [selectedYear, setSelectedYear] = useState<number>(currentDate.getFullYear());

  const loadStatistics = useCallback(() => {
    const msg: any = { type: 'getStatistics' };
    if (selectedYear) msg.year = selectedYear;
    if (selectedMonth > 0) msg.month = selectedMonth;
    vscode.postMessage(msg);
  }, [selectedMonth, selectedYear]);

  useEffect(() => {
    loadStatistics();
  }, [loadStatistics]);

  const handleMessage = useCallback((msg: any) => {
    if (msg.type === 'statistics') {
      setStats(msg.data);
    }
  }, []);

  useMessageListener(handleMessage);

  if (!stats) {
    return (
      <div style={styles.container}>
        <div style={styles.loading}>{t('stats.loading')}</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>{t('stats.title')}</h2>

      {/* Period filter */}
      <div style={styles.periodFilter}>
        <label style={styles.periodLabel}>{t('stats.period')}</label>
        <select
          value={selectedYear}
          onChange={e => setSelectedYear(Number(e.target.value))}
          style={styles.periodSelect}
        >
          {Array.from({ length: 5 }, (_, i) => currentDate.getFullYear() - i).map(y => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
        <select
          value={selectedMonth}
          onChange={e => setSelectedMonth(Number(e.target.value))}
          style={styles.periodSelect}
        >
          <option value={0}>{t('stats.allYear')}</option>
          {Array.from({ length: 12 }, (_, i) => (
            <option key={i + 1} value={i + 1}>{t(`month.${i + 1}`)}</option>
          ))}
        </select>
      </div>

      {/* Summary cards */}
      <div style={styles.cardsRow}>
        <div style={styles.card}>
          <div style={styles.cardValue}>{stats.totalPrompts}</div>
          <div style={styles.cardLabel}>{t('stats.totalPrompts')}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardValue}>{stats.favoriteCount}</div>
          <div style={styles.cardLabel}>{t('stats.favorites')}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardValue}>{formatDuration(stats.totalTime)}</div>
          <div style={styles.cardLabel}>{t('stats.totalTime')}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardValue}>{formatDuration(stats.avgTimePerPrompt)}</div>
          <div style={styles.cardLabel}>{t('stats.avgTime')}</div>
        </div>
      </div>

      {/* Status breakdown */}
      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>{t('stats.byStatus')}</h3>
        <div style={styles.barChart}>
          {Object.entries(stats.byStatus).map(([status, count]) => {
            const pct = stats.totalPrompts > 0 ? (count / stats.totalPrompts) * 100 : 0;
            const STATUS_ICONS: Record<string, string> = {
              'draft': '📝',
              'in-progress': '🚀',
              'stopped': '▣',
              'cancelled': '❌',
              'completed': '✅',
              'report': '🧾',
              'review': '🔎',
              'closed': '🔒',
            };
            const STATUS_KEYS: Record<string, string> = {
              'draft': 'status.draft',
              'in-progress': 'status.inProgress',
              'stopped': 'status.stopped',
              'cancelled': 'status.cancelled',
              'completed': 'status.completed',
              'report': 'status.report',
              'review': 'status.review',
              'closed': 'status.closed',
            };
            const label = `${STATUS_ICONS[status] || ''} ${t(STATUS_KEYS[status] || status)}`;
            return (
              <div key={status} style={styles.barRow}>
                <span style={styles.barLabel}>{label}</span>
                <div style={styles.barTrack}>
                  <div style={{ ...styles.barFill, width: `${Math.max(pct, 2)}%` }} />
                </div>
                <span style={styles.barCount}>{count}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Time breakdown */}
      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>{t('stats.time')}</h3>
        <div style={styles.timeGrid}>
          <div style={styles.timeStat}>
            <span style={styles.timeLabel}>{t('stats.writingTime')}</span>
            <span style={styles.timeValue}>{formatDuration(stats.totalTimeWriting)}</span>
          </div>
          <div style={styles.timeStat}>
            <span style={styles.timeLabel}>{t('stats.implementingTime')}</span>
            <span style={styles.timeValue}>{formatDuration(stats.totalTimeImplementing)}</span>
          </div>
        </div>
      </div>

      {/* Languages */}
      {stats.topLanguages.length > 0 && (
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>{t('stats.languages')}</h3>
          <div style={styles.tagCloud}>
            {stats.topLanguages.map(l => (
              <span key={l.name} style={styles.tag}>
                {l.name} <span style={styles.tagCount}>{l.count}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Frameworks */}
      {stats.topFrameworks.length > 0 && (
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>{t('stats.frameworks')}</h3>
          <div style={styles.tagCloud}>
            {stats.topFrameworks.map(f => (
              <span key={f.name} style={styles.tag}>
                {f.name} <span style={styles.tagCount}>{f.count}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Recent activity */}
      {stats.recentActivity.length > 0 && (
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>{t('stats.recentActivity')}</h3>
          <div style={styles.activityList}>
            {stats.recentActivity.map(a => (
              <div key={a.id} style={styles.activityItem}>
                <span style={styles.activityTitle}>{a.title || a.id}</span>
                <span style={styles.activityDate}>
                  {new Date(a.updatedAt).toLocaleDateString('ru-RU', {
                    day: '2-digit', month: '2-digit', year: '2-digit',
                    hour: '2-digit', minute: '2-digit',
                  })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Brief report table */}
      {stats.reportRows && stats.reportRows.length > 0 && (
        <div style={styles.section}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={styles.sectionTitle}>{t('stats.briefReport')}</h3>
            <button
              style={styles.exportBtn}
              onClick={() => {
                if (!stats.reportRows) return;
                const TARGET_HOURS = 165;
                const realTotalMs = stats.reportRows.reduce((s, r) => s + r.totalTime, 0);
                const realTotalHours = realTotalMs / (1000 * 60 * 60);
                const scale = realTotalHours > 0 ? TARGET_HOURS / realTotalHours : 1;
                const rows = [...stats.reportRows].sort((a, b) => {
                  const numA = parseInt(a.taskNumber, 10);
                  const numB = parseInt(b.taskNumber, 10);
                  const isNumA = !isNaN(numA);
                  const isNumB = !isNaN(numB);
                  if (isNumA && isNumB) return numB - numA;
                  if (isNumA) return -1;
                  if (isNumB) return 1;
                  return b.taskNumber.localeCompare(a.taskNumber);
                }).map(r => {
                  const scaledHours = Math.round((r.totalTime / (1000 * 60 * 60)) * scale);
                  return {
                    taskNumber: r.taskNumber || '—',
                    title: r.title,
                    hours: scaledHours,
                  };
                });
                vscode.postMessage({ type: 'exportReport', rows });
              }}
              title={t('stats.exportTooltip')}
            >
              {t('stats.exportBtn')}
            </button>
          </div>
          <table style={styles.reportTable}>
            <thead>
              <tr>
                <th style={styles.reportTh}>{t('stats.taskCol')}</th>
                <th style={styles.reportTh}>{t('stats.nameCol')}</th>
                <th style={styles.reportTh}>{t('stats.statusCol')}</th>
                <th style={{ ...styles.reportTh, textAlign: 'right' }}>{t('stats.writingCol')}</th>
                <th style={{ ...styles.reportTh, textAlign: 'right' }}>{t('stats.implementingCol')}</th>
                <th style={{ ...styles.reportTh, textAlign: 'right' }}>{t('stats.totalCol')}</th>
              </tr>
            </thead>
            <tbody>
              {[...stats.reportRows].sort((a, b) => {
                const numA = parseInt(a.taskNumber, 10);
                const numB = parseInt(b.taskNumber, 10);
                const isNumA = !isNaN(numA);
                const isNumB = !isNaN(numB);
                if (isNumA && isNumB) return numB - numA;
                if (isNumA) return -1;
                if (isNumB) return 1;
                return b.taskNumber.localeCompare(a.taskNumber);
              }).map((row, idx) => {
                const statusLabels: Record<string, string> = {
                  'draft': t('status.draft'),
                  'in-progress': t('status.inProgress'),
                  'stopped': t('status.stopped'),
                  'cancelled': t('status.cancelled'),
                  'completed': t('status.completed'),
                  'report': t('status.report'),
                  'review': t('status.review'),
                  'closed': t('status.closed'),
                };
                return (
                  <tr key={idx} style={idx % 2 === 0 ? styles.reportRowEven : undefined}>
                    <td style={styles.reportTaskCell}>{row.taskNumber || '—'}</td>
                    <td style={styles.reportTd}>{row.title}</td>
                    <td style={styles.reportTd}>{statusLabels[row.status] || row.status}</td>
                    <td style={{ ...styles.reportTd, textAlign: 'right' }}>{formatDuration(row.timeWriting)}</td>
                    <td style={{ ...styles.reportTd, textAlign: 'right' }}>{formatDuration(row.timeImplementing)}</td>
                    <td style={{ ...styles.reportTd, textAlign: 'right', fontWeight: 600 }}>{formatDuration(row.totalTime)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={styles.reportFooter}>
                <td style={styles.reportTd} colSpan={3}>{t('stats.totalCol')}</td>
                <td style={{ ...styles.reportTd, textAlign: 'right', fontWeight: 600 }}>{formatDuration(stats.totalTimeWriting)}</td>
                <td style={{ ...styles.reportTd, textAlign: 'right', fontWeight: 600 }}>{formatDuration(stats.totalTimeImplementing)}</td>
                <td style={{ ...styles.reportTd, textAlign: 'right', fontWeight: 700 }}>{formatDuration(stats.totalTime)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '20px',
    maxWidth: '800px',
    margin: '0 auto',
    fontFamily: 'var(--vscode-font-family)',
    color: 'var(--vscode-foreground)',
    overflowY: 'auto',
    height: '100vh',
  },
  loading: {
    textAlign: 'center',
    padding: '40px',
    color: 'var(--vscode-descriptionForeground)',
  },
  title: {
    margin: '0 0 20px',
    fontSize: '20px',
    fontWeight: 600,
  },
  periodFilter: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '16px',
  },
  periodLabel: {
    fontSize: '12px',
    fontWeight: 500,
    color: 'var(--vscode-foreground)',
  },
  periodSelect: {
    padding: '4px 8px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border, transparent)',
    borderRadius: '4px',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
  },
  exportBtn: {
    padding: '4px 10px',
    background: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
    whiteSpace: 'nowrap' as const,
  },
  cardsRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: '12px',
    marginBottom: '24px',
  },
  card: {
    padding: '16px',
    background: 'var(--vscode-input-background)',
    borderRadius: '4px',
    textAlign: 'center',
    border: '1px solid var(--vscode-panel-border)',
  },
  cardValue: {
    fontSize: '28px',
    fontWeight: 700,
    color: 'var(--vscode-textLink-foreground)',
    marginBottom: '4px',
  },
  cardLabel: {
    fontSize: '12px',
    color: 'var(--vscode-descriptionForeground)',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  section: {
    marginBottom: '20px',
  },
  sectionTitle: {
    fontSize: '14px',
    fontWeight: 600,
    margin: '0 0 12px',
    paddingBottom: '6px',
    borderBottom: '1px solid var(--vscode-panel-border)',
  },
  barChart: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  barRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  barLabel: {
    fontSize: '12px',
    minWidth: '120px',
    flexShrink: 0,
  },
  barTrack: {
    flex: 1,
    height: '16px',
    background: 'var(--vscode-input-background)',
    borderRadius: '4px',
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    background: 'var(--vscode-progressBar-background)',
    borderRadius: '4px',
    transition: 'width 0.3s ease',
  },
  barCount: {
    fontSize: '12px',
    fontWeight: 600,
    minWidth: '24px',
    textAlign: 'right',
  },
  timeGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '12px',
  },
  timeStat: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '12px',
    background: 'var(--vscode-input-background)',
    borderRadius: '4px',
  },
  timeLabel: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    textTransform: 'uppercase',
  },
  timeValue: {
    fontSize: '18px',
    fontWeight: 600,
  },
  tagCloud: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
  },
  tag: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '4px 10px',
    background: 'var(--vscode-badge-background)',
    color: 'var(--vscode-badge-foreground)',
    borderRadius: '4px',
    fontSize: '12px',
  },
  tagCount: {
    opacity: 0.7,
    fontSize: '10px',
  },
  activityList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  activityItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '6px 8px',
    background: 'var(--vscode-input-background)',
    borderRadius: '4px',
    fontSize: '12px',
  },
  activityTitle: {
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
  },
  activityDate: {
    color: 'var(--vscode-descriptionForeground)',
    fontSize: '11px',
    flexShrink: 0,
    marginLeft: '12px',
  },
  reportTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '12px',
  },
  reportTh: {
    textAlign: 'left',
    padding: '8px 10px',
    borderBottom: '2px solid var(--vscode-panel-border)',
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.3px',
    color: 'var(--vscode-descriptionForeground)',
  },
  reportTd: {
    padding: '6px 10px',
    borderBottom: '1px solid var(--vscode-panel-border)',
    fontSize: '12px',
  },
  reportTaskCell: {
    padding: '6px 10px',
    borderBottom: '1px solid var(--vscode-panel-border)',
    fontSize: '12px',
    fontWeight: 600,
    color: 'var(--vscode-textLink-foreground)',
    whiteSpace: 'nowrap',
  },
  reportRowEven: {
    background: 'var(--vscode-input-background)',
  },
  reportFooter: {
    background: 'var(--vscode-input-background)',
    borderTop: '2px solid var(--vscode-panel-border)',
  },
};
