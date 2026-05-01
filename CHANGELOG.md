# Changelog

All notable changes to obsidian-claude-code will be documented in this file.

## [0.6.3] - 2026-05-01

Tool-call density fix. A turn that fans out 6 tool calls used to fill the side panel — each `assistant.tool_use` and matching `user.tool_result` rendered as its own ~32px card, so a single agent loop pushed conversation context off-screen. v0.6.3 collapses consecutive generic tool calls into a single `Activity` group card whose body is closed by default. The user still gets one visible row per turn, the tool detail is one click away, and errors stay loud via a red chip in the header instead of a stripe per line.

### Added
- **Activity Group container card.** Consecutive generic tool calls (Read / Bash / Grep / Glob / WebFetch / Task / SlashCommand / etc.) inside one assistant turn now render inside a single `.claude-wv-card--activity-group` container. Header reads `Activity · N tools`. Closed by default — clicking the chevron expands the body.
- **Per-tool one-line entry.** Inside the group, each tool round-trip is a single `.claude-wv-tool-line` row with monospace 11px text. Format: `▸ Read · src/webview/view.ts ✓`. Click expands an inline `<details>` showing the input JSON preview and the result body. The matching `tool_result` no longer renders a separate card — it attaches into the same line, so one round-trip = one visual unit.
- **Header error chip.** Group header surfaces `2 ERRORS` as an uppercase red pill when any line in the group failed. Visible while the group is collapsed, so the user sees failure count without expanding. Disappears when no errors remain.
- **Status chip per line.** ✓ (subtle green) for success, ✗ (red pill) for error. Pulsing dot while still pending.
- **Orphan result fallback.** When a `tool_result` arrives after the group has closed (e.g. interleaved assistant text ended the burst), the result still renders as a standalone `.claude-wv-card--user-tool-result` card so data is never lost.

### Changed
- **`renderAssistantToolUse` and `renderUserToolResult` signatures** now take an `ActivityGroupRenderState` argument. Tests and integration paths updated to construct one with `createActivityGroupState()`. Internal API only — opt-in webview users see no compatibility break.
- **Group lifecycle is dispatcher-managed.** `view.ts` closes the active group when assistant emits a non-empty text block, when an Edit/Write/TodoWrite tool fires (those have dedicated diff and panel renderers), when the user sends a plain-text turn, or when a `result` event ends the conversation. Pure tool_use/tool_result events keep the group open.
- **Pre-existing `claude-wv-card--assistant-tool-use` card class is retired.** The grouped tool line uses `claude-wv-tool-line` instead. CSS/test selectors updated accordingly. Edit/Write diff cards and TodoWrite summary card keep their old class names — they live outside the group on purpose (the diff and panel are content the user wants to see, not log noise).
- **Errors no longer auto-open the group container.** Earlier draft auto-opened the `<details>` on the first error, which defeated the compaction goal — one bad line and the whole group expanded. Now the header chip carries the signal; the line's own `<details>` still auto-opens so the failure body is immediately visible the moment the user expands the group.

### Fixed
- **Tool-call noise overflowing the conversation.** A 6-tool turn was ~360px of stacked cards. After v0.6.3 the same turn collapses to a ~32px `Activity · 6 tools` header. Expanded view shows ~150px of compact log lines instead.

### Internal
- **New module `src/webview/renderers/activity-group.ts`** (~250 LOC). Owns `ActivityGroupRenderState`, the container element lifecycle, the per-line bookkeeping (count, pending tally, error tally), and the header refresh logic.
- **`assistant-tool-use.ts` rewritten** to emit `<div class="claude-wv-tool-line">` rather than `<div class="claude-wv-card claude-wv-card--assistant-tool-use">`. Same `data-tool-use-id` / `data-tool-name` / `data-pending` attributes preserved so view.ts pending-resolution and the existing CSS pulsing-dot animation keep working with minimal selector changes.
- **`user-tool-result.ts` rewritten** to look up the matching tool line via `findToolLine(groupState, tool_use_id)` and update its body in place. Falls back to the old standalone-card path when no matching line exists.
- **`view.ts` dispatcher** gained the activity-group state in `RendererStates`, plus four close-group trigger checks (assistant text/Edit/Write/TodoWrite, user plain-text, result event).
- **CSS** adds `.claude-wv-card--activity-group`, `.claude-wv-activity-group-{details,header,label,sep,count,error-chip,dot,body}`, `.claude-wv-tool-line`, `.claude-wv-tool-line-{details,summary,name,sep,hint,status,sep-line}`. Reuses the existing `claude-wv-pending-pulse` keyframe for the dot animation. Old `.claude-wv-card--assistant-tool-use` styles deleted.

