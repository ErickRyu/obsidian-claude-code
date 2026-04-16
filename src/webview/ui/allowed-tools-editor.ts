/**
 * Allowed-tools editor — Sub-AC 4 of AC 11.
 *
 * Lets the user OVERRIDE the permission preset's default `--allowedTools`
 * bundle with a custom subset (or superset within the canonical
 * `AllowedToolName` alphabet), and SURFACES the effective tool list that
 * the next `claude -p` spawn will actually see.  The override flows into
 * `SpawnArgsOptions.allowedToolsOverride` (Sub-AC 2 of AC 11) so the
 * existing argv builder is reused unchanged — this module is the UI layer
 * that populates that option.
 *
 * Interaction with `permission-dropdown.ts` (Sub-AC 3 of AC 11)
 * -----------------------------------------------------------
 *   1. The editor seeds its initial **effective** list from the preset's
 *      default (read from `PERMISSION_PRESETS[settings.permissionPreset]`)
 *      when the override is empty, mirroring the spawn-args semantics.
 *   2. The editor subscribes to `ui.permission-change` so that when the
 *      user switches presets in the dropdown, the surfaced "effective
 *      tools:" label refreshes without losing the user's explicit
 *      override (if any).
 *   3. On each change the editor emits
 *      `bus.emit({kind:'ui.allowed-tools-change', override, effective})`
 *      so a future status bar / session controller can observe the
 *      user's intent without re-reading DOM state.
 *
 * Override persistence
 * --------------------
 * The override is held in the caller-owned `AllowedToolsOverrideState`
 * object — NOT in the plugin's settings schema.  v0.6.0 Beta keeps the
 * persisted settings footprint frozen at 5 new fields (see
 * settings-adapter.ts); surviving-restarts persistence is deferred to
 * v0.7.0.  The state object lives on the Phase 4b view instance so the
 * override survives the dropdown being re-rendered but not an Obsidian
 * restart — consistent with "custom for this session" UX.
 *
 * UX contract — two interchangeable input modes
 * ---------------------------------------------
 * The spec calls for "multi-select OR comma-separated input"; this
 * module provides BOTH in the same component:
 *
 *   - A checkbox grid with one box per `AllowedToolName` — preferred for
 *     discoverability and typo-safety.
 *   - A single `<input type="text">` rendering the comma-joined override
 *     for power-users who prefer keyboard-only editing; validated against
 *     `isAllowedToolName` on blur / Enter.
 *
 * Both controls write the same `state.override` and emit the same bus
 * event, so a test / product call can drive either path and reach the
 * same argv.
 *
 * Error-surface discipline
 * ------------------------
 *   - Unknown tool names in the text input (e.g. "Reed" typo) are
 *     surfaced via `bus.emit({kind:'session.error', message:...})` with
 *     the `[claude-webview]` namespace and the override is NOT applied
 *     for that bad token — other valid tokens in the same input still
 *     take effect, so a single typo cannot silently wipe a known-good
 *     override.
 *   - A `persist()` throw / rejection (when caller wires persistence in
 *     a future phase) is surfaced on `session.error` — the DOM event
 *     loop never sees the failure — mirroring `permission-dropdown.ts`
 *     `persistSafely` pattern.
 *
 * Design rules (same as permission-dropdown.ts)
 * ---------------------------------------------
 *   - DOM-mutation-API ban: createElement + replaceChildren only.
 *     The grep gate under src/webview/ui/ (verification step 4a-5 in
 *     RALPH_PLAN.md) verifies 0 matches against the banned mutation
 *     methods listed there — this file uses only the replaceChildren
 *     batched-assembly pattern that layout.ts established.
 *   - No `any`; no ts-ignore / ts-expect-error escape hatches.
 *   - No plugin coupling: the module takes a narrow `{settings, bus,
 *     state, persist}` options object; it does NOT import `Plugin`.
 *   - Named export only — the factory `buildAllowedToolsEditor` returns
 *     the wrapper `<fieldset>` so the caller can reference it for
 *     disposal / re-layout.
 *
 * File allowlist: this module is slotted into Phase 4b under
 * `ui/allowed-tools-editor.ts` (see `scripts/check-allowlist.sh`).
 */
import type { Bus } from "../event-bus";
import type { PermissionPreset } from "../settings-adapter";
import type { DomEventRegistrar } from "./permission-dropdown";
import {
  ALLOWED_TOOL_NAMES,
  PERMISSION_PRESETS,
  isAllowedToolName,
  isPermissionPreset,
  type AllowedToolName,
} from "../session/permission-presets";

