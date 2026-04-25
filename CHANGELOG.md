# Changelog

## [Unreleased]

### Added
- AI post-correction of Whisper transcriptions via Copilot Language Model API (`promptManager.voice.aiPostCorrection`, enabled by default). Automatically corrects STT errors, restores punctuation and casing after speech-to-text processing.

### Changed
- Memory webview fully redesigned with a flat design language: all shadows removed, panels use thin 8% foreground-opacity borders, accent lines (3-4px colored left/top borders) replace heavy shadows for visual hierarchy, buttons are flat solid backgrounds without gradients, segmented tabs use a subtle contained bar, metric cards have a 3px top accent border, badge/pill shapes changed from pill (999px) to 6px radius rectangles, progress bars thinned to 6-8px, typography upgraded with uppercase labels, tighter letter-spacing, and larger metric numbers (32px), and dialog overlays use stronger backdrop blur with no box-shadow.
- Memory header card now uses a left accent border with a subtle gradient tint instead of heavy box-shadow and old gradient; eyebrow labels use the accent color for visual hierarchy.
- Navigation tabs (segmented tabs) now display inactive labels at 60% foreground opacity for better readability; active tab gets a subtle shadow lift for clearer distinction.
- Commit list in the History section now includes an inline search bar at the top for quick full-text/semantic search without switching to a separate tab.
- Settings panel labels increased to 12px bold foreground, descriptions use 70% opacity foreground for better readability, and field spacing reduced for a denser layout.
- Memory metric cards use a tinted background (2% foreground mix) for subtle depth, and the Dashboard hero panel has a soft gradient toward the accent color.
- List items in History and Instructions no longer leave border artifacts when switching selection; borders are removed in favor of clean left accent marks on active items.
- Custom scrollbar styling added to the Memory webview with thin 6px tracks and subtle foreground-colored thumbs.
- Copilot Premium Usage page redesigned: single-column layout, area chart with gradient and Catmull-Rom smoothing for trend visualization, color-coded daily bars (green/orange/red vs recommended pace), merged status footer with collapsible debug log.
- Quick Add Prompt is now also available as an editor title action near the tab bar using the Prompt Manager PM icon, it now stores the pasted input as prompt text instead of the Title field and runs the same automatic title and description enrichment used by the editor page, and custom-group sections in the sidebar now use each group color as the header background with automatic black-or-white contrast for the label.
- Project Memory now opens on a new dashboard-first landing page with top-level Dashboard / Histories / Instructions / Settings navigation, unified card styling across the Memory webview, richer overview charts and rankings, and a single Settings surface that combines history-memory and codemap instruction options under internal tabs.

