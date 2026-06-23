import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import MarkdownIt from 'markdown-it';

import { detectReportContentMode } from '../../../utils/reportContentMode.js';

type RichTextEditorCommitHandle = () => void;

interface Props {
  value: string;
  onChange: (value: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  onRegisterCommit?: (commit: RichTextEditorCommitHandle | null) => void;
  onDebug?: (message: string, payload?: Record<string, unknown>) => void;
  autoModeKey?: string;
  changeMode?: 'live' | 'blur';
  placeholder?: string;
  t?: (key: string) => string;
  persistedHeight?: number;
  onHeightChange?: (height: number) => void;
  onReset?: () => void;
  canReset?: boolean;
  onOpen?: () => void;
  openLabel?: string;
  openTitle?: string;
  onSecondaryAction?: () => void;
  secondaryActionLabel?: string;
  secondaryActionTitle?: string;
  secondaryActionDisabled?: boolean;
  fillHeight?: boolean;
  autoResize?: boolean;
  suspendAutoResize?: boolean;
  showFormattingToolbar?: boolean;
  contentPadding?: 'default' | 'compact';
}

type Mode = 'visual' | 'html' | 'markdown';
type BlockTag = 'p' | 'h1' | 'h2' | 'h3' | 'blockquote' | 'pre' | '';

interface FormattingState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikeThrough: boolean;
  unorderedList: boolean;
  orderedList: boolean;
  link: boolean;
  block: BlockTag;
}

interface ToolbarButtonProps {
  title: string;
  icon?: keyof typeof ICON_PATHS;
  label?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  wide?: boolean;
  textStyle?: React.CSSProperties;
}

interface ScrollSnapshot {
  top: number;
  left: number;
  reason: string;
  tagName: string;
  element: HTMLElement | null;
  recordedAt: number;
}

interface PendingModeSwitchState {
  from: Mode;
  to: Mode;
  deferredMeasurements: number;
}

type ScrollRestoreResult = 'restored' | 'noop' | 'missing';

export interface RichTextAutoResizeMeasurementStability {
  key: string;
  height: number;
  count: number;
}

export interface RichTextAutoResizeHeightStabilityResult {
  shouldApply: boolean;
  nextPending: RichTextAutoResizeMeasurementStability | null;
  reason: 'apply' | 'unchanged' | 'minor-change' | 'waiting-stable';
}

const DEFAULT_HEIGHT = 180;
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 800;
const AUTO_RESIZE_HEIGHT_PADDING = 2;
const AUTO_RESIZE_HEIGHT_CHANGE_THRESHOLD = 8;
const AUTO_RESIZE_STABLE_MEASUREMENT_COUNT = 2;
const BLUR_COMMIT_DEFER_MS = 120;
const MODE_SWITCH_MIN_UNSTABLE_HEIGHT = MIN_HEIGHT + 24;
const MAX_MODE_SWITCH_DEFERRED_MEASUREMENTS = 2;
const MODE_SWITCH_SCROLL_RESTORE_ATTEMPTS = 4;
const BLUR_SCROLL_RESTORE_ATTEMPTS = 3;
const PAGE_SCROLL_FALLBACK_MAX_AGE_MS = 4000;

// Resolves the effective editor height for manual and automatic sizing modes.
export function resolveRichTextEditorHeight(input: {
  measuredHeight: number;
  autoResize: boolean;
  minHeight?: number;
  maxHeight?: number;
}): number | null {
  const {
    measuredHeight,
    autoResize,
    minHeight = MIN_HEIGHT,
    maxHeight = MAX_HEIGHT,
  } = input;

  if (!Number.isFinite(measuredHeight) || measuredHeight <= 0) {
    return null;
  }

  const paddedHeight = Math.ceil(measuredHeight) + AUTO_RESIZE_HEIGHT_PADDING;
  if (autoResize) {
    return Math.max(minHeight, paddedHeight);
  }

  return Math.max(minHeight, Math.min(maxHeight, paddedHeight));
}

// Filters transient auto-resize measurements that otherwise make the surrounding section jump.
export function resolveRichTextAutoResizeHeightStability(input: {
  currentHeight: number;
  nextHeight: number;
  measurementKey: string;
  pending?: RichTextAutoResizeMeasurementStability | null;
  changeThreshold?: number;
  stableMeasurements?: number;
}): RichTextAutoResizeHeightStabilityResult {
  const changeThreshold = input.changeThreshold ?? AUTO_RESIZE_HEIGHT_CHANGE_THRESHOLD;
  const stableMeasurements = input.stableMeasurements ?? AUTO_RESIZE_STABLE_MEASUREMENT_COUNT;
  const delta = Math.abs(input.currentHeight - input.nextHeight);

  if (delta === 0) {
    return { shouldApply: false, nextPending: null, reason: 'unchanged' };
  }

  if (delta <= changeThreshold) {
    return { shouldApply: false, nextPending: null, reason: 'minor-change' };
  }

  const pending = input.pending || null;
  const isSameMeasurement = Boolean(pending
    && pending.key === input.measurementKey
    && Math.abs(pending.height - input.nextHeight) <= 1);
  const nextPending = {
    key: input.measurementKey,
    height: input.nextHeight,
    count: isSameMeasurement ? (pending?.count || 0) + 1 : 1,
  };

  if (nextPending.count < stableMeasurements) {
    return { shouldApply: false, nextPending, reason: 'waiting-stable' };
  }

  return { shouldApply: true, nextPending: null, reason: 'apply' };
}

// Ignores transient blur events that immediately return focus into the same editor surface.
export function shouldCommitDeferredRichTextBlur(input: {
  activeElementInsideEditor: boolean;
  documentHasFocus: boolean;
}): boolean {
  if (input.activeElementInsideEditor) {
    return false;
  }

  return input.documentHasFocus;
}

// Resolves whether restoring the surrounding page scroll would visibly move the viewport.
export function shouldRestoreRichTextPageScroll(input: {
  currentTop: number;
  savedTop: number;
  currentLeft: number;
  savedLeft: number;
}): boolean {
  return Math.abs(input.currentTop - input.savedTop) > 1
    || Math.abs(input.currentLeft - input.savedLeft) > 1;
}

// Keeps the saved page scroll alive across early no-op restore attempts while layout is still settling.
export function shouldPreserveRichTextPageScrollSnapshotOnNoop(input: {
  snapshotReason: string;
  remainingAttempts: number;
}): boolean {
  if (input.remainingAttempts <= 1) {
    return false;
  }

  return input.snapshotReason === 'mode.switch'
    || input.snapshotReason === 'blur.pointerDown'
    || input.snapshotReason === 'blur.defer'
    || input.snapshotReason === 'blur.immediate';
}

// Retries scroll restoration only while the current attempt was a harmless no-op.
export function shouldRetryRichTextPageScrollRestore(input: {
  restoreResult: ScrollRestoreResult;
  snapshotReason: string;
  remainingAttempts: number;
}): boolean {
  return input.restoreResult === 'noop'
    && shouldPreserveRichTextPageScrollSnapshotOnNoop({
      snapshotReason: input.snapshotReason,
      remainingAttempts: input.remainingAttempts,
    });
}

// Reuses the last stable page scroll only when the current snapshot already collapsed to the top unexpectedly.
export function shouldUseRichTextPageScrollFallback(input: {
  reason: string;
  currentTop: number;
  currentLeft: number;
  lastKnownTop: number | null;
  lastKnownLeft: number | null;
  lastKnownAgeMs: number | null;
}): boolean {
  const supportsFallback = input.reason === 'mode.switch'
    || input.reason === 'blur.pointerDown'
    || input.reason === 'blur.defer'
    || input.reason === 'blur.immediate';

  if (!supportsFallback) {
    return false;
  }

  if (Math.abs(input.currentTop) > 1 || Math.abs(input.currentLeft) > 1) {
    return false;
  }

  if ((input.lastKnownTop ?? 0) <= 1 && Math.abs(input.lastKnownLeft ?? 0) <= 1) {
    return false;
  }

  if (input.lastKnownAgeMs === null) {
    return false;
  }

  return input.lastKnownAgeMs <= PAGE_SCROLL_FALLBACK_MAX_AGE_MS;
}

// Rejects obviously stale first-pass auto-resize measurements after switching editor mode.
export function shouldDeferRichTextModeSwitchAutoResize(input: {
  modeSwitchPending: boolean;
  sourceLength: number;
  currentHeight: number;
  measuredHeight: number;
  deferredMeasurements: number;
}): boolean {
  if (!input.modeSwitchPending) {
    return false;
  }

  if (input.deferredMeasurements >= MAX_MODE_SWITCH_DEFERRED_MEASUREMENTS) {
    return false;
  }

  if (input.sourceLength < 200 || input.currentHeight < 200) {
    return false;
  }

  return input.measuredHeight <= MODE_SWITCH_MIN_UNSTABLE_HEIGHT;
}

// Resolves what should be copied for the currently selected editor mode.
export function resolveRichTextEditorCopyValue(input: {
  mode: Mode;
  rawValue: string;
  visualHtml?: string | null;
  sourceText?: string | null;
}): string {
  if (input.mode === 'visual') {
    return sanitizeHtml(input.visualHtml || input.rawValue || '');
  }

  if (input.mode === 'html') {
    return normalizeText(input.sourceText ?? input.rawValue);
  }

  return normalizeText(input.rawValue);
}

// Writes text into the clipboard from the webview, with a DOM fallback for restricted environments.
const writeTextToClipboard = async (text: string): Promise<boolean> => {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall back to a temporary textarea copy below.
    }
  }

  if (typeof document === 'undefined') {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
};

const markdownRenderer = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
});

const DEFAULT_FORMATTING_STATE: FormattingState = {
  bold: false,
  italic: false,
  underline: false,
  strikeThrough: false,
  unorderedList: false,
  orderedList: false,
  link: false,
  block: '',
};

