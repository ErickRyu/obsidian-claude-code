/**
 * Webview spawn-args assembler — Sub-AC 2 of AC 11.
 *
 * Translates the user's active `PermissionPreset` (from settings) into the
 * concrete `--allowedTools` + `--permission-mode` CLI flags that
 * `child_process.spawn(claude -p ...)` will receive in Phase 3's session
 * controller.  This module is the single place where preset config becomes
 * CLI argv — both `session-controller.ts` (runtime spawn) and Phase 4b's
 * `ui/permission-dropdown.ts` (preview / status bar hint) import from here,
 * so the flags shown to the user in the UI cannot drift from the flags
 * actually passed to the child process.
 *
 * Design rules:
 *
 * - **Preset → flags, single source of truth**: the preset label drives both
 *   `--allowedTools` and `--permission-mode` via `permission-presets.ts`.
 *   A settings change to `permissionPreset` is fully reflected in the NEXT
 *   spawn — no mid-session re-apply in the Beta.
 * - **Custom override escape hatch**: callers may pass explicit
 *   `allowedToolsOverride` / `permissionModeOverride` for a one-off spawn
 *   without mutating persistent settings.  When provided, they REPLACE (not
 *   extend) the preset's values.  This shape lets Phase 4b's dropdown
 *   optionally expose an advanced "custom" row without requiring a
 *   schema change here later.
 * - **Pure / DOM-free / Node-free**: no imports from `obsidian` or `node:*`.
 *   Pure string manipulation so vitest can exercise it under happy-dom and
 *   the evidence script can import it without the obsidian shim.
 * - **Deterministic argv order**: flags always come out in the same order
 *   regardless of object-key iteration, so snapshot-style differential tests
 *   (MH-09) stay stable across Node versions.
 * - **Double-flag form for CLI robustness**: we emit `--flag value` (two
 *   argv entries) rather than `--flag=value` because `claude -p` parses
 *   both but the former is what `docs/webview-spike/run-samples.sh.reference`
 *   settled on, and Phase 5b's smoke test already uses that shape.
 * - **Named export only**: `buildSpawnArgs` is a named export (no default)
 *   so Phase 3's dynamic-import callers (`const {buildSpawnArgs} = await
 *   import("./spawn-args")`) and test-time re-imports stay stable.
 * - **Error-surface discipline**: an unknown preset string surfaces via
 *   `getPermissionPresetConfig`'s explicit `throw` — NO silent fallback
 *   to "safe".  A malformed settings file must fail loudly so the user
 *   sees the `[claude-webview]` namespace in the error.
 *
 * File allowlist: this module is Phase 3's `session/spawn-args.ts` slot in
 * `scripts/check-allowlist.sh`.  It is introduced earlier than Phase 3's
 * tag only as the preset→CLI integration contract (Sub-AC 2 of AC 11);
 * the runtime `SessionController` that consumes it still lands in Phase 3.
 */
import {
  getPermissionPresetConfig,
  type AllowedToolName,
  type PermissionModeValue,
  type PermissionPresetConfig,
} from "./permission-presets";
import type { PermissionPreset } from "../settings-adapter";

/**
 * Minimum settings surface `buildSpawnArgs` reads.  Deliberately narrower
 * than `ClaudeTerminalSettings` so tests can construct a fixture without
 * pulling the full Obsidian-coupled settings shape through the import
 * graph.  The production `SessionController` passes
 * `this.plugin.settings` directly — structural typing means any settings
 * object carrying these fields is accepted.
 */
export interface SpawnArgsSettings {
  /** Absolute or PATH-relative path to the `claude` binary. */
  readonly claudePath: string;
  /** Active permission preset label driving --allowedTools + --permission-mode. */
  readonly permissionPreset: PermissionPreset;
  /**
   * Free-form extra CLI args the user typed in the "Extra CLI arguments"
   * settings field.  Split on ASCII whitespace; empty string → no extra
   * args.  Quote-aware parsing is deliberately NOT implemented in the
   * Beta — users needing spaces-in-values should rely on
   * `allowedToolsOverride` instead.
   */
  readonly extraArgs: string;
}

/**
 * Per-spawn options that override or augment the settings-derived config.
 * All fields are optional — in the common case the caller passes
 * `{}` (or omits the argument) and the preset alone drives the flags.
 */