### Fixed
- Prompt editor now enforces a single VS Code webview page for prompts by closing duplicate `promptManager.editor` tabs even when an older or restored tab is no longer tracked in the extension's internal panel map.
- Prompt editor opening, prompt switching, and status-change saves now avoid slow visible busy states: opening uses request-aware loading and post-open metadata hydration, silent chat-time recalculation stays off the visible progress line, status-change saves use the in-memory report binding and loaded base prompt instead of refreshing report.txt or rereading the prompt before writing, skip pending report persist waits and slug/id recalculation for already-open prompts, avoid unchanged prompt.md/report.txt writes and stable report/context file probes for status-only saves, write stable status-only config updates through a short synchronous local file write, end the visible save indicator before slower post-save sync work, and keep existing-prompt saves on the direct id/UUID identity path instead of scanning prompt lists.
- First prompt save after VS Code startup no longer waits behind Copilot usage/account diagnostics: activation and status bar startup reuse cached usage state instead of forcing immediate account summary/auth lookups, overlapping refresh calls return the current cache while another fetch is in flight, and VS Code `state.vscdb` fallback reads use async single-key SQLite lookups.
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
- Git Flow step 1 can now hide configured repo-relative path prefixes from the “Changes in other projects” block via `promptManager.gitOverlay.otherProjectsExcludedPaths`, and explicitly selected projects with zero changes now show “Exclude” instead of “Switch”.
- Closing the separate report editor right after Save no longer drops the latest edits; the webview now flushes unsynced local report state during shutdown so the first save survives the window close.
- Prompt pages no longer open as a blank webview after the recent Process-tab launch-block refactor; the editor render path now avoids the launch-state runtime failures that could break initial load.
- Prompt chat launch no longer shows the false "Chat launch was not confirmed" notice when the early session index lags behind and the same launch is confirmed a moment later by the tracked chat request state.
- The Process tab chat launch block now keeps each visual stage visible for at least one second before advancing, including the initial prepare and auto-load rows, so the whole sequence stays readable from the first step onward.
- The Process tab chat launch block no longer reappears later for the same launch when a transient prompt sync briefly drops chat-entry state or when the same prompt is reidentified by a later id/UUID normalization pass.
- Copilot Premium Usage no longer falls back to inflated local counters when the GitHub session is stale or invalid; the status bar now shows a dedicated sign-in error state instead of misleading percentages.
- Git Flow step 1 now shows a dedicated “No others” marker in rows where the expected branch field is hidden because there are no alternative target branches to choose from.
- The Process tab report editor no longer clips long Markdown or HTML output at the old 800px auto-resize ceiling, and it now recalculates height when the editor width changes so wrapped content stays fully visible.
- Session and codemap chat-memory instruction files now resolve prompt project scope against the current workspace, fall back to all workspace projects when saved selections are stale, and keep generated Markdown headings nested under a single document root instead of dropping embedded H1 sections into project blocks.
- Prompt chat launch confirmation now waits for a detected chat session before the Process block marks "Open Copilot Chat" as done, the false "Chat launch was not confirmed" notice is shown only after real confirmation timeout, and the launch block completion delay now starts after the final rename step finishes.
- Prompt editor background refresh and debounce timers now detach from the Node event loop when they are running as best-effort follow-up work, so test runs and other short-lived processes no longer sit idle for up to two minutes waiting for delayed chat/session refresh retries to expire.
- Prompt chat auto-complete no longer trusts only `lastRequestEnded` timing from the VS Code chat session index; it now waits for terminal request markers from the persisted chat session JSONL, preventing plan-mode and still-streaming chats from flipping prompts to Completed too early.
- Prompt status recovery now remembers when a prompt was manually moved back to In Progress or reopened in chat and only auto-completes again after a newer chat request starts, preventing the same already-finished request from forcing the prompt back to Completed.
- In the sidebar prompt list, selected in-progress items now render the third-column progress bar with an outlined inverse track, and 100% completion uses a more saturated green so progress stays readable on active selection.
- The Process tab Notes section now shows the current prompt status both in the section header and at the top of the block, reusing the same compact status color contract as the sidebar prompt list.
- Prompt-local context files stored under .vscode/prompt-manager/<prompt>/context now survive prompt folder renames and reopen correctly after the editor page is closed and opened again; stale config.json references are auto-repaired on load and on the next save.
- Background codemap refresh and manual history analysis now default to the new `lowest` background priority, lower the scheduling priority of their git subprocesses, and insert extra idle-friendly pauses between heavy batches so Memory page work no longer competes as aggressively with active CPU use.
- Quick Add Prompt now preselects the AI model from the most recently updated saved prompt, matching the default model behavior of the regular new-prompt flow.
- Reopening a prompt-bound chat session no longer falls back to a generic empty chat window just because the chat view memento is stale; bound sessions now reopen directly by session resource.
- Prompt-bound chat detection is now scoped to the current workspace storage bucket, preventing prompts from binding to active Copilot sessions from unrelated VS Code workspaces.
- The editor Stop button now cancels the active agent request for a prompt-bound chat by focusing the bound session before dispatching the chat cancel command.
- Bound chat sessions are now renamed both immediately after the launch flow binds a new chat session and again after a prompt title or task number change, the rename flow can still resolve the prompt through promptUuid after the prompt id changes, current VS Code builds now keep retrying the live title refresh through the early bind timing window instead of stopping after the first persisted rename, and the Process launch block shows that early rename as a dedicated fourth step.
- The Process launch block no longer stays stuck on "Open Copilot Chat" after a bound or reopened chat entry is already available again but transient launch flags were lost during sync.
- The editor now shows a more readable inline explanation above a disabled Start Chat button on every tab so it is clear whether prompt text is missing, metadata enrichment is still running, or chat launch is already in progress.
- The inline Start Chat notice is now limited to draft prompts before launch, and prompts already in progress no longer briefly re-show Start Chat after the launch spinner finishes.
- The Process tab chat launch block now shows the selected AI model directly inside the "Open Copilot Chat" step, with the model name emphasized for quicker visual confirmation.
- Generated global, project, session, and codemap instruction files no longer auto-inject an `applyTo` frontmatter block, while legacy project instruction files are still normalized on read and save.
- Copilot Premium Usage now correctly shows daily request counts by forward-filling snapshot gaps for days the extension was not running, and no longer clamps historical usage values to current-day counter.
- Git Flow now captures elapsed prompt time before switching to the final Done status, and even when Done does not change the status it still runs the regular save path so elapsed prompt time is persisted.
- Sidebar prompt items now show a loader instead of stale status or progress while a prompt is being saved or its title/description AI enrichment is still running.

