# Changelog

All notable changes to this project are documented in this file.

Unreleased changes are grouped by the date they landed. Tagged releases remain grouped by version and release date.

## [Unreleased]

### 2026-11-21

#### Added
- Click a Quick Notes row to preview its description, checklist, and attachment names.
- Choose a color in the Quick Notes add field. The widget remembers it for subsequent notes.

#### Changed
- Move Add and Search into the Quick Commands header and show the search field on demand.
  The agent dropdown shows the selected name on wide cards and a chat icon on narrow cards.

#### Fixed
- Keep the Quick Notes draft open when switching between project and global notes. The switch is on the right of the color palette.
- Dismiss a Quick Notes preview when focus leaves the editor and show keyboard focus on the custom color swatch.
- Align Git Flow with the right-hand widgets panel after resizing the editor or moving the divider.
  Keep a 16 px right margin and let the dialog expand left to fit the projects table with at least 16 px at the left edge.
- Quick Commands now resolves Current from an expanded Codex, Claude Code, or built-in chat sidebar
  in VS Code 1.96 and later, including desktop connections through a Tunnel.
- Limit Current to the widget's window when editor tabs are detached. Preserve the clipboard when
  Copilot accepts a draft in a private input model. Discard expired insert requests on delayed connections.
- Preserve categories if renaming or deleting a command fails. A command re-added without a category
  after deletion by an older client now stays uncategorized.

### 2026-11-20

#### Added
- Quick Commands supports categories, drag and keyboard reordering within each category, a copy action,
  and a deletion confirmation. Command order and categories are shared across workspaces.
- The Current agent option uses an identifiable built-in VS Code chat. If the target is ambiguous, the command
  is copied for manual paste when the clipboard is available. Select OpenCode CLI explicitly.

#### Fixed
- Keep the new-note field expanded during recording and background transcription. Append the result to the draft
  and return the caret to the end of the text.
- Keep the Quick Commands agent selected across prompts and editor tabs. Focus the Codex composer
  for local X11 paste and allow drafts in the existing OpenCode CLI terminal after automatic submission.
- Keep the global quick command list readable by older clients by storing category metadata separately.
  Confirm built-in chat insertion from the composer and release the command row if insertion or its reply times out.
- Resolve the Current agent from a visible Codex or Claude Code editor tab in VS Code Desktop.
- Show the status label alongside progress in the expanded Prompt Status widget.
- `/alek-review` показывает замечания до формы выбора и оставляет ход активным, пока ожидается асинхронный ответ.
- Clear keeps the new-note field open and focused. Cancel discards the draft and collapses it outside dictation.
  Note menu items fit on one line. A nonempty checklist with no description follows a colon after the title.
  Regenerating a checklist suggestion shows progress immediately.
- Startup waits up to ten seconds for the providers needed by each operation. A pending Copilot startup
  leaves the other account sections available.
- Ignore extra saved dashboard columns, keep command drafts attached to their original row, and preserve
  locally counted Copilot usage when a shared snapshot is read again.
- Keep an early microphone pause in effect and remove attachment copies when note duplication fails.
- В строке состояния Codex и Claude Code убраны сокращения режима. Цвета темы VS Code отображают
  расход квоты одинаково в режимах «Использовано» и «Осталось».
- Лупа в быстрых заметках управляет поиском и фильтром по цвету. «Сохранить» идёт первой кнопкой,
  а после голосового ввода курсор возвращается в поле новой заметки. Сокращено ожидание захвата
  микрофона и коррекции расшифровки.
- Двойной щелчок по быстрой команде готовит черновик в выбранном чате. «В работе» показывается одной
  шкалой. Изменённые файлы открывают сравнение нужной группы без ожидания списка SCM. Шаг 2 Git Flow
  выделяет постороннюю ветку красным по правилу шага 1.
- Поле новой заметки сворачивается после сохранения. Копирование включает название, отличающееся
  описание и чек-лист. Ctrl+ЛКМ выделяет несколько заметок для групповых действий из меню ПКМ.
- Сборка обновляет все настроенные установки VS Code Tunnel, по одной на реестр расширений.
  Список целей можно проверить перед сборкой без записи.
- Quick Notes bulk actions show the number of selected notes, including color changes and deletion.
- Codex, Claude Code, and GitHub Copilot share quota snapshots across sessions of the same user on one host.
  While one extension host refreshes a provider, the other hosts skip that provider's refresh.

### 2026-11-19

#### Added
- Для статус-баров Codex и Claude Code добавлена подсветка при достижении любой квоты:
  предупреждение от 60% использовано / 60% осталось и ниже, критический уровень
  от 90% использовано / 10% осталось и ниже. Используются стандартные цвета
  предупреждения и ошибки темы VS Code и контрастный цвет текста.
- Виджет «Быстрые команды»: глобальные редактируемые фразы с быстрым поиском и выбором чата;
  Copilot и адресный OpenCode CLI поддерживают вставку без отправки, Codex и Claude Code —
  безопасное копирование с открытием чата для ручной вставки.
- Поле новой заметки разворачивается поверх списка, с выбором области и кнопкой сохранения
  внутри, голосовым вводом и неизменной высотой виджета.
- Контекстное меню заметки по правой кнопке: редактирование, закрепление, копирование текста
  с подсветкой активного содержимого буфера, дублирование вместе с файлами, цвет и удаление.
- Окно заметки копирует описание или название вместе с чек-листом; перегенерация AI
  запоминает отклонённые ранее предложения.
- Свёрнутый виджет «Статус промпта» показывает текущий статус и компактную шкалу прогресса;
  «Git flow» у кнопки коммита указывает текущую ветку проекта.

#### Fixed
- Скрытые виджеты исключаются из загрузки данных; скрытые «Быстрые заметки» прекращают
  получать сообщения состояния до повторного показа.
- Поиск быстрых заметок и Docker перенесён под лупу в шапке; действующие сохранённые
  фильтры автоматически открывают поле, чтобы избежать невидимой фильтрации.
- Исправлены дублированные элементы голосового ввода и добавлены проверки корректного
  дублирования файлов заметки и хранения отклонённых AI-предложений.
#### Fixed
- Страница «Аккаунты» больше не показывает режим «Использовано», если Webview уже обновлена,
  но серверный процесс Extension Host был запущен до обновления расширения. Вместо этого
  показывается фактический прежний режим «Осталось», переключатель отключён и появляется
  предупреждение о необходимости перезагрузки окна после завершения задач агентов.
- В статус-барах Codex и Claude Code добавлена явная пометка исп. / ост.
  Режим совпадает с глобальной настройкой страницы «Аккаунты».

#### Added
- В верхней части страницы «Аккаунты» появился переключатель «Использовано / Осталось».
  По умолчанию показывается использованный процент лимита (100 - оставшаяся квота).
  Режим сохраняется глобально через application-scope настройку
  `promptManager.accounts.limitDisplayMode` и применяется к квотам и прогресс-барам
  Codex/Claude/Copilot и статус-барам Codex/Claude без новых запросов к сервисам.
- Страница «Аккаунты» показывает блоки Codex, Claude Code и GitHub Copilot только при наличии
  соответствующих расширений. Добавлены независимые профили Claude Code и ручное переключение.
- В статус-баре отображаются лимиты активных аккаунтов Codex и Claude Code.
  Устаревшие данные Claude не показываются как текущие.
- Добавлен локальный сборщик официальных данных statusLine после ответов Claude Code, без чтения OAuth-токенов.
  Его можно отключить настройкой `promptManager.claude.statusLineCollector` или командой
  «Удалить сборщик statusLine Claude Code»: снимается только запись Prompt Manager, собственный statusLine
  пользователя не меняется.
- В строках сброса лимитов Codex и Claude, а также кредитов Copilot показывается,
  сколько дней, часов и при необходимости минут осталось до сброса; пересчёт раз в минуту
  работает локально без новых запросов к провайдерам.
- При открытии страницы «Аккаунты» по центру вкладки показывается анимированный индикатор
  загрузки в цветах темы VS Code, с учётом reduced motion. После получения данных
  индикатор исчезает; при ошибке появляется кнопка «Повторить».
- На странице «Аккаунты» в блоке GitHub Copilot добавлен прогресс-бар кредитов: процент использования,
  количество использованных и доступных кредитов, ориентир следующего месячного периода и отметка
  расчётных данных при отсутствии прямой статистики GitHub. Используется существующий CopilotUsageService.
- В окне быстрых заметок можно выбрать файлы прямо с локального ПК через браузерный Remote Tunnel
  и перетащить их на блок «Файлы». Бинарные данные пересылаются блоками по 512 КиБ
  с проверкой размера/порядка, отдельным выбором файлов Ubuntu и прогрессом загрузки.
- Во время AI-генерации названия в конце поля названия показывается компактный лоадер:
  состояние приходит от сервера для всех открытых окон, после ответа (или ошибки) лоадер скрывается.
- Меню «⋯» рядом с кнопкой обновления панели «Обзор»: список всех виджетов с отметкой видимых; снятая отметка
  скрывает виджет, «Показать все» возвращает все. Скрытый виджет не загружает данные, как свёрнутый.
  Настройка `promptManager.dashboardPreferences.hiddenSections` общая для рабочих областей и передаётся Settings Sync.
- На доске заметок поле новой заметки после добавления остаётся для следующей и закрывается, когда фокус уходит
  в другое место доски; неотправленный текст сохраняется, Escape очищает его.

#### Changed
- Лимиты Codex запрашивает только окно VS Code в фокусе (или кнопка «Обновить»); остальные окна показывают
  общий результат, устаревшие значения отмечены «≈» и пометкой в подсказке.
- Инструкции ревью (`/alek-review`, `/alek-review-MR`) проверяют, что комментарии, документация,
  отчёты, сообщения коммитов и описания PR и MR написаны от лица разработчика, без упоминаний ИИ
  и агентов; найденные места выводятся замечанием `[Info]` с нейтральной заменой. Общая инструкция
  явно запрещает подписи `Co-Authored-By` и «Generated with …» от агентов и включает эту проверку
  в ревью своей работы и финальную проверку.

#### Removed
- Индикатор GitHub Copilot в статус-баре заменён индикаторами Codex и Claude Code; удалены его команда
  «Authenticate for Copilot Usage» и настройка `promptManager.copilotStatusBar.enabled`. Кредиты Copilot
  показываются на странице «Аккаунты».

#### Fixed
- Fixed duplicate prompt folders after concurrent saves and renames. Refreshing the list keeps the selected
  folder when older copies share its UUID.
- Preserved the latest edit during a rename, made legacy configuration updates atomic, and kept read-only
  prompts visible. New and imported prompts inherit the destination's access policy. Archived prompts retain
  their own history when folder names are reused, and imported history preserves the copy's Claude session binding.
- Обновление лимитов Claude теперь получает данные от официального CLI `/usage` раз в 5 минут,
  без отправки промпта модели и без собственных HTTP-запросов Prompt Manager к Anthropic.
  Общий на весь Ubuntu/VS Code Tunnel кэш и атомарная межпроцессная блокировка гарантируют,
  что из 4–5 открытых проектов проверку выполняет одно окно; другие читают его результат.
  При ошибках есть backoff, таймаут и резервный локальный кэш.
- Проверка `/usage` выполняется в постоянном рабочем каталоге и больше не создаёт новый каталог
  в `~/.claude/projects` при каждом запуске; оставшиеся пустые каталоги прежних проверок удаляются.
