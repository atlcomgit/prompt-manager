# Copilot Prompt Manager

<p align="center">
  <img src="media/icon.png" alt="Copilot Prompt Manager icon" width="128" height="128">
</p>

<p align="center">
  <strong>Structured prompt workflows for VS Code.</strong><br>
  Design prompts, launch GitHub Copilot chats, keep Git context nearby, track delivery, and build searchable project memory in one extension.
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
  <img src="https://img.shields.io/badge/version-0.1.88-55d0a6" alt="Version 0.1.88">
  <img src="https://img.shields.io/badge/license-MIT-0f172a" alt="MIT License">
</p>

<p align="center">
  <img src="media/readme/hero.png" alt="Copilot Prompt Manager overview" width="100%">
</p>

Prompt work usually gets scattered across chat tabs, notes, branch names, and half-finished checklists. Copilot Prompt Manager turns that into a repeatable workflow inside VS Code: prompts live as project assets, chats can be started and reopened from context, Git-aware execution stays close to the prompt, and delivery surfaces like tracker, statistics, reports, and project memory stay connected.

This README is intentionally modular. The extension is still evolving, and the page is designed so new panels, workflows, screenshots, and examples can be added without another full rewrite.

## Contents

- [Why Prompt Manager](#why-prompt-manager)
- [Visual Tour](#visual-tour)
- [What You Can Do](#what-you-can-do)
- [Extension Surfaces](#extension-surfaces)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Storage and Configuration](#storage-and-configuration)
- [Actively Evolving Areas](#actively-evolving-areas)
- [Ideas for Further Expansion](#ideas-for-further-expansion)
- [License](#license)

## Why Prompt Manager

- Keep prompts as real project artifacts instead of disposable chat fragments.
- Launch GitHub Copilot chats from structured context that already knows your task, branch, files, skills, and hooks.
- Track the prompt lifecycle with eight statuses: draft, in-progress, stopped, cancelled, completed, report, review, and closed.
- Connect prompt execution with Git workflows, reports, implementation timing, and repository memory.
- Turn commit history into searchable AI-assisted memory with analysis, embeddings, and codemap-oriented context.

## Visual Tour

| Prompt Library | Prompt Editor |
| --- | --- |
| ![Prompt library in the sidebar](media/readme/sidebar.png) | ![Prompt editor with process panels](media/readme/editor.png) |

| Project Analysis | Project Memory |
| --- | --- |
| ![Project AI analysis and history](media/readme/analytics.png) | ![Project Memory store](media/readme/memory.png) |

## What You Can Do

### Design prompts as reusable project assets

- Create, edit, duplicate, archive, import, and export prompts from a dedicated VS Code sidebar.
- Keep filtered grouped sidebar views flexible: temporary collapse changes made while filters are active do not overwrite the remembered expansion state restored after filters are cleared.
- Store prompt content in Markdown and keep prompt metadata in JSON inside `.vscode/prompt-manager/`.
- Attach projects, languages, frameworks, skills, MCP tools, hooks, task references, branches, notes, plans, and reports.
- Reuse prompt context across sessions without rebuilding the same setup every time.

### Launch and reopen Copilot chats from context

- Start a GitHub Copilot chat directly from a selected prompt.
- Reopen existing chat sessions linked to the prompt.
- Include prompt file paths, the chat-memory directory, and generated memory instruction file references in the chat start context.
- Keep the prompt, report, and editor state tied to the same workflow instead of splitting them across tools.

### Work with Git without leaving the prompt flow

- View, switch, and create branches in workspace projects.
- Guard branch actions with dirty-worktree checks.
- Surface dirty workspace projects in Git Flow step 1 even when they are not yet attached to the prompt.
- Keep branch references and task metadata near the prompt itself.
- Use the Git-oriented editor flow to support commits, review preparation, and related prompt execution.

### Track delivery, not just prompt writing

- Move prompts through a full lifecycle in the tracker panel.
- Change a prompt status directly from the sidebar item menu, including the More button and the context menu.
- Review the Process tab in workflow order with notes first, then the plan, and the report after that.
- New prompts always open on the Main tab with Basic, Time tracking, Workspace, Prompt,
  and Agent expanded by default, Notes starts collapsed but reopens automatically when it
  receives content before any manual toggle, Plan and Report do the same while they stay
  untouched, Start Chat waits for title and description enrichment to finish, and prompt
  folders stay stable after chat start while the Process tab only shows launch progress until
  the chat binding is actually unfinished.
- Open plan and report content through consistent inline Open actions across the prompt editor.
- Track writing time, implementation time, overall time on task, and untracked corrections.
- Open statistics and export delivery-friendly summaries in HTML or Markdown.
- Auto-fill report hours from working days in the selected period, persist the hourly rate per workspace, and omit hour or cost sections when those values are empty or zero.
- Keep reports inside the prompt workflow instead of treating them as a separate afterthought.

### Build project memory from real repository history

- Open the Project Memory panel to browse commits, file changes, and stored analysis.
- Run AI-powered history analysis with configurable models.
- Use semantic search over embeddings to find similar work by meaning, not just by text.
- Inspect knowledge-graph style relationships and code-oriented instruction snapshots.
- Refresh codemap instructions from the instructions view with locale-specific persistence, including selected-branch delta snapshots that stay tied to the branch you actually chose.

### Monitor Copilot usage inside VS Code

- See Copilot Premium request usage in the status bar.
- Open a detailed usage panel with quota signals, refresh health, and account binding diagnostics.
- Keep usage awareness close to the same workflow where prompts and chats are executed.

## Extension Surfaces

| Surface | What it does | Best used for |
| --- | --- | --- |
| Prompt Sidebar | Prompt list, search, filters, grouping, favorites, compact/detailed views | Navigating and organizing prompt inventory |
| Prompt Editor | Main prompt workspace with content, context, integrations, files, notes, plans, reports, and timing | Day-to-day prompt preparation and execution |
| Tracker | Kanban-style lifecycle view across prompt statuses | Delivery flow and prompt handoff |
| Statistics | Aggregated time and status analytics with export support | Reporting and review summaries |
| Project Memory | Commit browsing, AI analysis, semantic search, statistics, settings | Recalling prior implementation work |
| Copilot Usage | Status bar widget and detailed quota diagnostics | Monitoring Premium request consumption |
| About / Settings | Extension details and configuration access | Maintenance and onboarding |

## Installation

### From the VS Code Marketplace

1. Open the Extensions view in VS Code.
2. Search for **Copilot Prompt Manager**.
3. Click **Install**.
4. Open the Prompt Manager icon from the Activity Bar.

### Requirements

- VS Code `1.95+`
- GitHub Copilot Chat for the chat-centered workflow
- Git-enabled workspace folders for branch-aware features
- Optional: Project Memory enabled in settings when you want AI-assisted repository memory features

## Quick Start

1. Open **Prompt Manager** from the Activity Bar.
2. Create a new prompt from the sidebar.
3. Fill in the brief: title, description, workspace projects, languages, frameworks, branch, task number, and AI model.
4. Add prompt content in Markdown and attach context files if needed.
5. Save the prompt and launch GitHub Copilot Chat directly from the editor.
6. Use the tracker and statistics panels to move the task forward and keep reporting aligned.
7. If you want long-term recall, open **Project Memory** and start building repository history into a searchable assistant layer.

## Storage and Configuration

Prompt Manager keeps prompts in your workspace so they can travel with the repository.

```text
.vscode/prompt-manager/
├── my-prompt/
│   ├── config.json
│   ├── prompt.md
│   ├── report.txt
│   ├── plan.md
│   ├── context/
│   └── history/
└── another-prompt/
    ├── config.json
    └── prompt.md
```

Example `config.json` shape:

```json
{
  "id": "marketplace-readme-refresh",
  "title": "README for Marketplace visuals",
  "status": "in-progress",
  "projects": ["prompt-manager"],
  "languages": ["TypeScript"],
  "frameworks": ["Visual Studio Code", "vscode extension"],
  "skills": ["grep-timeout", "devtools"],
  "taskNumber": "30",
  "branch": "feature/readme-marketplace",
  "model": "gpt-5.4",
  "contextFiles": ["README.md", "package.json"]
}
```

Useful configuration ideas:

- Keep skills and hooks curated so repeated workflows stay consistent.
- Use branches and task numbers to connect prompts with delivery artifacts.
- Keep reports and plans with the prompt so review context stays local to the repository.
- Enable Project Memory when your repository history is valuable enough to search semantically.

## Actively Evolving Areas

The extension already covers a broad daily workflow, but some surfaces are still expanding and should be treated as evolving capabilities rather than a fixed end state.

- Voice-assisted prompt input and transcription workflows
- Codemap-oriented instruction refresh and project structure guidance
- Deeper report generation and review handoff workflows
- More advanced automation around project memory and repository analysis

## Ideas for Further Expansion

These are product-direction ideas, not promises. They are listed here because the README is meant to grow with the extension.

- Team prompt packs and shared workflow presets
- Prompt comparison views across multiple AI models
- Release-focused prompt templates for review, changelog, and reporting flows
- Stronger memory-to-prompt suggestions based on commit similarity and code areas

## License

MIT © alek

<p align="center">
  Built for VS Code teams who want prompt work to be reviewable, repeatable, and project-aware.
</p>

