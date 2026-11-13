import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PromptConfig } from '../../types/prompt';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../types/messages';
import type { PromptHoverPreviewResult, PromptHoverTarget } from '../../types/promptHoverPreview';
import { hasPromptHoverAnchorMoved, isCurrentPromptHoverResponse, type PromptHoverAnchorRect } from '../../utils/promptHoverPreview';
import { useMessageListener } from '../shared/useMessageListener';
import { getVsCodeApi } from '../shared/vscodeApi';
import { PromptHoverCard, PROMPT_HOVER_CARD_ID } from './components/PromptHoverCard';

/** Задержки не создают запросов при быстром проходе мыши; ответ ограничен десятью секундами. */
const OPEN_DELAY_MS = 400;
const CLOSE_DELAY_MS = 150;
const RESPONSE_TIMEOUT_MS = 10_000;

/** Один снимок только текущего наведения; завершённые тексты не сохраняются в кеше. */
interface Preview {
  prompt: PromptConfig;
  target: PromptHoverTarget;
  anchor: HTMLElement;
  anchorRect: PromptHoverAnchorRect;
  requestId: string;
  result?: PromptHoverPreviewResult;
}

/** Общие события строк не зависят от режима списка и количества групп. */
interface HoverActions {
  enter: (prompt: PromptConfig, anchor: HTMLElement, fromKeyboard?: boolean) => void;
  leave: (target: EventTarget | null) => void;
  dismiss: () => void;
  activeAnchor: HTMLElement | null;
}
const HoverContext = createContext<HoverActions | null>(null);

/** Позволяет отдельным строкам и их SSR-тестам работать также без контейнера подсказки. */
export function usePromptHoverPreview(): HoverActions | null {
  return useContext(HoverContext);
}

