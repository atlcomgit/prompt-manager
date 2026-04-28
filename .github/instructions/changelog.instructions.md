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