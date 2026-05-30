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

The extension now uses a compact lowercase pm wordmark across the Marketplace, the Activity Bar, and in-product panels, with an underlined colored marketplace mark and a matching monochrome panel version that stay readable at 32x32 and 16x16.

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
- Keep grouped sidebar results free from an extra Favorites section, while sidebar utility buttons stay light at rest and switch to a darker feedback state when active or pressed.
- Custom groups can now tint their sidebar section header with an auto-contrasted black or white title, so bright and dark group colors both stay readable.
- Busy prompts in the sidebar now show a loader instead of stale status or progress while saving or while AI is still generating title and description fields.
- Clicking `+ Новый` while another prompt page is open now keeps the optimistic draft pinned to the exact new prompt, so intermediate sidebar refreshes cannot jump the selection onto a different saved item before the real draft is persisted.
- Selected in-progress prompts keep the sidebar progress bar readable with an outlined inverse track, and fully completed progress uses a more saturated green fill.
- Sidebar search now also matches prompt-local `plan.md`, `report.txt`, and the selected HTTP examples file content, so prompts can be found by saved execution notes and request samples instead of title metadata alone.
- Store prompt content in Markdown and keep prompt metadata in JSON inside `.vscode/prompt-manager/`.
- Dictate prompt text from the microphone: confirmed recordings collapse into a compact in-field queue indicator while Whisper recognition and AI post-correction continue in the background, so you can start the next recording immediately.
- Let long voice capture continue smoothly: when the five-minute recording limit is reached without a button press, the finished audio is queued for recognition and a fresh recording starts automatically; pressing OK near that limit suppresses the restart.
- Troubleshoot voice overlay races by copying `[prompt-voice][trace]` lines from the `Prompt Manager` Output channel.
- Local test and publish validation for the Transformers-based voice runtime now uses a built-in declaration shim and a clean-lockfile reinstall path, so missing upstream `.d.ts` files in `@huggingface/transformers` do not break `npm run test` or the desktop publish script for Linux, Windows, and macOS VSIX targets.
- Keep prompt-local context files valid after prompt title or task-number driven folder renames, including auto-repair of stale saved file references on reopen.
- Attach projects, languages, frameworks, skills, MCP tools, hooks, task references, branches, notes, plans, and reports.
- Reuse prompt context across sessions without rebuilding the same setup every time.
- Keep the prompt-page `AI Models` picker aligned with the current Copilot chat catalog: cached visible models still stay first, but newly exposed live models such as `GPT-5.5` are now appended immediately instead of waiting for VS Code's local model cache to refresh.

### Launch and reopen Copilot chats from context

