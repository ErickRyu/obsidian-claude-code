# Claude Code Terminal for Obsidian

Embed Claude Code as an interactive terminal right in Obsidian's sidebar. Open it with a hotkey, send your note selections to Claude, and toggle focus between editor and terminal without leaving Obsidian.

## Features

- **Sidebar terminal** — Claude Code runs in the right sidebar via xterm.js + node-pty
- **Multi-tab support** — Open multiple Claude Code terminals simultaneously
- **Automatic workspace context** — Claude Code automatically knows which notes are open and which one is active, without you having to tell it
- **MCP context server** — Built-in MCP server exposes tools so Claude can read your open notes, search the vault, and fetch any note on demand
- **Cmd/Ctrl+click vault notes** — Click any vault path or `obsidian://open` URL Claude prints in the terminal to open the corresponding note in Obsidian
- **Send selection** — Select text in a note, run a command, and it appears in Claude's input with file path and line numbers
- **Send current file** — Send the active file's path to Claude with one command
- **Focus toggle** — Switch between editor and terminal without touching the mouse
- **Theme sync** — Terminal colors automatically match your Obsidian theme (dark/light)
- **Configurable** — Claude CLI path, font size, font family, extra CLI args, working directory override

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and available in your PATH
- Obsidian 1.5.0+ (desktop only, not available on mobile)

## Installation

### Via BRAT (recommended)

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat)
2. Open BRAT settings and click "Add Beta Plugin"
3. Enter `ErickRyu/obsidian-claude-code`
4. Enable the plugin in Community Plugins settings

The plugin will automatically download the required native module (node-pty) for your platform on first launch.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/ErickRyu/obsidian-claude-code/releases/latest)
2. Create a folder `.obsidian/plugins/obsidian-claude-code/` in your vault
3. Copy the downloaded files into that folder
4. Enable the plugin in Obsidian settings

The plugin will attempt to download the node-pty native binary automatically. If auto-download fails, download the appropriate `node-pty-{platform}.tar.gz` from the release page and extract it into the plugin folder.

### From source

```bash
git clone https://github.com/ErickRyu/obsidian-claude-code.git
cd obsidian-claude-code
npm install
npm run build
```

Copy `main.js`, `manifest.json`, `styles.css`, and `node_modules/node-pty/` to your vault's `.obsidian/plugins/obsidian-claude-code/` directory.

## Commands

| Command | Description |
|---------|-------------|
| Toggle Claude Code terminal | Open/close the active terminal |
| New Claude Code terminal | Open an additional terminal tab |
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
- **MCP context server** — Enable the built-in MCP server so Claude can access open notes, active file, and vault search (default: on). Requires terminal restart after toggling.

## How it works

The plugin spawns Claude Code CLI in a pseudo-terminal (PTY) using node-pty, renders it with xterm.js in an Obsidian sidebar view. Editor integration commands inject text into the terminal input buffer (paste-only, no auto-submit). A terminal state machine (closed/opening/ready/exited) ensures commands wait for the PTY to be ready before sending text.

### Workspace context

On load, the plugin starts a lightweight MCP (Model Context Protocol) server that exposes Obsidian's workspace state to Claude Code. It does two things:

1. **System prompt injection** — A short prompt file listing currently open notes and the active note is auto-generated and passed to Claude via `--append-system-prompt-file`. Claude always knows which notes you have open without you telling it.
2. **MCP tools** — Claude can call `get_active_note`, `list_open_notes`, `read_note`, and `search_notes` on demand to fetch note content or search the vault.

The plugin writes `.mcp.json` and `.claude/settings.local.json` in your vault on load so Claude Code auto-discovers the server and pre-approves the tools (no per-call permission prompts). These are cleaned up when the plugin is disabled.

## Webview mode (Beta, opt-in)

> **v0.6.0 Beta · opt-in · existing users see zero change by default.**
>
> v0.6.0 ships a brand-new **custom webview** that runs alongside the legacy xterm.js terminal. Instead of showing raw terminal output, the webview spawns `claude -p --output-format=stream-json` via `child_process.spawn`, parses the JSONL event stream, and renders **structured HTML cards** for `assistant` text, `tool_use`, `tool_result`, and `result` events. This is the foundation for v0.7.0 inline diff accept/reject and v0.8.0 plan-as-note. Today's release is **infrastructure-only** — the terminal path is unchanged and remains the default.

### How to enable