/** Один координатор на sidebar: таймеры, поздние ответы и очистка ресурсов отделены от строк. */
export const PromptHoverPreview: React.FC<{ prompts: PromptConfig[]; children: React.ReactNode }> = ({
  prompts, children,
}) => {
  const [preview, setPreview] = useState<Preview | null>(null);
  // Новый mount не принимает ответ от прежнего дерева webview с совпавшим порядковым номером.
  const [requestScope] = useState(() => `hover-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  const active = useRef<Preview | null>(null);
  const latestPrompts = useRef(prompts);
  latestPrompts.current = prompts;
  const sequence = useRef(0);
  const opening = useRef<ReturnType<typeof setTimeout>>();
  const closing = useRef<ReturnType<typeof setTimeout>>();
  const responseTimeout = useRef<ReturnType<typeof setTimeout>>();
  // Фокус может прокрутить список до того, как истечёт задержка открытия.
  const keyboardOpening = useRef<HTMLElement | null>(null);

  /** Закрытие инвалидирует ответ даже до очередного React-render. */
  const dismiss = useCallback(() => {
    clearTimeout(opening.current); clearTimeout(closing.current); clearTimeout(responseTimeout.current);
    active.current = null;
    keyboardOpening.current = null;
    setPreview(null);
  }, []);

  /** Карточка и её якорь образуют одну область удержания мыши/фокуса. */
  const retain = useCallback(() => { clearTimeout(closing.current); }, []);
  const leave = useCallback((target: EventTarget | null) => {
    const card = document.getElementById(PROMPT_HOVER_CARD_ID);
    if (target instanceof Node && (card?.contains(target) || active.current?.anchor.contains(target))) { return; }
    // Уход мыши не закрывает область, которую сейчас читают с клавиатуры.
    if (card?.contains(document.activeElement)
      || (active.current?.anchor || keyboardOpening.current) === document.activeElement) { return; }
    clearTimeout(opening.current);
    clearTimeout(closing.current);
    closing.current = setTimeout(dismiss, CLOSE_DELAY_MS);
  }, [dismiss]);

  /** Запрашивает текст после устойчивого наведения; optimistic-строка получает локальное пустое состояние. */
  const enter = useCallback((prompt: PromptConfig, anchor: HTMLElement, fromKeyboard = false) => {
    retain();
    if (active.current?.anchor === anchor) { return; }
    dismiss();
    keyboardOpening.current = fromKeyboard ? anchor : null;
    opening.current = setTimeout(() => {
      keyboardOpening.current = null;
      const current = latestPrompts.current.find(item => item.id === prompt.id
        && item.promptUuid === prompt.promptUuid && Boolean(item.archived) === Boolean(prompt.archived));
      const bounds = anchor.getBoundingClientRect();
      if (!anchor.isConnected || !current || bounds.bottom <= 0 || bounds.top >= window.innerHeight) { return; }
      const target = { id: current.id, promptUuid: current.promptUuid, archived: Boolean(current.archived) };
      const requestId = `${requestScope}-${++sequence.current}`;
      const next: Preview = { prompt: current, target, anchor, anchorRect: bounds, requestId,
        ...(current.id === '__new__' ? { result: { state: 'ready' as const, content: '' } } : {}) };
      active.current = next;
      setPreview(next);
      if (next.result) { return; }
      responseTimeout.current = setTimeout(() => {
        if (active.current?.requestId !== requestId) { return; }
        active.current = { ...active.current, result: { state: 'error' } };
        setPreview(active.current);
      }, RESPONSE_TIMEOUT_MS);
      const request: WebviewToExtensionMessage = { type: 'getPromptHoverPreview', target, requestId };
      getVsCodeApi().postMessage(request);
    }, OPEN_DELAY_MS);
  }, [dismiss, retain, requestScope]);

  /** Идентификатор и UUID защищают от ответов для закрытой, удалённой или переименованной строки. */
  const handleMessage = useCallback((message: ExtensionToWebviewMessage) => {
    if (message.type !== 'promptHoverPreview' || !active.current
      || !isCurrentPromptHoverResponse(active.current, message)) { return; }
    clearTimeout(responseTimeout.current);
    active.current = { ...active.current, result: message.result };
    setPreview(active.current);
  }, []);
  useMessageListener(handleMessage);

  // Обновление списка может убрать якорь, поменять identity или сохранить новую ревизию текста.
  useLayoutEffect(() => {
    if (!active.current) { return; }
    const current = prompts.find(item => item.id === active.current?.target.id
      && item.promptUuid === active.current.target.promptUuid
      && Boolean(item.archived) === active.current.target.archived);
    if (!active.current.anchor.isConnected || !current || current.updatedAt !== active.current.prompt.updatedAt) {
      dismiss();
    } else if (current !== active.current.prompt) {
      active.current = { ...active.current, prompt: current };
      setPreview(active.current);
    }
  });

  // Прокрутка карточки разрешена; уход окна в фон и scroll списка прекращают просмотр.
  useEffect(() => {
    const scroll = (event: Event) => {
      if (!active.current && keyboardOpening.current === document.activeElement) { return; }
      if (!(event.target instanceof Node)
        || !document.getElementById(PROMPT_HOVER_CARD_ID)?.contains(event.target)) {
        // Автопрокрутка фокуса может доставить событие после открытия: геометрия уже учтена.
        const current = active.current;
        if (current && !hasPromptHoverAnchorMoved(current.anchorRect, current.anchor.getBoundingClientRect())) { return; }
        dismiss();
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') { return; }
      const card = document.getElementById(PROMPT_HOVER_CARD_ID);
      if (card?.contains(document.activeElement)) { active.current?.anchor.focus({ preventScroll: true }); }
      dismiss();
    };
    const visibility = () => { if (document.hidden) { dismiss(); } };
    document.addEventListener('scroll', scroll, true);
    document.addEventListener('keydown', keydown);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('blur', dismiss);
    return () => {
      clearTimeout(opening.current); clearTimeout(closing.current); clearTimeout(responseTimeout.current);
      active.current = null;
      document.removeEventListener('scroll', scroll, true);
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('blur', dismiss);
    };
  }, [dismiss]);

  const actions = useMemo(() => ({ enter, leave, dismiss, activeAnchor: preview?.anchor || null }),
    [enter, leave, dismiss, preview?.anchor]);
  return <HoverContext.Provider value={actions}>
    {children}
    {preview && <PromptHoverCard key={preview.requestId} {...preview} onEnter={retain} onLeave={leave} />}
  </HoverContext.Provider>;
};
