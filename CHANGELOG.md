# Changelog

## [Unreleased]

### Improved
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