- Запрос лимитов Codex больше не приводит к повторному входу: токены, обновлённые при запросе,
  возвращаются в `~/.codex/auth.json` того же аккаунта, если файл за это время не менялся.
  Временные каталоги с копиями авторизации, оставшиеся после аварийного завершения, удаляются при запуске.
- Профили Codex и Claude Code общие для всех окон VS Code: профиль, добавленный или выбранный в одном окне,
  не теряется при обновлении страницы «Аккаунты» в другом, активный аккаунт Codex определяется по файлу авторизации.
- Индикатор Codex появляется сразу после установки расширения Codex; без него профили Codex не создаются.
- Закрытие терминала входа сразу завершает подключение аккаунта Codex или Claude Code, повторное
  «Добавить» доступно без ожидания таймаута. Путь к Claude CLI определяется при каждой проверке лимитов.
- «Отмена» в подтверждении выбора аккаунта больше не блокирует кнопки «Выбрать» на странице «Аккаунты».
- На странице «Аккаунты» добавлена собственная вертикальная прокрутка на всю высоту вкладки:
  общий Webview ранее запрещал прокрутку через `overflow: hidden`.
- Повторное сохранение из окна быстрой заметки больше не удаляет вложение, которое при прошлом сохранении
  получило суффикс из-за совпадения имени.
- У глобальной быстрой заметки ссылка на промпт не снимается в рабочей области, где этого промпта нет;
  промпт с тем же id, но другим UUID не открывается вместо связанного.
- AI-название новой заметки применяется в открытом окне без ложного предупреждения о конфликте,
  если название не менялось вручную; набранное описание сохраняется.
- Файлы быстрых заметок очищаются по жизненному циклу: удалённые несохранённые вложения сразу
  удаляются с сервера; сохранённые файлы удаляются после «Сохранить», при удалении заметки
  удаляется её папка вложений, а при отказе от правок очищается .pending.
- На доске заметок исправлено перетаскивание: сетка использует последовательный порядок
  по строкам, карточка видна рядом с курсором, текст не выделяется; перетаскивание
  выполненных заметок также обновляет порядок.
- Высота поля «Описание» сохраняется глобально в настройке
  promptManager.dashboardPreferences.quickNotes.descriptionHeight через Settings Sync.
- При удалении связанного промпта ссылка сразу снимается с заметки через StorageService.
- Статус-бар Claude Code показывает последние известные проценты с пометкой ≈ вместо полного скрытия, а сброшенные окна — как неизвестные.

### 2026-11-18

#### Added
- Длинная первая строка при добавлении быстрой заметки переносится в описание полностью;
  AI автоматически предлагает короткое название без задержки сохранения и без перезаписи ручных правок.
- Виджет «Быстрые заметки» в панели «Обзор» на странице промпта: заметка добавляется вводом и Enter
  (Ctrl+Enter — с открытием окна), заметки рабочей области хранятся в `.vscode/prompt-manager/quick-notes.json`,
  глобальные — в `~/.vscode/prompt-manager/quick-notes.json`; обе области показываются одним списком со значком.
  Цвет, отметка выполнения, описание, чек-лист, файлы (копии в `quick-notes-files/`), перенос порядка,
  блок выполненных, поиск и фильтр по цвету.
- Окно заметки с черновиком и «Сохранить / Отмена»: переход между заметками, предупреждение о конфликте
  с другим окном VS Code, плитки файлов с превью и плиткой «+», AI-предложение нового пункта чек-листа
  с перегенерацией и правкой, «В промпт» — черновик промпта без открытия редактора со ссылкой из заметки.
- Доска заметок на отдельной вкладке редактора: стикеры, фильтры, группировка по цвету и области, добавление
  на доске, перенос мышью и клавиатурой со сменой цвета или области. Изменения сразу видны в виджете и на доске.
- Новые application-настройки вида `promptManager.dashboardPreferences.quickNotes.*` и сворачивания
  `promptManager.dashboardLayouts.*.collapsed.quickNotes`; передаются через Settings Sync.

#### Fixed
- Выбранный вид плана «Краткий / Полный» сохраняется для каждого промпта отдельной записью по UUID и идентификатору
  промпта: старые снимки расположения блоков и события закрытия не возвращают «Полный», копия папки с тем же UUID
  не наследует чужой выбор, а переименование обычным сохранением в редакторе переносит выбор вместе
  с состоянием редактора.
- Метка совместимости страницы редактора и расширения обновлена: если файлы расширения обновлены на месте
  без перезагрузки окна (сборка при разработке, синхронизация Tunnel), страница сообщает о необходимости
  перезагрузки, а не теряет выбранный вид плана незаметно.

### 2026-11-17

#### Added
- Added a Compact / Full toggle to the Process tab's Plan header. Compact mode keeps Markdown headings and
  checkbox items with their original completion markers and nesting, hiding explanatory text and code blocks.
  New prompts now default to Compact, with each prompt's choice saved and restored independently.
  Existing stored states without a view choice continue to use Full; switching never edits the plan file.
  Compact mode now retains at most one existing blank line before a section heading.
  The general instructions now define self-contained checklist titles, indented multi-line details and
  acceptance criteria, with examples of how the same plan looks in Full and Compact views.
- Задача 173: на странице промпта ширину формы и виджетов можно менять разделителем — мышью, пером, касанием
  или клавиатурой (стрелки, Shift, Home/End); Enter и двойной щелчок возвращают автоматическую ширину.
  Доля ширины сохраняется глобально в application-настройке `promptManager.editor.panelSplitRatio`, общая для всех
  промптов и обеих вкладок, и передаётся через Settings Sync. Минимумы панелей сохранены; разделитель занимает
  промежуток 18 px (в покое — едва заметная линия с отступами по 8 px), поэтому виджеты уходят под форму при ширине
  меньше 638 px вместо 632 px. Изменение размера окна настройку не записывает. Во время перетаскивания колонки виджетов
  не перестраиваются и данные виджетов не перезапрашиваются — перестроение происходит один раз после отпускания.

#### Changed
- Общая инструкция требует максимально точных ответов без введения в заблуждение: выводы по задаче
  соответствуют подтверждённым фактам, а вопросы и варианты ответа точно описывают выбор и его последствия.
- Общая инструкция требует продуманных и оптимизированных автоматических тестов, чтобы полный набор
  выполнялся быстро: без фиксированных пауз, лишних обращений к внешним ресурсам и избыточной подготовки данных.
  Скорость не достигается исключением необходимых сценариев или ослаблением проверок.

### 2026-11-16

#### Added
- Задача 171: целевой чат «Opencode CLI» открывает новый интерактивный терминал на Linux-хосте,
  передаёт файлы через штатный IDE-протокол и сохраняет редактируемый черновик.
  Независимый автостарт выключен по умолчанию; однократная отправка подтверждается экспортом точной сессии.
  Переход и остановка изолированы от Copilot; инструкция Plan/Agent не меняет модель или разрешения OpenCode.
  Исправлен конфликт IDE-порта с Claude Code в Tunnel: окружение задаётся непосредственно процессу CLI.
  Готовность не зависит от необязательных режимов терминала; таймаут сохраняет терминал открытым.
  Частичная перерисовка имён файлов и перенос метки длинной вставки больше не блокируют подготовку текста.
  Каждый файл и текст промпта вставляются с новой строки, включая свёрнутый длинный текст.
  Старые ручные подтверждения не очищают план нового запуска; полная длинная вставка корректно определяется после прокрутки.
  Терминал и сессия используют формат «Номер | Название»; сессия переименовывается после первой подтверждённой отправки.
  Переименование не задерживает подтверждение отправки и не теряет его при последующем закрытии терминала.

#### Fixed
- Задача 172: Git Flow использует только уже активное Kilo Code. При отсутствии или неактивности расширения
  генерация переходит к внутреннему AI без запуска Kilo и ожидания его активации.
  Порядок: активное Kilo → внутренний генератор → штатный Copilot. Выключенный AI, отсутствие модели,
  пустой ответ или ошибка LM переводят запрос к Copilot; шаблонный текст больше не скрывает отсутствие результата.
  Ошибки контекста и обязательных инструкций не обходятся резервной командой. Внутренний успех не использует SCM.
  Предварительный полный сбор заменён проверкой staged; компактный контекст небольших файлов кода
  собирается только для включённого внутреннего генератора. Без кода используется минимальный текстовый набор.
  Добавлены замеры этапов; штатная команда Copilot продолжает самостоятельно собирать свой контекст.
  Исправлено чтение объектов text/file из инструкций коммита внутренним генератором, добавлены scope проекта
  и номер задачи. Убран повторный запрос каталога резервных моделей; выбор модели и отмена Copilot журналируются отдельно.
  Каталог поля «Модель ИИ», Memory и Git Flow прогревается при активации без блокировки редактора.
  Общий кеш объединяет одновременные загрузки и переиспользует объекты моделей, в том числе после истечения
  краткосрочного кеша выбранной модели. Изменение каталога или GitHub-аккаунта обновляет кеш и открытые списки.
  Поздние ответы прежнего аккаунта отбрасываются; пустые/ошибочные загрузки имеют ограниченные фоновые повторы.
  Бесплатный fallback проверяет точный provider/id; холодный/неполный каталог сохраняет адресный и полный поиск.
  Исправлен output-фильтр, скрывавший события model-catalog: прогрев и попадания в кеш видны с debugLogging.
  Staged-тексты предварительно загружаются параллельно без показа вкладок для повторного использования Copilot.
  Подготовка ограничена временем, числом и объёмом файлов; отмена запрещает поздний запуск команды.
  Групповая генерация запускает выбранные проекты параллельно, сохраняя порядок генераторов внутри проекта,
  независимость ошибок и соответствие cleanup tokens. Имена с test без учёта регистра исключаются
  только из собственного контекста; штатные Copilot и Kilo выбирают контекст сами.
  Test-файлы возвращены в предварительную загрузку Copilot, чтобы не оставлять их медленному последовательному чтению.
- Recognize VS Code's internal `mainThreadWebview-` tab type when removing duplicate prompt editors,
  including restored tabs in vscode.dev remote tunnels. Regression tests now model the actual tabs API
  and cover startup, late restoration, and unrelated webviews with identical titles.

### 2026-11-15

#### Added
- Задача 170: перестановка разделов на обеих вкладках промпта, отдельный блок «Статусы» и естественная
  сортировка списка по номеру задачи; пустые номера остаются в конце в обоих направлениях.
- Задача 170: добавлен начальный режим «Номер задачи + Дата создания» по возрастанию;
  одинаковые номера уточняются датой создания. Сохранённый выбор сортировки имеет приоритет.
- Порядок разделов, раскрытие вкладки «Основное» и настройки виджетов сохраняются глобально
  в пользовательских настройках VS Code и участвуют в Settings Sync. Раскрытие «Процесса» сохраняет прежние правила.
  Профили одной/двух колонок независимы; предусмотрены перенос прежних значений и обновление открытых окон.

#### Fixed
- Задача 170: последняя вкладка сохраняется сразу при выборе и восстанавливается после закрытия промпта;
  устранена отправка предыдущей вкладки при очистке страницы. Заголовки приближены к ручке,
  эффекты переноса разделов совпадают с виджетами.
- Задача 170: устранён цикл открытия при разных cache-метках уже работающего host и обновлённого webview.
  Метка совместимого интерфейса сохранена; попытка перезагрузки assets ограничена одной на панель.
