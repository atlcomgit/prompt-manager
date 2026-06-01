## 150: Не формировать файлы при отключенной памяти

- Дата: 2026-06-01.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: При старте чата добавлена runtime-проверка текущих настроек памяти истории и codemap-инструкций, поэтому при выключенных `promptManager.memory.enabled` и `promptManager.codemap.enabled` расширение больше не генерирует session/codemap instruction files и не подцепляет stale `codemap.instructions.md` в chat context.
- Ключевые моменты: Баг возникал из-за того, что `EditorPanelManager.startChat` ориентировался только на наличие сервисов, а `buildChatContextFiles()` безусловно прикладывал существующий `chat-memory/codemap.instructions.md`; теперь оба пути учитывают актуальные runtime-настройки, что сохраняет корректное поведение даже после переключения настроек без перезагрузки окна. Регрессионный тест фиксирует отсутствие prepare/attach path при выключенных флагах.
- Файлы:
  CHANGELOG.md
  README.md
  src/providers/editorPanelManager.ts
  src/utils/chatContextFiles.ts
  tests/editorPanelManager.test.ts

## 149: Добавить переключатель ИИ и памяти

- Дата: 2026-06-01.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Добавлен глобальный флаг `promptManager.ai.enabled` с выключенным по умолчанию состоянием для внутренних AI-функций Prompt Manager; при выключенном флаге расширение больше не выполняет встроенные AI-запросы для генерации полей промпта, отчетов, анализа истории памяти, codemap-очередей и voice post-correction. Также значения по умолчанию для `promptManager.memory.enabled` и `promptManager.codemap.enabled` переведены в `false`, чтобы память истории и инструкции были opt-in.
- Ключевые моменты: Общий gate вынесен в `aiSettingsConfig`, центральный AI path `AiService` завершает внутренние AI-flow без LM-запроса, а обходные пути в `MemoryAnalyzerService`, `CodeMapOrchestratorService` и `PromptVoicePostCorrectionService` дополнительно обрезаны отдельно; ручные AI-действия редактора теперь показывают явную ошибку вместо ложного fallback-результата, а defaults памяти и codemap выровнены между manifest и runtime config constants.
- Файлы:
  CHANGELOG.md
  README.md
  package.json
  src/codemap/codeMapConfig.ts
  src/codemap/codeMapOrchestratorService.ts
  src/providers/editorPanelManager.ts
  src/services/aiService.ts
  src/services/aiSettingsConfig.ts
  src/services/memoryAnalyzerService.ts
  src/services/promptVoice/promptVoicePostCorrectionService.ts
  src/types/memory.ts
  tests/aiService.test.ts
  tests/aiSettingsConfig.test.ts
  tests/codeMapConfig.test.ts
  tests/instructionsPanelSettings.test.ts
  tests/memorySettingsConfig.test.ts
  tests/memorySettingsPanel.test.ts

## Без номера: Дублирование webview-вкладок и медленное сохранение

- Дата: 2026-06-01.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Исправлено восстановление singleton prompt editor после reload VS Code: расширение теперь регистрирует serializer для `promptManager.editor`, принимает восстановленную webview обратно в `EditorPanelManager`, переиспользует её вместо создания второй вкладки и восстанавливает нужный промпт по persisted identity из webview state.
- Ключевые моменты: Корневой баг возникал из-за того, что VS Code мог восстановить старую webview-вкладку, а extension без `registerWebviewPanelSerializer` не брал её под управление и параллельно открывал новый singleton editor; в итоге одна вкладка была «живая», а старая оставалась stale и могла зависать на сохранении. Теперь `EditorApp` сохраняет `prompt id/promptUuid` в persisted webview state, `EditorPanelManager.revivePromptEditorPanel()` принимает restored panel, reuse-path принудительно делает новый boot cycle, если у панели ещё нет актуального host boot id, а регрессионный тест фиксирует сценарий без создания второй editor panel.
- Файлы:
  CHANGELOG.md
  README.md
  package.json
  src/extension.ts
  src/providers/editorPanelManager.ts
  src/webview/editor/EditorApp.tsx
  tests/editorPanelManager.test.ts

## 143: Краткое эффектное описание расширения

- Дата: 2026-05-31.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: README сокращён и переписан в короткий двуязычный marketplace-first формат с сильным hero-блоком, быстрым объяснением ценности, компактным visual tour, коротким quick start и минимально достаточными требованиями.
- Ключевые моменты: README больше не дублирует длинный changelog внутри страницы, не держит ручной version badge и не использует сломанный contents; первый экран теперь продаёт четыре главных differentiator-а расширения — repo-native prompt workflow, запуск Copilot из сохранённого контекста, Git-aware execution и Project Memory; для витрины используются существующие hero/sidebar/editor/memory assets без разрастания страницы.
- Файлы:
  CHANGELOG.md
  README.md

## 144: Ускорение виджета Ветки проектов

- Дата: 2026-05-31.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Ускорен виджет `Ветки проектов`: shared refresh секции `projects` теперь переиспользует уже собранные строки выбранных prompt-проектов и догружает Git snapshot только для отсутствующих workspace-репозиториев, а post-action AI follow-up после `Получить` и `Переключить` больше не запускает второй targeted refresh сразу после `reactive-branches` repaint; дополнительно локально выбранная, но ещё не применённая ветка больше не сбрасывается при refresh и после возврата из режима `Показать все`.
- Ключевые моменты: `PromptDashboardService.loadBranchWidgetProjectsData()` принимает уже гидратированные prompt-project summaries и собирает `branchProjects` из них плюс только недостающих workspace-проектов, чтобы не повторять selected snapshot при расширении branch widget до `Показать все`; `analyzeParallelReview()` получил safe reuse-path `skipProjectsRefresh`, а `EditorPanelManager` использует его после branch switch/pull flows, поэтому быстрый repaint строк и фоновый AI review больше не дублируют один и тот же targeted Git refresh; `PromptDashboard` теперь reconcile-ит локальные branch drafts по полному branch scope вместо одних selected rows, поэтому refresh не теряет workspace-only выбор до фактического подтверждения новой current branch.
- Файлы:
  CHANGELOG.md
  README.md
  src/webview/editor/components/PromptDashboard.tsx
  src/providers/editorPanelManager.ts
  src/services/promptDashboardService.ts
  tests/promptDashboardComponent.test.tsx
  tests/editorPanelManager.test.ts
  tests/promptDashboardService.test.ts