- Start a GitHub Copilot chat directly from a selected prompt.
- Reopen existing chat sessions linked to the prompt.
- Reopen bound chat sessions directly by their saved session resource, without falling back to a generic empty chat when the chat view state is stale.
- Scope prompt-bound chat discovery to the current workspace storage, so prompts do not accidentally attach to Copilot sessions from another open project.
- Stop an in-progress bound chat from the prompt editor, even after the conversation has been rebound to its saved chat session.
- Rename bound chat sessions both right after the session is first attached during chat launch and later after prompt title or task number changes, even if the prompt id was renamed in the meantime, keep retrying the live chat title refresh across the early launch timing window without waiting for a VS Code reload, and show that rename as a dedicated fourth step in the Process launch block.
- Hide the Process launch block as soon as a bound or reopened chat entry is already available again, so restored chat state does not stay stuck on the opening step.
- Keep the prompt editor page from failing into a blank webview when Process-tab chat-launch UI regressions happen during the initial render path.
- Suppress the false launch-timeout notice by waiting through a short confirmation grace window when the new chat session or tracked request marker appears slightly later than the first session-index pass.
- Keep each visible launch stage on screen for up to one second before the next stage appears, including the initial prepare and auto-load rows, so fast launch progress stays readable from the first step to the last one.
- Prevent the launch block from flashing again later for the same launch when background sync briefly loses and then restores the bound chat-entry signal or the same prompt is reidentified by a later id/UUID normalization step.
- See a clear explanation above the action buttons on every editor tab when Start Chat is temporarily disabled because the prompt is empty, metadata is still generating, or chat launch is already running.
- See Go to chat on every persisted prompt status except Draft and Closed, so reopening the bound Copilot chat stays available outside the initial draft stage.
- See the selected AI model directly in the Process tab launch step, so the opening step confirms which model will be used.
- Reuse the AI model from the most recently updated prompt when you create a draft through Quick Add Prompt, so quick capture starts with the same model you used last.
- Keep the prompt-page `AI Models` dropdown alphabetically sorted, while still showing the current prompt model even if it has not reached the freshly fetched Copilot catalog yet.
- Include prompt file paths, the chat-memory directory, and generated memory instruction file references in the chat start context, including dedicated project instructions stored in chat-memory when present.
- Keep chat launch context explicit about scope: the generated Markdown now adds a dedicated `Excluded projects` section right after `Projects`, that block is informational only so the model treats those folders as read-only exclusions instead of active task scope, and it now lists only excluded folders that still exist in the current workspace.
- Prepend a mandatory note before the generated `### Tools` list in Start Chat context, so listed Skills, MCP tools, hooks, and the preferred model are treated as required task tooling whenever they are available and relevant.
- Keep generated global, project, session, and codemap instruction files as plain Markdown without auto-injected `applyTo` frontmatter.
- Resolve generated session and codemap chat-memory instructions against the current workspace: valid prompt project selections stay scoped, while empty or stale selections fall back to all workspace projects.
- Rebase embedded codemap markdown headings under per-project sections so generated instruction files keep a single top-level H1 and stable nested H2/H3/H4 structure.
- Let prompt auto-complete wait for terminal result markers from the persisted Copilot chat session, so plan-mode or still-streaming chats do not jump to Completed just because the session index already has an end timestamp.
- When a prompt is moved back to In Progress manually or by reopening chat, auto-complete now waits for the next chat request that starts after that status change, so an older completed request in the same bound chat session does not immediately flip the prompt back to Completed.
- Keep best-effort prompt refresh, model refresh, and git overlay debounce timers detached from the Node event loop, so short-lived test and utility runs do not hang waiting for delayed background retries.
- Open, switch, and status-save prompt editor pages faster: the editor shows request-aware loading immediately, paints prompts before slower metadata hydration, keeps silent chat-time refresh off the visible progress line, keeps status-change saves on cached report/base prompt state instead of report.txt refreshes and prompt rereads, skips pending report persist waits and slug/id recalculation for already-open prompts, avoids unchanged prompt.md/report.txt writes and stable report/context file probes for status-only saves, writes stable status-only config updates through a short synchronous local file write, ends the visible save indicator before slower post-save sync work, uses a direct existing-prompt id/UUID path before any broader prompt-list scan, and keeps startup Copilot usage/account refresh from blocking the first prompt save.
- Freeze automatically derived prompt time after a prompt reaches Closed: background chat-session refresh and late chat completion no longer add implementing time, the implementing-time recalc action is hidden for closed prompts, and manual `Misc time` edits stay available for explicit corrections.
- See prompt switches clearly even when loading is fast: the editor now shows blank fixed-height sections for the target prompt before the real data appears, captures the latest rendered block heights before switch/save/close, reuses the latest queued snapshot immediately, avoids duplicate ready/open refreshes after prompt id changes, keeps layout state separated by prompt UUID plus prompt id, and persists those layout snapshots through an async queue to avoid sudden layout jumps without visible skeleton bars. Prompt-loading messages no longer block target prompt loading, real section measurements wait for the first post-open layout pass to settle, saved section heights are held as exact border-box locks while data appears, very fast prompt payloads wait for a short minimum blank-state window, switch placeholders now show the existing centered overlay loader immediately within the prompt form shell, the Workspace branch list keeps its per-prompt expanded or hidden state, the Process tab keeps report auto-resize suspended during open-lock, the Plan section keeps its saved blank height until the async plan snapshot arrives, and Process placeholders no longer add a Memory block when the target prompt has no saved Memory section height. Debug logging includes layout heights, branch-list state, plan hydration, and prompt switch timings for diagnosis.
- Prompt-editor section toggles such as `Files` now stay persisted per prompt through save, new-draft, and reopen flows because the shared editor view-state map is serialized before cross-prompt migrations can run.
- Keep the prompt editor as a single reusable VS Code page: duplicate editor webview tabs are closed automatically even if an older tab was restored or lost from the extension's internal panel tracking.
- Reopening the currently visible prompt now forces a fresh singleton editor boot cycle and replays the exact open payload on the next `ready` handshake, so stale restored prompt tabs stop turning into frozen duplicate prompt pages.
- Keep the prompt, report, and editor state tied to the same workflow instead of splitting them across tools.