- Задача 170: явный сброс глобальной настройки больше не возвращает старое workspace-значение.
  Поздний отказ записи не отменяет новый выбор; раскрытые виджеты продолжают обновляться
  после ошибки сохранения и внешнего изменения настроек.


### 2026-11-13

#### Added
- Задача 169: карточка при наведении на промпт показывает номер задачи, название, статус и полный Markdown-текст
  с прокруткой. Работает в обоих режимах списка и архивном поиске, поддерживает клавиатуру и Escape.
  Чтение не создаёт отчёты и не меняет конфигурацию; запоздавшие ответы не подменяют другую карточку.
  Номер задачи выделен жирным шрифтом и основным цветом текста карточки для читаемости в разных темах.
- Запуск Codex внутри Copilot из Prompt Manager подготавливает отдельную сессию с Full Access
  до отправки задачи. Разрешения проверяются через локальный Agent Host; общие настройки и другие чаты не меняются.
  Поддерживается Linux с AHP 1.1. При ошибке отправка отменяется, а полный текст сохраняется в буфере обмена.
- OpenAI Codex в VS Code Web, в том числе через туннель: полный текст задачи сохраняется в файл `task.md`
  в папке промпта и прикрепляется к новому чату штатной командой Codex; для запуска остаётся нажать «Отправить».
  Файл стоит первым в списке файлов чата. Первый запуск после загрузки окна повторяет прикрепление в течение 15 секунд,
  потому что ещё не загруженная панель Codex сбрасывает файлы. Текст также копируется в буфер обмена, при отказе команды
  остаётся ручная вставка. Вставка текста в поле на desktop не изменена; установленный Codex не модифицируется.

#### Changed
- Начальный вид списка: название по возрастанию, группировка по статусу, краткий режим.
  Ранее сохранённые настройки остаются в силе.
- Локально включаемая синхронизация после compile копирует сборку в обычную серверную папку Prompt Manager.
  Сохраняются путь Extension Host, зависимости и метаданные платформы; предусмотрены резервная копия и откат.
- Task 168: the prompt form shrinks to 300 px while keeping dashboard widgets visible; below 632 px,
  widgets move under the form in one vertical scroll area. Narrow controls wrap without changing the selected view.

#### Fixed
- Запуск OpenAI Codex в VS Code Web больше не останавливается на шаге открытия чата, когда браузер не завершает
  запись в буфер обмена: запись ожидается не дольше 2 секунд, а сообщение упоминает копирование только после её подтверждения.
- Шаг открытия Copilot отделён от ожидания привязки сессии. Kilo после Add to Context больше
  не ожидает лишнюю запись в буфер браузера. Xdotool не запускается в Web и удалённых окнах.
  OpenAI Codex в Web больше не выдаёт неподдерживаемую программную вставку за успешную;
  автоматическое заполнение поля в установленной версии Codex остаётся недоступным.
- Task 168: persist Docker/ToDo preferences and scoped Git disclosures in workspace state, preserve independent
  layout profiles, and prevent delayed prompt-open messages from replacing newer widget settings.
  Failed writes report an error without disabling refresh of visibly expanded widgets; bootstrap uses confirmed state.
  Preserve Process scroll across layout transitions, wrap narrow ToDo labels, and prevent queued Docker statistics
  from restarting after hide/dispose. Existing topology refresh remains unchanged.
  Await accepted dashboard writes before replacing the editor so reopening cannot erase a completed collapse change.
- Кнопка обновления списка перечитывает папки промптов и пересоздаёт кеш вместо повторного показа
  старого снимка из памяти. Устаревшие строки исчезают даже при пропущенных файловых событиях;
  параллельное обновление и запоздавшее чтение не возвращают их обратно.
- Переключение промптов сохраняет правки, поступившие во время записи; ошибка сохранения оставляет черновик открытым.
- Фоновая генерация названия не перезаписывает ручное сохранение номера задачи и текста.
- Список отбрасывает устаревшие чтения и ответы, учитывает внешние изменения сразу после локальной записи
  и восстанавливает открытие переименованного промпта по UUID при работе нескольких окон, включая туннель.
  Кеш списка заменяется целым JSON, чтобы параллельные записи не оставляли частичный файл.
- Локальный запуск Codex в Ubuntu корректно подключается к Unix-сокету Agent Host при включённой
  HTTP-обёртке VS Code. Соединение больше не перенаправляется на HTTP-порт localhost;
  ошибки подключения показывают безопасный системный код или HTTP-статус без токена авторизации.

### 2026-11-12

#### Changed
- Общая инструкция требует нейтрального изложения документации и бизнес-правил:
  при обновлении сразу убираются ссылки на переписку и происхождение материала,
  а затронутые предложения перерабатываются с проверкой грамматики, полноты смысла и связности.
  Технические факты, полномочия и предметные термины сохраняются.
- Одноколоночный и двухколоночный режимы панели виджетов отдельно сохраняют порядок карточек
  и их свёрнутое/раскрытое состояние. При изменении ширины и повторном открытии редактора
  восстанавливаются настройки соответствующего режима; прежние общие настройки сохраняются как исходные.
- Фоновое обновление виджетов учитывает сворачивание текущего режима отображения.

#### Fixed
- Раскрытые при смене режима виджеты догружают отсутствующие данные даже при свежем кеше.
- Пустая колонка сохраняет положение в двухколоночной сетке и принимает карточки при перетаскивании.

### 2026-11-10

#### Fixed
- Исправлено отсутствие реакции на перетаскивание виджетов в VS Code при смешанном вводе:
  нажатие и отпускание определяются как `mouse`, а движение — как `pen` с другим `pointerId`.
  Жест мыши дополняет `pointermove` совместимым `mousemove`; касания и перо привязаны к исходному указателю.
- Исправлено перемещение виджетов на узкой странице промпта: когда колонки расположены друг под другом,
  место вставки определяется по обеим координатам указателя. Перенос в нижнюю колонку больше не выбирает верхнюю.

### 2026-11-01

#### Changed
- Shared instructions require interactive questions in every agent mode, including post-review decisions.
  Agents select an allowed synchronous, asynchronous, or equivalent form instead of falling back to text
  when a single tool is unavailable; unavailable forms leave required decisions pending.

### 2026-10-29

#### Changed
- Пакет расширения `.vsix` больше не включает папку `share/` с шаблонами инструкций: расширение не читает
  эти файлы, а общая инструкция по умолчанию по-прежнему загружается по ссылке с GitHub.

### 2026-10-20

#### Added
- Открытие промпта и изменение выделения в списке сохраняют текущую задачу в
  `.vscode/prompt-manager/task-active.json`: идентификатор, UUID, номер задачи, название, признак архива
  и абсолютный путь к папке промпта (`promptDirectory`), учитывающий архив и переименование.
  Запись не блокирует редактор; быстрые переключения сохраняют последний выбор, а новый несохранённый
  промпт или снятие выделения записывают `null` вместо номера предыдущей задачи.

#### Fixed
- Git Flow: после генерации tracked-ветка между `🅰️🅻🅴🅺` и `|` заменяется непустым номером задачи,
  если отличается от ветки промпта. Правило одинаково для Kilo, Copilot и внутреннего генератора;
  остальной текст, ручные сообщения и безопасная очистка Source Control сохраняются.

### 2026-10-14

#### Fixed
- Git Flow: the "Push branches for all projects" button no longer spins forever after a successful push. The push
  completion is now reported before the final overlay snapshot, so the spinner is released by that snapshot.

### 2026-10-12

#### Added
- **Task167 (partial):** Added a Claude Code target that opens prepared text through
  the native sidebar. Agent/Plan are text instructions; Claude's model and permissions stay unchanged.
- After manual sending, an exact UUID marker binds the session under separate `claudeChat` state. Reopening verifies
  the exact bound session, and renaming uses the public Claude Agent SDK `0.3.234`. End-to-end validation is pending.

#### Fixed
- Claude launches and bound-session reopening now use `editor.open` with `honor-preferred-location` instead of
  forcing a primary editor tab. The sidebar preference is saved before opening, preserving its workspace/global scope.
- Claude Xdotool auto-send remains safety-blocked even when enabled: an active tab or matching PID cannot prove
  composer focus, and Enter could reach a terminal. The notice requests manual sending; stopping a request is manual
  inside Claude and does not invoke Copilot stop commands.
- Claude timing accepts only proven final `turn_duration` records. Unsupported compaction, queued commands, or
  multiple final records preserve previously saved time instead of estimating it.

### 2026-10-08

#### Fixed
- Starting a prompt with the `Не изменять` model into a Codex (Agent Host) chat now explicitly reselects the
  model remembered for that chat type, the same way as picking it manually. This reduces the chance that a new
  Codex chat starts through the Copilot provider and fails with "The requested model is not supported".
- A new Codex (Agent Host) chat started from a prompt now always opens in Agent mode, including prompts saved
  with Plan mode, so it no longer ends up in Ask mode. If `chat.newSession.defaultMode` is not configured, the
  launch sets it to `agent` in user settings: in a new Codex chat Agent mode appears only after Ask is selected,
  and VS Code reapplies this setting when the mode list changes.
- The Process tab "Chat launch" block no longer stays on "Open Copilot Chat" forever when the chat session
  cannot be detected for binding (for example, agent-host sessions), after the editor is hidden, or after
  the prompt is reopened. The block now finishes once no launch is being tracked.

### 2026-09-29

#### Fixed
- Dashboard file changes now refresh affected projects, including new and deleted untracked files,
  while filtering excluded paths, limiting background refresh frequency, and coalescing events during active work.
- Unrelated events no longer discard queued widget updates, and revealing a prompt editor refreshes its task progress.
- Root-only Compose discovery now supports grouped glob patterns, character ranges, and symbolic links to files
  without recursively searching the workspace.

### 2026-09-22

#### Fixed
- Copilot Chat startup now skips selection-resolution calls for the `Не изменять` option, so launching a prompt
  reaches the chat composer instead of waiting indefinitely during the opening step.

### 2026-09-21

#### Added
- Added a per-prompt Copilot Chat autostart flag in the Agent section. Disabling it places the prepared
  prompt in the selected Copilot input without submitting it, while the existing Xdotool flag remains
  limited to external chat targets.

#### Fixed
- Starting OpenAI Codex now opens a new chat, attaches real context files, and pastes the prepared prompt
  into the composer through Xdotool instead of routing it through the internal Implement TODO action. The
  external-chat autostart flag controls submission. Xdotool input is no longer treated as confirmed delivery,
  so the saved plan and request-start state remain intact until Codex exposes a verifiable command result.

### 2026-09-15

#### Fixed
- Saving a prompt no longer replaces a positive `timeSpentImplementing` already stored in `config.json` with a stale zero, including status-only saves, renames, and archiving, without counting the preserved time again in daily statistics.

### 2026-09-14

#### Fixed
- Git Flow now clears a matching Kilo/Copilot-generated Source Control input only after React acknowledges the applied field value, accumulates concurrent multi-project acknowledgments, and preserves newer user input and internal fallback text.

### 2026-09-05

#### Fixed
- Automatic prompt-title completion now clears its loading state in the current editor after a webview reload, prompt reopen, or folder rename, and ignores stale pending state from an earlier ready cycle.

### 2026-09-04