## 141: Зависание страницы и дубликаты

- Дата: 2026-05-30.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Исправлена стабильность singleton prompt editor и dashboard-обновлений: повторное открытие уже видимого промпта теперь переводит editor webview на новый boot cycle с точным versioned `prompt(open)` payload на следующем `ready`, а dashboard snapshot/widget сообщения перестали теряться после reused snapshot, если поздний payload всё ещё относится к текущему промпту и для него нет более нового активного request.
- Ключевые моменты: `EditorPanelManager` хранит pending ready prompt payload для rebooted panel и использует новый `bootId` при повторном открытии того же prompt, чтобы stale retained webview не зависал и не вел в дублирующую frozen вкладку; `promptDashboard` util-слой получил request-acceptance fallback для late same-prompt snapshot/widget payloads без активного нового request, а `EditorApp` логирует и применяет такие сообщения вместо прежнего жёсткого drop по `requestId` mismatch.
- Файлы:
  CHANGELOG.md
  README.md
  src/providers/editorPanelManager.ts
  src/utils/promptDashboard.ts
  src/webview/editor/EditorApp.tsx
  tests/editorPanelManager.test.ts
  tests/promptDashboard.test.ts

## 140: Убрать лимит в виджете активных промптов

- Дата: 2026-05-29.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: В виджете `Активные промпты` снято UI-ограничение на четыре строки в каждой группе активности, поэтому секции `Сегодня` и предыдущего активного дня теперь показывают все подходящие промпты без внутреннего усечения.
- Ключевые моменты: Лимит находился только в `PromptDashboard.tsx` и не затрагивал `PromptDashboardService`, который уже отдаёт полные `today/yesterday` массивы; добавлены component regression tests, которые фиксируют видимость пятой строки для обеих групп и защищают от возврата `slice(0, 4)`.
- Файлы:
  CHANGELOG.md
  README.md
  src/webview/editor/components/PromptDashboard.tsx
  tests/promptDashboardComponent.test.tsx

## 138: Показывать ошибку при получении опережающих файлов

- Дата: 2026-05-20.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: В виджете `Ветки проектов` ошибка действия `Получить` для опережающих upstream-изменений теперь сохраняется на уровне строки проекта и показывается под тем же проектом отдельной карточкой `Ошибка получения опережающих файлов` вместо пропажи после refresh.
- Ключевые моменты: `PromptDashboardService` хранит pull-action ошибки отдельно от branch-switch ошибок в scope-local map и подмешивает их в `PromptDashboardProjectSummary` через `decorateProjectsData()`, поэтому shared cache остаётся чистым; `PromptDashboard` рендерит отдельный inline error block с собственным заголовком для pull failure, а host flow `promptDashboardPullProject` по-прежнему делает widget-first refresh, чтобы ошибка приезжала через snapshot, а не через общий editor notice.
- Файлы:
  CHANGELOG.md
  README.md
  src/services/promptDashboardService.ts
  src/types/promptDashboard.ts
  src/webview/editor/components/PromptDashboard.tsx
  tests/editorPanelManager.test.ts
  tests/promptDashboard.test.ts
  tests/promptDashboardComponent.test.tsx
  tests/promptDashboardService.test.ts

## 137: Показать ветки всех авторов

- Дата: 2026-05-20.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Виджет `Параллельные ветки` перестал ограничиваться локальными cleanup-ветками и теперь показывает дополнительные ветки всех авторов из локальных head и уже fetched remote refs, сохраняет реальные Git ref для lazy hydration и открытия diff, а итоговый граф переделан в inline horizontal lane view прямо в строках веток, чтобы показывать ahead/behind без наложения на список и без смены цвета после раскрытия строки.
- Ключевые моменты: `GitService` теперь формирует отдельный список `parallelBranchCandidates` из локальных и remote веток без смешивания с Git Flow cleanup semantics; `PromptDashboardService` использует реальные ref и lightweight `ahead/behind` при display/details hydration параллельных веток; `PromptDashboard` рисует row-based lane graph с разной длиной сегментов по `ahead` и `behind`, держит цвет lane по типу ветки, а conflict state выводит отдельными row indicators, поэтому remote-only ветки остаются рабочими и визуально стабильными и после раскрытия.
- Файлы:
  CHANGELOG.md
  README.md
  src/services/gitService.ts
  src/services/promptDashboardService.ts
  src/types/git.ts
  src/webview/editor/components/PromptDashboard.tsx
  tests/gitService.test.ts
  tests/promptDashboardComponent.test.tsx
  tests/promptDashboardService.test.ts

## 136: Красная рамка для несоответствующих веток проектов

- Дата: 2026-05-19.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: В виджете `Ветки проектов` добавлена строгая визуальная индикация несоответствия ветке промпта: если проект выбран в промпте, у промпта задана Git-ветка и текущая ветка проекта не равна `prompt.branch`, select выбора ветки получает красную рамку.
- Ключевые моменты: `PromptDashboardService` теперь вычисляет явный `hasPromptBranchMismatch` только для проектов из `prompt.projects`, поэтому даже в режиме `Показать все` workspace-only строки не подсвечиваются; `PromptDashboard` применяет красный border только к select ветки и не меняет текущую логику Git Flow/start-chat preflight; добавлены focused regression tests на summary-state и SSR-render branch select.
- Файлы:
  CHANGELOG.md
  README.md
  src/services/promptDashboardService.ts
  src/types/promptDashboard.ts
  src/webview/editor/components/PromptDashboard.tsx
  tests/promptDashboard.test.ts
  tests/promptDashboardComponent.test.tsx
  tests/promptDashboardService.test.ts

