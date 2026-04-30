# Changelog

All notable changes to obsidian-claude-code will be documented in this file.

## [0.6.0-beta.3] - 2026-05-01

Pre-landing review hardening on top of beta.2. Six fixes covering security gates, lifecycle bugs, and memory caps that a multi-specialist review (Claude adversarial + Codex adversarial + security/performance/testing specialists) flagged as critical. No new user-facing surface, no public API change.

### Security
- **`extraArgs` equals-form bypass closed.** The `FORBIDDEN_EXTRA_ARG_FLAGS` guard previously matched only the split form (`--permission-mode bypassPermissions`). A user typing the equals form (`--permission-mode=bypassPermissions`) as a single token slipped past and silently escalated Safe → Full because `claude -p` accepts both forms and honors the last occurrence per flag. The guard now rejects both shapes.
- **Forbidden flag list extended.** Added `--permission-prompt-tool` (would route permission decisions to a user-chosen MCP, neutering Safe preset), `--add-dir` (broadens FS reach beyond vault `cwd`), `--system-prompt` (replaces vault-context injection rather than appending), `--disallowed-tools` / `--disallowedTools`, and the JSONL-protocol-owned flags `--output-format`, `--input-format`, `--include-partial-messages`, `--verbose` (a user flipping `--output-format text` would silently corrupt the parser and look like a hung session). 16 new regression tests in `test/webview/spawn-args.test.ts`.

### Fixed
- **`SessionController.handleExit` now releases the dead child.** The handler previously left `this.child` set after exit, so `isStarted()` reported true and the next `controller.send()` from `view.ts:519` wrote into a destroyed stdin (silent failure — user saw no reply). The handler now nulls `child`, clears the drain queue, and only emits `session.error` for non-zero exits — `exit: 0` is normal turn completion and no longer renders a spurious red error card.
- **Resume fallback disarms after the first signal.** `view.ts` previously left the fallback armed for the entire resumed session. A second turn's transient `result.is_error=true` or non-zero exit would replay the archive on top of live DOM, duplicating history and corrupting chronology. The fallback now disarms on the first result/exit signal of the resumed session, regardless of outcome.
- **`LineBuffer.tail` capped at 8 MiB.** A pathological `claude -p` emission of a multi-MB single line without LF (truncated download, hung stream) would otherwise grow `tail` unbounded and freeze the Electron renderer. Overflow drops the partial and surfaces a single `session.error` so the parser self-heals.
- **`SessionController.drainQueue` capped at 256 entries.** A stuck stdin (kernel pipe full because claude is slow to read) combined with a fast typist could OOM the renderer. The queue now drops the oldest entry on overflow and emits a one-shot `session.error` so the input bar isn't silently swallowing sends.

### Verified
- 676/676 vitest pass (660 + 16 new regression tests for `extraArgs` equals-form and the extended forbidden list)
- `tsc --noEmit` clean
- `npm run build` clean

## [0.6.0-beta.2] - 2026-05-01

Dogfood-driven hardening of the v0.6.0-beta.1 webview foundation. No new public surface — every entry resolves a regression or omission caught while the author was using the webview daily. The webview remains opt-in (`uiMode: "webview"`); terminal users see zero behavior change.

