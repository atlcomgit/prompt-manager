import React from 'react';
import type { PromptVoiceStatus } from '../voice/usePromptVoiceController';

type Props = {
  status: PromptVoiceStatus;
  elapsedLabel: string;
  maxDurationLabel: string;
  levels: number[];
  progressMessage: string;
  progressPercent: number | null;
  errorMessage: string;
  errorBadge: string;
  errorHint: string;
  onConfirm: () => void | Promise<void>;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void | Promise<void>;
  t: (key: string) => string;
};

const VoiceIcon: React.FC<{ path: string; size?: number }> = ({ path, size = 14 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
    <path fill="currentColor" d={path} />
  </svg>
);

const ICONS = {
  mic: 'M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a1 1 0 1 1 2 0 7 7 0 0 1-6 6.93V21h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-3.07A7 7 0 0 1 5 11a1 1 0 1 1 2 0 5 5 0 1 0 10 0z',
  pause: 'M7 5h3v14H7V5zm7 0h3v14h-3V5z',
  record: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  ok: 'M9.55 18.55 3.7 12.7l1.4-1.4 4.45 4.45L18.9 6.4l1.4 1.4-10.75 10.75z',
  cancel: 'M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.29 19.7 2.88 18.3 9.17 12 2.88 5.71 4.29 4.29l6.3 6.3 6.3-6.3z',
};

const VoiceButton: React.FC<{
  label: string;
  icon: keyof typeof ICONS;
  onClick: () => void | Promise<void>;
  variant?: 'primary' | 'secondary' | 'danger';
}> = ({ label, icon, onClick, variant = 'secondary' }) => (
  <button
    type="button"
    onClick={() => { void onClick(); }}
    style={{
      ...styles.actionButton,
      ...(variant === 'primary' ? styles.actionButtonPrimary : null),
      ...(variant === 'danger' ? styles.actionButtonDanger : null),
    }}
  >
    <VoiceIcon path={ICONS[icon]} />
    <span>{label}</span>
  </button>
);

const WAVE_VIEWBOX_WIDTH = 520;
const WAVE_VIEWBOX_HEIGHT = 92;
const WAVE_CENTER_Y = WAVE_VIEWBOX_HEIGHT / 2;
const WAVE_HISTORY_POINTS = 132;
const WAVE_FRAME_MS = 26;
const WAVE_HORIZONTAL_PADDING = 8;
const WAVE_MAX_AMPLITUDE = 34;
const SILENT_WAVE_VALUE = 0.006;
const WAVE_BASE_AMPLITUDE = 0.18;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const createWaveformHistory = (value: number = SILENT_WAVE_VALUE): number[] => (
  Array.from({ length: WAVE_HISTORY_POINTS }, () => value)
);

const deriveWaveformEnergy = (levels: number[]): number => {
  if (levels.length === 0) {
    return 0.03;
  }

  let total = 0;
  let peak = 0;
  let min = 1;

  for (const level of levels) {
    total += level;
    peak = Math.max(peak, level);
    min = Math.min(min, level);
  }

  const average = total / levels.length;
  const spread = peak - min;
  return clamp(
    ((peak - 0.12) * 1.28)
    + ((average - 0.18) * 0.74)
    + (spread * 1.1),
    SILENT_WAVE_VALUE,
    1,
  );
};

const computeWaveformSample = (
  levels: number[],
  tick: number,
  previous: number,
  paused: boolean,
): number => {
  const safeLevels = levels.length > 0 ? levels : [SILENT_WAVE_VALUE];
  const energy = deriveWaveformEnergy(safeLevels);
  const cursor = tick % safeLevels.length;
  const current = safeLevels[cursor] ?? energy;
  const next = safeLevels[(cursor + 2) % safeLevels.length] ?? current;
  const far = safeLevels[(cursor + 5) % safeLevels.length] ?? next;

  const emphasis = clamp(
    (energy * 1.12)
    + (Math.max(0, current - 0.08) * 0.95)
    + (Math.max(0, next - 0.08) * 0.55)
    + (Math.max(0, far - 0.08) * 0.35),
    SILENT_WAVE_VALUE,
    1,
  );

  const attack = paused ? 0.18 : 0.88;
  const decay = paused ? 0.78 : 0.26;
  const mix = emphasis >= previous ? attack : decay;
  const envelope = previous + ((emphasis - previous) * mix);

  const flutter = paused
    ? 0
    : ((Math.sin((tick * 0.92) + (current * 9)) * 0.05) + (Math.sin((tick * 2.4) + (next * 15)) * 0.026));

  return clamp(envelope + (flutter * Math.max(0.12, envelope)), SILENT_WAVE_VALUE, 1);
};

const buildWaveformPaths = (history: number[]): { fill: string; top: string; bottom: string } => {
  const innerWidth = WAVE_VIEWBOX_WIDTH - (WAVE_HORIZONTAL_PADDING * 2);
  const points = history.map((value, index) => {
    const ratio = history.length === 1 ? 0 : index / (history.length - 1);
    const x = WAVE_HORIZONTAL_PADDING + (ratio * innerWidth);
    const amplitude = WAVE_BASE_AMPLITUDE + (Math.pow(clamp(value, SILENT_WAVE_VALUE, 1), 1.16) * WAVE_MAX_AMPLITUDE);
    return {
      x,
      top: WAVE_CENTER_Y - amplitude,
      bottom: WAVE_CENTER_Y + amplitude,
    };
  });

  const top = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.top.toFixed(2)}`).join(' ');
  const bottomPoints = [...points].reverse();
  const bottom = bottomPoints.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.bottom.toFixed(2)}`).join(' ');
  const fill = `${top} ${bottomPoints.map(point => `L ${point.x.toFixed(2)} ${point.bottom.toFixed(2)}`).join(' ')} Z`;

  return { fill, top, bottom };
};

