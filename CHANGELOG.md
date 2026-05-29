# Changelog

All notable changes to this project are documented in this file.

Unreleased changes are grouped by the date they landed. Tagged releases remain grouped by version and release date.

## [Unreleased]

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