## 134: Поиск по файлам и сохранение состояния

- Дата: 2026-05-15.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: В sidebar-поиск добавлен runtime-only полнотекстовый корпус по `plan.md`, `report.txt` и содержимому выбранного HTTP examples файла, а сохранение раскрытых секций редактора переведено на сериализованные мутации общей карты editor view state, чтобы блоки вроде `Файлы` не схлопывались после сохранения и переключения между промптами.
- Ключевые моменты: `StorageService` теперь строит `sidebarSearchText` при чтении/сохранении prompt config, обновляет кэш prompt list при изменениях `plan.md` и `report.txt`, и не записывает runtime поля обратно в `config.json`; `SidebarApp` ищет по этому корпусу без чтения файлов на каждый ввод; `StateService` сериализует `savePromptEditorViewState` и `migratePromptEditorViewState`, поэтому конкурирующие async write-path больше не теряют состояние других prompt sections; добавлены focused regression tests на sidebar search corpus и на lost-update сценарий editor view state.
- Файлы:
  CHANGELOG.md
  README.md
  src/services/stateService.ts
  src/services/storageService.ts
  src/types/prompt.ts
  src/webview/sidebar/SidebarApp.tsx
  tests/sidebarArchiveSearch.test.ts
  tests/stateService.test.ts
  tests/storageServiceSidebarSearch.test.ts

## 133: Зависание при создании MR/PR для всех

- Дата: 2026-05-14.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Исправлено зависание шага 4 окна Git Flow при действии `Создать MR/PR для всех проектов`; manager теперь помнит актуальный panel `postMessage` callback для overlay-сессии и при сбое reread после создания MR/PR переиспользует последний cached snapshot с optimistic review request.
- Ключевые моменты: `EditorPanelManager` на каждом `handleMessage` обновляет history callback-ов активной Git Overlay session, поэтому reread и fallback больше не теряют текущую панель; overlay session теперь хранит `lastSnapshot`, lazy other-project refresh поддерживает его в актуальном состоянии, а bulk/single create-review-request path при ошибке reread публикует cached `gitOverlaySnapshot` с наложенными review request-данными вместо вечного loader; добавлен focused regression test на fallback cached snapshot после сбоя reread, README/CHANGELOG и project feature memory обновлены.
- Файлы:
  .github/instructions/changelog.instructions.md
  .vscode/prompt-manager/chat-memory/feature.instructions.md
  CHANGELOG.md
  README.md
  src/providers/editorPanelManager.ts
  tests/editorPanelManager.test.ts

## 132: Кнопки коммита сразу в загрузке

- Дата: 2026-05-13.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Исправлено залипание loading-состояния у кнопок коммита на шаге 2 окна Git Flow после повторного открытия overlay; свежий snapshot теперь умеет отбрасывать устаревшие tracked commit-request, если коммит уже фактически завершён или старый pending-запрос очевидно устарел.
- Ключевые моменты: `EditorApp` получил helper `shouldPruneGitOverlayTrackedRequest()` и snapshot-side pruning для stale commit-request без вмешательства в актуальные in-flight операции; это не даёт шагу 2 наследовать ложный loading из предыдущей сессии overlay, но сохраняет реальный loading для свежих запросов; добавлены focused regression tests на чистый snapshot, недавний dirty snapshot и aged-out dirty snapshot, обновлены README/CHANGELOG и project memory note.
- Файлы:
  .github/instructions/changelog.instructions.md
  .vscode/prompt-manager/chat-memory/feature.instructions.md
  CHANGELOG.md
  README.md
  src/webview/editor/EditorApp.tsx
  tests/editorApp.test.tsx

## 131: Не учитывать время при статусе «Закрыт»

- Дата: 2026-05-13.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Закрытые промпты больше не получают автоматически вычисляемое `implementing`-время из background chat-session refresh, silent/manual recalc или позднего завершения чата; при этом ручная правка `Misc time` сохранена.
- Ключевые моменты: `EditorPanelManager` теперь замораживает derived implementing-time и не уводит prompt из `closed`, если поздний tracked completion или refresh приходит уже после закрытия; `EditorApp` перестал запускать silent/manual `recalcImplementingTime` для `closed`, а `TimerDisplay` скрывает кнопку пересчёта для закрытых промптов; добавлены focused regression tests на bucket-логику, host completion/recalc path и editor/UI guard.
- Файлы:
  src/providers/editorPanelManager.ts
  src/webview/editor/EditorApp.tsx
  src/webview/editor/components/TimerDisplay.tsx
  tests/editorPanelManager.test.ts
  tests/editorApp.test.tsx
  tests/timeTrackingService.test.ts
  README.md
  CHANGELOG.md
  .vscode/prompt-manager/chat-memory/feature.instructions.md

## 129: Автовыделение нового пункта

- Дата: 2026-05-12.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Исправлено автовыделение нового промпта в sidebar после нажатия `+ Новый`, когда открыта страница другого промпта; промежуточные refresh списка больше не могут перевести выделение на посторонний prompt до фактического сохранения нового черновика.
- Ключевые моменты: `SidebarApp` больше не вычисляет новый selected id по `первому id вне baseline`; optimistic row `__new__` захватывает стабильный `promptUuid` из host-события `promptSaving` и переключается на реальный saved prompt только после точного совпадения UUID в обновлённом списке; `sidebarSelection` util покрыт регрессионными тестами на сохранение optimistic selection, захват `promptUuid` и точный remap только на соответствующий persisted draft.
- Файлы: src/webview/sidebar/SidebarApp.tsx, src/utils/sidebarSelection.ts, tests/sidebarSelection.test.ts, README.md, CHANGELOG.md, .vscode/prompt-manager/chat-memory/feature.instructions.md.

