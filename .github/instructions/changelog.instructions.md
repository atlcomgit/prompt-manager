## 114: Переработка виджетов: ветки, ИИ-обзор и файловое дерево

- Дата: 2026-05-03.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Переработаны dashboard-виджеты редактора промпта: `Ветки проектов` теперь выбирает текущую ветку первой и показывает роли current/prompt/tracked, dashboard обновляется и после локальных изменений параметров промпта на странице, и после внешних обновлений, и после git branch/repository-state changes в видимых prompt editor, status-card сразу отражает актуальные данные промпта, AI review получил понятные пользовательские разделы, а деревья файлов коммитов и параллельных веток стали спокойными explorer-like tree-list с компактными метриками `+ / ~ / -`; дополнительно старт dashboard при открытии панели облегчён, чтобы не подвешивать VS Code, git-reactive refresh после checkout стал branch-first и лёгким, а boot-time startup перестал запрашивать dashboard на placeholder prompt и дергать refresh на каждом Git repository open.
- Ключевые моменты: `GitService` обогащает `getCommitChangedFiles` и parallel branch summaries данными `git show/diff --numstat` с поддержкой rename brace paths, а expensive parallel branch scan теперь ограничен тем же render-limit вместо полного прохода по всем local cleanup branches; `PromptDashboard` строит компактный explorer-like tree-list без ASCII-connections, без boxed file rows и без action badges, но с агрегированными directory counters; `PromptDashboardService` больше не отдаёт stale status из тёплого scope-cache при same-scope изменениях промпта, умеет force-refresh только Git-backed `projects` widget, не запускает AI review на первом prompt-open critical path, не грузит pipeline status на обычном первом `projects` refresh и добирает его только для manual AI review/full refresh, не запрашивает per-file change detail enrichment в dashboard project snapshots, потому что виджеты используют только dirty/conflict membership, сериализует тяжёлые project enrichments и при git-reactive refresh сперва обновляет branch-backed state, переиспользуя закэшированные тяжёлые секции; `EditorPanelManager` переиспользует существующие git reactive watchers для dashboard refresh в видимых prompt editor, но не запускает dashboard refresh на каждый workspace file event, пропускает первый visible-event projects refresh сразу после open/switch, отправляет checkout-triggered dashboard refresh через lightweight reactive path и игнорирует built-in Git `onDidOpenRepository` bootstrap как источник dashboard refresh; `EditorApp` ждёт реальный loaded prompt перед первым dashboard snapshot и не перезапрашивает весь snapshot на каждый title/content input; AI prompt должен возвращать простые разделы `Что происходит`, `На что обратить внимание`, `Что сделать дальше`.
- Файлы: src/types/git.ts, src/services/gitService.ts, src/services/aiService.ts, src/utils/promptDashboard.ts, src/webview/editor/EditorApp.tsx, src/webview/editor/components/PromptDashboard.tsx, tests/gitService.test.ts, tests/promptDashboardComponent.test.tsx, README.md, CHANGELOG.md, .vscode/prompt-manager/chat-memory/feature.instructions.md.

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