export interface SpawnArgsOptions {
  /**
   * When set, `--resume <resumeId>` is appended.  Empty string is treated
   * the same as `undefined` (no resume).  `buildSpawnArgs` validates the
   * UUID shape (8-4-4-4-12 hex) via `UUID_RE` and throws on malformed
   * input — defense-in-depth against settings-file tampering.
   */
  readonly resumeId?: string;
  /**
   * When set, `--mcp-config <path>` is appended.  Used by Phase 5a when
   * the user opts in to the plugin's MCP bridge; no-op in the Beta when
   * MCP is routed through the legacy terminal instead.
   */
  readonly mcpConfigPath?: string;
  /**
   * Explicit override for `--allowedTools`.  REPLACES (not extends) the
   * preset's tool list.  Passing `[]` produces `--allowedTools ""` (an
   * empty allow-list — Claude will prompt for every tool).  Phase 4b's
   * advanced "custom" dropdown row will populate this field.
   */
  readonly allowedToolsOverride?: ReadonlyArray<AllowedToolName>;
  /**
   * Explicit override for `--permission-mode`.  REPLACES the preset's
   * permission-mode string.  Mirrors `allowedToolsOverride` semantics.
   */
  readonly permissionModeOverride?: PermissionModeValue;
}

/**
 * Result of `buildSpawnArgs`.  `args` is the argv array to pass directly
 * to `child_process.spawn(cmd, args, ...)` — NOT a shell string.  The
 * `effective*` fields are echoed back so the UI (Phase 4b status bar +
 * evidence / debug logs) can display the same strings the child will
 * actually see, without re-parsing argv.
 */
export interface BuiltSpawnArgs {
  readonly cmd: string;
  readonly args: string[];
  readonly effectivePreset: PermissionPreset;
  readonly effectivePermissionMode: PermissionModeValue;
  readonly effectiveAllowedTools: ReadonlyArray<AllowedToolName>;
  /** True when the user / caller passed explicit overrides — surfaced by
   *  Phase 4b's dropdown so the "custom" label is shown instead of the
   *  preset's canonical label.  False in the common preset-only case. */
  readonly isCustom: boolean;
}

/**
 * Canonical base argv — present on EVERY spawn regardless of preset.  These
 * flags are what the webview foundation depends on:
 *
 *   `-p`                         — non-interactive (print) mode
 *   `--output-format stream-json` — JSONL on stdout (parser contract)
 *   `--input-format stream-json`  — JSONL on stdin (input-bar contract)
 *   `--verbose`                  — include system.init + hook_* events
 *   `--include-partial-messages` — streaming assistant text
 *
 * Kept as a frozen tuple so test-time assertions can use array equality
 * against this constant without worrying about callers mutating it.
 */
export const BASE_SPAWN_ARGS: ReadonlyArray<string> = Object.freeze([
  "-p",
  "--output-format",
  "stream-json",
  "--input-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
]);

/**
 * Resolve the effective preset config and compute overrides.  Extracted
 * from `buildSpawnArgs` so tests can cover the override-merge branch
 * independently of argv assembly.
 */
function resolveEffectiveConfig(
  settings: SpawnArgsSettings,
  options: SpawnArgsOptions
): {
  presetCfg: PermissionPresetConfig;
  effectivePermissionMode: PermissionModeValue;
  effectiveAllowedTools: ReadonlyArray<AllowedToolName>;
  isCustom: boolean;
} {
  const presetCfg = getPermissionPresetConfig(settings.permissionPreset);
  const hasToolsOverride = options.allowedToolsOverride !== undefined;
  const hasModeOverride = options.permissionModeOverride !== undefined;
  const effectivePermissionMode: PermissionModeValue =
    options.permissionModeOverride ?? presetCfg.permissionMode;
  const effectiveAllowedTools: ReadonlyArray<AllowedToolName> =
    options.allowedToolsOverride ?? presetCfg.allowedTools;
  return {
    presetCfg,
    effectivePermissionMode,
    effectiveAllowedTools,
    isCustom: hasToolsOverride || hasModeOverride,
  };
}

/**
 * Tokens a user may NOT include in `extraArgs` — they would subvert the
 * preset-driven permission flags that precede them in argv.  `claude -p`
 * honors the last occurrence per flag, so allowing the user to append
 * `--permission-mode bypassPermissions` in extraArgs would silently
 * escalate Safe → Full.  Matching is case-sensitive on the exact flag
 * token; values that follow (e.g. `bypassPermissions`) are allowed so
 * a lone word like `verbose` still works.
 */
const FORBIDDEN_EXTRA_ARG_FLAGS: ReadonlySet<string> = new Set([
  "--permission-mode",
  "--allowedTools",
  "--allowed-tools",
  "--mcp-config",
  "--resume",
  "--dangerously-skip-permissions",
]);