#### Changed
- Shared workflow instructions now keep the generated project schema inside one marker-delimited section of `project.instructions.md`, preserve all user-authored sections outside it, reject malformed or concurrent updates, and limit only the managed section to 300 lines and 30,000 Unicode code points.
- `CHANGELOG.md` is no longer treated as mandatory full-project context and is consulted only through targeted history searches when needed.
- Concurrent `CHANGELOG.md` entries from independent tasks are now treated as normal collaborative updates: each task preserves unrelated entries, rebases its minimal patch on the latest target section, and stops only for an incompatible edit or Git conflict markers affecting its own entry or insertion point.

### 2026-08-28

#### Fixed
- Project branch file counters now remain visible across lightweight and reactive refreshes, stop automatic detail retries after errors, hydrate changed workspace-only rows precisely, complete collapsed hydration requests, and isolate project ordering from unrelated widgets.
- The Docker table `running` filter now excludes stopped or undeployed service rows, keeps raw created containers startable, and shares active lifecycle semantics with aggregate counters, row actions, and workspace actions.
- Git Flow commit-message generation now explicitly activates Kilo Code, applies one 75-second lifecycle deadline, waits for asynchronously opened nested repositories, invokes the real SCM command for the deepest root, keys queue quarantine by normalized root, handles same-result and delayed writes through a cleared input sentinel, restores drafts after empty failures, and keeps the latest response valid across snapshot ordering.

### 2026-07-26

#### Added
- The final prompt statistics table now shows miscellaneous tracked time in a sortable `Other` column and includes its total in the footer.
- A new `Export XLS` action saves the currently filtered and sorted eight-column statistics table as a real `.xlsx` workbook through the VS Code save dialog.

#### Changed
- Statistics duration labels now follow the active webview locale, while XLSX text cells remain explicit text values to prevent spreadsheet formula interpretation.
- The final statistics table now fits all eight columns into its available width, uses tighter horizontal cell padding, and truncates long prompt titles with an accessible full-text tooltip.
- The `Ветки проектов` widget now labels an existing prompt branch as `промпт, есть` in each project selector without changing missing-branch creation or shared branch availability.

### 2026-07-22

#### Fixed
- HTML statistics metadata cards now keep hour mode, period, generated date, large hour totals, rates, and amounts inside their boundaries on wide and narrow documents.

### 2026-07-21

#### Changed
- The `Docker контейнеры` dashboard widget now moves every table-row command into a vertical-ellipsis menu so long names receive more space, collapses container, Compose, and declared-service cards to one lifecycle row, and renders CPU, RAM, and network history as three compact charts inside expanded list details while hidden metrics no longer keep live polling active.
- Statistics exports now use actual tracked time for the selected period when `Hours` is blank, display that period in HTML and Markdown previews/exports, and preserve explicit positive scaling plus the existing zero-hours hidden mode.
- Regular and Quick Add prompts now reuse every saved chat-launch field from the most recently updated prompt instead of carrying over only one field.

#### Fixed
- Docker table action menus now stay open while focus moves from the vertical-ellipsis trigger into the menu, close reliably after focus leaves, and no longer show a misleading non-interactive ellipsis in the table header. Menu commands now use VS Code-native hover, pressed, and keyboard-focus feedback while disabled commands remain visually inactive.
- The `Активные промпты` widget now refreshes after the durable daily-time write completes, coalesces consecutive saves, and no longer rereads stale time immediately after prompt save.

### 2026-06-29

#### Added
- Added a prompt-dashboard `ToDo` widget that scans selected workspace projects for `todo` and `//?!?` markers, groups matches by project, file type, file and line, provides persisted file-type/search filters, and opens the source file directly at the matched line.

### 2026-06-26

#### Fixed
- Prompt Manager AI model pickers now use the full GitHub Copilot Chat picker catalog instead of free-only or Copilot-only model lists: prompt editor, Project Memory, and CodeMap settings include visible Custom Endpoint/OpenRouter/BYOK models such as Tokenator, Qwen, and GPT-OSS, include Copilot models hidden from the VS Code picker defaults, and preserve selected external model identifiers for internal Memory/CodeMap requests.

### 2026-06-11

#### Added
- The prompt-page `AI Models` picker now offers a `Do not change` option at the top of the list. When selected, starting a chat keeps whatever model is already active in the chat — Prompt Manager skips applying or persisting any model and does not inject a `Preferred model` line.

#### Fixed
- The prompt-page `AI Models` picker now excludes session-scoped models that VS Code binds to a specific chat session type (`targetChatSessionType`, such as the `copilotcli` and `claude-code` providers). The public `vscode.lm.selectChatModels()` API returns these models without exposing `targetChatSessionType`, so they previously leaked into the list as bare ids (for example `claude-sonnet-4.6`) even though VS Code keeps them out of the general model picker; they are now filtered using cached model metadata.
- The prompt-page `AI Models` picker now resolves the correct VS Code `state.vscdb` before filtering hidden models: when several candidate databases exist (custom profiles, or an Extension Development Host running against a fresh user-data dir), it now picks the database that actually carries `chatModelVisibility` picker state instead of the first existing file, and also scans per-profile databases. The sqlite read is also `-readonly` with a timeout so opening the picker can no longer hang on a WAL-locked database.
- The prompt-page `AI Models` picker now reliably hides models whose whole provider section is hidden in the VS Code model picker, even when version separators differ: hidden ids persisted with dashes (for example `claude-sonnet-4-6`) are now matched against live/cached models that report dotted ids (`claude-sonnet-4.6`), so BYOK providers hidden as an entire section (such as Anthropic or OpenRouter) no longer leak back through live model results that fail to resolve to a cached entry.

### 2026-06-10

#### Fixed
- The prompt-page `AI Models` picker now mirrors the promoted Copilot Chat model picker list instead of flattening the whole model catalog: it keeps pinned/current/recent/featured models plus the same remaining visible entries, restores full Custom Endpoint identifiers such as Tokenator from VS Code's cached model catalog when the live LM API omits them, and keeps provider-scoped models hidden in the VS Code picker from leaking back through live model results, cached entries, or the saved-current-model fallback.

### 2026-06-05

#### Changed
- The prompt editor now treats Kilo Code and OpenAI Codex as external chat targets: the prompt page hides the Copilot-only `AI Models` picker for those targets, keeps `Chat Mode` visible, shows a per-prompt `Autostart chat via Xdotool` checkbox, and Start Chat reflects the selected mode in external chat payloads and task messages.

### 2026-06-02

#### Fixed
- The `Docker контейнеры` dashboard widget now tracks Docker action loaders independently from the shared dashboard busy state, so several quick start/stop/restart/compose clicks keep loaders on each clicked icon and their widget refresh payloads are no longer dropped by a newer Docker request id.

### 2026-06-01

#### Changed
- Added a new `promptManager.ai.enabled` setting that defaults to `false`, so Prompt Manager internal AI generations and analyses stay opt-in; when it remains disabled, built-in AI prompt actions, memory analysis, codemap refresh jobs, and voice post-correction skip AI requests.
- Changed `promptManager.memory.enabled` and `promptManager.codemap.enabled` defaults to `false`, so Project Memory history analysis and CodeMap instructions are also opt-in for new workspaces unless explicitly enabled.

#### Fixed
- Start Chat now checks the current `promptManager.memory.enabled` and `promptManager.codemap.enabled` values at runtime, so disabled Project Memory history and CodeMap no longer generate or attach session/codemap instruction files, and stale `chat-memory/codemap.instructions.md` files are skipped when CodeMap is off.
- Restored `promptManager.editor` webviews are now revived through a registered serializer, rebound to the live singleton editor panel, and reopened with the persisted prompt identity from webview state, so VS Code session restore no longer leaves a stale duplicate prompt tab where saves hang while a second tab works.
- Prompt-dashboard card dragging now uses pointer events instead of native HTML5 drag/drop, so widget reordering no longer depends on fragile webview `drop` delivery and commits reliably when the pointer is released.

### 2026-05-31

#### Changed
- Reworked the Marketplace README into a short bilingual overview with a stronger hero, compact value proposition blocks, a smaller visual tour, and a clearer quick-start path so the extension is easier to understand at a glance.

#### Fixed
- The `Docker контейнеры` dashboard widget now requests Docker stats snapshots without `one-shot`, so Linux Docker daemons keep `precpu` counters and live CPU percentages no longer get rounded down to a constant `0%` under load.
- The `Docker контейнеры` dashboard widget now normalizes CPU usage to a host-wide `0..100%` scale instead of Docker CLI's multi-core sum, so busy single containers no longer show values above `100%` in the dashboard UI.
- The `Ветки проектов` dashboard widget now reuses already loaded prompt-project rows when it widens branch visibility to all workspace repositories, so the shared `projects` refresh fetches fresh Git snapshots only for missing repositories instead of repeating the selected-project snapshot.
- Post-action AI review for `Получить` and `Переключить` now reuses the preceding reactive branch-row refresh and skips a second targeted project snapshot before the background review starts, so those actions settle faster while the review catches up.
- The `Ветки проектов` dashboard widget now keeps manually chosen but unapplied branch targets across widget refreshes and `Показать все` scope changes until refreshed Git data confirms the branch became current, so background refreshes no longer reset pending switch choices.
- Collapsed prompt-dashboard cards now keep their refresh work truly paused until reopen: shared Git `display` refreshes stop updating hidden sections such as `Параллельные ветки`, and direct dashboard AI-review requests are skipped while the `AI review` card stays collapsed.
- The `Docker контейнеры` dashboard widget now moves the table disclosure control into the first column, lets the container name toggle the same details block, removes the extra leading compose icon from container rows, keeps only the one-line container name in the table title with ellipsis for long values, moves the `project/compose/container` path into the bottom of expanded details as `Контейнер: ...`, keeps running container titles brighter than stopped ones, and renders the same live resource bars plus history chart inside expanded table details.
- The `Docker контейнеры` dashboard widget now keeps Docker search text, status filter, and sort order in persisted webview state, shows a clear-search button whenever the field is non-empty, no longer leaves stale inactive declared-service rows visible after filtering compose groups by search, still finds non-running containers even when the host compose-group payload only lists active rows, switches the `Запущено` summary-tile action to a workspace-wide restart whenever containers are already running, keeps the restore-previous action only when no container is running, stops running workspace containers via `docker compose down` for compose-managed groups plus reverse-order standalone stops while remembering them, restores the remembered compose services and standalone containers after a VS Code restart, and repaints Docker widget state faster after external `docker start/stop/restart` commands by keeping the Docker Engine event stream alive without the old idle timeout and automatically reconnecting it after close/error.

### 2026-05-30

#### Added
- Added a `Docker контейнеры` prompt-dashboard widget that discovers root-level workspace Docker Compose files outside configured Excluded Paths, matches local containers through Compose labels, serves cached Docker Engine API snapshots with CPU, memory and network metrics for running containers, supports tree/card/table/list views with filtering and sorting, remembers the selected view and expanded containers, groups all modes by project, keeps compose files and declared services visible even when no containers exist, opens logs and `docker exec` terminals, exposes start, restart, stop and safe stopped-container removal as transparent icon-only row actions, and adds hidden compose-file `up`, `down`, and `restart` orchestration buttons with per-button loaders and inline compose errors.
- Added `promptManager.docker.*` settings for enabling the widget, compose-file discovery patterns, refresh and stats intervals, cache TTL, default view mode, terminal shell and remove confirmation.

