# Changelog

All notable changes to obsidian-claude-code will be documented in this file.

## [Unreleased]

### Fixed
- **Bare `obsidian://open?...` URLs now render as short clickable labels.** When Claude ignores the system-prompt instruction and emits the raw URL without the `[text](url)` wrapper, `ObsidianLinkTransform` detects it and wraps it in an OSC 8 hyperlink using the basename from the `path` query parameter as the visible text. Partial URLs split across PTY chunks are buffered and re-joined, with structural-boundary heuristics (`=`, `&`, `?`, `/`, half-written `%XX`) triggering the hold. An already-wrapped URL inside an OSC 8 sequence is protected from re-matching by a `(?<!\x1b\]8;;)` lookbehind.
- **MCP context server setting now applies at runtime.** Previously, toggling `Enable MCP context server` in settings updated the stored value but did not tear down or spin up the bridge, so the change silently required a plugin reload. `ClaudeTerminalPlugin.reconfigureMcp()` is now called from the settings `onChange` handler and a Notice reminds the user that already-spawned terminals still need a manual restart (the Claude CLI snapshots `--mcp-config` at spawn time).

### Changed
- Workspace `file-open` and `layout-change` listeners that drive MCP context refresh now register once at plugin load and no-op when the bridge is absent, so hot-swapping MCP on/off does not re-register handlers.
- Release workflow now restricts its trigger to `v*` tags, verifies the tag version matches `manifest.json`, and attaches the matching `CHANGELOG.md` section as the release body. Drafts are still the default so maintainers can review before publishing.

## [0.5.1] - 2026-04-15

### Added
- **Clean terminal output for vault links.** Markdown-style Obsidian links (`[name](obsidian://open?...)`) are transformed into OSC 8 terminal hyperlinks before reaching xterm. Only the visible text shows on screen; the raw URL is hidden. Cmd/Ctrl+click on the visible text still opens the note.

### Fixed
- **Cmd/Ctrl+click now works when MCP is disabled.** Previously, the Obsidian URL format instruction that tells Claude how to emit clickable links was written only when the MCP context server was enabled. Turning MCP off silently broke the click-to-open feature. The instruction now writes to disk on plugin load regardless of MCP state.

### Changed
- System prompt file is written atomically (temp file + rename) so the Claude CLI can never spawn against a partially-written prompt file.
- `SystemPromptWriter` owns prompt file lifecycle; the MCP bridge layers context on top when enabled.
- `ObsidianLinkTransform` streams PTY output with bounded carry-over buffer for links that span chunk boundaries.
- OSC 8 link handler routes `obsidian://` URLs through the existing vault-resolution path (Cmd/Ctrl-gated); other schemes open via `window.open`.

### Known issues
- Toggling the `enableMcp` setting at runtime still requires a plugin reload to take effect. This pre-existing bug is tracked separately in TODO.md.

## [0.5.0] - 2026-04-15

### Added
- **Cmd/Ctrl+click vault notes**: Click any vault path or `obsidian://open` URL Claude prints in the terminal to jump straight to the note in Obsidian
- **Smart path detection**: Recognizes paths with spaces, Korean characters, and Markdown link syntax — only highlights paths that actually exist in your vault

### Changed
- **System prompt now instructs Claude to format vault references as clickable Obsidian URLs** with percent-encoded paths so click-to-open works reliably even when the terminal wraps long lines

## [0.4.0] - 2026-04-12

### Added
- **@-mention file picker**: Type `@` in the terminal to open a fuzzy file search popup for vault files
- **File preview panel**: 2-column layout showing file content preview before selection
- **Heading reference**: Use `@file#heading` syntax to reference specific headings
- **Folder filter**: Append `/` to the query to filter files within a specific folder
- **vitest test infrastructure**: Obsidian API mocks + 20 unit tests

### Fixed
- Dismissing the file picker with Escape now correctly types the literal `@` character
- Binary files and files over 1MB are safely handled in the preview panel

## [0.3.0] - 2026-04-10

### Added
- MCP context server exposing open notes, active file, and vault search to Claude Code
- Auto-inject open notes into Claude's system prompt
- Auto-configure `.mcp.json` and tool permissions on load

## [0.2.0] - 2026-04-06

### Added
- Multi-tab terminal support
- Claude AI sidebar icon

## [0.1.0] - 2026-04-05

### Added
- Embed Claude Code terminal in Obsidian's sidebar
- xterm.js + node-pty based terminal
- Shift+Enter multiline input
- Automatic theme synchronization
- Auto-download node-pty native binary on first launch
