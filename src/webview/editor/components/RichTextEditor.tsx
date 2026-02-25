import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  persistedHeight?: number;
  onHeightChange?: (height: number) => void;
}

type Mode = 'visual' | 'html';

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

const htmlToPlain = (html: string): string => {
  if (!html) {
    return '';
  }
  if (typeof DOMParser === 'undefined') {
    return html;
  }
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  return (doc.body.textContent || '').trim();
};

export const RichTextEditor: React.FC<Props> = ({
  value,
  onChange,
  placeholder,
  persistedHeight,
  onHeightChange,
}) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>('visual');
  const [htmlSource, setHtmlSource] = useState(value || '');

  useEffect(() => {
    setHtmlSource(value || '');
  }, [value]);

  useEffect(() => {
    if (mode !== 'visual' || !editorRef.current) {
      return;
    }

    const sanitized = sanitizeHtml(value || '');
    if (editorRef.current.innerHTML !== sanitized) {
      editorRef.current.innerHTML = sanitized;
    }
  }, [mode, value]);

  useEffect(() => {
    if (!editorRef.current || !onHeightChange || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      if (!editorRef.current) {
        return;
      }
      const height = Math.round(editorRef.current.getBoundingClientRect().height);
      if (height > 0) {
        onHeightChange(height);
      }
    });

    observer.observe(editorRef.current);
    return () => observer.disconnect();
  }, [onHeightChange]);

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
          .pm-rich-editor-content ul,
          .pm-rich-editor-content ol {
            margin: 0.5em 0;
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
        `}
      </style>
      <div style={styles.toolbar}>
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
            minHeight: persistedHeight ? `${persistedHeight}px` : styles.editor.minHeight,
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
            minHeight: persistedHeight ? `${persistedHeight}px` : styles.source.minHeight,
          }}
          spellCheck={false}
        />
      )}

      <div style={styles.hint}>{modeHint}</div>
      <div style={styles.previewPlain}>Текст: {htmlToPlain(value) || '—'}</div>
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
  editor: {
    width: '100%',
    minHeight: '180px',
    border: '1px solid var(--vscode-input-border, transparent)',
    borderRadius: '4px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    padding: '10px',
    boxSizing: 'border-box',
    outline: 'none',
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    overflow: 'auto',
  },
  source: {
    width: '100%',
    minHeight: '180px',
    border: '1px solid var(--vscode-input-border, transparent)',
    borderRadius: '4px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    padding: '10px',
    boxSizing: 'border-box',
    outline: 'none',
    lineHeight: 1.5,
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    resize: 'vertical',
  },
  hint: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
  },
  previewPlain: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    opacity: 0.9,
  },
};