#### Changed
- The `Docker контейнеры` dashboard widget now reuses a persisted workspace snapshot immediately when discovered Compose files have the same content hash, refreshes live Docker state in a parallel background pass, raises the default Docker widget cache TTL to five minutes, renders tree mode with branch-guided collapsible project and compose-file rows while moving CPU, memory and network metrics into the expanded container details block for running containers only, shows declared compose services plus play actions in every view when no Docker container exists yet, adds a table `project/compose` column with an icon, shows dashes for stopped containers in table metrics, uses play/stop glyphs for compose `up`/`down` and stopped-container start actions, shows compose-file lifecycle badges, and disables `down` plus `restart` when the compose file has no running containers.
- Prompt-dashboard cards can now be collapsed from their header with a workspace-shared persisted state instead of a per-prompt setting; collapsed sections hide their body and widget refresh button, and the host skips snapshot refresh, widget refresh, lazy hydration, and AI review work for those hidden cards.
- Prompt-dashboard cards can now be reordered by dragging the handle in each section header; the new card order is shared across prompts in the workspace, persists through prompt switches and webview reloads, shows a visible drop indicator while a card is moving, and now preserves the exact visible column placement after drop instead of rebalancing cards into another position.
- Prompt-dashboard drag handles now use a higher-contrast visible button treatment so the `Перетащить виджет` affordance is easier to spot in widget headers.

#### Fixed
- The `Docker контейнеры` dashboard widget now seeds its very first prompt-dashboard paint from a persisted workspace snapshot only when the current root-level Compose files still match the cached content hash, primes its own Docker refresh immediately in the background instead of waiting for the generic dashboard timer, and keeps list mode visually grouped by compose file so each container row stays attached to the correct compose entry.
- The Docker widget no longer flashes `Docker Engine API недоступен` from the startup placeholder before the real Docker refresh starts, and disabled Docker action icons now use the IDE disabled foreground while active icons follow the current theme foreground.
- The Docker widget now shows loaders on exact container action icon buttons, keeps compact card titles visible even when Docker names are missing, exposes compose start/restart/stop plus open-file icon buttons in card, list, table and tree modes, and renders table mode as a flat `project/compose/container` list with compact status icons instead of project grouping.
- The Docker widget now renders container lifecycle status in dense tree and table rows as smaller square outlined play/stop glyphs, and tree disclosure buttons stay aligned to the container title line instead of drifting to the vertical middle of two-line rows.
- Docker dashboard actions now keep their request-scoped loader until the matching widget refresh lands, release stale dashboard request ids after completed widget payloads so background Docker refreshes are no longer dropped, reopen Docker logs in a dedicated terminal instead of a temporary editor document, wait briefly for start/stop/restart/up/down state changes to become visible before unlocking the widget, refresh running-container CPU/RAM/network metrics through a lightweight stats-only background pass every second by default, keep table-mode CPU/RAM cells on the same live stats path, and fix table sorting plus stopped/running status filtering so active transitional states no longer leak into the wrong filter bucket.
- Docker RAM metrics now display as MiB values instead of percentages, switch to GiB with two decimals above 1000 MiB, keep one decimal below 10 MiB plus whole-number rounding otherwise, and running compose cards in card view now show compact aggregate CPU/RAM totals.
- Expanded Docker container details now keep a five-minute CPU/RAM/network trend window, reuse the existing stats polling cadence, stretch the chart across the full available row width, render network history as a fixed bright orange top-layer line, downsample through stable absolute time buckets so historical points stop reshuffling on each refresh, reset chart continuity after long hidden-state pauses instead of reusing stale sample joins, stop live Docker stats polling while the corresponding resource block is hidden or collapsed, and defer full widget refreshes caused by external Docker changes until the Docker widget is expanded again.
- Refreshing any non-branch prompt-dashboard widget no longer disables controls inside `Ветки проектов`; only actual branch mutations lock those buttons and selects.
- Saving a prompt no longer auto-generates or overwrites `Description`; the field is now updated only through the explicit manual AI generation action.
- Prompt save and switch flows now preserve newer local edits that arrive during an older in-flight save, and prompt reopen can resolve a pending saved snapshot by `promptUuid` even if the prompt id changes during the same switch.
- Internal `plan.md` and `report.txt` writes no longer bounce through the external prompt-config watcher path, so self-authored support-file saves stop reapplying stale storage state back into the editor.
- The prompt-page `AI Models` picker now keeps its delayed ready-cycle retry bound to the active prompt identity instead of the exact in-memory prompt object, so a slow first model fetch no longer leaves the dropdown stuck on `Auto` plus the raw saved model id.
- Prompt Manager AI-model dropdowns now prefer the current VS Code `chat.modelsControl` catalog before stale legacy cached model lists, so prompts and memory/settings pickers stop resurfacing outdated entries such as older `GPT-4.1` / `Raptor mini` standard-model catalogs when the modern cache is temporarily unavailable.
- Switching GitHub Copilot accounts from `Copilot Premium Usage` now clears Prompt Manager's short-lived AI-model caches and re-broadcasts model options to open prompt and memory pickers with delayed retries, so account-specific model availability stops sticking to the previous account after the Copilot catalog catches up.
- Reopening the currently visible prompt now rebuilds the singleton editor webview with a fresh boot cycle and replays the exact `prompt(open)` payload on the next `ready` handshake, so stale restored prompt tabs stop drifting into frozen duplicate pages.
- Prompt dashboard snapshot and widget updates now accept late same-prompt payloads after a reused snapshot when no newer request is active, so branch and activity cards keep refreshing after compact or hidden transitions instead of getting stuck on stale data.
- Reopening a collapsed prompt-dashboard card now immediately issues the correct full or targeted refresh when that card is the first visible section again and its data is still empty, stale, or errored, so expanding a hidden widget no longer leaves it blank until some unrelated dashboard refresh happens.
- Widget-level dashboard refresh now keeps the loading spinner scoped to the clicked card even for shared Git-backed sections, auto-expand refresh reuses that same section-level indicator, and disabled branch-action buttons keep a stable bordered height instead of visually collapsing when they become inactive.
- Prompt-dashboard cards now start from the persisted shared collapsed state on the very first editor paint instead of flashing open before the host message arrives, the first reopened Git-backed card on a fully collapsed page now bootstraps from its own widget payload instead of forcing a full shared `projects` refresh for the other still-collapsed Git cards, and the editor plus host now emit focused expand-refresh debug traces that also pass the Prompt Manager output filter so that first reopen path can be diagnosed from logs.
- Shared Git-backed dashboard cards no longer reuse a skipped collapsed `projects` snapshot as if it had already been refreshed in the current open cycle, so reopening `Ветки проектов`, `Коммиты проектов`, `Параллельные ветки`, or `MR/PR` now triggers the expected first expand refresh even when older shared project data was still warm in cache.
- Shared Git-backed dashboard cards now track which individual section actually loaded inside the shared `projects` payload, so refreshing `Параллельные ветки` no longer makes `Ветки проектов`, `MR/PR`, or `Коммиты проектов` look preloaded before their own first refresh.
- The first reopened Git-backed card no longer loses its own targeted widget refresh to a competing automatic full dashboard snapshot request, so expanding `Ветки проектов` from a fully collapsed page now refreshes immediately instead of waiting for a later card open.
- Prompt-dashboard card dragging now accepts drops in the empty gap between cards and below the last card inside a column, so releasing the pointer slightly outside a widget body still commits the nearest visible reorder slot instead of silently snapping the card back to its old position.

### 2026-05-29

#### Fixed
- The `Активные промпты` dashboard widget no longer trims the `Сегодня` and previous active day groups to four rows, so every qualifying prompt remains visible in the card.

### 2026-05-20

#### Changed
- The `Параллельные ветки` dashboard widget now renders each branch row with an inline horizontal lane graph, so behind distance stays visible on the left, ahead distance stays visible on the right, and the graph no longer collides with the branch list layout.

#### Fixed
- The `Ветки проектов` dashboard widget now completes branch switch, tracked-branch apply, and single-project `Получить` flows through targeted lightweight row refreshes, so the visible widget updates immediately without replaying a full projects snapshot and keeps the previous heavy project data mounted while the refresh lands.
- Post-action dashboard AI review now rerenders only the affected project rows instead of repeating a full `projects` refresh, and multi-project branch switching reuses bounded parallel Git mutations plus a single local/remote branch availability lookup per checkout path.
- The `Ветки проектов` dashboard widget now keeps a project-scoped inline error card under the same row when the green `Получить` action fails, so pull errors for incoming upstream changes stay visible after the widget refresh instead of disappearing into a filtered editor notice.
- The `Параллельные ветки` dashboard widget no longer limits itself to local cleanup branches; it now includes already fetched remote-only branches from other authors, preserves the real Git ref during lazy hydration and diff opening, and keeps those remote branch rows stable through the lightweight and detailed refresh path.
- The `Параллельные ветки` lane graph now keeps its branch-kind color stable before and after row expansion; conflict hydration still updates the row warning indicators, but no longer recolors the graph itself.

### 2026-05-19

#### Fixed
- The `Ветки проектов` dashboard widget now marks only the branch select with a red validation border when a selected prompt project is on a different current branch than the prompt Git branch, while workspace-only rows shown through `Показать все` stay neutral.

### 2026-05-15

#### Added
- Sidebar prompt search now also indexes prompt-local `plan.md`, `report.txt`, and the selected HTTP examples file contents through a runtime-only search corpus, so prompts can be found by saved plans, reports, and request samples without reading files on each keystroke.

#### Fixed
- Prompt editor section expansion state no longer gets lost when saving one prompt, creating or saving another prompt, and then returning to the first one; editor view-state saves and migrations are now serialized so blocks like `Files` stay restored consistently across prompt switches.

### 2026-05-14

#### Fixed
- Git Flow step 4 now refreshes the current overlay scope through the current panel callback after single-project or bulk MR/PR creation, and if that reread fails it replays the latest cached overlay snapshot with optimistic review data so `Create MR/PR for all projects` does not stay stuck on a permanent loader.

### 2026-05-13

#### Fixed
- Closed prompts no longer accumulate automatically derived implementing time from background chat-session refresh, silent/manual implementing-time recalculation, or late chat completion after the prompt has already been moved to `closed`; manual `Misc time` adjustments remain available.
- Git Flow step 2 no longer reopens with `Commit project` and `Commit changes in all projects` stuck in a false loading state after a previous commit already settled; fresh overlay snapshots now prune stale pending commit tracking once the requested projects are clean or the old request has clearly aged out.

### 2026-05-12

#### Changed
- Dashboard section headers now expose a per-widget refresh button beside the counter, and the `Коммиты проектов` card shows `short SHA + author` on the first line with the full commit subject wrapped on the next line instead of truncating it into one row.

