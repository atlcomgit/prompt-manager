# Prompt Manager

<p align="center">
  <img src="media/icon.png" alt="Prompt Manager icon" width="128" height="128">
</p>

<p align="center">
  <strong>Prompt workflows that stay attached to your code.</strong><br>
  Run AI chat from saved context, keep Git and delivery state nearby, and build project memory inside VS Code.<br>
  <strong>Промпты, Git-контекст, отчёты и память проекта в одном рабочем процессе прямо в VS Code.</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=alek-fiend.copilot-prompt-manager">Marketplace</a>
  ·
  <a href="https://github.com/atlcomgit/prompt-manager">Repository</a>
  ·
  <a href="https://github.com/atlcomgit/prompt-manager/issues">Issues</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/VS%20Code-1.95%2B-2f8cff?logo=visualstudiocode&logoColor=white" alt="VS Code 1.95+">
  <img src="https://img.shields.io/badge/license-MIT-0f172a" alt="MIT License">
</p>

<p align="center">
  <img src="media/readme/hero.png" alt="Prompt Manager overview" width="100%">
</p>

Prompt work usually gets split across chat tabs, notes, branches, and half-finished checklists.
Prompt Manager turns that mess into one repeatable workflow.

Работа с промптами обычно распадается на вкладки чата, заметки, ветки и разрозненные отчёты.
Prompt Manager собирает это в один понятный и управляемый процесс.

Support: Github Copilot Chat, Codex, and Kilo Code for the chat workflow.
Поддержка Github Copilot Chat, Codex и Kilo Code для работы с чатом.

## Why Teams Install It / Зачем это ставят

- **Repo-native prompts.** Prompts, plans, reports, and attached files live in the workspace instead of getting lost in separate tools. Промпты, планы, отчёты и файлы хранятся рядом с репозиторием.
- **AI chat from saved context.** Start or reopen AI Chat from a prepared brief with model, files, instructions, and scope. AI чат запускается из уже подготовленного контекста, а не из памяти пользователя.
- **Git-aware execution.** Keep branches, review flow, task tracking, and delivery status next to the prompt. Git-поток, ветки и статус выполнения остаются рядом с задачей.
- **Project Memory.** Turn repository history into searchable AI context with analyses, semantic search, and codemap instructions. История репозитория становится рабочей памятью проекта.

## What You Get / Что внутри

| Prompt Library | Prompt Workspace | Project Memory |
| --- | --- | --- |
| ![Prompt library](media/readme/sidebar.png) | ![Prompt workspace](media/readme/editor.png) | ![Project Memory](media/readme/memory.png) |
| Organize prompts, search fast, keep favorites and statuses close. | Edit the brief, launch chat, track progress, and stay inside one execution flow. | Reuse repository history, analyses, and semantic search when context matters. |
| Быстрый доступ к промптам, статусам и избранному. | Один экран для подготовки, запуска и сопровождения задачи. | Поиск по истории проекта и повторное использование накопленного контекста. |

## Built For Real Work / Для реальной работы

- **Prompt Sidebar** for library, filters, groups, and fast capture.
- **Prompt Editor** for context, files, chat launch, Git-aware execution, plan, and report. Prompt-dashboard cards can be collapsed and reordered from their headers, hidden cards pause their own refresh and AI review work until reopened, and restored prompt tabs are rebound to the singleton editor after VS Code reload so a stale duplicate webview does not keep a broken save loop. When Kilo Code or OpenAI Codex is selected as the target chat, AI-only model and chat-mode controls are replaced with a per-prompt Xdotool autostart flag. Карточки prompt-dashboard можно сворачивать и переставлять из шапки; скрытые карточки не обновляются и не запускают AI review, пока их снова не раскроют, а восстановленная после перезапуска вкладка редактора снова привязывается к singleton-странице и не создаёт вторую нерабочую webview. Если целевым чатом выбран Kilo Code или OpenAI Codex, поля модели и режима AI заменяются флагом автостарта через Xdotool для конкретного промпта.
- **Tracker and Statistics** for delivery visibility instead of forgotten prompt drafts.
- **Project Memory** for commit history, AI analysis, semantic search, and codemap snapshots.
- **AI Usage** for Premium request awareness without leaving VS Code.

## Quick Start / Быстрый старт

1. Install the extension and open Prompt Manager from the Activity Bar. Установите расширение и откройте Prompt Manager на боковой панели.
2. Turn on `Prompt Manager: AI Enabled` only when you want built-in AI generations, reports, or repository analysis. Включайте `Prompt Manager: AI Enabled` только когда нужны встроенные AI-генерации, отчёты и анализ репозитория.
3. Create a prompt, then add the brief, projects, branch, files, and AI model. Создайте промпт и заполните контекст задачи.
4. Save the prompt and launch AI Chat from the editor. Сохраните промпт и запускайте чат прямо из редактора.
5. Enable Project Memory / CodeMap in settings when you want history analysis and chat instructions. Включайте Project Memory / CodeMap в настройках только когда нужны анализ истории и инструкции для чата.
  When these settings stay off, Start Chat does not generate or attach session-memory / codemap instruction files. Если эти настройки выключены, Start Chat не создаёт и не прикладывает session-memory / codemap instruction файлы.

## Requirements / Требования

- VS Code `1.95+`
- GitHub Copilot Chat, Codex, Kilo Code for the chat workflow
- Git-enabled workspace folders for branch-aware features
- Optional: enable `Prompt Manager: AI Enabled`, Project Memory, and CodeMap in settings when you want built-in AI automation, repository analysis, and semantic recall

VS Code Web is not supported right now because the extension ships as a desktop Node-based extension.
Веб-версия VS Code пока не поддерживается.

## Prompts Stay With The Repo / Где живут промпты

Prompt Manager stores prompt assets inside the workspace, so they travel with the project.
Промпты живут внутри рабочей области и остаются частью проекта.

```text
.vscode/prompt-manager/
├── my-prompt/
│   ├── config.json
│   ├── prompt.md
│   ├── plan.md
│   └── report.txt
└── chat-memory/
```

## License

MIT © alek

<p align="center">
  Built for teams who want prompt work to be reviewable, repeatable, and project-aware.<br>
  Для команд, которым нужен не просто чат, а управляемый AI workflow в кодовой базе.
</p>
