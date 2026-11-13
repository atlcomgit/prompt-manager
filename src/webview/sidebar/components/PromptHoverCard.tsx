import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PromptConfig } from '../../../types/prompt';
import type { PromptHoverPreviewResult } from '../../../types/promptHoverPreview';
import { getPromptHoverPosition } from '../../../utils/promptHoverPreview';
import { useT } from '../../shared/i18n';
import { getPromptStatusLabel, PROMPT_STATUS_COLORS } from '../../shared/promptStatus';
import { renderPromptHoverMarkdown } from '../promptHoverMarkdown';

/** Общий адрес немодальной области для связи со строкой и перехода с клавиатуры. */
export const PROMPT_HOVER_CARD_ID = 'pm-prompt-hover-preview';

/** Карточка получает только выбранный промпт; отсутствие result обозначает загрузку. */
interface Props {
  prompt: PromptConfig;
  anchor: HTMLElement;
  result?: PromptHoverPreviewResult;
  onEnter: () => void;
  onLeave: (target: EventTarget | null) => void;
}

/** Оформление ограничено карточкой; код, таблицы и длинные слова не расширяют sidebar. */
const CARD_CSS = `
.pm-prompt-hover { position:fixed; z-index:1000; display:flex; flex-direction:column; overflow:hidden;
  box-sizing:border-box; padding:12px; gap:10px; border:1px solid var(--vscode-editorHoverWidget-border);
  border-radius:var(--pm-border-radius,4px); background:var(--vscode-editorHoverWidget-background);
  color:var(--vscode-editorHoverWidget-foreground,var(--vscode-foreground));
  box-shadow:0 4px 16px var(--vscode-widget-shadow); font-size:var(--vscode-font-size,13px); }
.pm-prompt-hover:focus-visible,.pm-prompt-item:focus-visible { outline:1px solid var(--vscode-focusBorder);
  outline-offset:-2px; }
.pm-hover-meta { display:flex; flex-wrap:wrap; justify-content:space-between; gap:6px; font-size:11px;
  color:var(--vscode-descriptionForeground); flex:none; }
/* Номер использует основной цвет карточки вместо приглушённого цвета метаданных. */
.pm-hover-task { overflow-wrap:anywhere; min-width:0; font-weight:700;
  color:var(--vscode-editorHoverWidget-foreground,var(--vscode-foreground)); }
.pm-hover-status { border:1px solid currentColor; border-radius:var(--pm-border-radius,4px); padding:1px 6px; }
.pm-hover-title { font-size:14px; line-height:1.4; font-weight:600; margin:0; overflow-wrap:anywhere; }
.pm-hover-body { overflow:auto; overscroll-behavior:contain; min-height:0; user-select:text; line-height:1.5;
  overflow-wrap:anywhere; border-top:1px solid var(--vscode-editorHoverWidget-border); padding-top:10px; }
.pm-hover-body > :first-child { margin-top:0; }
.pm-hover-body > :last-child { margin-bottom:0; }
.pm-hover-body p,.pm-hover-body pre,.pm-hover-body ul,.pm-hover-body ol,.pm-hover-body blockquote,
.pm-hover-body table { margin:0 0 10px; }
.pm-hover-body h1,.pm-hover-body h2,.pm-hover-body h3,.pm-hover-body h4,.pm-hover-body h5,
.pm-hover-body h6 { font-size:1em; line-height:1.4; margin:12px 0 6px; }
.pm-hover-body ul,.pm-hover-body ol { padding-left:20px; }
.pm-hover-body code { font-family:var(--vscode-editor-font-family,monospace);
  color:var(--vscode-textPreformat-foreground); background:var(--vscode-textCodeBlock-background); }
.pm-hover-body pre { padding:8px; white-space:pre-wrap; overflow-wrap:anywhere;
  background:var(--vscode-textCodeBlock-background); border-radius:var(--pm-border-radius,4px); }
.pm-hover-body blockquote { padding-left:10px; border-left:3px solid var(--vscode-textBlockQuote-border);
  color:var(--vscode-descriptionForeground); }
.pm-hover-body table { border-collapse:collapse; max-width:100%; }
.pm-hover-body th,.pm-hover-body td { padding:4px 6px; border:1px solid var(--vscode-editorHoverWidget-border); }
.pm-hover-link { color:var(--vscode-textLink-foreground); }
.pm-hover-notice { color:var(--vscode-descriptionForeground); padding:8px 0; }
`;

/** Полный Markdown в одном portal; размер пересчитывается после загрузки текста и изменения геометрии. */
export const PromptHoverCard: React.FC<Props> = ({ prompt, anchor, result, onEnter, onLeave }) => {
  const t = useT();
  const cardRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(() => getPromptHoverPosition(
    anchor.getBoundingClientRect(), window.innerWidth, window.innerHeight, 260,
  ));
  const content = result?.state === 'ready' ? result.content : '';
  const html = useMemo(() => renderPromptHoverMarkdown(content), [content]);

  // Наблюдатель очищается вместе с portal; resize не оставляет карточку за границей панели.
  useLayoutEffect(() => {
    const update = () => {
      if (!cardRef.current || !anchor.isConnected) { return; }
      const next = getPromptHoverPosition(anchor.getBoundingClientRect(), window.innerWidth,
        window.innerHeight, cardRef.current.getBoundingClientRect().height);
      setPosition(previous => Object.keys(next).every(key => (
        next[key as keyof typeof next] === previous[key as keyof typeof next]
      )) ? previous : next);
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    if (cardRef.current) { observer?.observe(cardRef.current); }
    window.addEventListener('resize', update);
    return () => { observer?.disconnect(); window.removeEventListener('resize', update); };
  }, [anchor, content]);

  // Заголовок также прокручивается при экстремально длинном названии и очень низкой панели.
  return createPortal(<>
    <style>{CARD_CSS}</style>
    <div id={PROMPT_HOVER_CARD_ID} ref={cardRef} className="pm-prompt-hover" role="region" tabIndex={0}
      aria-label={t('sidebar.previewLabel')} aria-busy={!result} style={position}
      onMouseEnter={onEnter} onMouseLeave={event => onLeave(event.relatedTarget)}
      onFocus={onEnter} onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) { onLeave(event.relatedTarget); }
      }}>
      <div className="pm-hover-meta">
        <span className="pm-hover-task">{prompt.taskNumber ? `#${prompt.taskNumber}` : t('sidebar.previewNoTask')}</span>
        <span className="pm-hover-status" style={{ color: PROMPT_STATUS_COLORS[prompt.status] }}>
          {getPromptStatusLabel(prompt.status, t)}
        </span>
      </div>
      <div className="pm-hover-body">
        <h2 className="pm-hover-title">{prompt.title || prompt.id}</h2>
        {!result ? <p className="pm-hover-notice" role="status">{t('sidebar.previewLoading')}</p>
          : result.state !== 'ready' ? <p className="pm-hover-notice" role="status">
            {t(result.state === 'missing' ? 'sidebar.previewMissing' : 'sidebar.previewError')}
          </p>
            : !content.trim() ? <p className="pm-hover-notice">{t('sidebar.previewEmpty')}</p>
              : <div dangerouslySetInnerHTML={{ __html: html }} />}
      </div>
    </div>
  </>, document.body);
};