### Verified
- 721 vitest pass (12 pre-existing artifact-gate failures unchanged: `completion-gate.test.ts`, `sub-ac-4-ac-1-mh-10-mh-11-smoke.test.ts`).
- 10 new test cases in `test/webview/render-activity-group.test.ts` covering container creation, idempotent ensure/register, close/reopen, header count refresh, error chip rendering, pending state transitions, orphan-line tolerance.
- Existing `render-tool-use-basic`, `render-user-tool-result`, `render-permission-plan-mode`, `card-kinds-per-fixture`, `render-fixtures-integration`, `render-todo-panel`, `mh-07-08-09-readiness` updated to the new line-mode + group-container shape. Card-kind expectations recomputed against real fixture replay.
- `npm run build` clean.
- Manually dogfooded in Obsidian: 6-tool agent loop renders as `Activity · 6 tools`, expands to log-style lines, error line shows red ✗ pill, Edit/Write diff cards remain visible outside the group, TodoWrite strip unaffected.

### Migration notes
None for end users — opt-in webview, internal renderer change, no settings or stored data touched. Test authors who write integration tests against `assistant-tool-use` need to (1) construct an `ActivityGroupRenderState` and pass it as the second argument to `renderAssistantToolUse` / `renderUserToolResult`, (2) query the group container via `.claude-wv-card--activity-group`, and (3) query individual tool calls via `.claude-wv-tool-line` (not `.claude-wv-card--assistant-tool-use`).

## [0.6.2] - 2026-05-01

Webview input UX overhaul. Three phases (Enter-to-send, `@` file picker, `/` slash menu) shipped behind a unified inline popover, plus filesystem-based command discovery so the slash menu is populated the moment the view opens — no more "type something first to see your commands". The `@@<path>` duplication bug from the first pass is fixed via a fundamental architecture change: triggers now fire on the textarea's `input` event, not `keydown`, so there's no race with the modal's focus shift.

### Added
- **Plain Enter sends the message; Shift+Enter inserts a newline.** Chat-app standard. Cmd/Ctrl+Enter still submit (backwards-compat). IME composition (`isComposing`) is guarded so Korean / Japanese / Chinese input completes naturally without firing send mid-character.
- **`@` opens an inline file picker.** Type `@` (at start of input or after whitespace) and a popover lists vault notes, fuzzy-ranked by `prepareFuzzySearch`. Empty query shows the 30 most recently modified notes. Selection rewrites the typed `@<query>` to `@<path> ` so the user sees no duplication.
- **`/` opens an inline slash command menu.** Type `/` at the start of an empty input. Source merge: CLI builtins from `system.init.slash_commands` (~462 entries once Claude responds to the first message) + vault `.claude/commands/*.md` + global `~/.claude/commands/*.md` + every plugin discovered via `~/.claude/plugins/installed_plugins.json` (`<installPath>/commands/*.md` + `<installPath>/skills/<dir>/`). Filesystem discovery runs at view open, so the menu is populated before the user sends their first message — Claude CLI itself only emits the canonical list AFTER the first prompt arrives on stdin, so without filesystem discovery the popover would be empty until then.
- **Inline popover replaces SuggestModal for both `@` and `/` triggers.** Anchors above (or below) the textarea via `getBoundingClientRect`, no backdrop, focus stays on the textarea. Keyboard nav: ↑↓ to move, Enter to select, Esc to dismiss; click-outside also dismisses. Mouse hover updates selection. `mousedown` selection (not `click`) preventDefaults the focus shift so the textarea stays selected after pick.

### Changed
- **`@` and `/` trigger detection moved from `keydown` to the textarea's `input` event.** The `keydown` approach raced with the modal's focus shift — when `modal.open()` ran inside the keydown handler, focus shifted to the modal's search input before the browser's default key action fired, so the typed character landed in the modal instead of the textarea (or duplicated when both happened). The `input` event fires AFTER the character is in the textarea, eliminating the race entirely. Detection uses `InputEvent.data === '@'` / `'/'` and `inputType === 'insertText'` to filter out paste, IME, and autocomplete.
- **Slash command source extended from 2 to 4 sources.** Previously only CLI builtins + vault `.claude/commands/`. Now also includes global `~/.claude/commands/*.md` and full plugin discovery (commands + skills) via `installed_plugins.json`. Custom plugin install paths (e.g. `~/MyDocument/claude-config/plugins/sungjin-core`) are picked up automatically because the manifest carries the canonical `installPath` for each plugin instance.

