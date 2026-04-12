# TODO — obsidian-claude-code

UX improvements inspired by VS Code Claude Code extension. The core insight: VS Code's
real advantage over a raw terminal is a **custom webview that parses Claude Code's
`stream-json` output and renders structured message/tool/diff cards**. Everything else
below is either a quick win we can add without replacing xterm.js, or prep work for
that bigger rewrite.

Organized by target version. Each item lists: what it does, why it matters, how to
build it, and rough effort.

---

## v0.4.0 — Low-cost quick wins (keeps xterm.js)

These don't require replacing the terminal renderer. They intercept keystrokes in
xterm.js and layer Obsidian-native UI on top (SuggestModal, StatusBar, etc.).

### [x] @-mention file picker

**What:** User types `@` in the terminal input and a fuzzy file search popup appears
listing vault notes. Selecting a note inserts `@path/to/note.md` into the prompt.

**Why:** VS Code's `@` trigger is the single highest-frequency UX affordance. Raw
xterm.js forces the user to remember exact paths.

**How:**
- Intercept `@` keypress in `attachCustomKeyEventHandler` (in `claude-terminal-view.ts`).
- Open an Obsidian `SuggestModal` populated from `app.vault.getMarkdownFiles()`.
- On selection, write `@{selectedPath} ` into the PTY via `terminalManager.write`.
- Trailing `/` in the query should filter to folders only.
- Support `@note#heading` syntax for heading-level references.

**Effort:** ~2 hours CC time. The SuggestModal API is straightforward.

**Files:** `src/claude-terminal-view.ts`, new `src/file-suggest-modal.ts`.

---

### [ ] Slash command menu

**What:** User types `/` and a command menu opens with Claude Code's built-in commands
(`/compact`, `/mcp`, `/plugins`, `/clear`, etc.) plus any custom ones.

**Why:** Discoverability. Users don't know what slash commands exist without reading docs.