/**
 * Narrow settings surface the editor reads from.  Deliberately a subset
 * of `ClaudeTerminalSettings` so tests can construct a plain object
 * without pulling the full plugin-coupled shape through the import graph.
 */
export interface AllowedToolsEditorSettings {
  permissionPreset: PermissionPreset;
}

/**
 * Mutable session-scoped state holder for the override.  The caller owns
 * this object; the editor mutates `override` in place on each change and
 * re-reads it when the preset changes to refresh the effective list.
 *
 * `override === null` (or `[]`) means "no override applied — use the
 * preset default".  A non-empty array means the user has explicitly
 * chosen that subset regardless of preset.
 */
export interface AllowedToolsOverrideState {
  override: ReadonlyArray<AllowedToolName> | null;
}

/**
 * Construction options.  `persist` is invoked after each successful
 * override change; v0.6.0 Beta callers pass a noop since the override
 * is session-scoped, but the signature is kept identical to
 * `PermissionDropdownOptions.persist` so a future phase can add
 * `this.plugin.saveSettings()` without re-threading the call site.
 */
export interface AllowedToolsEditorOptions {
  readonly settings: AllowedToolsEditorSettings;
  readonly state: AllowedToolsOverrideState;
  readonly bus: Bus;
  readonly persist: () => void | Promise<void>;
  /**
   * Optional auto-cleanup DOM-event registrar.  Mirrors the same field in
   * `permission-dropdown.ts`: when `view.ts` attaches the editor it
   * passes `(el, type, handler) => this.registerDomEvent(el, type,
   * handler)` so the three listeners (checkboxes × N, text-input change,
   * text-input keydown) tear down with the leaf on close.  Tests omit it
   * and fall back to plain `addEventListener`.
   */
  readonly registerDomEvent?: DomEventRegistrar;
}

/**
 * CSS classes applied to the sub-structure.  Exported so tests and the
 * styles.css rules key off the same strings.  The `CHECKBOX_PREFIX` +
 * tool name gives each checkbox a stable id (`claude-wv-tool-Read`) for
 * `label[for]` linkage and for test-time `querySelector` lookups.
 */
export const ALLOWED_TOOLS_EDITOR_CLASS = "claude-wv-allowed-tools-editor";
export const ALLOWED_TOOLS_EDITOR_EFFECTIVE_CLASS =
  "claude-wv-allowed-tools-editor__effective";
export const ALLOWED_TOOLS_EDITOR_INPUT_CLASS =
  "claude-wv-allowed-tools-editor__input";
export const ALLOWED_TOOLS_EDITOR_CHECKBOX_CLASS =
  "claude-wv-allowed-tools-editor__checkbox";
export const ALLOWED_TOOLS_EDITOR_CHECKBOX_ID_PREFIX = "claude-wv-tool-";

/**
 * Result of `parseAllowedToolsOverride`.  `tokens` is the validated
 * subset (preserving input order, deduped) and `invalid` is the list of
 * rejected tokens so the caller can surface a `session.error`.
 */
export interface ParsedOverride {
  readonly tokens: ReadonlyArray<AllowedToolName>;
  readonly invalid: ReadonlyArray<string>;
}

/**
 * Split a free-form comma-separated override string into validated
 * `AllowedToolName` tokens.  Whitespace-tolerant (trims each token),
 * deduplicating (first occurrence wins), case-sensitive (must match
 * canonical names exactly — "read" is rejected, "Read" accepted).
 *
 * Empty input / whitespace-only input returns `{tokens: [], invalid:
 * []}` — callers interpret an empty `tokens` list as "no override".
 */
export function parseAllowedToolsOverride(raw: string): ParsedOverride {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { tokens: [], invalid: [] };
  }
  const seen = new Set<string>();
  const tokens: AllowedToolName[] = [];
  const invalid: string[] = [];
  for (const part of trimmed.split(",")) {
    const tok = part.trim();
    if (tok.length === 0) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    if (isAllowedToolName(tok)) {
      tokens.push(tok);
    } else {
      invalid.push(tok);
    }
  }
  return { tokens, invalid };
}

/**
 * Compute the effective allowed-tools list that the next `claude -p`
 * spawn will actually receive.  Mirrors the `resolveEffectiveConfig`
 * logic in `spawn-args.ts` so the UI cannot drift from argv assembly:
 *
 *   - override is null or empty array → fall back to preset default
 *   - override is non-empty           → use override verbatim
 */