const buildGridLines = (): { horizontal: string[]; vertical: string[] } => {
  const horizontal = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    const y = 12 + (ratio * (WAVE_VIEWBOX_HEIGHT - 24));
    return `M ${WAVE_HORIZONTAL_PADDING} ${y.toFixed(2)} L ${(WAVE_VIEWBOX_WIDTH - WAVE_HORIZONTAL_PADDING).toFixed(2)} ${y.toFixed(2)}`;
  });

  const vertical = Array.from({ length: 11 }, (_, index) => {
    const ratio = index / 10;
    const x = WAVE_HORIZONTAL_PADDING + (ratio * (WAVE_VIEWBOX_WIDTH - (WAVE_HORIZONTAL_PADDING * 2)));
    return `M ${x.toFixed(2)} 10 L ${x.toFixed(2)} ${(WAVE_VIEWBOX_HEIGHT - 10).toFixed(2)}`;
  });

  return { horizontal, vertical };
};

const PromptVoiceWave: React.FC<{ levels: number[]; paused: boolean }> = ({ levels, paused }) => {
  const fillGradientId = React.useId();
  const strokeGradientId = React.useId();
  const glowId = React.useId();
  const latestLevelsRef = React.useRef(levels);
  const pausedRef = React.useRef(paused);
  const historyRef = React.useRef<number[]>(createWaveformHistory());
  const previousSampleRef = React.useRef(SILENT_WAVE_VALUE);
  const tickRef = React.useRef(0);
  const lastFrameAtRef = React.useRef(0);
  const [history, setHistory] = React.useState<number[]>(() => createWaveformHistory());

  React.useEffect(() => {
    latestLevelsRef.current = levels;
  }, [levels]);

  React.useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  React.useEffect(() => {
    let animationFrame = 0;

    const animate = (timestamp: number) => {
      if (!lastFrameAtRef.current) {
        lastFrameAtRef.current = timestamp;
      }

      if (timestamp - lastFrameAtRef.current >= WAVE_FRAME_MS) {
        lastFrameAtRef.current = timestamp;
        tickRef.current += 1;
        const isPaused = pausedRef.current;

        const nextSample = computeWaveformSample(
          latestLevelsRef.current,
          tickRef.current,
          previousSampleRef.current,
          isPaused,
        );
        previousSampleRef.current = nextSample;

        const nextHistory = [...historyRef.current.slice(1), nextSample];
        historyRef.current = nextHistory;
        setHistory(nextHistory);
      }

      animationFrame = window.requestAnimationFrame(animate);
    };

    animationFrame = window.requestAnimationFrame(animate);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      lastFrameAtRef.current = 0;
    };
  }, []);

  const { fill, top, bottom } = buildWaveformPaths(history);
  const headX = WAVE_VIEWBOX_WIDTH - WAVE_HORIZONTAL_PADDING;
  const grid = buildGridLines();

  return (
    <svg viewBox={`0 0 ${WAVE_VIEWBOX_WIDTH} ${WAVE_VIEWBOX_HEIGHT}`} preserveAspectRatio="none" style={styles.waveSvg} aria-hidden="true">
      <defs>
        <linearGradient id={fillGradientId} x1="0%" x2="100%" y1="0%" y2="0%">
          <stop offset="0%" stopColor="var(--vscode-focusBorder)" stopOpacity={paused ? 0.1 : 0.16} />
          <stop offset="72%" stopColor="var(--vscode-button-background)" stopOpacity={paused ? 0.34 : 0.76} />
          <stop offset="100%" stopColor="var(--vscode-textLink-foreground)" stopOpacity={paused ? 0.48 : 0.92} />
        </linearGradient>
        <linearGradient id={strokeGradientId} x1="0%" x2="100%" y1="0%" y2="0%">
          <stop offset="0%" stopColor="var(--vscode-focusBorder)" stopOpacity={paused ? 0.44 : 0.74} />
          <stop offset="72%" stopColor="var(--vscode-button-background)" stopOpacity="1" />
          <stop offset="100%" stopColor="var(--vscode-textLink-foreground)" stopOpacity={paused ? 0.7 : 1} />
        </linearGradient>
        <filter id={glowId} x="-20%" y="-80%" width="140%" height="260%">
          <feGaussianBlur stdDeviation="2.6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <rect x="0" y="0" width={WAVE_VIEWBOX_WIDTH} height={WAVE_VIEWBOX_HEIGHT} fill="color-mix(in srgb, var(--vscode-input-background) 12%, transparent)" />
      {grid.vertical.map((line, index) => (
        <path key={`grid-v-${index}`} d={line} fill="none" stroke="color-mix(in srgb, var(--vscode-descriptionForeground) 14%, transparent)" strokeWidth="0.8" />
      ))}
      {grid.horizontal.map((line, index) => (
        <path key={`grid-h-${index}`} d={line} fill="none" stroke="color-mix(in srgb, var(--vscode-descriptionForeground) 11%, transparent)" strokeWidth={index === 2 ? 1.1 : 0.8} />
      ))}
      <path d={`M ${WAVE_HORIZONTAL_PADDING} ${WAVE_CENTER_Y} L ${WAVE_VIEWBOX_WIDTH - WAVE_HORIZONTAL_PADDING} ${WAVE_CENTER_Y}`} fill="none" stroke="color-mix(in srgb, var(--vscode-focusBorder) 28%, transparent)" strokeWidth="1" />
      <path d={fill} fill={`url(#${fillGradientId})`} opacity={paused ? 0.38 : 0.96} />
      <path d={top} fill="none" stroke={`url(#${strokeGradientId})`} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" filter={`url(#${glowId})`} opacity={paused ? 0.52 : 1} />
      <path d={bottom} fill="none" stroke={`url(#${strokeGradientId})`} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" filter={`url(#${glowId})`} opacity={paused ? 0.52 : 1} />
      <path d={`M ${headX} 10 L ${headX} ${WAVE_VIEWBOX_HEIGHT - 10}`} fill="none" stroke="color-mix(in srgb, var(--vscode-button-background) 46%, transparent)" strokeWidth="1.2" opacity={paused ? 0.35 : 0.82} />
    </svg>
  );
};