#### Fixed
- Clicking `+ Новый` while another prompt page is open no longer lets an intermediate sidebar refresh select the wrong prompt; the optimistic `__new__` row now resolves only through the exact saved `promptUuid` instead of the first unseen prompt id.
- The Process tab report editor now keeps the surrounding page scroll stable not only while typing but also while switching between Text / Html / Markdown views and while leaving the field on blur: the raw Text source surface was rewritten from a native textarea to a plain-text `contenteditable` editor, pending autosave still waits for the inline editor to really yield focus, mode switches snapshot and restore page scroll before the editor surface swap, clearly stale first-pass auto-resize measurements are retried instead of collapsing the editor to a false minimal height, and same-content save echoes still no longer leave the prompt in a fake dirty loop or trigger repeated dashboard churn.
- The report editor toolbar now includes a `Копировать` action that copies the representation of the currently selected mode into the clipboard.
- The `Параллельные ветки` widget now keeps an already visible row mounted with an explicit empty/error state when a later details refresh cannot return a diff payload for that branch, instead of making the row disappear from the list.
- The `Параллельные ветки` widget now falls back through merge-base when a lightweight three-dot diff count cannot be resolved, so zero-file branches stop lingering as visible placeholders that disappear only after expansion.
- The `MR/PR` widget now renders as the last dashboard card instead of appearing earlier in the multi-column overview layout.
- The `Параллельные ветки` widget no longer drops an already visible branch row on expand just because the heavy details refresh picked a different top-N candidate set to hydrate.
- Multi-column prompt dashboard widgets now avoid the large empty vertical gaps that appeared under shorter cards after the stable-column layout change.
- The `Коммиты проектов` widget now shows lightweight changed-file counts in collapsed commit rows immediately instead of rendering `...` until the file list hydration runs.
- Multi-column prompt dashboard widgets now keep their column positions stable when commit, branch, or file disclosures expand, instead of jumping into different columns as card heights change.
- The `Параллельные ветки` widget now shows the latest branch author after each branch name.
- The `Параллельные ветки` widget now shows lightweight unique-file counts in collapsed branch rows immediately instead of rendering `...` everywhere until one branch expansion triggers the full details hydration, and branches whose lightweight or hydrated result resolves to `0` unique files are suppressed from the widget entirely instead of disappearing only after expansion.
- Prompt chat launch now waits through a short confirmation grace window before showing "Chat launch was not confirmed", so a late active chat session or tracked request marker can still confirm the same launch after the first session-index pass misses it.

### 2026-05-10

#### Fixed
- The `Ветки проектов` widget now keeps full directory prefixes in flat `Незакоммиченные файлы` and `Опережающие файлы` rows while they still fit on one line, and only begins collapsing the longest folder segments first when the rendered row runs out of horizontal room instead of truncating every folder immediately.

### 2026-05-09

#### Added
- Start Chat context now prepends a mandatory note before the `### Tools` list, so listed Skills, MCP tools, hooks, and the preferred model stay explicit required tooling whenever they are available and relevant.

#### Changed
- Dashboard branch-widget incoming disclosures now append the comma-separated list of unique upstream commit authors in the visible `Опережающие файлы` title, while the opened diff title still appends the latest file author resolved from the compared ref.

### 2026-05-08

#### Fixed
- Start Chat now drops missing workspace folders from the `Excluded projects` section before sending the generated chat context, so stale excluded names no longer leak into Copilot chat scope.

### 2026-05-07

#### Added
- Start Chat context now adds an `Excluded projects` section immediately after `Projects`, so readonly workspace exclusions are visible to the model without mixing them into the active task scope.

#### Changed
- The custom desktop publish script now stages Linux, Windows, and macOS VSIX targets first and publishes those prebuilt packages together in one Marketplace call, avoiding same-version failures on later desktop targets while still pruning ONNX runtime assets per target instead of shipping Linux-only bundles; VS Code Web remains unsupported because the extension still has no browser entrypoint.

#### Fixed
- The prompt-page `AI Models` picker now sorts the Copilot model list alphabetically, while still keeping the current prompt model visible even when it is not present in the latest fetched catalog yet.
- The prompt-page `AI Models` picker now keeps curated visible Copilot models first but still appends newly available live chat models returned by the VS Code Language Model API, so fresh entries such as `GPT-5.5` appear immediately instead of waiting for the local visibility cache to catch up.
- The `Ветки проектов` widget now shortens long project names in the middle, renders compact relative path prefixes for dirty files, and schedules a scoped one-second refresh after matching workspace file edits instead of waiting only for the next Git metadata event.
- The `Ветки проектов` widget now turns the per-project action into `Получить` when the selected current branch is behind its upstream, runs a single-project pull through the same widget-first refresh path used by branch applies, keeps the busy state until the refreshed `projects` widget arrives, and shows incoming upstream changes in a green `Опережающие файлы` disclosure with clickable branch-diff rows.

### 2026-05-05

#### Added
- Added `promptManager.excludedProjects` so selected workspace folders can be hidden from prompt project pickers, Git Flow, dashboard widgets, Project Memory, and new CodeMap/Memory runtime collection while previously stored history stays intact.

#### Fixed
- Prompt dashboard MR/PR cards no longer show projects whose only review state is “active MR/PR not found”, and the `Активные промпты` widget now invalidates its warm cache when the prompt status or tracked activity changes locally.
- The Process tab chat-launch block no longer briefly disappears and reappears on the first ready-state render before its completion hold timer starts.
- Git Flow now keeps a freshly created MR/PR visible immediately after the create action even when the first follow-up snapshot is still stale.
- Saving from the separate report editor now pushes the latest report back into the main prompt editor immediately, and the external report window now includes a Copy action.
- The prompt header inside the editor now shows `taskNumber | title`, matching the panel title and chat-session rename format.

### 2026-05-04

#### Changed
- Dashboard dirty-file disclosure now keeps the normal first `projects` widget refresh lightweight but hydrates per-file change stats on demand when that block is expanded, retries that lazy hydration automatically for already opened rows after a projects refresh completes, and the dirty-file rows themselves use larger file names, slightly dimmer folder names, tighter spacing, higher-contrast secondary labels, stronger symbolic status badges, a compact unresolved-stat placeholder instead of an empty slot while counts are still hydrating, and matching folder/file row line height so the file list remains readable in narrow dashboard cards.
- Fully redesigned the extension icon set across the Activity Bar, Marketplace package icon, About surfaces, and README visuals with a compact lowercase pm wordmark, replacing the earlier icon concept and keeping both the colored and monochrome silhouettes readable at 32x32 and 16x16.
- The prompt editor overview rail now shows the colored marketplace pm icon before the combined `Обзор` / `Обновлено` heading block so the dashboard chrome matches the updated branding, and its toolbar now starts on the same horizontal line as the prompt-form header buttons.
- The prompt editor overview brand mark now uses the same 32px footprint as the prompt-form header action buttons, so the dashboard heading icon matches the surrounding chrome without changing the widget toolbar height.
- Quick Add Prompt is now also available as an editor title action near the tab bar using the Prompt Manager pm icon, it now stores the pasted input as prompt text instead of the Title field and runs the same automatic title and description enrichment used by the editor page, and custom-group sections in the sidebar now use each group color as the header background with automatic black-or-white contrast for the label.

#### Fixed
- The dashboard now hides `closed` prompts from `Активные промпты`, lets `Ветки проектов` switch between prompt-scoped rows and all workspace repositories through `Показать все` without widening the other widgets, omits zero-valued `+0` / `-0` counters, respects `promptManager.gitOverlay.otherProjectsExcludedPaths` in the branch-widget dirty-files disclosure, and hides fully hydrated parallel branches that have no unique changes versus their base branch.
- Prompt dashboard file-list hydration no longer re-runs a full `details` Git refresh for every workspace repository when you expand one commit, parallel branch, or dirty-file block; the dashboard now hydrates only the opened project row, dirty-file disclosure uses its own narrow change-only project refresh instead of reloading branch/review/recent-commit overlay state, the `dirty:<project>` expansion path now correctly routes into that dedicated dirty refresh and re-attempts hydration after widget loading settles, tracked dirty-file line counters batch `git diff --numstat` work per change group instead of spawning one diff per file, the follow-up AI review pass reuses the MR/PR state already loaded during the visible projects refresh instead of repeating the same slow review CLI probe immediately afterward, that background AI refresh now keeps commit/parallel file trees lightweight until explicit details hydration is requested, and already hydrated dirty-file line counters are preserved instead of being reset by the follow-up pass.
- Expanding a row in `Параллельные ветки` no longer makes that row disappear when the prompt branch is missing in the target repository; parallel-branch hydration now falls back to an available current or tracked branch base before requesting the detailed comparison.
- Dashboard tracked-branch applies no longer create a missing local branch implicitly, the prompt-branch preset button is now disabled whenever the prompt has no configured Git branch, the per-project branch selectors now fall back to the refreshed current branch after bulk or preset dashboard branch applies, and the `Статус промпта` widget now stays synchronized with live local prompt status/time changes, runtime `agent.json` progress updates, plus later async snapshot or widget patches instead of waiting for a full dashboard scope refresh. In-progress cards also keep the freshest loaded percent instead of falling back to 50% when `config.json` has no progress but `agent.json` already does, when several Codemap tracked branches are configured the dashboard now treats the project's current branch as tracked whenever it already belongs to that configured tracked set instead of pinning the first configured branch, branch-switch failures now stay attached to the affected project row inside `Ветки проектов` in a dedicated outlined error card, and the same widget can disclose each project's local uncommitted files in its own outlined warning card with clickable diff rows, active-file highlighting, compact line counters, larger file-row typography, tighter row spacing, matching folder/file line height, and a compact unresolved-stat placeholder instead of an empty stat slot while lazy counters are still hydrating.

### 2026-05-03

#### Added
- Prompt editor overview dashboard: when the editor has enough right-side space, flat compact masonry-style widgets now sit directly in the empty area beside the fixed-width prompt form instead of using a separate drawer. Widgets load independently through a stale-while-revalidate cache warmed every five minutes and cover recent long-running prompts with task numbers, current prompt status with a larger color-coded chip plus an In Progress-only prompt-list-style progress bar, a dedicated project-branches widget for bulk branch switching, separate project commits, MR/PR, and `Параллельные ветки` widgets, calm explorer-like file tree lists with compact `+ / ~ / -` counters, standard side-by-side VS Code diff opening for the exact commit or branch change, and cached AI review on manual dashboard refresh.
- Dashboard refinements: active prompt rows now open the selected prompt, project branch switching is denser and preset buttons apply per-project prompt/tracked branches immediately, project selectors now show current/prompt/tracked branches and select the current branch first, dashboard widgets refresh after local prompt parameter edits, external prompt updates, and reactive git branch/repository-state changes in visible prompt editors, the status widget now reflects live prompt data even when the dashboard scope cache stays warm, git-reactive project refresh now updates branch-backed state first and reuses cached heavy sections instead of immediately recomputing pipelines, recent commits, and parallel branches, dashboard startup now waits for the real prompt payload before requesting snapshots, built-in Git repository bootstrap no longer retriggers dashboard refreshes on every `onDidOpenRepository` event, dashboard project scope falls back to all workspace repos when saved selections are stale, dashboard widgets mirror the prompt form left-accent card treatment, the first panel-visible pulse after prompt open/switch no longer duplicates a heavy projects refresh, hidden/revealed dashboard rails now keep the last snapshot mounted and only request a catch-up project refresh when hidden git changes were queued, project Git enrichments now run serially to avoid CPU spikes, parallel-branch enrichment now scans only the rendered branch limit instead of every local cleanup branch, the first `projects` paint now keeps commit and parallel-branch file details lazy until the user opens those rows, pipeline status is now skipped on the normal first `projects` widget refresh and loaded only for manual AI review/full refresh, dashboard project snapshots now skip per-file working-tree diff enrichment because the widgets only need dirty/conflict membership, parallel-branch summaries now keep structured file diffs with rename and numstat support from the same merge-base range used by diff opening, file trees now render as compact branch-guided project trees with persistent opened/viewed file markers, row clicks open the diff directly, remote GitHub/GitLab CLI failures are shown as compact availability messages, and AI review reuses shared cached results across prompt switches without running on the initial prompt-open critical path.

