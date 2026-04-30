/**
 * Sub-AC 4 of AC 11 — allowed-tools editor UI contract.
 *
 * Proves that `buildAllowedToolsEditor`:
 *
 *   (a) renders a `<fieldset>` wrapper with role=group + aria-label +
 *       the canonical class and a `<legend>` label;
 *   (b) renders exactly `ALLOWED_TOOL_NAMES.length` checkboxes in
 *       canonical order, each with a matching `<label for>` wired via
 *       the `claude-wv-tool-<ToolName>` id prefix;
 *   (c) seeds the checkboxes + text input + effective label from the
 *       preset default when `state.override === null`;
 *   (d) seeds from the override (not preset) when `state.override`
 *       is a non-empty array, and surfaces "(custom)" in the effective
 *       label;
 *   (e) on checkbox toggle, mutates `state.override`, updates the text
 *       input + effective label, emits exactly one
 *       `ui.allowed-tools-change` with the new override + recomputed
 *       effective, and calls `persist` once;
 *   (f) toggling back to match the preset default exactly → override
 *       collapses to `null` (no spurious isCustom=true);
 *   (g) entering a valid csv into the text input + firing Enter /
 *       change commits the same way as checkboxes;
 *   (h) entering invalid tokens ("Reed") surfaces `session.error`
 *       with the `[claude-webview]` namespace, keeps the valid tokens,
 *       and drops the invalid ones;
 *   (i) a `ui.permission-change` bus event refreshes the effective
 *       label (override-less case) without clobbering an explicit
 *       user override;
 *   (j) `persist()` throw / rejection is caught + surfaced on
 *       `session.error`;
 *   (k) `parseAllowedToolsOverride` pure helper contract
 *       (dedup, whitespace tolerance, case-sensitivity).
 *
 * Style: structural + behavioral.  No HTML snapshot, no fixture
 * replay — this is a UI-component contract test.  Complements Sub-AC
 * 2 of AC 11's spawn-args test by proving the UI actually produces
 * the `allowedToolsOverride` shape that argv assembly consumes.
 */
import { describe, it, expect, vi } from "vitest";
import { Window } from "happy-dom";
import {
  buildAllowedToolsEditor,
  parseAllowedToolsOverride,
  computeEffectiveAllowedTools,
  ALLOWED_TOOLS_EDITOR_CLASS,
  ALLOWED_TOOLS_EDITOR_EFFECTIVE_CLASS,
  ALLOWED_TOOLS_EDITOR_INPUT_CLASS,
  ALLOWED_TOOLS_EDITOR_CHECKBOX_CLASS,
  ALLOWED_TOOLS_EDITOR_CHECKBOX_ID_PREFIX,
  type AllowedToolsEditorSettings,
  type AllowedToolsOverrideState,
} from "../../src/webview/ui/allowed-tools-editor";
import { createBus, type Bus, type BusEvent } from "../../src/webview/event-bus";
import {
  ALLOWED_TOOL_NAMES,
  PERMISSION_PRESETS,
  type AllowedToolName,
} from "../../src/webview/session/permission-presets";
import type { PermissionPreset } from "../../src/webview/settings-adapter";

interface Fixture {
  readonly window: Window;
  readonly doc: Document;
  readonly root: HTMLElement;
  readonly settings: AllowedToolsEditorSettings;
  readonly state: AllowedToolsOverrideState;
  readonly bus: Bus;
  readonly persist: ReturnType<typeof vi.fn>;
  readonly emitted: BusEvent[];
  readonly wrapper: HTMLElement;
  readonly checkboxes: HTMLInputElement[];
  readonly textInput: HTMLInputElement;
  readonly effectiveEl: HTMLElement;
}

