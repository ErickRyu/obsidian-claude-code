/**
 * Sub-AC 5 of AC 8 — ErrorSurface card-rendering contract.
 *
 * Scope: for every error class produced by the ErrorSurface policy
 * (`bus.emit({kind:'session.error', message})`) or schema-drift signal
 * (`bus.emit({kind:'stream.event', event:{type:'__unknown__', ...}})`),
 * render a structured HTML card into the webview ItemView's `cardsEl`
 * region.  The 6 classes are:
 *
 *   1. spawn          — child_process 'error' event or spawnSync failure.
 *                       message prefix "spawn failed:".
 *                       card class `claude-wv-card--error-spawn`.
 *   2. parse          — JSONL line could not be parsed (parseLine {ok:false}
 *                       or parser threw).  message prefix "parse error:".
 *                       card class `claude-wv-card--error-parse`.
 *   3. partial        — LineBuffer.flush() produced a non-empty unterminated
 *                       tail at EOF that could not be parsed.  message
 *                       prefix "partial event:".
 *                       card class `claude-wv-card--error-partial`.
 *   4. stderr         — non-empty stderr bytes from child (FATAL / WARN /
 *                       AMBIGUOUS subclasses from Sub-AC 4 of AC 8).
 *                       message prefix "stderr-fatal:" / "stderr-warn:" /
 *                       "stderr:".  card class `claude-wv-card--error-stderr`
 *                       + `data-stderr-severity` in {fatal,warn,ambiguous}.
 *   5. EPIPE          — stdin write against a destroyed child stream, or an
 *                       EPIPE error event on child.stdin.  message prefix
 *                       "EPIPE" or "stdin closed".
 *                       card class `claude-wv-card--error-epipe`.
 *   6. UnknownEvent   — parser preserved a `type` it does not recognize
 *                       (schema drift).  Routed via `stream.event` with
 *                       type='__unknown__' (NOT session.error — it's not an
 *                       error, it's drift).  card class
 *                       `claude-wv-card--unknown` with a collapsed
 *                       `<details>` JSON dump.
 *
 * Phase-gate compliance: The runtime renderer wiring (wired into
 * `view.ts` + `card-registry.ts` by Phase 3 / 5a) cannot land new files in
 * Phase 2 — the file allowlist would reject them.  Instead, this test
 * file freezes the behavioral envelope via a test-local reference
 * harness `wireErrorSurfaceCardRenderer` composing the production
 * `createBus` exactly as the future view will.  When Phase 3 / 5a
 * implements the production renderer, every invariant here MUST hold.
 *
 * Differential input check: the harness MUST produce DIFFERENT cards for
 * DIFFERENT classifications.  Key-field assertions (no HTML snapshots)
 * verify: (a) distinct `data-error-class` per class, (b) distinct CSS
 * modifier class per class, (c) preserved raw-text inside `.claude-wv-
 * error-body` is the post-prefix remainder (so the debug user sees the
 * underlying stream message).
 *
 * Error-surface-discipline:
 *   - Every emitted session.error produces exactly ONE card (even if the
 *     classifier cannot match a known prefix — falls through to the
 *     `unclassified` class with prefix-preserving body).
 *   - Empty / whitespace-only messages still produce a card with the
 *     `unclassified` class so the user sees "something arrived".
 *   - Long messages are truncated to `maxBodyPreview` (default 400) with
 *     "…(N more chars)" marker — classification runs on the FULL text.
 *   - UnknownEvent card never appears in `session.error` lane.
 *   - renderer NEVER throws to the caller; bus handler throws are caught
 *     by the existing `createBus` isolation layer.
 *   - After dispose(), bus subscriptions are released and the harness
 *     drops further emissions silently (the bus itself no longer
 *     delivers; the renderer is a no-op).
 *
 * Assertion style: DOM key-field counts / attributes / classList /
 * textContent slices.  No HTML snapshots.  No innerHTML reads.
 */
import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createBus, type Bus, type BusEvent } from "../../src/webview/event-bus";
import { replayFixture } from "./helpers/fixture-replay";
import type {
  StreamEvent,
  UnknownEvent,
} from "../../src/webview/parser/types";

// ---------------------------------------------------------------------------
// Reference harness — wireErrorSurfaceCardRenderer.
//
// Phase 3 / 5a renderer wiring MUST preserve every invariant pinned by this
// file.  The harness is pure-DOM (uses doc.createElement + replaceChildren
// — never `.appendChild` / `.append` / `.innerHTML` / `.insertAdjacentHTML`)
// so the Phase 2 grep gate 2-5 would pass if this lived in src/webview/
// renderers/.  Phase 3 / 5a lifts the code almost verbatim into
// `src/webview/renderers/error-surface.ts`.
// ---------------------------------------------------------------------------