#### Changed
- Dashboard file trees now use shorter `├─` / `└─` branch guides and render file/folder names with the regular UI font instead of the monospace editor font, so long paths take less horizontal space.

#### Fixed
- Prompt editor dashboard no longer falls back to `Анализ обновляется...` on prompt switches when the prompt/Git fingerprint is unchanged; the initial snapshot now reuses shared project and AI-review cache data immediately, manual dashboard refresh now returns the refreshed snapshot before the follow-up AI review finishes, and scopes that still have no AI review now auto-start the review right after the first background Git refresh instead of waiting for the five-minute warm cycle. Late AI completions for the same prompt fingerprint now still repaint the widget even if a newer snapshot request changed the active request id, slow reviews now publish a quick local preliminary summary after a short delay instead of leaving the widget blank on `проверяем`, repeated AI requests reuse a short-lived selected-model cache, AI prompt logging no longer blocks the request path, dashboard review prompts now send a much more compact Git summary to the language model, and ai-request logs now include prompt lengths to diagnose slow model responses. Project pipelines resolve against the latest workflow or pipeline run on each repository's actual current branch, branch actions keep their request-scoped loaders visible until the refreshed projects widget lands instead of waiting on a full dashboard snapshot, loading project refreshes now keep the previously rendered rows mounted instead of flashing empty placeholders, the follow-up AI review refresh now reruns in the background without blanking the projects widget, the `Активные промпты` widget falls back from an empty yesterday bucket to the latest earlier active day, `Ветки проектов` keeps the chosen target branch visible until refreshed data lands, commit/parallel change files render as a real nested tree instead of grouped folders, and dashboard perf logs now include AI review requested/reused/started/skipped/completed events for stuck-state diagnosis.
- Prompt switching is no longer slowed down by hidden or immediately reloading dashboard widgets: the editor skips dashboard requests when the right-side rail is not visible, keeps the previous dashboard snapshot mounted across temporary hide/reveal cycles, delays and coalesces automatic widget refresh away from the prompt-switch critical path, avoids reveal-time project refresh unless hidden git changes were queued, pauses stale in-flight dashboard work as soon as prompt switching starts, and Prompt Manager debug logs now split prompt-open pending-save/storage timings plus dashboard performance timings for diagnosis.

### 2026-04-29

#### Added
- Background voice-recognition queue for prompt text input: pressing OK now queues the captured audio, collapses recognition into a compact in-field progress indicator, and lets the user start another microphone recording immediately. Recordings that hit the five-minute limit are queued automatically and a new recording starts right away.
- Prompt voice trace logging now writes `[prompt-voice][trace]` lines for webview and extension-host recording events, making OK/limit/auto-restart overlay races easier to diagnose from the `Prompt Manager` Output channel.

#### Changed
- Voice queue recognition jobs now process in parallel while completed text is released to the prompt field strictly in original queue order, quiet recordings receive stronger transcription gain, the queue indicator sits at the bottom of the prompt field, and the prompt textarea scrolls to the bottom after recognized text is appended.

#### Fixed
- Local test and publish workflows no longer fail when the installed `@huggingface/transformers` package is missing its advertised declaration files; Prompt Manager now ships a local declaration shim for the runtime APIs it uses, and the Linux publish script rebuilds dependencies with `npm ci` before tests and after runtime pruning.
- Voice queue recognition no longer inserts Copilot post-correction placeholder replies such as “Пожалуйста, предоставьте текст для исправления.” or “Пожалуйста, предоставьте текст для корректуры.” for later queued recordings; the correction prompt now sends instructions and transcription together, and placeholder replies fall back to the raw Whisper text.
- Pressing OK near the recording time limit no longer closes, reopens, and closes the recording overlay through the auto-restart path; manual confirmation intent is registered on press-down before the click event, so it wins over the limit auto-restart race.
- Pressing OK no longer lets a delayed recorder `recording` or `paused` state switch the overlay back from “processing” to the recording UI while `recorder.stop()` is already in flight.
- Packaged the external `@huggingface/transformers` runtime dependencies needed by Whisper recognition into the VSIX, preventing installed extensions from failing with `Cannot find package '@huggingface/transformers'` at speech-recognition time.

### 2026-04-28

#### Fixed
- Git Flow start-chat preflight now shows a dedicated `Start on current branches` action whenever the regular Start button is visible but disabled, so chat can continue without waiting for the standard branch-check path.
- Git Flow no longer shows transient step-1 prompt-branch and tracked-branch blockers during summary or light open hydration; summary/light snapshots now keep their tracked-branch list stable until branch metadata is ready, and built-in repository state pulses no longer keep auto-refresh looping while the overlay is already refreshing.
- Git Flow step 1 no longer hides and re-shows the “Changes in other projects” block during snapshot refreshes; the editor now keeps the last loaded peer-project snapshot visible until the next lazy other-project update arrives.

### 2026-04-27

#### Fixed
- The prompt editor footer now keeps Go to chat visible for every persisted prompt status except Draft and Closed, while a fresh chat launch still keeps the Start Chat spinner visible until the launch settles.
- Prompt editor switching now shows request-aware blank fixed-height sections immediately, using the target prompt view state and saved per-prompt layout heights so quick switches are clear without visible skeleton bars or block-height jumps when data arrives; the editor captures the latest rendered section heights before prompt switches, prompt saves, and webview hide/close, keeps the latest queued layout snapshot available in memory for instant reuse, stores layout state by prompt UUID plus prompt id to avoid duplicate-UUID collisions, ignores the first unstable post-open section measurements until child editors settle, holds saved section heights as exact border-box locks while real data appears, keeps very fast prompt payloads behind a short minimum blank-state window, shows the existing centered overlay loader immediately within the prompt form shell during blank switch placeholders, preserves the Workspace branch-list expanded/hidden state per prompt so manual hiding is not reopened by mismatch auto-expand, keeps Process-tab report auto-resize suspended while Report settles, keeps the Plan section at its saved blank height until the async plan snapshot arrives, avoids adding a transient Memory placeholder when the target prompt has no saved Memory section height, persists state through a coalesced async queue outside the open/save critical path, posts prompt-loading messages without blocking target prompt loading, avoids duplicate unversioned ready/open messages after prompt id changes, and logs layout heights/timings through the existing debug log channel.

### 2026-04-26

#### Fixed
- Prompt editor now enforces a single VS Code webview page for prompts by closing duplicate `promptManager.editor` tabs even when an older or restored tab is no longer tracked in the extension's internal panel map.
- Prompt editor opening, prompt switching, and status-change saves now avoid slow visible busy states: opening uses request-aware loading and post-open metadata hydration, silent chat-time recalculation stays off the visible progress line, status-change saves use the in-memory report binding and loaded base prompt instead of refreshing report.txt or rereading the prompt before writing, skip pending report persist waits and slug/id recalculation for already-open prompts, avoid unchanged prompt.md/report.txt writes and stable report/context file probes for status-only saves, write stable status-only config updates through a short synchronous local file write, end the visible save indicator before slower post-save sync work, and keep existing-prompt saves on the direct id/UUID identity path instead of scanning prompt lists.
- First prompt save after VS Code startup no longer waits behind Copilot usage/account diagnostics: activation and status bar startup reuse cached usage state instead of forcing immediate account summary/auth lookups, overlapping refresh calls return the current cache while another fetch is in flight, and VS Code `state.vscdb` fallback reads use async single-key SQLite lookups.

### 2026-04-25

#### Fixed
- Opening and refreshing Git Flow in large workspaces now keep the full overlay snapshot focused on the selected prompt projects, while the step 1 “Changes in other projects” block is loaded separately from a lighter peer-project snapshot without review, graph, and per-file diff enrichment; fully clean peer repositories now short-circuit before the heavier change scan, and peer-only auto-refresh updates also reuse that lighter path instead of rebuilding the full selected-project snapshot.
- The first visible Git Flow snapshot now opens in two phases: selected projects first render from a lightweight branch-first summary snapshot that also defers review setup/request detection and skips `recentCommits`, change groups, and local/remote branch enumeration on the first paint, while the full selected-project hydrate and lazy other-project scan are deferred so the initial payload reaches the webview sooner.
- Git Flow first open no longer loses that ready summary snapshot when the same overlay panel refreshes its webview message callback during the opening cycle; stale-session checks now accept the recent callback history of the same panel instead of treating that visibility sync as a different session.
- The first full selected-project Git Flow hydrate now ships branch and change data without waiting on review setup/request detection; step 4 review state is hydrated afterward through lightweight per-project patches, and the review step stays pending until that background data arrives.
- The first full selected-project Git Flow hydrate no longer waits on local/remote branch enumeration and cleanup metadata either; branch-dependent controls now stay in a loading state until lightweight per-project branch patches arrive.
- The follow-up `open-review` patches now reuse the existing project snapshot and resolve only review state, instead of recomputing branch and change metadata a second time for the same selected repositories.
- Git Flow no longer flashes stale, field-level loading, or empty step data during open snapshot replacement; the webview now receives the snapshot detail level and masks previous counts and step bodies with loader cards until the fresh snapshot and automatic branch/review hydration are ready, while refresh keeps existing step content visible and shows only the header progress line.
- Git Flow step 1 no longer flashes the “nothing to commit” hint during opening or automatic refresh before hydrated tracked-branch metadata has settled.
- The second-phase Git Flow hydrate now keeps project change lists lightweight on first arrival, short-circuits clean repositories before extra diff commands, and postpones per-file diff enrichment until a user expands a specific project card, reducing the remaining open latency without hiding the changed-file lists.
- Git Flow no longer closes itself right after opening when the same prompt receives a follow-up `reason: 'open'` refresh during silent recalculation or other same-prompt webview rehydration; the overlay state is now preserved unless the active prompt identity actually changes.
- Git Flow no longer carries section data from the previous prompt into the next one after a prompt switch, and reopening the overlay now starts with completed warning-free step sections collapsed so the first visible state is less noisy.
- Bulk Git Flow actions across multiple projects now execute independent fetch, sync, push, review-request, and commit work with controlled parallelism, which reduces button latency in larger workspaces without changing result ordering in the overlay.
- With `promptManager.debugLogging.enabled`, Git Flow now emits duration metrics for selected snapshots, lazy other-project snapshots, refresh cycles, bulk git operations, and per-project full-hydrate stages such as local branches, remote branches, and lightweight change scans so large-workspace before/after comparisons are easier to inspect.

### 2026-04-24

#### Fixed
- Git Flow step 1 can now hide configured repo-relative path prefixes from the “Changes in other projects” block via `promptManager.gitOverlay.otherProjectsExcludedPaths`, and explicitly selected projects with zero changes now show “Exclude” instead of “Switch”.

### 2026-04-23

#### Fixed
- Closing the separate report editor right after Save no longer drops the latest edits; the webview now flushes unsynced local report state during shutdown so the first save survives the window close.
- The Process tab chat launch block now keeps each visual stage visible for at least one second before advancing, including the initial prepare and auto-load rows, so the whole sequence stays readable from the first step onward.
- The Process tab chat launch block no longer reappears later for the same launch when a transient prompt sync briefly drops chat-entry state or when the same prompt is reidentified by a later id/UUID normalization pass.

### 2026-04-22

#### Fixed
- Prompt pages no longer open as a blank webview after the recent Process-tab launch-block refactor; the editor render path now avoids the launch-state runtime failures that could break initial load.

### 2026-04-21

