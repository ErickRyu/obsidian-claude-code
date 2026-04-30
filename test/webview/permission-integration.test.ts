/**
 * MH-09 core contract — permission preset dropdown actually changes the
 * NEXT `claude -p` spawn argv.
 *
 * End-to-end loop:
 *
 *   (a) Create a shared mutable settings object with `permissionPreset: "standard"`.
 *   (b) Construct `SessionController` with a fake spawn impl. Call `start()`.
 *       The spawn receives `--allowedTools Read,Edit,Write,Glob,Grep,TodoWrite`
 *       (no Bash). This is the baseline.
 *   (c) Build `buildPermissionDropdown` on a happy-dom root with the same
 *       settings object. Fire `change → "full"`. Observe:
 *         - `settings.permissionPreset === "full"` (in-place mutation).
 *         - Bus emits `{kind:"ui.permission-change", preset:"full"}`.
 *         - `persist()` spy invoked exactly once.
 *   (d) Dispose the first controller. Construct a SECOND controller with the
 *       SAME settings reference (the one the dropdown just mutated) and call
 *       `start()`. The spawn receives `--allowedTools Read,Edit,Write,Bash,
 *       Glob,Grep,TodoWrite` (Bash is the material difference) and
 *       `--permission-mode bypassPermissions` — proving buildSpawnArgs is
 *       re-computed at start() time, not frozen at controller-construction.
 *
 * If any step regresses, the dropdown is a silent no-op and MH-09 is broken.
 *
 * The separate titled test `preset change reflects in next spawn args`
 * covers gate 4b-3 with a single subset assertion on the second spawn's
 * argv so the matrix entry and `vitest -t` filter stay readable.
 */
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Window } from "happy-dom";
import type { ChildProcess } from "node:child_process";
import { createBus, type Bus, type BusEvent } from "../../src/webview/event-bus";
import {
  SessionController,
  type SpawnImpl,
} from "../../src/webview/session/session-controller";
import { buildPermissionDropdown } from "../../src/webview/ui/permission-dropdown";
import type { PermissionPreset } from "../../src/webview/settings-adapter";
import type { WebviewMutableSettings } from "../../src/webview/view";

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill(signal?: string): boolean;
  killed: boolean;
  pid: number;
  exitCode: number | null;
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter();
  const fake = Object.assign(ee, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    pid: 12345,
    exitCode: null,
    kill(_signal?: string): boolean {
      fake.killed = true;
      return true;
    },
  }) as FakeChild;
  return fake;
}

function makeFakeSpawn(): {
  spawnImpl: SpawnImpl;
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawnImpl: SpawnImpl = (cmd: string, args: string[]) => {
    calls.push({ cmd, args: [...args] });
    return makeFakeChild() as unknown as ChildProcess;
  };
  return { spawnImpl, calls };
}

function makeSharedSettings(preset: PermissionPreset): WebviewMutableSettings {
  // Single mutable object — the dropdown mutates `permissionPreset` in
  // place via its `PermissionDropdownSettings` view; the session controller
  // reads the same reference through its `SpawnArgsSettings` (readonly)
  // view. `WebviewMutableSettings` is the canonical export that unifies
  // both surfaces so a contract drift surfaces as a compile error here.
  return {
    claudePath: "claude",
    permissionPreset: preset,
    extraArgs: "",
  };
}

function getFlagValue(args: readonly string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1] ?? null;
}

