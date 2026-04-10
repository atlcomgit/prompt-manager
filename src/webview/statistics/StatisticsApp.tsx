/**
 * Statistics App — Shows prompt usage statistics and reports
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { getVsCodeApi } from '../shared/vscodeApi';
import { useMessageListener } from '../shared/useMessageListener';
import { useT } from '../shared/i18n';
import { DateRangeCalendar } from './DateRangeCalendar';
import type { PromptStatistics, PromptStatus } from '../../types/prompt';
import { calculateStatisticsExportTargetHours } from '../../utils/statisticsExport.js';
import {
  buildStatisticsExportHtmlPreview,
  buildStatisticsExportMarkdownDocument,
  type StatisticsExportDocumentRow,
} from '../../utils/statisticsDocumentTemplate.js';

const vscode = getVsCodeApi();
const DEFAULT_EXPORT_HOURS = 165;
const DEFAULT_EXPORT_HOURLY_RATE = 1743;
const STATISTICS_HOURLY_RATE_WEBVIEW_STATE_KEY = 'pm.statistics.hourlyRateInput';

/** Format milliseconds as human-readable duration */
function formatDuration(ms: number): string {
  if (ms < 1000) return '0с';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}ч ${minutes}м ${seconds}с`;
  if (minutes > 0) return `${minutes}м ${seconds}с`;
  return `${seconds}с`;
}

/** Sort direction type */
type SortDir = 'asc' | 'desc';

/** Single sort criterion */
interface SortCriterion {
  field: string;
  dir: SortDir;
}

/** Column keys for report table */
type ReportColumn = 'taskNumber' | 'title' | 'status' | 'timeWriting' | 'timeImplementing' | 'timeOnTask' | 'totalTime';

type ExportFormat = 'html' | 'md';

function readInitialHourlyRateInput(): string {
  const state = (vscode.getState() || {}) as Record<string, unknown>;
  const savedValue = state[STATISTICS_HOURLY_RATE_WEBVIEW_STATE_KEY];
  return typeof savedValue === 'string' ? savedValue : String(DEFAULT_EXPORT_HOURLY_RATE);
}

function parseOptionalExportHours(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseOptionalExportHourlyRate(value: string): number | null {
  const normalized = value.trim().replace(',', '.');
  if (!normalized) {
    return null;
  }

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function buildScaledExportRows(
  rows: Array<{ taskNumber: string; title: string; totalTime: number; status: PromptStatus; reportSummary?: string }>,
  targetHours: number,
): StatisticsExportDocumentRow[] {
  if (rows.length === 0) {
    return [];
  }

  const totalMs = rows.reduce((sum, row) => sum + row.totalTime, 0);

  if (totalMs <= 0) {
    const baseHours = Math.floor(targetHours / rows.length);
    let remainder = targetHours - baseHours * rows.length;
    return rows.map((row) => {
      const hours = baseHours + (remainder > 0 ? 1 : 0);
      remainder = Math.max(0, remainder - 1);
      return {
        taskNumber: row.taskNumber || '—',
        title: row.title,
        hours,
        status: row.status,
        reportSummary: row.reportSummary || '',
      };
    });
  }

  const scale = targetHours / (totalMs / (1000 * 60 * 60));
  const normalized = rows.map((row, index) => {
    const rawHours = (row.totalTime / (1000 * 60 * 60)) * scale;
    const flooredHours = Math.floor(rawHours);
    return {
      index,
      rawHours,
      flooredHours,
      fraction: rawHours - flooredHours,
      row,
    };
  });

  let allocatedHours = normalized.reduce((sum, item) => sum + item.flooredHours, 0);
  let remainder = targetHours - allocatedHours;

  normalized
    .slice()
    .sort((left, right) => {
      if (right.fraction !== left.fraction) {
        return right.fraction - left.fraction;
      }
      return left.index - right.index;
    })
    .forEach((item) => {
      if (remainder <= 0) {
        return;
      }
      item.flooredHours += 1;
      remainder -= 1;
      allocatedHours += 1;
    });

  if (allocatedHours !== targetHours && normalized.length > 0) {
    normalized[normalized.length - 1].flooredHours += targetHours - allocatedHours;
  }

  return normalized
    .sort((left, right) => left.index - right.index)
    .map(({ row, flooredHours }) => ({
      taskNumber: row.taskNumber || '—',
      title: row.title,
      hours: flooredHours,
      status: row.status,
      reportSummary: row.reportSummary || '',
    }));
}

export const StatisticsApp: React.FC = () => {
  const t = useT();
  const [stats, setStats] = useState<PromptStatistics | null>(null);
  const [previewFormat, setPreviewFormat] = useState<ExportFormat>('html');

  // --- Date range filter ---
  const [dateFrom, setDateFrom] = useState<string | null>(null);
  const [dateTo, setDateTo] = useState<string | null>(null);
  /** Flag: show only prompts with ≥5 min total time in daily-time.json */
  const [minFiveMin, setMinFiveMin] = useState(false);
  const [includeReportInExport, setIncludeReportInExport] = useState(false);
  const [exportHoursInput, setExportHoursInput] = useState<string>(String(DEFAULT_EXPORT_HOURS));
  const [hourlyRateInput, setHourlyRateInput] = useState<string>(() => readInitialHourlyRateInput());
  const [statisticsUiHydrated, setStatisticsUiHydrated] = useState(false);

  // --- Table sorting (multi-column) ---
  const [sortCriteria, setSortCriteria] = useState<SortCriterion[]>([]);

  /** Load statistics with current filters */
  const loadStatistics = useCallback(() => {
    const msg: any = { type: 'getStatistics' };
    if (dateFrom && dateTo) {
      msg.dateFrom = dateFrom;
      msg.dateTo = dateTo;
    }
    if (minFiveMin) {
      msg.minFiveMin = true;
    }
    vscode.postMessage(msg);
  }, [dateFrom, dateTo, minFiveMin]);

  useEffect(() => {
    loadStatistics();
  }, [loadStatistics]);

  useEffect(() => {
    vscode.postMessage({ type: 'getStatisticsUiState' });
  }, []);

  useEffect(() => {
    if (!dateFrom && !dateTo) {
      const fallbackHours = String(DEFAULT_EXPORT_HOURS);
      setExportHoursInput((prev) => prev === fallbackHours ? prev : fallbackHours);
      return;
    }

    if (!dateFrom || !dateTo) {
      return;
    }

    const nextHours = String(calculateStatisticsExportTargetHours({
      dateFrom,
      dateTo,
      fallbackHours: DEFAULT_EXPORT_HOURS,
    }));
    setExportHoursInput((prev) => prev === nextHours ? prev : nextHours);
  }, [dateFrom, dateTo]);

  useEffect(() => {
    const currentState = (vscode.getState() || {}) as Record<string, unknown>;
    if (currentState[STATISTICS_HOURLY_RATE_WEBVIEW_STATE_KEY] === hourlyRateInput) {
      return;
    }

    vscode.setState({
      ...currentState,
      [STATISTICS_HOURLY_RATE_WEBVIEW_STATE_KEY]: hourlyRateInput,
    });
  }, [hourlyRateInput]);

  useEffect(() => {
    if (!statisticsUiHydrated) {
      return;
    }

    vscode.postMessage({ type: 'saveStatisticsUiState', hourlyRateInput });
  }, [hourlyRateInput, statisticsUiHydrated]);

  /** Handle messages from extension */
  const handleMessage = useCallback((msg: any) => {
    if (msg.type === 'statistics') {
      setStats(msg.data);
    }

    if (msg.type === 'statisticsUiState') {
      setHourlyRateInput(typeof msg.hourlyRateInput === 'string' ? msg.hourlyRateInput : String(DEFAULT_EXPORT_HOURLY_RATE));
      setStatisticsUiHydrated(true);
    }
  }, []);

  useMessageListener(handleMessage);

  /** Reset all filters */
  const resetFilters = useCallback(() => {
    setDateFrom(null);
    setDateTo(null);
    setMinFiveMin(false);
  }, []);

  /** Handle column header click for sorting */
  const handleSortClick = useCallback((field: ReportColumn, e: React.MouseEvent) => {
    setSortCriteria(prev => {
      // Ctrl+Click — add/toggle secondary sort
      if (e.ctrlKey || e.metaKey) {
        const existingIdx = prev.findIndex(c => c.field === field);
        if (existingIdx >= 0) {
          // Toggle direction or remove if clicked 3rd time
          const existing = prev[existingIdx];
          if (existing.dir === 'asc') {
            const updated = [...prev];
            updated[existingIdx] = { field, dir: 'desc' };
            return updated;
          } else {
            // Remove this sort criterion
            return prev.filter((_, i) => i !== existingIdx);
          }
        }
        return [...prev, { field, dir: 'asc' }];
      }
      // Regular click — single column sort
      const existing = prev.length === 1 && prev[0].field === field ? prev[0] : null;
      if (existing) {
        return existing.dir === 'asc' ? [{ field, dir: 'desc' }] : [];
      }
      return [{ field, dir: 'asc' }];
    });
  }, []);

  /** Reset sort */
  const resetSort = useCallback(() => {
    setSortCriteria([]);
  }, []);

  /** Sort indicator for column header */
  const getSortIndicator = useCallback((field: ReportColumn): string => {
    const idx = sortCriteria.findIndex(c => c.field === field);
    if (idx < 0) return '';
    const arrow = sortCriteria[idx].dir === 'asc' ? '↑' : '↓';
    return sortCriteria.length > 1 ? `${arrow}${idx + 1}` : arrow;
  }, [sortCriteria]);

  /** Sorted report rows */
  const sortedReportRows = useMemo(() => {
    if (!stats?.reportRows) return [];
    const rows = [...stats.reportRows];

    if (sortCriteria.length === 0) {
      // Default sort: by task number descending
      return rows.sort((a, b) => {
        const numA = parseInt(a.taskNumber, 10);
        const numB = parseInt(b.taskNumber, 10);
        const isNumA = !isNaN(numA);
        const isNumB = !isNaN(numB);
        if (isNumA && isNumB) return numB - numA;
        if (isNumA) return -1;
        if (isNumB) return 1;
        return b.taskNumber.localeCompare(a.taskNumber);
      });
    }

    return rows.sort((a, b) => {
      for (const { field, dir } of sortCriteria) {
        let cmp = 0;
        const valA = (a as any)[field];
        const valB = (b as any)[field];
        if (typeof valA === 'number' && typeof valB === 'number') {
          cmp = valA - valB;
        } else if (field === 'taskNumber') {
          const nA = parseInt(valA, 10);
          const nB = parseInt(valB, 10);
          const isNA = !isNaN(nA);
          const isNB = !isNaN(nB);
          if (isNA && isNB) cmp = nA - nB;
          else if (isNA) cmp = -1;
          else if (isNB) cmp = 1;
          else cmp = String(valA).localeCompare(String(valB));
        } else {
          cmp = String(valA || '').localeCompare(String(valB || ''));
        }
        if (cmp !== 0) return dir === 'asc' ? cmp : -cmp;
      }
      return 0;
    });
  }, [stats?.reportRows, sortCriteria]);

  const parsedExportHours = useMemo(() => parseOptionalExportHours(exportHoursInput), [exportHoursInput]);
  const showHours = parsedExportHours !== null && parsedExportHours > 0;
  const exportTargetHours = showHours && parsedExportHours !== null ? parsedExportHours : 0;
  const parsedExportHourlyRate = useMemo(() => parseOptionalExportHourlyRate(hourlyRateInput), [hourlyRateInput]);
  const showCost = showHours && parsedExportHourlyRate !== null && parsedExportHourlyRate > 0;
  const exportHourlyRate = showCost && parsedExportHourlyRate !== null ? parsedExportHourlyRate : 0;
  const exportDisplayOptions = useMemo(() => ({ showHours, showCost }), [showCost, showHours]);

  const exportRows = useMemo(
    () => buildScaledExportRows(sortedReportRows, exportTargetHours),
    [exportTargetHours, sortedReportRows],
  );
  const exportRowsTotal = useMemo(
    () => exportRows.reduce((sum, row) => sum + row.hours, 0),
    [exportRows],
  );
  const uiLocale = useMemo(() => {
    if (typeof document !== 'undefined') {
      return document.documentElement.lang || navigator.language || 'en';
    }
    return 'en';
  }, []);
  const exportHtmlPreview = useMemo(
    () => buildStatisticsExportHtmlPreview(
      exportRows,
      exportRowsTotal,
      uiLocale,
      includeReportInExport,
      exportHourlyRate,
      exportDisplayOptions,
    ),
    [exportDisplayOptions, exportHourlyRate, uiLocale, exportRows, exportRowsTotal, includeReportInExport],
  );
  const exportMarkdownPreview = useMemo(
    () => buildStatisticsExportMarkdownDocument(
      exportRows,
      exportRowsTotal,
      uiLocale,
      includeReportInExport,
      exportHourlyRate,
      exportDisplayOptions,
    ),
    [exportDisplayOptions, exportHourlyRate, uiLocale, exportRows, exportRowsTotal, includeReportInExport],
  );

  const handleExport = useCallback((format: ExportFormat) => {
    if (exportRows.length === 0) return;
    vscode.postMessage({
      type: 'exportReport',
      format,
      rows: exportRows,
      hourlyRate: exportHourlyRate,
      includeReport: includeReportInExport,
      showHours,
      showCost,
    });
  }, [exportHourlyRate, exportRows, includeReportInExport, showCost, showHours]);

  /** Status labels map */
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

  if (!stats) {
    return (
      <div style={styles.page}>
        <div style={styles.container}>
          <div style={styles.loading}>{t('stats.loading')}</div>
        </div>
      </div>
    );
  }

  /** Column header builder with sort support */
  const sortableHeader = (field: ReportColumn, label: string, align: 'left' | 'right' = 'left') => {
    const indicator = getSortIndicator(field);
    return (
      <th
        style={{
          ...styles.reportTh,
          textAlign: align,
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={(e) => handleSortClick(field, e)}
        title={t('stats.sortTooltip')}
      >
        {label} {indicator && <span style={styles.sortIndicator}>{indicator}</span>}
      </th>
    );
  };

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <h2 style={styles.title}>{t('stats.title')}</h2>

        {/* Period filter — date range + min 5 min checkbox + reset */}
        <div style={styles.periodFilter}>
          <label style={styles.periodLabel}>{t('stats.period')}</label>
          <DateRangeCalendar
            dateFrom={dateFrom}
            dateTo={dateTo}
            onChange={(from, to) => { setDateFrom(from); setDateTo(to); }}
            placeholder={t('stats.selectPeriod')}
          />
          <label style={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={minFiveMin}
              onChange={e => setMinFiveMin(e.target.checked)}
              style={styles.checkbox}
            />
            {t('stats.minFiveMin')}
          </label>
          {(dateFrom || dateTo || minFiveMin) && (
            <button
              style={styles.resetBtn}
              onClick={resetFilters}
              title={t('stats.resetFilters')}
            >
              ✕ {t('stats.resetFilters')}
            </button>
          )}
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
                'draft': '📝', 'in-progress': '🚀', 'stopped': '▣', 'cancelled': '❌',
                'completed': '✅', 'report': '🧾', 'review': '🔎', 'closed': '🔒',
              };
              const STATUS_KEYS: Record<string, string> = {
                'draft': 'status.draft', 'in-progress': 'status.inProgress', 'stopped': 'status.stopped',
                'cancelled': 'status.cancelled', 'completed': 'status.completed', 'report': 'status.report',
                'review': 'status.review', 'closed': 'status.closed',
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

        {/* Time breakdown — all fields in one row, equal size */}
        <div style={styles.section}>
          <h3 style={styles.sectionTitle}>{t('stats.time')}</h3>
          <div style={styles.timeGridRow}>
            <div style={styles.timeStat}>
              <span style={styles.timeLabel}>{t('stats.writingTime')}</span>
              <span style={styles.timeValue}>{formatDuration(stats.totalTimeWriting)}</span>
            </div>
            <div style={styles.timeStat}>
              <span style={styles.timeLabel}>{t('stats.implementingTime')}</span>
              <span style={styles.timeValue}>{formatDuration(stats.totalTimeImplementing)}</span>
            </div>
            <div style={styles.timeStat}>
              <span style={styles.timeLabel}>{t('stats.taskWorkTime')}</span>
              <span style={styles.timeValue}>{formatDuration(stats.totalTimeOnTask || 0)}</span>
            </div>
          </div>
        </div>

        {/* Recent activity */}
        {stats.recentActivity.length > 0 && (
          <div style={styles.section}>
            <h3 style={styles.sectionTitle}>{t('stats.recentActivity')}</h3>
            <div style={styles.activityList}>
              {stats.recentActivity.map(a => (
                <div key={a.id} style={styles.activityItem}>
                  <span style={styles.activityTitle}>{a.title || a.id}</span>
                  <span style={styles.activityDate}>
                    {new Date(a.updatedAt).toLocaleDateString(uiLocale, {
                      day: '2-digit', month: '2-digit', year: '2-digit',
                      hour: '2-digit', minute: '2-digit',
                    })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Brief report table with sortable headers */}
        {stats.reportRows && stats.reportRows.length > 0 && (
          <div style={styles.section}>
            <h3 style={styles.sectionTitle}>{t('stats.briefReport')}</h3>
            <div style={styles.reportControlsPanel}>
              <div style={styles.reportControlsLeft}>
                {sortCriteria.length > 0 && (
                  <button
                    style={styles.resetSortBtn}
                    onClick={resetSort}
                    title={t('stats.resetSort')}
                  >
                    ✕ {t('stats.resetSort')}
                  </button>
                )}
                <label style={styles.exportField}>
                  <span style={styles.exportFieldLabel}>{t('stats.exportHoursField')}</span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={exportHoursInput}
                    onChange={e => setExportHoursInput(e.target.value)}
                    style={styles.exportInput}
                  />
                </label>
                <label style={styles.exportField}>
                  <span style={styles.exportFieldLabel}>{t('stats.exportRateField')}</span>
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    value={hourlyRateInput}
                    onChange={e => setHourlyRateInput(e.target.value)}
                    style={styles.exportInput}
                  />
                </label>
                <label style={styles.checkboxLabel} title={t('stats.exportWithReportTooltip')}>
                  <input
                    type="checkbox"
                    checked={includeReportInExport}
                    onChange={e => setIncludeReportInExport(e.target.checked)}
                    style={styles.checkbox}
                  />
                  {t('stats.exportWithReport')}
                </label>
              </div>
              <div style={styles.reportControlsRight}>
                <button
                  style={styles.exportBtn}
                  onClick={() => handleExport('html')}
                  title={t('stats.exportHtmlTooltip').replace('{hours}', String(exportTargetHours))}
                >
                  {`${t('stats.exportHtmlBtn')} (${exportTargetHours}${t('stats.exportHoursSuffix')})`}
                </button>
                <button
                  style={styles.exportMdBtn}
                  onClick={() => handleExport('md')}
                  title={t('stats.exportMdTooltip').replace('{hours}', String(exportTargetHours))}
                >
                  {`${t('stats.exportMdBtn')} (${exportTargetHours}${t('stats.exportHoursSuffix')})`}
                </button>
              </div>
            </div>
            <div style={styles.documentPreviewCard}>
              <div style={styles.documentPreviewHeader}>
                <div style={styles.documentPreviewHeadingBlock}>
                  <div style={styles.documentPreviewTitle}>{t('stats.documentPreview')}</div>
                  <div style={styles.documentPreviewSubtitle}>
                    {previewFormat === 'html'
                      ? t('stats.documentPreviewHtmlHint')
                      : t('stats.documentPreviewMdHint')}
                  </div>
                </div>
                <div style={styles.documentPreviewTabs}>
                  <button
                    type="button"
                    style={{
                      ...styles.documentPreviewTab,
                      ...(previewFormat === 'html' ? styles.documentPreviewTabActive : null),
                    }}
                    onClick={() => setPreviewFormat('html')}
                  >
                    {t('stats.previewHtmlTab')}
                  </button>
                  <button
                    type="button"
                    style={{
                      ...styles.documentPreviewTab,
                      ...(previewFormat === 'md' ? styles.documentPreviewTabActive : null),
                    }}
                    onClick={() => setPreviewFormat('md')}
                  >
                    {t('stats.previewMdTab')}
                  </button>
                </div>
              </div>
              <div style={styles.documentPreviewViewport}>
                {previewFormat === 'html' ? (
                  <div
                    style={styles.documentPreviewHtmlCanvas}
                    dangerouslySetInnerHTML={{ __html: exportHtmlPreview }}
                  />
                ) : (
                  <pre style={styles.documentPreviewSource}>
                    <code style={styles.documentPreviewSourceCode}>{exportMarkdownPreview}</code>
                  </pre>
                )}
              </div>
            </div>
            <table style={styles.reportTable}>
              <thead>
                <tr>
                  {sortableHeader('taskNumber', t('stats.taskCol'))}
                  {sortableHeader('title', t('stats.nameCol'))}
                  {sortableHeader('status', t('stats.statusCol'))}
                  {sortableHeader('timeWriting', t('stats.writingCol'), 'right')}
                  {sortableHeader('timeImplementing', t('stats.implementingCol'), 'right')}
                  {sortableHeader('timeOnTask', t('stats.taskWorkCol'), 'right')}
                  {sortableHeader('totalTime', t('stats.totalCol'), 'right')}
                </tr>
              </thead>
              <tbody>
                {sortedReportRows.map((row, idx) => (
                  <tr key={idx} style={idx % 2 === 0 ? styles.reportRowEven : undefined}>
                    <td style={styles.reportTaskCell}>{row.taskNumber || '—'}</td>
                    <td style={styles.reportTd}>{row.title}</td>
                    <td style={styles.reportTd}>{statusLabels[row.status] || row.status}</td>
                    <td style={{ ...styles.reportTd, textAlign: 'right' }}>{formatDuration(row.timeWriting)}</td>
                    <td style={{ ...styles.reportTd, textAlign: 'right' }}>{formatDuration(row.timeImplementing)}</td>
                    <td style={{ ...styles.reportTd, textAlign: 'right' }}>{formatDuration(row.timeOnTask || 0)}</td>
                    <td style={{ ...styles.reportTd, textAlign: 'right', fontWeight: 600 }}>{formatDuration(row.totalTime)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={styles.reportFooter}>
                  <td style={styles.reportTd} colSpan={3}>{t('stats.totalCol')}</td>
                  <td style={{ ...styles.reportTd, textAlign: 'right', fontWeight: 600 }}>{formatDuration(stats.totalTimeWriting)}</td>
                  <td style={{ ...styles.reportTd, textAlign: 'right', fontWeight: 600 }}>{formatDuration(stats.totalTimeImplementing)}</td>
                  <td style={{ ...styles.reportTd, textAlign: 'right', fontWeight: 600 }}>{formatDuration(stats.totalTimeOnTask || 0)}</td>
                  <td style={{ ...styles.reportTd, textAlign: 'right', fontWeight: 700 }}>{formatDuration(stats.totalTime)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  page: {
    width: '100%',
    height: '100vh',
    overflowY: 'auto',
    display: 'flex',
    justifyContent: 'center',
  },
  container: {
    padding: '20px',
    width: '980px',
    maxWidth: '980px',
    minWidth: '920px',
    boxSizing: 'border-box',
    fontFamily: 'var(--vscode-font-family)',
    color: 'var(--vscode-foreground)',
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
    gap: '10px',
    marginBottom: '16px',
    flexWrap: 'wrap',
  },
  periodLabel: {
    fontSize: '12px',
    fontWeight: 500,
    color: 'var(--vscode-foreground)',
  },
  checkboxLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '12px',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  checkbox: {
    accentColor: 'var(--vscode-button-background)',
  },
  resetBtn: {
    padding: '4px 8px',
    background: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '11px',
    fontFamily: 'var(--vscode-font-family)',
    whiteSpace: 'nowrap',
  },
  resetSortBtn: {
    padding: '4px 8px',
    background: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '11px',
    fontFamily: 'var(--vscode-font-family)',
    whiteSpace: 'nowrap',
  },
  reportControlsPanel: {
    display: 'flex',
    gap: '12px',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    marginBottom: '12px',
    padding: '12px',
    background: 'var(--vscode-input-background)',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '6px',
  },
  documentPreviewCard: {
    marginBottom: '14px',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '10px',
    overflow: 'hidden',
    background: 'var(--vscode-editor-background)',
    boxShadow: '0 10px 28px color-mix(in srgb, var(--vscode-panel-border) 18%, transparent)',
  },
  documentPreviewHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '12px',
    padding: '12px 14px',
    /*background: 'color-mix(in srgb, var(--vscode-input-background) 84%, var(--vscode-editor-background) 16%)',*/
    background: 'var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15))',
    borderBottom: '1px solid var(--vscode-panel-border)',
    flexWrap: 'wrap',
  },
  documentPreviewHeadingBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  documentPreviewTitle: {
    fontSize: '13px',
    fontWeight: 700,
    color: 'var(--vscode-foreground)',
  },
  documentPreviewSubtitle: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
  },
  documentPreviewTabs: {
    display: 'inline-flex',
    gap: '6px',
    alignItems: 'center',
  },
  documentPreviewTab: {
    padding: '6px 10px',
    background: 'transparent',
    color: 'var(--vscode-foreground)',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '999px',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
  },
  documentPreviewTabActive: {
    background: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
    border: '1px solid color-mix(in srgb, var(--vscode-button-background) 76%, black)',
  },
  documentPreviewViewport: {
    maxHeight: '760px',
    overflow: 'auto',
    background: 'color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-input-background) 10%)',
  },
  documentPreviewHtmlCanvas: {
    minWidth: '840px',
    transform: 'scale(0.6667)',
    transformOrigin: 'top left',
    width: '150%',
  },
  documentPreviewSource: {
    margin: 0,
    padding: '22px 26px',
    background: 'transparent',
    color: 'var(--vscode-editor-foreground)',
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: '12px',
    lineHeight: 1.75,
    whiteSpace: 'pre',
    minWidth: 'max-content',
  },
  documentPreviewSourceCode: {
    fontFamily: 'inherit',
    fontSize: 'inherit',
    color: 'inherit',
  },
  reportControlsLeft: {
    display: 'flex',
    gap: '8px',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    flex: '1 1 520px',
  },
  reportControlsRight: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    marginLeft: 'auto',
  },
  exportField: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    minWidth: '120px',
  },
  exportFieldLabel: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    whiteSpace: 'nowrap',
  },
  exportInput: {
    display: 'block',
    width: '100%',
    maxWidth: '140px',
    padding: '4px 8px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border)',
    borderRadius: '3px',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
    boxSizing: 'border-box',
  },
  exportBtn: {
    padding: '6px 12px',
    background: 'linear-gradient(135deg, var(--vscode-button-background), color-mix(in srgb, var(--vscode-button-background) 70%, white))',
    color: 'var(--vscode-button-foreground)',
    border: '1px solid color-mix(in srgb, var(--vscode-button-background) 70%, black)',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
    whiteSpace: 'nowrap',
    boxShadow: '0 8px 20px color-mix(in srgb, var(--vscode-button-background) 20%, transparent)',
  },
  exportMdBtn: {
    padding: '6px 12px',
    background: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
    whiteSpace: 'nowrap',
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
  /* Time grid: all 3 fields in one row, equal width */
  timeGridRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
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
  sortIndicator: {
    fontSize: '10px',
    color: 'var(--vscode-textLink-foreground)',
    marginLeft: '2px',
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