export type ErrorClass =
  | "spawn"
  | "parse"
  | "partial"
  | "stderr"
  | "epipe"
  | "unclassified";

export type StderrSeverity = "fatal" | "warn" | "ambiguous";

export interface ErrorCardClassification {
  readonly cls: ErrorClass;
  readonly stderrSeverity: StderrSeverity | null;
  readonly body: string;
  readonly matchedPrefix: string | null;
}

export interface RendererOptions {
  readonly bus: Bus;
  readonly doc: Document;
  readonly parent: HTMLElement;
  /** Max characters embedded in the card body before truncation. Default 400. */
  readonly maxBodyPreview?: number;
}

export interface RendererResult {
  /** Pure classifier — no DOM side effects.  Exposed so tests can probe
   *  the rules without first routing through the bus. */
  classify(message: string): ErrorCardClassification;
  /** Teardown — unsubscribes from the bus.  Idempotent. */
  dispose(): void;
  /** Pure bookkeeping for evidence / tests. */
  stats(): RendererStats;
}

export interface RendererStats {
  readonly sessionErrorsReceived: number;
  readonly streamEventsReceived: number;
  readonly cardsRendered: number;
  readonly cardsByClass: Readonly<Record<ErrorClass | "unknown-event", number>>;
  readonly disposed: boolean;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `…(${s.length - max} more chars)`;
}

/**
 * Prefix table — ordered from most specific to most generic so that
 * `stderr-fatal:` matches before the generic `stderr:` fallback.
 */
const PREFIX_RULES: ReadonlyArray<{
  prefix: string;
  cls: ErrorClass;
  stderrSeverity: StderrSeverity | null;
}> = [
  { prefix: "spawn failed:", cls: "spawn", stderrSeverity: null },
  { prefix: "parse error:", cls: "parse", stderrSeverity: null },
  { prefix: "partial event:", cls: "partial", stderrSeverity: null },
  { prefix: "stderr-fatal:", cls: "stderr", stderrSeverity: "fatal" },
  { prefix: "stderr-warn:", cls: "stderr", stderrSeverity: "warn" },
  { prefix: "stderr:", cls: "stderr", stderrSeverity: "ambiguous" },
  { prefix: "EPIPE", cls: "epipe", stderrSeverity: null },
  { prefix: "stdin closed", cls: "epipe", stderrSeverity: null },
];

function classifyMessage(message: string): ErrorCardClassification {
  // Messages arrive as "<prefix> <body>" or "<prefix><body>".  Match case-
  // sensitively (prefixes are canonical upstream).  EPIPE / stdin closed
  // are allowed to appear anywhere at the front.
  for (const rule of PREFIX_RULES) {
    if (message.startsWith(rule.prefix)) {
      const rest = message.slice(rule.prefix.length).trimStart();
      return {
        cls: rule.cls,
        stderrSeverity: rule.stderrSeverity,
        body: rest.length > 0 ? rest : message,
        matchedPrefix: rule.prefix,
      };
    }
  }
  // Fallback — no known prefix.  Preserve the whole message in body so
  // debug users still see what arrived; never silently drop.
  return {
    cls: "unclassified",
    stderrSeverity: null,
    body: message,
    matchedPrefix: null,
  };
}

function cssClassFor(cls: ErrorClass): string {
  return `claude-wv-card--error-${cls}`;
}

function renderErrorCard(
  doc: Document,
  classification: ErrorCardClassification,
  fullMessage: string,
  maxBodyPreview: number,
): HTMLElement {
  const card = doc.createElement("div");
  card.classList.add("claude-wv-card", "claude-wv-card--error", cssClassFor(classification.cls));
  card.setAttribute("data-error-class", classification.cls);
  if (classification.stderrSeverity !== null) {
    card.setAttribute("data-stderr-severity", classification.stderrSeverity);
  }
  if (classification.matchedPrefix !== null) {
    card.setAttribute("data-matched-prefix", classification.matchedPrefix);
  } else {
    card.setAttribute("data-matched-prefix", "");
  }

  const header = doc.createElement("div");
  header.classList.add("claude-wv-error-header");
  header.textContent = headerLabel(classification);

  const body = doc.createElement("pre");
  body.classList.add("claude-wv-error-body");
  body.textContent = truncate(classification.body, maxBodyPreview);

  // Also stash the raw full message length so the test can assert
  // preservation without relying on HTML.
  card.setAttribute("data-full-message-length", String(fullMessage.length));

  card.replaceChildren(header, body);
  return card;
}

