/**
 * Permission preset dropdown — Sub-AC 3 of AC 11.
 *
 * Renders the Safe / Standard / Full <select> control that mounts into the
 * webview ItemView's `headerEl` region (from `ui/layout.ts`).  Three concerns
 * are unified here:
 *
 *   1. Initial value is seeded from `settings.permissionPreset` so a user who
 *      restarts Obsidian sees the preset they last saved — "persisted across
 *      sessions" in plain English.
 *   2. On `change` the handler updates `settings.permissionPreset` in place,
 *      emits `bus.emit({kind:'ui.permission-change', preset})` so any
 *      listener (session controller, status bar, etc.) can observe the
 *      change, and invokes the injected `persist()` callback so the plugin
 *      can call `this.plugin.saveSettings()` against its `data.json`.
 *   3. Labels/descriptions are read from `permission-presets.ts` — the
 *      single source of truth — so the dropdown can never drift from the
 *      spawn-args allowedTools config.
 *
 * Design rules:
 *
 * - **DOM-mutation API ban**: assembled via `createElement` + final
 *   `replaceChildren` at each attach boundary — mirroring `ui/layout.ts`.
 *   No direct DOM-mutation APIs are used: a grep gate (Phase 4a 4a-5)
 *   verifies zero matches under `src/webview/ui/`.
 * - **No plugin coupling**: the module takes a narrow `{settings, bus,
 *   persist}` triple rather than importing `Plugin` — keeps the unit test
 *   DOM-only and lets Phase 4b's `view.ts` supply the real
 *   `() => this.plugin.saveSettings()`.
 * - **Error-surface discipline**: if `persist()` throws (e.g. disk full,
 *   Obsidian vault in read-only state) the failure is surfaced via
 *   `bus.emit({kind:'session.error', ...})` with the `[claude-webview]`
 *   namespace — never silently swallowed.  The settings mutation is NOT
 *   rolled back: consistent with Obsidian's own `saveSettings` semantics
 *   the user can retry on next change.
 * - **Change-only emission**: selecting the same preset that is already
 *   active is a no-op (no bus emit, no persist call).  Prevents spurious
 *   re-spawns if a future change handler reacts to the bus event.
 * - **Async persist support**: `persist()` may return a Promise.  The
 *   returned Promise is awaited but its rejection is caught and surfaced
 *   as `session.error` — callers do NOT need to handle it themselves.
 *
 * File allowlist: phase4b `ui/permission-dropdown.ts` slot in
 * `scripts/check-allowlist.sh`.
 */
import type { Bus } from "../event-bus";
import type { PermissionPreset } from "../settings-adapter";
import {
  PERMISSION_PRESETS,
  PERMISSION_PRESET_ORDER,
  isPermissionPreset,
} from "../session/permission-presets";

/**
 * Narrow settings surface the dropdown mutates.  Deliberately a subset of
 * `ClaudeTerminalSettings` so tests can pass a plain object without
 * carrying the full plugin-coupled shape.
 */
export interface PermissionDropdownSettings {
  permissionPreset: PermissionPreset;
}

/**
 * DOM-event registrar — a caller-supplied bridge so the listener can be
 * auto-cleaned on Obsidian view unload.  `view.ts` passes
 * `(el, type, handler) => this.registerDomEvent(el, type, handler)` so
 * Obsidian's `Component.registerDomEvent` tears the listener down when
 * the leaf closes.  Test fixtures omit it and we fall back to a plain
 * `el.addEventListener` (DOM-only tests do not need cleanup guarantees).
 */
export type DomEventRegistrar = (
  el: HTMLElement,
  type: keyof HTMLElementEventMap,
  handler: (ev: Event) => void
) => void;

/**
 * Construction options.  `persist` is invoked after each successful preset
 * change; the dropdown does not itself know how to talk to Obsidian's
 * plugin storage.  Tests inject a spy; `view.ts` injects
 * `() => this.plugin.saveSettings()`.
 */
export interface PermissionDropdownOptions {
  readonly settings: PermissionDropdownSettings;
  readonly bus: Bus;
  readonly persist: () => void | Promise<void>;
  /**
   * Optional auto-cleanup DOM-event registrar (see `DomEventRegistrar`).
   * When omitted, the dropdown falls back to `el.addEventListener` — test
   * fixtures do not need cleanup and plugin code passes the view-scoped
   * registrar explicitly to prevent listener leaks across reload cycles.
   */
  readonly registerDomEvent?: DomEventRegistrar;
}

/**
 * Root class applied to the wrapping `<div>`.  Exported so tests and
 * styling can key off the same string.
 */
export const PERMISSION_DROPDOWN_CLASS = "claude-wv-permission-dropdown";

