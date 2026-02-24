import React, { useCallback, useRef, useState, useEffect } from 'react';
import { useT } from '../../shared/i18n';

interface Props {
  label?: string;
  value: string;
  onChange: (value: string) => void;
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
}

/**
 * TextArea with VS Code-style ghost text autocomplete.
 *
 * Uses a layered approach: a hidden mirror div behind the textarea renders
 * ghost text inline at the cursor position. The textarea has a transparent
 * background so the ghost text shows through.
 */
export const TextArea: React.FC<Props> = ({
  label, value, onChange, placeholder, required, rows = 8,
  onRequestSuggestion, suggestion, suggestions,
  autoCompleteEnabled = true, onAutoCompleteChange,
  showControls = true, requestSuggestionSignal,
  onSuggestionLoadingChange,
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
    if (!requestSuggestionSignal || !onRequestSuggestion || !textareaRef.current) {
      return;
    }
    const pos = textareaRef.current.selectionStart;
    const textBefore = value.substring(0, pos);
    if (textBefore.trim().length === 0) {
      return;
    }
    setIsRequesting(true);
    onRequestSuggestion(textBefore);
  }, [requestSuggestionSignal, onRequestSuggestion, value]);

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
          onSelect={handleSelect}
          onScroll={syncScroll}
          placeholder={placeholder}
          rows={rows}
          style={styles.textarea}
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
