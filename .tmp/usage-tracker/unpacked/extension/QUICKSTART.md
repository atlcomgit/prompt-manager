# Quick Start Guide - VS Code Extension

## Test the Extension (Development Mode)

1. **Open the extension folder in VS Code**:

   ```bash
   code "/Users/romain/PERSO/usage_traker/GitHub Copilot Usage Tracker/extension"
   ```

2. **Press F5** to launch the Extension Development Host

   - A new VS Code window will open with the extension loaded

3. **Look at the bottom-right status bar**

   - You should see: "$(graph) Copilot Usage"

4. **Click on the status bar item** to enter your current usage

   - Enter a percentage (e.g., `45.5`)
   - The status bar will update with your usage vs. target

5. **View the status**:
   - The display will show something like: "📊 45.5% | Target: 33.3% | Ahead by 12.2%"

## Commands (Cmd+Shift+P)

- `Enter Current Copilot Usage` - Enter your current percentage
- `Show Copilot Usage History` - View all entries for the current month

## How the Target Works

The target is calculated based on the day of the month:

- Target = (Current Day / Total Days in Month) × 100
- Example: On day 10 of a 30-day month, target = 33.3%
- Goal: Reach 100% usage by the end of the month

## Status Bar Colors

- **No background**: On track or ahead
- **Yellow/Orange**: Behind by 5-10%
- **Red**: Behind by more than 10%

## Package the Extension (Optional)

To create a .vsix file for installation:

```bash
cd extension
npm install -g @vscode/vsce
vsce package
```

Then install it: Extensions → "..." menu → "Install from VSIX..."
