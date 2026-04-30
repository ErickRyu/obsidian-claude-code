/**
 * Sub-AC 2 of AC 11 — spawn-args preset/custom CLI flag integration.
 *
 * Proves that `buildSpawnArgs` emits the correct `--allowedTools` +
 * `--permission-mode` argv entries for every preset AND for the
 * custom-override path, with deterministic argv order.  Key-field
 * assertions only — no snapshot files — so future CLI flag additions
 * that keep the preset contract intact do not churn snapshots.
 *
 * Coverage matrix:
 *
 *   (a) each preset (safe / standard / full) maps to its canonical
 *       `--permission-mode` + `--allowedTools` pair (3 cases)
 *   (b) the 3 argv outputs are pairwise distinct (differential — proves
 *       the dropdown change actually reaches the child process)
 *   (c) --resume flag is present iff a non-empty resumeId is passed
 *   (d) --mcp-config flag is present iff a non-empty mcpConfigPath is passed
 *   (e) custom overrides REPLACE (not extend) the preset's values
 *   (f) extraArgs are split on whitespace and appended last
 *   (g) base argv (-p + stream-json flags) is always present
 *   (h) unknown preset label throws with [claude-webview] namespace
 */
import { describe, it, expect } from "vitest";
import {
  buildSpawnArgs,
  BASE_SPAWN_ARGS,
  type SpawnArgsSettings,
} from "../../src/webview/session/spawn-args";
import {
  PERMISSION_PRESETS,
  PERMISSION_PRESET_ORDER,
  type AllowedToolName,
  type PermissionModeValue,
} from "../../src/webview/session/permission-presets";
import type { PermissionPreset } from "../../src/webview/settings-adapter";

function fxSettings(preset: PermissionPreset, extraArgs = ""): SpawnArgsSettings {
  return {
    claudePath: "claude",
    permissionPreset: preset,
    extraArgs,
  };
}

