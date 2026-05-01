/**
 * Activity Group renderer (2026-05-01 dogfood) — groups consecutive
 * generic tool_use rows (Read / Bash / Grep / Glob / WebFetch / Task / …)
 * into a single collapsed-by-default container card so the conversation
 * stream stays readable when an assistant turn fans out a lot of tools.
 *
 * Design:
 * - One *active* group at a time. The group is opened lazily by
 *   `ensureActivityGroup` when a generic tool_use is about to render and
 *   no group is currently active. It is closed by `closeActivityGroup`,
 *   which the dispatcher invokes whenever an event arrives that visually
 *   "ends" the tool burst — assistant text, Edit/Write diff cards, the
 *   TodoWrite panel, and any non-tool_result user turn.
 * - Closing only resets `state`; the DOM container remains in place so
 *   prior turns stay scrollable. The next generic tool starts a fresh
 *   group element appended after it.
 * - The group container is a `.claude-wv-card` so existing card-flow
 *   styles (border, gap with neighbors) apply, but it carries an extra
 *   `.claude-wv-card--activity-group` class so card-kind selectors can
 *   exclude it.
 * - The body element returned by `ensureActivityGroup` is the parent
 *   into which `assistant-tool-use.ts` appends its tool-line nodes. This
 *   keeps the leaf renderer agnostic of grouping — it just receives a
 *   different `parent` argument than before.
 * - Header text reflects live tool count and a running indicator while
 *   any line is pending. `data-pending` on the group element drives the
 *   pulsing dot in CSS, mirroring the pattern used on individual lines.
 * - Errors do NOT auto-open the group container. The compaction goal
 *   wins: the group stays collapsed by default, and the header surfaces
 *   a red `N error(s)` chip so the failure is visible at a glance.
 *   The line's own `<details>` is auto-opened (by user-tool-result.ts)
 *   so the failure body is immediately readable once the user expands
 *   the group.
 */

export interface ActivityGroupRenderState {
  current: {
    group: HTMLElement;
    body: HTMLElement;
    details: HTMLDetailsElement;
    summary: HTMLElement;
  } | null;
  toolLines: Map<string, HTMLElement>;
  toolCount: number;
  pendingCount: number;
  errorCount: number;
}

export function createActivityGroupState(): ActivityGroupRenderState {
  return {
    current: null,
    toolLines: new Map(),
    toolCount: 0,
    pendingCount: 0,
    errorCount: 0,
  };
}

/**
 * Return the body element of the active group, creating the group if
 * none is active. The returned element is where leaf renderers should
 * `appendChild` / `replaceChildren` their tool-line nodes.
 */
export function ensureActivityGroup(
  state: ActivityGroupRenderState,
  parent: HTMLElement,
  doc: Document,
): HTMLElement {
  if (state.current !== null) {
    return state.current.body;
  }

  const group = doc.createElement("div");
  group.classList.add("claude-wv-card", "claude-wv-card--activity-group");
  group.setAttribute("data-pending", "false");

  const details = doc.createElement("details") as HTMLDetailsElement;
  details.classList.add("claude-wv-activity-group-details");
  // collapsed-by-default; opened automatically on first error.

  const summary = doc.createElement("summary");
  summary.classList.add("claude-wv-activity-group-header");

  const body = doc.createElement("div");
  body.classList.add("claude-wv-activity-group-body");

  details.replaceChildren(summary, body);
  group.replaceChildren(details);

  // Append after any existing siblings so a fresh group always lands at
  // the end of the conversation flow. `replaceChildren(...existing,
  // group)` mirrors the pattern used in other renderers and keeps the
  // grep-gate happy (no insertBefore / append).
  const existing = Array.from(parent.children);
  parent.replaceChildren(...existing, group);

  state.current = { group, body, details, summary };
  state.toolLines = new Map();
  state.toolCount = 0;
  state.pendingCount = 0;
  state.errorCount = 0;
  refreshHeader(state);

  return body;
}

/**
 * Mark the active group as ended. Subsequent `ensureActivityGroup`
 * calls will create a brand-new group element. The old group's DOM is
 * left in place so the conversation history stays intact.
 *
 * Before clearing state, force the group container's `data-pending`
 * attribute to `"false"`. Without this, a group that closes while a
 * tool is still in flight (e.g. assistant text arrives between
 * tool_use and tool_result) leaves a dangling pulsing dot on the
 * header. The dispatcher's later `data-pending="false"` sweep updates
 * tool-line elements but not the group container, so this is the only
 * place that catches it.
 */
export function closeActivityGroup(state: ActivityGroupRenderState): void {
  if (state.current !== null) {
    state.current.group.setAttribute("data-pending", "false");
  }
  state.current = null;
  state.toolLines = new Map();
  state.toolCount = 0;
  state.pendingCount = 0;
  state.errorCount = 0;
}

