/**
 * Permission preset configuration — Sub-AC 1 of AC 11.
 *
 * Maps each `PermissionPreset` label (`safe` / `standard` / `full`) to the
 * concrete `--permission-mode` value and the default `--allowedTools` list
 * that `claude -p` is spawned with.  This module is the single source of
 * truth for preset semantics; `session/spawn-args.ts` (Phase 3) and
 * `ui/permission-dropdown.ts` (Phase 4b) both consume it so the dropdown
 * labels and the CLI flag they imply cannot drift.
 *
 * Design rules:
 *
 * - **Pure / DOM-free / Node-free**: the module depends only on
 *   `settings-adapter`'s `PermissionPreset` union type.  It imports nothing
 *   from Obsidian or `node:*`, so parser-layer tests and future CLI-only
 *   consumers can reuse it without a happy-dom shim.
 * - **Readonly by construction**: each preset config is frozen via
 *   `as const`, and the exported type widens only the minimum required
 *   fields.  Mutating the returned `allowedTools` array at runtime is a
 *   type error.
 * - **Exhaustive at compile time**: `PERMISSION_PRESETS` is declared as
 *   `Record<PermissionPreset, PermissionPresetConfig>` so dropping a label
 *   from either the union (in `settings-adapter.ts`) or this map fails
 *   `tsc --noEmit`.  `PERMISSION_PRESET_ORDER` mirrors the union for
 *   dropdown iteration stability.
 * - **Distinct presets**: each preset maps to a DIFFERENT `permissionMode`
 *   AND a DIFFERENT `allowedTools` set — spawn-args differential tests
 *   (Phase 3 3-1) and the MH-09 integration test (Phase 4b 4b-1) rely on
 *   this inequality to prove the dropdown actually changes CLI args.
 * - **No --permission-mode "plan"**: the `plan` mode is only surfaced by
 *   system.init events during user-initiated plan-mode sessions; it is not
 *   a preset the user picks from the webview dropdown.  The preset dropdown
 *   covers the three non-interactive modes (`default` / `acceptEdits` /
 *   `bypassPermissions`).
 */
import type { PermissionPreset } from "../settings-adapter";

/**
 * Canonical `--permission-mode` values accepted by `claude -p` that the
 * webview's preset dropdown is permitted to emit.  Narrower than the CLI's
 * full set — we deliberately exclude `plan` here (see module header).
 */
export type PermissionModeValue =
  | "default"
  | "acceptEdits"
  | "bypassPermissions";

/**
 * Canonical tool names Claude recognises on `--allowedTools`.  Narrowing
 * the array element type to this union keeps typos out of the preset
 * config and gives downstream consumers (`spawn-args.ts`) a deterministic
 * comma-join alphabet.
 */
export type AllowedToolName =
  | "Read"
  | "Edit"
  | "Write"
  | "Bash"
  | "Glob"
  | "Grep"
  | "TodoWrite";

/**
 * Per-preset CLI config.  `allowedTools` is a readonly array so callers
 * cannot mutate the shared default lists; copy it (via `[...cfg.allowedTools]`)
 * before appending.
 */
export interface PermissionPresetConfig {
  readonly preset: PermissionPreset;
  readonly permissionMode: PermissionModeValue;
  readonly allowedTools: ReadonlyArray<AllowedToolName>;
  /**
   * Human-readable label for the dropdown and status bar.  Not localised
   * in the Beta — kept as a bare English string so tests can key off it.
   */
  readonly label: string;
  /**
   * One-sentence tooltip explaining the safety tradeoff.  Surfaced by the
   * dropdown in Phase 4b; kept here so copy lives next to the preset it
   * describes.
   */
  readonly description: string;
}

/**
 * Preset → config map.  Declared with an explicit
 * `Record<PermissionPreset, PermissionPresetConfig>` annotation so adding
 * or removing a label in `settings-adapter.ts#PermissionPreset` forces a
 * matching change here at compile time.
 *
 * Differential summary (locked contract — downstream tests depend on it):
 *
 * | preset    | permissionMode      | Bash? | Edit/Write? |
 * |-----------|---------------------|-------|-------------|
 * | safe      | default             |  no   |    no       |
 * | standard  | acceptEdits         |  no   |    yes      |
 * | full      | bypassPermissions   |  yes  |    yes      |
 *
 * The `safe` preset's `default` mode means Claude prompts the user before
 * invoking any tool — the allow-list just caps what CAN be asked about.
 * `standard` auto-accepts file edits (the common case) while still
 * prompting for anything outside the list.  `full` runs wide-open and is
 * for trusted sessions only; Bash is the material difference vs standard.
 */
