/**
 * Sub-AC 3 of AC 1 — MH-07 / MH-08 / MH-09 foundation readiness +
 * Phase 4a/4b/5a result event handling + error/stderr surfacing +
 * coexistence via uiMode switching.
 *
 * Context: MH-07/08/09 are phase-gated (Phase 5a/3/4b respectively) and the
 * current worktree is at Phase 2.  This test suite locks the FOUNDATION
 * contracts those phases will build on, so downstream iterations can extend
 * the runtime without touching the parser/settings/bus surface.
 *
 * Coverage:
 *   1. MH-07 readiness — `system:hook_started` / `system:hook_response`
 *      events parse into the typed SystemEvent discriminated union (not
 *      UnknownEvent) AND the `showDebugSystemEvents` setting defaults to
 *      `false`.  The card-registry dispatch key for hooks is reachable so
 *      Phase 5a's hook-hide logic can attach a handler.
 *   2. MH-08 readiness — `ui.send` is part of the BusEvent type union and
 *      round-trips through the bus; `session.error` lane exists for stderr
 *      surfacing; wiring for the webview-open command exists in
 *      `wireWebview` (Phase 3 will register the input-bar textarea against
 *      the same bus).
 *   3. MH-09 readiness — `permissionPreset` defaults to `"standard"`, the
 *      3 preset labels exist at the type level, and `permission.jsonl` +
 *      `plan-mode.jsonl` + `hello.jsonl` fixtures exhibit DIFFERENT
 *      `permissionMode` strings so the runtime can differentiate presets
 *      downstream.
 *   4. Phase 4a/4b/5a result event handling — `renderResult` exposes
 *      `data-is-error="true"` for `ResultEvent.is_error === true`
 *      (resume.jsonl) AND absent on happy path (hello.jsonl); the dispatch
 *      key for system:compact_boundary (Phase 5a) is derivable from the
 *      parser output without any custom code.
 *   5. Error/stderr surfacing — bus handler failures NEVER cascade; a
 *      failing handler is logged to `console.error` with `[claude-webview]`
 *      namespace and sibling handlers still run; UnknownEvent never throws
 *      in the parser — the collapsed-JSON fallback card handles it.
 *   6. Coexistence via uiMode switching — `wireWebview` stays a no-op when
 *      `uiMode === "terminal"`; registration only happens in the "webview"
 *      branch; console namespaces (`[claude-webview]`) do not leak into the
 *      terminal-view source files.
 *
 * Assertion style: key-field parser/state checks + DOM attribute checks on
 * already-landed renderers (result + system-init + user-tool-result).  No
 * HTML snapshots.  Fixture file bytes are referenced only indirectly through
 * `replayFixture` + the existing sha256 cross-validation in evidence JSON.
 */
import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import { Window } from "happy-dom";
import { Plugin } from "obsidian";
import {
  replayFixture,
  eventCountByType,
} from "./helpers/fixture-replay";
import { parseLine } from "../../src/webview/parser/stream-json-parser";
import { createBus, type BusEvent } from "../../src/webview/event-bus";
import {
  DEFAULT_WEBVIEW_SETTINGS,
  type PermissionPreset,
} from "../../src/webview/settings-adapter";
import { createRegistry, eventKey } from "../../src/webview/renderers/card-registry";
import {
  createResultState,
  renderResult,
} from "../../src/webview/renderers/result";
import {
  createSystemInitState,
  renderSystemInit,
} from "../../src/webview/renderers/system-init";
import {
  createUserToolResultState,
  renderUserToolResult,
} from "../../src/webview/renderers/user-tool-result";
import { createActivityGroupState } from "../../src/webview/renderers/activity-group";
import { wireWebview, type WebviewPluginHost } from "../../src/webview";
import { VIEW_TYPE_CLAUDE_WEBVIEW, COMMAND_OPEN_WEBVIEW } from "../../src/constants";
import type {
  ResultEvent,
  StreamEvent,
  SystemHookStartedEvent,
  SystemHookResponseEvent,
  SystemInitEvent,
  SystemCompactBoundaryEvent,
  UserEvent,
  ToolResultBlock,
} from "../../src/webview/parser/types";

const FIXTURE_DIR = path.resolve(__dirname, "..", "fixtures", "stream-json");

function makeDoc(): { doc: Document; parent: HTMLElement } {
  const window = new Window();
  const doc = window.document as unknown as Document;
  const parent = doc.createElement("div");
  (doc.body as unknown as HTMLElement).replaceChildren(parent);
  return { doc, parent };
}