function fireChange(select: HTMLSelectElement, value: PermissionPreset): void {
  select.value = value;
  const Event = (select.ownerDocument?.defaultView as unknown as {
    Event: typeof window.Event;
  }).Event;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("permission-integration (MH-09) — dropdown → next spawn args", () => {
  it("full 3-step sequence: standard start → dropdown full → next start carries Bash + bypassPermissions", async () => {
    const { spawnImpl, calls } = makeFakeSpawn();
    const settings = makeSharedSettings("standard");
    const bus: Bus = createBus();
    const emitted: BusEvent[] = [];
    bus.on("ui.permission-change", (e) => emitted.push(e));
    bus.on("session.error", (e) => emitted.push(e));

    // (a + b) initial spawn under "standard"
    const controller1 = new SessionController({ settings, bus, spawnImpl });
    controller1.start();
    expect(calls.length).toBe(1);
    const firstArgs = calls[0].args;
    expect(getFlagValue(firstArgs, "--permission-mode")).toBe("acceptEdits");
    const firstTools = getFlagValue(firstArgs, "--allowedTools") ?? "";
    expect(firstTools.split(",")).toEqual([
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
      "TodoWrite",
    ]);
    expect(firstTools.split(",")).not.toContain("Bash");

    // (c) mount dropdown, user flips to "full"
    const { document: doc } = new Window();
    const root = doc.createElement("div");
    doc.body.appendChild(root as unknown as Node);
    const persist = vi.fn();

    const wrapper = buildPermissionDropdown(root as unknown as HTMLElement, {
      settings,
      bus,
      persist,
    });
    const select = wrapper.querySelector(
      "select",
    ) as unknown as HTMLSelectElement;
    fireChange(select, "full");

    expect(settings.permissionPreset).toBe("full");
    const presetEvents = emitted.filter(
      (e): e is Extract<BusEvent, { kind: "ui.permission-change" }> =>
        e.kind === "ui.permission-change",
    );
    expect(presetEvents.length).toBe(1);
    expect(presetEvents[0].preset).toBe("full");
    // Let the detached persist promise settle so the spy is observable.
    await Promise.resolve();
    await Promise.resolve();
    expect(persist).toHaveBeenCalledTimes(1);

    // (d) second controller re-reads settings at start() time
    controller1.dispose();
    const controller2 = new SessionController({ settings, bus, spawnImpl });
    controller2.start();
    expect(calls.length).toBe(2);
    const secondArgs = calls[1].args;
    expect(getFlagValue(secondArgs, "--permission-mode")).toBe("bypassPermissions");
    const secondTools = getFlagValue(secondArgs, "--allowedTools") ?? "";
    expect(secondTools.split(",")).toContain("Bash");
    expect(secondTools.split(",")).toEqual([
      "Read",
      "Edit",
      "Write",
      "Bash",
      "Glob",
      "Grep",
      "TodoWrite",
    ]);

    // Differential sanity: two spawns received materially different argv.
    expect(firstArgs).not.toEqual(secondArgs);

    controller2.dispose();
    bus.dispose();
  });

  it("preset change reflects in next spawn args (4b-3 filter target)", async () => {
    const { spawnImpl, calls } = makeFakeSpawn();
    const settings = makeSharedSettings("standard");
    const bus: Bus = createBus();
    const persist = vi.fn();

    const { document: doc } = new Window();
    const root = doc.createElement("div");
    doc.body.appendChild(root as unknown as Node);
    const wrapper = buildPermissionDropdown(root as unknown as HTMLElement, {
      settings,
      bus,
      persist,
    });
    const select = wrapper.querySelector(
      "select",
    ) as unknown as HTMLSelectElement;
    fireChange(select, "full");
    expect(settings.permissionPreset).toBe("full");

    const controller = new SessionController({ settings, bus, spawnImpl });
    controller.start();

    expect(calls.length).toBe(1);
    const spawned = calls[0].args;
    const tools = (getFlagValue(spawned, "--allowedTools") ?? "").split(",");
    expect(tools).toContain("Bash");
    expect(getFlagValue(spawned, "--permission-mode")).toBe("bypassPermissions");

    controller.dispose();
    bus.dispose();
  });

  it("selecting the already-active preset does NOT re-emit or change spawn args", () => {
    const { spawnImpl, calls } = makeFakeSpawn();
    const settings = makeSharedSettings("full");
    const bus: Bus = createBus();
    const emitted: BusEvent[] = [];
    bus.on("ui.permission-change", (e) => emitted.push(e));
    const persist = vi.fn();

    const { document: doc } = new Window();
    const root = doc.createElement("div");
    doc.body.appendChild(root as unknown as Node);
    const wrapper = buildPermissionDropdown(root as unknown as HTMLElement, {
      settings,
      bus,
      persist,
    });
    const select = wrapper.querySelector(
      "select",
    ) as unknown as HTMLSelectElement;

    // Fire a change event whose value equals the already-active preset.
    fireChange(select, "full");

    expect(settings.permissionPreset).toBe("full");
    expect(emitted.length).toBe(0);
    expect(persist).not.toHaveBeenCalled();

    const controller = new SessionController({ settings, bus, spawnImpl });
    controller.start();
    expect(calls.length).toBe(1);
    const tools = (getFlagValue(calls[0].args, "--allowedTools") ?? "").split(",");
    expect(tools).toContain("Bash");

    controller.dispose();
    bus.dispose();
  });
});