## 130: Сброс скролла в поле «Результат работы»

- Дата: 2026-05-12.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Исправлен сброс скролла страницы редактора промпта и мерцание Process tab при наборе текста в блоке `Отчет` -> `Результат работы`; длинный отчет больше не возвращает страницу в начало из-за mid-edit autosave и не триггерит полный redraw промпта на каждом нажатии клавиши.
- Ключевые моменты: `RichTextEditor` получил режим blur-commit, где `report` changes остаются локальными во время ввода и отдаются наружу только после blur/явных действий; `EditorApp` перевёл поле `report` на этот режим, откладывает любой уже поставленный autosave, пока inline report editor держит focus или локальный draft, и больше не оставляет prompt в ложном dirty loop, когда save response возвращает тот же report; узкая проверка выполняется через `npm run test:compile && node --test out-tests/tests/editorApp.test.js out-tests/tests/richTextEditor.test.js`, а финальная сборка проходит через проектный compile script.
- Файлы: src/webview/editor/components/RichTextEditor.tsx, src/webview/editor/EditorApp.tsx, CHANGELOG.md, .github/instructions/changelog.instructions.md, .vscode/prompt-manager/chat-memory/feature.instructions.md.

## 128: Git Flow refresh and dashboard widget controls

- Дата: 2026-05-12.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Исправлено обновление шага 4 в окне `Git flow` после создания одного или нескольких MR/PR, в виджете `Коммиты проектов` автор теперь показывается сразу после short SHA, а полное сообщение коммита переносится на отдельную строку без UI-усечения, и у каждого dashboard-виджета появилась собственная кнопка обновления в header справа от счётчика.
- Ключевые моменты: `EditorApp` и `EditorPanelManager` выровняли `gitOverlayCreateReviewRequest` по tracked-request flow с `requestId`, текущими `promptBranch/projects` и scoped reread текущего overlay snapshot, поэтому step 4 перестал зависать после single/bulk create-review-request; `PromptDashboardService` открыл targeted refresh path для отдельных widget kinds, `PromptDashboard` добавил header refresh buttons и reuse shared `projects` refresh для `Ветки проектов` / `Коммиты проектов` / `MR/PR` / `Параллельные ветки`, а util `shouldClearPromptDashboardBusyActionFromWidget` теперь умеет снимать busy state после `refresh-widget:*`; focused host/component/util tests покрывают новый Git flow contract и dashboard UI/loader behavior.
- Файлы: src/types/messages.ts, src/webview/editor/EditorApp.tsx, src/providers/editorPanelManager.ts, src/services/promptDashboardService.ts, src/utils/promptDashboard.ts, src/webview/editor/components/PromptDashboard.tsx, tests/editorPanelManager.test.ts, tests/promptDashboardComponent.test.tsx, tests/promptDashboard.test.ts, README.md, CHANGELOG.md, .github/instructions/changelog.instructions.md, .vscode/prompt-manager/chat-memory/feature.instructions.md.

## 127: Задержка подтверждения запуска Copilot Chat

- Дата: 2026-05-12.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Исправлено ложное зависание шага `Открываем Copilot Chat`, когда Prompt Manager слишком рано показывал ошибку неподтверждённого запуска, хотя VS Code отдавал новую chat session или request marker немного позже первой проверки; host-логика теперь даёт короткое grace-окно на позднее подтверждение и покрыта регрессионным тестом.
- Ключевые моменты: `EditorPanelManager` после первичного confirmation timeout повторно проверяет поздно появившуюся активную chat session через `StateService.getActiveChatSessionId()` и делает короткий дополнительный poll `waitForChatRequestCompletion()` перед тем, как показывать пользователю timeout; успешная поздняя привязка по active session или tracked request activity больше не шлёт ложную ошибку и продолжает обычный bind/open flow; regression test фиксирует именно этот late-confirmation path.
- Файлы: src/providers/editorPanelManager.ts, tests/editorPanelManager.test.ts, README.md, CHANGELOG.md, .github/instructions/changelog.instructions.md, .vscode/prompt-manager/chat-memory/feature.instructions.md.

## 126: Эллипсис путей в незакоммиченных файлах

- Дата: 2026-05-10.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Исправлено сокращение путей в flat-строках блоков `Незакоммиченные файлы` и `Опережающие файлы` виджета `Ветки проектов`: теперь путь не укорачивается, пока помещается рядом с именем файла, а при нехватке места сегменты каталога сжимаются по реальной ширине строки и в первую очередь режутся самые длинные части пути.
- Ключевые моменты: `promptDashboard` util-слой теперь отдельно хранит normal path split и width-aware helper `fitPromptDashboardPathPartsToWidth()`, чтобы diff-title логика не зависела от UI compaction; `PromptDashboard.tsx` для flat incoming/dirty rows перешёл на runtime width measurement через `ResizeObserver` и canvas text measurement внутри row-local component, сохранив tree-view списки без изменений; focused util/component tests покрывают full-fit, longest-first shrink и SSR-safe rendering path.
- Файлы: src/utils/promptDashboard.ts, src/webview/editor/components/PromptDashboard.tsx, tests/promptDashboard.test.ts, README.md, CHANGELOG.md, .github/instructions/changelog.instructions.md, .vscode/prompt-manager/chat-memory/feature.instructions.md.

## 125: Добавить обязательные инструменты и автора