#### Fixed
- Copilot Premium Usage no longer falls back to inflated local counters when the GitHub session is stale or invalid; the status bar now shows a dedicated sign-in error state instead of misleading percentages.
- Git Flow step 1 now shows a dedicated “No others” marker in rows where the expected branch field is hidden because there are no alternative target branches to choose from.
- The Process launch block no longer stays stuck on "Open Copilot Chat" after a bound or reopened chat entry is already available again but transient launch flags were lost during sync.

#### Improved
- Start Chat now refreshes the shared agent context from the latest editor state instead of relying on stale persisted metadata, empty shared-context values still trigger a fresh remote load on launch, manual edits disable the auto-refresh until the remote context is loaded again, failed refresh attempts fall back to the last saved value without blocking chat launch, and the Process tab now shows that auto-load state inline as a launch step.

### 2026-04-20

#### Changed
- Memory webview fully redesigned with a flat design language: all shadows removed, panels use thin 8% foreground-opacity borders, accent lines (3-4px colored left/top borders) replace heavy shadows for visual hierarchy, buttons are flat solid backgrounds without gradients, segmented tabs use a subtle contained bar, metric cards have a 3px top accent border, badge/pill shapes changed from pill (999px) to 6px radius rectangles, progress bars thinned to 6-8px, typography upgraded with uppercase labels, tighter letter-spacing, and larger metric numbers (32px), and dialog overlays use stronger backdrop blur with no box-shadow.
- Memory header card now uses a left accent border with a subtle gradient tint instead of heavy box-shadow and old gradient; eyebrow labels use the accent color for visual hierarchy.
- Navigation tabs (segmented tabs) now display inactive labels at 60% foreground opacity for better readability; active tab gets a subtle shadow lift for clearer distinction.
- Commit list in the History section now includes an inline search bar at the top for quick full-text/semantic search without switching to a separate tab.
- Settings panel labels increased to 12px bold foreground, descriptions use 70% opacity foreground for better readability, and field spacing reduced for a denser layout.
- Memory metric cards use a tinted background (2% foreground mix) for subtle depth, and the Dashboard hero panel has a soft gradient toward the accent color.
- List items in History and Instructions no longer leave border artifacts when switching selection; borders are removed in favor of clean left accent marks on active items.
- Custom scrollbar styling added to the Memory webview with thin 6px tracks and subtle foreground-colored thumbs.
- Project Memory now opens on a new dashboard-first landing page with top-level Dashboard / Histories / Instructions / Settings navigation, unified card styling across the Memory webview, richer overview charts and rankings, and a single Settings surface that combines history-memory and codemap instruction options under internal tabs.

#### Fixed
- The Process tab report editor no longer clips long Markdown or HTML output at the old 800px auto-resize ceiling, and it now recalculates height when the editor width changes so wrapped content stays fully visible.
- Session and codemap chat-memory instruction files now resolve prompt project scope against the current workspace, fall back to all workspace projects when saved selections are stale, and keep generated Markdown headings nested under a single document root instead of dropping embedded H1 sections into project blocks.
- Prompt chat launch confirmation now waits for a detected chat session before the Process block marks "Open Copilot Chat" as done, the false "Chat launch was not confirmed" notice is shown only after real confirmation timeout, and the launch block completion delay now starts after the final rename step finishes.
- Prompt editor background refresh and debounce timers now detach from the Node event loop when they are running as best-effort follow-up work, so test runs and other short-lived processes no longer sit idle for up to two minutes waiting for delayed chat/session refresh retries to expire.
- Prompt chat auto-complete no longer trusts only `lastRequestEnded` timing from the VS Code chat session index; it now waits for terminal request markers from the persisted chat session JSONL, preventing plan-mode and still-streaming chats from flipping prompts to Completed too early.
- Prompt status recovery now remembers when a prompt was manually moved back to In Progress or reopened in chat and only auto-completes again after a newer chat request starts, preventing the same already-finished request from forcing the prompt back to Completed.
- In the sidebar prompt list, selected in-progress items now render the third-column progress bar with an outlined inverse track, and 100% completion uses a more saturated green so progress stays readable on active selection.
- The Process tab Notes section now shows the current prompt status both in the section header and at the top of the block, reusing the same compact status color contract as the sidebar prompt list.

### 2026-04-19

#### Fixed
- Prompt-local context files stored under .vscode/prompt-manager/<prompt>/context now survive prompt folder renames and reopen correctly after the editor page is closed and opened again; stale config.json references are auto-repaired on load and on the next save.
- Background codemap refresh and manual history analysis now default to the new `lowest` background priority, lower the scheduling priority of their git subprocesses, and insert extra idle-friendly pauses between heavy batches so Memory page work no longer competes as aggressively with active CPU use.
- Quick Add Prompt now preselects the AI model from the most recently updated saved prompt, matching the default model behavior of the regular new-prompt flow.
- Generated global, project, session, and codemap instruction files no longer auto-inject an `applyTo` frontmatter block, while legacy project instruction files are still normalized on read and save.

### 2026-04-18

#### Fixed
- Reopening a prompt-bound chat session no longer falls back to a generic empty chat window just because the chat view memento is stale; bound sessions now reopen directly by session resource.
- Prompt-bound chat detection is now scoped to the current workspace storage bucket, preventing prompts from binding to active Copilot sessions from unrelated VS Code workspaces.
- The editor Stop button now cancels the active agent request for a prompt-bound chat by focusing the bound session before dispatching the chat cancel command.
- Bound chat sessions are now renamed both immediately after the launch flow binds a new chat session and again after a prompt title or task number change, the rename flow can still resolve the prompt through promptUuid after the prompt id changes, current VS Code builds now keep retrying the live title refresh through the early bind timing window instead of stopping after the first persisted rename, and the Process launch block shows that early rename as a dedicated fourth step.
- The inline Start Chat notice is now limited to draft prompts before launch, and prompts already in progress no longer briefly re-show Start Chat after the launch spinner finishes.
- Sidebar prompt items now show a loader instead of stale status or progress while a prompt is being saved or its title/description AI enrichment is still running.

### 2026-04-17

#### Fixed
- The editor now shows a more readable inline explanation above a disabled Start Chat button on every tab so it is clear whether prompt text is missing, metadata enrichment is still running, or chat launch is already in progress.
- The Process tab chat launch block now shows the selected AI model directly inside the "Open Copilot Chat" step, with the model name emphasized for quicker visual confirmation.
- Git Flow now captures elapsed prompt time before switching to the final Done status, and even when Done does not change the status it still runs the regular save path so elapsed prompt time is persisted.

### 2026-04-15

#### Changed
- Copilot Premium Usage page redesigned: single-column layout, area chart with gradient and Catmull-Rom smoothing for trend visualization, color-coded daily bars (green/orange/red vs recommended pace), merged status footer with collapsible debug log.

#### Fixed
- Copilot Premium Usage now correctly shows daily request counts by forward-filling snapshot gaps for days the extension was not running, and no longer clamps historical usage values to current-day counter.

### 2026-04-13

#### Added
- AI post-correction of Whisper transcriptions via Copilot Language Model API (`promptManager.voice.aiPostCorrection`, enabled by default). Automatically corrects STT errors, restores punctuation and casing after speech-to-text processing.

#### Changed
- Migrated STT engine from deprecated `@xenova/transformers` v2 to `@huggingface/transformers` v4 with `dtype: 'q8'` quantization for improved Russian speech recognition quality.
- Upgraded Whisper model from `whisper-tiny` (39 MB) / `whisper-base` (74 MB) to `onnx-community/whisper-small` (~60 MB quantized) for significantly lower word error rate (~12% vs ~25% on Russian).
- Added `promptManager.voice.whisperModel` and `promptManager.voice.language` configuration settings.

#### Fixed
- The sidebar no longer adds a separate Favorites group on top of grouped results, and the import, filter, and view utility buttons use a lighter idle palette with darker pressed or active feedback.
- Starting a fresh chat now clears an existing prompt plan only after the start preflight succeeds, so stale plan steps do not leak into the next run.
- Plan and Report now reopen automatically when their section was still empty at the time of a manual toggle and content appears later, while non-empty sections continue to respect the user's manual collapse state.
- Opening the Report section no longer risks blanking the editor webview when the auto-resizing report editor mounts.

#### Improved
- The prompt editor header can open a dedicated chat-memory project.instructions.md file, the General instruction block can edit it directly, and report editing now grows with content automatically instead of relying on manual resize.

### 2026-04-12

#### Fixed
- Git Flow step 1 now includes dirty workspace projects outside the current prompt selection so they can be added directly from the overlay.
- New prompts now always open on the Main tab, Start Chat stays disabled while title or description AI enrichment is still running, prompt folders stop renaming after chat start fixes the directory path, and completed chat-launch blocks no longer reappear just because status was manually switched back to In Progress.
- New prompt editor disclosure rules now open Basic, Time tracking, Workspace, Prompt, and Agent by default, while Notes starts collapsed and Notes, Plan, and Report expand automatically when content appears until the section is toggled manually.

### 2026-04-11

#### Fixed
- Codemap instruction refresh now updates locale-specific records deterministically and selected delta refresh resolves the chosen branch against its own head/tree references instead of mixing them with the active workspace branch.
- Grouped prompt lists now allow temporary collapse changes while filters are active without overwriting the remembered group expansion state that returns after filters are cleared.

#### Improved
- Copilot Chat start context now includes the absolute chat-memory directory together with generated memory instruction file references.

## [0.1.88] - 2026-04-10

### Added
- Project Memory panel for commit browsing, AI-powered analysis, semantic search, statistics, and settings.
- Copilot Premium usage status bar widget and detailed diagnostics panel.
- Expanded prompt lifecycle support across draft, in-progress, stopped, cancelled, completed, report, review, and closed states.
- Richer prompt editor workflows around plans, reports, integrations, files, and time tracking.

### Changed
- Improved Git-aware prompt execution, including review-oriented flows and tighter branch context inside the editor experience.
- Expanded prompt management UX with better sidebar views, grouping, filtering, and delivery-oriented surfaces such as tracker and statistics.
- Refreshed documentation and Marketplace-facing presentation assets for the current feature set.

### Improved
- Better support for context files, clipboard-driven assets, and reusable prompt execution context.
- Stronger AI enrichment and repository understanding workflows through memory and codemap-related capabilities.
- Prompt statuses can now be changed directly from the sidebar item menu, with a dedicated Status submenu and current-state checkmark.
- New prompts now open on the Main tab, and the Process tab shows a sticky chat launch state above the footer until Go to chat becomes available.
- Statistics exports now auto-fill hours from the selected work period, persist the hourly rate between panel openings, hide empty hour or cost sections, and use cleaner document previews.
- The prompt editor Process tab now follows the working order of notes, plan, and report.
- The prompt editor now keeps Open actions visually consistent and places the plan Open action in the section header when content exists.

## [0.1.0] - 2026-02-23

### Added
- Initial MVP release
- Sidebar webview panel with prompt list
- Editor webview panel for prompt configuration
- Search, filter, sort and group prompts
- Status management (Draft, In Progress, Completed, Stopped)
- Favorites system
- AI-powered generation of titles, descriptions and slugs via VS Code Language Model API
- Auto-detection of programming languages and frameworks
- Git branch management (view, switch, create)
- Copilot Chat integration (start chat, open existing chat)
- Skills, MCP tools and hooks discovery
- Import/export prompts
- Context files attachment
- Time tracking (writing time, implementation time)
- UI state persistence (filters, sort, last opened prompt)
- Dark/light theme support via VS Code CSS variables
