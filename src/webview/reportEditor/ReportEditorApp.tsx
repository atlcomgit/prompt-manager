import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RichTextEditor } from '../editor/components/RichTextEditor';
import { useT } from '../shared/i18n';
import { useMessageListener } from '../shared/useMessageListener';
import { getVsCodeApi } from '../shared/vscodeApi';

const vscode = getVsCodeApi();

export const ReportEditorApp: React.FC = () => {
  const t = useT();
  const [promptId, setPromptId] = useState('');
  const [title, setTitle] = useState('');
  const [report, setReport] = useState('');
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [reportHeight, setReportHeight] = useState<number | undefined>(undefined);
  const flushTimerRef = useRef<number | null>(null);
  const lastActivityRef = useRef(Date.now());
  const pendingActivityRef = useRef(0);

  const flushReport = useCallback((nextReport: string) => {
    if (!promptId) {
      return;
    }

    vscode.postMessage({
      type: 'reportEditorUpdate',
      promptId,
      report: nextReport,
      activityDeltaMs: pendingActivityRef.current,
    });
    pendingActivityRef.current = 0;
  }, [promptId]);

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
        setPromptId(String(msg.promptId || ''));
        setTitle(String(msg.title || ''));
        setReport(typeof msg.report === 'string' ? msg.report : '');
        setIsGeneratingReport(false);
        lastActivityRef.current = Date.now();
        pendingActivityRef.current = 0;
        break;
      case 'generatedReport':
        setReport(typeof msg.report === 'string' ? msg.report : '');
        setIsGeneratingReport(false);
        lastActivityRef.current = Date.now();
        pendingActivityRef.current = 0;
        break;
      case 'error':
        setIsGeneratingReport(false);
        break;
      default:
        break;
    }
  }, []);

  useMessageListener(handleMessage);

  useEffect(() => {
    vscode.postMessage({ type: 'reportEditorReady', promptId });
  }, [promptId]);

  useEffect(() => {
    return () => {
      if (flushTimerRef.current) {
        window.clearTimeout(flushTimerRef.current);
      }
      flushReport(report);
    };
  }, [flushReport, report]);

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>{t('editor.workResult')}</h2>
        <div style={styles.subtitle}>{title || promptId || '...'}</div>
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
          setReport(nextReport);
          scheduleFlush(nextReport, 350);
        }}
        placeholder={t('editor.reportPlaceholder')}
        persistedHeight={reportHeight}
        onHeightChange={setReportHeight}
        canReset={Boolean(report.trim())}
        fillHeight
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
};