- Дата: 2026-05-09.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Start Chat теперь добавляет обязательную подсказку перед секцией `### Инструменты`, чтобы перечисленные Skills, MCP tools, hooks и preferred model воспринимались как обязательные инструменты задачи; дополнительно в видимом заголовке disclosure `Опережающие файлы` в виджете `Ветки проектов` теперь показываются авторы входящих upstream-коммитов, а открываемый diff сохраняет короткий понятный title с автором без длинного merge-base hash.
- Ключевые моменты: `chatMessageBuilder` использует новый локализованный ключ `chatMessage.toolsNote` и вставляет его перед списком инструментов; `GitService.getIncomingBranchAuthors()` собирает unique author list для диапазона `HEAD..@{upstream}`, `PromptDashboardService` прокидывает `incomingAuthors` в branch widget rows, `PromptDashboard.tsx` рисует заголовок `Опережающие файлы (author1, author2)`, а `EditorPanelManager` при открытии dashboard diff по-прежнему запрашивает latest file author через `GitService.getFileAuthorAtRef()` и собирает короткий title через `buildPromptDashboardFileDiffTitle()`; focused tests покрывают mandatory tools note, incoming authors и diff-title helper.
- Файлы: src/utils/chatMessageBuilder.ts, src/i18n/translations.ts, src/utils/promptDashboard.ts, src/services/gitService.ts, src/services/promptDashboardService.ts, src/providers/editorPanelManager.ts, src/webview/editor/components/PromptDashboard.tsx, src/types/promptDashboard.ts, tests/chatMessageBuilder.test.ts, tests/promptDashboard.test.ts, tests/gitService.test.ts, tests/promptDashboardService.test.ts, tests/promptDashboardComponent.test.tsx, README.md, CHANGELOG.md.

## 123: Clean excluded projects chat context

- Дата: 2026-05-08.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Start Chat now filters the `Excluded projects` chat section against the current workspace before sending the generated Markdown to Copilot, so stale excluded names that are no longer present as workspace folders do not leak into chat scope; a focused host-level regression test and user-facing docs were updated alongside the fix.
- Ключевые моменты: `EditorPanelManager` now resolves excluded project names through the same workspace scope helper used for visible prompt projects, but with `includeExcluded=true` and `fallbackToWorkspaceWhenSelectionInvalid=false`, which preserves only real excluded workspace folders without widening the list back to the full workspace; the regression test asserts the final start-chat query contains the surviving excluded project and omits a missing one.
- Файлы: src/providers/editorPanelManager.ts, tests/editorPanelManager.test.ts, README.md, CHANGELOG.md.

## 130: Dashboard pull action and incoming files

- Дата: 2026-05-07.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: В виджете `Ветки проектов` per-project action теперь переключается с `Применить` на зелёную кнопку `Получить`, если выбранная текущая ветка отстаёт от upstream, а под проектом показывается зелёный disclosure-блок `Опережающие файлы` со списком входящих upstream-изменений.
- Ключевые моменты: `GitService` получил helper для `HEAD..@{upstream}` diff с rename/numstat-метаданными, `PromptDashboardService` прокидывает `incomingFiles` и выполняет dashboard-only pull одного проекта, `EditorPanelManager` и `EditorApp` добавили typed message flow `promptDashboardPullProject` с widget-first refresh и background AI review, `PromptDashboard` переиспользует existing branch patch viewer для incoming rows и очищает `pull-project:*` busy state только после готового `projects` widget; focused tests покрывают git/service/host/component/util слои.
- Файлы: src/services/gitService.ts, src/services/promptDashboardService.ts, src/types/messages.ts, src/utils/promptDashboard.ts, src/providers/editorPanelManager.ts, src/webview/editor/EditorApp.tsx, src/webview/editor/components/PromptDashboard.tsx, tests/gitService.test.ts, tests/promptDashboard.test.ts, tests/promptDashboardService.test.ts, tests/editorPanelManager.test.ts, tests/promptDashboardComponent.test.tsx, README.md, CHANGELOG.md.

## 129: Branch widget readability, excluded chat scope, and desktop publish targets

- Дата: 2026-05-06.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: В dashboard-виджете `Ветки проектов` длинные project/file labels стали компактнее и понятнее, Start Chat теперь явно перечисляет `Исключенные проекты` как readonly-блок, а `.vscode/bash/publish.sh` публикует desktop VSIX для Linux, Windows и macOS вместо Linux-only потока; Web отдельно зафиксирован как пока не поддерживаемый runtime.
- Ключевые моменты: `promptDashboard` util-слой получил helper-ы для middle-ellipsis project names и сокращения intermediate path segments у dirty-file rows; `PromptDashboard.tsx` показывает path prefix отдельно от file name и обновляет branch widget после scoped file changes через `setTimeout(1000)` reactive path в `EditorPanelManager`; `chatMessageBuilder` и `EditorPanelManager` передают в Start Chat отдельный раздел `Excluded projects` с readonly note; `publish.sh` теперь итерирует desktop target matrix и prunes ONNX runtime payload под каждый target вместо удаления всех darwin/win32 assets заранее; README и CHANGELOG задокументированы, а host/component/unit tests покрывают новые dashboard и chat contracts.
- Файлы: src/utils/promptDashboard.ts, src/webview/editor/components/PromptDashboard.tsx, src/utils/chatMessageBuilder.ts, src/providers/editorPanelManager.ts, src/i18n/translations.ts, tests/promptDashboard.test.ts, tests/promptDashboardComponent.test.tsx, tests/chatMessageBuilder.test.ts, tests/editorPanelManager.test.ts, .vscode/bash/publish.sh, README.md, CHANGELOG.md, .github/instructions/changelog.instructions.md.

## 116: Скрывать закрытые промпты