export const PERMISSION_PRESETS: Readonly<
  Record<PermissionPreset, PermissionPresetConfig>
> = {
  safe: {
    preset: "safe",
    permissionMode: "default",
    allowedTools: ["Read", "Glob", "Grep"] as const,
    label: "Safe",
    description:
      "Read-only tools. Claude prompts before every tool use; edits and Bash are blocked.",
  },
  standard: {
    preset: "standard",
    permissionMode: "acceptEdits",
    allowedTools: [
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
      "TodoWrite",
    ] as const,
    label: "Standard",
    description:
      "File edits auto-accepted; Bash still blocked. Recommended for most sessions.",
  },
  full: {
    preset: "full",
    permissionMode: "bypassPermissions",
    allowedTools: [
      "Read",
      "Edit",
      "Write",
      "Bash",
      "Glob",
      "Grep",
      "TodoWrite",
    ] as const,
    label: "Full",
    description:
      "All tools auto-accepted including Bash. Use only in trusted sessions.",
  },
} as const;

/**
 * Stable dropdown iteration order — matches the safety gradient
 * (most-restrictive first).  Consumers should iterate this array rather
 * than `Object.keys(PERMISSION_PRESETS)` so the ordering is not subject
 * to engine-specific key order.
 */
export const PERMISSION_PRESET_ORDER: ReadonlyArray<PermissionPreset> = [
  "safe",
  "standard",
  "full",
] as const;

/**
 * Canonical list of every `AllowedToolName` Claude recognises on
 * `--allowedTools`.  Sub-AC 4 of AC 11 (allowed-tools editor) iterates this
 * array so the UI offers the same alphabet the type system enforces —
 * adding a new tool in the union forces a matching addition here, which
 * the `isAllowedToolName` guard and the `ALLOWED_TOOL_NAMES.length`
 * vitest assertion both pin.  Ordering mirrors the safety gradient
 * (read-only first, destructive last) so the checkbox grid and the
 * surfaced "effective list" keep a deterministic presentation.
 */
export const ALLOWED_TOOL_NAMES: ReadonlyArray<AllowedToolName> = [
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "TodoWrite",
  "Bash",
] as const;

/**
 * Runtime type guard for untrusted input — e.g. a comma-separated string
 * typed by the user in the allowed-tools editor (Sub-AC 4 of AC 11) or
 * loaded from a hand-edited `data.json`.  Returns true iff the raw string
 * is exactly one of the `AllowedToolName` labels (case-sensitive).
 */
export function isAllowedToolName(value: unknown): value is AllowedToolName {
  return (
    typeof value === "string" &&
    (ALLOWED_TOOL_NAMES as ReadonlyArray<string>).includes(value)
  );
}

/**
 * Resolve a preset label to its config.  Throws `Error` (not silently
 * falls back) on an unknown label so a settings-migration bug surfaces
 * loudly rather than silently downgrading the user to `safe`.
 *
 * The `PermissionPreset` union already narrows at the call site in
 * product code — this runtime check is the belt-and-braces for
 * `unknown`-typed inputs (e.g. a hand-edited `data.json`).
 */
export function getPermissionPresetConfig(
  preset: PermissionPreset
): PermissionPresetConfig {
  const cfg = PERMISSION_PRESETS[preset];
  if (!cfg) {
    throw new Error(
      `[claude-webview] unknown permission preset: ${String(preset)}`
    );
  }
  return cfg;
}

/**
 * Runtime type guard for untrusted input (e.g. saved settings loaded from
 * disk).  Use this before trusting a raw string as `PermissionPreset` —
 * pair with `Object.assign(DEFAULT_SETTINGS, loaded)` migration so a
 * malformed value falls back to the default preset rather than propagating.
 */
export function isPermissionPreset(value: unknown): value is PermissionPreset {
  return (
    typeof value === "string" &&
    (PERMISSION_PRESET_ORDER as ReadonlyArray<string>).includes(value)
  );
}