const ICON_PATHS = {
  discard: 'M12 3a9 9 0 1 0 6.36 2.64l1.42-1.42v4.78H15l1.93-1.93A6 6 0 1 1 12 6v2l-4-3 4-3v1z',
  redo: 'M12 3a9 9 0 1 1-6.36 2.64L4.22 4.22V9h4.78L7.07 7.07A6 6 0 1 0 12 6v2l4-3-4-3v1z',
  quote: 'M6.5 7A3.5 3.5 0 0 0 3 10.5V17h6v-6H6c0-1.38 1.12-2.5 2.5-2.5V7zm8 0A3.5 3.5 0 0 0 11 10.5V17h6v-6h-3c0-1.38 1.12-2.5 2.5-2.5V7z',
  code: 'M9.47 7.47 4.94 12l4.53 4.53-1.41 1.41L2.11 12l5.95-5.94 1.41 1.41zm5.06 0 1.41-1.41L21.89 12l-5.95 5.94-1.41-1.41L19.06 12l-4.53-4.53z',
  bold: 'M8 4h5.5a3.5 3.5 0 0 1 1.81 6.49A4 4 0 0 1 14 18H8V4zm2 2v4h3.5a1.5 1.5 0 0 0 0-3H10zm0 6v4h4a2 2 0 1 0 0-4h-4z',
  italic: 'M10 4v2h2.59l-3.18 8H7v2h7v-2h-2.59l3.18-8H17V4h-7z',
  inlineCode: 'M7.41 12 11 8.41 9.59 7 4.59 12l5 5 1.41-1.41L7.41 12zm9.18 0L13 15.59 14.41 17l5-5-5-5L13 8.41 16.59 12z',
  clearAll: 'M5 5h10l4 4-8.5 8.5a2.12 2.12 0 0 1-3 0L2.5 12.5a2.12 2.12 0 0 1 0-3L5 5zm3.41 4L7 10.41 8.59 12 7 13.59 8.41 15 10 13.41 11.59 15 13 13.59 11.41 12 13 10.41 11.59 9 10 10.59 8.41 9z',
  listUnordered: 'M4 6h2v2H4V6zm4 0h12v2H8V6zm-4 5h2v2H4v-2zm4 0h12v2H8v-2zm-4 5h2v2H4v-2zm4 0h12v2H8v-2z',
  listOrdered: 'M4 6h2v2H4V6zm4 0h12v2H8V6zM4 11h2v2H4v-2zm4 0h12v2H8v-2zM4 16h2v2H4v-2zm4 0h12v2H8v-2z',
  indent: 'M3 6h10v2H3V6zm0 4h6v2H3v-2zm0 4h10v2H3v-2zm12-1 4 3-4 3v-2h-2v-2h2v-2z',
  link: 'M10.59 13.41a1.996 1.996 0 0 1 0-2.82l3.18-3.18a2 2 0 1 1 2.83 2.83l-1.06 1.06 1.41 1.41 1.06-1.06a4 4 0 1 0-5.66-5.66l-3.18 3.18a4 4 0 0 0 5.66 5.66l.53-.53-1.41-1.41-.53.52a1.996 1.996 0 0 1-2.83 0zm2.82-2.82a1.996 1.996 0 0 1 2.82 0 1.996 1.996 0 0 1 0 2.82l-3.18 3.18a2 2 0 1 1-2.83-2.83l1.06-1.06-1.41-1.41-1.06 1.06a4 4 0 1 0 5.66 5.66l3.18-3.18a4 4 0 0 0 0-5.66 4 4 0 0 0-5.66 0l-.53.53 1.41 1.41.53-.52z',
  unlink: 'M6.7 7.3a4 4 0 0 1 5.66 0l.7.7-1.42 1.42-.7-.7a2 2 0 0 0-2.82 2.82l.7.7L7.4 13.66l-.7-.7a4 4 0 0 1 0-5.66zm10.6 9.4a4 4 0 0 1-5.66 0l-.7-.7 1.42-1.42.7.7a2 2 0 1 0 2.82-2.82l-.7-.7 1.42-1.42.7.7a4 4 0 0 1 0 5.66zM5 19.59 19.59 5 21 6.41 6.41 21 5 19.59z',
  ruler: 'M3 11h18v2H3v-2zm2-4h2v3H5V7zm4 0h1v3H9V7zm3 0h2v3h-2V7zm4 0h1v3h-1V7z',
} as const;

const ToolbarIcon: React.FC<{ icon: keyof typeof ICON_PATHS }> = ({ icon }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={styles.formatIcon}>
    <path d={ICON_PATHS[icon]} fill="currentColor" />
  </svg>
);

const ToolbarButton: React.FC<ToolbarButtonProps> = ({
  title,
  icon,
  label,
  active,
  disabled,
  onClick,
  wide,
  textStyle,
}) => (
  <button
    type="button"
    className="pm-rich-toolbar-button"
    style={{
      ...styles.formatBtn,
      ...(wide ? styles.formatBtnWide : null),
      ...(active ? styles.formatBtnActive : null),
      ...(disabled ? styles.formatBtnDisabled : null),
    }}
    title={title}
    aria-label={title}
    aria-pressed={active}
    disabled={disabled}
    onMouseDown={(event) => event.preventDefault()}
    onClick={onClick}
  >
    {icon && <ToolbarIcon icon={icon} />}
    {label && <span style={{ ...styles.formatBtnLabel, ...(textStyle || null) }}>{label}</span>}
  </button>
);

const normalizeText = (value: string): string => value
  .replace(/\r\n?/g, '\n')
  .replace(/[\u2028\u2029]/g, '\n')
  .replace(/[\u00A0\u2007\u202F]/g, ' ')
  .replace(/[\u200B\u2060\uFEFF\u00AD]/g, '')
  .normalize('NFC');

const detectPreferredMode = (value: string): Mode => {
  const detectedMode = detectReportContentMode(value);
  if (detectedMode === 'html') {
    return 'visual';
  }
  if (detectedMode === 'markdown') {
    return 'markdown';
  }
  return 'html';
};

const sanitizeHtml = (rawHtml: string): string => {
  if (!rawHtml.trim()) {
    return '';
  }

  if (typeof DOMParser === 'undefined') {
    return normalizeText(rawHtml);
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(rawHtml, 'text/html');

  const blockedTags = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta']);
  const allowedTags = new Set([
    'p', 'br', 'div', 'span',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'b', 'em', 'i', 'u', 's',
    'code', 'pre', 'blockquote',
    'ul', 'ol', 'li',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'a', 'hr',
  ]);

  const cleanNode = (node: Node): Node | null => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = normalizeText(node.textContent || '');
      return doc.createTextNode(text);
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return null;
    }

    const element = node as HTMLElement;
    const tag = element.tagName.toLowerCase();

    if (blockedTags.has(tag)) {
      return null;
    }

    if (!allowedTags.has(tag)) {
      const fragment = doc.createDocumentFragment();
      for (const child of Array.from(element.childNodes)) {
        const cleaned = cleanNode(child);
        if (cleaned) {
          fragment.appendChild(cleaned);
        }
      }
      return fragment;
    }

    const cleanEl = doc.createElement(tag);

    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value;

      if (name.startsWith('on')) {
        continue;
      }

      if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) {
        continue;
      }

      if (tag === 'a' && name === 'href') {
        cleanEl.setAttribute('href', value.trim());
        cleanEl.setAttribute('target', '_blank');
        cleanEl.setAttribute('rel', 'noopener noreferrer');
        continue;
      }

      if (name === 'colspan' || name === 'rowspan') {
        cleanEl.setAttribute(name, value);
      }
    }

    for (const child of Array.from(element.childNodes)) {
      const cleaned = cleanNode(child);
      if (cleaned) {
        cleanEl.appendChild(cleaned);
      }
    }

    return cleanEl;
  };

  const wrapper = doc.createElement('div');
  for (const child of Array.from(doc.body.childNodes)) {
    const cleaned = cleanNode(child);
    if (cleaned) {
      wrapper.appendChild(cleaned);
    }
  }

  return wrapper.innerHTML.trim();
};

// Reads plain text from a contenteditable source surface while preserving line breaks.
const readPlainTextFromEditableElement = (element: HTMLElement): string => {
  const elementWithInnerText = element as HTMLElement & { innerText?: string };
  const rawText = typeof elementWithInnerText.innerText === 'string'
    ? elementWithInnerText.innerText || ''
    : element.textContent || '';
  return normalizeText(rawText);
};

