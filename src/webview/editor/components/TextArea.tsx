import React, { useCallback, useRef, useState, useEffect } from 'react';
import { useT } from '../../shared/i18n';

const normalizeLineEndings = (value: string): string => value
  .replace(/\r\n?/g, '\n')
  .replace(/[\u2028\u2029]/g, '\n');

const normalizePastedUnicode = (value: string): string => normalizeLineEndings(value)
  .replace(/[\u00A0\u2007\u202F]/g, ' ')
  .replace(/[\u200B\u2060\uFEFF\u00AD]/g, '')
  .normalize('NFC');

const collapseExtraBlankLines = (value: string): string => value
  .replace(/\n{3,}/g, '\n\n')
  .replace(/[ \t]+\n/g, '\n')
  .trim();

const escapeMdInline = (value: string): string => value.replace(/\|/g, '\\|');

const htmlToMarkdown = (html: string): string => {
  if (typeof DOMParser === 'undefined') {
    return '';
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const inline = (node: ChildNode): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.textContent || '').replace(/\s+/g, ' ');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const content = Array.from(el.childNodes).map(inline).join('');

    if (tag === 'br') {
      return '\n';
    }
    if (tag === 'code') {
      return `\`${content.trim()}\``;
    }
    if (tag === 'strong' || tag === 'b') {
      return `**${content.trim()}**`;
    }
    if (tag === 'em' || tag === 'i') {
      return `*${content.trim()}*`;
    }
    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      const text = content.trim() || href;
      return href ? `[${text}](${href})` : text;
    }
    return content;
  };

  const block = (node: ChildNode, depth = 0): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent || '').trim();
      return text ? text.replace(/\s+/g, ' ') : '';
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();

    if (tag === 'pre') {
      const codeEl = el.querySelector('code');
      const rawCode = normalizeLineEndings(codeEl?.textContent || el.textContent || '').replace(/\n$/, '');
      const classAttr = codeEl?.getAttribute('class') || '';
      const langMatch = classAttr.match(/(?:language-|lang-)([\w-]+)/i);
      const lang = langMatch?.[1] || '';
      return `\`\`\`${lang}\n${rawCode}\n\`\`\``;
    }

    if (tag === 'table') {
      const rows = Array.from(el.querySelectorAll('tr')).map((tr) =>
        Array.from(tr.querySelectorAll('th,td')).map((cell) => escapeMdInline((cell.textContent || '').replace(/\s+/g, ' ').trim()))
      ).filter((row) => row.length > 0);

      if (rows.length === 0) {
        return '';
      }

      const header = rows[0];
      const separator = header.map(() => '---');
      const body = rows.slice(1);
      const lines = [
        `| ${header.join(' | ')} |`,
        `| ${separator.join(' | ')} |`,
        ...body.map((row) => `| ${row.join(' | ')} |`),
      ];
      return lines.join('\n');
    }

    if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(el.children).filter((child) => child.tagName.toLowerCase() === 'li');
      const lines: string[] = [];

      items.forEach((item, idx) => {
        const li = item as HTMLLIElement;
        const nestedLists = Array.from(li.children).filter((child) => {
          const childTag = child.tagName.toLowerCase();
          return childTag === 'ul' || childTag === 'ol';
        });

        const nonListNodes = Array.from(li.childNodes).filter((child) => {
          if (child.nodeType !== Node.ELEMENT_NODE) {
            return true;
          }
          const childTag = (child as HTMLElement).tagName.toLowerCase();
          return childTag !== 'ul' && childTag !== 'ol';
        });

        const content = nonListNodes.map((child) => {
          if (child.nodeType === Node.ELEMENT_NODE) {
            return ((child as HTMLElement).tagName.toLowerCase() === 'p' ? block(child, depth + 1) : inline(child));
          }
          return inline(child);
        }).join('').replace(/\s+/g, ' ').trim();

        const prefix = `${'  '.repeat(depth)}${tag === 'ol' ? `${idx + 1}.` : '-'} `;
        lines.push(`${prefix}${content}`.trimEnd());

        nestedLists.forEach((nested) => {
          const nestedMd = block(nested, depth + 1);
          if (nestedMd) {
            lines.push(nestedMd);
          }
        });
      });

      return lines.join('\n');
    }

    if (tag === 'blockquote') {
      const quoteText = Array.from(el.childNodes).map((child) => block(child, depth)).join('\n').trim();
      if (!quoteText) {
        return '';
      }
      return quoteText.split('\n').map((line) => `> ${line}`).join('\n');
    }

    if (tag === 'hr') {
      return '---';
    }

    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      const content = Array.from(el.childNodes).map(inline).join('').replace(/\s+/g, ' ').trim();
      return `${'#'.repeat(level)} ${content}`.trim();
    }

    if (tag === 'p') {
      return Array.from(el.childNodes).map(inline).join('').replace(/\s+/g, ' ').trim();
    }

    const childBlocks = Array.from(el.childNodes)
      .map((child) => block(child, depth))
      .filter(Boolean);

    if (childBlocks.length > 0) {
      return childBlocks.join('\n\n');
    }

    return Array.from(el.childNodes).map(inline).join('').replace(/\s+/g, ' ').trim();
  };

  const markdown = Array.from(doc.body.childNodes)
    .map((node) => block(node, 0))
    .filter(Boolean)
    .join('\n\n');

  return collapseExtraBlankLines(normalizePastedUnicode(markdown));
};