### Work with Git without leaving the prompt flow

- View, switch, and create branches in workspace projects.
- Keep a live compact masonry-style prompt editor overview dashboard in the empty right-side space beside the fixed-width prompt form when the editor is wide enough, now with the colored marketplace pm icon before the `Обзор` / `Обновлено` heading block above the widgets, sized to the same 32px chrome footprint as the prompt-form header action buttons, and vertically aligned so the overview toolbar starts on the same horizontal line as the prompt-form header controls.
- Review today's prompts and the most recent previous active day with more than five minutes of work, including clickable task rows, the current prompt status as a larger color-coded chip with a prompt-list-style progress bar only while In Progress, independently loading project widgets that refresh after prompt switching without blocking the main editor flow, mounted snapshots that survive temporary dashboard-rail hides, no reveal-time reload unless hidden git changes actually need a catch-up refresh, and an `Активные промпты` list that skips prompts already moved to `Закрыт` without trimming each day bucket to four rows.
- Use a compact `Ветки проектов` widget for bulk branch switching with immediate `Ветка промпта` and `Tracked-ветка` presets, current-branch-first default selection, labels for current/prompt/tracked branches, per-project apply actions and busy indicators, immediate status/widget refresh after branch switching, prompt parameter edits, external prompt updates, and live git branch/repository-state changes in the tracked workspace projects, where Apply now finishes on the refreshed projects widget instead of waiting for a full dashboard snapshot, single-project pull and tracked-branch follow-up refreshes now rerender only the affected project rows, multi-project branch switches run through bounded parallel Git mutations, loading refreshes keep the previous project rows mounted instead of blanking the widget, tracked-branch applies no longer create a missing local branch implicitly, the prompt-branch preset is disabled when the prompt has no `Ветка Git`, the per-project branch selectors now snap back to the refreshed current branch after bulk or preset applies, branch-switch failures now stay visible directly under the affected project selector inside a bordered warning card instead of disappearing into a generic notice, the per-project action now switches from `Применить` to a green `Получить` button when the selected current branch is behind its upstream and can be pulled directly from the widget, failed single-project pulls now keep their own inline `Ошибка получения опережающих файлов` card under that same project row after refresh, incoming upstream changes for that same branch now appear in a green `Опережающие файлы` disclosure with clickable branch-diff rows whose visible title appends the comma-separated list of unique incoming commit authors, the branch card can temporarily switch to all workspace repositories through `Показать все` without widening the other dashboard widgets, long project names now shorten with a middle ellipsis so both the start and tail stay visible, local uncommitted files now show their own bordered disclosure card with a brighter heading, clickable diff rows, opened-file highlighting, compact added/changed/deleted line counters on the right, no noisy `+0` / `-0` counters, and width-aware relative path prefixes that now stay full while the row still fits and only start collapsing the longest folder segments first when the flat incoming or dirty row runs out of horizontal room, while path-prefix filtering still respects `promptManager.gitOverlay.otherProjectsExcludedPaths`; scoped workspace file edits now queue a one-second reactive refresh for that widget even before the next Git metadata pulse, lazy detail hydration now restores those line counters for dirty files without slowing the normal first widget paint, expanding commit / parallel / dirty file lists now hydrates only the opened project instead of rescanning every workspace repository, expanding the dirty-files disclosure now uses a dedicated change-only refresh that skips branch/review/recent-commit overlay work and batches tracked `git diff --numstat` lookups per change group so counters appear faster in large dirty repositories, already opened dirty/commit/parallel blocks now retry that lazy hydration automatically after a `projects` refresh finishes instead of staying stuck with unresolved placeholders, the background AI follow-up reuses the freshly loaded MR/PR state and keeps already hydrated dirty-file counters instead of wiping them during its lightweight refresh, file-list and file-tree rows now use larger text, clearer symbolic status badges/icons, slightly dimmer folder names, tighter vertical spacing, matching folder/file row line height, and a compact unresolved-stat placeholder instead of a blank slot while counters are still hydrating, the `Статус промпта` card now stays synchronized with local status/time changes, runtime `agent.json` progress updates, and later async dashboard patches, and it now preserves the freshest loaded in-progress percent instead of falling back to the default 50% when `config.json` has no progress but `agent.json` does, external git changes first apply a lightweight branch-state refresh so VS Code stays responsive, startup bootstrap waits for the real prompt before requesting the dashboard, built-in Git repository discovery no longer retriggers dashboard refreshes for every repo open, heavy parallel-branch enrichment now scans only the small rendered branch limit instead of every local cleanup branch, dashboard project snapshots no longer compute per-file working-tree diff stats that the widgets never render, multiple Codemap tracked branches now prefer the project's actual current branch when it already belongs to the tracked set instead of pinning the first configured branch, and the dashboard still falls back to all workspace repos automatically when the saved prompt selection becomes stale or invalid.
- When the prompt has a Git branch and a selected prompt project is currently on another branch, the same `Ветки проектов` widget now marks only that project's branch select with a red validation border; workspace-only rows revealed through `Показать все` stay neutral.
- Refresh any dashboard card directly from its own header: `Статус промпта`, `Активные промпты`, `AI review`, and the Git-backed cards now expose a small refresh button beside the section counter, while the shared Git cards (`Ветки проектов`, `Коммиты проектов`, `Параллельные ветки`, `MR/PR`) reuse the same targeted `projects` refresh path instead of forcing a full rail reload.
- Dashboard snapshot and widget updates now keep accepting late same-prompt payloads after the rail reuses the current snapshot, so `Ветки проектов` and neighboring cards do not get stuck on stale data after compact or hidden transitions.
- Opening an `Опережающие файлы` row now appends the latest file author resolved from the compared upstream ref to the side-by-side diff title, so the review window keeps ownership visible without changing the underlying patch content.
- Inspect separate widgets for project commits, MR/PR, and `Параллельные ветки`, where the first dashboard paint keeps commit and parallel-branch file details lazy until you open those rows so VS Code does not wait on extra Git diff scans, the parallel-branches card now includes already fetched remote-only branches from other authors instead of limiting itself to local cleanup heads and renders each branch row with an inline horizontal lane graph that shows behind distance on the left and ahead distance on the right, collapsed commit rows now also show a lightweight changed-file count immediately instead of `...`, branches that resolve to zero unique files are suppressed from the widget entirely instead of appearing first and disappearing only after expansion, the lightweight parallel-branch pre-count now falls back through merge-base when the shortcut three-dot diff cannot be resolved so branches do not linger as unresolved placeholders and then vanish only after expansion, and if a branch row was already visible but the later details hydrate still cannot return a diff payload for it, the row now stays mounted with an explicit empty/error state instead of disappearing from the widget, multi-column dashboard cards now keep their left-to-right positions stable when any widget disclosure expands without leaving grid-sized empty gutters under shorter cards, each visible parallel branch row now shows the latest branch author after the branch name, expanding a visible parallel branch now hydrates that same branch row instead of dropping it when a different heavy-scan top-N candidate set would have been selected, and the `MR/PR` card now renders after the other Git widgets as the last dashboard card, while the opened parallel branch row still stays visible during details hydration even when the prompt branch does not exist in that repository, fully hydrated branch rows with no unique files are hidden instead of rendering an empty placeholder, and the compact file tree uses shorter `├─` / `└─` branch guides with proportional file and folder names so long paths fit better.
- Read recent commits more directly in `Коммиты проектов`: collapsed rows now show `short SHA + author` on the first line and keep the full commit subject on a separate wrapped line, while Git Flow step 4 now refreshes through the live panel callback after single-project or bulk MR/PR creation and falls back to the latest cached overlay snapshot with optimistic review data if that reread fails, so `Создать MR/PR для всех проектов` no longer hangs on a permanent loader.
- Open commit and branch changes from a compact branch-guided project tree with one-row file entries, compact `+ / ~ / -` counters, rename metadata, persistent `открыт` / `просмотрен` file markers, and direct row click opening, while the diff itself opens the exact commit or branch change in the standard side-by-side VS Code diff editor after those heavier file details hydrate on demand.
- Let AI review present simple user-facing Russian sections, reuse the cached result immediately after prompt switches, stay off the first prompt-open critical path while still auto-starting in the background right after the first dashboard Git refresh whenever the current scope has no review yet, accept the late completion of that same review after a later snapshot request for the unchanged dashboard fingerprint, show a quick local preliminary summary if the model is still thinking after a few seconds, cache the selected Copilot chat model for short bursts of repeated requests, send AI prompt logging to disk off the critical path, send more compact dashboard data to the model so the review usually returns faster, let manual refresh return the refreshed snapshot before AI review finishes, keep the background AI projects refresh lightweight by reusing cached commit/parallel trees until explicit details hydration is requested, refresh silently after branch-apply so the projects widget stays stable while the review catches up in the background, rerender only the touched project rows during that post-action follow-up instead of replaying a full projects refresh, fetch pipeline status only for manual AI review/full dashboard refresh instead of the normal first widget paint, pause stale review/widget jobs as soon as prompt switching starts, and keep pipeline status bound to the latest workflow or pipeline run for each project's actual current branch.
- Guard branch actions with dirty-worktree checks.
- Surface dirty workspace projects in Git Flow step 1 even when they are not yet attached to the prompt.
- Hide selected generated or noisy paths from the Git Flow step 1 “Changes in other projects” block with `promptManager.gitOverlay.otherProjectsExcludedPaths`, without changing the selected prompt projects themselves.
- In large workspaces, keep Git Flow faster by calculating the full overlay state only for the selected prompt projects, while neighboring repositories in the “Changes in other projects” block are loaded separately through a lighter snapshot path that now short-circuits fully clean peer repositories before the heavier change scan; peer-only auto-refresh updates also reuse that lighter path.
- Keep the first visible Git Flow payload out of the slow-path with a two-phase open: selected projects first render from a lightweight branch-first summary snapshot that defers review setup/request detection and skips extra recent-history loading, change groups, and local/remote branch enumeration on the first paint, and only then hydrates the full selected-project details and lazy “Changes in other projects” data.
- Keep the first Git Flow opening cycle resilient to webview lifecycle churn: the overlay session now preserves a short callback history for the same panel, so a follow-up visibility sync does not invalidate an already-ready summary snapshot before it reaches the webview.
- Keep the first full selected-project hydrate focused on branch and change data: review setup/request detection now lands afterward through lightweight per-project patches, and the review step stays pending until that background hydration finishes.
- Keep the first full selected-project hydrate off the branch-enumeration slow path too: local/remote branch metadata and cleanup candidates are now hydrated afterward through lightweight per-project patches, and branch-dependent controls show a loading state until that data arrives.
- Keep those review follow-up patches narrow too: Git Flow now reuses the existing project snapshot and resolves only review state for `open-review`, instead of recomputing branch and change metadata a second time.
- Keep Git Flow opening visually stable too: the webview now receives the snapshot phase explicitly and masks stale open data with loader cards and a compact summary loader until the next snapshot and automatic branch/review hydration are ready, while refresh keeps the current step content visible and shows only the header progress line.
- Keep branch-check warnings stable during that opening cycle too: the summary/light snapshots now keep their tracked-branch list stable until branch metadata is hydrated, so Git Flow does not flash prompt-branch or tracked-branch blockers that disappear a moment later.
- When Start Chat opens Git Flow and the regular Start action is visible but disabled, the footer now also shows a dedicated Start on current branches action so chat can continue without waiting for the standard branch-check path.
- Keep step 1 clean-state hints stable during open and refresh by waiting for hydrated tracked-branch metadata before showing “nothing to commit” messages.
- Keep the step 1 “Changes in other projects” block stable during refresh too: the editor preserves the last loaded peer-project snapshot until the next lazy other-project update arrives, so the block no longer disappears and reappears while Git Flow is updating.
- Keep reactive Git Flow refreshes focused on real repo changes: commit and checkout events plus filesystem and git metadata watchers still refresh the overlay, but noisy built-in repository state pulses no longer queue endless auto-refresh loops while a refresh is already running.
- Keep the second-phase Git Flow hydrate lighter too: selected and peer project change lists now open without per-file diff enrichment, clean repositories short-circuit before extra diff commands, and file-level metrics are hydrated lazily only when a specific project card is expanded.
- Reopening Git Flow after a completed commit no longer keeps step 2 commit buttons stuck in a false loading state: fresh overlay snapshots now prune stale pending commit tracking when the requested projects are already clean or the old request has clearly aged out.
- Keep bulk multi-project Git Flow actions responsive by running independent fetch, sync, push, review-request, and commit operations with controlled parallelism while preserving deterministic project ordering in the UI results.
- When `promptManager.debugLogging.enabled` is enabled, Git Flow writes duration metrics for selected snapshots, lazy other-project snapshots, refresh, bulk git operations, and per-project full-hydrate stages such as local branches, remote branches, and lightweight change scans into the existing debug log stream for easier before/after comparisons.
- Keep Git Flow visually scoped to the active prompt: switching prompts now resets step state instead of reusing the previous prompt’s section data, and reopening the overlay auto-collapses completed sections that no longer contain warnings.
- Keep the Git Flow Done action consistent with Save by persisting the final derived prompt status before the overlay closes.
- Keep branch references and task metadata near the prompt itself.
- Use the Git-oriented editor flow to support commits, review preparation, and related prompt execution.

