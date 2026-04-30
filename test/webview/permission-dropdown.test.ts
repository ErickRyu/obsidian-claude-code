/**
 * Sub-AC 3 of AC 11 — permission preset dropdown UI contract.
 *
 * Proves that `buildPermissionDropdown`:
 *
 *   (a) renders exactly 3 options (Safe / Standard / Full) in canonical
 *       safety-gradient order, with labels + tooltips sourced from
 *       `PERMISSION_PRESETS`;
 *   (b) seeds the `<select>.value` from `settings.permissionPreset` so a
 *       user sees the last-saved preset after restart (persisted across
 *       sessions);
 *   (c) on `change`, mutates `settings.permissionPreset`, emits
 *       `{kind:'ui.permission-change', preset}` on the bus, and invokes
 *       the `persist` callback — in that contract order;
 *   (d) selecting the already-active preset is a no-op (no emit, no
 *       persist call) — prevents spurious re-spawns;
 *   (e) rejects foreign values via `session.error` without silently
 *       coercing (error-surface discipline);
 *   (f) a `persist()` throw is caught and surfaced on `session.error` —
 *       the dropdown never lets the failure cascade back to the DOM event
 *       loop.
 *
 * Assertion style: structural + behavioral.  No HTML snapshot, no fixture
 * replay — this is a UI-component contract test.
 */
import { describe, it, expect, vi } from "vitest";
import { Window } from "happy-dom";
import {
  buildPermissionDropdown,
  PERMISSION_DROPDOWN_CLASS,
  type PermissionDropdownSettings,
} from "../../src/webview/ui/permission-dropdown";
import { createBus, type Bus, type BusEvent } from "../../src/webview/event-bus";
import {
  PERMISSION_PRESETS,
  PERMISSION_PRESET_ORDER,
} from "../../src/webview/session/permission-presets";
import type { PermissionPreset } from "../../src/webview/settings-adapter";

interface Fixture {
  readonly window: Window;
  readonly doc: Document;
  readonly root: HTMLElement;
  readonly settings: PermissionDropdownSettings;
  readonly bus: Bus;
  readonly persist: ReturnType<typeof vi.fn>;
  readonly emitted: BusEvent[];
  readonly wrapper: HTMLElement;
  readonly select: HTMLSelectElement;
}

function setup(
  initialPreset: PermissionPreset = "standard",
  persistImpl?: () => void | Promise<void>
): Fixture {
  const window = new Window();
  const doc = window.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root as unknown as Node);

  const settings: PermissionDropdownSettings = {
    permissionPreset: initialPreset,
  };

  const bus = createBus();
  const emitted: BusEvent[] = [];
  // Spy on every emit by subscribing to every kind.
  bus.on("stream.event", (e) => emitted.push(e));
  bus.on("session.error", (e) => emitted.push(e));
  bus.on("ui.send", (e) => emitted.push(e));
  bus.on("ui.permission-change", (e) => emitted.push(e));

  const persist = vi.fn(persistImpl ?? (() => {}));

  const wrapper = buildPermissionDropdown(root, {
    settings,
    bus,
    persist,
  });

  const select = wrapper.querySelector("select") as unknown as HTMLSelectElement;

  return { window, doc, root, settings, bus, persist, emitted, wrapper, select };
}