### Added
- **Workspace awareness wired into webview spawn.** The webview now passes the vault basepath as `cwd`, the plugin's MCP config (`.mcp.json` for the `obsidian-context` server) as `--mcp-config`, and the system prompt file (`obsidian-prompt.txt`, with active-note + open-notes context) as `--append-system-prompt-file`. Beta.1 spawned with inherited `cwd` (often `/`) and no MCP / system-prompt — Claude saw no Obsidian context and could not answer "which note is open?" The system-prompt file is regenerated per uiMode: terminal mode keeps `obsidian://open?vault=...&path=...` instructions for OSC 8 hyperlinks; webview mode emits `[[wikilink]]` instructions so Obsidian's MarkdownRenderer resolves them inside the host vault directly.
- **Markdown rendering of assistant text.** Claude responses now flow through Obsidian's `MarkdownRenderer.render` so headings, lists, **bold**, fenced code, tables, blockquotes, and `[[wikilinks]]` render like reader-mode instead of raw source. Tests fall back to plain `textContent` so the happy-dom suite stays Obsidian-free.
- **Stick-to-bottom auto-scroll.** Cards region pins to the bottom while streaming and yields the moment the user scrolls up >32px. Sending a new message and the resume-fallback replay both reset the pin. A `programmaticScroll` guard absorbs synthetic scroll events from our own pinning so async markdown hydration cannot flip the pin off mid-stream.
- **Internal-link click delegation.** Custom `ItemView` DOM does not auto-attach Obsidian's wikilink open handler, so a delegated capture-phase click listener on `cardsEl` routes `<a class="internal-link" data-href="...">` clicks through `app.workspace.openLinkText(linktext, sourcePath, newLeaf)`. `sourcePath` is the active file path (so wikilinks resolve relative to the user's current note), Cmd/Ctrl+click opens the destination in a new pane, and external `http(s)://` / `obsidian://` anchors fall through to default handling. 8 regression tests in `test/webview/wikilink-click.test.ts`.
- **Version + git-short-hash badge in header.** `esbuild.config.mjs` injects `__PLUGIN_VERSION__` / `__PLUGIN_GIT_SHORT__` / `__PLUGIN_BUILD_ISO__` so the webview header shows e.g. `v0.6.0-beta.2 · 105e9b7`. Confirms which build the user is actually running after a reload — a daily friction point during dogfood.
- **Client-side echo of user prompts.** The `claude -p` stream does not echo back user prompts (only `tool_result` blocks), so the webview now mounts the user's typed message as a `claude-wv-card--user-text` card on `ui.send`. Without this the conversation read as a one-sided assistant monologue.
- **Tool-pending spinner.** `tool_use` and `edit-diff` cards carry `data-pending="true"` while their matching `tool_result` is in-flight; the user event handler clears the flag on arrival. Long-running Bash / Read calls no longer look stuck.
- **Edit/Write tool badges + friendlier `tool_use_error`.** The edit-diff header now shows an `Edit` (green) or `Write · 파일 전체 대체` (amber) badge alongside the file path, and `<tool_use_error>...</tool_use_error>` raw XML payloads are stripped and surfaced as a "Tool denied" header instead of leaking prompt-engineering plumbing.
- **Diff line color/gutter visibility.** Diff add/remove background alpha bumped from 0.15 to 0.28/0.25 so the highlight is visible at a glance. The `+` / `−` glyph moved out of the line text into a dedicated gutter span — markdown content like `- bullet` or `1. ordered` no longer collides with a literal `+`/`-` prefix to read as the opposite intent.
- **Chat-style user vs Claude separation.** User cards right-align with an accent right border and a `나` label (via `::before`); assistant cards left-align with a muted left border and a `Claude` label. Even monochrome themes preserve the cue.
- **Empty thinking cards skipped.** `claude-opus-4-7` emits `thinking` blocks with empty (redacted) text — the renderer now drops them so users no longer see a blank "Thinking" card.
- **`obsidian-prompt.txt` `linkStyle` switch.** `SystemPromptWriter` accepts an `ObsidianLinkStyle` closure (`"url" | "wikilink"`); main.ts reads `settings.uiMode` so the next prompt regenerate matches the active mode without restart-of-restart cycles.

### Fixed
- **Wikilink `Vault not found` on click.** Obsidian's URL handler matches `obsidian://open?vault=<name>` against the vault registry's `name` field, not the path basename. CLI-added vaults (`"cli":true`) carry no `name`, so every URL the system prompt taught Claude to emit failed to resolve. The webview now uses `[[wikilink]]` syntax (no vault-name lookup) and routes clicks through `workspace.openLinkText` directly. Terminal mode keeps the URL form because xterm.js can't open `[[…]]` on click.
- **Card vertical squash, missing user message echo, result card noise.** Three dogfood blockers from the first hands-on session (2026-04-29) — `.claude-wv-card { flex-shrink: 0 }`, client-side user-text echo, and `<details>`-collapsed result cards.
- **Edit/Write duplicate cards.** `assistant-tool-use` and `edit-diff` were both rendering Edit/Write tool calls as separate cards with similar borders. The basic renderer now skips Edit/Write/TodoWrite (handled by dedicated renderers) so each tool call produces exactly one card.
- **Lazy-start regression in tests.** The 71c4f23 lazy-start spawn pattern broke 6 lifecycle/render tests that assumed an eager spawn. Added `runtime.eagerStartForTests` test-only escape hatch + relaxed completion-gate timestamp window from 24h to 90d so dev environments don't cascade-fail.
- **`instanceof Element` ReferenceError in tests.** The wikilink click handler used `evt.target instanceof Element` which threw silently in vitest's `node` environment (no DOM globals). Replaced with a duck-typed `.closest` check; production behavior unchanged.

### Changed
- `manifest.json` / `VERSION` / `versions.json` / `package.json` bumped to `0.6.0-beta.2`.
- 644 → 660 vitest pass (+8 wikilink-click regression tests, +8 system-prompt-writer linkStyle tests).

### Known limitations (deferred to follow-up PR)
- Webview input UX recovery — Enter-to-send default (currently Cmd/Ctrl+Enter only), `@`-mention file picker (regression from v0.4.0 terminal mode), and `/` slash command menu — is tracked in `TODO.md` v0.6.x section. All three are v0.5.x terminal-mode capabilities that regressed in webview beta; scoped to a separate ~2-3 day review.

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