- Дата: 2026-05-04.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Dashboard prompt editor обновлён так, чтобы `Активные промпты` скрывали closed-подсказки, `Ветки проектов` могли временно показывать все workspace-проекты через отдельный branch-only scope, dirty-file disclosure игнорировал path prefixes из `Prompt Manager › Git Overlay: Other Projects Excluded Paths`, нулевые `+0` / `-0` counters не рендерились, а `Параллельные ветки` скрывали уже гидратированные ветки без уникальных файлов.
- Ключевые моменты: `PromptDashboardProjectsData` получил отдельный `branchProjects` список только для branch widget, чтобы остальные dashboard cards оставались в prompt scope; `PromptDashboardService` собирает этот workspace-wide branch scope отдельным лёгким Git snapshot path с подробными dirty-file stats и одновременно отфильтровывает branch-widget uncommitted files по `otherProjectsExcludedPaths`; `PromptDashboard` по умолчанию оставляет branch widget prompt-scoped, переключает его на workspace rows только через локальный toggle `Показать все`, скрывает fully hydrated parallel rows без unique changes и больше не выводит нулевые `+0` / `-0` line-stat tokens; regression tests покрывают hidden closed activity rows, workspace-wide `branchProjects`, excluded-path filtering, show-all helper, zero-stat rendering и hidden empty parallel branches.
- Файлы: src/types/promptDashboard.ts, src/services/promptDashboardService.ts, src/webview/editor/components/PromptDashboard.tsx, tests/promptDashboardService.test.ts, tests/promptDashboardComponent.test.tsx, README.md, CHANGELOG.md, .github/instructions/changelog.instructions.md.

## 128: Keep hydrated parallel-branch rows stable when prompt branch is missing

- Дата: 2026-05-04.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Исправлено раскрытие строк в виджете `Параллельные ветки`, чтобы placeholder branch row не исчезал во время lazy details hydration, если `Ветка Git` промпта отсутствует в конкретном репозитории; заодно в `PromptDashboard.tsx` над `styles` добавлено более заметное описание групп inline-стилей.
- Ключевые моменты: `PromptDashboardService` выбирает base branch для parallel hydration только из реально доступных branch names текущего project snapshot, предпочитая `prompt -> tracked -> current` только если такая ветка действительно существует в проекте; display и details paths теперь используют один и тот же helper, поэтому opened row не схлопывается из-за пустого hydrated result; regression test покрывает сценарий отсутствующей prompt branch в проекте и подтверждает, что detail refresh остается на `main`; `PromptDashboard.tsx` получил явный блок-комментарий перед `styles` и дополнительные subgroup comments рядом с branch controls и AI review styles.
- Файлы: src/services/promptDashboardService.ts, src/webview/editor/components/PromptDashboard.tsx, tests/promptDashboardService.test.ts, README.md, CHANGELOG.md, .github/instructions/changelog.instructions.md.

## 127: Fix dirty disclosure routing after dashboard loading

- Дата: 2026-05-04.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Исправлен routing lazy hydration для `dirty:<project>` disclosure в prompt dashboard, чтобы правые line counters реально догружались через dedicated dirty path, даже если блок был открыт во время `projects` loading; заодно папки в shared file tree сделаны чуть тусклее по цвету.
- Ключевые моменты: `PromptDashboard` больше не отбрасывает dirty toggle key из-за пустого хвоста после `project` segment, переводит hydration expanded-blocks на effect после render и повторяет lazy hydrate для уже раскрытых commit/parallel/dirty секций после завершения widget refresh; regression test покрывает `resolveExpandedDetailsHydrationRequest('dirty:<project>')` и защищает dedicated route `dirty-files`.
- Файлы: src/webview/editor/components/PromptDashboard.tsx, tests/promptDashboardComponent.test.tsx, README.md, CHANGELOG.md, .github/instructions/changelog.instructions.md.

## 126: Speed up dirty-file counters and document dashboard file-row styles

- Дата: 2026-05-04.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Раскрытие блока `Незакоммиченные файлы` в prompt dashboard переведено на отдельный узкий dirty-only hydrate path, tracked line counters теперь собираются batched `git diff --numstat` по change groups, а в `PromptDashboard.tsx` добавлены описания style-групп и обновлена типографика/contrast status badges для file rows.
- Ключевые моменты: `PromptDashboard` передает в `hydratePromptDashboardProjectsDetails` причину `dirty-files`, чтобы `EditorPanelManager` и `PromptDashboardService` запускали новый mode `dirty-details`; этот mode использует `GitService.getGitOverlayProjectSnapshot` без branch/review/recent-commit hydration и merge-ит только свежие dirty-file данные обратно в cached project row; `GitService.getChangeGroups(includeDetails: true)` теперь батчит tracked numstat lookup на весь merge/staged/working-tree group вместо отдельных git diff вызовов на каждый файл; regression tests покрывают и dirty-only refresh path, и batched numstat enrichment.
- Файлы: src/types/messages.ts, src/webview/editor/EditorApp.tsx, src/webview/editor/components/PromptDashboard.tsx, src/providers/editorPanelManager.ts, src/services/promptDashboardService.ts, src/services/gitService.ts, tests/promptDashboardService.test.ts, tests/gitService.test.ts, README.md, CHANGELOG.md, .github/instructions/changelog.instructions.md.

## 125: Narrow dashboard file-detail hydration and reuse cached review state

- Дата: 2026-05-04.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Гидрация commit / parallel / dirty file lists в prompt dashboard стала project-scoped, а follow-up AI review теперь переиспользует уже загруженный MR/PR state вместо повторного review CLI прохода по тем же репозиториям.
- Ключевые моменты: `PromptDashboard` и `EditorApp` передают в `hydratePromptDashboardProjectsDetails` конкретный список раскрытых проектов; `PromptDashboardService` умеет частично обновлять только эти проекты и merge-ить result обратно в общий projects widget cache без full details refresh по всем workspace repos; `loadProjectsData('details')` больше не тащит review state, а `loadProjectsData('analysis')` подсовывает `prefetchedReviewStatesByProject` из свежего projects cache, чтобы follow-up AI review не повторял дорогие `gh`/`glab` запросы; regression tests покрывают и project-scoped details refresh, и reuse cached review state.
- Файлы: src/types/messages.ts, src/webview/editor/components/PromptDashboard.tsx, src/webview/editor/EditorApp.tsx, src/providers/editorPanelManager.ts, src/services/promptDashboardService.ts, tests/editorPanelManager.test.ts, tests/promptDashboardService.test.ts, README.md, CHANGELOG.md, .github/instructions/changelog.instructions.md.

