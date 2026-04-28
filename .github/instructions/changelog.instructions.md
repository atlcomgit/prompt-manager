## 113: Фоновая очередь распознавания и интерфейс записи

- Дата: 2026-04-28.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Для записи промпта с микрофона добавлена фоновая FIFO-очередь распознавания, компактный in-text индикатор прогресса, автоочередь и автозапуск следующей записи при лимите 05:00, а также исправлена упаковка runtime-зависимостей `@huggingface/transformers` в VSIX.
- Ключевые моменты: Active recording теперь отделен от background recognition jobs; `PromptVoiceService` обрабатывает Whisper/AI-коррекцию в controlled parallel workers, но выпускает completed text строго по исходному порядку очереди; ручной OK должен побеждать limit auto-restart race уже на press-down intent до click event; после OK webview должен игнорировать stale `recording`/`paused` recorder states, которые пришли уже после перехода в `processing`; `[prompt-voice][trace]` логи из webview и host помогают разбирать OK/limit/overlay races; `PromptVoiceTranscriptionService` preloads configured Whisper model/language during recording; TextArea bottom overlay/inset используется для queue chips без перекрытия текста; после вставки распознанного текста поле скроллится вниз; AI post-correction placeholder replies вроде “Пожалуйста, предоставьте текст для исправления/корректуры.” должны fallback-иться к raw Whisper text; тихая речь усиливается агрессивнее с повторным DC recenter после soft clipping.
- Файлы: .vscodeignore, src/services/promptVoice/promptVoiceService.ts, src/services/promptVoice/promptVoiceTranscriptionService.ts, src/services/promptVoice/promptVoiceRecorder.ts, src/types/messages.ts, src/webview/editor/voice/usePromptVoiceController.ts, src/webview/editor/components/PromptVoiceOverlay.tsx, src/webview/editor/components/PromptVoiceQueueIndicator.tsx, src/webview/editor/components/TextArea.tsx, src/webview/editor/EditorApp.tsx, src/i18n/translations.ts, tests/promptVoiceQueue.test.tsx, README.md, CHANGELOG.md, .vscode/prompt-manager/chat-memory/feature.instructions.md.

## 112: Кнопка «Начать на текущих ветках»

- Дата: 2026-04-28.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: В start-chat preflight окна Git Flow добавлена отдельная кнопка «Начать на текущих ветках», которая теперь показывается всякий раз, когда обычная кнопка «Начать» видна, но заблокирована. Также обновлены локализации, README, CHANGELOG и регрессионные тесты.
- Ключевые моменты: Новый CTA показывается только в режиме запуска чата и следует фактическому disabled-состоянию основной кнопки «Начать»; обычная кнопка «Начать» по-прежнему активируется после прохождения стандартной проверки веток, а альтернативная кнопка использует уже существующий путь запуска с `skipBranchMismatchCheck`.
- Файлы: src/webview/editor/components/GitOverlay.tsx, src/i18n/translations.ts, tests/gitOverlay.test.ts, README.md, CHANGELOG.md, .vscode/prompt-manager/chat-memory/feature.instructions.md.

## 110: Кнопка «Перейти в чат» вне черновика

- Дата: 2026-04-27.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Обновлена логика ActionBar, чтобы кнопка «Перейти в чат» отображалась для всех сохранённых статусов промпта, кроме «Черновик» и «Закрыт», при этом во время запуска нового чата по-прежнему показывается спиннер «Start Chat».
- Ключевые моменты: Открытие чата допускается для любого сохранённого нечернового и незакрытого промпта даже без уже восстановленного chat-entry состояния; путь запуска нового чата для draft остаётся отдельным и не должен перекрываться кнопкой открытия во время launch-pending.
- Файлы: src/webview/editor/components/ActionBar.tsx, tests/actionBar.test.ts, README.md, CHANGELOG.md, .vscode/prompt-manager/chat-memory/feature.instructions.md.

## 111: Исправить мерцание блока в Git Flow

- Дата: 2026-04-28.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Исправлено мерцание блока «Изменения в других проектах» в шаге 1 Git Flow, стабилизирован root-список tracked-веток в summary/light snapshot до branch hydration, чтобы при открытии не мигали ложные step-1 предупреждения, и убран шумный built-in git state watcher, который мог удерживать auto-refresh в цикле. Добавлены регрессионные тесты и обновлена документация.
- Ключевые моменты: `gitOverlaySnapshot` обновляет выбранные проекты раньше `gitOverlayOtherProjectsSnapshot`, поэтому webview должен временно сохранять предыдущее `otherProjects`, пока новый lazy-снимок не подтвердит актуальный список; до branch hydration root `snapshot.trackedBranches` должен сохранять стабильный initial список tracked-веток, чтобы branch patches не оставляли UI без допустимой текущей tracked-ветки; `repository.state.onDidChange` нельзя использовать как триггер Git Flow auto-refresh, потому что его шумные пульсы легко держат `refreshQueued` в самоподдерживающемся цикле.
- Файлы: src/utils/gitOverlay.ts, src/webview/editor/EditorApp.tsx, src/services/gitService.ts, src/providers/editorPanelManager.ts, tests/gitOverlay.test.ts, tests/gitService.test.ts, tests/editorPanelManager.test.ts, README.md, CHANGELOG.md, .vscode/prompt-manager/chat-memory/feature.instructions.md.