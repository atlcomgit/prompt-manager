# Changelog

## [Unreleased]

### Added
- AI post-correction of Whisper transcriptions via Copilot Language Model API (`promptManager.voice.aiPostCorrection`, enabled by default). Automatically corrects STT errors, restores punctuation and casing after speech-to-text processing.

### Changed
- Copilot Premium Usage page redesigned: single-column layout, area chart with gradient and Catmull-Rom smoothing for trend visualization, color-coded daily bars (green/orange/red vs recommended pace), merged status footer with collapsible debug log.
- Quick Add Prompt is now also available as an editor title action near the tab bar using the Prompt Manager PM icon, it now stores the pasted input as prompt text instead of the Title field and runs the same automatic title and description enrichment used by the editor page, and custom-group sections in the sidebar now use each group color as the header background with automatic black-or-white contrast for the label.

### Fixed
- Reopening a prompt-bound chat session no longer falls back to a generic empty chat window just because the chat view memento is stale; bound sessions now reopen directly by session resource.
- Prompt-bound chat detection is now scoped to the current workspace storage bucket, preventing prompts from binding to active Copilot sessions from unrelated VS Code workspaces.
- The editor Stop button now cancels the active agent request for a prompt-bound chat by focusing the bound session before dispatching the chat cancel command.
- Bound chat sessions are now renamed both immediately after the launch flow binds a new chat session and again after a prompt title or task number change, the rename flow can still resolve the prompt through promptUuid after the prompt id changes, current VS Code builds now keep retrying the live title refresh through the early bind timing window instead of stopping after the first persisted rename, and the Process launch block shows that early rename as a dedicated fourth step.
- The editor now shows a more readable inline explanation above a disabled Start Chat button on every tab so it is clear whether prompt text is missing, metadata enrichment is still running, or chat launch is already in progress.
- The inline Start Chat notice is now limited to draft prompts before launch, and prompts already in progress no longer briefly re-show Start Chat after the launch spinner finishes.
- The Process tab chat launch block now shows the selected AI model directly inside the "Open Copilot Chat" step, with the model name emphasized for quicker visual confirmation.
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