export const PromptVoiceOverlay: React.FC<Props> = ({
  status,
  elapsedLabel,
  maxDurationLabel,
  levels,
  progressMessage,
  progressPercent,
  errorMessage,
  errorBadge,
  errorHint,
  onConfirm,
  onPause,
  onResume,
  onCancel,
  t,
}) => {
  const isPaused = status === 'paused';
  const isRecording = status === 'recording' || status === 'paused';
  const isBusy = status === 'preparing-model' || status === 'processing';
  const isError = status === 'error';

  return (
    <div style={styles.overlay} role="dialog" aria-modal="false" aria-live="polite">
      <div style={styles.header}>
        <div style={styles.titleWrap}>
          <span style={styles.titleIcon}>
            <VoiceIcon path={ICONS.mic} size={16} />
          </span>
          <div style={styles.titleColumn}>
            <strong style={styles.title}>
              {isError
                ? t('editor.voiceErrorTitle')
                : (isBusy ? (progressMessage || t('editor.voiceProcessing')) : t('editor.voiceRecordingTitle'))}
            </strong>
            {isRecording && (
              <span style={styles.subtitle}>{`${elapsedLabel} / ${maxDurationLabel}`}</span>
            )}
            {isBusy && progressPercent !== null && (
              <span style={styles.subtitle}>{`${Math.round(progressPercent)}%`}</span>
            )}
            {isError && (
              <span style={styles.subtitle}>{errorMessage}</span>
            )}
          </div>
        </div>
      </div>

      <div style={styles.body}>
        {isRecording && (
          <div style={styles.waveWrap} aria-hidden="true">
            <PromptVoiceWave levels={levels} paused={isPaused} />
          </div>
        )}

        {isBusy && (
          <div style={styles.processingWrap}>
            <div style={styles.processingSpinner} />
            <div style={styles.processingText}>
              <span>{progressMessage || t('editor.voiceProcessing')}</span>
              <span style={styles.processingDots}>...</span>
            </div>
          </div>
        )}

        {isError && (
          <div style={styles.errorWrap}>
            <div style={styles.errorBadge}>{errorBadge}</div>
            <div style={styles.errorHint}>{errorHint || errorMessage}</div>
          </div>
        )}
      </div>

      <div style={styles.actions}>
        {isRecording && (
          <>
            <VoiceButton label={t('editor.voiceOk')} icon="ok" onClick={onConfirm} variant="primary" />
            {!isPaused && (
              <VoiceButton label={t('editor.voicePause')} icon="pause" onClick={onPause} />
            )}
            {isPaused && (
              <VoiceButton label={t('editor.voiceResume')} icon="record" onClick={onResume} />
            )}
            <VoiceButton label={t('editor.voiceCancel')} icon="cancel" onClick={onCancel} variant="danger" />
          </>
        )}

        {isError && (
          <>
            <VoiceButton label={t('editor.voiceResume')} icon="record" onClick={onResume} variant="primary" />
            <VoiceButton label={t('editor.voiceCancel')} icon="cancel" onClick={onCancel} variant="danger" />
          </>
        )}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'absolute',
    top: '12px',
    left: '12px',
    right: '12px',
    zIndex: 4,
    borderRadius: '14px',
    border: '1px solid color-mix(in srgb, var(--vscode-focusBorder) 70%, transparent)',
    background: 'color-mix(in srgb, var(--vscode-editor-background) 78%, transparent)',
    boxShadow: '0 10px 24px color-mix(in srgb, var(--vscode-widget-shadow, rgba(0,0,0,0.35)) 70%, transparent)',
    backdropFilter: 'blur(12px)',
    padding: '14px 16px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    animation: 'pm-fade-in 0.18s ease-out',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  titleWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  titleIcon: {
    width: '32px',
    height: '32px',
    borderRadius: '999px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'color-mix(in srgb, var(--vscode-focusBorder) 16%, transparent)',
    color: 'var(--vscode-focusBorder)',
    flexShrink: 0,
  },
  titleColumn: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  title: {
    fontSize: '13px',
    fontWeight: 700,
    color: 'var(--vscode-foreground)',
  },
  subtitle: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
  },
  body: {
    minHeight: '82px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  waveWrap: {
    width: '100%',
    minHeight: '84px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '4px 8px',
    borderRadius: '12px',
    overflow: 'hidden',
    background: 'color-mix(in srgb, var(--vscode-input-background) 28%, transparent)',
    border: '1px solid color-mix(in srgb, var(--vscode-input-border, var(--vscode-panel-border)) 40%, transparent)',
    boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--vscode-focusBorder) 12%, transparent)',
  },
  waveSvg: {
    width: '100%',
    height: '84px',
    display: 'block',
  },
  processingWrap: {
    width: '100%',
    minHeight: '58px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '10px',
  },
  processingSpinner: {
    width: '22px',
    height: '22px',
    border: '2px solid color-mix(in srgb, var(--vscode-focusBorder) 30%, transparent)',
    borderTopColor: 'var(--vscode-focusBorder)',
    borderRadius: '50%',
    animation: 'pm-spin 0.8s linear infinite',
  },
  processingText: {
    fontSize: '12px',
    color: 'var(--vscode-foreground)',
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
  },
  processingDots: {
    letterSpacing: '2px',
    animation: 'pm-voice-pulse 1.1s ease-in-out infinite',
  },
  errorWrap: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '8px',
  },
  errorBadge: {
    fontSize: '11px',
    fontWeight: 700,
    color: 'var(--vscode-errorForeground)',
    background: 'color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent)',
    padding: '4px 8px',
    borderRadius: '999px',
  },
  errorHint: {
    fontSize: '12px',
    color: 'var(--vscode-descriptionForeground)',
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '8px',
    flexWrap: 'wrap',
  },
  actionButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    minHeight: '32px',
    padding: '0 12px',
    borderRadius: '999px',
    border: '1px solid color-mix(in srgb, var(--vscode-button-secondaryBackground) 65%, transparent)',
    background: 'color-mix(in srgb, var(--vscode-button-secondaryBackground) 20%, transparent)',
    color: 'var(--vscode-button-secondaryForeground)',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
    whiteSpace: 'nowrap',
  },
  actionButtonPrimary: {
    background: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
    borderColor: 'transparent',
  },
  actionButtonDanger: {
    color: 'var(--vscode-errorForeground)',
    borderColor: 'color-mix(in srgb, var(--vscode-errorForeground) 25%, transparent)',
    background: 'color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent)',
  },
};
