# Claude Code Terminal for Obsidian

Embed Claude Code as an interactive terminal right in Obsidian's sidebar. Open it with a hotkey, send your note selections to Claude, and toggle focus between editor and terminal without leaving Obsidian.

## Features

- **Sidebar terminal** — Claude Code runs in the right sidebar via xterm.js + node-pty
- **Send selection** — Select text in a note, run a command, and it appears in Claude's input with file path and line numbers
- **Send current file** — Send the active file's path to Claude with one command
- **Focus toggle** — Switch between editor and terminal without touching the mouse
- **Theme sync** — Terminal colors automatically match your Obsidian theme (dark/light)
- **Configurable** — Claude CLI path, font size, font family, extra CLI args, working directory override

## Installation

### From source (recommended for now)

```bash
git clone https://github.com/sungjin/obsidian-claude-code.git
cd obsidian-claude-code
npm install
npm run build
```

Copy `main.js`, `manifest.json`, `styles.css`, and the `node-pty` folder from `node_modules/node-pty` to your vault's `.obsidian/plugins/obsidian-claude-code/` directory.

### Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed (`npm install -g @anthropic-ai/claude-code`)
- Obsidian 1.5.0+ (desktop only)
- Node.js build tools for native module compilation (`xcode-select --install` on macOS)

## Commands

| Command | Description |
|---------|-------------|
| Toggle Claude Code terminal | Open/close the terminal sidebar |
| Send selection to Claude | Send selected text with file context to Claude |
| Send current file to Claude | Send `@filepath` to Claude |
| Focus Claude Code terminal | Toggle focus between editor and terminal |

Set hotkeys in Settings > Hotkeys. Recommended: `Cmd+2` for toggle.

## Settings

- **Claude CLI path** — Default: `claude`. Change if installed elsewhere.
- **Font size** — Terminal font size (default: 14)
- **Font family** — Terminal font (default: system monospace)
- **Extra CLI arguments** — Additional args passed to Claude CLI (e.g., `--model sonnet`)
- **Working directory** — Override the working directory (default: vault root)

## How it works

The plugin spawns Claude Code CLI in a pseudo-terminal (PTY) using node-pty, renders it with xterm.js in an Obsidian sidebar view. Editor integration commands inject text into the terminal input buffer (paste-only, no auto-submit). A terminal state machine (closed/opening/ready/exited) ensures commands wait for the PTY to be ready before sending text.

## Limitations

- **Desktop only** — requires node-pty (native module), does not work on mobile
- **No inline diffs** — Obsidian API does not support inline diff views
- **No automatic context** — unlike VS Code, context sharing is command-based, not automatic
- **Native module build** — node-pty must be compiled for your Obsidian's Electron version

## License

MIT