// Inserts plain text into the active selection without bringing rich HTML into the source editor.
const insertPlainTextIntoSelection = (text: string): boolean => {
  if (!text || typeof document === 'undefined') {
    return false;
  }

  try {
    if (document.execCommand('insertText', false, text)) {
      return true;
    }
  } catch {
    // Fall back to a direct Range insertion when execCommand is unavailable.
  }

  if (typeof window === 'undefined') {
    return false;
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return false;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();

  const textNode = document.createTextNode(text);
  range.insertNode(textNode);

  const nextRange = document.createRange();
  nextRange.setStartAfter(textNode);
  nextRange.collapse(true);
  selection.removeAllRanges();
  selection.addRange(nextRange);
  return true;
};

export const RichTextEditor: React.FC<Props> = ({
  value,
  onChange,
  onFocus,
  onBlur,
  onDirtyChange,
  onRegisterCommit,
  onDebug,
  autoModeKey,
  changeMode = 'live',
  placeholder,
  t,
  persistedHeight,
  onHeightChange,
  onReset,
  canReset,
  onOpen,
  openLabel,
  openTitle,
  onSecondaryAction,
  secondaryActionLabel,
  secondaryActionTitle,
  secondaryActionDisabled,
  fillHeight,
  autoResize = false,
  suspendAutoResize = false,
  showFormattingToolbar,
  contentPadding = 'default',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const lastLocalValueRef = useRef<string | null>(null);
  const lastPropValueRef = useRef(value || '');
  const htmlSourceRef = useRef(value || '');
  const isModeManuallySelectedRef = useRef(false);
  const pendingAutoResizeFrameRef = useRef<number | null>(null);
  const pendingBlurCommitTimerRef = useRef<number | null>(null);
  const pendingBlurRestoreFrameRef = useRef<number | null>(null);
  const pendingModeSwitchRestoreFrameRef = useRef<number | null>(null);
  const pendingPageScrollRestoreRef = useRef<ScrollSnapshot | null>(null);
  const livePageScrollRef = useRef<ScrollSnapshot | null>(null);
  const pendingModeSwitchRef = useRef<PendingModeSwitchState | null>(null);
  const pendingAutoResizeMeasurementRef = useRef<RichTextAutoResizeMeasurementStability | null>(null);
  const pendingLocalCommitRef = useRef(false);
  const [mode, setMode] = useState<Mode>(() => detectPreferredMode(value || ''));
  const [htmlSource, setHtmlSource] = useState(value || '');
  const [formattingState, setFormattingState] = useState<FormattingState>(DEFAULT_FORMATTING_STATE);

  const [currentHeight, setCurrentHeight] = useState(persistedHeight || DEFAULT_HEIGHT);
  const isDragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);
  const isCompactPadding = contentPadding === 'compact';

  useEffect(() => {
    if (typeof persistedHeight === 'number' && persistedHeight > 0) {
      setCurrentHeight(persistedHeight);
    }
  }, [persistedHeight]);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    dragStartY.current = e.clientY;
    dragStartHeight.current = currentHeight;

    const handleMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = ev.clientY - dragStartY.current;
      const newH = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, dragStartHeight.current + delta));
      setCurrentHeight(newH);
    };

    const handleMouseUp = () => {
      isDragging.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [currentHeight]);

  // Persist height on change
  useEffect(() => {
    onHeightChange?.(currentHeight);
  }, [currentHeight, onHeightChange]);

  const resolveNearestScrollContainer = useCallback((): HTMLElement | null => {
    if (typeof window === 'undefined') {
      return null;
    }

    let current = containerRef.current?.parentElement || null;
    while (current) {
      const computedStyle = window.getComputedStyle(current);
      const overflowValue = `${computedStyle.overflow} ${computedStyle.overflowY}`;
      const canScroll = /(auto|scroll|overlay)/.test(overflowValue)
        && current.scrollHeight > current.clientHeight + 1;
      if (canScroll) {
        return current;
      }
      current = current.parentElement;
    }

    if (typeof document === 'undefined') {
      return null;
    }

    const scrollingElement = document.scrollingElement;
    return scrollingElement instanceof HTMLElement ? scrollingElement : null;
  }, []);

  const rememberCurrentScrollContainer = useCallback((reason: string, options?: { preserveZero?: boolean }): ScrollSnapshot | null => {
    const scrollContainer = resolveNearestScrollContainer();
    if (!scrollContainer) {
      return null;
    }

    const top = scrollContainer.scrollTop;
    const left = scrollContainer.scrollLeft;
    if (!options?.preserveZero && Math.abs(top) <= 1 && Math.abs(left) <= 1) {
      return livePageScrollRef.current;
    }

    const snapshot: ScrollSnapshot = {
      top,
      left,
      reason,
      tagName: scrollContainer.tagName,
      element: scrollContainer,
      recordedAt: Date.now(),
    };
    livePageScrollRef.current = snapshot;
    return snapshot;
  }, [resolveNearestScrollContainer]);

  const snapshotNearestScrollContainer = useCallback((reason: string, options?: { preserveExisting?: boolean }) => {
    if (options?.preserveExisting && pendingPageScrollRestoreRef.current) {
      return pendingPageScrollRestoreRef.current;
    }

    const scrollContainer = resolveNearestScrollContainer();
    if (!scrollContainer) {
      return null;
    }

    const currentTop = scrollContainer.scrollTop;
    const currentLeft = scrollContainer.scrollLeft;
    const lastKnownSnapshot = livePageScrollRef.current;
    const lastKnownAgeMs = lastKnownSnapshot ? Date.now() - lastKnownSnapshot.recordedAt : null;
    const fallbackUsed = shouldUseRichTextPageScrollFallback({
      reason,
      currentTop,
      currentLeft,
      lastKnownTop: lastKnownSnapshot?.top ?? null,
      lastKnownLeft: lastKnownSnapshot?.left ?? null,
      lastKnownAgeMs,
    });

    const targetContainer = fallbackUsed && lastKnownSnapshot?.element?.isConnected
      ? lastKnownSnapshot.element
      : scrollContainer;
    const targetTop = fallbackUsed ? (lastKnownSnapshot?.top ?? currentTop) : currentTop;
    const targetLeft = fallbackUsed ? (lastKnownSnapshot?.left ?? currentLeft) : currentLeft;

    const snapshot: ScrollSnapshot = {
      top: targetTop,
      left: targetLeft,
      reason,
      tagName: targetContainer.tagName,
      element: targetContainer,
      recordedAt: Date.now(),
    };
    pendingPageScrollRestoreRef.current = snapshot;
    onDebug?.('pageScroll.snapshot', {
      reason,
      top: snapshot.top,
      left: snapshot.left,
      tagName: snapshot.tagName,
      fallbackUsed,
      liveTop: lastKnownSnapshot?.top ?? null,
      liveTagName: lastKnownSnapshot?.tagName ?? null,
      liveAgeMs: lastKnownAgeMs,
    });
    return snapshot;
  }, [onDebug, resolveNearestScrollContainer]);

  const restoreNearestScrollContainer = useCallback((reason: string, options?: {
    expectedSnapshotReason?: string;
    preserveSnapshotOnNoop?: boolean;
  }): ScrollRestoreResult => {
    const snapshot = pendingPageScrollRestoreRef.current;
    if (!snapshot) {
      return 'missing';
    }

    if (options?.expectedSnapshotReason && snapshot.reason !== options.expectedSnapshotReason) {
      return 'missing';
    }

    const preferredContainer = snapshot.element?.isConnected ? snapshot.element : null;
    const scrollContainer = preferredContainer || resolveNearestScrollContainer();
    if (!scrollContainer) {
      pendingPageScrollRestoreRef.current = null;
      return 'missing';
    }

    if (!shouldRestoreRichTextPageScroll({
      currentTop: scrollContainer.scrollTop,
      savedTop: snapshot.top,
      currentLeft: scrollContainer.scrollLeft,
      savedLeft: snapshot.left,
    })) {
      if (!options?.preserveSnapshotOnNoop) {
        pendingPageScrollRestoreRef.current = null;
      }
      return 'noop';
    }

    scrollContainer.scrollTop = snapshot.top;
    scrollContainer.scrollLeft = snapshot.left;
    pendingPageScrollRestoreRef.current = null;
    livePageScrollRef.current = {
      ...snapshot,
      element: scrollContainer,
      tagName: scrollContainer.tagName,
      reason,
      recordedAt: Date.now(),
    };
    onDebug?.('pageScroll.restore', {
      reason,
      snapshotReason: snapshot.reason,
      top: snapshot.top,
      left: snapshot.left,
      tagName: scrollContainer.tagName,
    });
    return 'restored';
  }, [onDebug, resolveNearestScrollContainer]);

  const clearPendingBlurRestoreFrame = useCallback(() => {
    if (pendingBlurRestoreFrameRef.current !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(pendingBlurRestoreFrameRef.current);
      pendingBlurRestoreFrameRef.current = null;
    }
  }, []);

  const clearPendingModeSwitchRestoreFrame = useCallback(() => {
    if (pendingModeSwitchRestoreFrameRef.current !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(pendingModeSwitchRestoreFrameRef.current);
      pendingModeSwitchRestoreFrameRef.current = null;
    }
  }, []);

  const queueModeSwitchScrollRestore = useCallback((reason: string) => {
    const scheduleAttempt = (remainingAttempts: number) => {
      if (typeof window === 'undefined') {
        restoreNearestScrollContainer(reason, {
          expectedSnapshotReason: 'mode.switch',
        });
        return;
      }

      clearPendingModeSwitchRestoreFrame();
      pendingModeSwitchRestoreFrameRef.current = window.requestAnimationFrame(() => {
        pendingModeSwitchRestoreFrameRef.current = null;
        const snapshotReason = pendingPageScrollRestoreRef.current?.reason;
        if (snapshotReason !== 'mode.switch') {
          return;
        }

        const result = restoreNearestScrollContainer(reason, {
          expectedSnapshotReason: 'mode.switch',
          preserveSnapshotOnNoop: shouldPreserveRichTextPageScrollSnapshotOnNoop({
            snapshotReason,
            remainingAttempts,
          }),
        });
        onDebug?.('mode.switch.restoreAttempt', {
          reason,
          result,
          remainingAttempts,
          mode,
        });

        if (shouldRetryRichTextPageScrollRestore({
          restoreResult: result,
          snapshotReason,
          remainingAttempts,
        })) {
          scheduleAttempt(remainingAttempts - 1);
          return;
        }

        if (result === 'noop' && pendingPageScrollRestoreRef.current?.reason === 'mode.switch') {
          pendingPageScrollRestoreRef.current = null;
        }
      });
    };

    scheduleAttempt(MODE_SWITCH_SCROLL_RESTORE_ATTEMPTS);
  }, [clearPendingModeSwitchRestoreFrame, mode, onDebug, restoreNearestScrollContainer]);

  const queueDeferredBlurScrollRestore = useCallback((reason: string) => {
    const scheduleAttempt = (remainingAttempts: number) => {
      if (typeof window === 'undefined') {
        restoreNearestScrollContainer(reason);
        return;
      }

      clearPendingBlurRestoreFrame();
      pendingBlurRestoreFrameRef.current = window.requestAnimationFrame(() => {
        pendingBlurRestoreFrameRef.current = null;
        const snapshotReason = pendingPageScrollRestoreRef.current?.reason;
        if (
          snapshotReason !== 'blur.pointerDown'
          && snapshotReason !== 'blur.defer'
          && snapshotReason !== 'blur.immediate'
        ) {
          return;
        }

        const result = restoreNearestScrollContainer(reason, {
          preserveSnapshotOnNoop: shouldPreserveRichTextPageScrollSnapshotOnNoop({
            snapshotReason,
            remainingAttempts,
          }),
        });
        if (shouldRetryRichTextPageScrollRestore({
          restoreResult: result,
          snapshotReason,
          remainingAttempts,
        })) {
          scheduleAttempt(remainingAttempts - 1);
          return;
        }

        if (result === 'noop' && pendingPageScrollRestoreRef.current?.reason === snapshotReason) {
          pendingPageScrollRestoreRef.current = null;
        }
      });
    };

    scheduleAttempt(BLUR_SCROLL_RESTORE_ATTEMPTS);
  }, [clearPendingBlurRestoreFrame, restoreNearestScrollContainer]);

  const resolveAutoResizeTarget = useCallback((): HTMLElement | null => {
    if (mode === 'visual') {
      return editorRef.current;
    }
    if (mode === 'html') {
      return sourceRef.current;
    }
    return previewRef.current;
  }, [mode]);

  const syncAutoResizeHeight = useCallback(() => {
    if (fillHeight || !autoResize || suspendAutoResize) {
      return;
    }

    const target = resolveAutoResizeTarget();
    if (!target || !target.isConnected) {
      return;
    }

    // Temporarily reset explicit height so scrollHeight reflects actual content size.
    // Without this, scrollHeight returns max(content, explicit height) and the block
    // can never shrink when content is reduced.
    const previousHeight = target.style.height;
    target.style.height = 'auto';
    const measuredHeight = Math.ceil(target.scrollHeight || 0);
    target.style.height = previousHeight;

    if (measuredHeight <= 0) {
      return;
    }

    const nextHeight = resolveRichTextEditorHeight({
      measuredHeight,
      autoResize,
    });
    if (!nextHeight) {
      return;
    }

    const pendingModeSwitch = pendingModeSwitchRef.current;
    if (shouldDeferRichTextModeSwitchAutoResize({
      modeSwitchPending: pendingModeSwitch?.to === mode,
      sourceLength: htmlSourceRef.current.length,
      currentHeight,
      measuredHeight,
      deferredMeasurements: pendingModeSwitch?.deferredMeasurements ?? 0,
    })) {
      if (pendingModeSwitch) {
        pendingModeSwitch.deferredMeasurements += 1;
      }
      onDebug?.('autoResize.deferUnstableModeSwitchMeasurement', {
        fromMode: pendingModeSwitch?.from || null,
        toMode: pendingModeSwitch?.to || null,
        measuredHeight,
        nextHeight,
        currentHeight,
        sourceLength: htmlSourceRef.current.length,
        attempt: pendingModeSwitch?.deferredMeasurements ?? 0,
      });
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        if (pendingAutoResizeFrameRef.current !== null) {
          window.cancelAnimationFrame(pendingAutoResizeFrameRef.current);
        }
        pendingAutoResizeFrameRef.current = window.requestAnimationFrame(() => {
          pendingAutoResizeFrameRef.current = null;
          syncAutoResizeHeight();
        });
      }
      return;
    }

    const sourceFingerprint = `${htmlSourceRef.current.length}:${htmlSourceRef.current.slice(0, 32)}:${htmlSourceRef.current.slice(-32)}`;
    const measurementKey = [
      mode,
      sourceFingerprint,
      Math.round(containerRef.current?.getBoundingClientRect().width || 0),
    ].join(':');
    const heightStability = resolveRichTextAutoResizeHeightStability({
      currentHeight,
      nextHeight,
      measurementKey,
      pending: pendingAutoResizeMeasurementRef.current,
    });
    pendingAutoResizeMeasurementRef.current = heightStability.nextPending;
    if (!heightStability.shouldApply) {
      if (heightStability.reason === 'waiting-stable'
        && typeof window !== 'undefined'
        && typeof window.requestAnimationFrame === 'function') {
        if (pendingAutoResizeFrameRef.current !== null) {
          window.cancelAnimationFrame(pendingAutoResizeFrameRef.current);
        }
        pendingAutoResizeFrameRef.current = window.requestAnimationFrame(() => {
          pendingAutoResizeFrameRef.current = null;
          syncAutoResizeHeight();
        });
      }
      if ((heightStability.reason === 'unchanged' || heightStability.reason === 'minor-change')
        && pendingModeSwitch?.to === mode) {
        pendingModeSwitchRef.current = null;
      }
      if (heightStability.reason !== 'unchanged') {
        onDebug?.('autoResize.heightSkipped', {
          reason: heightStability.reason,
          previousHeight: currentHeight,
          measuredHeight,
          nextHeight,
          mode,
        });
      }
      return;
    }

    if (currentHeight === nextHeight) {
      if (pendingModeSwitch?.to === mode) {
        pendingModeSwitchRef.current = null;
      }
      return;
    }

    snapshotNearestScrollContainer('autoResize.heightChanged', {
      preserveExisting: pendingPageScrollRestoreRef.current?.reason === 'mode.switch'
        || pendingPageScrollRestoreRef.current?.reason === 'blur.pointerDown',
    });
    onDebug?.('autoResize.heightChanged', {
      previousHeight: currentHeight,
      measuredHeight,
      nextHeight,
      mode,
    });
    if (pendingModeSwitch?.to === mode) {
      pendingModeSwitchRef.current = null;
    }
    setCurrentHeight(nextHeight);
  }, [autoResize, currentHeight, fillHeight, mode, onDebug, resolveAutoResizeTarget, snapshotNearestScrollContainer, suspendAutoResize]);

  // Schedules a single measurement per frame while the layout is stabilizing.
  const scheduleAutoResizeHeightSync = useCallback(() => {
    if (fillHeight || !autoResize || suspendAutoResize) {
      return;
    }

    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      syncAutoResizeHeight();
      return;
    }

    if (pendingAutoResizeFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingAutoResizeFrameRef.current);
    }

    pendingAutoResizeFrameRef.current = window.requestAnimationFrame(() => {
      pendingAutoResizeFrameRef.current = null;
      syncAutoResizeHeight();
    });
  }, [autoResize, fillHeight, suspendAutoResize, syncAutoResizeHeight]);

  useEffect(() => {
    htmlSourceRef.current = htmlSource;
  }, [htmlSource]);

  // Keeps the caller informed only when the local blur draft actually changes state.
  const setPendingLocalCommit = useCallback((nextPending: boolean) => {
    if (pendingLocalCommitRef.current === nextPending) {
      return;
    }

    pendingLocalCommitRef.current = nextPending;
    onDirtyChange?.(nextPending);
  }, [onDirtyChange]);

  const clearPendingBlurCommit = useCallback(() => {
    if (pendingBlurCommitTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(pendingBlurCommitTimerRef.current);
      pendingBlurCommitTimerRef.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    if (pendingPageScrollRestoreRef.current?.reason !== 'autoResize.heightChanged') {
      return;
    }
    restoreNearestScrollContainer('autoResize.layout');
  }, [currentHeight, restoreNearestScrollContainer]);

  useEffect(() => {
    return () => {
      if (pendingAutoResizeFrameRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(pendingAutoResizeFrameRef.current);
      }
      if (pendingBlurCommitTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(pendingBlurCommitTimerRef.current);
      }
      if (pendingBlurRestoreFrameRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(pendingBlurRestoreFrameRef.current);
      }
      if (pendingModeSwitchRestoreFrameRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(pendingModeSwitchRestoreFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const handlePointerDownCapture = (event: PointerEvent) => {
      const activeElement = document.activeElement;
      if (!containerRef.current || !(activeElement instanceof Node) || !containerRef.current.contains(activeElement)) {
        return;
      }

      const target = event.target;
      if (target instanceof Node && containerRef.current.contains(target)) {
        return;
      }

      snapshotNearestScrollContainer('blur.pointerDown', { preserveExisting: true });
    };

    document.addEventListener('pointerdown', handlePointerDownCapture, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDownCapture, true);
    };
  }, [snapshotNearestScrollContainer]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const handleTrackedScroll = () => {
      const activeElement = document.activeElement;
      const shouldTrack = Boolean(
        containerRef.current
        && ((activeElement instanceof Node && containerRef.current.contains(activeElement))
          || pendingLocalCommitRef.current),
      );
      if (!shouldTrack) {
        return;
      }

      rememberCurrentScrollContainer('scroll');
    };

    document.addEventListener('scroll', handleTrackedScroll, true);
    return () => {
      document.removeEventListener('scroll', handleTrackedScroll, true);
    };
  }, [rememberCurrentScrollContainer]);

  useEffect(() => {
    const nextValue = value || '';

    onDebug?.('propValue.received', {
      nextLength: nextValue.length,
      lastLocalLength: lastLocalValueRef.current?.length ?? null,
      mode,
      autoModeKey: autoModeKey || '',
      changeMode,
      hasPendingLocalCommit: pendingLocalCommitRef.current,
    });

    if (changeMode === 'blur' && pendingLocalCommitRef.current) {
      if (nextValue === htmlSourceRef.current) {
        lastPropValueRef.current = nextValue;
        setPendingLocalCommit(false);
      } else {
        onDebug?.('propValue.skipPendingLocalDraft', {
          nextLength: nextValue.length,
          draftLength: htmlSourceRef.current.length,
          mode,
        });
        return;
      }
    }

    setHtmlSource(nextValue);
    lastPropValueRef.current = nextValue;

    if (lastLocalValueRef.current === nextValue) {
      onDebug?.('propValue.skipSameAsLocal', {
        nextLength: nextValue.length,
        mode,
      });
      return;
    }

    if (!isModeManuallySelectedRef.current) {
      setMode(detectPreferredMode(nextValue));
    }
  }, [changeMode, value]);

  useEffect(() => {
    lastLocalValueRef.current = null;
    lastPropValueRef.current = value || '';
    isModeManuallySelectedRef.current = false;
    setPendingLocalCommit(false);
    onDebug?.('autoModeKey.reset', {
      autoModeKey: autoModeKey || '',
      valueLength: (value || '').length,
    });
    setMode(detectPreferredMode(value || ''));
  }, [autoModeKey]);

  const translate = useCallback((key: string, fallback: string) => t?.(key) || fallback, [t]);

  const markdownPreviewHtml = useMemo(() => {
    const rendered = markdownRenderer.render(htmlSource || '').trim();
    return sanitizeHtml(rendered);
  }, [htmlSource]);

  const switchMode = useCallback((nextMode: Mode) => {
    isModeManuallySelectedRef.current = true;
    setMode(nextMode);
  }, []);

  const preventToolbarBlur = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
  }, []);

  const syncFormattingState = useCallback(() => {
    if (!showFormattingToolbar || mode !== 'visual' || !editorRef.current) {
      setFormattingState(DEFAULT_FORMATTING_STATE);
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      setFormattingState(DEFAULT_FORMATTING_STATE);
      return;
    }

    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (
      (anchorNode && !editorRef.current.contains(anchorNode)) ||
      (focusNode && !editorRef.current.contains(focusNode))
    ) {
      setFormattingState(DEFAULT_FORMATTING_STATE);
      return;
    }

    const readState = (command: string): boolean => {
      try {
        return document.queryCommandState(command);
      } catch {
        return false;
      }
    };

    let block: BlockTag = '';
    try {
      const rawBlock = String(document.queryCommandValue('formatBlock') || '')
        .toLowerCase()
        .replace(/[<>]/g, '') as BlockTag;
      if (['p', 'h1', 'h2', 'h3', 'blockquote', 'pre'].includes(rawBlock)) {
        block = rawBlock;
      }
    } catch {
      block = '';
    }

    setFormattingState({
      bold: readState('bold'),
      italic: readState('italic'),
      underline: readState('underline'),
      strikeThrough: readState('strikeThrough'),
      unorderedList: readState('insertUnorderedList'),
      orderedList: readState('insertOrderedList'),
      link: readState('createLink'),
      block,
    });
  }, [mode, showFormattingToolbar]);

  useEffect(() => {
    if (mode !== 'visual' || !editorRef.current) {
      return;
    }

    // Skip DOM update while user is actively editing — the DOM already has
    // the latest content and overwriting innerHTML would destroy cursor position
    // and selection, making editing painful (especially during auto-save).
    if (document.activeElement === editorRef.current && document.hasFocus()) {
      onDebug?.('domSync.skipFocused', {
        incomingLength: (value || '').length,
        domLength: editorRef.current.innerHTML.length,
        mode,
      });
      return;
    }

    const sanitized = sanitizeHtml(value || '');
    if (editorRef.current.innerHTML !== sanitized) {
      onDebug?.('domSync.apply', {
        incomingLength: sanitized.length,
        previousDomLength: editorRef.current.innerHTML.length,
        mode,
      });
      editorRef.current.innerHTML = sanitized;
    } else {
      onDebug?.('domSync.noop', {
        incomingLength: sanitized.length,
        domLength: editorRef.current.innerHTML.length,
        mode,
      });
    }
  }, [mode, onDebug, value]);

  useEffect(() => {
    if (mode !== 'html' || !sourceRef.current) {
      return;
    }

    if (document.activeElement === sourceRef.current && document.hasFocus()) {
      onDebug?.('sourceDomSync.skipFocused', {
        incomingLength: htmlSource.length,
        domLength: readPlainTextFromEditableElement(sourceRef.current).length,
        mode,
      });
      return;
    }

    const normalizedSource = normalizeText(htmlSource);
    const currentSource = readPlainTextFromEditableElement(sourceRef.current);
    if (currentSource !== normalizedSource) {
      onDebug?.('sourceDomSync.apply', {
        incomingLength: normalizedSource.length,
        previousDomLength: currentSource.length,
        mode,
      });
      sourceRef.current.textContent = normalizedSource;
    } else {
      onDebug?.('sourceDomSync.noop', {
        incomingLength: normalizedSource.length,
        domLength: currentSource.length,
        mode,
      });
    }
  }, [htmlSource, mode, onDebug]);

  useEffect(() => {
    // Wait for DOM updates before measuring content-driven height.
    scheduleAutoResizeHeightSync();
  }, [htmlSource, markdownPreviewHtml, mode, scheduleAutoResizeHeightSync, value]);

  useEffect(() => {
    if (fillHeight || !autoResize || suspendAutoResize) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    // Recalculate height when the available width changes and line wrapping shifts.
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        scheduleAutoResizeHeightSync();
      });
      observer.observe(container);
      return () => observer.disconnect();
    }

    if (typeof window === 'undefined') {
      return;
    }

    const handleWindowResize = () => {
      scheduleAutoResizeHeightSync();
    };
    window.addEventListener('resize', handleWindowResize);

    return () => {
      window.removeEventListener('resize', handleWindowResize);
    };
  }, [autoResize, fillHeight, scheduleAutoResizeHeightSync, suspendAutoResize]);

  useEffect(() => {
    if (!showFormattingToolbar) {
      return;
    }

    const handleSelectionChange = () => {
      syncFormattingState();
    };

    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
  }, [showFormattingToolbar, syncFormattingState]);

  const insertHtmlAtCursor = useCallback((html: string) => {
    if (!editorRef.current) {
      return;
    }

    editorRef.current.focus();

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      editorRef.current.innerHTML += html;
      return;
    }

    const range = selection.getRangeAt(0);
    range.deleteContents();

    const fragment = range.createContextualFragment(html);
    const lastNode = fragment.lastChild;
    range.insertNode(fragment);

    if (lastNode) {
      const newRange = document.createRange();
      newRange.setStartAfter(lastNode);
      newRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(newRange);
    }
  }, []);

  // Applies a local editor value and only commits upstream when the selected mode requires it.
  const applyNextValue = useCallback((nextValue: string, options: { commit?: boolean } = {}) => {
    lastLocalValueRef.current = nextValue;
    setHtmlSource(nextValue);

    if (changeMode === 'blur' && !options.commit) {
      setPendingLocalCommit(nextValue !== lastPropValueRef.current);
      return;
    }

    lastPropValueRef.current = nextValue;
    setPendingLocalCommit(false);
    onChange(nextValue);
  }, [changeMode, onChange, setPendingLocalCommit]);

  const syncFromEditor = useCallback((options: { commit?: boolean } = {}) => {
    if (!editorRef.current) {
      return;
    }

    const sanitized = sanitizeHtml(editorRef.current.innerHTML);
    onDebug?.('visual.syncFromEditor', {
      domLength: editorRef.current.innerHTML.length,
      sanitizedLength: sanitized.length,
      mode,
      commit: options.commit === true,
      changeMode,
    });
    applyNextValue(sanitized, options);
  }, [applyNextValue, changeMode, mode, onDebug]);

  const syncFromSourceEditor = useCallback((options: { commit?: boolean } = {}) => {
    if (!sourceRef.current) {
      return;
    }

    const nextValue = readPlainTextFromEditableElement(sourceRef.current);
    onDebug?.('text.syncFromSourceSurface', {
      nextLength: nextValue.length,
      previousLength: htmlSource.length,
      mode,
      changeMode,
      commit: options.commit === true,
    });
    applyNextValue(nextValue, options);
  }, [applyNextValue, changeMode, htmlSource.length, mode, onDebug]);

  // Flushes a pending blur draft when the user leaves the editor surface.
  const commitPendingValue = useCallback(() => {
    if (!pendingLocalCommitRef.current) {
      return;
    }

    applyNextValue(htmlSourceRef.current, { commit: true });
  }, [applyNextValue]);

  const executeEditorCommand = useCallback((command: string, commandValue?: string) => {
    if (mode !== 'visual' || !editorRef.current) {
      return;
    }

    editorRef.current.focus();
    document.execCommand(command, false, commandValue);
    syncFromEditor();
    syncFormattingState();
  }, [mode, syncFormattingState, syncFromEditor]);

  const applyBlockFormat = useCallback((tag: Exclude<BlockTag, ''>) => {
    executeEditorCommand('formatBlock', tag);
  }, [executeEditorCommand]);

  const handleCreateLink = useCallback(() => {
    const rawUrl = window.prompt(translate('editor.formatLinkPrompt', 'Введите адрес ссылки'), 'https://');
    if (!rawUrl) {
      return;
    }

    const trimmed = rawUrl.trim();
    if (!trimmed) {
      return;
    }

    const normalizedUrl = /^[a-z]+:/i.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('#')
      ? trimmed
      : `https://${trimmed}`;

    executeEditorCommand('createLink', normalizedUrl);
  }, [executeEditorCommand, translate]);

  const handleClearFormatting = useCallback(() => {
    executeEditorCommand('removeFormat');
    executeEditorCommand('unlink');
  }, [executeEditorCommand]);

  const wrapSelectionWithHtml = useCallback((before: string, after: string, placeholder: string) => {
    if (mode !== 'visual' || !editorRef.current) {
      return;
    }

    editorRef.current.focus();
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      insertHtmlAtCursor(`${before}${placeholder}${after}`);
      syncFromEditor();
      syncFormattingState();
      return;
    }

    const range = selection.getRangeAt(0);
    const wrapper = document.createElement('div');
    wrapper.appendChild(range.cloneContents());
    const selectedHtml = wrapper.innerHTML.trim();
    const html = `${before}${selectedHtml || placeholder}${after}`;

    range.deleteContents();
    const fragment = range.createContextualFragment(html);
    const lastNode = fragment.lastChild;
    range.insertNode(fragment);

    if (lastNode) {
      const nextRange = document.createRange();
      nextRange.setStartAfter(lastNode);
      nextRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(nextRange);
    }

    syncFromEditor();
    syncFormattingState();
  }, [insertHtmlAtCursor, mode, syncFormattingState, syncFromEditor]);

  const handleInlineCode = useCallback(() => {
    wrapSelectionWithHtml('<code>', '</code>', 'code');
  }, [wrapSelectionWithHtml]);

  const handleCodeBlock = useCallback(() => {
    wrapSelectionWithHtml('<pre><code>', '</code></pre>', 'code');
  }, [wrapSelectionWithHtml]);

  const handleUnlink = useCallback(() => {
    executeEditorCommand('unlink');
  }, [executeEditorCommand]);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    if (mode !== 'visual') {
      return;
    }

    const html = e.clipboardData.getData('text/html');
    const markdown = e.clipboardData.getData('text/markdown') || e.clipboardData.getData('text/x-markdown');
    const plain = e.clipboardData.getData('text/plain');

    let payload = '';
    if (html.trim()) {
      payload = sanitizeHtml(html);
    } else if (markdown.trim()) {
      payload = `<pre><code>${normalizeText(markdown)}</code></pre>`;
    } else if (plain.trim()) {
      payload = `<p>${normalizeText(plain).replace(/\n/g, '<br/>')}</p>`;
    }

    if (!payload) {
      return;
    }

    e.preventDefault();
    insertHtmlAtCursor(payload);
    syncFromEditor();
  }, [insertHtmlAtCursor, mode, syncFromEditor]);

  const handleSourcePaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    if (mode !== 'html') {
      return;
    }

    const plain = normalizeText(e.clipboardData.getData('text/plain') || '');
    if (!plain) {
      return;
    }

    e.preventDefault();
    if (!insertPlainTextIntoSelection(plain) && sourceRef.current) {
      const currentValue = readPlainTextFromEditableElement(sourceRef.current);
      sourceRef.current.textContent = `${currentValue}${plain}`;
    }
    syncFromSourceEditor();
  }, [mode, syncFromSourceEditor]);

  const handleCopyCurrentMode = useCallback(async () => {
    const copyValue = resolveRichTextEditorCopyValue({
      mode,
      rawValue: htmlSource,
      visualHtml: editorRef.current?.innerHTML || null,
      sourceText: sourceRef.current ? readPlainTextFromEditableElement(sourceRef.current) : null,
    });

    const copied = await writeTextToClipboard(copyValue);
    onDebug?.('copy.currentMode', {
      mode,
      copied,
      length: copyValue.length,
    });
  }, [htmlSource, mode, onDebug]);

  // Commits a pending blur draft before delegating to external button actions.
  const flushPendingValue = useCallback(() => {
    if (changeMode === 'blur') {
      commitPendingValue();
    }
  }, [changeMode, commitPendingValue]);

  // Expose the blur-mode commit hook so parent save actions include the latest local draft.
  useEffect(() => {
    onRegisterCommit?.(flushPendingValue);
    return () => onRegisterCommit?.(null);
  }, [flushPendingValue, onRegisterCommit]);

  const startModeSwitch = useCallback((nextMode: Mode) => {
    if (nextMode === mode) {
      return;
    }

    clearPendingBlurCommit();
    clearPendingModeSwitchRestoreFrame();
    snapshotNearestScrollContainer('mode.switch');
    pendingModeSwitchRef.current = {
      from: mode,
      to: nextMode,
      deferredMeasurements: 0,
    };
    onDebug?.('mode.switch.start', {
      fromMode: mode,
      toMode: nextMode,
      currentHeight,
      sourceLength: htmlSourceRef.current.length,
    });
    flushPendingValue();
    switchMode(nextMode);
    queueModeSwitchScrollRestore('mode.switch.raf');
  }, [clearPendingBlurCommit, clearPendingModeSwitchRestoreFrame, currentHeight, flushPendingValue, mode, onDebug, queueModeSwitchScrollRestore, snapshotNearestScrollContainer, switchMode]);

  const handleEditorFocus = useCallback(() => {
    clearPendingBlurCommit();
    clearPendingBlurRestoreFrame();
    clearPendingModeSwitchRestoreFrame();
    rememberCurrentScrollContainer('focus', { preserveZero: true });
    restoreNearestScrollContainer('focus');
    onFocus?.();
  }, [clearPendingBlurCommit, clearPendingBlurRestoreFrame, clearPendingModeSwitchRestoreFrame, onFocus, rememberCurrentScrollContainer, restoreNearestScrollContainer]);

  const handleEditorBlur = useCallback((event: React.FocusEvent<HTMLDivElement | HTMLTextAreaElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && containerRef.current?.contains(nextTarget)) {
      onDebug?.('blur.skipInternalFocusMove', {
        mode,
        changeMode,
      });
      return;
    }

    if (nextTarget) {
      snapshotNearestScrollContainer('blur.immediate', { preserveExisting: true });
      onDebug?.('blur.commitImmediate', {
        mode,
        changeMode,
      });
      flushPendingValue();
      onBlur?.();
      queueDeferredBlurScrollRestore('blur.commitImmediate');
      return;
    }

    clearPendingBlurCommit();
    snapshotNearestScrollContainer('blur.defer', { preserveExisting: true });
    onDebug?.('blur.defer', {
      mode,
      changeMode,
      delayMs: BLUR_COMMIT_DEFER_MS,
    });

    if (typeof window === 'undefined') {
      flushPendingValue();
      onBlur?.();
      restoreNearestScrollContainer('blur.deferImmediate');
      return;
    }

    pendingBlurCommitTimerRef.current = window.setTimeout(() => {
      pendingBlurCommitTimerRef.current = null;
      const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
      const activeElementInsideEditor = Boolean(
        containerRef.current
        && activeElement
        && containerRef.current.contains(activeElement),
      );
      const documentHasFocus = typeof document === 'undefined' || typeof document.hasFocus !== 'function'
        ? true
        : document.hasFocus();

      if (!shouldCommitDeferredRichTextBlur({ activeElementInsideEditor, documentHasFocus })) {
        onDebug?.('blur.cancelDeferred', {
          mode,
          changeMode,
          activeElementInsideEditor,
          documentHasFocus,
        });
        queueDeferredBlurScrollRestore('blur.cancelDeferred');
        return;
      }

      onDebug?.('blur.commitDeferred', {
        mode,
        changeMode,
        activeElementInsideEditor,
        documentHasFocus,
      });
      flushPendingValue();
      onBlur?.();
      queueDeferredBlurScrollRestore('blur.commitDeferred');
    }, BLUR_COMMIT_DEFER_MS);
  }, [changeMode, clearPendingBlurCommit, flushPendingValue, mode, onBlur, onDebug, queueDeferredBlurScrollRestore, restoreNearestScrollContainer, snapshotNearestScrollContainer]);

  const modeHint = useMemo(() => {
    if (mode === 'visual') {
      return translate('editor.modeHintHtml', 'Html mode shows the rendered result with formatting, lists and tables.');
    }
    if (mode === 'markdown') {
      return translate('editor.modeHintMarkdown', 'Markdown mode shows the rendered Markdown preview. Switch to Text mode to edit the source.');
    }
    return translate('editor.modeHintText', 'Text mode shows the raw report content without visual rendering.');
  }, [mode, translate]);

  return (
    <div
      ref={containerRef}
      style={{ ...styles.root, ...(fillHeight ? styles.rootFillHeight : null) }}
    >
      <style>
        {`
          .pm-rich-editor-content,
          .pm-rich-markdown-preview,
          .pm-rich-source-editor {
            /*--pm-rich-surface: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-input-background) 10%);*/
            --pm-rich-border: color-mix(in srgb, var(--vscode-panel-border, rgba(128,128,128,0.35)) 88%, transparent);
            --pm-rich-border-strong: color-mix(in srgb, var(--vscode-panel-border, rgba(128,128,128,0.35)) 100%, black 6%);
            --pm-rich-muted: var(--vscode-descriptionForeground);
            --pm-rich-code-bg: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
            max-width: 980px;
            margin: 0 auto;
            padding: 6px 0;
            font-size: 14px;
            line-height: 1.72;
            color: var(--vscode-foreground);
          }

          .pm-rich-editor-content *,
          .pm-rich-markdown-preview *,
          .pm-rich-source-editor * {
            box-sizing: border-box;
          }

          .pm-rich-source-editor {
            white-space: pre-wrap;
            word-break: break-word;
            overflow-wrap: anywhere;
          }

          .pm-rich-source-editor[data-empty="true"]::before {
            content: attr(data-placeholder);
            color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground));
            pointer-events: none;
          }

          .pm-rich-editor-content > :first-child,
          .pm-rich-markdown-preview > :first-child {
            margin-top: 0;
          }

          .pm-rich-editor-content > :last-child,
          .pm-rich-markdown-preview > :last-child {
            margin-bottom: 0;
          }

          .pm-rich-editor-content p,
          .pm-rich-markdown-preview p {
            margin: 0 0 1em;
          }

          .pm-rich-editor-content h1,
          .pm-rich-editor-content h2,
          .pm-rich-editor-content h3,
          .pm-rich-editor-content h4,
          .pm-rich-editor-content h5,
          .pm-rich-editor-content h6,
          .pm-rich-markdown-preview h1,
          .pm-rich-markdown-preview h2,
          .pm-rich-markdown-preview h3,
          .pm-rich-markdown-preview h4,
          .pm-rich-markdown-preview h5,
          .pm-rich-markdown-preview h6 {
            margin: 1.3em 0 0.55em;
            line-height: 1.2;
            font-weight: 700;
            letter-spacing: -0.02em;
          }

          .pm-rich-editor-content h1,
          .pm-rich-markdown-preview h1 {
            font-size: 2em;
          }

          .pm-rich-editor-content h2,
          .pm-rich-markdown-preview h2 {
            font-size: 1.55em;
          }

          .pm-rich-editor-content h3,
          .pm-rich-markdown-preview h3 {
            font-size: 1.2em;
          }

          .pm-rich-editor-content h4,
          .pm-rich-markdown-preview h4 {
            font-size: 1.05em;
          }

          .pm-rich-editor-content ul,
          .pm-rich-editor-content ol,
          .pm-rich-markdown-preview ul,
          .pm-rich-markdown-preview ol {
            margin: 0 0 1em;
            padding-left: 1.7em;
            list-style-position: outside;
          }

          .pm-rich-editor-content ul,
          .pm-rich-markdown-preview ul {
            list-style-type: disc;
          }

          .pm-rich-editor-content ol,
          .pm-rich-markdown-preview ol {
            list-style-type: decimal;
          }

          .pm-rich-editor-content li,
          .pm-rich-markdown-preview li {
            margin: 0.18em 0;
          }

          .pm-rich-editor-content li > ul,
          .pm-rich-editor-content li > ol,
          .pm-rich-markdown-preview li > ul,
          .pm-rich-markdown-preview li > ol {
            margin-top: 0.35em;
            margin-bottom: 0.35em;
          }

          .pm-rich-editor-content code,
          .pm-rich-markdown-preview code {
            font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
            font-size: 0.92em;
            background: var(--pm-rich-code-bg);
            padding: 0.12em 0.38em;
            border-radius: 6px;
          }

          .pm-rich-editor-content pre,
          .pm-rich-markdown-preview pre {
            margin: 0 0 1.1em;
            padding: 16px 18px;
            background: var(--pm-rich-code-bg);
            border: 1px solid var(--pm-rich-border);
            border-radius: 12px;
            overflow-x: auto;
            line-height: 1.55;
          }

          .pm-rich-editor-content pre code,
          .pm-rich-markdown-preview pre code {
            background: none;
            padding: 0;
            border-radius: 0;
            font-size: var(--vscode-editor-font-size, 12px);
          }

          .pm-rich-editor-content blockquote,
          .pm-rich-markdown-preview blockquote {
            margin: 0 0 1.1em;
            padding: 12px 16px;
            border-left: 4px solid var(--vscode-textBlockQuote-border, var(--vscode-focusBorder));
            border-radius: 0 10px 10px 0;
            background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-input-background) 12%);
            color: var(--pm-rich-muted);
          }

          .pm-rich-editor-content a,
          .pm-rich-markdown-preview a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
          }

          .pm-rich-editor-content a:hover,
          .pm-rich-markdown-preview a:hover {
            text-decoration: underline;
          }

          .pm-rich-editor-content hr,
          .pm-rich-markdown-preview hr {
            border: none;
            border-top: 1px solid var(--pm-rich-border);
            margin: 1.4em 0;
          }

          .pm-rich-editor-content table,
          .pm-rich-markdown-preview table {
            width: 100%;
            border-collapse: separate;
            border-spacing: 0;
            margin: 0 0 1.2em;
            background: var(--pm-rich-surface);
            border: 1px solid var(--pm-rich-border);
            border-radius: 12px;
            overflow: hidden;
          }

          .pm-rich-editor-content th,
          .pm-rich-editor-content td,
          .pm-rich-markdown-preview th,
          .pm-rich-markdown-preview td {
            border-bottom: 1px solid var(--pm-rich-border);
            padding: 12px 14px;
            text-align: left;
            vertical-align: top;
          }

          .pm-rich-editor-content tbody tr:last-child td,
          .pm-rich-markdown-preview tbody tr:last-child td {
            border-bottom: none;
          }

          .pm-rich-editor-content th,
          .pm-rich-markdown-preview th {
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 0.05em;
            text-transform: uppercase;
            /*background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-input-background) 18%);*/
            background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
            border-bottom: 1px solid var(--pm-rich-border-strong);
          }

          .pm-rich-editor-content tbody tr:nth-child(even) td,
          .pm-rich-markdown-preview tbody tr:nth-child(even) td {
            /*background: color-mix(in srgb, var(--vscode-editor-background) 94%, white 6%);*/
            background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
          }

          .pm-rich-editor-content strong,
          .pm-rich-editor-content b {
            font-weight: 600;
          }

          .pm-rich-markdown-preview strong,
          .pm-rich-markdown-preview b {
            font-weight: 600;
          }

          .pm-rich-toolbar-button:hover:not(:disabled) {
            color: var(--vscode-foreground);
            background: var(--vscode-list-hoverBackground);
          }

          .pm-rich-toolbar-button:disabled {
            opacity: 0.45;
          }
        `}
      </style>
      <div style={styles.toolbar}>
        <div style={styles.modeGroup}>
          <button
            type="button"
            style={{ ...styles.modeBtn, ...(mode === 'html' ? styles.modeBtnActive : null) }}
            onMouseDown={preventToolbarBlur}
            onClick={() => startModeSwitch('html')}
          >
            {translate('editor.modeText', 'Text')}
          </button>
          <button
            type="button"
            style={{ ...styles.modeBtn, ...(mode === 'visual' ? styles.modeBtnActive : null) }}
            onMouseDown={preventToolbarBlur}
            onClick={() => startModeSwitch('visual')}
          >
            {translate('editor.modeHtml', 'Html')}
          </button>
          <button
            type="button"
            style={{ ...styles.modeBtn, ...(mode === 'markdown' ? styles.modeBtnActive : null) }}
            onMouseDown={preventToolbarBlur}
            onClick={() => startModeSwitch('markdown')}
          >
            {translate('editor.modeMarkdown', 'Markdown')}
          </button>
        </div>
        <div style={styles.actionGroup}>
          <button
            type="button"
            style={styles.linkBtn}
            onMouseDown={preventToolbarBlur}
            onClick={() => {
              void handleCopyCurrentMode();
            }}
            title={translate('editor.copyModeTitle', 'Копировать содержимое текущего режима')}
          >
            {`📋 ${translate('editor.copyMode', 'Копировать')}`}
          </button>
          {onOpen && (
            <button
              type="button"
              style={styles.linkBtn}
              onMouseDown={preventToolbarBlur}
              onClick={() => {
                flushPendingValue();
                onOpen();
              }}
              title={openTitle || openLabel || 'Открыть'}
            >
              {`📝 ${openLabel || 'Открыть'}`}
            </button>
          )}
          {onSecondaryAction && secondaryActionLabel && (
            <button
              type="button"
              style={{ ...styles.linkBtn, ...(secondaryActionDisabled ? styles.linkBtnDisabled : null) }}
              onMouseDown={preventToolbarBlur}
              onClick={() => {
                flushPendingValue();
                onSecondaryAction();
              }}
              title={secondaryActionTitle || secondaryActionLabel}
              disabled={secondaryActionDisabled}
            >
              {`✨ ${secondaryActionLabel}`}
            </button>
          )}
          {canReset && onReset && (
            <button
              type="button"
              style={styles.resetBtn}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setPendingLocalCommit(false);
                onReset();
              }}
              title="Очистить отчет"
            >
              ↺ Сбросить
            </button>
          )}
        </div>
      </div>

      {showFormattingToolbar && (
        <div style={styles.formatToolbarContainer}>
          <div style={styles.formatToolbar}>
            <div style={styles.formatGroup}>
              <ToolbarButton
                title={translate('editor.formatUndo', 'Отменить')}
                icon="discard"
                disabled={mode !== 'visual'}
                onClick={() => executeEditorCommand('undo')}
              />
              <ToolbarButton
                title={translate('editor.formatRedo', 'Повторить')}
                icon="redo"
                disabled={mode !== 'visual'}
                onClick={() => executeEditorCommand('redo')}
              />
            </div>

            <div style={styles.formatDivider} />

            <div style={styles.formatGroup}>
              <ToolbarButton
                title={translate('editor.formatParagraph', 'Абзац')}
                label="P"
                active={formattingState.block === 'p'}
                disabled={mode !== 'visual'}
                onClick={() => applyBlockFormat('p')}
                wide
              />
              <ToolbarButton
                title={translate('editor.formatHeading1', 'Заголовок 1')}
                label="H1"
                active={formattingState.block === 'h1'}
                disabled={mode !== 'visual'}
                onClick={() => applyBlockFormat('h1')}
                wide
              />
              <ToolbarButton
                title={translate('editor.formatHeading2', 'Заголовок 2')}
                label="H2"
                active={formattingState.block === 'h2'}
                disabled={mode !== 'visual'}
                onClick={() => applyBlockFormat('h2')}
                wide
              />
              <ToolbarButton
                title={translate('editor.formatHeading3', 'Заголовок 3')}
                label="H3"
                active={formattingState.block === 'h3'}
                disabled={mode !== 'visual'}
                onClick={() => applyBlockFormat('h3')}
                wide
              />
              <ToolbarButton
                title={translate('editor.formatQuote', 'Цитата')}
                icon="quote"
                active={formattingState.block === 'blockquote'}
                disabled={mode !== 'visual'}
                onClick={() => applyBlockFormat('blockquote')}
              />
              <ToolbarButton
                title={translate('editor.formatCodeBlock', 'Блок кода')}
                icon="code"
                active={formattingState.block === 'pre'}
                disabled={mode !== 'visual'}
                onClick={handleCodeBlock}
              />
            </div>

            <div style={styles.formatDivider} />

            <div style={styles.formatGroup}>
              <ToolbarButton
                title={translate('editor.formatBold', 'Жирный')}
                icon="bold"
                active={formattingState.bold}
                disabled={mode !== 'visual'}
                onClick={() => executeEditorCommand('bold')}
              />
              <ToolbarButton
                title={translate('editor.formatItalic', 'Курсив')}
                icon="italic"
                active={formattingState.italic}
                disabled={mode !== 'visual'}
                onClick={() => executeEditorCommand('italic')}
              />
              <ToolbarButton
                title={translate('editor.formatUnderline', 'Подчеркивание')}
                label="U"
                textStyle={styles.formatUnderline}
                active={formattingState.underline}
                disabled={mode !== 'visual'}
                onClick={() => executeEditorCommand('underline')}
              />
              <ToolbarButton
                title={translate('editor.formatStrike', 'Зачеркнутый')}
                label="S"
                textStyle={styles.formatStrike}
                active={formattingState.strikeThrough}
                disabled={mode !== 'visual'}
                onClick={() => executeEditorCommand('strikeThrough')}
              />
              <ToolbarButton
                title={translate('editor.formatInlineCode', 'Строчный код')}
                icon="inlineCode"
                disabled={mode !== 'visual'}
                onClick={handleInlineCode}
              />
              <ToolbarButton
                title={translate('editor.formatClear', 'Очистить форматирование')}
                icon="clearAll"
                disabled={mode !== 'visual'}
                onClick={handleClearFormatting}
              />
            </div>

            <div style={styles.formatDivider} />

            <div style={styles.formatGroup}>
              <ToolbarButton
                title={translate('editor.formatBulletedList', 'Маркированный список')}
                icon="listUnordered"
                active={formattingState.unorderedList}
                disabled={mode !== 'visual'}
                onClick={() => executeEditorCommand('insertUnorderedList')}
              />
              <ToolbarButton
                title={translate('editor.formatNumberedList', 'Нумерованный список')}
                icon="listOrdered"
                active={formattingState.orderedList}
                disabled={mode !== 'visual'}
                onClick={() => executeEditorCommand('insertOrderedList')}
              />
              <ToolbarButton
                title={translate('editor.formatIndent', 'Увеличить отступ')}
                icon="indent"
                disabled={mode !== 'visual'}
                onClick={() => executeEditorCommand('indent')}
              />
              <ToolbarButton
                title={translate('editor.formatOutdent', 'Уменьшить отступ')}
                label="⇤"
                disabled={mode !== 'visual'}
                onClick={() => executeEditorCommand('outdent')}
              />
            </div>

            <div style={styles.formatDivider} />

            <div style={styles.formatGroup}>
              <ToolbarButton
                title={translate('editor.formatLink', 'Вставить ссылку')}
                icon="link"
                active={formattingState.link}
                disabled={mode !== 'visual'}
                onClick={handleCreateLink}
              />
              <ToolbarButton
                title={translate('editor.formatUnlink', 'Убрать ссылку')}
                icon="unlink"
                disabled={mode !== 'visual'}
                onClick={handleUnlink}
              />
              <ToolbarButton
                title={translate('editor.formatDivider', 'Вставить разделитель')}
                icon="ruler"
                disabled={mode !== 'visual'}
                onClick={() => executeEditorCommand('insertHorizontalRule')}
              />
            </div>
          </div>

          {mode !== 'visual' && (
            <div style={styles.formatToolbarHint}>{translate('editor.formatToolbarHint', 'Форматирование доступно в режиме Html.')}</div>
          )}
        </div>
      )}

      {mode === 'visual' ? (
        <div
          ref={editorRef}
          className="pm-rich-editor-content"
          contentEditable
          suppressContentEditableWarning
          onFocus={handleEditorFocus}
          onInput={() => syncFromEditor()}
          onBlur={handleEditorBlur}
          onKeyUp={syncFormattingState}
          onMouseUp={syncFormattingState}
          onPaste={handlePaste}
          data-placeholder={placeholder || 'Введите отчет'}
          style={{
            ...styles.editor,
            ...(isCompactPadding ? styles.editorCompactPadding : null),
            ...(fillHeight ? styles.editorFillHeight : null),
            height: fillHeight ? undefined : `${currentHeight}px`,
            minHeight: undefined,
            maxHeight: undefined,
            overflow: autoResize ? 'hidden' : undefined,
          }}
        />
      ) : mode === 'markdown' ? (
        markdownPreviewHtml ? (
          <div
            ref={previewRef}
            className="pm-rich-markdown-preview"
            style={{
              ...styles.preview,
              ...(isCompactPadding ? styles.previewCompactPadding : null),
              ...(fillHeight ? styles.editorFillHeight : null),
              height: fillHeight ? undefined : `${currentHeight}px`,
              minHeight: undefined,
              maxHeight: undefined,
              overflow: autoResize ? 'hidden' : undefined,
            }}
            dangerouslySetInnerHTML={{ __html: markdownPreviewHtml }}
          />
        ) : (
          <div
            ref={previewRef}
            style={{
              ...styles.previewEmpty,
              ...(isCompactPadding ? styles.previewCompactPadding : null),
              ...(fillHeight ? styles.editorFillHeight : null),
              height: fillHeight ? undefined : `${currentHeight}px`,
              minHeight: undefined,
              maxHeight: undefined,
              overflow: autoResize ? 'hidden' : undefined,
            }}
          >
            {translate('editor.markdownPreviewEmpty', 'Markdown preview is empty. Switch to Text mode to edit the content.')}
          </div>
        )
      ) : (
        <div
          ref={sourceRef}
          className="pm-rich-source-editor"
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          data-placeholder={placeholder || 'Введите отчет'}
          data-empty={htmlSource.length === 0 ? 'true' : 'false'}
          onFocus={handleEditorFocus}
          onInput={() => syncFromSourceEditor()}
          onBlur={(event) => {
            syncFromSourceEditor();
            handleEditorBlur(event);
          }}
          onPaste={handleSourcePaste}
          spellCheck={false}
          style={{
            ...styles.source,
            ...(isCompactPadding ? styles.sourceCompactPadding : null),
            ...(fillHeight ? styles.editorFillHeight : null),
            height: fillHeight ? undefined : `${currentHeight}px`,
            minHeight: undefined,
            maxHeight: undefined,
            overflow: autoResize ? 'hidden' : undefined,
          }}
        />
      )}

      {/* Drag handle for resizing */}
      {!fillHeight && !autoResize && (
        <div
          onMouseDown={handleDragStart}
          style={styles.resizeHandle}
          title="Потяните для изменения высоты"
        />
      )}

      <div style={styles.hint}>{modeHint}</div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  rootFillHeight: {
    flex: 1,
    minHeight: 0,
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
  },
  actionGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  formatToolbarContainer: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  formatToolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '6px',
    padding: '0 2px 6px',
    borderBottom: '1px solid var(--vscode-panel-border, var(--vscode-input-border, transparent))',
    overflowX: 'auto',
  },
  formatGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flexShrink: 0,
  },
  formatDivider: {
    width: '1px',
    height: '18px',
    background: 'var(--vscode-panel-border, var(--vscode-input-border, transparent))',
    flexShrink: 0,
  },
  formatBtn: {
    minWidth: '34px',
    height: '28px',
    padding: '0 8px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '4px',
    border: 'none',
    borderRadius: '4px',
    background: 'transparent',
    color: 'var(--vscode-descriptionForeground)',
    cursor: 'pointer',
    fontSize: '11px',
    fontFamily: 'var(--vscode-font-family)',
    boxShadow: 'none',
    outline: 'none',
    transition: 'background 0.12s ease, color 0.12s ease',
  },
  formatBtnWide: {
    minWidth: '38px',
  },
  formatBtnActive: {
    background: 'var(--vscode-list-activeSelectionBackground)',
    color: 'var(--vscode-foreground)',
    boxShadow: 'none',
  },
  formatBtnDisabled: {
    opacity: 0.5,
    cursor: 'default',
    border: 'none',
  },
  formatIcon: {
    width: '14px',
    height: '14px',
    display: 'block',
    flexShrink: 0,
  },
  formatBtnLabel: {
    fontSize: '11px',
    fontWeight: 700,
    lineHeight: 1,
  },
  formatToolbarHint: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
  },
  formatUnderline: {
    textDecoration: 'underline',
  },
  formatStrike: {
    textDecoration: 'line-through',
  },
  modeGroup: {
    display: 'flex',
    gap: '6px',
  },
  linkBtn: {
    padding: '2px 0',
    background: 'transparent',
    border: 'none',
    color: 'var(--vscode-textLink-foreground)',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
  },
  linkBtnDisabled: {
    opacity: 0.5,
    cursor: 'default',
    border: 'none',
  },
  modeBtn: {
    border: 'none',
    background: 'transparent',
    color: 'var(--vscode-descriptionForeground)',
    borderRadius: '4px',
    padding: '4px 8px',
    fontSize: '12px',
    cursor: 'pointer',
    boxShadow: 'none',
    outline: 'none',
  },
  modeBtnActive: {
    background: 'var(--vscode-list-activeSelectionBackground)',
    color: 'var(--vscode-foreground)',
  },
  resetBtn: {
    padding: '4px 8px',
    background: 'transparent',
    border: '1px dashed var(--vscode-input-border, var(--vscode-panel-border))',
    borderRadius: '4px',
    color: 'var(--vscode-textLink-foreground)',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
  },
  editor: {
    width: '100%',
    border: '1px solid var(--vscode-panel-border, transparent)',
    borderRadius: '12px 12px 0 0',
    /*background: 'color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-input-background) 10%)',*/
    color: 'var(--vscode-editor-foreground)',
    padding: '26px 30px',
    boxSizing: 'border-box',
    outline: 'none',
    lineHeight: 1.65,
    overflow: 'auto',
    boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--vscode-editor-background) 85%, white 15%)',
  },
  editorCompactPadding: {
    padding: '10px 12px',
  },
  editorFillHeight: {
    flex: 1,
    minHeight: 0,
  },
  source: {
    width: '100%',
    border: '1px solid var(--vscode-panel-border, transparent)',
    borderRadius: '12px 12px 0 0',
    background: 'color-mix(in srgb, var(--vscode-editor-background) 30%, white 70%)',
    color: 'var(--vscode-editor-foreground)',
    padding: '24px 28px',
    boxSizing: 'border-box',
    outline: 'none',
    lineHeight: 1.7,
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: '13px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    overflowWrap: 'anywhere',
    cursor: 'text',
  },
  sourceCompactPadding: {
    padding: '10px 12px',
  },
  preview: {
    width: '100%',
    border: '1px solid var(--vscode-panel-border, transparent)',
    borderRadius: '12px 12px 0 0',
    background: 'color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-input-background) 10%)',
    color: 'var(--vscode-editor-foreground)',
    padding: '26px 30px',
    boxSizing: 'border-box',
    overflow: 'auto',
    boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--vscode-editor-background) 85%, white 15%)',
  },
  previewCompactPadding: {
    padding: '10px 12px',
  },
  previewEmpty: {
    width: '100%',
    border: '1px solid var(--vscode-panel-border, transparent)',
    borderRadius: '12px 12px 0 0',
    /*background: 'color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-input-background) 10%)',*/
    color: 'var(--vscode-descriptionForeground)',
    padding: '26px 30px',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    overflow: 'auto',
    lineHeight: 1.6,
  },
  resizeHandle: {
    height: '6px',
    cursor: 'ns-resize',
    background: 'var(--vscode-input-border, var(--vscode-panel-border))',
    borderRadius: '0 0 4px 4px',
    opacity: 0.5,
    transition: 'opacity 0.15s',
  },
  hint: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
  },
};