export function computeEffectiveAllowedTools(
  preset: PermissionPreset,
  override: ReadonlyArray<AllowedToolName> | null
): ReadonlyArray<AllowedToolName> {
  if (!override || override.length === 0) {
    const cfg = PERMISSION_PRESETS[preset];
    return cfg ? cfg.allowedTools : [];
  }
  return override;
}

interface InternalRefs {
  readonly effectiveEl: HTMLElement;
  readonly textInput: HTMLInputElement;
  readonly checkboxes: ReadonlyArray<HTMLInputElement>;
}

/**
 * Assemble the allowed-tools editor fieldset and mount it into `root`.
 * Returns the wrapping `<fieldset>` so the caller can reference the
 * element for disposal / re-layout; the inner `<input>` and checkboxes
 * are reachable via standard `querySelector` calls keyed off the
 * exported class / id constants.
 *
 * Contract (tested by `test/webview/allowed-tools-editor.test.ts`):
 *
 *   - Wrapper is a `<fieldset>` with class
 *     `claude-wv-allowed-tools-editor` and `role="group"`.
 *   - A `<legend>` precedes the controls with the label
 *     "Allowed tools (override preset):".
 *   - 7 checkboxes render in `ALLOWED_TOOL_NAMES` order, each with a
 *     `<label for>` that matches the checkbox id
 *     (`claude-wv-tool-<ToolName>`).
 *   - A text `<input>` mirrors the checkbox state as a comma-joined
 *     list; typing a new list updates the checkboxes on blur / Enter.
 *   - A `<span class="…__effective">` surfaces "Effective: <csv>
 *     (<source>)" where source is either the preset label (when no
 *     override) or "custom".
 *   - Initial state:
 *       - state.override === null/[] → all checkboxes reflect the
 *         preset defaults (checked iff tool is in preset), text input
 *         shows empty, effective displays preset default.
 *       - state.override non-empty → boxes reflect override, text
 *         input shows "A,B,C", effective shows "A, B, C (custom)".
 *   - Change handling:
 *       - Toggling a checkbox updates `state.override`, emits one
 *         `ui.allowed-tools-change`, refreshes the effective label,
 *         updates the text input, and calls `persist` once.
 *       - Editing the text input on Enter / blur parses via
 *         `parseAllowedToolsOverride`, updates state/checkboxes, and
 *         surfaces any invalid tokens via `session.error` (valid tokens
 *         still apply).
 *   - Preset change via bus refreshes the effective label (only when
 *     override is empty; an explicit override is preserved).
 *   - `persist()` throw / rejection is caught and surfaced via
 *     `session.error` with the `[claude-webview]` namespace.
 */