function fireChange(select: HTMLSelectElement, value: PermissionPreset): void {
  select.value = value;
  const Event = (select.ownerDocument?.defaultView as unknown as { Event: typeof window.Event })
    .Event;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("permission-dropdown — UI contract (Sub-AC 3 of AC 11)", () => {
  describe("wrapper + structure", () => {
    it("returns an element with class claude-wv-permission-dropdown + role=group", () => {
      const { wrapper } = setup();
      expect(wrapper.classList.contains(PERMISSION_DROPDOWN_CLASS)).toBe(true);
      expect(wrapper.getAttribute("role")).toBe("group");
      expect(wrapper.getAttribute("aria-label")).toBe("Permission preset");
    });

    it("mounts into root without wiping existing children (header can host siblings)", () => {
      const window = new Window();
      const doc = window.document as unknown as Document;
      const root = doc.createElement("div");
      const priorSibling = doc.createElement("span");
      priorSibling.textContent = "prior";
      root.replaceChildren(priorSibling);

      const settings: PermissionDropdownSettings = { permissionPreset: "safe" };
      const bus = createBus();
      const persist = vi.fn();
      const wrapper = buildPermissionDropdown(root, { settings, bus, persist });

      expect(root.children.length).toBe(2);
      expect(root.children[0]).toBe(priorSibling as unknown as Element);
      expect(root.children[1]).toBe(wrapper as unknown as Element);
    });

    it("contains a <label for=...> preceding the <select id=...> (a11y linkage)", () => {
      const { wrapper, select } = setup();
      const label = wrapper.querySelector("label");
      expect(label).not.toBeNull();
      const forAttr = label?.getAttribute("for");
      expect(forAttr).toBeTruthy();
      expect(select.id).toBe(forAttr);
      // Sanity: label comes before select in DOM order.
      expect(wrapper.children[0]).toBe(label as unknown as Element);
      expect(wrapper.children[1]).toBe(select as unknown as Element);
    });
  });

  describe("options — Safe / Standard / Full from PERMISSION_PRESETS", () => {
    it("renders exactly 3 options in canonical order (safe, standard, full)", () => {
      const { select } = setup();
      const options = Array.from(select.querySelectorAll("option"));
      expect(options).toHaveLength(3);
      const values = options.map((o) => o.getAttribute("value"));
      expect(values).toEqual([...PERMISSION_PRESET_ORDER]);
    });

    it("option textContent matches PERMISSION_PRESETS[preset].label (Safe / Standard / Full)", () => {
      const { select } = setup();
      const options = Array.from(select.querySelectorAll("option"));
      expect(options[0].textContent).toBe(PERMISSION_PRESETS.safe.label);
      expect(options[1].textContent).toBe(PERMISSION_PRESETS.standard.label);
      expect(options[2].textContent).toBe(PERMISSION_PRESETS.full.label);
      // Guard against a typo that matches both the label and the value.
      expect(options[0].textContent).toBe("Safe");
      expect(options[1].textContent).toBe("Standard");
      expect(options[2].textContent).toBe("Full");
    });

    it("option title attribute carries PERMISSION_PRESETS[preset].description (tooltip)", () => {
      const { select } = setup();
      const options = Array.from(select.querySelectorAll("option"));
      for (let i = 0; i < PERMISSION_PRESET_ORDER.length; i++) {
        const preset = PERMISSION_PRESET_ORDER[i];
        const title = options[i].getAttribute("title");
        expect(title).toBe(PERMISSION_PRESETS[preset].description);
        expect(title && title.length).toBeGreaterThan(0);
      }
    });
  });

  describe("initial value — seeded from settings.permissionPreset (persisted across sessions)", () => {
    it.each(PERMISSION_PRESET_ORDER)(
      "settings.permissionPreset='%s' → select.value matches (user sees last saved choice)",
      (preset) => {
        const { select, settings } = setup(preset);
        expect(select.value).toBe(preset);
        // Exactly one option is marked `selected`, and it is the seeded one.
        const selectedOptions = Array.from(
          select.querySelectorAll("option")
        ).filter((o) => (o as unknown as HTMLOptionElement).selected);
        expect(selectedOptions).toHaveLength(1);
        expect(selectedOptions[0].getAttribute("value")).toBe(preset);
        // Settings object is NOT mutated by build (initial seed only reads).
        expect(settings.permissionPreset).toBe(preset);
      }
    );

    it("malformed settings.permissionPreset falls back to 'standard' and surfaces session.error", () => {
      const window = new Window();
      const doc = window.document as unknown as Document;
      const root = doc.createElement("div");
      const settings = {
        permissionPreset: "ultra" as unknown as PermissionPreset,
      };
      const bus = createBus();
      const errs: string[] = [];
      bus.on("session.error", (e) => errs.push(e.message));
      const persist = vi.fn();

      const wrapper = buildPermissionDropdown(root, { settings, bus, persist });
      const sel = wrapper.querySelector("select") as unknown as HTMLSelectElement;

      expect(sel.value).toBe("standard");
      expect(errs.length).toBeGreaterThan(0);
      expect(errs[0]).toMatch(/\[claude-webview\].*unknown permissionPreset/);
      expect(errs[0]).toContain("ultra");
    });
  });

  describe("change handler — settings mutation + bus emit + persist (in contract order)", () => {
    it("changing safe → full mutates settings, emits ui.permission-change with preset=full, then calls persist once", async () => {
      const { select, settings, persist, emitted } = setup("safe");
      fireChange(select, "full");

      expect(settings.permissionPreset).toBe("full");

      const permChanges = emitted.filter(
        (e) => e.kind === "ui.permission-change"
      );
      expect(permChanges).toHaveLength(1);
      expect(
        (permChanges[0] as Extract<BusEvent, { kind: "ui.permission-change" }>)
          .preset
      ).toBe("full");

      // persist is called synchronously from the handler.
      expect(persist).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["safe", "standard"],
      ["safe", "full"],
      ["standard", "safe"],
      ["standard", "full"],
      ["full", "safe"],
      ["full", "standard"],
    ] as const)(
      "every distinct transition %s → %s emits exactly one ui.permission-change",
      (from, to) => {
        const { select, settings, emitted } = setup(from);
        fireChange(select, to);
        expect(settings.permissionPreset).toBe(to);
        const permChanges = emitted.filter(
          (e) => e.kind === "ui.permission-change"
        );
        expect(permChanges).toHaveLength(1);
        expect(
          (permChanges[0] as Extract<BusEvent, { kind: "ui.permission-change" }>)
            .preset
        ).toBe(to);
      }
    );

    it("selecting the already-active preset is a no-op (no emit, no persist call)", () => {
      const { select, settings, persist, emitted } = setup("standard");
      fireChange(select, "standard");
      expect(settings.permissionPreset).toBe("standard");
      expect(persist).not.toHaveBeenCalled();
      expect(
        emitted.filter((e) => e.kind === "ui.permission-change")
      ).toHaveLength(0);
    });

    it("every change triggers a fresh persist call (subsequent changes are not coalesced)", async () => {
      const { select, persist } = setup("safe");
      fireChange(select, "standard");
      fireChange(select, "full");
      fireChange(select, "safe");
      expect(persist).toHaveBeenCalledTimes(3);
    });
  });

  describe("error-surface discipline — persist() failure", () => {
    it("synchronous persist throw is caught and surfaced on session.error (no crash)", async () => {
      const thrown = new Error("disk full");
      const { select, bus } = setup("safe", () => {
        throw thrown;
      });
      const errs: string[] = [];
      bus.on("session.error", (e) => errs.push(e.message));

      expect(() => fireChange(select, "full")).not.toThrow();
      // persistSafely runs on a microtask; drain it.
      await Promise.resolve();
      await Promise.resolve();

      expect(errs.length).toBeGreaterThan(0);
      expect(errs[0]).toMatch(/\[claude-webview\].*failed to persist/);
      expect(errs[0]).toContain("disk full");
    });

    it("async persist rejection is caught and surfaced on session.error", async () => {
      const { select, bus } = setup("safe", async () => {
        throw new Error("vault read-only");
      });
      const errs: string[] = [];
      bus.on("session.error", (e) => errs.push(e.message));

      expect(() => fireChange(select, "full")).not.toThrow();
      // Wait for the microtask to flush.
      await Promise.resolve();
      await Promise.resolve();

      expect(errs.some((m) => m.includes("vault read-only"))).toBe(true);
      expect(errs.some((m) => m.startsWith("[claude-webview]"))).toBe(true);
    });
  });

  describe("defense-in-depth — DOM tampering sets a foreign value", () => {
    it("rejects foreign <select>.value via session.error and does NOT mutate settings", () => {
      const { select, settings, persist, emitted } = setup("standard");
      // Simulate DOM tampering: force an arbitrary value through the select.
      select.value = "standard"; // baseline
      // Manually poke an unknown value — the browser would normally reject
      // this, but happy-dom accepts it; our handler must still guard.
      Object.defineProperty(select, "value", { value: "ultra", writable: true });
      const Event = (select.ownerDocument?.defaultView as unknown as {
        Event: typeof window.Event;
      }).Event;
      select.dispatchEvent(new Event("change", { bubbles: true }));

      // settings untouched (still "standard").
      expect(settings.permissionPreset).toBe("standard");
      // persist never called.
      expect(persist).not.toHaveBeenCalled();
      // session.error surfaced with the [claude-webview] namespace.
      const errs = emitted.filter((e) => e.kind === "session.error");
      expect(errs.length).toBeGreaterThan(0);
    });
  });

  describe("bus discipline — no cross-kind noise", () => {
    it("a change emits exactly one bus event of kind ui.permission-change and nothing else", () => {
      const { select, emitted } = setup("safe");
      fireChange(select, "full");
      // Only ui.permission-change should appear; no stream.event, no ui.send.
      const kinds = emitted.map((e) => e.kind);
      expect(kinds).toEqual(["ui.permission-change"]);
    });
  });
});