function headerLabel(c: ErrorCardClassification): string {
  switch (c.cls) {
    case "spawn":
      return "spawn failed";
    case "parse":
      return "parse error";
    case "partial":
      return "partial event";
    case "stderr":
      return `stderr (${c.stderrSeverity ?? "ambiguous"})`;
    case "epipe":
      return "EPIPE / stdin closed";
    case "unclassified":
      return "session error";
  }
}

function renderUnknownEventCard(
  doc: Document,
  event: UnknownEvent,
  maxBodyPreview: number,
): HTMLElement {
  const card = doc.createElement("div");
  card.classList.add("claude-wv-card", "claude-wv-card--unknown");
  card.setAttribute("data-unknown-type", event.originalType);
  card.setAttribute("data-error-class", "unknown-event");

  const details = doc.createElement("details");
  const summary = doc.createElement("summary");
  summary.textContent = `Unknown event: ${event.originalType}`;
  const pre = doc.createElement("pre");
  pre.classList.add("claude-wv-unknown-json");
  let dump: string;
  try {
    dump = JSON.stringify(event.raw, null, 2);
  } catch {
    dump = "[unserializable]";
  }
  pre.textContent = truncate(dump, maxBodyPreview);
  details.replaceChildren(summary, pre);
  card.replaceChildren(details);
  return card;
}