/**
 * Assemble the dropdown wrapper and mount it into `root`.  Returns the
 * wrapping `<div>` (NOT the `<select>`) so the caller can reference the
 * element for disposal / re-layout; the `<select>` is reachable via the
 * standard `wrapper.querySelector("select")`.
 *
 * Contract (tested by `test/webview/permission-dropdown.test.ts`):
 *
 * - Wrapper has class `claude-wv-permission-dropdown` and role `group`.
 * - A `<label>` precedes the `<select>` and its `for` attribute matches
 *   the `<select>`'s `id` for a11y.
 * - Exactly 3 `<option>` elements are present, in the
 *   `PERMISSION_PRESET_ORDER` order (`safe`, `standard`, `full`).
 * - Option `value` is the preset id; option `textContent` is the human
 *   label from `PERMISSION_PRESETS[preset].label`.
 * - Option `title` attribute carries the full description (tooltip).
 * - `<select>.value` initializes to `settings.permissionPreset`.
 * - On `change`, the handler mutates `settings.permissionPreset`, emits
 *   `ui.permission-change`, and awaits `persist()`.  A `persist` throw is
 *   surfaced via `session.error` on the bus.
 */
export function buildPermissionDropdown(
  root: HTMLElement,
  options: PermissionDropdownOptions
): HTMLElement {
  const doc = root.ownerDocument;
  if (!doc) {
    throw new Error(
      "[claude-webview] buildPermissionDropdown: root has no ownerDocument"
    );
  }

  const { settings, bus, persist } = options;
  const register: DomEventRegistrar =
    options.registerDomEvent ??
    ((el, type, handler) => el.addEventListener(type, handler));

  // If somehow the settings carry a stale/unknown label (e.g. a hand-edited
  // data.json), fall back to "standard" in the UI while leaving the raw
  // settings value alone — surfacing the mismatch via session.error so the
  // user sees it instead of silently coercing.
  let initialPreset: PermissionPreset;
  if (isPermissionPreset(settings.permissionPreset)) {
    initialPreset = settings.permissionPreset;
  } else {
    initialPreset = "standard";
    bus.emit({
      kind: "session.error",
      message: `[claude-webview] unknown permissionPreset in settings: ${String(settings.permissionPreset)} — defaulting dropdown to 'standard'`,
    });
  }

  const wrapper = doc.createElement("div");
  wrapper.classList.add(PERMISSION_DROPDOWN_CLASS);
  wrapper.setAttribute("role", "group");
  wrapper.setAttribute("aria-label", "Permission preset");

  const selectId = "claude-wv-permission-select";

  const label = doc.createElement("label");
  label.classList.add("claude-wv-permission-dropdown__label");
  label.setAttribute("for", selectId);
  label.textContent = "Permissions:";

  const select = doc.createElement("select");
  select.classList.add("claude-wv-permission-dropdown__select");
  select.id = selectId;
  select.setAttribute("name", "claude-wv-permission-preset");

  const optionNodes: HTMLOptionElement[] = [];
  for (const preset of PERMISSION_PRESET_ORDER) {
    const cfg = PERMISSION_PRESETS[preset];
    const opt = doc.createElement("option");
    opt.value = cfg.preset;
    opt.textContent = cfg.label;
    opt.setAttribute("title", cfg.description);
    if (preset === initialPreset) {
      opt.selected = true;
    }
    optionNodes.push(opt);
  }
  select.replaceChildren(...optionNodes);
  // Explicitly sync the select's value in case `selected` did not stick on
  // all DOM implementations (happy-dom vs browser).
  select.value = initialPreset;

  register(select, "change", () => {
    const raw = select.value;
    if (!isPermissionPreset(raw)) {
      // A foreign value should be impossible here (the only options we
      // rendered are valid presets), but defend against DOM tampering.
      bus.emit({
        kind: "session.error",
        message: `[claude-webview] permission dropdown received unknown value: ${String(raw)}`,
      });
      return;
    }
    const next: PermissionPreset = raw;
    if (next === settings.permissionPreset) {
      // No-op: selecting the already-active preset does not re-emit.
      return;
    }

    settings.permissionPreset = next;
    bus.emit({ kind: "ui.permission-change", preset: next });

    // persist() may be sync or async; await in a detached task so the
    // change-handler stays non-blocking.  Errors surface via bus.
    void persistSafely(persist, bus);
  });

  wrapper.replaceChildren(label, select);
  // Append to root without wiping its existing children — the header may
  // host the status bar alongside this dropdown in later phases.
  const existing = Array.from(root.children);
  root.replaceChildren(...existing, wrapper);

  return wrapper;
}

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
      message: `[claude-webview] failed to persist permission preset: ${msg}`,
    });
  }
}