/**
 * Register a tool-line element with the active group, appending it
 * into the group body if not already present. Idempotent on
 * `toolUseId` — repeated calls with the same id reuse the existing
 * tracked entry and do not increment the count.
 *
 * No-op when no group is active (e.g. line was emitted after a
 * `closeActivityGroup`). This keeps the call site safe in the rare
 * edge where the dispatcher closes the group between ensure and
 * register.
 */
export function registerToolUseLine(
  state: ActivityGroupRenderState,
  toolUseId: string,
  line: HTMLElement,
): void {
  if (state.current === null) return;
  if (state.toolLines.has(toolUseId)) {
    // Idempotent re-register; the existing entry is already in the
    // body via prior append. Still refresh the header in case the
    // line's pending/error attributes changed externally.
    refreshHeader(state);
    return;
  }
  // Append into the group body using replaceChildren — the
  // src/webview/renderers/ grep gate forbids direct DOM-mutation APIs.
  const body = state.current.body;
  const existing = Array.from(body.children);
  body.replaceChildren(...existing, line);

  state.toolLines.set(toolUseId, line);
  state.toolCount += 1;
  if (line.getAttribute("data-pending") === "true") {
    state.pendingCount += 1;
  }
  if (line.getAttribute("data-is-error") === "true") {
    state.errorCount += 1;
    // Group stays collapsed; the error count chip in the header
    // signals the failure without breaking the compaction.
  }
  refreshHeader(state);
}

/**
 * Look up a tool line previously registered with this group, by
 * `tool_use_id`. Returns null when the group is closed or the id was
 * never registered (e.g. a tool_result arriving for a tool from a
 * group that has since been ended by an interleaved assistant text).
 */
export function findToolLine(
  state: ActivityGroupRenderState,
  toolUseId: string,
): HTMLElement | null {
  return state.toolLines.get(toolUseId) ?? null;
}

/**
 * Toggle the line's `data-pending` attribute and update the group
 * pending tally. The group's `data-pending` mirrors "any line still
 * running" so CSS can fade out the running indicator on completion.
 * No-op if the id isn't registered.
 */
export function setLinePending(
  state: ActivityGroupRenderState,
  toolUseId: string,
  pending: boolean,
): void {
  const line = state.toolLines.get(toolUseId);
  if (!line) return;
  const wasPending = line.getAttribute("data-pending") === "true";
  if (wasPending === pending) return;
  line.setAttribute("data-pending", pending ? "true" : "false");
  if (pending) {
    state.pendingCount += 1;
  } else {
    state.pendingCount = Math.max(0, state.pendingCount - 1);
  }
  refreshHeader(state);
}

/**
 * Toggle the line's `data-is-error` attribute and update the group
 * error tally. The group container stays collapsed — the error count
 * chip in the header is the user-facing signal. The line's own
 * `<details>` is auto-opened by `user-tool-result.ts` so the failure
 * body is immediately readable once the user expands the group.
 */
export function setLineError(
  state: ActivityGroupRenderState,
  toolUseId: string,
  isError: boolean,
): void {
  const line = state.toolLines.get(toolUseId);
  if (!line || state.current === null) return;
  const wasError = line.getAttribute("data-is-error") === "true";
  if (isError) {
    line.setAttribute("data-is-error", "true");
    if (!wasError) {
      state.errorCount += 1;
    }
  } else {
    line.removeAttribute("data-is-error");
    if (wasError) {
      state.errorCount = Math.max(0, state.errorCount - 1);
    }
  }
  refreshHeader(state);
}

function refreshHeader(state: ActivityGroupRenderState): void {
  if (state.current === null) return;
  const { group, summary } = state.current;
  const isPending = state.pendingCount > 0;
  group.setAttribute("data-pending", isPending ? "true" : "false");
  group.setAttribute(
    "data-has-errors",
    state.errorCount > 0 ? "true" : "false",
  );
  // Compose the header as small spans so styling can target each part.
  // Using `replaceChildren` with text nodes keeps this injection-safe.
  const doc = group.ownerDocument;
  const labelEl = doc.createElement("span");
  labelEl.classList.add("claude-wv-activity-group-label");
  labelEl.textContent = "Activity";
  const sepEl = doc.createElement("span");
  sepEl.classList.add("claude-wv-activity-group-sep");
  sepEl.textContent = " · ";
  const countEl = doc.createElement("span");
  countEl.classList.add("claude-wv-activity-group-count");
  const noun = state.toolCount === 1 ? "tool" : "tools";
  countEl.textContent = `${state.toolCount} ${noun}`;

  const children: Node[] = [labelEl, sepEl, countEl];

  if (state.errorCount > 0) {
    // Red chip surfaces failures while the group itself stays collapsed.
    const chip = doc.createElement("span");
    chip.classList.add("claude-wv-activity-group-error-chip");
    const errNoun = state.errorCount === 1 ? "error" : "errors";
    chip.textContent = `${state.errorCount} ${errNoun}`;
    children.push(chip);
  }

  if (isPending) {
    const dot = doc.createElement("span");
    dot.classList.add("claude-wv-activity-group-dot");
    dot.setAttribute("aria-hidden", "true");
    children.push(dot);
  }

  summary.replaceChildren(...children);
}