function isHookStarted(ev: StreamEvent): ev is SystemHookStartedEvent {
  return ev.type === "system" && ev.subtype === "hook_started";
}

function isHookResponse(ev: StreamEvent): ev is SystemHookResponseEvent {
  return ev.type === "system" && ev.subtype === "hook_response";
}

function isSystemInit(ev: StreamEvent): ev is SystemInitEvent {
  return ev.type === "system" && ev.subtype === "init";
}

function isCompactBoundary(ev: StreamEvent): ev is SystemCompactBoundaryEvent {
  return ev.type === "system" && ev.subtype === "compact_boundary";
}

function isResult(ev: StreamEvent): ev is ResultEvent {
  return ev.type === "result";
}

function isUser(ev: StreamEvent): ev is UserEvent {
  return ev.type === "user";
}

describe("Sub-AC 3 of AC 1 — MH-07/MH-08/MH-09 readiness + error/stderr + uiMode switching", () => {
  describe("MH-07 readiness — system:hook_* parsing + showDebugSystemEvents default", () => {
    it("parses hook_started / hook_response into typed SystemEvent (not UnknownEvent)", () => {
      // hello.jsonl is the smallest fixture that contains hook events — its
      // presence confirms the parser's SystemEvent discriminated union covers
      // the hook subtypes without falling through to UnknownEvent.
      const replay = replayFixture(path.join(FIXTURE_DIR, "hello.jsonl"));
      expect(replay.rawSkipped).toBe(0);
      expect(replay.unknownEventCount).toBe(0);

      const started = replay.events.filter(isHookStarted);
      const response = replay.events.filter(isHookResponse);
      expect(started.length).toBeGreaterThanOrEqual(1);
      expect(response.length).toBeGreaterThanOrEqual(1);

      // Spot-check a typed field only available if parseLine populated the
      // discriminated union: `hook_name` on SystemHookStartedEvent.
      for (const h of started) {
        expect(typeof h.hook_name).toBe("string");
        expect(h.hook_name.length).toBeGreaterThan(0);
        expect(typeof h.session_id).toBe("string");
      }
      for (const h of response) {
        expect(typeof h.hook_name).toBe("string");
        // hook_response is allowed to have a missing outcome/output, but
        // hook_name stays required — differential vs hook_started.
        expect(h.hook_event.length).toBeGreaterThan(0);
      }
    });

    it("DEFAULT_WEBVIEW_SETTINGS.showDebugSystemEvents === false (hooks hidden by default)", () => {
      expect(DEFAULT_WEBVIEW_SETTINGS.showDebugSystemEvents).toBe(false);
    });

    it("card-registry dispatch key for hooks is addressable (phase 5a can register a handler)", () => {
      // Phase 5a will attach `system:hook_started` / `system:hook_response`
      // handlers to this registry.  The only thing we can lock right now is
      // that `eventKey(event)` returns the `system:<subtype>` form.
      const { doc, parent } = makeDoc();
      const registry = createRegistry({
        doc,
        cardsEl: parent,
        state: { cards: [], messageCards: new Map() },
      });
      const replay = replayFixture(path.join(FIXTURE_DIR, "hello.jsonl"));
      const hs = replay.events.filter(isHookStarted)[0];
      expect(eventKey(hs)).toBe("system:hook_started");

      // Register a handler; dispatch must route to it (not the unknown
      // fallback).  This is the hook Phase 5a will register its hide/debug
      // gating logic in.
      let handlerRan = false;
      registry.register("system:hook_started", () => {
        handlerRan = true;
      });
      registry.dispatch(hs);
      expect(handlerRan).toBe(true);
    });

    it("differential — slash-compact.jsonl contains extra system subtypes (status + compact_boundary) the other fixtures do not", () => {
      const sc = replayFixture(path.join(FIXTURE_DIR, "slash-compact.jsonl"));
      const counts = eventCountByType(sc.events);
      // slash-compact.jsonl is the only fixture with status + compact_boundary
      // system events; that guarantees Phase 5a handlers will have meaningful
      // differential coverage when they land.
      const compact = sc.events.filter(isCompactBoundary);
      expect(compact.length).toBeGreaterThanOrEqual(1);

      // status events are NOT typed with a dedicated narrow-guard here, but
      // they're in the union — eventKey("system:status") is derivable.
      const hasStatus = sc.events.some(
        (e) => e.type === "system" && (e as { subtype: string }).subtype === "status",
      );
      expect(hasStatus).toBe(true);

      // hello.jsonl must NOT have compact_boundary (differential).
      const hello = replayFixture(path.join(FIXTURE_DIR, "hello.jsonl"));
      expect(hello.events.filter(isCompactBoundary).length).toBe(0);
    });
  });

  describe("MH-08 readiness — bus ui.send + session.error lanes + open-webview command wiring", () => {
    it("bus accepts ui.send and delivers to matching handler (input-bar → controller wiring contract)", () => {
      const bus = createBus();
      const received: string[] = [];
      bus.on("ui.send", (ev) => {
        received.push(ev.text);
      });
      bus.emit({ kind: "ui.send", text: "hello from textarea" });
      expect(received).toEqual(["hello from textarea"]);
      bus.dispose();
      expect(bus.listenerCount()).toBe(0);
    });

    it("bus exposes session.error lane for stderr/EPIPE/spawn-fail surfacing", () => {
      const bus = createBus();
      const errors: string[] = [];
      bus.on("session.error", (ev) => {
        errors.push(ev.message);
      });
      bus.emit({ kind: "session.error", message: "claude CLI exited 127 (not found)" });
      expect(errors).toEqual(["claude CLI exited 127 (not found)"]);
      bus.dispose();
    });

    it("stream.event lane round-trips a parsed StreamEvent without losing the discriminated union", () => {
      const bus = createBus();
      const replay = replayFixture(path.join(FIXTURE_DIR, "hello.jsonl"));
      const init = replay.events.find(isSystemInit);
      expect(init).toBeDefined();

      let capturedType: string | null = null;
      let capturedSubtype: string | null = null;
      bus.on("stream.event", (ev) => {
        capturedType = ev.event.type;
        if (ev.event.type === "system") {
          capturedSubtype = ev.event.subtype;
        }
      });
      bus.emit({ kind: "stream.event", event: init as StreamEvent });
      expect(capturedType).toBe("system");
      expect(capturedSubtype).toBe("init");
      bus.dispose();
    });

    it("wireWebview registers COMMAND_OPEN_WEBVIEW (surface Phase 3 input-bar command can extend)", () => {
      // We only assert that the command id is a stable string in the webview
      // namespace that Phase 3 can piggyback on; no runtime registration is
      // performed here (that lives in `coexistence.test.ts`).
      expect(COMMAND_OPEN_WEBVIEW).toBe("claude-webview:open");
      expect(COMMAND_OPEN_WEBVIEW.startsWith("claude-webview:")).toBe(true);
    });
  });

  describe("MH-09 readiness — permissionPreset default + 3-label surface + fixture differential", () => {
    it("DEFAULT_WEBVIEW_SETTINGS.permissionPreset === 'standard'", () => {
      expect(DEFAULT_WEBVIEW_SETTINGS.permissionPreset).toBe("standard");
    });

    it("PermissionPreset union spans exactly 3 labels (safe / standard / full)", () => {
      // Compile-time check via exhaustive assignment — if the union loses a
      // label this test fails to compile BEFORE runtime.  The runtime array
      // mirrors the union so Phase 4b's dropdown has a stable source list.
      const labels: ReadonlyArray<PermissionPreset> = ["safe", "standard", "full"];
      for (const l of labels) {
        const _ok: PermissionPreset = l;
        void _ok;
      }
      expect(labels).toEqual(["safe", "standard", "full"]);
    });

    it("differential — permission.jsonl / hello.jsonl / plan-mode.jsonl expose 3 DISTINCT permissionMode strings", () => {
      // This proves Phase 4b's dropdown change won't be masked by fixture
      // homogeneity — each preset maps to a different system.init.permissionMode
      // signal that the header card already surfaces via system-init.ts.
      const modes = new Map<string, string>();
      for (const fx of ["hello.jsonl", "permission.jsonl", "plan-mode.jsonl"]) {
        const r = replayFixture(path.join(FIXTURE_DIR, fx));
        const init = r.events.find(isSystemInit);
        expect(init).toBeDefined();
        modes.set(fx, (init as SystemInitEvent).permissionMode ?? "");
      }
      const values = Array.from(modes.values());
      expect(new Set(values).size).toBe(3);
      expect(values).toContain("acceptEdits");
      expect(values).toContain("default");
      expect(values).toContain("plan");
    });

    it("renderSystemInit surfaces permissionMode into the permission row (Phase 4b drop-down ↔ header feedback loop)", () => {
      const { doc, parent } = makeDoc();
      const state = createSystemInitState();

      const r = replayFixture(path.join(FIXTURE_DIR, "permission.jsonl"));
      const init = r.events.find(isSystemInit);
      expect(init).toBeDefined();
      const card = renderSystemInit(state, parent, init as SystemInitEvent, doc);

      const rows = card.querySelectorAll(".claude-wv-kv-row");
      let permissionRow: string | null = null;
      for (const row of Array.from(rows)) {
        const k = row.querySelector(".claude-wv-kv-key")?.textContent ?? "";
        if (k === "permission") {
          permissionRow = row.querySelector(".claude-wv-kv-value")?.textContent ?? "";
        }
      }
      expect(permissionRow).toBe("default");
    });
  });

  describe("Phase 4a/4b/5a — result event handling + error attribute surfacing", () => {
    it("resume.jsonl → data-is-error='true' on the rendered result card (error surface visible)", () => {
      const { doc, parent } = makeDoc();
      const state = createResultState();
      const r = replayFixture(path.join(FIXTURE_DIR, "resume.jsonl"));
      const result = r.events.find(isResult);
      expect(result).toBeDefined();
      const card = renderResult(state, parent, result as ResultEvent, doc);
      expect(card.getAttribute("data-is-error")).toBe("true");
      expect(card.getAttribute("data-subtype")).toBe("error_during_execution");
    });

    it("hello.jsonl (happy path) → data-is-error attribute is absent on the rendered result card", () => {
      const { doc, parent } = makeDoc();
      const state = createResultState();
      const r = replayFixture(path.join(FIXTURE_DIR, "hello.jsonl"));
      const result = r.events.find(isResult);
      expect(result).toBeDefined();
      const card = renderResult(state, parent, result as ResultEvent, doc);
      expect(card.hasAttribute("data-is-error")).toBe(false);
    });

    it("plan-mode.jsonl → user.tool_result with is_error=true lands as data-is-error='true' on the correlated card", () => {
      const { doc, parent } = makeDoc();
      const state = createUserToolResultState();
      const groupState = createActivityGroupState();
      const r = replayFixture(path.join(FIXTURE_DIR, "plan-mode.jsonl"));
      for (const ue of r.events.filter(isUser)) {
        renderUserToolResult(state, groupState, parent, ue, doc);
      }
      // No matching tool-line in this isolated render — error result lands
      // as a fallback card carrying data-is-error.
      const errCards = parent.querySelectorAll(
        '.claude-wv-card--user-tool-result[data-is-error="true"]',
      );
      expect(errCards.length).toBeGreaterThanOrEqual(1);

      // Differential: hello.jsonl renders 0 error tool_result cards.
      const { doc: dH, parent: pH } = makeDoc();
      const stateH = createUserToolResultState();
      const groupStateH = createActivityGroupState();
      const rH = replayFixture(path.join(FIXTURE_DIR, "hello.jsonl"));
      for (const ue of rH.events.filter(isUser)) {
        renderUserToolResult(stateH, groupStateH, pH, ue, dH);
      }
      const helloErrCards = pH.querySelectorAll(
        '.claude-wv-card--user-tool-result[data-is-error="true"]',
      );
      expect(helloErrCards.length).toBe(0);
    });

    it("unknown top-level type → UnknownEvent wrapper (parser never throws, renderer shows collapsed JSON)", () => {
      const res = parseLine(
        JSON.stringify({ type: "future_schema_drift", foo: "bar" }),
      );
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("parser failed unexpectedly");
      expect(res.event.type).toBe("__unknown__");
      if (res.event.type !== "__unknown__") {
        throw new Error("not an unknown event");
      }
      expect(res.event.originalType).toBe("future_schema_drift");
      expect(res.event.raw).toBeDefined();
      expect(res.event.raw.foo).toBe("bar");

      // Dispatch through the registry WITHOUT registering a handler — the
      // default unknown handler must render a collapsed JSON card.
      const { doc, parent } = makeDoc();
      const registry = createRegistry({
        doc,
        cardsEl: parent,
        state: { cards: [], messageCards: new Map() },
      });
      registry.dispatch(res.event);
      const unknownCards = parent.querySelectorAll(".claude-wv-card--unknown");
      expect(unknownCards.length).toBe(1);
      expect(unknownCards[0].getAttribute("data-unknown-type")).toBe(
        "future_schema_drift",
      );
      const details = unknownCards[0].querySelector("details");
      expect(details).not.toBeNull();
      const pre = unknownCards[0].querySelector(".claude-wv-unknown-json");
      expect(pre?.textContent ?? "").toContain("future_schema_drift");
    });

    it("malformed JSONL line → parser returns {ok:false} without throwing (rawSkipped lane)", () => {
      // This is the "parse error" class from the error-surface-discipline
      // principle: invalid JSON must be captured as rawSkipped, never thrown.
      const cases = [
        "",
        "not json",
        "{unbalanced",
        '"just a string"',
        "123",
        "null",
      ];
      for (const c of cases) {
        expect(() => parseLine(c)).not.toThrow();
        const res = parseLine(c);
        expect(res.ok).toBe(false);
      }
    });
  });

  describe("Error/stderr surface discipline — bus isolation + namespace logging", () => {
    it("bus handler exception does NOT cascade into sibling handlers and is logged under [claude-webview]", () => {
      const bus = createBus();
      const sibling: string[] = [];
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        bus.on("session.error", () => {
          throw new Error("boom in handler A");
        });
        bus.on("session.error", (ev) => {
          sibling.push(ev.message);
        });
        bus.emit({ kind: "session.error", message: "downstream still runs" });
      } finally {
        const errLogs = errSpy.mock.calls.map((c) => String(c[0]));
        errSpy.mockRestore();
        expect(sibling).toEqual(["downstream still runs"]);
        // Namespace guard — failed handler must tag the log with the webview
        // prefix so the terminal view's log stream stays clean.
        expect(errLogs.some((l) => l.startsWith("[claude-webview]"))).toBe(true);
      }
      bus.dispose();
    });

    it("wireWebview no-op (uiMode='terminal') tags its skip log with [claude-webview] not [claude-terminal]", () => {
      const plugin = new Plugin() as unknown as WebviewPluginHost;
      plugin.settings = { uiMode: "terminal" };
      plugin.registerView = vi.fn() as unknown as Plugin["registerView"];
      plugin.addCommand = vi.fn(((cmd: unknown) => cmd)) as unknown as Plugin["addCommand"];
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        wireWebview(plugin);
        const logs = logSpy.mock.calls.map((c) => String(c[0]));
        expect(logs.some((l) => l.startsWith("[claude-webview]"))).toBe(true);
        expect(logs.some((l) => l.startsWith("[claude-terminal]"))).toBe(false);
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  describe("Coexistence via uiMode switching — terminal default + webview opt-in", () => {
    it("uiMode='terminal' → wireWebview registers no views and no commands (zero regression)", () => {
      const plugin = new Plugin() as unknown as WebviewPluginHost;
      plugin.settings = { uiMode: "terminal" };
      const registeredViews: string[] = [];
      const registeredCommands: string[] = [];
      plugin.registerView = vi.fn((t: string) => {
        registeredViews.push(t);
      }) as unknown as Plugin["registerView"];
      plugin.addCommand = vi.fn((cmd: { id: string }) => {
        registeredCommands.push(cmd.id);
        return cmd as unknown as ReturnType<Plugin["addCommand"]>;
      }) as unknown as Plugin["addCommand"];
      wireWebview(plugin);
      expect(registeredViews).toEqual([]);
      expect(registeredCommands).toEqual([]);
    });

    it("uiMode='webview' → wireWebview registers VIEW_TYPE_CLAUDE_WEBVIEW + COMMAND_OPEN_WEBVIEW (+ resume command in Phase 5a)", () => {
      const plugin = new Plugin() as unknown as WebviewPluginHost;
      plugin.settings = { uiMode: "webview" };
      const registeredViews: string[] = [];
      const registeredCommands: string[] = [];
      plugin.registerView = vi.fn((t: string) => {
        registeredViews.push(t);
      }) as unknown as Plugin["registerView"];
      plugin.addCommand = vi.fn((cmd: { id: string }) => {
        registeredCommands.push(cmd.id);
        return cmd as unknown as ReturnType<Plugin["addCommand"]>;
      }) as unknown as Plugin["addCommand"];
      wireWebview(plugin);
      expect(registeredViews).toEqual([VIEW_TYPE_CLAUDE_WEBVIEW]);
      // Phase 5a adds a second "resume last" command. The MH-07/08/09
      // readiness contract only requires COMMAND_OPEN_WEBVIEW to survive —
      // assert contains instead of exact equality so Phase 5b can add more.
      expect(registeredCommands).toContain(COMMAND_OPEN_WEBVIEW);
      expect(registeredCommands.length).toBeGreaterThanOrEqual(1);
    });
  });
});