### Changed
- Migrated STT engine from deprecated `@xenova/transformers` v2 to `@huggingface/transformers` v4 with `dtype: 'q8'` quantization for improved Russian speech recognition quality.
- Upgraded Whisper model from `whisper-tiny` (39 MB) / `whisper-base` (74 MB) to `onnx-community/whisper-small` (~60 MB quantized) for significantly lower word error rate (~12% vs ~25% on Russian).
- Added `promptManager.voice.whisperModel` and `promptManager.voice.language` configuration settings.

### Fixed
- Codemap instruction refresh now updates locale-specific records deterministically and selected delta refresh resolves the chosen branch against its own head/tree references instead of mixing them with the active workspace branch.
- Grouped prompt lists now allow temporary collapse changes while filters are active without overwriting the remembered group expansion state that returns after filters are cleared.
- The sidebar no longer adds a separate Favorites group on top of grouped results, and the import, filter, and view utility buttons use a lighter idle palette with darker pressed or active feedback.
- Git Flow step 1 now includes dirty workspace projects outside the current prompt selection so they can be added directly from the overlay.
- New prompts now always open on the Main tab, Start Chat stays disabled while title or description AI enrichment is still running, prompt folders stop renaming after chat start fixes the directory path, and completed chat-launch blocks no longer reappear just because status was manually switched back to In Progress.
- New prompt editor disclosure rules now open Basic, Time tracking, Workspace, Prompt, and Agent by default, while Notes starts collapsed and Notes, Plan, and Report expand automatically when content appears until the section is toggled manually.
- Starting a fresh chat now clears an existing prompt plan only after the start preflight succeeds, so stale plan steps do not leak into the next run.
- Plan and Report now reopen automatically when their section was still empty at the time of a manual toggle and content appears later, while non-empty sections continue to respect the user's manual collapse state.
- Opening the Report section no longer risks blanking the editor webview when the auto-resizing report editor mounts.

### Improved
- Copilot Chat start context now includes the absolute chat-memory directory together with generated memory instruction file references.
- The prompt editor header can open a dedicated chat-memory project.instructions.md file, the General instruction block can edit it directly, and report editing now grows with content automatically instead of relying on manual resize.
- Start Chat now refreshes the shared agent context from the latest editor state instead of relying on stale persisted metadata, empty shared-context values still trigger a fresh remote load on launch, manual edits disable the auto-refresh until the remote context is loaded again, failed refresh attempts fall back to the last saved value without blocking chat launch, and the Process tab now shows that auto-load state inline as a launch step.

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
