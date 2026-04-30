/**
 * Webview settings schema — merged into the existing ClaudeTerminalSettings
 * via Object.assign(DEFAULT_SETTINGS, loaded) so v0.5.x users migrate with
 * zero behavior change. Defaults below preserve existing UX exactly:
 * `uiMode: "terminal"` means webview registration is skipped.
 *
 * Consumers should NOT import this file directly outside of `settings.ts`
 * and `webview/index.ts`. The fields are re-exported as part of the
 * ClaudeTerminalSettings interface in `settings.ts`.
 */

export type UiMode = "terminal" | "webview";
export type PermissionPreset = "safe" | "standard" | "full";

/**
 * Webview-specific settings added in v0.6.0.
 *
 * - `uiMode`: selects which ItemView the plugin registers. Default `"terminal"`
 *   for zero-regression opt-in.
 * - `permissionPreset`: which `--allowedTools` bundle `claude -p` is spawned
 *   with. Reflected in next spawn, not runtime-reapplied.
 * - `showDebugSystemEvents`: when true, hook_started / hook_response cards
 *   render as collapsed JSON dumps. Default false for noise reduction.
 * - `showThinking`: when true, assistant thinking blocks render with
 *   `<details open>` by default. Default false (collapsed).
 * - `lastSessionId`: persisted from the latest `result.session_id` so
 *   "Resume last" commands can `--resume <id>`. Empty string means no
 *   resume target.
 */
export interface WebviewSettings {
  uiMode: UiMode;
  permissionPreset: PermissionPreset;
  showDebugSystemEvents: boolean;
  showThinking: boolean;
  lastSessionId: string;
}

export const DEFAULT_WEBVIEW_SETTINGS: WebviewSettings = {
  uiMode: "terminal",
  permissionPreset: "standard",
  showDebugSystemEvents: false,
  showThinking: false,
  lastSessionId: "",
};
