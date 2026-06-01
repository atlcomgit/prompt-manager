# Copilot Prompt Manager

<p align="center">
  <img src="media/icon.png" alt="Copilot Prompt Manager icon" width="128" height="128">
</p>

<p align="center">
  <strong>Prompt workflows that stay attached to your code.</strong><br>
  Run GitHub Copilot from saved context, keep Git and delivery state nearby, and build project memory inside VS Code.<br>
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
  <img src="media/readme/hero.png" alt="Copilot Prompt Manager overview" width="100%">
</p>

Prompt work usually gets split across chat tabs, notes, branches, and half-finished checklists.
Copilot Prompt Manager turns that mess into one repeatable workflow.

Работа с промптами обычно распадается на вкладки чата, заметки, ветки и разрозненные отчёты.
Copilot Prompt Manager собирает это в один понятный и управляемый процесс.

## Why Teams Install It / Зачем это ставят

- **Repo-native prompts.** Prompts, plans, reports, and attached files live in the workspace instead of getting lost in separate tools. Промпты, планы, отчёты и файлы хранятся рядом с репозиторием.
- **Copilot from saved context.** Start or reopen GitHub Copilot Chat from a prepared brief with model, files, instructions, and scope. Чат запускается из уже подготовленного контекста, а не из памяти пользователя.
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
- **Prompt Editor** for context, files, chat launch, Git-aware execution, plan, and report. Collapsed prompt-dashboard cards pause their own refresh and AI review work until reopened. Свёрнутые карточки prompt-dashboard не обновляются и не запускают AI review, пока их снова не раскроют.
- **Tracker and Statistics** for delivery visibility instead of forgotten prompt drafts.
- **Project Memory** for commit history, AI analysis, semantic search, and codemap snapshots.
- **Copilot Usage** for Premium request awareness without leaving VS Code.

## Quick Start / Быстрый старт

1. Install the extension and open Prompt Manager from the Activity Bar. Установите расширение и откройте Prompt Manager на боковой панели.
2. Create a prompt, then add the brief, projects, branch, files, and AI model. Создайте промпт и заполните контекст задачи.
3. Save the prompt and launch GitHub Copilot Chat from the editor. Сохраните промпт и запускайте чат прямо из редактора.
4. Use tracker, report, Git flow, and Project Memory to carry the task to completion. Ведите задачу до результата в одном рабочем процессе.

## Requirements / Требования

- VS Code `1.95+`
- GitHub Copilot Chat for the chat workflow
- Git-enabled workspace folders for branch-aware features
- Optional: Project Memory in settings when you want repository analysis and semantic recall

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