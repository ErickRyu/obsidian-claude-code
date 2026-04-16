# Changelog

All notable changes to obsidian-claude-code will be documented in this file.

## [0.6.0-beta.1] - 2026-04-16

v0.6.0 Beta 1 — **Webview foundation (opt-in)**. Ships the first cut of the new custom `ItemView` that coexists with the legacy xterm.js terminal behind a `uiMode` toggle. This release is **infrastructure-only**: no end-user workflow changes unless the user explicitly enables `uiMode: "webview"` in settings. Existing users stay on the xterm terminal path by default with zero behavior change. Subsequent v0.6.x releases will build diff accept/reject (v0.7.0) and plan-as-note (v0.8.0) on top of this foundation.

### Added
- **Custom webview `ItemView` (opt-in, Beta).** A new `VIEW_TYPE_CLAUDE_WEBVIEW` view spawns `claude -p --output-format=stream-json` via `child_process.spawn` (CLI, not the Anthropic SDK), parses the JSONL stream event-by-event, and renders `assistant` text, `tool_use`, `tool_result`, and `result` events as structured HTML cards. The webview is registered only when the user opts in via the `uiMode` setting; the terminal path is unaffected.
- **`uiMode` setting toggle (`"terminal" | "webview"`, default `"terminal"`).** Changing the setting shows a Notice "재시작 필요" — the view registration is fixed at plugin load, so switching modes requires an Obsidian restart. Settings migration uses `Object.assign(DEFAULT_SETTINGS, loaded)` so existing installs pick up the new field with the safe default automatically.
- **Permission preset dropdown (Safe / Standard / Full).** The webview exposes `--allowedTools` and `--permission-mode` as a three-choice preset: **Safe** (read-only tools), **Standard** (read + edit + bash with prompts), **Full** (bypass prompts — for power users who trust the session). The preset is applied per-spawn, so each webview session can run under a different permission posture.
- **Stream-json parser with UnknownEvent preservation.** Parser consumes stdout line-by-line through a `LineBuffer` with tail retention for partial chunks; every recognized event class is dispatched to a typed handler, and any wrapper whose `type` does not match a known class is emitted as `UnknownEvent` (raw JSON preserved) rather than thrown. Never-silent-swallow: all 6 error classes (spawn failure / JSONL parse error / partial line / stderr noise / stdin EPIPE / UnknownEvent) have explicit, documented policies with namespaced `[claude-webview]` console output.
- **Collapsed JSON-dump card for unknown events.** Debug users see drift in the CLI's JSONL schema as a collapsible `<details>` card instead of a hidden failure, enabling schema-drift detection over time.
- **8 replay fixtures + differential assertions.** `hello` / `edit` / `permission` / `plan-mode` / `resume` / `slash-compact` / `mcp-tool` / `unknown-event` fixtures replay through the parser with `rawSkipped === 0` and satisfy key-field assertions (event-count-by-type, card-kinds Set membership, card-count-by-kind). No HTML snapshots — only semantic key-field checks so fixtures survive cosmetic renderer tweaks.
- **Single real `claude -p` smoke test** (≤ 30 s timeout). Validates a real CLI spawn returns a UUID `session_id`, a `version` field, and a non-empty assistant card in end-to-end mode.
- **"Webview mode (Beta, opt-in)" README section.** Documents how to enable the beta, the three permission presets, and the Beta-scope constraints.

### Changed
- `manifest.json` / `VERSION` / `versions.json` / `package.json` bumped to `0.6.0-beta.1`.
- Plugin load now conditionally registers `VIEW_TYPE_CLAUDE_WEBVIEW` only when `uiMode === "webview"`; `VIEW_TYPE_CLAUDE_TERMINAL` registration is unchanged.
- Console logs for the webview path use a new `[claude-webview]` namespace, kept strictly separate from the legacy `[claude-terminal]` namespace so log filtering stays unambiguous.

### Known issues / Beta limitations
- **`/mcp` slash command is not supported in webview mode.** MCP context still flows through the terminal path; the webview beta does not wire up the MCP bridge.
- **Inline permission prompts are not supported in webview mode.** Use the permission preset dropdown (Safe / Standard / Full) instead. Fine-grained per-call approval lands in v0.7.0.
- **Switching `uiMode` at runtime requires an Obsidian restart.** The Notice "재시작 필요" reminds users; runtime re-registration is intentionally deferred to keep view lifecycle simple in Beta.
- **Screenshots / GIFs for the webview are not included in this Beta** — they will land with the v0.6.0 GA release once UX stabilizes.
- **Webview is opt-in only.** With `uiMode: "terminal"` (the default) all existing behavior — xterm.js, node-pty, system prompt, MCP bridge, OSC 8 obsidian:// links, @-mention picker — is preserved unchanged. Existing users will not notice this release unless they explicitly flip the setting.

## [0.5.2] - 2026-04-16

Track A v0.5.x terminal-mode maintenance bundle — critical UX regressions fixed, measurement infrastructure added, release automation tightened. No new features; the xterm.js path stays on life support until the v0.6.0 webview lands.

### Added
- **URL emission compliance counters.** Three in-memory, session-scoped counters (`linkMarkdownEmitted`, `linkBareUrlEmitted`, `vaultPathMentioned`) track how often Claude follows the system-prompt instruction to emit `[text](obsidian://open?...)` vs a raw URL vs a plain vault path. Values are logged to the developer console on plugin unload and never persisted; `vaultPathMentioned` is deduped per `(line, start, text)` so hover and repaint do not inflate the count, and only paths that actually resolve to a vault note are included. Used to decide in a ~2-week dogfood window whether the system-prompt approach is reliable enough or whether we need a stronger fallback.

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
