# GitHub Copilot Usage Tracker

See your GitHub Copilot request quota at a glance — right from the VS Code status bar. No manual input needed: the extension connects to your GitHub account automatically and keeps the widget up to date every 5 minutes.

## Features

- **Live status bar widget** — shows usage count, percentage, or both, with an optional ASCII progress bar
- **Automatic authentication** — connects via your existing VS Code GitHub session; no setup required in most cases
- **Daily cumulative target** — optionally compare your usage against a pro-rated daily budget (adapts to the real number of days in the month)
- **Color indicators** — green when you're fine, orange above 80 %, red when the quota is reached
- **Usage history** — browse all snapshots recorded this month
- **Fully customisable display** — change every option directly from the details panel without opening Settings

## Status Bar

The widget lives in the bottom-right corner. Examples depending on your display settings:

| Setting combination | Widget |
|---|---|
| Count + Bar | `⬡ 42/300 [▰▰▱▱▱▱▱▱]` |
| Count only | `⬡ 42/300` |
| Percent only | `⬡ 14%` |
| Both + Bar | `⬡ 42/300 (14%) [▰▰▱▱▱▱▱▱]` |

## Display Settings

Click the widget to open the details panel. At the bottom you'll find three toggle groups:

| Setting | Options | Description |
|---|---|---|
| **Display Mode** | Count / Percent / Both | What numbers to show in the widget |
| **View Style** | Bar / Text / Both | Show an ASCII bar, plain text, or both |
| **Usage Reference** | Total / Daily | Compare against the full monthly quota or today's cumulative daily target |

Settings are saved globally and take effect immediately on the widget.

## Authentication

The extension tries two methods automatically:

1. **GitHub session** — uses the GitHub account already signed into VS Code (no extra steps)
2. **Personal Access Token** — use *Copilot Usage: Set GitHub Token (PAT)* if the automatic method doesn't work

To sign out, click **Disconnect from GitHub** at the bottom of the details panel, or run *Copilot Usage: Disconnect from GitHub* from the Command Palette.

## Color Indicators

| Color | Meaning |
|---|---|
| Default | Usage below 80 % |
| 🟡 Orange | Usage between 80 % and 99 % |
| 🔴 Red | Quota reached (100 %+) |

## Commands

All commands are available via the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`):

| Command | Description |
|---|---|
| `Copilot Usage: Refresh` | Force a data refresh |
| `Copilot Usage: Show Details` | Open the details panel |
| `Copilot Usage: Show History` | Browse this month's snapshots |
| `Copilot Usage: Authenticate with GitHub` | Trigger a GitHub sign-in |
| `Copilot Usage: Set GitHub Token (PAT)` | Save a Personal Access Token |
| `Copilot Usage: Disconnect from GitHub` | Clear token and cached data |
| `Copilot Usage: Show Logs` | Open the output channel for debugging |

## Installation

1. Package the extension:

```bash
npm install -g @vscode/vsce
vsce package
```

2. Install the `.vsix` file in VS Code:
   - Go to Extensions (`Cmd+Shift+X` / `Ctrl+Shift+X`)
   - Click the `···` menu → **Install from VSIX…**
   - Select the generated `.vsix` file

## License

MIT