function valueAfter(args: ReadonlyArray<string>, flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

describe("spawn-args — preset → CLI flag integration (Sub-AC 2 of AC 11)", () => {
  describe("base argv (always present, regardless of preset)", () => {
    it("every spawn emits -p + stream-json I/O flags + --verbose + --include-partial-messages", () => {
      for (const preset of PERMISSION_PRESET_ORDER) {
        const { args } = buildSpawnArgs(fxSettings(preset));
        expect(args.slice(0, BASE_SPAWN_ARGS.length)).toEqual([...BASE_SPAWN_ARGS]);
        // Anchor individual flags too so a reorder of BASE_SPAWN_ARGS is loud.
        expect(args).toContain("-p");
        expect(args).toContain("--output-format");
        expect(valueAfter(args, "--output-format")).toBe("stream-json");
        expect(args).toContain("--input-format");
        expect(valueAfter(args, "--input-format")).toBe("stream-json");
        expect(args).toContain("--verbose");
        expect(args).toContain("--include-partial-messages");
      }
    });

    it("cmd equals settings.claudePath verbatim (honors user override)", () => {
      const built = buildSpawnArgs({
        claudePath: "/usr/local/bin/claude",
        permissionPreset: "standard",
        extraArgs: "",
      });
      expect(built.cmd).toBe("/usr/local/bin/claude");
    });
  });

  describe("preset → --permission-mode + --allowedTools (canonical mapping)", () => {
    it.each(PERMISSION_PRESET_ORDER)(
      "preset=%s emits --permission-mode <cfg.permissionMode> + --allowedTools <cfg.allowedTools.join(',')>",
      (preset) => {
        const cfg = PERMISSION_PRESETS[preset];
        const { args, effectivePreset, effectivePermissionMode, effectiveAllowedTools, isCustom } =
          buildSpawnArgs(fxSettings(preset));

        expect(effectivePreset).toBe(preset);
        expect(effectivePermissionMode).toBe(cfg.permissionMode);
        expect([...effectiveAllowedTools]).toEqual([...cfg.allowedTools]);
        expect(isCustom).toBe(false);

        // Argv-level check — the flags actually reach the child.
        expect(valueAfter(args, "--permission-mode")).toBe(cfg.permissionMode);
        expect(valueAfter(args, "--allowedTools")).toBe(cfg.allowedTools.join(","));
      }
    );

    it("safe preset: --permission-mode=default, --allowedTools=Read,Glob,Grep (no Bash, no Edit, no Write)", () => {
      const { args } = buildSpawnArgs(fxSettings("safe"));
      expect(valueAfter(args, "--permission-mode")).toBe("default");
      const tools = valueAfter(args, "--allowedTools") ?? "";
      expect(tools).toBe("Read,Glob,Grep");
      expect(tools).not.toContain("Bash");
      expect(tools).not.toContain("Edit");
      expect(tools).not.toContain("Write");
    });

    it("standard preset: --permission-mode=acceptEdits, includes Edit+Write+TodoWrite but NOT Bash", () => {
      const { args } = buildSpawnArgs(fxSettings("standard"));
      expect(valueAfter(args, "--permission-mode")).toBe("acceptEdits");
      const tools = valueAfter(args, "--allowedTools") ?? "";
      expect(tools).toBe("Read,Edit,Write,Glob,Grep,TodoWrite");
      expect(tools).toContain("Edit");
      expect(tools).toContain("Write");
      expect(tools).not.toContain("Bash");
    });

    it("full preset: --permission-mode=bypassPermissions, includes Bash (the material diff vs standard)", () => {
      const { args } = buildSpawnArgs(fxSettings("full"));
      expect(valueAfter(args, "--permission-mode")).toBe("bypassPermissions");
      const tools = valueAfter(args, "--allowedTools") ?? "";
      expect(tools).toBe("Read,Edit,Write,Bash,Glob,Grep,TodoWrite");
      expect(tools).toContain("Bash");
    });
  });

  describe("preset differential — a dropdown change MUST produce distinct argv", () => {
    it("all 3 presets produce pairwise-distinct --permission-mode values", () => {
      const modes = PERMISSION_PRESET_ORDER.map(
        (p) => valueAfter(buildSpawnArgs(fxSettings(p)).args, "--permission-mode")
      );
      expect(new Set(modes).size).toBe(3);
    });

    it("all 3 presets produce pairwise-distinct --allowedTools strings", () => {
      const lists = PERMISSION_PRESET_ORDER.map(
        (p) => valueAfter(buildSpawnArgs(fxSettings(p)).args, "--allowedTools")
      );
      expect(new Set(lists).size).toBe(3);
    });

    it("full argv is pairwise-distinct across the 3 presets (JSON-stringified)", () => {
      const outputs = PERMISSION_PRESET_ORDER.map((p) =>
        JSON.stringify(buildSpawnArgs(fxSettings(p)).args)
      );
      expect(new Set(outputs).size).toBe(3);
    });
  });

  describe("resume flag — UUID validation (Phase 3 post-review SR-2)", () => {
    it("rejects a malformed resumeId (non-UUID) with [claude-webview] namespace", () => {
      expect(() =>
        buildSpawnArgs(fxSettings("standard"), { resumeId: "not-a-uuid" }),
      ).toThrow(/\[claude-webview\].*resumeId must be a UUID/);
    });

    it("rejects a resumeId missing hyphens", () => {
      expect(() =>
        buildSpawnArgs(fxSettings("standard"), {
          resumeId: "d70751ee151b4b5bb5c4957c02505dc6",
        }),
      ).toThrow(/resumeId must be a UUID/);
    });
  });

  describe("mcpConfigPath — absolute-path validation (Phase 3 post-review SR-3)", () => {
    it("rejects a relative mcpConfigPath", () => {
      expect(() =>
        buildSpawnArgs(fxSettings("standard"), { mcpConfigPath: "mcp.json" }),
      ).toThrow(/mcpConfigPath must be absolute/);
    });

    it("rejects a ./-prefixed mcpConfigPath", () => {
      expect(() =>
        buildSpawnArgs(fxSettings("standard"), { mcpConfigPath: "./mcp.json" }),
      ).toThrow(/mcpConfigPath must be absolute/);
    });

    it("accepts an absolute mcpConfigPath", () => {
      const { args } = buildSpawnArgs(fxSettings("standard"), {
        mcpConfigPath: "/vault/.obsidian/plugins/obsidian-claude-code/mcp.json",
      });
      expect(args).toContain("--mcp-config");
    });
  });

  describe("resume flag — conditional on non-empty resumeId", () => {
    it("no --resume flag when options is omitted", () => {
      const { args } = buildSpawnArgs(fxSettings("standard"));
      expect(args).not.toContain("--resume");
    });

    it("no --resume flag when resumeId is empty string", () => {
      const { args } = buildSpawnArgs(fxSettings("standard"), { resumeId: "" });
      expect(args).not.toContain("--resume");
    });

    it("--resume <id> appears exactly once when resumeId is provided", () => {
      const id = "d70751ee-151b-4b5b-b5c4-957c02505dc6";
      const { args } = buildSpawnArgs(fxSettings("standard"), { resumeId: id });
      const resumeIdx = args.indexOf("--resume");
      expect(resumeIdx).toBeGreaterThan(0);
      expect(args[resumeIdx + 1]).toBe(id);
      // Exactly once — not duplicated.
      expect(args.filter((a) => a === "--resume")).toHaveLength(1);
    });
  });

  describe("mcp-config flag — conditional on non-empty path", () => {
    it("no --mcp-config flag when omitted", () => {
      const { args } = buildSpawnArgs(fxSettings("standard"));
      expect(args).not.toContain("--mcp-config");
    });

    it("--mcp-config <path> is appended when mcpConfigPath provided", () => {
      const { args } = buildSpawnArgs(fxSettings("standard"), {
        mcpConfigPath: "/tmp/mcp.json",
      });
      const idx = args.indexOf("--mcp-config");
      expect(idx).toBeGreaterThan(0);
      expect(args[idx + 1]).toBe("/tmp/mcp.json");
    });

    it("empty-string mcpConfigPath is treated as absent", () => {
      const { args } = buildSpawnArgs(fxSettings("standard"), { mcpConfigPath: "" });
      expect(args).not.toContain("--mcp-config");
    });
  });

  describe("custom overrides — allowedTools / permission-mode bypass preset", () => {
    it("allowedToolsOverride REPLACES the preset list, isCustom=true", () => {
      const custom: AllowedToolName[] = ["Read", "Bash"];
      const built = buildSpawnArgs(fxSettings("safe"), {
        allowedToolsOverride: custom,
      });
      expect(built.isCustom).toBe(true);
      expect(built.effectiveAllowedTools).toEqual(custom);
      expect(valueAfter(built.args, "--allowedTools")).toBe("Read,Bash");
      // Permission mode still comes from preset when only the tools are
      // overridden — safe → "default".
      expect(built.effectivePermissionMode).toBe("default");
      expect(valueAfter(built.args, "--permission-mode")).toBe("default");
    });

    it("permissionModeOverride REPLACES the preset mode, isCustom=true", () => {
      const built = buildSpawnArgs(fxSettings("safe"), {
        permissionModeOverride: "bypassPermissions",
      });
      expect(built.isCustom).toBe(true);
      expect(built.effectivePermissionMode).toBe("bypassPermissions");
      expect(valueAfter(built.args, "--permission-mode")).toBe("bypassPermissions");
      // Tools still come from safe preset.
      expect(valueAfter(built.args, "--allowedTools")).toBe("Read,Glob,Grep");
    });

    it("both overrides together: argv is fully custom, isCustom=true", () => {
      const built = buildSpawnArgs(fxSettings("safe"), {
        allowedToolsOverride: ["Read"],
        permissionModeOverride: "acceptEdits",
      });
      expect(built.isCustom).toBe(true);
      expect(valueAfter(built.args, "--permission-mode")).toBe("acceptEdits");
      expect(valueAfter(built.args, "--allowedTools")).toBe("Read");
    });

    it("empty allowedToolsOverride yields an empty --allowedTools argv value", () => {
      const built = buildSpawnArgs(fxSettings("standard"), {
        allowedToolsOverride: [],
      });
      expect(built.isCustom).toBe(true);
      expect(valueAfter(built.args, "--allowedTools")).toBe("");
    });

    it("isCustom=false when no overrides are passed (preset-only path)", () => {
      const built = buildSpawnArgs(fxSettings("standard"));
      expect(built.isCustom).toBe(false);
    });
  });

  describe("extraArgs — free-form user flags appended last", () => {
    it("empty / whitespace-only extraArgs produces no extra argv entries", () => {
      const { args: emptyArgs } = buildSpawnArgs(fxSettings("standard", ""));
      const { args: wsArgs } = buildSpawnArgs(fxSettings("standard", "   "));
      expect(emptyArgs).toEqual(wsArgs);
    });

    it("whitespace-split extraArgs append to the end of argv", () => {
      const { args } = buildSpawnArgs(fxSettings("standard", "--model sonnet"));
      expect(args[args.length - 2]).toBe("--model");
      expect(args[args.length - 1]).toBe("sonnet");
    });

    it("extraArgs come AFTER permission flags (so permission flags are authoritative by position)", () => {
      const { args } = buildSpawnArgs(fxSettings("standard", "--extra-flag"));
      const extraIdx = args.indexOf("--extra-flag");
      const permModeIdx = args.indexOf("--permission-mode");
      const allowedToolsIdx = args.indexOf("--allowedTools");
      expect(extraIdx).toBeGreaterThan(permModeIdx);
      expect(extraIdx).toBeGreaterThan(allowedToolsIdx);
    });

    // Phase 3 post-review SR-1 anchor: preset escalation via extraArgs must
    // throw, not silently win via `--permission-mode`'s last-occurrence rule.
    it("rejects --permission-mode in extraArgs (Safe→Full escalation defense)", () => {
      expect(() =>
        buildSpawnArgs(fxSettings("safe", "--permission-mode bypassPermissions")),
      ).toThrow(/extraArgs rejected.*permission-mode/);
    });

    it("rejects --allowedTools in extraArgs", () => {
      expect(() =>
        buildSpawnArgs(fxSettings("safe", "--allowedTools Bash")),
      ).toThrow(/extraArgs rejected.*allowedTools/);
    });

    it("rejects --dangerously-skip-permissions in extraArgs", () => {
      expect(() =>
        buildSpawnArgs(fxSettings("safe", "--dangerously-skip-permissions")),
      ).toThrow(/extraArgs rejected.*dangerously-skip-permissions/);
    });

    // Pre-landing review (Plan B Lifecycle+Security): the original guard only
    // matched `--flag value` (split form). A user typing the equals form
    // `--permission-mode=bypassPermissions` as a single token slipped past
    // and silently escalated Safe → Full because claude -p honors both forms
    // AND the last occurrence per flag.
    it.each([
      "--permission-mode=bypassPermissions",
      "--allowedTools=Bash",
      "--allowed-tools=Bash",
      "--dangerously-skip-permissions=true",
      "--mcp-config=/etc/passwd",
      "--append-system-prompt-file=/tmp/x",
      "--resume=00000000-0000-0000-0000-000000000000",
    ])(
      "rejects equals-form bypass: %s",
      (token) => {
        expect(() => buildSpawnArgs(fxSettings("safe", token))).toThrow(
          /extraArgs rejected/,
        );
      },
    );

    // Pre-landing review (Plan B): forbidden list extended to cover flags
    // that subvert the preset → permission contract or corrupt the JSONL
    // protocol the parser depends on.
    it.each([
      "--permission-prompt-tool",
      "--add-dir",
      "--system-prompt",
      "--disallowed-tools",
      "--disallowedTools",
      "--output-format",
      "--input-format",
      "--include-partial-messages",
      "--verbose",
    ])(
      "rejects newly-forbidden flag in extraArgs: %s",
      (flag) => {
        expect(() => buildSpawnArgs(fxSettings("safe", `${flag} value`))).toThrow(
          /extraArgs rejected/,
        );
      },
    );
  });

  describe("error-surface discipline — unknown preset label", () => {
    it("throws with [claude-webview] namespace on unknown preset (no silent fallback)", () => {
      const bogus = "ultra" as unknown as PermissionPreset;
      expect(() =>
        buildSpawnArgs({
          claudePath: "claude",
          permissionPreset: bogus,
          extraArgs: "",
        })
      ).toThrow(/\[claude-webview\].*unknown permission preset: ultra/);
    });
  });

  describe("deterministic argv ordering (snapshot-free)", () => {
    it("two calls with the same inputs produce identical argv arrays (pure function)", () => {
      const a = buildSpawnArgs(fxSettings("standard"), {
        resumeId: "d70751ee-151b-4b5b-b5c4-957c02505dc6",
        mcpConfigPath: "/x.json",
      });
      const b = buildSpawnArgs(fxSettings("standard"), {
        resumeId: "d70751ee-151b-4b5b-b5c4-957c02505dc6",
        mcpConfigPath: "/x.json",
      });
      expect(a.args).toEqual(b.args);
      expect(a.cmd).toBe(b.cmd);
    });

    it("permission flags come BEFORE optional flags (--resume / --mcp-config)", () => {
      const { args } = buildSpawnArgs(fxSettings("standard"), {
        resumeId: "d70751ee-151b-4b5b-b5c4-957c02505dc6",
        mcpConfigPath: "/cfg.json",
      });
      const permIdx = args.indexOf("--permission-mode");
      const toolsIdx = args.indexOf("--allowedTools");
      const mcpIdx = args.indexOf("--mcp-config");
      const resumeIdx = args.indexOf("--resume");
      expect(permIdx).toBeLessThan(mcpIdx);
      expect(toolsIdx).toBeLessThan(mcpIdx);
      expect(permIdx).toBeLessThan(resumeIdx);
    });
  });

  describe("type-surface echo-back (effective* fields match argv)", () => {
    it("effectivePermissionMode round-trips the same string placed in argv", () => {
      for (const preset of PERMISSION_PRESET_ORDER) {
        const built = buildSpawnArgs(fxSettings(preset));
        const argvMode = valueAfter(built.args, "--permission-mode");
        expect(argvMode).toBe(built.effectivePermissionMode);
      }
    });

    it("effectiveAllowedTools.join(',') round-trips the same string placed in argv", () => {
      for (const preset of PERMISSION_PRESET_ORDER) {
        const built = buildSpawnArgs(fxSettings(preset));
        const argvTools = valueAfter(built.args, "--allowedTools");
        expect(argvTools).toBe([...built.effectiveAllowedTools].join(","));
      }
    });

    it("PermissionModeValue union stays in lockstep with emitted argv (type-level anchor)", () => {
      const modes: ReadonlyArray<PermissionModeValue> = [
        "default",
        "acceptEdits",
        "bypassPermissions",
      ];
      expect(modes).toHaveLength(3);
      // Every preset's effective mode is a member of the union.
      for (const preset of PERMISSION_PRESET_ORDER) {
        const built = buildSpawnArgs(fxSettings(preset));
        expect(modes).toContain(built.effectivePermissionMode);
      }
    });
  });
});
