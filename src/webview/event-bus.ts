/**
 * Lightweight pub/sub bus shared by session controller, renderers, and input bar.
 *
 * Design rules:
 * - `on()` accepts a narrow kind and a typed handler; emission is discriminated.
 * - `dispose()` clears every listener so an unmounted leaf does not leak
 *   subscriptions into the plugin lifetime.
 * - NEVER throws — a failing handler is caught and surfaced via `console.error`
 *   with the `[claude-webview]` namespace so we do not cascade into sibling
 *   handlers (error-surface-discipline).
 */
import type { StreamEvent } from "./parser/types";
import type { PermissionPreset } from "./settings-adapter";
import type { AllowedToolName } from "./session/permission-presets";

export type BusEvent =
  | { kind: "stream.event"; event: StreamEvent }
  | { kind: "session.error"; message: string }
  | { kind: "ui.send"; text: string }
  | { kind: "ui.permission-change"; preset: PermissionPreset }
  /**
   * Emitted by the allowed-tools editor (Sub-AC 4 of AC 11) whenever the
   * user changes the override list.  `override === null` means "no
   * override — fall back to the preset default" (unchecking every box or
   * clearing the text input); `effective` is the list the next spawn
   * will actually use (override when non-null, else preset default) so
   * downstream listeners (status bar, session controller) do not have to
   * re-derive it.
   */
  | {
      kind: "ui.allowed-tools-change";
      override: ReadonlyArray<AllowedToolName> | null;
      effective: ReadonlyArray<AllowedToolName>;
    };

export type BusHandler<K extends BusEvent["kind"]> = (
  event: Extract<BusEvent, { kind: K }>
) => void;

export interface Bus {
  on<K extends BusEvent["kind"]>(kind: K, handler: BusHandler<K>): void;
  emit(event: BusEvent): void;
  listenerCount(kind?: BusEvent["kind"]): number;
  dispose(): void;
}

export function createBus(): Bus {
  const handlers = new Map<BusEvent["kind"], Set<(e: BusEvent) => void>>();

  return {
    on(kind, handler) {
      let set = handlers.get(kind);
      if (!set) {
        set = new Set();
        handlers.set(kind, set);
      }
      // The narrow-handler type is widened here; the on() signature already
      // enforces that emitters pass matching shapes, and this cast is scoped
      // to the internal Set storage only.
      set.add(handler as (e: BusEvent) => void);
    },
    emit(event) {
      const set = handlers.get(event.kind);
      if (!set) return;
      for (const h of set) {
        try {
          h(event);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.error(`[claude-webview] bus handler threw on kind=${event.kind}: ${msg}`);
        }
      }
    },
    listenerCount(kind) {
      if (kind === undefined) {
        let total = 0;
        for (const set of handlers.values()) total += set.size;
        return total;
      }
      return handlers.get(kind)?.size ?? 0;
    },
    dispose() {
      for (const set of handlers.values()) set.clear();
      handlers.clear();
    },
  };
}
