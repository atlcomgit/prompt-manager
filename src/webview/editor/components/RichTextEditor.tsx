import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  persistedHeight?: number;
  onHeightChange?: (height: number) => void;
  onReset?: () => void;
  canReset?: boolean;
}

type Mode = 'visual' | 'html';

const DEFAULT_HEIGHT = 180;
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 800;

const normalizeText = (value: string): string => value
  .replace(/\r\n?/g, '\n')
  .replace(/[\u2028\u2029]/g, '\n')
  .replace(/[\u00A0\u2007\u202F]/g, ' ')
  .replace(/[\u200B\u2060\uFEFF\u00AD]/g, '')
  .normalize('NFC');

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

export const RichTextEditor: React.FC<Props> = ({
  value,
  onChange,
  placeholder,
  persistedHeight,
  onHeightChange,
  onReset,
  canReset,
}) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>('visual');
  const [htmlSource, setHtmlSource] = useState(value || '');

  const [currentHeight, setCurrentHeight] = useState(persistedHeight || DEFAULT_HEIGHT);
  const isDragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);

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

  useEffect(() => {
    setHtmlSource(value || '');
  }, [value]);

  useEffect(() => {
    if (mode !== 'visual' || !editorRef.current) {
      return;
    }

    // Skip DOM update while user is actively editing — the DOM already has
    // the latest content and overwriting innerHTML would destroy cursor position
    // and selection, making editing painful (especially during auto-save).
    if (document.activeElement === editorRef.current) {
      return;
    }

    const sanitized = sanitizeHtml(value || '');
    if (editorRef.current.innerHTML !== sanitized) {
      editorRef.current.innerHTML = sanitized;
    }
  }, [mode, value]);

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

  const syncFromEditor = useCallback(() => {
    if (!editorRef.current) {
      return;
    }
    const sanitized = sanitizeHtml(editorRef.current.innerHTML);
    setHtmlSource(sanitized);
    onChange(sanitized);
  }, [onChange]);

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

  const modeHint = useMemo(() => {
    if (mode === 'visual') {
      return 'Вставка из Copilot Chat сохраняет оформление (списки, таблицы, блоки, ссылки).';
    }
    return 'Режим исходного HTML для точной правки разметки.';
  }, [mode]);

  return (
    <div style={styles.root}>
      <style>
        {`
          .pm-rich-editor-content {
            font-size: var(--vscode-font-size, 13px);
            line-height: 1.6;
            color: var(--vscode-foreground);
          }

          .pm-rich-editor-content p {
            margin: 0.4em 0;
          }

          .pm-rich-editor-content h1,
          .pm-rich-editor-content h2,
          .pm-rich-editor-content h3,
          .pm-rich-editor-content h4,
          .pm-rich-editor-content h5,
          .pm-rich-editor-content h6 {
            margin: 0.8em 0 0.4em;
            font-weight: 600;
            line-height: 1.3;
          }
          .pm-rich-editor-content h1 { font-size: 1.4em; }
          .pm-rich-editor-content h2 { font-size: 1.25em; }
          .pm-rich-editor-content h3 { font-size: 1.1em; }
          .pm-rich-editor-content h4 { font-size: 1em; }

          .pm-rich-editor-content ul,
          .pm-rich-editor-content ol {
            margin: 0.4em 0;
            padding-left: 1.6em;
            list-style-position: outside;
          }
          .pm-rich-editor-content ul { list-style-type: disc; }
          .pm-rich-editor-content ol { list-style-type: decimal; }

          .pm-rich-editor-content li {
            margin: 0.15em 0;
          }
          .pm-rich-editor-content li > ul,
          .pm-rich-editor-content li > ol {
            margin-top: 0.25em;
            margin-bottom: 0.25em;
          }

          .pm-rich-editor-content code {
            font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
            font-size: 0.9em;
            background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
            padding: 1px 4px;
            border-radius: 3px;
          }

          .pm-rich-editor-content pre {
            margin: 0.6em 0;
            padding: 10px 12px;
            background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
            border-radius: 4px;
            overflow-x: auto;
            line-height: 1.45;
          }
          .pm-rich-editor-content pre code {
            background: none;
            padding: 0;
            border-radius: 0;
            font-size: var(--vscode-editor-font-size, 12px);
          }

          .pm-rich-editor-content blockquote {
            margin: 0.6em 0;
            padding: 4px 12px;
            border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-focusBorder));
            background: var(--vscode-textBlockQuote-background, transparent);
            color: var(--vscode-foreground);
          }

          .pm-rich-editor-content a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
          }
          .pm-rich-editor-content a:hover {
            text-decoration: underline;
          }

          .pm-rich-editor-content hr {
            border: none;
            border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
            margin: 0.8em 0;
          }

          .pm-rich-editor-content table {
            border-collapse: collapse;
            margin: 0.6em 0;
            width: 100%;
            font-size: 0.95em;
          }
          .pm-rich-editor-content th,
          .pm-rich-editor-content td {
            border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
            padding: 5px 10px;
            text-align: left;
          }
          .pm-rich-editor-content th {
            font-weight: 600;
            background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1));
          }

          .pm-rich-editor-content strong,
          .pm-rich-editor-content b {
            font-weight: 600;
          }
        `}
      </style>
      <div style={styles.toolbar}>
        <div style={styles.modeGroup}>
          <button
            type="button"
            style={{ ...styles.modeBtn, ...(mode === 'visual' ? styles.modeBtnActive : null) }}
            onClick={() => setMode('visual')}
          >
            Визуально
          </button>
          <button
            type="button"
            style={{ ...styles.modeBtn, ...(mode === 'html' ? styles.modeBtnActive : null) }}
            onClick={() => setMode('html')}
          >
            HTML
          </button>
        </div>
        {canReset && onReset && (
          <button type="button" style={styles.resetBtn} onClick={onReset} title="Очистить отчет">
            Сбросить
          </button>
        )}
      </div>

      {mode === 'visual' ? (
        <div
          ref={editorRef}
          className="pm-rich-editor-content"
          contentEditable
          suppressContentEditableWarning
          onInput={syncFromEditor}
          onBlur={syncFromEditor}
          onPaste={handlePaste}
          data-placeholder={placeholder || 'Введите отчет'}
          style={{
            ...styles.editor,
            height: `${currentHeight}px`,
            minHeight: undefined,
            maxHeight: undefined,
          }}
        />
      ) : (
        <textarea
          value={htmlSource}
          onChange={(e) => {
            const next = normalizeText(e.target.value);
            setHtmlSource(next);
            onChange(next);
          }}
          placeholder={placeholder}
          style={{
            ...styles.source,
            height: `${currentHeight}px`,
            minHeight: undefined,
            maxHeight: undefined,
          }}
          spellCheck={false}
        />
      )}

      {/* Drag handle for resizing */}
      <div
        onMouseDown={handleDragStart}
        style={styles.resizeHandle}
        title="Потяните для изменения высоты"
      />

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
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
  },
  modeGroup: {
    display: 'flex',
    gap: '6px',
  },
  modeBtn: {
    border: '1px solid var(--vscode-button-border, transparent)',
    background: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
    borderRadius: '4px',
    padding: '4px 8px',
    fontSize: '12px',
    cursor: 'pointer',
  },
  modeBtnActive: {
    background: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
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
    border: '1px solid var(--vscode-input-border, transparent)',
    borderRadius: '4px 4px 0 0',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    padding: '10px',
    boxSizing: 'border-box',
    outline: 'none',
    lineHeight: 1.5,
    overflow: 'auto',
  },
  source: {
    width: '100%',
    border: '1px solid var(--vscode-input-border, transparent)',
    borderRadius: '4px 4px 0 0',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    padding: '10px',
    boxSizing: 'border-box',
    outline: 'none',
    lineHeight: 1.5,
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    resize: 'none',
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