### Track delivery, not just prompt writing

- Move prompts through a full lifecycle in the tracker panel.
- Change a prompt status directly from the sidebar item menu, including the More button and the context menu.
- Review the Process tab in workflow order with notes first, then the plan, and the report after that.
- See the current prompt status directly inside the Process tab Notes section: it is shown in the section header and again at the top of the block, using the same compact color treatment as the sidebar prompt list.
- New prompts always open on the Main tab with Basic, Time tracking, Workspace, Prompt,
  and Agent expanded by default, Notes starts collapsed but reopens automatically when it
  receives content before any manual toggle, and Plan and Report now also reopen when they
  were manually toggled while still empty and content appears later, while non-empty sections
  keep respecting later manual collapse changes, Start Chat waits for title and description
  enrichment to finish, and prompt folders stay stable after chat start while the Process tab
  only shows launch progress until the chat binding is actually unfinished.
- Open plan and report content through consistent inline Open actions across the prompt editor.
- Edit shared agent context and a dedicated project instructions file directly from the General instruction block, and open both from the editor without leaving the workflow.
- Let Start Chat refresh the shared agent context automatically when the field is still remote-backed or has been reset to empty, keep manual edits as an explicit freeze on that snapshot until you load it again yourself, and see the current auto-load state directly in the Process tab while chat launch is running.
- See a clear “No others” marker in Git Flow step 1 rows where the expected branch field is hidden because there are no alternative target branches to choose from.
- Track writing time, implementation time, overall time on task, and untracked corrections.
- Let the report editor expand to the content automatically without blanking the webview when the section opens, keep that height in sync when the editor width changes, and avoid clipping the bottom of long reports, while a new Start Chat run clears the previous plan after the launch preflight succeeds.
- Keep the surrounding Process-tab scroll position stable while typing in a long `Результат работы` report, switching between Text / Html / Markdown views, or leaving the editor on blur: the raw Text source mode now uses the same `contenteditable`-based editor surface family instead of a native textarea, pending prompt autosave stays deferred until the inline editor really yields focus, mode switches snapshot and restore page scroll before the surface swap, and unstable first-pass auto-resize measurements are retried instead of collapsing the editor to a false minimal height.
- Use the inline `Копировать` action in the report field toolbar to copy the current mode representation into the clipboard: raw text in Text mode, rendered HTML markup in Html mode, and the markdown source in Markdown mode.
- Closing the separate report editor right after Save now keeps the latest edits by flushing any still-unsynced local report state before the window goes away.
- Open statistics and export delivery-friendly summaries in HTML or Markdown.
- Auto-fill report hours from working days in the selected period, persist the hourly rate per workspace, and omit hour or cost sections when those values are empty or zero.
- Keep reports inside the prompt workflow instead of treating them as a separate afterthought.