1. Open **Settings → Community Plugins → Claude Code Terminal**.
2. Find the **UI mode** dropdown and change it from `Terminal (xterm.js — default)` to `Webview (beta)`.
3. You will see a Notice: *"웹뷰 적용을 위해 Obsidian 재시작 필요 / Restart Obsidian to apply UI mode change"*.
4. Fully restart Obsidian (the view registration is fixed at plugin load — runtime re-registration is intentionally deferred to keep the lifecycle simple in Beta).
5. After restart, run the **Open Claude Webview** command (or click the sidebar icon) to open the new view.

To go back, switch the dropdown to `Terminal (xterm.js — default)` and restart Obsidian. Your existing terminal-mode settings (CLI path, font, MCP, hotkeys, etc.) are untouched.

### Permission presets

The webview does not show inline per-call permission prompts in this Beta. Instead, you choose a **preset** that translates to `--allowedTools` + `--permission-mode` flags on the next spawn:

| Preset | Allowed tools | When to use |
|--------|---------------|-------------|
| **Safe** | `Read`, `Glob`, `Grep` (read-only) | Browsing, summarizing, planning — Claude cannot modify your vault |
| **Standard** *(default)* | Safe + `Edit`, `Write`, `TodoWrite` | Normal editing workflow without shell access |
| **Full** | Standard + `Bash` | Power users who trust the session — Claude can execute shell commands |

Change the preset from the **Permission preset (Webview)** dropdown in settings, or from the in-view dropdown next to the input bar. Changes apply to the **next** spawned session, not the current one.

### What the webview renders

- **Assistant text cards** — Streaming markdown-style text, deduplicated by `msg.id` (no flicker from re-emitted chunks).
- **`tool_use` cards** — Per-tool name with input JSON preview; `Edit` and `Write` get a built-in **unified diff card** (no third-party diff library).
- **`tool_result` cards** — Stringified or per-block content from the tool runner.
- **TodoWrite side panel** — `TodoWrite` results are hoisted to a side panel with checkbox / status / content rows, so the conversation stays clean.
- **Thinking blocks** — Collapsed by default in a `<details>` element. Toggle **Show thinking blocks expanded (Webview)** to open them automatically.
- **Compact boundary card** — `/compact` runs render a horizontal divider with pre/post token counts and elapsed time.
- **Status bar** — Per-result token usage (input + output / context window) and `total_cost_usd` derived from `result.modelUsage` (the source of truth, not assistant `usage`).
- **Unknown event card** — If the CLI emits a JSONL `type` the parser does not recognize, it is preserved as a collapsed JSON-dump card rather than dropped silently. This makes future schema drift visible to debug users.
- **Session resume** — On exit, the webview saves `result.session_id` to `lastSessionId`. The **Open Claude Webview (resume last)** command spawns with `--resume <id>` and falls back to a local archive replay if the CLI rejects the resume id.

Console logs from this path use the namespaced `[claude-webview]` prefix (kept strictly separate from `[claude-terminal]`) so log filtering stays unambiguous.

### Beta constraints

The following are intentionally out of scope for v0.6.0 Beta and tracked for follow-up releases:

- **`/mcp` slash command is not supported in webview mode.** MCP context still works through the terminal path. The webview beta does not wire up the MCP bridge.
- **Inline per-call permission prompts are not supported.** Use the Safe / Standard / Full preset dropdown instead. Fine-grained per-call approval lands in v0.7.0.
- **Switching `uiMode` at runtime requires an Obsidian restart.** The Notice "재시작 필요" reminds you. Runtime re-registration is deferred to keep view lifecycle simple in Beta.
- **No screenshots / GIFs ship with this Beta.** They will land with the v0.6.0 GA release once the UX stabilizes.
- **Webview is opt-in only.** With `uiMode: "terminal"` (the default) all existing behavior — xterm.js, node-pty, system prompt, MCP bridge, OSC 8 `obsidian://` links, @-mention picker — is preserved unchanged. Existing users will not notice this release unless they explicitly flip the setting.

If you hit a parser drift, an unexpected event class, or a lifecycle issue, please open an issue with the `[claude-webview]` console output and the offending JSONL line — the parser preserves the raw wrapper exactly so you can attach it directly.

## Limitations

- **Desktop only** — requires node-pty (native module), does not work on mobile
- **No inline diffs** — Obsidian API does not support inline diff views
- **Native module build** — node-pty must be compiled for your Obsidian's Electron version

## License

MIT