### Fixed
- **`@@<path>` duplication when picking a file from `@` modal.** Root cause: `e.preventDefault()` in the keydown handler did NOT suppress the default key insertion under Obsidian/Electron, so the typed `@` landed in the textarea AND `insertAtCursor` then prepended another `@<path>`. Fixed by switching to input-event detection (so we work WITH the browser's default action, not against it) and replacing `insertAtCursor` with `replaceAtToken` (which swaps `@<query>` → `@<path> ` rather than prepending).
- **Global slash commands failing to load.** The earlier dynamic `import("node:fs/promises")` was emitted by esbuild as `import("fs/promises")`, which Obsidian's renderer rejects with `TypeError: Failed to resolve module specifier 'fs/promises'` (Electron's strict ESM resolver doesn't accept Node builtins via dynamic import). Switched to `globalThis.require("fs/promises")` so the call routes through the CommonJS loader, which always resolves Node builtins under Obsidian.

### Internal
- **New module `src/webview/ui/inline-popover.ts`** (~250 LOC). Generic, source-agnostic — both `@` and `/` triggers reuse the same component.
- **`createAtMentionDriver` and `createSlashMenuDriver`** in `at-mention-trigger.ts` and `slash-menu.ts` own one popover instance each and hook into the textarea's `input` event. Lifecycle handles dispose to prevent listener leaks across view re-mounts.
- **`listPluginCommandsAndSkills`** scans `installed_plugins.json` once per view open. Reads `commands/*.md` (description = first non-frontmatter line) and `skills/<dir>/SKILL.md` (description = frontmatter `description:` field, falls back to first prose line). Errors silenced — folder missing or unreadable yields `[]`.

### Verified
- 709/721 vitest pass. The 12 failures are pre-existing artifact-gate tests unrelated to this work (`completion-gate.test.ts`, `sub-ac-4-ac-1-mh-10-mh-11-smoke.test.ts`) — they look for runtime artifacts that don't exist in this branch's filesystem.
- ~50 new test cases across `at-mention-trigger.test.ts`, `slash-menu.test.ts`, `input-bar.test.ts` covering driver lifecycle, fresh-trigger detection, IME guards, paste-vs-typing, `replaceAtToken`, `mergeSlashCommands` precedence, dismiss/select callbacks.
- `npm run build` clean.
- Dogfooded in real Obsidian session: `/wee` matches `weekly-review` skill, `@` picker shows vault notes without `@@` duplication, plain Enter sends, Shift+Enter inserts newline, IME composition isn't disrupted.

### Migration notes
None — webview is opt-in via `uiMode: "webview"` and the input bar API is internal. Existing webview users get the new behavior on next reload.

## [0.6.1] - 2026-05-01

First stable v0.6.x release. Three dogfood-driven UI fixes on top of beta.3 — the webview now stops drowning the conversation in tool plumbing, the Todo strip cleans up after itself, and the header status indicator stops pulsing during idle. No public API change.

### Changed
- **Tool calls and tool results collapse by default.** `Read`, `Bash`, and other generic tool cards now render as a single-line `<details>` summary (`Read · /path/to/file`, `Bash · ls -la`) and expand on click. Previously the JSON input preview and the result body were always-open `<pre>` blocks that buried the conversation under one screenful per tool call. Errors stay open by default so the user reacts immediately. The summary line picks the most identifying scalar field (`file_path`, `command`, `pattern`, `query`, `url`, …) so a glance reads the call without expanding.
- **TodoWrite success result hidden.** The `tool_result` for a successful `TodoWrite` (`"Todos have been modified successfully"`) was a noise card right after the `→ todos updated (N)` summary card. The user-tool-result renderer now skips it when a matching summary card is present in the same `cardsEl`. Errors still render so failed updates are visible.
- **Todo panel moved from right-side column to bottom strip.** Beta.1–beta.3 carved a 240 px right column off `main` for the live todo list. Obsidian sidebars are narrow; that 240 px noticeably squashed every assistant card. The panel is now a horizontal strip between the cards area and the input bar, capped at `max-height: 30vh`. Same auto-hide via the existing `.claude-wv-todo-side:empty` rule.
- **Todo strip auto-hides when all todos are completed.** `renderTodoPanel` now removes the side-panel wrapper from the DOM (and from `state.panelWrappers`) when the latest TodoWrite payload is empty or every entry is `completed`. The summary card stays in the conversation log for history; only the live strip disappears. A subsequent TodoWrite with new pending items recreates the wrapper as before.

### Fixed
- **Header `requesting ●` spinner stops pulsing on turn end.** The CLI is supposed to emit a `system.status` event with `status: null` when a request completes, but in practice it sometimes leaves the last `requesting` status hanging — the dot then pulsed indefinitely while the webview was idle. The view now calls `clearSystemStatus(states.systemStatus)` on every `result` event so the spinner is unambiguously cleared at turn end regardless of CLI behavior.

### Verified
- 682/682 vitest pass (676 + 6 new regression tests for collapsed details, TodoWrite suppression, todo auto-hide, and `clearSystemStatus`)
- `npm run build` clean (572 KB main.js)

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
