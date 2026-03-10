import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RichTextEditor } from '../editor/components/RichTextEditor';
import { useT } from '../shared/i18n';
import { useMessageListener } from '../shared/useMessageListener';
import { getVsCodeApi } from '../shared/vscodeApi';
import { shouldIgnoreReportEditorExternalUpdate } from '../../utils/reportSync.js';

const vscode = getVsCodeApi();

export const ReportEditorApp: React.FC = () => {
  const t = useT();
  const [promptId, setPromptId] = useState('');
  const [title, setTitle] = useState('');
  const [report, setReport] = useState('');
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [reportHeight, setReportHeight] = useState<number | undefined>(undefined);
  const flushTimerRef = useRef<number | null>(null);
  const saveFeedbackTimerRef = useRef<number | null>(null);
  const lastActivityRef = useRef(Date.now());
  const pendingActivityRef = useRef(0);
  const lastSyncedReportRef = useRef('');
  const reportRef = useRef('');
  const hasUnsyncedLocalChangesRef = useRef(false);

  const logReportDebug = useCallback((message: string, payload?: Record<string, unknown>) => {
    vscode.postMessage({ type: 'debugLog', scope: 'report-editor', message, payload });
  }, []);

  const clearSaveFeedbackTimer = useCallback(() => {
    if (saveFeedbackTimerRef.current) {
      window.clearTimeout(saveFeedbackTimerRef.current);
      saveFeedbackTimerRef.current = null;
    }
  }, []);

  const flushReport = useCallback((nextReport: string) => {
    if (!promptId) {
      return;
    }

    logReportDebug('flush.dispatched', {
      promptId,
      nextLength: nextReport.length,
      previousSyncedLength: lastSyncedReportRef.current.length,
      activityDeltaMs: pendingActivityRef.current,
    });

    vscode.postMessage({
      type: 'reportEditorUpdate',
      promptId,
      report: nextReport,
      previousReport: lastSyncedReportRef.current,
      activityDeltaMs: pendingActivityRef.current,
    });
    pendingActivityRef.current = 0;
  }, [logReportDebug, promptId]);

  const saveReport = useCallback(() => {
    if (!promptId || saveState === 'saving') {
      return;
    }

    if (flushTimerRef.current) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }

    clearSaveFeedbackTimer();
    setSaveState('saving');
    logReportDebug('save.dispatched', {
      promptId,
      reportLength: report.length,
      previousSyncedLength: lastSyncedReportRef.current.length,
      activityDeltaMs: pendingActivityRef.current,
    });
    vscode.postMessage({
      type: 'reportEditorSave',
      promptId,
      report,
      previousReport: lastSyncedReportRef.current,
      activityDeltaMs: pendingActivityRef.current,
    });
    pendingActivityRef.current = 0;
  }, [clearSaveFeedbackTimer, logReportDebug, promptId, report, saveState]);

  const scheduleFlush = useCallback((nextReport: string, delayMs: number) => {
    if (flushTimerRef.current) {
      window.clearTimeout(flushTimerRef.current);
    }

    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      flushReport(nextReport);
    }, delayMs);
  }, [flushReport]);

  const handleMessage = useCallback((msg: any) => {
    switch (msg.type) {
      case 'reportEditorInit':
        logReportDebug('message.init', {
          promptId: String(msg.promptId || ''),
          reportLength: typeof msg.report === 'string' ? msg.report.length : 0,
        });
        setPromptId(String(msg.promptId || ''));
        setTitle(String(msg.title || ''));
        setReport(typeof msg.report === 'string' ? msg.report : '');
        lastSyncedReportRef.current = typeof msg.report === 'string' ? msg.report : '';
        hasUnsyncedLocalChangesRef.current = false;
        setIsGeneratingReport(false);
        clearSaveFeedbackTimer();
        setSaveState('idle');
        lastActivityRef.current = Date.now();
        pendingActivityRef.current = 0;
        break;
      case 'generatedReport':
        logReportDebug('message.generatedReport', {
          reportLength: typeof msg.report === 'string' ? msg.report.length : 0,
        });
        setReport(typeof msg.report === 'string' ? msg.report : '');
        lastSyncedReportRef.current = typeof msg.report === 'string' ? msg.report : '';
        hasUnsyncedLocalChangesRef.current = false;
        setIsGeneratingReport(false);
        clearSaveFeedbackTimer();
        setSaveState('idle');
        lastActivityRef.current = Date.now();
        pendingActivityRef.current = 0;
        break;
      case 'reportEditorExternalUpdate':
        if (typeof msg.report === 'string' && shouldIgnoreReportEditorExternalUpdate({
          hasUnsyncedLocalChanges: hasUnsyncedLocalChangesRef.current,
          incomingReport: msg.report,
          currentReport: reportRef.current,
        })) {
          logReportDebug('message.externalUpdateIgnoredLocalAhead', {
            incomingLength: msg.report.length,
            currentLength: reportRef.current.length,
            syncedLength: lastSyncedReportRef.current.length,
          });
          break;
        }
        logReportDebug('message.externalUpdate', {
          reportLength: typeof msg.report === 'string' ? msg.report.length : 0,
          currentLength: reportRef.current.length,
        });
        setReport(typeof msg.report === 'string' ? msg.report : '');
        lastSyncedReportRef.current = typeof msg.report === 'string' ? msg.report : '';
        hasUnsyncedLocalChangesRef.current = false;
        clearSaveFeedbackTimer();
        setSaveState('idle');
        lastActivityRef.current = Date.now();
        pendingActivityRef.current = 0;
        break;
      case 'reportEditorSynced':
        logReportDebug('message.synced', {
          reportLength: typeof msg.report === 'string' ? msg.report.length : report.length,
        });
        lastSyncedReportRef.current = typeof msg.report === 'string' ? msg.report : report;
        hasUnsyncedLocalChangesRef.current = false;
        break;
      case 'reportEditorSaved':
        logReportDebug('message.saved', {
          reportLength: report.length,
        });
        lastSyncedReportRef.current = report;
        hasUnsyncedLocalChangesRef.current = false;
        clearSaveFeedbackTimer();
        setSaveState('saved');
        saveFeedbackTimerRef.current = window.setTimeout(() => {
          setSaveState('idle');
          saveFeedbackTimerRef.current = null;
        }, 1800);
        break;
      case 'error':
        logReportDebug('message.error', {
          message: String(msg.message || ''),
        });
        setIsGeneratingReport(false);
        clearSaveFeedbackTimer();
        setSaveState('idle');
        break;
      default:
        break;
    }
  }, [clearSaveFeedbackTimer]);

  useMessageListener(handleMessage);

  useEffect(() => {
    vscode.postMessage({ type: 'reportEditorReady', promptId });
    logReportDebug('ready', {
      promptId,
    });
  }, [logReportDebug, promptId]);

  useEffect(() => {
    reportRef.current = report;
  }, [report]);

  useEffect(() => {
    logReportDebug('state.reportChanged', {
      promptId,
      reportLength: report.length,
      syncedLength: lastSyncedReportRef.current.length,
      saveState,
    });
  }, [logReportDebug, promptId, report, saveState]);

  useEffect(() => {
    return () => {
      const hadPendingFlush = flushTimerRef.current !== null;
      if (flushTimerRef.current) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      clearSaveFeedbackTimer();
      if (hadPendingFlush) {
        logReportDebug('cleanup.flushPendingOnUnmount', {
          promptId,
          reportLength: reportRef.current.length,
        });
        flushReport(reportRef.current);
      }
    };
  }, [clearSaveFeedbackTimer, flushReport, logReportDebug, promptId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isSaveShortcut = (event.ctrlKey || event.metaKey) && (event.code === 'KeyS' || event.key.toLowerCase() === 's');
      if (isSaveShortcut) {
        event.preventDefault();
        event.stopPropagation();
        saveReport();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [saveReport]);

  const saveLabel = saveState === 'saving'
    ? t('editor.saving')
    : saveState === 'saved'
      ? t('editor.saved')
      : t('editor.save');

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.headerMain}>
          <div style={styles.headerText}>
            <h2 style={styles.title}>{t('editor.workResult')}</h2>
            <div style={styles.subtitle}>{title || promptId || '...'}</div>
          </div>
          <button
            type="button"
            style={{
              ...styles.saveButton,
              ...(saveState === 'saved' ? styles.saveButtonSaved : null),
              ...((!promptId || saveState === 'saving') ? styles.saveButtonDisabled : null),
            }}
            onClick={saveReport}
            disabled={!promptId || saveState === 'saving'}
            title="Ctrl+S"
          >
            {saveLabel}
          </button>
        </div>
      </div>

      <RichTextEditor
        value={report}
        onChange={(nextReport) => {
          const now = Date.now();
          const rawDelta = now - lastActivityRef.current;
          if (rawDelta > 0 && rawDelta <= 5000) {
            pendingActivityRef.current += rawDelta;
          }
          lastActivityRef.current = now;
          logReportDebug('input.onChange', {
            promptId,
            previousLength: report.length,
            nextLength: nextReport.length,
            rawDelta,
            pendingActivityMs: pendingActivityRef.current,
          });
          hasUnsyncedLocalChangesRef.current = true;
          if (saveState !== 'idle') {
            clearSaveFeedbackTimer();
            setSaveState('idle');
          }
          setReport(nextReport);
          scheduleFlush(nextReport, 350);
        }}
        autoModeKey={promptId}
        placeholder={t('editor.reportPlaceholder')}
        t={t}
        persistedHeight={reportHeight}
        onHeightChange={setReportHeight}
        canReset={Boolean(report.trim())}
        fillHeight
        onDebug={logReportDebug}
        showFormattingToolbar
        onSecondaryAction={() => {
          if (!promptId || isGeneratingReport) {
            return;
          }

          setIsGeneratingReport(true);
          vscode.postMessage({ type: 'reportEditorGenerate', promptId });
        }}
        secondaryActionLabel={isGeneratingReport ? t('editor.generating') : t('editor.generateReport')}
        secondaryActionTitle={t('editor.generateReportTooltip')}
        secondaryActionDisabled={!promptId || isGeneratingReport}
        onReset={() => {
          lastActivityRef.current = Date.now();
          logReportDebug('reset', {
            promptId,
            previousLength: report.length,
          });
          hasUnsyncedLocalChangesRef.current = true;
          setReport('');
          scheduleFlush('', 0);
        }}
      />
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    height: '100vh',
    minHeight: 0,
    padding: '16px',
    background: 'var(--vscode-editor-background)',
  },
  header: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  headerMain: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '12px',
  },
  headerText: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    minWidth: 0,
  },
  title: {
    margin: 0,
    fontSize: '16px',
    fontWeight: 600,
    color: 'var(--vscode-foreground)',
  },
  subtitle: {
    fontSize: '12px',
    color: 'var(--vscode-descriptionForeground)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  saveButton: {
    border: '1px solid var(--vscode-button-border, transparent)',
    background: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
    borderRadius: '6px',
    padding: '6px 12px',
    fontSize: '12px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  saveButtonSaved: {
    background: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
  },
  saveButtonDisabled: {
    border: 'none',
    opacity: 0.6,
    cursor: 'not-allowed',
  },
};