**How:**
- Intercept `/` keypress (only when it's the first char of the input line).
- Open a `SuggestModal` with a hardcoded list of known Claude Code commands + descriptions.
- On selection, write the command into the PTY.
- Stretch: parse `.claude/commands/*.md` and `~/.claude/commands/*.md` for user-defined
  commands and merge them into the list.

**Effort:** ~2 hours CC time.

**Files:** `src/claude-terminal-view.ts`, new `src/slash-command-modal.ts`.

**Risk:** Distinguishing "user wants to type `/` in the middle of text" vs "user wants
the command menu" requires tracking input state. Start with "only trigger at prompt start".

---

### [ ] Permission mode pill (status bar)

**What:** A clickable badge in Obsidian's status bar showing the current Claude Code
permission mode: **Normal / Plan / Auto-accept**. Click to cycle.

**Why:** VS Code has this and it's a constant visual reminder of what Claude can do
autonomously. Without it, users don't know if they're in plan mode vs auto-accept mode.

**How:**
- Use `this.addStatusBarItem()` in `main.ts`.
- Permission mode state is tracked per-terminal. The pill reflects the currently focused
  terminal's mode.
- Clicking cycles mode by sending the appropriate keyboard shortcut or slash command to
  the PTY (e.g., `Shift+Tab` cycles permission modes in Claude Code CLI).
- Listen for Claude Code's mode change output to update the pill.

**Effort:** ~3 hours CC time. The tricky part is detecting mode changes from Claude's
output since we don't have a structured event stream.

**Files:** `src/main.ts`, new `src/permission-mode-pill.ts`.

**Alternative:** Skip detection and just track what the user clicked. Less accurate but
simpler.

---

### [ ] Context window indicator

**What:** Status bar item showing `42% ctx` — the current conversation's token usage
as a percentage of the model's context window.

**Why:** Users can't tell when they're about to hit context limits. VS Code shows this.

**How:**
- Parse token usage from Claude Code's output (it reports tokens in its status line).
- Update the status bar item on each response.
- Color-code: green < 50%, yellow 50-80%, red > 80%.

**Effort:** ~4 hours CC time. Parsing terminal output for tokens is fragile.

**Files:** `src/main.ts`, new `src/context-indicator.ts`.

**Risk:** Parsing ANSI-stripped terminal output for numbers is brittle. The stream-json
approach (v1.0.0) solves this cleanly.

---

### [ ] Session resume dropdown

**What:** A command that opens a modal listing past Claude Code sessions with titles
(auto-generated from first message), filtered by date (Today / Yesterday / Last 7 days).
Selecting one runs `claude --resume <id>` in a new terminal tab.

**Why:** VS Code has a "Past Conversations" dropdown. Currently we have no way to resume
a specific past session.

**How:**
- Claude Code stores sessions in `~/.claude/projects/<project-slug>/` as JSONL.
- Parse the JSONL files to extract session ID + first user message + timestamp.
- Open a `SuggestModal` with sorted list.
- On selection, spawn new terminal with `--resume <sessionId>`.

**Effort:** ~4 hours CC time. Parsing the session store format needs research.

**Files:** new `src/session-browser.ts`, `src/main.ts` (command registration).

**Dependency:** Verify Claude Code's session storage format is stable before shipping.

---

## v0.5.0 — Medium effort improvements

### [ ] Tab icon status dots

**What:** The sidebar tab icon for a Claude terminal shows a colored dot:
- **Blue** = permission prompt pending (user needs to respond)
- **Orange** = Claude finished its task while the tab was hidden

**Why:** Background awareness. When you're editing a note and Claude is working in
another pane, you should know when it needs you.

**How:**
- Parse the terminal output for permission prompt markers and "response complete" signals.
- Override `getIcon()` on `ClaudeTerminalView` to return different icons based on state.
- Clear the dot when the tab becomes active.

**Effort:** ~5 hours CC time. Detection from terminal output is brittle — this gets
much easier in the v1.0.0 webview mode.

**Files:** `src/claude-terminal-view.ts`.

---

### [ ] Obsidian URI handler

**What:** Support `obsidian://claude-code?prompt=...&session=...` URLs that open Claude
Code with a prefilled prompt or resume a specific session. Lets external scripts,
bookmarklets, and other apps launch into Claude from Obsidian.

**Why:** Enables workflows like "right-click a URL in browser → send to Claude Code in
Obsidian" or "from another script, queue up a prompt".

**How:**
- Use `this.registerObsidianProtocolHandler("claude-code", (params) => {...})` in `main.ts`.
- Parse params: `prompt` (string to inject), `session` (session id to resume), `new` (bool
  to force a new terminal).
- Open/focus a terminal and write the prompt into it.

**Effort:** ~2 hours CC time.

**Files:** `src/main.ts`.

---

### [ ] Checkpoints / rewind

**What:** Hover over any past message in the conversation to reveal a rewind button.
Three rewind options:
1. **Fork conversation** — branch off without undoing code
2. **Rewind code only** — revert code changes back to that point but keep conversation
3. **Rewind both** — full time travel

**Why:** This is one of VS Code's most distinctive features and genuinely changes how
people work with Claude. Easy to experiment aggressively when you know you can undo.

**How:**
- Requires capturing conversation history + git snapshots at each message boundary.
- Hard in terminal mode, natural in webview mode.
- **Punt until v1.0.0** — this needs the webview architecture to work properly.

**Effort:** ~3 days CC time. Complex enough to deserve its own milestone.

**Files:** Deferred to v1.0.0.

---

### [ ] Plan mode — editable markdown plan (Obsidian's killer feature)

**What:** When Claude enters plan mode and produces a plan, instead of showing it as
ephemeral terminal text, create a real markdown note in the vault (e.g.,
`_claude/plans/YYYY-MM-DD-slug.md`), open it as an editor tab, and let the user edit
it before approving. On approval, Claude continues with the user's edited version.

**Why:** This is where Obsidian can beat VS Code. VS Code opens the plan in a normal
editor tab. Obsidian can open it with full markdown editing power: backlinks, tags,
embedded queries, graph view. Plans become first-class artifacts in the knowledge base.

**How:**
- Intercept plan-mode activation in Claude Code output.
- Extract the plan text, write it to a note in the vault.
- Open the note in a new Obsidian editor tab.
- Add two buttons at the top of the note (via custom CodeMirror decoration or
  MarkdownPostProcessor): "Approve and continue" / "Edit and approve".
- On approval, send the note's current content back to Claude Code as the approved plan.

**Effort:** ~2 days CC time. Interception is the hard part.

**Files:** new `src/plan-mode-bridge.ts`, `src/claude-terminal-view.ts`.

**Why this is priority:** This is the one feature where we can credibly beat VS Code.
Everything else is "catch up"; this is "leapfrog".

---

## v1.0.0 — The big rewrite: custom webview mode

### [ ] Custom webview with stream-json parsing

**What:** Replace (or complement, as a toggle) xterm.js with a fully custom Obsidian
view that runs Claude Code in non-interactive streaming mode and renders messages,
tool calls, diffs, and permission prompts as structured HTML cards.

**Why:** This is the single biggest UX delta between VS Code and our current plugin.
Raw xterm.js gives us ANSI-colored text. Webview mode gives us:
- Markdown-rendered messages with code highlighting
- Collapsible tool call cards
- Inline diff viewers with accept/reject
- Permission prompt cards with proper buttons
- Todo list side panel
- Token/cost tracking in the chat

**How:**
- Run Claude Code with `claude -p --output-format=stream-json --input-format=stream-json`.
- Parse the JSONL stream — each line is a typed event: `user_message`, `assistant_message`,
  `tool_use`, `tool_result`, `permission_request`, `result`.
- Build a React-free UI (vanilla DOM or Preact) rendering each event as a card.
- Handle user input by writing JSON lines to stdin.
- Keep the xterm.js mode as a fallback setting (`uiMode: "terminal" | "webview"`).

**Effort:** ~2-3 weeks CC time. This is a ground-up rewrite of the view layer.

**Files:** new `src/webview/` directory with multiple files.

**Risks:**
- `stream-json` input/output format may not cover 100% of interactive Claude Code
  features (slash commands, keyboard shortcuts). Need to verify.
- Some Claude Code functionality may require the TUI and not work in `-p` mode. Need
  to test each feature.

**Dependencies:**
- Verify stable stream-json schema across Claude Code versions.
- Confirm slash commands work in `-p` mode or design an alternative dispatch.

---

### [ ] Inline diff viewer with accept/reject

**What:** When Claude proposes a file edit, show a side-by-side or unified diff inside
the chat with Accept / Reject / "Tell Claude what to do instead" buttons.

**Why:** Currently the user sees the diff as text in the terminal and has to manually
approve via CLI. VS Code's inline approval is a major UX win.

**How:**
- Requires webview mode.
- Parse `tool_use` events for Edit/Write tools.
- Render diff using a lightweight JS diff library (e.g., `diff` npm package) or Obsidian's
  built-in markdown diff.
- Wire Accept/Reject to Claude Code's permission response via stdin.

**Effort:** ~1 week CC time after webview mode exists.

**Files:** `src/webview/diff-card.ts`.

**Dependency:** Webview mode must land first.

---

### [ ] Todo list side panel

**What:** When Claude uses the TodoWrite tool, display the current todo list as a
persistent side panel (or collapsible card at the top of the chat) showing
pending/in-progress/completed items.

**Why:** Right now todos scroll away in the terminal. A sticky display keeps the user
oriented during long sessions.

**How:**
- Parse `tool_use` events for TodoWrite.
- Maintain local state of the todo list.
- Render it as either a right-docked sub-panel or a sticky header in the chat view.

**Effort:** ~2 days CC time after webview mode exists.

**Files:** `src/webview/todo-panel.ts`.

**Dependency:** Webview mode.

---

### [ ] Progress indicators for long operations

**What:** Show a spinner + elapsed time when Claude is running a long tool call (e.g.,
a long Bash command, a WebSearch, a large Read). VS Code shows this in the status bar.

**Why:** Without feedback, users wonder if Claude is stuck.

**How:**
- In webview mode, track active tool calls and render a spinner card.
- In terminal mode, this already exists as Claude's spinner output — no change needed.

**Effort:** ~1 day CC time after webview mode exists.

---

### [ ] Session title generation

**What:** After the first user message in a session, call Claude (or a cheap model) to
generate a short title for the session. Display it in the tab name and the session
browser.

**Why:** "Claude Code #3" is useless. "Fix auth bug in login flow" is useful.

**How:**
- On first user message, make a one-shot call to Claude Haiku with the message and ask
  for a 3-5 word title.
- Store the title in the session metadata.
- Update the `ClaudeTerminalView.getDisplayText()` to return the title.

**Effort:** ~3 hours CC time.

**Files:** `src/session-title-generator.ts`, `src/claude-terminal-view.ts`.

**Note:** Can ship in v0.5.0 independently of webview mode — the title display works
in terminal mode too.

---

## Ongoing / Backlog

### [ ] Onboarding walkthrough

Dismissible checklist of "Learn Claude Code" items with "Show me" buttons that walk
the user through each feature. Similar to VS Code's walkthrough.

**Effort:** ~1 day CC time.

---

### [ ] `@terminal:name` references

Let the user reference a specific terminal's output with `@terminal:1` in the prompt.
Currently we only support file references.

**Effort:** ~4 hours CC time.

---

### [ ] MCP/plugin management GUI

A settings panel for managing installed MCP servers (enable/disable, view tools, add
from marketplace). Currently users edit JSON files manually.

**Effort:** ~1 week CC time.

---

### [ ] Per-terminal working directory selector

Each terminal can have its own CWD, not just the global `cwdOverride` setting. Useful
for multi-project vaults.

**Effort:** ~4 hours CC time.

---

### [ ] Keyboard shortcut for @-mention active file

`Cmd+Opt+K` style shortcut that inserts a reference to the currently active note in
the editor, including line range if text is selected. VS Code has `Opt+K`.

**Effort:** ~2 hours CC time.

---

## Completed

### [x] MCP context server with automatic workspace awareness
**Completed:** v0.3.0 (2026-04-10)

Built-in MCP server exposes open notes, active file, and vault search to Claude Code.
System prompt injection tells Claude which notes are open without the user having to
ask. `.mcp.json` and tool permissions auto-written on load.