/**
 * UUID pattern `claude -p` emits via `system.init.session_id`.  Format is
 * the canonical lowercase 8-4-4-4-12 hex; we accept either case so a
 * user's clipboard copy-paste of an uppercase value still resumes.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Split the free-form `extraArgs` field on ASCII whitespace and reject any
 * token that matches `FORBIDDEN_EXTRA_ARG_FLAGS`.  This is the
 * defense-in-depth gate for the preset → argv contract: a value the user
 * typed in settings cannot relocate `--permission-mode` or `--allowedTools`
 * to a later argv position that the CLI's last-wins parsing would honor.
 */
function splitExtraArgsValidated(raw: string): string[] {
  if (!raw || raw.trim().length === 0) return [];
  const tokens = raw.trim().split(/\s+/).filter((s) => s.length > 0);
  for (const t of tokens) {
    if (FORBIDDEN_EXTRA_ARG_FLAGS.has(t)) {
      throw new Error(
        `[claude-webview] extraArgs rejected: "${t}" may only be set via permission preset / structured options, not via the free-form Extra CLI arguments field.`,
      );
    }
  }
  return tokens;
}

/**
 * Assemble the full `(cmd, args)` pair for `child_process.spawn`.
 *
 * Argv layout (deterministic order — tests depend on it):
 *
 *   [ ...BASE_SPAWN_ARGS,
 *     "--permission-mode", <mode>,
 *     "--allowedTools",    <toolsCommaJoined>,
 *     ("--mcp-config" <path>)?,
 *     ("--resume" <id>)?,
 *     ...splitExtraArgs(settings.extraArgs)
 *   ]
 *
 * The permission flags come BEFORE optional flags so a naive `args.slice(
 * 0, N)` prefix check in tests stays meaningful across feature additions.
 */
export function buildSpawnArgs(
  settings: SpawnArgsSettings,
  options: SpawnArgsOptions = {}
): BuiltSpawnArgs {
  const resolved = resolveEffectiveConfig(settings, options);
  const args: string[] = [...BASE_SPAWN_ARGS];

  // --permission-mode <mode>
  args.push("--permission-mode", resolved.effectivePermissionMode);

  // --allowedTools <Read,Edit,...>
  // Join with comma (no spaces) — claude -p accepts comma-separated or
  // repeated flag forms; comma-join keeps argv compact.  An empty
  // override yields an empty string, which Claude treats as "prompt for
  // every tool" — same as --permission-mode=default.
  args.push("--allowedTools", resolved.effectiveAllowedTools.join(","));

  // --mcp-config <path> (optional).  Defense-in-depth: must be absolute so a
  // working-directory-relative path cannot resolve into an unexpected vault
  // location.  The caller (view.ts) is responsible for resolving the value
  // against the plugin's data dir before passing it in.
  if (options.mcpConfigPath && options.mcpConfigPath.length > 0) {
    if (!options.mcpConfigPath.startsWith("/")) {
      throw new Error(
        `[claude-webview] mcpConfigPath must be absolute (received "${options.mcpConfigPath}").`,
      );
    }
    args.push("--mcp-config", options.mcpConfigPath);
  }

  // --resume <id> (optional; empty string treated as absent).  Validate the
  // UUID shape before it reaches argv — argv-array spawn prevents shell
  // injection, but rejecting malformed ids early surfaces user errors in
  // the webview instead of as an opaque CLI failure.
  if (options.resumeId && options.resumeId.length > 0) {
    if (!UUID_RE.test(options.resumeId)) {
      throw new Error(
        `[claude-webview] resumeId must be a UUID (received "${options.resumeId}").`,
      );
    }
    args.push("--resume", options.resumeId);
  }

  // ...extraArgs (free-form user input, last so user can override anything
  // earlier in argv — claude -p honors the last occurrence per flag).
  // Validated against FORBIDDEN_EXTRA_ARG_FLAGS to prevent a user from
  // escalating Safe → Full via `--permission-mode bypassPermissions`.
  const extras = splitExtraArgsValidated(settings.extraArgs);
  if (extras.length > 0) args.push(...extras);

  return {
    cmd: settings.claudePath,
    args,
    effectivePreset: settings.permissionPreset,
    effectivePermissionMode: resolved.effectivePermissionMode,
    effectiveAllowedTools: resolved.effectiveAllowedTools,
    isCustom: resolved.isCustom,
  };
}
