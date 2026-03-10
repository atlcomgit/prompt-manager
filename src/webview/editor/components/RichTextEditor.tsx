import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface Props {
  value: string;
  onChange: (value: string) => void;
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
  showFormattingToolbar?: boolean;
}

type Mode = 'visual' | 'html';
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
  icon?: string;
  label?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  wide?: boolean;
  textStyle?: React.CSSProperties;
}

const DEFAULT_HEIGHT = 180;
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 800;

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
    {icon && <span style={styles.formatIcon} className={`codicon ${icon}`} />}
    {label && <span style={{ ...styles.formatBtnLabel, ...(textStyle || null) }}>{label}</span>}
  </button>
);

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
  showFormattingToolbar,
}) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>('visual');
  const [htmlSource, setHtmlSource] = useState(value || '');
  const [formattingState, setFormattingState] = useState<FormattingState>(DEFAULT_FORMATTING_STATE);

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

  const translate = useCallback((key: string, fallback: string) => t?.(key) || fallback, [t]);

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
    if (document.activeElement === editorRef.current) {
      return;
    }

    const sanitized = sanitizeHtml(value || '');
    if (editorRef.current.innerHTML !== sanitized) {
      editorRef.current.innerHTML = sanitized;
    }
  }, [mode, value]);

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

  const syncFromEditor = useCallback(() => {
    if (!editorRef.current) {
      return;
    }
    const sanitized = sanitizeHtml(editorRef.current.innerHTML);
    setHtmlSource(sanitized);
    onChange(sanitized);
  }, [onChange]);

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

  const modeHint = useMemo(() => {
    if (mode === 'visual') {
      return 'Вставка из Copilot Chat сохраняет оформление (списки, таблицы, блоки, ссылки).';
    }
    return 'Режим исходного HTML для точной правки разметки.';
  }, [mode]);

  return (
    <div style={{ ...styles.root, ...(fillHeight ? styles.rootFillHeight : null) }}>
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
        <div style={styles.actionGroup}>
          {onOpen && (
            <button
              type="button"
              style={styles.linkBtn}
              onClick={onOpen}
              title={openTitle || openLabel || 'Открыть'}
            >
              {`↗ ${openLabel || 'Открыть'}`}
            </button>
          )}
          {onSecondaryAction && secondaryActionLabel && (
            <button
              type="button"
              style={{ ...styles.linkBtn, ...(secondaryActionDisabled ? styles.linkBtnDisabled : null) }}
              onClick={onSecondaryAction}
              title={secondaryActionTitle || secondaryActionLabel}
              disabled={secondaryActionDisabled}
            >
              {`✨ ${secondaryActionLabel}`}
            </button>
          )}
          {canReset && onReset && (
            <button type="button" style={styles.resetBtn} onClick={onReset} title="Очистить отчет">
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
                icon="codicon-discard"
                disabled={mode !== 'visual'}
                onClick={() => executeEditorCommand('undo')}
              />
              <ToolbarButton
                title={translate('editor.formatRedo', 'Повторить')}
                icon="codicon-redo"
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
                icon="codicon-quote"
                active={formattingState.block === 'blockquote'}
                disabled={mode !== 'visual'}
                onClick={() => applyBlockFormat('blockquote')}
              />
              <ToolbarButton
                title={translate('editor.formatCodeBlock', 'Блок кода')}
                icon="codicon-code"
                active={formattingState.block === 'pre'}
                disabled={mode !== 'visual'}
                onClick={handleCodeBlock}
              />
            </div>

            <div style={styles.formatDivider} />

            <div style={styles.formatGroup}>
              <ToolbarButton
                title={translate('editor.formatBold', 'Жирный')}
                icon="codicon-bold"
                active={formattingState.bold}
                disabled={mode !== 'visual'}
                onClick={() => executeEditorCommand('bold')}
              />
              <ToolbarButton
                title={translate('editor.formatItalic', 'Курсив')}
                icon="codicon-italic"
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
                icon="codicon-symbol-keyword"
                disabled={mode !== 'visual'}
                onClick={handleInlineCode}
              />
              <ToolbarButton
                title={translate('editor.formatClear', 'Очистить форматирование')}
                icon="codicon-clear-all"
                disabled={mode !== 'visual'}
                onClick={handleClearFormatting}
              />
            </div>

            <div style={styles.formatDivider} />

            <div style={styles.formatGroup}>
              <ToolbarButton
                title={translate('editor.formatBulletedList', 'Маркированный список')}
                icon="codicon-list-unordered"
                active={formattingState.unorderedList}
                disabled={mode !== 'visual'}
                onClick={() => executeEditorCommand('insertUnorderedList')}
              />
              <ToolbarButton
                title={translate('editor.formatNumberedList', 'Нумерованный список')}
                icon="codicon-list-ordered"
                active={formattingState.orderedList}
                disabled={mode !== 'visual'}
                onClick={() => executeEditorCommand('insertOrderedList')}
              />
              <ToolbarButton
                title={translate('editor.formatIndent', 'Увеличить отступ')}
                icon="codicon-indent"
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
                icon="codicon-link"
                active={formattingState.link}
                disabled={mode !== 'visual'}
                onClick={handleCreateLink}
              />
              <ToolbarButton
                title={translate('editor.formatUnlink', 'Убрать ссылку')}
                icon="codicon-link-external"
                disabled={mode !== 'visual'}
                onClick={handleUnlink}
              />
              <ToolbarButton
                title={translate('editor.formatDivider', 'Вставить разделитель')}
                icon="codicon-symbol-ruler"
                disabled={mode !== 'visual'}
                onClick={() => executeEditorCommand('insertHorizontalRule')}
              />
            </div>
          </div>

          {mode !== 'visual' && (
            <div style={styles.formatToolbarHint}>{translate('editor.formatToolbarHint', 'Форматирование доступно в визуальном режиме.')}</div>
          )}
        </div>
      )}

      {mode === 'visual' ? (
        <div
          ref={editorRef}
          className="pm-rich-editor-content"
          contentEditable
          suppressContentEditableWarning
          onInput={syncFromEditor}
          onBlur={syncFromEditor}
          onKeyUp={syncFormattingState}
          onMouseUp={syncFormattingState}
          onPaste={handlePaste}
          data-placeholder={placeholder || 'Введите отчет'}
          style={{
            ...styles.editor,
            ...(fillHeight ? styles.editorFillHeight : null),
            height: fillHeight ? undefined : `${currentHeight}px`,
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
            ...(fillHeight ? styles.editorFillHeight : null),
            height: fillHeight ? undefined : `${currentHeight}px`,
            minHeight: undefined,
            maxHeight: undefined,
          }}
          spellCheck={false}
        />
      )}

      {/* Drag handle for resizing */}
      {!fillHeight && (
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
    fontSize: '13px',
    lineHeight: 1,
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
  editorFillHeight: {
    flex: 1,
    minHeight: 0,
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