interface Props {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  required?: boolean;
  rows?: number;
  onRequestSuggestion?: (textBefore: string) => void;
  suggestion?: string;
  suggestions?: string[];
  autoCompleteEnabled?: boolean;
  onAutoCompleteChange?: (enabled: boolean) => void;
  showControls?: boolean;
  requestSuggestionSignal?: number;
  onSuggestionLoadingChange?: (loading: boolean) => void;
  persistedHeight?: number;
  onHeightChange?: (height: number) => void;
  normalizePastedText?: boolean;
  focusSignal?: number;
}

/**
 * TextArea with VS Code-style ghost text autocomplete.
 *
 * Uses a layered approach: a hidden mirror div behind the textarea renders
 * ghost text inline at the cursor position. The textarea has a transparent
 * background so the ghost text shows through.
 */
export const TextArea: React.FC<Props> = ({
  label, value, onChange, onBlur, placeholder, required, rows = 8,
  onRequestSuggestion, suggestion, suggestions,
  autoCompleteEnabled = false, onAutoCompleteChange,
  showControls = true, requestSuggestionSignal,
  onSuggestionLoadingChange,
  persistedHeight,
  onHeightChange,
  normalizePastedText = false,
  focusSignal,
}) => {
  const t = useT();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [ghostText, setGhostText] = useState('');
  const [cursorPos, setCursorPos] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const [isRequesting, setIsRequesting] = useState(false);
  const [allVariants, setAllVariants] = useState<string[]>([]);
  const [currentVariantIdx, setCurrentVariantIdx] = useState(0);
  const lastHandledSuggestionSignalRef = useRef<number>(0);

  // Show ghost text when suggestion arrives
  useEffect(() => {
    if (suggestions && suggestions.length > 0) {
      setAllVariants(suggestions);
      setCurrentVariantIdx(0);
      setGhostText(suggestions[0]);
      setIsRequesting(false);
    } else if (suggestion) {
      setAllVariants([suggestion]);
      setCurrentVariantIdx(0);
      setGhostText(suggestion);
      setIsRequesting(false);
    } else {
      setGhostText('');
      setAllVariants([]);
      setCurrentVariantIdx(0);
      setIsRequesting(false);
    }
  }, [suggestion, suggestions]);

  useEffect(() => {
    onSuggestionLoadingChange?.(isRequesting);
  }, [isRequesting, onSuggestionLoadingChange]);

  // Handle text input — clear ghost, debounce suggestion request only after space
  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    const pos = e.target.selectionStart;
    onChange(newValue);
    setCursorPos(pos);
    setGhostText('');

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    // Auto-request suggestion only after typing a space or newline, with 2s delay
    if (autoCompleteEnabled && onRequestSuggestion) {
      const typedChar = pos > 0 ? newValue[pos - 1] : '';
      if (typedChar === ' ' || typedChar === '\n') {
        debounceRef.current = setTimeout(() => {
          const textBefore = newValue.substring(0, pos);
          if (textBefore.trim().length > 0) {
            setIsRequesting(true);
            onRequestSuggestion(textBefore);
          }
        }, 2000);
      }
    }
  }, [onChange, onRequestSuggestion, autoCompleteEnabled]);

  // Track cursor position on selection change
  const handleSelect = useCallback(() => {
    if (textareaRef.current) {
      setCursorPos(textareaRef.current.selectionStart);
    }
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab' && ghostText) {
      e.preventDefault();
      const pos = textareaRef.current?.selectionStart ?? cursorPos;
      const newValue = value.substring(0, pos) + ghostText + value.substring(pos);
      onChange(newValue);
      setGhostText('');
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          const newPos = pos + ghostText.length;
          textareaRef.current.selectionStart = newPos;
          textareaRef.current.selectionEnd = newPos;
        }
      });
    } else if (e.key === 'Escape' && ghostText) {
      e.preventDefault();
      setGhostText('');
      setAllVariants([]);
    } else if (e.key === 'ArrowDown' && ghostText && allVariants.length > 1) {
      e.preventDefault();
      const nextIdx = (currentVariantIdx + 1) % allVariants.length;
      setCurrentVariantIdx(nextIdx);
      setGhostText(allVariants[nextIdx]);
    } else if (e.key === 'ArrowUp' && ghostText && allVariants.length > 1) {
      e.preventDefault();
      const prevIdx = (currentVariantIdx - 1 + allVariants.length) % allVariants.length;
      setCurrentVariantIdx(prevIdx);
      setGhostText(allVariants[prevIdx]);
    } else if (e.key === 'Tab' && !ghostText) {
      e.preventDefault();
      const textarea = e.currentTarget;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newValue = value.substring(0, start) + '  ' + value.substring(end);
      onChange(newValue);
      requestAnimationFrame(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 2;
      });
    }
  }, [value, onChange, ghostText, cursorPos]);

  const sanitizePastedText = useCallback((rawText: string): string => {
    return collapseExtraBlankLines(normalizePastedUnicode(rawText));
  }, []);

  const extractPreferredClipboardText = useCallback((clipboardData: DataTransfer): string => {
    const markdown = clipboardData.getData('text/markdown') || clipboardData.getData('text/x-markdown');
    if (markdown.trim()) {
      return markdown;
    }

    const html = clipboardData.getData('text/html');
    if (html.trim()) {
      const converted = htmlToMarkdown(html);
      if (converted.trim()) {
        return converted;
      }
    }

    return clipboardData.getData('text/plain');
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!normalizePastedText) {
      return;
    }

    const textarea = e.currentTarget;
    const pastedRaw = extractPreferredClipboardText(e.clipboardData);
    const pastedText = sanitizePastedText(pastedRaw);
    if (!pastedText) {
      e.preventDefault();
      return;
    }

    e.preventDefault();

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const newValue = value.slice(0, start) + pastedText + value.slice(end);
    const newPos = start + pastedText.length;

    onChange(newValue);
    setGhostText('');
    setCursorPos(newPos);

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.selectionStart = newPos;
        textareaRef.current.selectionEnd = newPos;
      }
    });
  }, [extractPreferredClipboardText, normalizePastedText, onChange, sanitizePastedText, value]);

  // Sync scroll between textarea and mirror
  const syncScroll = useCallback(() => {
    if (textareaRef.current && mirrorRef.current) {
      mirrorRef.current.scrollTop = textareaRef.current.scrollTop;
      mirrorRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  useEffect(() => {
    if (!textareaRef.current || !onHeightChange || typeof ResizeObserver === 'undefined') {
      return;
    }

    const textarea = textareaRef.current;
    const observer = new ResizeObserver(() => {
      const height = Math.round(textarea.getBoundingClientRect().height);
      if (height > 0) {
        onHeightChange(height);
      }
    });
    observer.observe(textarea);

    return () => observer.disconnect();
  }, [onHeightChange]);

  useEffect(() => {
    if (!requestSuggestionSignal || !onRequestSuggestion || !textareaRef.current) {
      return;
    }
    if (lastHandledSuggestionSignalRef.current === requestSuggestionSignal) {
      return;
    }
    lastHandledSuggestionSignalRef.current = requestSuggestionSignal;

    const pos = textareaRef.current.selectionStart;
    const textBefore = value.substring(0, pos);
    if (textBefore.trim().length === 0) {
      setIsRequesting(false);
      return;
    }
    setIsRequesting(true);
    onRequestSuggestion(textBefore);
  }, [requestSuggestionSignal, onRequestSuggestion, value]);

  useEffect(() => {
    if (!focusSignal || !textareaRef.current) {
      return;
    }
    textareaRef.current.focus();
    const position = textareaRef.current.value.length;
    textareaRef.current.selectionStart = position;
    textareaRef.current.selectionEnd = position;
  }, [focusSignal]);

  const textBeforeCursor = value.substring(0, cursorPos);
  const textAfterCursor = value.substring(cursorPos);
  const showLabelRow = Boolean(label) || showControls;

  return (
    <div style={styles.field}>
      {showLabelRow && (
        <div style={styles.labelRow}>
          <label style={styles.label}>
            {label}
            {required && <span style={styles.required}> *</span>}
          </label>
          {showControls && (
            <div style={styles.labelActions}>
              {onAutoCompleteChange && (
                <label style={styles.autoCompleteLabel}>
                  <input
                    type="checkbox"
                    checked={autoCompleteEnabled}
                    onChange={e => onAutoCompleteChange(e.target.checked)}
                    style={{ margin: 0 }}
                  />
                  Автодополнение
                </label>
              )}
              <span style={styles.loadingIndicator}>{isRequesting ? '⏳' : ''}</span>
              {onRequestSuggestion && (
                <button
                  style={styles.suggestBtn}
                  onClick={() => {
                    if (textareaRef.current && onRequestSuggestion) {
                      const pos = textareaRef.current.selectionStart;
                      setIsRequesting(true);
                      onRequestSuggestion(value.substring(0, pos));
                    }
                  }}
                  title={t('textArea.suggestTooltip')}
                >
                  {t('textArea.suggest')}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div style={styles.editorContainer}>
        {/* Mirror div behind textarea — renders ghost text */}
        <div ref={mirrorRef} style={styles.mirror} aria-hidden="true">
          <span>{textBeforeCursor}</span>
          {ghostText && <span style={styles.ghostText}>{ghostText}</span>}
          <span>{textAfterCursor}</span>
          <br />&nbsp;
        </div>

        {/* Actual textarea — transparent background so ghost shows through */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onSelect={handleSelect}
          onScroll={syncScroll}
          onBlur={onBlur}
          placeholder={placeholder}
          rows={rows}
          style={{
            ...styles.textarea,
            height: persistedHeight ? `${persistedHeight}px` : undefined,
          }}
          spellCheck={false}
        />

        {ghostText && (
          <div style={styles.ghostHint}>
            {t('textArea.tabAccept')} · {t('textArea.escDismiss')}{allVariants.length > 1 ? ` · ↑↓ — ${t('textArea.variant')} ${currentVariantIdx + 1}/${allVariants.length}` : ''}
          </div>
        )}
      </div>

      <div style={styles.hint}>
        {t('textArea.mdHint')}
      </div>
    </div>
  );
};

const monoFont = 'var(--vscode-editor-font-family, monospace)';

const styles: Record<string, React.CSSProperties> = {
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  labelRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  label: {
    fontSize: '12px',
    fontWeight: 500,
    color: 'var(--vscode-foreground)',
  },
  required: {
    color: 'var(--vscode-errorForeground)',
  },
  labelActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  loadingIndicator: {
    fontSize: '12px',
    width: '16px',
    textAlign: 'center',
    flexShrink: 0,
  },
  autoCompleteLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '11px',
    cursor: 'pointer',
    color: 'var(--vscode-descriptionForeground)',
    whiteSpace: 'nowrap',
  },
  suggestBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--vscode-textLink-foreground)',
    cursor: 'pointer',
    fontSize: '11px',
    fontFamily: 'var(--vscode-font-family)',
    padding: '2px 6px',
    borderRadius: '4px',
  },
  editorContainer: {
    position: 'relative',
  },
  mirror: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    padding: '8px',
    fontFamily: monoFont,
    fontSize: '13px',
    lineHeight: '1.5',
    whiteSpace: 'pre-wrap',
    wordWrap: 'break-word',
    overflow: 'hidden',
    pointerEvents: 'none',
    color: 'transparent',
    border: '1px solid transparent',
    boxSizing: 'border-box',
    borderRadius: '4px',
    zIndex: 2,
  },
  ghostText: {
    color: 'var(--vscode-editorGhostText-foreground, rgba(128,128,128,0.6))',
    fontStyle: 'italic',
  },
  textarea: {
    position: 'relative',
    zIndex: 1,
    width: '100%',
    padding: '8px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border, transparent)',
    borderRadius: '4px',
    fontFamily: monoFont,
    fontSize: '13px',
    lineHeight: '1.5',
    tabSize: 2,
    resize: 'vertical',
    outline: 'none',
    minHeight: '120px',
    boxSizing: 'border-box',
    caretColor: 'var(--vscode-editorCursor-foreground, var(--vscode-foreground))',
  },
  ghostHint: {
    position: 'absolute',
    bottom: '4px',
    right: '8px',
    fontSize: '10px',
    color: 'var(--vscode-descriptionForeground)',
    background: 'var(--vscode-input-background)',
    padding: '2px 6px',
    borderRadius: '4px',
    opacity: 0.8,
    pointerEvents: 'none',
  },
  hint: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
  },
};