## 124: Restore dirty-file counters with lazy hydration

- Дата: 2026-05-04.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Для disclosure-блока `Незакоммиченные файлы` возвращены правые line counters через existing lazy `details` hydration path, а spacing и контраст flat file rows дополнительно поджаты и усилены по screenshot feedback.
- Ключевые моменты: `PromptDashboardService` больше не просит `includeChangeDetails` на обычном `display` refresh и включает его только в `details` mode, поэтому первый paint остаётся лёгким; `PromptDashboard` теперь триггерит `hydratePromptDashboardProjectsDetails` и при раскрытии `dirty:` block, если у tracked/staged/working-tree файлов ещё нет `additions/deletions`; flat dirty-file rows используют цветной status badge вместо блеклого file glyph, вторичные подписи читаются контрастнее, а интервалы между файлами и папками в shared tree renderer ещё уменьшены.
- Файлы: src/services/promptDashboardService.ts, src/webview/editor/components/PromptDashboard.tsx, tests/promptDashboardService.test.ts, README.md, CHANGELOG.md, .github/instructions/changelog.instructions.md.

## 123: Improve dashboard file-row readability

- Дата: 2026-05-04.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Повышена читаемость списка незакоммиченных файлов и остальных file-tree rows в dashboard: шрифт и иконки увеличены, вертикальные интервалы стали компактнее, а шумные `—` для неизвестных dirty-file stats убраны из disclosure list.
- Ключевые моменты: `PromptDashboard` расширяет `DashboardFileTreeEntry` флагами для плоских file rows без branch prefix и для скрытия unknown line stats; dirty-files disclosure продолжает использовать shared clickable file-row renderer с `open diff`/highlight, но без лишних префиксов и без `work`-style noise; общие tree/file-row styles получили более крупную типографику и иконки при меньшем `minHeight`, чтобы на реальном screenshot UI читался лучше.
- Файлы: src/webview/editor/components/PromptDashboard.tsx, tests/promptDashboardComponent.test.tsx, README.md, CHANGELOG.md, .github/instructions/changelog.instructions.md.

## 122: Polish dashboard branch-widget warning cards

- Дата: 2026-05-04.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: В `Ветки проектов` ошибки переключения веток и уведомление о незакоммиченных файлах оформлены как отдельные outline-блоки, а раскрытый список dirty files теперь использует тот же clickable file-row UI, что и остальные dashboard file trees.
- Ключевые моменты: `PromptDashboard` больше не показывает плоский список dirty files с непонятной меткой `work`; disclosure block теперь рендерит существующие dashboard file rows с `open diff`, `открыт`/`просмотрен` highlight и правыми `+ / ~ / -` line stats, заголовок `Незакоммиченные файлы` получил более яркий warning accent, а untracked/conflict file status badges в shared file-row tone mapping теперь читаются понятнее.
- Файлы: src/webview/editor/components/PromptDashboard.tsx, tests/promptDashboardComponent.test.tsx, README.md, CHANGELOG.md, .github/instructions/changelog.instructions.md.

## 121: Show branch-switch errors and dirty files inside dashboard branch widget

- Дата: 2026-05-03.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: В виджете `Ветки проектов` теперь показываются ошибки переключения веток прямо под полем нужного проекта, а при наличии локальных незакоммиченных файлов отображается раскрываемое предупреждение со списком файлов.
- Ключевые моменты: `PromptDashboardService` хранит per-project ошибки переключения веток локально на уровне dashboard scope и накладывает их поверх projects widget без загрязнения shared projects cache; project summaries теперь содержат список `uncommittedFiles` из `merge/staged/working-tree/untracked` change groups; `PromptDashboard` показывает под селектором ветки branch-switch error и disclosure block `Незакоммиченные файлы`, а regression tests покрывают и mapping ошибок к project row, и рендер нового уведомления.
- Файлы: src/types/promptDashboard.ts, src/services/promptDashboardService.ts, src/webview/editor/components/PromptDashboard.tsx, tests/promptDashboard.test.ts, tests/promptDashboardService.test.ts, tests/promptDashboardComponent.test.tsx, README.md, CHANGELOG.md, .github/instructions/changelog.instructions.md.

## 120: Prefer current tracked branch in dashboard project widget

- Дата: 2026-05-03.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Исправлено определение `tracked`-ветки в виджете `Ветки проектов`, когда в настройке `Prompt Manager › Codemap: Tracked Branches` указано несколько веток и текущая ветка проекта уже входит в этот список.
- Ключевые моменты: `PromptDashboardService` теперь берёт список tracked-веток из Codemap settings с тем же fallback, что и остальной Git/Codemap flow, а при отсутствии explicit tracked override предпочитает текущую ветку проекта, если она уже есть среди tracked-веток; добавлен regression test на сценарий `master` + `develop`, где проект уже стоит на `develop`, чтобы виджет не закреплял `master` как единственную tracked-ветку только из-за порядка в настройке.
- Файлы: src/services/promptDashboardService.ts, tests/promptDashboardService.test.ts, README.md, CHANGELOG.md, .github/instructions/changelog.instructions.md.

## 119: Align dashboard toolbar with prompt form header