export function buildAllowedToolsEditor(
  root: HTMLElement,
  options: AllowedToolsEditorOptions
): HTMLElement {
  const doc = root.ownerDocument;
  if (!doc) {
    throw new Error(
      "[claude-webview] buildAllowedToolsEditor: root has no ownerDocument"
    );
  }

  const { settings, state, bus, persist } = options;
  const register: DomEventRegistrar =
    options.registerDomEvent ??
    ((el, type, handler) => el.addEventListener(type, handler));

  // Validate incoming override for the initial render; invalid entries
  // are dropped and surfaced so a hand-edited setting does not silently
  // coerce.
  if (state.override !== null) {
    const cleaned: AllowedToolName[] = [];
    const dropped: string[] = [];
    for (const t of state.override) {
      if (isAllowedToolName(t)) {
        cleaned.push(t);
      } else {
        dropped.push(String(t));
      }
    }
    if (dropped.length > 0) {
      bus.emit({
        kind: "session.error",
        message:
          `[claude-webview] allowed-tools editor: dropping unknown tool(s) from initial override: ${dropped.join(
            ", "
          )}`,
      });
    }
    state.override = cleaned.length > 0 ? cleaned : null;
  }

  // Resolve initial preset, guarding against a malformed settings value.
  const initialPreset: PermissionPreset = isPermissionPreset(
    settings.permissionPreset
  )
    ? settings.permissionPreset
    : "standard";

  const wrapper = doc.createElement("fieldset");
  wrapper.classList.add(ALLOWED_TOOLS_EDITOR_CLASS);
  wrapper.setAttribute("role", "group");
  wrapper.setAttribute("aria-label", "Allowed tools editor");

  const legend = doc.createElement("legend");
  legend.textContent = "Allowed tools (override preset):";

  // Checkbox grid — one box per AllowedToolName, in canonical order.
  const grid = doc.createElement("div");
  grid.classList.add("claude-wv-allowed-tools-editor__grid");
  const checkboxes: HTMLInputElement[] = [];
  const checkboxLabels: HTMLElement[] = [];

  for (const tool of ALLOWED_TOOL_NAMES) {
    const id = `${ALLOWED_TOOLS_EDITOR_CHECKBOX_ID_PREFIX}${tool}`;

    const cell = doc.createElement("div");
    cell.classList.add("claude-wv-allowed-tools-editor__cell");

    const checkbox = doc.createElement("input");
    checkbox.setAttribute("type", "checkbox");
    checkbox.classList.add(ALLOWED_TOOLS_EDITOR_CHECKBOX_CLASS);
    checkbox.id = id;
    checkbox.setAttribute("name", `claude-wv-tool-${tool}`);
    checkbox.setAttribute("data-tool", tool);

    const lbl = doc.createElement("label");
    lbl.setAttribute("for", id);
    lbl.textContent = tool;

    cell.replaceChildren(checkbox, lbl);
    checkboxes.push(checkbox);
    checkboxLabels.push(cell);
  }
  grid.replaceChildren(...checkboxLabels);

  // Free-form comma-separated input (power-user path).
  const inputWrapper = doc.createElement("div");
  inputWrapper.classList.add("claude-wv-allowed-tools-editor__input-row");

  const inputLabel = doc.createElement("label");
  const inputId = "claude-wv-allowed-tools-input";
  inputLabel.setAttribute("for", inputId);
  inputLabel.textContent = "Custom list:";

  const textInput = doc.createElement("input");
  textInput.setAttribute("type", "text");
  textInput.classList.add(ALLOWED_TOOLS_EDITOR_INPUT_CLASS);
  textInput.id = inputId;
  textInput.setAttribute(
    "placeholder",
    "e.g. Read,Edit,Write — leave blank for preset default"
  );

  inputWrapper.replaceChildren(inputLabel, textInput);

  // "Effective tools: <csv> (<source>)" surfaced live so the user always
  // sees what the next spawn will receive.
  const effectiveEl = doc.createElement("div");
  effectiveEl.classList.add(ALLOWED_TOOLS_EDITOR_EFFECTIVE_CLASS);
  effectiveEl.setAttribute("aria-live", "polite");

  wrapper.replaceChildren(legend, grid, inputWrapper, effectiveEl);

  const refs: InternalRefs = {
    effectiveEl,
    textInput,
    checkboxes,
  };

  // Active-preset ref declared BEFORE any handler that reads it so the
  // temporal-dead-zone rule holds.  Updated by the preset-change
  // subscriber below.
  const activePresetRef: { current: PermissionPreset } = {
    current: initialPreset,
  };

  // Seed the controls from the initial state + preset.
  syncControlsFromState(refs, state, activePresetRef.current);

  // Checkbox change → recompute override from boxes, write state, emit.
  for (const cb of checkboxes) {
    register(cb, "change", () => {
      const next = readOverrideFromCheckboxes(checkboxes, activePresetRef);
      applyOverride(refs, state, bus, persist, next, activePresetRef);
    });
  }

  // Text input: parse on Enter or blur so we do not re-render on every
  // keystroke (noisy + would fight the user's typing).
  const commit = (): void => {
    const raw = textInput.value;
    const parsed = parseAllowedToolsOverride(raw);
    if (parsed.invalid.length > 0) {
      bus.emit({
        kind: "session.error",
        message:
          `[claude-webview] allowed-tools editor: ignored unknown tool(s) in custom list: ${parsed.invalid.join(
            ", "
          )}`,
      });
    }
    const next: ReadonlyArray<AllowedToolName> | null =
      parsed.tokens.length === 0 ? null : parsed.tokens;
    applyOverride(refs, state, bus, persist, next, activePresetRef);
  };
  register(textInput, "change", commit);
  register(textInput, "keydown", (ev: Event) => {
    // happy-dom and real browsers both emit KeyboardEvent with `key`.
    const ke = ev as KeyboardEvent;
    if (ke.key === "Enter") {
      ev.preventDefault();
      commit();
    }
  });

  // Preset change: refresh the effective label (and checkbox seeding
  // when there is no explicit override yet).  The shared ref lets the
  // handler read the latest active preset without rebuilding the DOM.
  bus.on("ui.permission-change", (e) => {
    activePresetRef.current = e.preset;
    // If the user has not overridden, the checkboxes should follow the
    // new preset's defaults.  If they have overridden, we leave the
    // checkboxes alone (override is an explicit user intent).
    syncControlsFromState(refs, state, activePresetRef.current);
  });

  // Append without wiping existing root children.
  const existing = Array.from(root.children);
  root.replaceChildren(...existing, wrapper);

  return wrapper;
}

