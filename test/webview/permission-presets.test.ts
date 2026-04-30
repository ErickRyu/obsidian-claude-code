/**
 * Sub-AC 1 of AC 11 — Permission preset config contract.
 *
 * Locks the typed mapping of each preset (`safe` / `standard` / `full`)
 * to its `--permission-mode` value and default `--allowedTools` list.
 * Phase 3's `spawn-args.ts` and Phase 4b's `permission-dropdown.ts` both
 * consume this module; downstream differential tests (3-1 preset produces
 * distinct allowedTools, 4b-1 dropdown change reflects in next spawn args)
 * rely on the inequality and presence assertions below to stay true.
 *
 * Assertion style: key-field checks on the exported const + function
 * round-trips.  No HTML, no DOM, no fixture replay — this is a pure
 * config-surface contract.
 */
import { describe, it, expect } from "vitest";
import {
  PERMISSION_PRESETS,
  PERMISSION_PRESET_ORDER,
  getPermissionPresetConfig,
  isPermissionPreset,
  type AllowedToolName,
  type PermissionModeValue,
} from "../../src/webview/session/permission-presets";
import {
  DEFAULT_WEBVIEW_SETTINGS,
  type PermissionPreset,
} from "../../src/webview/settings-adapter";

describe("permission-presets — typed preset → (permissionMode, allowedTools) mapping", () => {
  describe("preset order + coverage", () => {
    it("exports exactly 3 presets in safety-gradient order (safe, standard, full)", () => {
      expect(PERMISSION_PRESET_ORDER).toEqual(["safe", "standard", "full"]);
    });

    it("PERMISSION_PRESETS has a config entry for every label in the union", () => {
      for (const label of PERMISSION_PRESET_ORDER) {
        expect(PERMISSION_PRESETS[label]).toBeDefined();
        expect(PERMISSION_PRESETS[label].preset).toBe(label);
      }
    });

    it("default permissionPreset ('standard') has a config entry", () => {
      const cfg = PERMISSION_PRESETS[DEFAULT_WEBVIEW_SETTINGS.permissionPreset];
      expect(cfg).toBeDefined();
      expect(cfg.preset).toBe("standard");
    });
  });

  describe("per-preset allowedTools contracts (Phase 3 spawn-args source of truth)", () => {
    it("safe → Read / Glob / Grep only (no Edit, no Write, no Bash, no TodoWrite)", () => {
      const cfg = PERMISSION_PRESETS.safe;
      expect(cfg.allowedTools).toEqual(["Read", "Glob", "Grep"]);
      expect(cfg.allowedTools).not.toContain("Edit");
      expect(cfg.allowedTools).not.toContain("Write");
      expect(cfg.allowedTools).not.toContain("Bash");
      expect(cfg.allowedTools).not.toContain("TodoWrite");
    });

    it("standard → Read / Edit / Write / Glob / Grep / TodoWrite (no Bash)", () => {
      const cfg = PERMISSION_PRESETS.standard;
      expect(cfg.allowedTools).toEqual([
        "Read",
        "Edit",
        "Write",
        "Glob",
        "Grep",
        "TodoWrite",
      ]);
      expect(cfg.allowedTools).not.toContain("Bash");
    });

    it("full → standard + Bash (the material difference vs standard)", () => {
      const cfg = PERMISSION_PRESETS.full;
      expect(cfg.allowedTools).toEqual([
        "Read",
        "Edit",
        "Write",
        "Bash",
        "Glob",
        "Grep",
        "TodoWrite",
      ]);
      expect(cfg.allowedTools).toContain("Bash");
    });
  });

  describe("per-preset permissionMode contracts", () => {
    it("safe → 'default' (prompt before every tool)", () => {
      expect(PERMISSION_PRESETS.safe.permissionMode).toBe("default");
    });

    it("standard → 'acceptEdits' (auto-accept file edits)", () => {
      expect(PERMISSION_PRESETS.standard.permissionMode).toBe("acceptEdits");
    });

    it("full → 'bypassPermissions' (auto-accept everything including Bash)", () => {
      expect(PERMISSION_PRESETS.full.permissionMode).toBe("bypassPermissions");
    });
  });

  describe("differential — each preset is distinct on BOTH axes (dropdown change must matter)", () => {
    it("all 3 permissionMode values are distinct", () => {
      const modes = PERMISSION_PRESET_ORDER.map(
        (p) => PERMISSION_PRESETS[p].permissionMode
      );
      expect(new Set(modes).size).toBe(3);
    });

    it("all 3 allowedTools sets are distinct (set-equality)", () => {
      const sets = PERMISSION_PRESET_ORDER.map(
        (p) => [...PERMISSION_PRESETS[p].allowedTools].sort().join(",")
      );
      expect(new Set(sets).size).toBe(3);
    });

    it("monotonic permissivity — safe ⊂ standard ⊂ full on allowedTools", () => {
      const safe = new Set(PERMISSION_PRESETS.safe.allowedTools);
      const standard = new Set(PERMISSION_PRESETS.standard.allowedTools);
      const full = new Set(PERMISSION_PRESETS.full.allowedTools);
      for (const t of safe) expect(standard.has(t)).toBe(true);
      for (const t of standard) expect(full.has(t)).toBe(true);
      expect(standard.size).toBeGreaterThan(safe.size);
      expect(full.size).toBeGreaterThan(standard.size);
    });
  });

  describe("human-readable labels + descriptions (dropdown copy anchored to config)", () => {
    it("every preset exposes a non-empty label + description", () => {
      for (const p of PERMISSION_PRESET_ORDER) {
        const cfg = PERMISSION_PRESETS[p];
        expect(cfg.label.length).toBeGreaterThan(0);
        expect(cfg.description.length).toBeGreaterThan(0);
      }
    });

    it("labels are title-case English (Safe / Standard / Full)", () => {
      expect(PERMISSION_PRESETS.safe.label).toBe("Safe");
      expect(PERMISSION_PRESETS.standard.label).toBe("Standard");
      expect(PERMISSION_PRESETS.full.label).toBe("Full");
    });
  });

  describe("getPermissionPresetConfig — resolver discipline", () => {
    it("returns the matching config for every valid label", () => {
      for (const p of PERMISSION_PRESET_ORDER) {
        expect(getPermissionPresetConfig(p)).toBe(PERMISSION_PRESETS[p]);
      }
    });

    it("throws with [claude-webview] namespace on unknown label (no silent fallback)", () => {
      // Cast to bypass the union type — simulates a settings-migration bug
      // where a stale/malformed value slipped past validation.
      const bogus = "ultra" as unknown as PermissionPreset;
      expect(() => getPermissionPresetConfig(bogus)).toThrow(
        /\[claude-webview\].*unknown permission preset: ultra/
      );
    });
  });

  describe("isPermissionPreset — runtime guard for untrusted input", () => {
    it("returns true for every valid label", () => {
      for (const p of PERMISSION_PRESET_ORDER) {
        expect(isPermissionPreset(p)).toBe(true);
      }
    });

    it("returns false for malformed / foreign input", () => {
      expect(isPermissionPreset("ultra")).toBe(false);
      expect(isPermissionPreset("")).toBe(false);
      expect(isPermissionPreset("SAFE")).toBe(false);
      expect(isPermissionPreset(null)).toBe(false);
      expect(isPermissionPreset(undefined)).toBe(false);
      expect(isPermissionPreset(42)).toBe(false);
      expect(isPermissionPreset({ preset: "safe" })).toBe(false);
    });
  });

  describe("type-surface shape (compile-time contract mirrored at runtime)", () => {
    it("PermissionModeValue union accepts the 3 canonical CLI values", () => {
      // If either of these lines stops type-checking the production union
      // diverged — compile-time gate reinforced by a runtime no-op.
      const modes: ReadonlyArray<PermissionModeValue> = [
        "default",
        "acceptEdits",
        "bypassPermissions",
      ];
      expect(modes).toHaveLength(3);
    });

    it("AllowedToolName union covers every tool used across the 3 presets", () => {
      const used = new Set<AllowedToolName>();
      for (const p of PERMISSION_PRESET_ORDER) {
        for (const t of PERMISSION_PRESETS[p].allowedTools) used.add(t);
      }
      // All 7 canonical tool names appear across the 3 presets.
      expect(used.size).toBe(7);
      for (const t of [
        "Read",
        "Edit",
        "Write",
        "Bash",
        "Glob",
        "Grep",
        "TodoWrite",
      ] as const) {
        expect(used.has(t)).toBe(true);
      }
    });

    it("allowedTools arrays are readonly at the type layer (sanity — runtime arrays allow copy-spread)", () => {
      const cfg = PERMISSION_PRESETS.standard;
      // Spread copy succeeds — consumers should always copy before mutating.
      const copy = [...cfg.allowedTools];
      copy.push("Bash");
      expect(copy).toContain("Bash");
      expect(cfg.allowedTools).not.toContain("Bash");
    });
  });
});