- Дата: 2026-05-03.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Верхний toolbar правого dashboard prompt editor визуально выровнен по горизонтали с header-кнопками над формой промпта.
- Ключевые моменты: `PromptDashboard` теперь начинает rail с того же верхнего padding, что и header формы (`12px` вместо `16px`), поэтому иконка `pm`, заголовок `Обзор` и кнопка refresh больше не выглядят опущенными относительно кнопок в header слева; логика и размеры самих header action buttons не менялись.
- Файлы: src/webview/editor/components/PromptDashboard.tsx, README.md, CHANGELOG.md, .github/instructions/changelog.instructions.md.

## 118: Fix prompt dashboard progress fallback after agent sync

- Дата: 2026-05-03.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Исправлено расхождение между progress bar в списке промптов и карточке `Статус промпта` в dashboard prompt editor для in-progress промптов, у которых `agent.json` уже содержит runtime progress, а `config.json` ещё не хранит поле `progress`.
- Ключевые моменты: `syncPromptDashboardStatusFromPrompt` теперь умеет переиспользовать самый свежий percent из уже загруженного status snapshot или explicit runtime override вместо fallback `50` для `in-progress`; `EditorApp` передаёт этот режим во все status-widget reconciliation paths (`promptAgentProgress`, полный snapshot, widget patch, локальные prompt edits); добавлен regression test на реальный сценарий `config.json` без progress и `agent.json` со значением `100`.
- Файлы: src/utils/promptDashboard.ts, src/webview/editor/EditorApp.tsx, tests/promptDashboard.test.ts, README.md, CHANGELOG.md, .github/instructions/changelog.instructions.md.

## 117: Runtime progress sync для status widget prompt dashboard

- Дата: 2026-05-03.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: В prompt editor карточка `Статус промпта` теперь обновляется не только от локальных полей prompt и dashboard snapshot/widget сообщений, но и от runtime-поля `progress` в `agent.json`, когда агент меняет его вне обычного сохранения `config.json`.
- Ключевые моменты: `EditorPanelManager` подписывается на `**/agent.json`, дебаунсит внешние изменения и шлёт в webview отдельный message `promptAgentProgress`, не подменяя весь prompt payload; `EditorApp` применяет этот runtime progress только в status-widget reconciliation path, чтобы не записывать transient `agent.json` значение обратно в prompt config, а входящие dashboard snapshot/widget сообщения продолжают переиспользовать тот же override до следующего normal prompt open; добавлен host-level regression test на watcher sync и обновлены README/CHANGELOG.
- Файлы: src/providers/editorPanelManager.ts, src/types/messages.ts, src/webview/editor/EditorApp.tsx, tests/editorPanelManager.test.ts, README.md, CHANGELOG.md, .github/instructions/changelog.instructions.md.

## 116: Доработка dashboard prompt editor: статус, tracked-ветки и размер бренд-иконки

- Дата: 2026-05-03.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: В правом dashboard prompt editor бренд-иконка над виджетами выровнена по размеру с header action button формы, `Tracked-ветка` в виджете `Ветки проектов` больше не создаёт отсутствующую локальную ветку автоматически, а карточка `Статус промпта` теперь синхронизируется сразу по локальным изменениям статуса и времени и не откатывается от более поздних snapshot/widget сообщений.
- Ключевые моменты: `PromptDashboardService` отделяет tracked-targets от prompt-branch/direct branch targets и отправляет их через no-create путь `GitService.switchBranchesByProject`; `GitService` для tracked dashboard switch сначала пытается local/remote checkout и при отсутствии ветки возвращает ошибку вместо `checkout -b`; `EditorApp` локально пересобирает `status` widget из текущего `prompt` и повторно применяет эту синхронизацию при входящих `promptDashboardSnapshot` и `promptDashboardWidgetSnapshot`, чтобы асинхронные обновления не перетирали более свежий статус; `PromptDashboard` теперь автоматически вычищает только те `branchDrafts`, которые после refresh уже совпали с новой текущей веткой или стали невалидными, поэтому поля в `Ветки проектов` возвращаются к фактической current branch после bulk/preset apply, а кнопка `Ветка промпта` деактивируется, если у промпта не задана `Ветка Git`; README и CHANGELOG обновлены под новую UX-логику dashboard.
- Файлы: src/services/gitService.ts, src/services/promptDashboardService.ts, src/utils/promptDashboard.ts, src/webview/editor/EditorApp.tsx, src/webview/editor/components/PromptDashboard.tsx, tests/gitService.test.ts, tests/promptDashboard.test.ts, tests/promptDashboardComponent.test.tsx, tests/promptDashboardService.test.ts, README.md, CHANGELOG.md, .github/instructions/changelog.instructions.md.

## 115: Обновить иконки расширения: панель, маркет, README

- Дата: 2026-05-03.
- Автор: 🅰️🅻🅴🅺.
- Ветка: master.
- Что сделано: Обновлены брендовые иконки расширения: для Marketplace, README и About подготовлен новый color master asset с компактным lowercase pm wordmark и подчеркивающим accent-bar, а для Activity Bar и panel tabs подготовлен отдельный monochrome currentColor SVG в том же новом визуальном языке.
- Ключевые моменты: `media/icon.svg` и `media/icon-marketplace.svg` хранят редактируемый цветной мастер, `media/icon.png` пересобирается из цветного SVG при обновлении брендинга, `package.json`, README и showcase используют этот PNG, `media/sidebar-icon.svg` остаётся source of truth для Activity Bar container и webview panel tabs, а новая геометрия намеренно опирается на компактный lowercase pm wordmark и короткий underline-accent ради малых размеров.
- Файлы: media/icon.svg, media/icon-marketplace.svg, media/icon.png, media/sidebar-icon.svg, README.md, CHANGELOG.md, .github/instructions/changelog.instructions.md, .vscode/prompt-manager/chat-memory/feature.instructions.md.

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