/**
 * Read the current override from the checkbox grid.  Returns null when
 * every checkbox is EITHER in the preset default state AND the user has
 * not previously set an explicit override — but since the grid reflects
 * the state mutation path, we return the literal array (or null when
 * empty).  The caller decides whether "matches preset default" counts
 * as "no override" vs "explicit all-tools override".
 */
function readOverrideFromCheckboxes(
  checkboxes: ReadonlyArray<HTMLInputElement>,
  presetRef: { current: PermissionPreset }
): ReadonlyArray<AllowedToolName> | null {
  const checked: AllowedToolName[] = [];
  for (const cb of checkboxes) {
    const tool = cb.getAttribute("data-tool");
    if (cb.checked && tool && isAllowedToolName(tool)) {
      checked.push(tool);
    }
  }
  // If the checked set exactly equals the preset default, treat as
  // "no override" — the user clicked through to the defaults, which is
  // UX-equivalent to leaving the editor untouched.  Prevents spurious
  // override==true states that would force isCustom=true on spawn-args.
  const presetCfg = PERMISSION_PRESETS[presetRef.current];
  if (presetCfg && checked.length === presetCfg.allowedTools.length) {
    const presetSet = new Set<string>(presetCfg.allowedTools);
    const everyMatches = checked.every((t) => presetSet.has(t));
    if (everyMatches) return null;
  }
  if (checked.length === 0) return null;
  return checked;
}

/**
 * Apply the new override to state + refresh DOM + emit bus + persist.
 *
 * `persist()` is awaited in a detached task so the event handler stays
 * non-blocking; rejections / throws surface via `session.error`.  The
 * bus event is emitted ONLY when the override semantics actually change
 * (cheap deep-compare via JSON.stringify — the arrays are short).
 */
function applyOverride(
  refs: InternalRefs,
  state: AllowedToolsOverrideState,
  bus: Bus,
  persist: () => void | Promise<void>,
  next: ReadonlyArray<AllowedToolName> | null,
  presetRef: { current: PermissionPreset }
): void {
  const prev = state.override;
  const prevKey =
    prev === null ? "__null__" : JSON.stringify([...prev]);
  const nextKey =
    next === null ? "__null__" : JSON.stringify([...next]);
  if (prevKey === nextKey) {
    // No-op — skip emit + persist so the caller does not see spurious
    // re-spawn triggers.  Still re-sync the DOM in case the input text
    // differed from the checkbox grid.
    syncControlsFromState(refs, state, presetRef.current);
    return;
  }

  state.override = next;
  syncControlsFromState(refs, state, presetRef.current);

  const effective = computeEffectiveAllowedTools(presetRef.current, next);
  bus.emit({
    kind: "ui.allowed-tools-change",
    override: next,
    effective,
  });

  void persistSafely(persist, bus);
}

/**
 * Refresh all three sub-controls (checkboxes, text input, effective
 * label) from the current `state.override` + active preset.  Called on
 * build, on user change, and on preset change.
 */
function syncControlsFromState(
  refs: InternalRefs,
  state: AllowedToolsOverrideState,
  activePreset: PermissionPreset
): void {
  const effective = computeEffectiveAllowedTools(activePreset, state.override);
  const effectiveSet = new Set<string>(effective);

  // Checkboxes: reflect the effective list.  When override is null, this
  // is the preset default; when override is set, this is the override.
  for (const cb of refs.checkboxes) {
    const tool = cb.getAttribute("data-tool");
    cb.checked = tool !== null && effectiveSet.has(tool);
  }

  // Text input: empty string when no override, comma-joined otherwise.
  refs.textInput.value =
    state.override && state.override.length > 0
      ? [...state.override].join(",")
      : "";

  // Effective label: surface the csv + source tag.
  const source: string =
    state.override === null ? `${activePreset} preset` : "custom";
  const csv = [...effective].join(", ");
  refs.effectiveEl.setAttribute("data-source", source);
  refs.effectiveEl.setAttribute("data-effective", csv);
  refs.effectiveEl.textContent = `Effective: ${csv} (${source})`;
}

/**
 * Shared `persist` wrapper — mirrors `permission-dropdown.ts`'s
 * `persistSafely`.  Awaits the callback's promise (if any) and routes
 * any thrown / rejected error to `session.error` with the
 * `[claude-webview]` namespace so the UI event loop never crashes.
 */
async function persistSafely(
  persist: () => void | Promise<void>,
  bus: Bus
): Promise<void> {
  try {
    await persist();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    bus.emit({
      kind: "session.error",
      message: `[claude-webview] failed to persist allowed-tools override: ${msg}`,
    });
  }
}