### Build project memory from real repository history

- Start on a dashboard-first Memory landing page with a shared visual layout, top-level navigation for Dashboard, Histories, Instructions, and Settings, and at-a-glance metrics for coverage, storage, activity, authors, files, and recent histories.
- Open the Project Memory panel to browse commits, file changes, and stored analysis.
- Run AI-powered history analysis with configurable models and a dedicated background priority control that defaults to the new `lowest` mode.
- Use semantic search over embeddings to find similar work by meaning, not just by text.
- Inspect knowledge-graph style relationships and code-oriented instruction snapshots.
- Manage history-memory and codemap-instruction options from one unified Settings screen with internal tabs instead of jumping between separate settings views.
- Refresh codemap instructions from the instructions view with locale-specific persistence, selected-branch delta snapshots that stay tied to the branch you actually chose, and a default `lowest` priority tuned to stay closer to idle CPU time.

### Monitor Copilot usage inside VS Code

- See Copilot Premium request usage in the status bar.
- When the saved GitHub session becomes stale or invalid, the status bar now switches to an explicit sign-in error state instead of showing inflated fallback usage numbers.
- During startup, cached usage state is reused while background refreshes settle, and the status bar does not immediately run account-summary auth checks when cached usage is available, so prompt editor saves are not held behind Copilot usage/account diagnostics.
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