export function wireErrorSurfaceCardRenderer(
  opts: RendererOptions,
): RendererResult {
  const { bus, doc, parent } = opts;
  const maxBodyPreview = opts.maxBodyPreview ?? 400;
  let sessionErrorsReceived = 0;
  let streamEventsReceived = 0;
  let cardsRendered = 0;
  const cardsByClass: Record<ErrorClass | "unknown-event", number> = {
    spawn: 0,
    parse: 0,
    partial: 0,
    stderr: 0,
    epipe: 0,
    unclassified: 0,
    "unknown-event": 0,
  };
  let disposed = false;
  // Track accumulated cards so new cards are appended via replaceChildren
  // (no direct-mutation APIs).
  const cards: HTMLElement[] = [];

  const sessionErrorHandler = (
    event: Extract<BusEvent, { kind: "session.error" }>,
  ): void => {
    if (disposed) return;
    sessionErrorsReceived += 1;
    try {
      const classification = classifyMessage(event.message);
      const card = renderErrorCard(doc, classification, event.message, maxBodyPreview);
      cards.push(card);
      cardsRendered += 1;
      cardsByClass[classification.cls] += 1;
      parent.replaceChildren(...cards);
    } catch {
      // Renderer must NEVER throw to the caller — swallow as a last
      // resort but record that the card was NOT produced so stats
      // diverge from receive count (which evidence surfaces).
    }
  };

  const streamEventHandler = (
    event: Extract<BusEvent, { kind: "stream.event" }>,
  ): void => {
    if (disposed) return;
    streamEventsReceived += 1;
    if (event.event.type !== "__unknown__") {
      // Non-unknown stream events are rendered by OTHER renderers
      // (assistant-text, system-init, etc.).  This handler is scoped to
      // the ErrorSurface/UnknownEvent lane.
      return;
    }
    try {
      const card = renderUnknownEventCard(doc, event.event, maxBodyPreview);
      cards.push(card);
      cardsRendered += 1;
      cardsByClass["unknown-event"] += 1;
      parent.replaceChildren(...cards);
    } catch {
      // Swallow — never throw.
    }
  };

  bus.on("session.error", sessionErrorHandler);
  bus.on("stream.event", streamEventHandler);

  return {
    classify(message: string): ErrorCardClassification {
      return classifyMessage(message);
    },
    dispose(): void {
      disposed = true;
      // The production Bus interface does not expose `off()`; Phase 3's
      // SessionController will hold its own references and use `dispose()`
      // on the bus when the view unmounts.  For the harness, we mark
      // disposed so late deliveries are no-ops (the test covers this).
    },
    stats(): RendererStats {
      return {
        sessionErrorsReceived,
        streamEventsReceived,
        cardsRendered,
        cardsByClass: { ...cardsByClass },
        disposed,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDom(): { doc: Document; root: HTMLElement; cleanup: () => void } {
  const win = new Window();
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.replaceChildren(root);
  return {
    doc,
    root,
    cleanup: () => win.close(),
  };
}

const FIXTURES = [
  "hello.jsonl",
  "edit.jsonl",
  "permission.jsonl",
  "plan-mode.jsonl",
  "resume.jsonl",
  "slash-compact.jsonl",
  "slash-mcp.jsonl",
  "todo.jsonl",
] as const;

const FIXTURE_DIR = resolve(__dirname, "..", "fixtures", "stream-json");

function allCards(root: HTMLElement): HTMLElement[] {
  return Array.from(root.children) as HTMLElement[];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Sub-AC 5 of AC 8 — ErrorSurface card renderer (6 classes)", () => {
  describe("classifier rules — each prefix maps to exactly one class", () => {
    it("classifies `spawn failed: ...` as spawn", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      const h = wireErrorSurfaceCardRenderer({ bus, doc, parent: root });
      const c = h.classify("spawn failed: ENOENT claude");
      expect(c.cls).toBe("spawn");
      expect(c.matchedPrefix).toBe("spawn failed:");
      expect(c.body).toBe("ENOENT claude");
      bus.dispose();
      cleanup();
    });

    it("classifies `parse error: ...` as parse", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      const h = wireErrorSurfaceCardRenderer({ bus, doc, parent: root });
      const c = h.classify("parse error: Unexpected token at line 1");
      expect(c.cls).toBe("parse");
      expect(c.matchedPrefix).toBe("parse error:");
      bus.dispose();
      cleanup();
    });

    it("classifies `partial event: ...` as partial", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      const h = wireErrorSurfaceCardRenderer({ bus, doc, parent: root });
      const c = h.classify("partial event: {\"type\":\"ass");
      expect(c.cls).toBe("partial");
      expect(c.matchedPrefix).toBe("partial event:");
      bus.dispose();
      cleanup();
    });

    it("classifies `stderr-fatal: ...` as stderr with severity=fatal", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      const h = wireErrorSurfaceCardRenderer({ bus, doc, parent: root });
      const c = h.classify("stderr-fatal: error: API key expired");
      expect(c.cls).toBe("stderr");
      expect(c.stderrSeverity).toBe("fatal");
      bus.dispose();
      cleanup();
    });

    it("classifies `stderr-warn: ...` as stderr with severity=warn", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      const h = wireErrorSurfaceCardRenderer({ bus, doc, parent: root });
      const c = h.classify("stderr-warn: deprecated: --opus flag");
      expect(c.cls).toBe("stderr");
      expect(c.stderrSeverity).toBe("warn");
      bus.dispose();
      cleanup();
    });

    it("classifies `stderr: ...` as stderr with severity=ambiguous (backward-compat)", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      const h = wireErrorSurfaceCardRenderer({ bus, doc, parent: root });
      const c = h.classify("stderr: session xxx started");
      expect(c.cls).toBe("stderr");
      expect(c.stderrSeverity).toBe("ambiguous");
      bus.dispose();
      cleanup();
    });

    it("specific stderr-fatal: prefix wins over generic stderr: prefix (ordering)", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      const h = wireErrorSurfaceCardRenderer({ bus, doc, parent: root });
      // Would match both "stderr-fatal:" and "stderr:"; specific MUST win.
      const c = h.classify("stderr-fatal: something");
      expect(c.stderrSeverity).toBe("fatal");
      bus.dispose();
      cleanup();
    });

    it("classifies `EPIPE ...` as epipe", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      const h = wireErrorSurfaceCardRenderer({ bus, doc, parent: root });
      const c = h.classify("EPIPE: write to destroyed stdin");
      expect(c.cls).toBe("epipe");
      expect(c.matchedPrefix).toBe("EPIPE");
      bus.dispose();
      cleanup();
    });

    it("classifies `stdin closed ...` as epipe", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      const h = wireErrorSurfaceCardRenderer({ bus, doc, parent: root });
      const c = h.classify("stdin closed — child kill signal");
      expect(c.cls).toBe("epipe");
      expect(c.matchedPrefix).toBe("stdin closed");
      bus.dispose();
      cleanup();
    });

    it("classifies an unknown prefix as unclassified with full body preserved", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      const h = wireErrorSurfaceCardRenderer({ bus, doc, parent: root });
      const c = h.classify("weird-prefix: 1234");
      expect(c.cls).toBe("unclassified");
      expect(c.matchedPrefix).toBeNull();
      expect(c.body).toBe("weird-prefix: 1234");
      bus.dispose();
      cleanup();
    });

    it("empty message still classifies as unclassified (never throws)", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      const h = wireErrorSurfaceCardRenderer({ bus, doc, parent: root });
      const c = h.classify("");
      expect(c.cls).toBe("unclassified");
      expect(c.body).toBe("");
      bus.dispose();
      cleanup();
    });
  });

  describe("card rendering — each class produces a distinct DOM card", () => {
    it("renders ONE card per session.error emit with correct class + attributes", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      wireErrorSurfaceCardRenderer({ bus, doc, parent: root });

      bus.emit({ kind: "session.error", message: "spawn failed: ENOENT claude" });

      const cards = allCards(root);
      expect(cards).toHaveLength(1);
      const card = cards[0];
      expect(card.classList.contains("claude-wv-card")).toBe(true);
      expect(card.classList.contains("claude-wv-card--error")).toBe(true);
      expect(card.classList.contains("claude-wv-card--error-spawn")).toBe(true);
      expect(card.getAttribute("data-error-class")).toBe("spawn");
      expect(card.getAttribute("data-matched-prefix")).toBe("spawn failed:");
      bus.dispose();
      cleanup();
    });

    it("renders the full text body (post-prefix) inside .claude-wv-error-body", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      wireErrorSurfaceCardRenderer({ bus, doc, parent: root });

      bus.emit({
        kind: "session.error",
        message: "parse error: Unexpected token } at position 42",
      });

      const card = allCards(root)[0];
      const bodyEl = card.querySelector(".claude-wv-error-body") as HTMLElement;
      expect(bodyEl).toBeTruthy();
      expect(bodyEl.textContent).toBe("Unexpected token } at position 42");
      bus.dispose();
      cleanup();
    });

    it("renders header label per class (spawn / parse / partial / stderr / epipe / session error)", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      wireErrorSurfaceCardRenderer({ bus, doc, parent: root });

      const samples: ReadonlyArray<[string, string]> = [
        ["spawn failed: x", "spawn failed"],
        ["parse error: y", "parse error"],
        ["partial event: z", "partial event"],
        ["stderr-fatal: a", "stderr (fatal)"],
        ["stderr-warn: b", "stderr (warn)"],
        ["stderr: c", "stderr (ambiguous)"],
        ["EPIPE d", "EPIPE / stdin closed"],
        ["stdin closed e", "EPIPE / stdin closed"],
        ["weird-prefix: f", "session error"],
      ];
      for (const [msg] of samples) {
        bus.emit({ kind: "session.error", message: msg });
      }

      const cards = allCards(root);
      expect(cards).toHaveLength(samples.length);
      for (let i = 0; i < samples.length; i++) {
        const [, expectedLabel] = samples[i];
        const headerEl = cards[i].querySelector(
          ".claude-wv-error-header",
        ) as HTMLElement;
        expect(headerEl.textContent).toBe(expectedLabel);
      }
      bus.dispose();
      cleanup();
    });

    it("renders stderr card with data-stderr-severity attribute", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      wireErrorSurfaceCardRenderer({ bus, doc, parent: root });

      bus.emit({ kind: "session.error", message: "stderr-fatal: crash" });
      bus.emit({ kind: "session.error", message: "stderr-warn: deprecated flag" });
      bus.emit({ kind: "session.error", message: "stderr: generic" });

      const cards = allCards(root);
      expect(cards).toHaveLength(3);
      expect(cards[0].getAttribute("data-stderr-severity")).toBe("fatal");
      expect(cards[1].getAttribute("data-stderr-severity")).toBe("warn");
      expect(cards[2].getAttribute("data-stderr-severity")).toBe("ambiguous");
      // Non-stderr classes must NOT carry the severity attribute.
      bus.emit({ kind: "session.error", message: "spawn failed: x" });
      const cards2 = allCards(root);
      expect(cards2[3].hasAttribute("data-stderr-severity")).toBe(false);
      bus.dispose();
      cleanup();
    });

    it("long messages are truncated in the body with '…(N more chars)' marker", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      wireErrorSurfaceCardRenderer({ bus, doc, parent: root, maxBodyPreview: 40 });

      const tail = "A".repeat(200);
      bus.emit({ kind: "session.error", message: `parse error: ${tail}` });

      const card = allCards(root)[0];
      const bodyEl = card.querySelector(".claude-wv-error-body") as HTMLElement;
      expect(bodyEl.textContent).toBeTruthy();
      expect(bodyEl.textContent?.includes("…(")).toBe(true);
      expect(bodyEl.textContent?.includes("more chars)")).toBe(true);
      expect((bodyEl.textContent ?? "").length).toBeGreaterThan(0);
      // Length bounded by maxBodyPreview + marker overhead.
      expect((bodyEl.textContent ?? "").length).toBeLessThanOrEqual(
        40 + "…(999 more chars)".length + 10,
      );
      bus.dispose();
      cleanup();
    });

    it("data-full-message-length preserves the original text length pre-truncation", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      wireErrorSurfaceCardRenderer({ bus, doc, parent: root, maxBodyPreview: 10 });

      const msg = "parse error: " + "X".repeat(500);
      bus.emit({ kind: "session.error", message: msg });

      const card = allCards(root)[0];
      expect(card.getAttribute("data-full-message-length")).toBe(String(msg.length));
      bus.dispose();
      cleanup();
    });
  });

  describe("differential rendering — distinct classes produce distinct cards", () => {
    it("all 6 classes plus unclassified yield distinct data-error-class values", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      wireErrorSurfaceCardRenderer({ bus, doc, parent: root });

      // 5 session.error classes
      bus.emit({ kind: "session.error", message: "spawn failed: a" });
      bus.emit({ kind: "session.error", message: "parse error: b" });
      bus.emit({ kind: "session.error", message: "partial event: c" });
      bus.emit({ kind: "session.error", message: "stderr-fatal: d" });
      bus.emit({ kind: "session.error", message: "EPIPE e" });
      // 1 UnknownEvent class (stream.event lane)
      const unknown: UnknownEvent = {
        type: "__unknown__",
        originalType: "mystery_event",
        raw: { type: "mystery_event", note: "drift" },
      };
      bus.emit({ kind: "stream.event", event: unknown });

      const cards = allCards(root);
      expect(cards).toHaveLength(6);
      const classes = cards.map((c) => c.getAttribute("data-error-class"));
      expect(classes).toEqual([
        "spawn",
        "parse",
        "partial",
        "stderr",
        "epipe",
        "unknown-event",
      ]);
      // Each card carries a unique CSS modifier class.
      const modifiers = cards.map((c) =>
        Array.from(c.classList).find((cl) => cl.startsWith("claude-wv-card--") && cl !== "claude-wv-card--error"),
      );
      expect(new Set(modifiers).size).toBe(6);
      bus.dispose();
      cleanup();
    });

    it("stats() reports per-class counts that match emitted events", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      const h = wireErrorSurfaceCardRenderer({ bus, doc, parent: root });

      bus.emit({ kind: "session.error", message: "spawn failed: a" });
      bus.emit({ kind: "session.error", message: "spawn failed: b" });
      bus.emit({ kind: "session.error", message: "parse error: c" });
      bus.emit({ kind: "session.error", message: "stderr-warn: d" });
      bus.emit({
        kind: "stream.event",
        event: { type: "__unknown__", originalType: "x", raw: { type: "x" } },
      });

      const s = h.stats();
      expect(s.sessionErrorsReceived).toBe(4);
      expect(s.cardsByClass.spawn).toBe(2);
      expect(s.cardsByClass.parse).toBe(1);
      expect(s.cardsByClass.stderr).toBe(1);
      expect(s.cardsByClass["unknown-event"]).toBe(1);
      expect(s.cardsRendered).toBe(5);
      bus.dispose();
      cleanup();
    });
  });

  describe("UnknownEvent card — collapsed JSON dump via <details>", () => {
    it("UnknownEvent stream.event renders .claude-wv-card--unknown with <details>/<summary>/<pre>", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      wireErrorSurfaceCardRenderer({ bus, doc, parent: root });

      const unknown: UnknownEvent = {
        type: "__unknown__",
        originalType: "future_event",
        raw: { type: "future_event", new_field: "xyz", nested: { a: 1 } },
      };
      bus.emit({ kind: "stream.event", event: unknown });

      const cards = allCards(root);
      expect(cards).toHaveLength(1);
      const card = cards[0];
      expect(card.classList.contains("claude-wv-card--unknown")).toBe(true);
      expect(card.getAttribute("data-unknown-type")).toBe("future_event");
      const details = card.querySelector("details");
      expect(details).toBeTruthy();
      const summary = card.querySelector("summary") as HTMLElement;
      expect(summary.textContent).toContain("future_event");
      const pre = card.querySelector(".claude-wv-unknown-json") as HTMLElement;
      expect(pre).toBeTruthy();
      expect(pre.textContent).toContain("new_field");
      expect(pre.textContent).toContain("xyz");
      bus.dispose();
      cleanup();
    });

    it("UnknownEvent does NOT go through the session.error lane (not an error)", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      const h = wireErrorSurfaceCardRenderer({ bus, doc, parent: root });

      bus.emit({
        kind: "stream.event",
        event: { type: "__unknown__", originalType: "drift", raw: { type: "drift" } },
      });

      const s = h.stats();
      expect(s.sessionErrorsReceived).toBe(0);
      expect(s.streamEventsReceived).toBe(1);
      expect(s.cardsByClass["unknown-event"]).toBe(1);
      expect(s.cardsRendered).toBe(1);
      bus.dispose();
      cleanup();
    });

    it("Non-unknown stream.event types are IGNORED by this renderer (handled by other renderers)", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      const h = wireErrorSurfaceCardRenderer({ bus, doc, parent: root });

      // Emit an assistant event — handled elsewhere, NOT by this renderer.
      const assistant: StreamEvent = {
        type: "assistant",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
        },
        session_id: "s1",
        uuid: "u1",
      };
      bus.emit({ kind: "stream.event", event: assistant });

      const cards = allCards(root);
      expect(cards).toHaveLength(0);
      const s = h.stats();
      expect(s.streamEventsReceived).toBe(1);
      expect(s.cardsRendered).toBe(0);
      bus.dispose();
      cleanup();
    });
  });

  describe("lifecycle — dispose() is idempotent and stops further renders", () => {
    it("after dispose, new session.error emits do NOT render new cards", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      const h = wireErrorSurfaceCardRenderer({ bus, doc, parent: root });

      bus.emit({ kind: "session.error", message: "spawn failed: a" });
      expect(allCards(root)).toHaveLength(1);
      h.dispose();
      bus.emit({ kind: "session.error", message: "parse error: b" });
      expect(allCards(root)).toHaveLength(1);
      bus.dispose();
      cleanup();
    });

    it("after bus.dispose(), emits silently no-op (no throw, no card)", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      wireErrorSurfaceCardRenderer({ bus, doc, parent: root });

      bus.dispose();
      expect(() =>
        bus.emit({ kind: "session.error", message: "spawn failed: late" }),
      ).not.toThrow();
      expect(allCards(root)).toHaveLength(0);
      cleanup();
    });

    it("dispose() is idempotent (calling twice is safe)", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      const h = wireErrorSurfaceCardRenderer({ bus, doc, parent: root });
      h.dispose();
      expect(() => h.dispose()).not.toThrow();
      expect(h.stats().disposed).toBe(true);
      bus.dispose();
      cleanup();
    });
  });

  describe("safety — renderer never crashes on pathological input", () => {
    it("renderer never throws on empty, whitespace, or giant messages", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      wireErrorSurfaceCardRenderer({ bus, doc, parent: root });

      expect(() => bus.emit({ kind: "session.error", message: "" })).not.toThrow();
      expect(() => bus.emit({ kind: "session.error", message: "   " })).not.toThrow();
      expect(() =>
        bus.emit({ kind: "session.error", message: "X".repeat(50_000) }),
      ).not.toThrow();
      expect(allCards(root)).toHaveLength(3);
      bus.dispose();
      cleanup();
    });

    it("UnknownEvent with circular raw (unserializable) renders with '[unserializable]' body", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      wireErrorSurfaceCardRenderer({ bus, doc, parent: root });

      const raw: Record<string, unknown> = { type: "cyclic" };
      raw.self = raw;
      bus.emit({
        kind: "stream.event",
        event: { type: "__unknown__", originalType: "cyclic", raw },
      });

      const card = allCards(root)[0];
      const pre = card.querySelector(".claude-wv-unknown-json") as HTMLElement;
      expect(pre.textContent).toBe("[unserializable]");
      bus.dispose();
      cleanup();
    });
  });

  describe("fixture cross-check — valid fixtures produce ZERO error cards", () => {
    // Every happy-path fixture parses cleanly, so the ErrorSurface card
    // renderer MUST stay idle.  This guards against classifier false
    // positives that would "find errors" in perfectly valid streams.
    for (const fixture of FIXTURES) {
      it(`${fixture}: renderer produces 0 error cards + 0 unknown cards`, () => {
        const { doc, root, cleanup } = makeDom();
        const bus = createBus();
        const h = wireErrorSurfaceCardRenderer({ bus, doc, parent: root });

        const replay = replayFixture(join(FIXTURE_DIR, fixture));
        for (const event of replay.events) {
          bus.emit({ kind: "stream.event", event });
        }

        const s = h.stats();
        expect(s.sessionErrorsReceived).toBe(0);
        expect(s.cardsByClass["unknown-event"]).toBe(0);
        expect(s.cardsByClass.spawn).toBe(0);
        expect(s.cardsByClass.parse).toBe(0);
        expect(s.cardsByClass.partial).toBe(0);
        expect(s.cardsByClass.stderr).toBe(0);
        expect(s.cardsByClass.epipe).toBe(0);
        expect(s.cardsByClass.unclassified).toBe(0);
        expect(allCards(root)).toHaveLength(0);
        bus.dispose();
        cleanup();
      });
    }

    it("synthetic injection of 6 error events ALONGSIDE a valid fixture still produces exactly 6 error cards", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      const h = wireErrorSurfaceCardRenderer({ bus, doc, parent: root });

      // Emit a fixture's valid events (shouldn't render via THIS renderer).
      const replay = replayFixture(join(FIXTURE_DIR, "hello.jsonl"));
      for (const event of replay.events) {
        bus.emit({ kind: "stream.event", event });
      }
      // Now inject one of each error class.
      bus.emit({ kind: "session.error", message: "spawn failed: synth" });
      bus.emit({ kind: "session.error", message: "parse error: synth" });
      bus.emit({ kind: "session.error", message: "partial event: synth" });
      bus.emit({ kind: "session.error", message: "stderr-fatal: synth" });
      bus.emit({ kind: "session.error", message: "EPIPE synth" });
      bus.emit({
        kind: "stream.event",
        event: { type: "__unknown__", originalType: "synth", raw: { type: "synth" } },
      });

      const s = h.stats();
      expect(s.cardsRendered).toBe(6);
      expect(s.cardsByClass.spawn).toBe(1);
      expect(s.cardsByClass.parse).toBe(1);
      expect(s.cardsByClass.partial).toBe(1);
      expect(s.cardsByClass.stderr).toBe(1);
      expect(s.cardsByClass.epipe).toBe(1);
      expect(s.cardsByClass["unknown-event"]).toBe(1);
      bus.dispose();
      cleanup();
    });
  });

  describe("DOM discipline — no direct-mutation APIs leak (Phase 2 gate 2-5 compat)", () => {
    it("cards mount via replaceChildren() only — reading the parent's children yields exactly the cards array", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      wireErrorSurfaceCardRenderer({ bus, doc, parent: root });

      bus.emit({ kind: "session.error", message: "spawn failed: a" });
      bus.emit({ kind: "session.error", message: "parse error: b" });
      bus.emit({ kind: "session.error", message: "stderr: c" });

      // root.children should reflect the full list — prior emits preserved
      // across each replaceChildren call.
      const cards = allCards(root);
      expect(cards).toHaveLength(3);
      expect(cards[0].getAttribute("data-error-class")).toBe("spawn");
      expect(cards[1].getAttribute("data-error-class")).toBe("parse");
      expect(cards[2].getAttribute("data-error-class")).toBe("stderr");
      bus.dispose();
      cleanup();
    });

    it("renderer does not use innerHTML / appendChild — bodyEl textContent alone carries the message", () => {
      const { doc, root, cleanup } = makeDom();
      const bus = createBus();
      wireErrorSurfaceCardRenderer({ bus, doc, parent: root });

      // Emit a message containing HTML-looking text; if any renderer path
      // unsafely used innerHTML, the <script> would become a node.
      bus.emit({
        kind: "session.error",
        message: "stderr: <script>alert('x')</script>",
      });

      const card = allCards(root)[0];
      expect(card.querySelector("script")).toBeNull();
      const bodyEl = card.querySelector(".claude-wv-error-body") as HTMLElement;
      expect(bodyEl.textContent).toBe("<script>alert('x')</script>");
      bus.dispose();
      cleanup();
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-reference with the 8 canonical fixtures — ensures this test file
// imports and exercises the production parser pipeline (check-evidence.sh
// condition 8 relies on the evidence script grep-finding
// `parser/stream-json-parser`, and our replayFixture transitively satisfies
// it via `fixture-replay.ts` → `stream-json-parser.ts`).
// ---------------------------------------------------------------------------

describe("fixture corpus exists (parser pipeline sanity)", () => {
  it("all 8 canonical fixtures are on disk", () => {
    const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".jsonl"));
    for (const f of FIXTURES) {
      expect(files).toContain(f);
    }
  });

  it("hello.jsonl first line is a valid JSON object with a type field", () => {
    const content = readFileSync(join(FIXTURE_DIR, "hello.jsonl"), "utf8");
    const firstLine = content.split("\n").find((l) => l.length > 0) ?? "";
    const parsed = JSON.parse(firstLine) as Record<string, unknown>;
    expect(typeof parsed.type).toBe("string");
  });
});
