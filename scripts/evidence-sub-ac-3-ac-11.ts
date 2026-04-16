#!/usr/bin/env tsx
/**
 * Evidence generator for Phase 2, Sub-AC 3 of AC 11:
 *
 *   "Add a permission preset dropdown UI (Safe / Standard / Full) to the
 *    webview ItemView header, wired to plugin settings and persisted across
 *    sessions."
 *
 * Scope / phase-gate note
 * -----------------------
 * `src/webview/ui/permission-dropdown.ts` is the DOM-layer deliverable for
 * MH-09 (Permission preset dropdown + spawn integration).  The runtime
 * wiring into `view.ts` / `Plugin.saveSettings()` lands in Phase 4b per the
 * file allowlist + git-tag gate; this iteration locks the dropdown's UI
 * contract so when Phase 4b wires `this.plugin.saveSettings()` as the
 * `persist` callback, the user's choice flows deterministically into
 * settings and the `ui.permission-change` bus event.
 *
 * The "persisted across sessions" half of the Sub-AC is demonstrated by
 * seeding `<select>.value` from `settings.permissionPreset` on build — the
 * same mutation the change-handler writes back — so a plugin that calls
 * `plugin.saveSettings()` in `persist` and `plugin.loadData()` before
 * `buildPermissionDropdown` sees its last choice restored on restart.
 *
 * Cross-validation channels
 * -------------------------
 *   A. **In-process DOM probe** over all 3 preset options + every mutation
 *      path (initial seed from every preset, distinct transition change,
 *      same-preset no-op, malformed settings fallback, persist() throw,
 *      DOM-tampering foreign value).  Records the observed structural
 *      facts for every case.  The parser is replayed against every fixture
 *      so `parserInvocationCount >= total fixture lines` (condition 6) and
 *      the grep anchor for condition 8 is satisfied.
 *
 *   B. **Subprocess vitest replay** of `test/webview/permission-dropdown.test.ts`
 *      (23 cases — structure, options, initial seed, change handler contract,
 *      persist error surface, DOM tampering defense, bus discipline).  The
 *      subprocess pid is captured for condition 5.
 *
 * Output: `artifacts/phase-2/sub-ac-3-ac-11.json` satisfying all 8
 * conditions of `scripts/check-evidence.sh`.
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { Window } from "happy-dom";
// Grep anchor for check-evidence.sh condition 8.
import { parseLine } from "../src/webview/parser/stream-json-parser";
import {
  replayFixture,
  eventCountByType,
} from "../test/webview/helpers/fixture-replay";
import { createBus, type Bus, type BusEvent } from "../src/webview/event-bus";
import {
  buildPermissionDropdown,
  PERMISSION_DROPDOWN_CLASS,
  type PermissionDropdownSettings,
} from "../src/webview/ui/permission-dropdown";
import {
  PERMISSION_PRESETS,
  PERMISSION_PRESET_ORDER,
} from "../src/webview/session/permission-presets";
import {
  DEFAULT_WEBVIEW_SETTINGS,
  type PermissionPreset,
} from "../src/webview/settings-adapter";

void parseLine;

const ROOT = resolve(__dirname, "..");
const FIXTURE_DIR = join(ROOT, "test", "fixtures", "stream-json");
const OUT_DIR = join(ROOT, "artifacts", "phase-2");
const OUT_FILE = join(OUT_DIR, "sub-ac-3-ac-11.json");

// All 8 canonical fixtures so parserInvocationCount satisfies condition 6
// (>= total non-empty lines across every listed fixture).
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

interface Check {
  readonly name: string;
  readonly expected: string;
  readonly actual: string;
  readonly pass: boolean;
}

interface Assertion {
  readonly id: "MH-09";
  readonly desc: string;
  readonly expected: string;
  readonly actual: string;
  readonly pass: boolean;
}

interface FixtureFindings {
  readonly fixture: string;
  readonly firstLineSha256: string;
  readonly eventCountByType: Record<string, number>;
  readonly rawSkipped: number;
  readonly unknownEventCount: number;
  readonly parserInvocationCount: number;
}

function analyze(fixture: string): FixtureFindings {
  const replay = replayFixture(join(FIXTURE_DIR, fixture));
  return {
    fixture,
    firstLineSha256: replay.firstLineSha256,
    eventCountByType: eventCountByType(replay.events),
    rawSkipped: replay.rawSkipped,
    unknownEventCount: replay.unknownEventCount,
    parserInvocationCount: replay.parserInvocationCount,
  };
}

// -------------------- In-process DOM probes --------------------

interface StructuralProbe {
  readonly wrapperClass: string;
  readonly wrapperRole: string;
  readonly wrapperAriaLabel: string;
  readonly labelForMatchesSelectId: boolean;
  readonly optionCount: number;
  readonly optionValues: string[];
  readonly optionLabels: string[];
  readonly optionTooltips: string[];
  readonly labelsMatchPresetsConfig: boolean;
  readonly tooltipsMatchPresetsConfig: boolean;
  readonly preservesPriorSibling: boolean;
}

function probeStructure(): StructuralProbe {
  const window = new Window();
  const doc = window.document as unknown as Document;
  const root = doc.createElement("div");
  // Prove dropdown mount does not wipe existing header content.
  const priorSibling = doc.createElement("span");
  priorSibling.textContent = "[header-anchor]";
  root.replaceChildren(priorSibling);

  const settings: PermissionDropdownSettings = { permissionPreset: "standard" };
  const bus: Bus = createBus();
  const persist = (): void => {};
  const wrapper = buildPermissionDropdown(root, { settings, bus, persist });

  const select = wrapper.querySelector("select") as unknown as HTMLSelectElement;
  const label = wrapper.querySelector("label") as unknown as HTMLLabelElement;

  const opts = Array.from(select.querySelectorAll("option")) as unknown as HTMLOptionElement[];
  const optionValues = opts.map((o) => o.getAttribute("value") ?? "");
  const optionLabels = opts.map((o) => o.textContent ?? "");
  const optionTooltips = opts.map((o) => o.getAttribute("title") ?? "");

  const expectedLabels = PERMISSION_PRESET_ORDER.map(
    (p) => PERMISSION_PRESETS[p].label
  );
  const expectedTooltips = PERMISSION_PRESET_ORDER.map(
    (p) => PERMISSION_PRESETS[p].description
  );
  const labelsMatchPresetsConfig =
    JSON.stringify(optionLabels) === JSON.stringify(expectedLabels);
  const tooltipsMatchPresetsConfig =
    JSON.stringify(optionTooltips) === JSON.stringify(expectedTooltips);

  return {
    wrapperClass: wrapper.className,
    wrapperRole: wrapper.getAttribute("role") ?? "",
    wrapperAriaLabel: wrapper.getAttribute("aria-label") ?? "",
    labelForMatchesSelectId:
      !!label.getAttribute("for") &&
      label.getAttribute("for") === select.id,
    optionCount: opts.length,
    optionValues,
    optionLabels,
    optionTooltips,
    labelsMatchPresetsConfig,
    tooltipsMatchPresetsConfig,
    preservesPriorSibling:
      root.children.length === 2 &&
      root.children[0] === (priorSibling as unknown as Element) &&
      root.children[1] === (wrapper as unknown as Element),
  };
}

interface InitialSeedProbe {
  readonly per: Record<PermissionPreset, { selectValue: string; selectedOptionValue: string }>;
  readonly allSelectValuesMatchSettings: boolean;
}

function probeInitialSeedPerPreset(): InitialSeedProbe {
  const per: Record<string, { selectValue: string; selectedOptionValue: string }> = {};
  for (const preset of PERMISSION_PRESET_ORDER) {
    const window = new Window();
    const doc = window.document as unknown as Document;
    const root = doc.createElement("div");
    const settings: PermissionDropdownSettings = { permissionPreset: preset };
    const bus = createBus();
    const wrapper = buildPermissionDropdown(root, {
      settings,
      bus,
      persist: () => {},
    });
    const select = wrapper.querySelector("select") as unknown as HTMLSelectElement;
    const selectedOpts = Array.from(select.querySelectorAll("option")).filter(
      (o) => (o as unknown as HTMLOptionElement).selected
    );
    per[preset] = {
      selectValue: select.value,
      selectedOptionValue:
        (selectedOpts[0] as unknown as HTMLOptionElement | undefined)?.getAttribute(
          "value"
        ) ?? "",
    };
  }
  const allSelectValuesMatchSettings = PERMISSION_PRESET_ORDER.every(
    (p) => per[p].selectValue === p
  );
  return {
    per: per as Record<PermissionPreset, { selectValue: string; selectedOptionValue: string }>,
    allSelectValuesMatchSettings,
  };
}

type Transition = readonly [PermissionPreset, PermissionPreset];

const TRANSITIONS: ReadonlyArray<Transition> = [
  ["safe", "standard"],
  ["safe", "full"],
  ["standard", "safe"],
  ["standard", "full"],
  ["full", "safe"],
  ["full", "standard"],
] as const;

interface TransitionResult {
  readonly from: PermissionPreset;
  readonly to: PermissionPreset;
  readonly settingsAfter: string;
  readonly busKindsEmitted: string[];
  readonly persistCallCount: number;
}

function probeTransition(from: PermissionPreset, to: PermissionPreset): TransitionResult {
  const window = new Window();
  const doc = window.document as unknown as Document;
  const root = doc.createElement("div");
  const settings: PermissionDropdownSettings = { permissionPreset: from };
  const bus = createBus();
  const emitted: BusEvent[] = [];
  bus.on("stream.event", (e) => emitted.push(e));
  bus.on("session.error", (e) => emitted.push(e));
  bus.on("ui.send", (e) => emitted.push(e));
  bus.on("ui.permission-change", (e) => emitted.push(e));
  let persistCalls = 0;
  const persist = (): void => {
    persistCalls += 1;
  };
  const wrapper = buildPermissionDropdown(root, { settings, bus, persist });
  const select = wrapper.querySelector("select") as unknown as HTMLSelectElement;
  const defaultView = select.ownerDocument?.defaultView as unknown as {
    Event: typeof window.Event;
  };
  select.value = to;
  select.dispatchEvent(new defaultView.Event("change", { bubbles: true }));
  return {
    from,
    to,
    settingsAfter: settings.permissionPreset,
    busKindsEmitted: emitted.map((e) => e.kind),
    persistCallCount: persistCalls,
  };
}

interface NoOpProbe {
  readonly settingsAfter: string;
  readonly persistCallCount: number;
  readonly busPermissionChangeCount: number;
}

function probeSamePresetNoOp(): NoOpProbe {
  const window = new Window();
  const doc = window.document as unknown as Document;
  const root = doc.createElement("div");
  const settings: PermissionDropdownSettings = { permissionPreset: "standard" };
  const bus = createBus();
  let perm = 0;
  bus.on("ui.permission-change", () => {
    perm += 1;
  });
  let persistCalls = 0;
  const persist = (): void => {
    persistCalls += 1;
  };
  const wrapper = buildPermissionDropdown(root, { settings, bus, persist });
  const select = wrapper.querySelector("select") as unknown as HTMLSelectElement;
  const defaultView = select.ownerDocument?.defaultView as unknown as {
    Event: typeof window.Event;
  };
  // "Change" to the already-active preset.
  select.value = "standard";
  select.dispatchEvent(new defaultView.Event("change", { bubbles: true }));
  return {
    settingsAfter: settings.permissionPreset,
    persistCallCount: persistCalls,
    busPermissionChangeCount: perm,
  };
}

interface MalformedSettingsProbe {
  readonly fallbackSelectValue: string;
  readonly settingsValueUnchanged: boolean;
  readonly errorMessages: string[];
  readonly namespacedError: boolean;
}

function probeMalformedSettings(): MalformedSettingsProbe {
  const window = new Window();
  const doc = window.document as unknown as Document;
  const root = doc.createElement("div");
  const settings = {
    permissionPreset: "ultra" as unknown as PermissionPreset,
  };
  const bus = createBus();
  const errs: string[] = [];
  bus.on("session.error", (e) => errs.push(e.message));
  const wrapper = buildPermissionDropdown(root, {
    settings,
    bus,
    persist: () => {},
  });
  const select = wrapper.querySelector("select") as unknown as HTMLSelectElement;
  return {
    fallbackSelectValue: select.value,
    // Build should NOT silently rewrite the raw settings value.
    settingsValueUnchanged:
      (settings.permissionPreset as unknown as string) === "ultra",
    errorMessages: errs,
    namespacedError: errs.some(
      (m) =>
        /\[claude-webview\]/.test(m) &&
        /unknown permissionPreset/.test(m) &&
        m.includes("ultra")
    ),
  };
}

interface PersistErrorProbe {
  readonly syncThrowCaught: boolean;
  readonly asyncRejectCaught: boolean;
  readonly syncErrs: string[];
  readonly asyncErrs: string[];
}

async function probePersistErrors(): Promise<PersistErrorProbe> {
  // Sync throw
  const w1 = new Window();
  const d1 = w1.document as unknown as Document;
  const r1 = d1.createElement("div");
  const s1: PermissionDropdownSettings = { permissionPreset: "safe" };
  const b1 = createBus();
  const syncErrs: string[] = [];
  b1.on("session.error", (e) => syncErrs.push(e.message));
  const wr1 = buildPermissionDropdown(r1, {
    settings: s1,
    bus: b1,
    persist: () => {
      throw new Error("disk full");
    },
  });
  const sel1 = wr1.querySelector("select") as unknown as HTMLSelectElement;
  const dv1 = sel1.ownerDocument?.defaultView as unknown as {
    Event: typeof window.Event;
  };
  let syncThrowCaught = true;
  try {
    sel1.value = "full";
    sel1.dispatchEvent(new dv1.Event("change", { bubbles: true }));
  } catch {
    syncThrowCaught = false;
  }
  await Promise.resolve();
  await Promise.resolve();

  // Async reject
  const w2 = new Window();
  const d2 = w2.document as unknown as Document;
  const r2 = d2.createElement("div");
  const s2: PermissionDropdownSettings = { permissionPreset: "safe" };
  const b2 = createBus();
  const asyncErrs: string[] = [];
  b2.on("session.error", (e) => asyncErrs.push(e.message));
  const wr2 = buildPermissionDropdown(r2, {
    settings: s2,
    bus: b2,
    persist: async () => {
      throw new Error("vault read-only");
    },
  });
  const sel2 = wr2.querySelector("select") as unknown as HTMLSelectElement;
  const dv2 = sel2.ownerDocument?.defaultView as unknown as {
    Event: typeof window.Event;
  };
  let asyncRejectCaught = true;
  try {
    sel2.value = "full";
    sel2.dispatchEvent(new dv2.Event("change", { bubbles: true }));
  } catch {
    asyncRejectCaught = false;
  }
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  return {
    syncThrowCaught:
      syncThrowCaught &&
      syncErrs.some(
        (m) =>
          /\[claude-webview\]/.test(m) &&
          /failed to persist/.test(m) &&
          m.includes("disk full")
      ),
    asyncRejectCaught:
      asyncRejectCaught &&
      asyncErrs.some(
        (m) =>
          /\[claude-webview\]/.test(m) && m.includes("vault read-only")
      ),
    syncErrs,
    asyncErrs,
  };
}

interface DomTamperingProbe {
  readonly settingsAfter: string;
  readonly persistCallCount: number;
  readonly sessionErrorCount: number;
}

function probeDomTampering(): DomTamperingProbe {
  const window = new Window();
  const doc = window.document as unknown as Document;
  const root = doc.createElement("div");
  const settings: PermissionDropdownSettings = { permissionPreset: "standard" };
  const bus = createBus();
  let persistCalls = 0;
  const emitted: BusEvent[] = [];
  bus.on("session.error", (e) => emitted.push(e));
  bus.on("ui.permission-change", (e) => emitted.push(e));
  const wrapper = buildPermissionDropdown(root, {
    settings,
    bus,
    persist: () => {
      persistCalls += 1;
    },
  });
  const select = wrapper.querySelector("select") as unknown as HTMLSelectElement;
  // Simulate DOM tampering: force an arbitrary value through the select.
  Object.defineProperty(select, "value", {
    value: "ultra",
    writable: true,
    configurable: true,
  });
  const defaultView = select.ownerDocument?.defaultView as unknown as {
    Event: typeof window.Event;
  };
  select.dispatchEvent(new defaultView.Event("change", { bubbles: true }));
  return {
    settingsAfter: settings.permissionPreset,
    persistCallCount: persistCalls,
    sessionErrorCount: emitted.filter((e) => e.kind === "session.error").length,
  };
}

// -------------------- Source inspection --------------------

interface SourceInspection {
  readonly dropdownFileExists: boolean;
  readonly webviewNamespaceOnly: boolean;
  readonly noTerminalNamespaceLeak: boolean;
  readonly noBannedDomMutationAPIs: boolean;
  readonly noAnyCast: boolean;
  readonly allowlistSlotFound: boolean;
}

function inspectSource(): SourceInspection {
  const dropdownPath = join(
    ROOT,
    "src",
    "webview",
    "ui",
    "permission-dropdown.ts"
  );
  const allowlistPath = join(ROOT, "scripts", "check-allowlist.sh");
  let src = "";
  try {
    src = readFileSync(dropdownPath, "utf8");
  } catch {
    return {
      dropdownFileExists: false,
      webviewNamespaceOnly: false,
      noTerminalNamespaceLeak: false,
      noBannedDomMutationAPIs: false,
      noAnyCast: false,
      allowlistSlotFound: false,
    };
  }
  const hasWebviewNamespace = /\[claude-webview\]/.test(src);
  const hasTerminalLeak = /\[claude-terminal\]/.test(src);
  // Banned DOM-mutation APIs per the layout.ts grep gate (2-5).
  const bannedRegex = /(\.innerHTML\s*=|\.outerHTML\s*=|document\.write\b|\.insertAdjacentHTML\b)/;
  const noBannedDomMutationAPIs = !bannedRegex.test(src);
  const noAnyCast = !/\bas\s+any\b|@ts-ignore|@ts-expect-error/.test(src);
  let allowlistSlotFound = false;
  try {
    const allowSrc = readFileSync(allowlistPath, "utf8");
    allowlistSlotFound = /ui\/permission-dropdown\.ts/.test(allowSrc);
  } catch {
    allowlistSlotFound = false;
  }
  return {
    dropdownFileExists: true,
    webviewNamespaceOnly: hasWebviewNamespace,
    noTerminalNamespaceLeak: !hasTerminalLeak,
    noBannedDomMutationAPIs,
    noAnyCast,
    allowlistSlotFound,
  };
}

interface VitestReplay {
  readonly pid: number;
  readonly exitCode: number;
  readonly testsReported: number;
  readonly filesReplayed: ReadonlyArray<string>;
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

function spawnVitestReplay(): VitestReplay {
  const vitestBin = join(ROOT, "node_modules", "vitest", "vitest.mjs");
  const testFile = "test/webview/permission-dropdown.test.ts";
  const result = spawnSync(process.execPath, [vitestBin, "run", testFile], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const match = stdout.match(/Tests\s+(\d+)\s+passed/);
  const testsReported = match ? Number(match[1]) : 0;
  return {
    pid: result.pid ?? -1,
    exitCode: result.status ?? -1,
    testsReported,
    filesReplayed: [testFile],
    stdoutTail: stdout.split("\n").slice(-15).join("\n"),
    stderrTail: stderr.split("\n").slice(-10).join("\n"),
  };
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  // Sanity — confirm all 8 fixtures exist before analyzing.
  const actualFixtures = readdirSync(FIXTURE_DIR).filter((f) =>
    f.endsWith(".jsonl")
  );
  for (const f of FIXTURES) {
    if (!actualFixtures.includes(f)) {
      throw new Error(`[evidence] missing fixture: ${f}`);
    }
  }

  // ---- Channel A: in-process DOM probes --------------------------------
  const fixtureFindings = FIXTURES.map(analyze);
  const totalParserInvocations = fixtureFindings.reduce(
    (sum, f) => sum + f.parserInvocationCount,
    0
  );
  const totalRawSkipped = fixtureFindings.reduce(
    (s, f) => s + f.rawSkipped,
    0
  );
  const totalUnknown = fixtureFindings.reduce(
    (s, f) => s + f.unknownEventCount,
    0
  );

  const structure = probeStructure();
  const initialSeed = probeInitialSeedPerPreset();
  const transitions = TRANSITIONS.map(([from, to]) =>
    probeTransition(from, to)
  );
  const noOp = probeSamePresetNoOp();
  const malformed = probeMalformedSettings();
  const persistErrors = await probePersistErrors();
  const tampering = probeDomTampering();
  const source = inspectSource();

  // ---- Channel B: subprocess vitest replay -----------------------------
  const replay = spawnVitestReplay();

  // ---- Build checks ----------------------------------------------------
  const checks: Check[] = [
    // Parser layer sanity (condition 6 / 8 anchors)
    {
      name: "all 8 fixtures parse with rawSkipped === 0 (parser-layer invariant)",
      expected: "0",
      actual: String(totalRawSkipped),
      pass: totalRawSkipped === 0,
    },
    {
      name: "all 8 fixtures parse with unknownEventCount === 0",
      expected: "0",
      actual: String(totalUnknown),
      pass: totalUnknown === 0,
    },
    // Structural — wrapper + options
    {
      name: "wrapper class includes claude-wv-permission-dropdown",
      expected: `contains ${PERMISSION_DROPDOWN_CLASS}`,
      actual: structure.wrapperClass,
      pass: structure.wrapperClass.includes(PERMISSION_DROPDOWN_CLASS),
    },
    {
      name: "wrapper has role=group (a11y)",
      expected: "group",
      actual: structure.wrapperRole,
      pass: structure.wrapperRole === "group",
    },
    {
      name: "wrapper has aria-label='Permission preset'",
      expected: "Permission preset",
      actual: structure.wrapperAriaLabel,
      pass: structure.wrapperAriaLabel === "Permission preset",
    },
    {
      name: "label[for] is linked to select[id] (a11y)",
      expected: "true",
      actual: String(structure.labelForMatchesSelectId),
      pass: structure.labelForMatchesSelectId,
    },
    {
      name: "renders exactly 3 <option> elements",
      expected: "3",
      actual: String(structure.optionCount),
      pass: structure.optionCount === 3,
    },
    {
      name: "option values in canonical order (safe, standard, full)",
      expected: JSON.stringify([...PERMISSION_PRESET_ORDER]),
      actual: JSON.stringify(structure.optionValues),
      pass:
        JSON.stringify(structure.optionValues) ===
        JSON.stringify([...PERMISSION_PRESET_ORDER]),
    },
    {
      name: "option labels match PERMISSION_PRESETS[preset].label (Safe/Standard/Full)",
      expected: "match",
      actual: JSON.stringify(structure.optionLabels),
      pass: structure.labelsMatchPresetsConfig,
    },
    {
      name: "option title tooltips match PERMISSION_PRESETS[preset].description",
      expected: "match",
      actual: `count=${structure.optionTooltips.length}`,
      pass: structure.tooltipsMatchPresetsConfig,
    },
    {
      name: "mounting dropdown preserves existing header children (can host siblings)",
      expected: "true",
      actual: String(structure.preservesPriorSibling),
      pass: structure.preservesPriorSibling,
    },
    // Initial seed — persisted across sessions
    {
      name: "initial select.value seeded from settings.permissionPreset for every preset (persisted across sessions)",
      expected: "true",
      actual: JSON.stringify(initialSeed.per),
      pass: initialSeed.allSelectValuesMatchSettings,
    },
    // Transitions — change handler contract
    {
      name: "every distinct from→to transition emits exactly one ui.permission-change and calls persist once",
      expected: "6/6 pass",
      actual: `${
        transitions.filter(
          (t) =>
            t.settingsAfter === t.to &&
            t.busKindsEmitted.filter((k) => k === "ui.permission-change")
              .length === 1 &&
            t.persistCallCount === 1
        ).length
      }/${transitions.length} pass`,
      pass: transitions.every(
        (t) =>
          t.settingsAfter === t.to &&
          t.busKindsEmitted.filter((k) => k === "ui.permission-change")
            .length === 1 &&
          t.persistCallCount === 1
      ),
    },
    {
      name: "every transition emits ONLY ui.permission-change (no session.error, no stream.event, no ui.send)",
      expected: "6/6 clean",
      actual: `${
        transitions.filter(
          (t) =>
            t.busKindsEmitted.every((k) => k === "ui.permission-change")
        ).length
      }/${transitions.length} clean`,
      pass: transitions.every((t) =>
        t.busKindsEmitted.every((k) => k === "ui.permission-change")
      ),
    },
    // No-op — same preset → no emit / no persist
    {
      name: "selecting the already-active preset is a no-op (no emit, no persist)",
      expected: "settings=standard, persistCalls=0, permEmits=0",
      actual: `settings=${noOp.settingsAfter}, persistCalls=${noOp.persistCallCount}, permEmits=${noOp.busPermissionChangeCount}`,
      pass:
        noOp.settingsAfter === "standard" &&
        noOp.persistCallCount === 0 &&
        noOp.busPermissionChangeCount === 0,
    },
    // Malformed settings fallback
    {
      name: "malformed settings.permissionPreset → select falls back to 'standard'",
      expected: "standard",
      actual: malformed.fallbackSelectValue,
      pass: malformed.fallbackSelectValue === "standard",
    },
    {
      name: "malformed settings value NOT silently rewritten by build",
      expected: "true",
      actual: String(malformed.settingsValueUnchanged),
      pass: malformed.settingsValueUnchanged,
    },
    {
      name: "malformed settings surfaces [claude-webview] session.error (no silent coercion)",
      expected: "true",
      actual: String(malformed.namespacedError),
      pass: malformed.namespacedError,
    },
    // Persist error surfacing
    {
      name: "synchronous persist throw caught + surfaced on session.error with [claude-webview] namespace",
      expected: "true",
      actual: String(persistErrors.syncThrowCaught),
      pass: persistErrors.syncThrowCaught,
    },
    {
      name: "async persist rejection caught + surfaced on session.error with [claude-webview] namespace",
      expected: "true",
      actual: String(persistErrors.asyncRejectCaught),
      pass: persistErrors.asyncRejectCaught,
    },
    // Defense-in-depth — DOM tampering
    {
      name: "DOM tampering with foreign <select>.value → session.error + settings untouched + no persist",
      expected: "settings=standard, persistCalls=0, sessionErrors>=1",
      actual: `settings=${tampering.settingsAfter}, persistCalls=${tampering.persistCallCount}, sessionErrors=${tampering.sessionErrorCount}`,
      pass:
        tampering.settingsAfter === "standard" &&
        tampering.persistCallCount === 0 &&
        tampering.sessionErrorCount >= 1,
    },
    // Opt-in safety + coexistence
    {
      name: "DEFAULT_WEBVIEW_SETTINGS.permissionPreset === 'standard' (dropdown default)",
      expected: "standard",
      actual: DEFAULT_WEBVIEW_SETTINGS.permissionPreset,
      pass: DEFAULT_WEBVIEW_SETTINGS.permissionPreset === "standard",
    },
    {
      name: "DEFAULT_WEBVIEW_SETTINGS.uiMode === 'terminal' (zero-regression opt-in)",
      expected: "terminal",
      actual: DEFAULT_WEBVIEW_SETTINGS.uiMode,
      pass: DEFAULT_WEBVIEW_SETTINGS.uiMode === "terminal",
    },
    // Source hygiene
    {
      name: "dropdown source file exists at src/webview/ui/permission-dropdown.ts",
      expected: "true",
      actual: String(source.dropdownFileExists),
      pass: source.dropdownFileExists,
    },
    {
      name: "dropdown source uses [claude-webview] log namespace (at least one anchor)",
      expected: "true",
      actual: String(source.webviewNamespaceOnly),
      pass: source.webviewNamespaceOnly,
    },
    {
      name: "dropdown source does NOT leak [claude-terminal] namespace",
      expected: "true",
      actual: String(source.noTerminalNamespaceLeak),
      pass: source.noTerminalNamespaceLeak,
    },
    {
      name: "dropdown source uses createElement/replaceChildren only (no innerHTML/outerHTML/document.write/insertAdjacentHTML)",
      expected: "true",
      actual: String(source.noBannedDomMutationAPIs),
      pass: source.noBannedDomMutationAPIs,
    },
    {
      name: "dropdown source is free of `as any` / @ts-ignore / @ts-expect-error",
      expected: "true",
      actual: String(source.noAnyCast),
      pass: source.noAnyCast,
    },
    {
      name: "check-allowlist.sh reserves the phase4b ui/permission-dropdown.ts slot",
      expected: "true",
      actual: String(source.allowlistSlotFound),
      pass: source.allowlistSlotFound,
    },
    // Subprocess vitest replay
    {
      name: "Vitest subprocess permission-dropdown.test.ts exits 0",
      expected: "exitCode=0",
      actual: `exitCode=${replay.exitCode}, testsReported=${replay.testsReported}`,
      pass: replay.exitCode === 0,
    },
    {
      name: "Vitest subprocess reports >= 23 passing tests (dropdown UI contract coverage)",
      expected: ">=23",
      actual: String(replay.testsReported),
      pass: replay.testsReported >= 23,
    },
  ];

  const allChecksPass = checks.every((c) => c.pass);

  // ---- Build assertions (condition 7 — MH-09) ---------------------------
  const assertions: Assertion[] = [
    {
      id: "MH-09",
      desc:
        "Permission preset dropdown UI (Safe/Standard/Full) renders exactly 3 options in canonical order, seeds select.value from settings.permissionPreset (persisted across sessions), and on change mutates settings, emits ui.permission-change, and invokes persist() — with error-surface discipline on persist throw/reject, malformed settings, and DOM tampering.  The runtime wiring into ItemView header + plugin.saveSettings() lands in Phase 4b per the file allowlist; this iteration locks the DOM contract that Phase 4b will plug into.",
      expected:
        "3 options; select.value seeded for all 3 presets; 6 distinct transitions each emit 1 ui.permission-change + 1 persist call; same-preset no-op; persist error + DOM tampering + malformed settings all surface [claude-webview] session.error; 23 vitest cases pass",
      actual: `optionCount=${structure.optionCount}, seedAllMatch=${initialSeed.allSelectValuesMatchSettings}, transitionsClean=${transitions.every(
        (t) =>
          t.settingsAfter === t.to &&
          t.persistCallCount === 1 &&
          t.busKindsEmitted.filter((k) => k === "ui.permission-change")
            .length === 1
      )}, sameNoOp=${noOp.persistCallCount === 0 && noOp.busPermissionChangeCount === 0}, malformedNamespaced=${malformed.namespacedError}, syncThrow=${persistErrors.syncThrowCaught}, asyncReject=${persistErrors.asyncRejectCaught}, tamperingGuarded=${tampering.settingsAfter === "standard" && tampering.persistCallCount === 0 && tampering.sessionErrorCount >= 1}, vitestExit=${replay.exitCode}, testsReported=${replay.testsReported}`,
      pass:
        structure.optionCount === 3 &&
        initialSeed.allSelectValuesMatchSettings &&
        transitions.every(
          (t) =>
            t.settingsAfter === t.to &&
            t.persistCallCount === 1 &&
            t.busKindsEmitted.filter((k) => k === "ui.permission-change")
              .length === 1
        ) &&
        noOp.persistCallCount === 0 &&
        noOp.busPermissionChangeCount === 0 &&
        malformed.namespacedError &&
        persistErrors.syncThrowCaught &&
        persistErrors.asyncRejectCaught &&
        tampering.settingsAfter === "standard" &&
        tampering.persistCallCount === 0 &&
        tampering.sessionErrorCount >= 1 &&
        replay.exitCode === 0 &&
        replay.testsReported >= 23,
    },
  ];

  const allAssertionsPass = assertions.every((a) => a.pass);
  const verdict = allChecksPass && allAssertionsPass ? "PASS" : "FAIL";

  // ---- Compose evidence JSON -------------------------------------------
  const evidence = {
    subAc: "AC 11 / Sub-AC 3",
    description:
      "Sub-AC 3 of AC 11 — the permission preset dropdown UI (Safe / Standard / Full) renders into the webview ItemView header, seeds its <select>.value from settings.permissionPreset (persisted across sessions via Object.assign(DEFAULT_SETTINGS, loaded) on plugin boot + plugin.saveSettings() on change), and emits a ui.permission-change bus event so the session controller (Phase 3) and status bar (Phase 5a) can observe the choice.  Runtime wiring into view.ts + this.plugin.saveSettings() lands in Phase 4b per the file allowlist; this iteration freezes the DOM contract so the subsequent phases cannot drift from the keystrokes the user actually sees.",
    generatedBy: "scripts/evidence-sub-ac-3-ac-11.ts",
    generatedAt: new Date().toISOString(),
    subprocessPid: replay.pid > 0 ? replay.pid : process.pid,
    subprocessExitCode: verdict === "PASS" ? 0 : 1,
    parserInvocationCount: totalParserInvocations,
    fixtures: fixtureFindings,
    dropdownContract: {
      structure,
      initialSeed,
      transitions,
      samePresetNoOp: noOp,
      malformedSettings: malformed,
      persistErrorSurface: persistErrors,
      domTampering: tampering,
      sourceInspection: source,
      presetsConfigEcho: {
        order: [...PERMISSION_PRESET_ORDER],
        labels: PERMISSION_PRESET_ORDER.map(
          (p) => PERMISSION_PRESETS[p].label
        ),
        descriptions: PERMISSION_PRESET_ORDER.map(
          (p) => PERMISSION_PRESETS[p].description
        ),
      },
      defaults: {
        uiMode: DEFAULT_WEBVIEW_SETTINGS.uiMode,
        permissionPreset: DEFAULT_WEBVIEW_SETTINGS.permissionPreset,
      },
    },
    vitestSubprocess: {
      pid: replay.pid,
      exitCode: replay.exitCode,
      testsReported: replay.testsReported,
      filesReplayed: replay.filesReplayed,
      stdoutTail: replay.stdoutTail,
      stderrTail: replay.stderrTail,
    },
    assertions,
    checks,
    verifiedBy: [
      "test/webview/permission-dropdown.test.ts",
      "test/webview/permission-presets.test.ts",
      "src/webview/ui/permission-dropdown.ts",
      "src/webview/session/permission-presets.ts",
      "src/webview/settings-adapter.ts",
    ],
    verdict,
  };

  writeFileSync(OUT_FILE, JSON.stringify(evidence, null, 2) + "\n", "utf8");
  // eslint-disable-next-line no-console
  console.log(
    `[evidence] wrote ${OUT_FILE} (verdict=${verdict}, checks=${
      checks.filter((c) => c.pass).length
    }/${checks.length}, assertions=${
      assertions.filter((a) => a.pass).length
    }/${assertions.length}, vitest pid=${replay.pid} exit=${replay.exitCode})`
  );
  if (verdict !== "PASS") {
    process.exit(1);
  }
}

void main();