The bundled desktop publish flow packages Marketplace VSIX targets for Linux, Windows, and macOS first, then publishes those prebuilt VSIX files together in one Marketplace release so the same extension version can carry every desktop target. VS Code Web is still unsupported because the extension currently ships only a Node-based `main` entry and no `browser` host bundle.

## Quick Start

1. Open **Prompt Manager** from the Activity Bar.
2. Create a new prompt from the sidebar.
3. Use Quick Add Prompt from the pm icon in the editor title actions near the tab bar when you want to paste raw prompt text into a new draft and let the extension auto-fill title and description in the background.
4. Fill in the brief: title, description, workspace projects, languages, frameworks, branch, task number, and AI model.
5. Add prompt content in Markdown and attach context files if needed.
6. Save the prompt and launch GitHub Copilot Chat directly from the editor.
7. Use the tracker and statistics panels to move the task forward and keep reporting aligned.
8. If you want long-term recall, open **Project Memory** and start building repository history into a searchable assistant layer.

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
- Use `promptManager.gitOverlay.otherProjectsExcludedPaths` when Git Flow step 1 should ignore generated folders or path prefixes in the “Changes in other projects” block.
- Tune voice input with `promptManager.voice.whisperModel`, `promptManager.voice.language`, and `promptManager.voice.aiPostCorrection` when local STT speed or quality needs adjustment.
- Enable Project Memory when your repository history is valuable enough to search semantically.

Полезная настройка для multi-root workspace:

- `promptManager.excludedProjects` — список имен workspace folders, которые нужно полностью скрыть из `Projects`, `Git Flow`, prompt dashboard, Project Memory и runtime-путей CodeMap; новые memory/codemap данные по ним больше не строятся, а уже сохраненная история остается в хранилище.

## Actively Evolving Areas

The extension already covers a broad daily workflow, but some surfaces are still expanding and should be treated as evolving capabilities rather than a fixed end state.

- Voice-assisted prompt input and transcription workflows, including the background recognition queue
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