function setup(opts?: {
  preset?: PermissionPreset;
  initialOverride?: ReadonlyArray<AllowedToolName> | null;
  persistImpl?: () => void | Promise<void>;
}): Fixture {
  const preset: PermissionPreset = opts?.preset ?? "standard";
  const window = new Window();
  const doc = window.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root as unknown as Node);

  const settings: AllowedToolsEditorSettings = { permissionPreset: preset };
  const state: AllowedToolsOverrideState = {
    override: opts?.initialOverride ?? null,
  };

  const bus = createBus();
  const emitted: BusEvent[] = [];
  bus.on("stream.event", (e) => emitted.push(e));
  bus.on("session.error", (e) => emitted.push(e));
  bus.on("ui.send", (e) => emitted.push(e));
  bus.on("ui.permission-change", (e) => emitted.push(e));
  bus.on("ui.allowed-tools-change", (e) => emitted.push(e));

  const persist = vi.fn(opts?.persistImpl ?? (() => {}));

  const wrapper = buildAllowedToolsEditor(root, {
    settings,
    state,
    bus,
    persist,
  });

  const checkboxes = Array.from(
    wrapper.querySelectorAll<HTMLInputElement>(
      `.${ALLOWED_TOOLS_EDITOR_CHECKBOX_CLASS}`
    )
  );
  const textInput = wrapper.querySelector<HTMLInputElement>(
    `.${ALLOWED_TOOLS_EDITOR_INPUT_CLASS}`
  ) as HTMLInputElement;
  const effectiveEl = wrapper.querySelector<HTMLElement>(
    `.${ALLOWED_TOOLS_EDITOR_EFFECTIVE_CLASS}`
  ) as HTMLElement;

  return {
    window,
    doc,
    root,
    settings,
    state,
    bus,
    persist,
    emitted,
    wrapper,
    checkboxes,
    textInput,
    effectiveEl,
  };
}

function fireChange(el: HTMLElement): void {
  const Event = (el.ownerDocument?.defaultView as unknown as {
    Event: typeof window.Event;
  }).Event;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function fireEnter(el: HTMLElement): void {
  const win = el.ownerDocument?.defaultView as unknown as {
    KeyboardEvent: typeof window.KeyboardEvent;
  };
  el.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true })
  );
}

describe("allowed-tools editor — UI contract (Sub-AC 4 of AC 11)", () => {
  describe("wrapper + structure", () => {
    it("returns a <fieldset> wrapper with the canonical class + role=group + aria-label", () => {
      const { wrapper } = setup();
      expect(wrapper.tagName.toUpperCase()).toBe("FIELDSET");
      expect(wrapper.classList.contains(ALLOWED_TOOLS_EDITOR_CLASS)).toBe(true);
      expect(wrapper.getAttribute("role")).toBe("group");
      expect(wrapper.getAttribute("aria-label")).toBe("Allowed tools editor");
    });

    it("first child is a <legend> with the prompt label", () => {
      const { wrapper } = setup();
      const legend = wrapper.querySelector("legend");
      expect(legend).not.toBeNull();
      expect(legend?.textContent).toContain("Allowed tools");
    });

    it("mounts into root without wiping existing siblings", () => {
      const window = new Window();
      const doc = window.document as unknown as Document;
      const root = doc.createElement("div");
      const prior = doc.createElement("span");
      prior.textContent = "prior";
      root.replaceChildren(prior);

      const bus = createBus();
      const wrapper = buildAllowedToolsEditor(root, {
        settings: { permissionPreset: "safe" },
        state: { override: null },
        bus,
        persist: () => {},
      });

      expect(root.children.length).toBe(2);
      expect(root.children[0]).toBe(prior as unknown as Element);
      expect(root.children[1]).toBe(wrapper as unknown as Element);
    });

    it("renders exactly ALLOWED_TOOL_NAMES.length checkboxes in canonical order with matching id/label pairs", () => {
      const { checkboxes, wrapper } = setup();
      expect(checkboxes).toHaveLength(ALLOWED_TOOL_NAMES.length);
      for (let i = 0; i < ALLOWED_TOOL_NAMES.length; i++) {
        const tool = ALLOWED_TOOL_NAMES[i];
        const cb = checkboxes[i];
        expect(cb.getAttribute("data-tool")).toBe(tool);
        expect(cb.id).toBe(`${ALLOWED_TOOLS_EDITOR_CHECKBOX_ID_PREFIX}${tool}`);
        const labelEl = wrapper.querySelector<HTMLLabelElement>(
          `label[for="${cb.id}"]`
        );
        expect(labelEl).not.toBeNull();
        expect(labelEl?.textContent).toBe(tool);
      }
    });

    it("renders a text input + effective-label span with a11y live region", () => {
      const { textInput, effectiveEl } = setup();
      expect(textInput).not.toBeNull();
      expect(textInput.getAttribute("type")).toBe("text");
      expect(effectiveEl).not.toBeNull();
      expect(effectiveEl.getAttribute("aria-live")).toBe("polite");
    });
  });

  describe("initial seeding from state + preset", () => {
    it.each([
      ["safe"],
      ["standard"],
      ["full"],
    ] as const)(
      "override === null + preset=%s → checkboxes match preset default, text input empty, effective label shows preset",
      (preset) => {
        const { checkboxes, textInput, effectiveEl, emitted } = setup({
          preset,
        });
        const cfg = PERMISSION_PRESETS[preset];
        const presetSet = new Set<string>(cfg.allowedTools);
        for (const cb of checkboxes) {
          const tool = cb.getAttribute("data-tool") ?? "";
          expect(cb.checked).toBe(presetSet.has(tool));
        }
        expect(textInput.value).toBe("");
        expect(effectiveEl.textContent).toContain(`${preset} preset`);
        expect(effectiveEl.getAttribute("data-source")).toBe(
          `${preset} preset`
        );
        expect(effectiveEl.getAttribute("data-effective")).toBe(
          [...cfg.allowedTools].join(", ")
        );
        // No emits during build — initial seed is passive.
        expect(emitted).toHaveLength(0);
      }
    );

    it("non-empty override → checkboxes reflect override, text input shows csv, effective source='custom'", () => {
      const initialOverride: AllowedToolName[] = ["Read", "Bash"];
      const { checkboxes, textInput, effectiveEl } = setup({
        preset: "safe",
        initialOverride,
      });
      const checked = checkboxes
        .filter((c) => c.checked)
        .map((c) => c.getAttribute("data-tool"));
      expect(new Set(checked)).toEqual(new Set(["Read", "Bash"]));
      expect(textInput.value).toBe("Read,Bash");
      expect(effectiveEl.getAttribute("data-source")).toBe("custom");
      expect(effectiveEl.getAttribute("data-effective")).toBe("Read, Bash");
      expect(effectiveEl.textContent).toContain("custom");
    });

    it("initial override with an unknown tool name is cleaned + surfaces session.error", () => {
      const window = new Window();
      const doc = window.document as unknown as Document;
      const root = doc.createElement("div");
      const state = {
        override: ["Read", "Mystery" as unknown as AllowedToolName],
      };
      const bus = createBus();
      const errs: string[] = [];
      bus.on("session.error", (e) => errs.push(e.message));

      buildAllowedToolsEditor(root, {
        settings: { permissionPreset: "standard" },
        state: state as AllowedToolsOverrideState,
        bus,
        persist: () => {},
      });

      expect(state.override).toEqual(["Read"]);
      expect(errs.length).toBeGreaterThan(0);
      expect(errs[0]).toMatch(/\[claude-webview\]/);
      expect(errs[0]).toMatch(/Mystery/);
    });
  });

  describe("checkbox toggle → state mutation + bus emit + persist", () => {
    it("toggling a box from the preset default emits exactly one ui.allowed-tools-change with recomputed effective", () => {
      const { checkboxes, state, emitted, persist } = setup({
        preset: "safe",
      });
      // Safe preset defaults: Read, Glob, Grep checked; Bash unchecked.
      const bashBox = checkboxes.find(
        (c) => c.getAttribute("data-tool") === "Bash"
      ) as HTMLInputElement;
      bashBox.checked = true;
      fireChange(bashBox);

      expect(state.override).not.toBeNull();
      const changes = emitted.filter((e) => e.kind === "ui.allowed-tools-change");
      expect(changes).toHaveLength(1);
      const ev = changes[0] as Extract<
        BusEvent,
        { kind: "ui.allowed-tools-change" }
      >;
      expect(ev.override).toEqual(state.override);
      expect(new Set(ev.effective)).toEqual(
        new Set(["Read", "Glob", "Grep", "Bash"])
      );
      expect(persist).toHaveBeenCalledTimes(1);
    });

    it("un-toggling back to match the preset default collapses override to null (no spurious custom)", () => {
      const { checkboxes, state, emitted, persist } = setup({
        preset: "safe",
        initialOverride: ["Read"],
      });
      // Re-check Glob and Grep → back to safe preset default.
      const glob = checkboxes.find(
        (c) => c.getAttribute("data-tool") === "Glob"
      ) as HTMLInputElement;
      const grep = checkboxes.find(
        (c) => c.getAttribute("data-tool") === "Grep"
      ) as HTMLInputElement;
      glob.checked = true;
      fireChange(glob);
      grep.checked = true;
      fireChange(grep);

      expect(state.override).toBeNull();
      const lastChange = emitted
        .filter((e) => e.kind === "ui.allowed-tools-change")
        .at(-1) as Extract<BusEvent, { kind: "ui.allowed-tools-change" }>;
      expect(lastChange.override).toBeNull();
      expect(new Set(lastChange.effective)).toEqual(
        new Set(PERMISSION_PRESETS.safe.allowedTools)
      );
      // persist was called on each real transition (2x here).
      expect(persist.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it("toggling between two distinct custom states emits separate ui.allowed-tools-change events", () => {
      const { checkboxes, emitted, persist } = setup({ preset: "safe" });
      const bash = checkboxes.find(
        (c) => c.getAttribute("data-tool") === "Bash"
      ) as HTMLInputElement;
      const write = checkboxes.find(
        (c) => c.getAttribute("data-tool") === "Write"
      ) as HTMLInputElement;

      bash.checked = true;
      fireChange(bash);
      write.checked = true;
      fireChange(write);

      const changes = emitted.filter(
        (e) => e.kind === "ui.allowed-tools-change"
      );
      expect(changes).toHaveLength(2);
      expect(persist).toHaveBeenCalledTimes(2);
    });
  });

  describe("text input — commits on Enter + change", () => {
    it("typing 'Read,Bash' + firing change emits ui.allowed-tools-change with those exact tokens", () => {
      const { textInput, state, emitted } = setup({ preset: "safe" });
      textInput.value = "Read,Bash";
      fireChange(textInput);
      expect(state.override).toEqual(["Read", "Bash"]);
      const changes = emitted.filter(
        (e) => e.kind === "ui.allowed-tools-change"
      );
      expect(changes).toHaveLength(1);
      const ev = changes[0] as Extract<
        BusEvent,
        { kind: "ui.allowed-tools-change" }
      >;
      expect(ev.override).toEqual(["Read", "Bash"]);
    });

    it("typing + pressing Enter also commits the parse", () => {
      const { textInput, state } = setup({ preset: "safe" });
      textInput.value = "Edit";
      fireEnter(textInput);
      expect(state.override).toEqual(["Edit"]);
    });

    it("emptying the text input and firing change resets override to null (back to preset default)", () => {
      const { textInput, state, emitted } = setup({
        preset: "safe",
        initialOverride: ["Read", "Bash"],
      });
      textInput.value = "";
      fireChange(textInput);
      expect(state.override).toBeNull();
      const changes = emitted.filter(
        (e) => e.kind === "ui.allowed-tools-change"
      );
      expect(changes.at(-1)).toMatchObject({ override: null });
    });

    it("invalid tokens ('Reed') surface [claude-webview] session.error AND valid tokens still apply", () => {
      const { textInput, state, emitted, bus } = setup({ preset: "safe" });
      const errs: string[] = [];
      bus.on("session.error", (e) => errs.push(e.message));
      textInput.value = "Read, Reed, Bash";
      fireChange(textInput);

      expect(state.override).toEqual(["Read", "Bash"]);
      expect(errs.some((m) => /\[claude-webview\]/.test(m) && /Reed/.test(m))).toBe(
        true
      );
      const changes = emitted.filter(
        (e) => e.kind === "ui.allowed-tools-change"
      );
      expect(changes).toHaveLength(1);
    });
  });

  describe("ui.permission-change refresh (interoperates with permission-dropdown)", () => {
    it("preset change while override is null refreshes the effective label + checkbox defaults", () => {
      const fx = setup({ preset: "safe" });
      const { bus, effectiveEl, checkboxes } = fx;
      // Emit a preset switch from safe → full.
      bus.emit({ kind: "ui.permission-change", preset: "full" });

      expect(effectiveEl.getAttribute("data-source")).toBe("full preset");
      const fullCfg = PERMISSION_PRESETS.full;
      const fullSet = new Set<string>(fullCfg.allowedTools);
      for (const cb of checkboxes) {
        const tool = cb.getAttribute("data-tool") ?? "";
        expect(cb.checked).toBe(fullSet.has(tool));
      }
    });

    it("preset change while override is set preserves the override (explicit user intent wins)", () => {
      const fx = setup({
        preset: "safe",
        initialOverride: ["Read"],
      });
      const { bus, effectiveEl, state } = fx;
      bus.emit({ kind: "ui.permission-change", preset: "full" });

      expect(state.override).toEqual(["Read"]);
      expect(effectiveEl.getAttribute("data-source")).toBe("custom");
      expect(effectiveEl.getAttribute("data-effective")).toBe("Read");
    });
  });

  describe("error-surface discipline — persist() failure", () => {
    it("synchronous persist throw is caught + surfaced on session.error with [claude-webview] namespace", async () => {
      const fx = setup({
        preset: "safe",
        persistImpl: () => {
          throw new Error("disk full");
        },
      });
      const errs: string[] = [];
      fx.bus.on("session.error", (e) => errs.push(e.message));

      const bashBox = fx.checkboxes.find(
        (c) => c.getAttribute("data-tool") === "Bash"
      ) as HTMLInputElement;
      bashBox.checked = true;
      expect(() => fireChange(bashBox)).not.toThrow();

      await Promise.resolve();
      await Promise.resolve();

      expect(
        errs.some(
          (m) =>
            /\[claude-webview\]/.test(m) &&
            /failed to persist allowed-tools override/.test(m) &&
            m.includes("disk full")
        )
      ).toBe(true);
    });

    it("async persist rejection is caught + surfaced", async () => {
      const fx = setup({
        preset: "safe",
        persistImpl: async () => {
          throw new Error("vault read-only");
        },
      });
      const errs: string[] = [];
      fx.bus.on("session.error", (e) => errs.push(e.message));

      const bashBox = fx.checkboxes.find(
        (c) => c.getAttribute("data-tool") === "Bash"
      ) as HTMLInputElement;
      bashBox.checked = true;
      expect(() => fireChange(bashBox)).not.toThrow();

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(
        errs.some(
          (m) => /\[claude-webview\]/.test(m) && m.includes("vault read-only")
        )
      ).toBe(true);
    });
  });

  describe("no-op when new override === previous override", () => {
    it("committing the same override twice emits only one bus event", () => {
      const { textInput, emitted, persist } = setup({ preset: "safe" });
      textInput.value = "Read,Bash";
      fireChange(textInput);
      textInput.value = "Read,Bash";
      fireChange(textInput);

      const changes = emitted.filter(
        (e) => e.kind === "ui.allowed-tools-change"
      );
      expect(changes).toHaveLength(1);
      expect(persist).toHaveBeenCalledTimes(1);
    });
  });
});

describe("parseAllowedToolsOverride — pure helper", () => {
  it("empty / whitespace-only input → empty tokens + no invalid", () => {
    expect(parseAllowedToolsOverride("")).toEqual({ tokens: [], invalid: [] });
    expect(parseAllowedToolsOverride("   ")).toEqual({ tokens: [], invalid: [] });
    expect(parseAllowedToolsOverride(",,")).toEqual({ tokens: [], invalid: [] });
  });

  it("valid csv produces ordered, deduped tokens", () => {
    const p = parseAllowedToolsOverride("Read, Edit ,Read,Write");
    expect(p.tokens).toEqual(["Read", "Edit", "Write"]);
    expect(p.invalid).toEqual([]);
  });

  it("invalid tokens ('Reed', 'read') are surfaced in .invalid", () => {
    const p = parseAllowedToolsOverride("Read,Reed,read,Bash");
    expect(p.tokens).toEqual(["Read", "Bash"]);
    // 'Reed' and 'read' are both invalid (case-sensitive).
    expect(p.invalid).toEqual(expect.arrayContaining(["Reed", "read"]));
  });

  it("duplicate entries are deduped (first occurrence wins, preserves order)", () => {
    const p = parseAllowedToolsOverride("Edit,Read,Edit,Grep,Read");
    expect(p.tokens).toEqual(["Edit", "Read", "Grep"]);
  });
});

describe("computeEffectiveAllowedTools — pure helper", () => {
  it("null override → preset default tools", () => {
    const effective = computeEffectiveAllowedTools("standard", null);
    expect([...effective]).toEqual([
      ...PERMISSION_PRESETS.standard.allowedTools,
    ]);
  });

  it("empty array override → preset default (treated as 'no override')", () => {
    const effective = computeEffectiveAllowedTools("full", []);
    expect([...effective]).toEqual([...PERMISSION_PRESETS.full.allowedTools]);
  });

  it("non-empty override → override verbatim, ignoring preset", () => {
    const override: AllowedToolName[] = ["Read"];
    const effective = computeEffectiveAllowedTools("full", override);
    expect([...effective]).toEqual(["Read"]);
  });
});
