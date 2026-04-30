import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildObsidianLinkInstruction,
  buildWikilinkInstruction,
  SystemPromptWriter,
  type ObsidianLinkStyle,
} from "../src/system-prompt-writer";
import { MCP_PROMPT_FILE } from "../src/constants";

describe("buildObsidianLinkInstruction", () => {
  it("emits the canonical URL template with encoded vault name", () => {
    const lines = buildObsidianLinkInstruction("test-vault");
    const joined = lines.join("\n");
    expect(joined).toContain("obsidian://open?vault=test-vault&path=");
  });

  it("percent-encodes spaces in the vault name", () => {
    const joined = buildObsidianLinkInstruction("test vault").join("\n");
    expect(joined).toContain("vault=test%20vault");
    expect(joined).not.toContain("vault=test vault");
  });

  it("percent-encodes Korean (non-ASCII) vault names", () => {
    const joined = buildObsidianLinkInstruction("한글금고").join("\n");
    // encodeURIComponent("한글금고") => %ED%95%9C%EA%B8%80%EA%B8%88%EA%B3%A0
    expect(joined).toContain(encodeURIComponent("한글금고"));
    expect(joined).not.toContain("한글금고&"); // raw name not followed by next param
  });

  it("percent-encodes reserved URL chars in the vault name", () => {
    const joined = buildObsidianLinkInstruction("A&B?C").join("\n");
    expect(joined).toContain("vault=A%26B%3FC");
  });

  it("is deterministic — repeated calls produce identical output", () => {
    const a = buildObsidianLinkInstruction("v").join("\n");
    const b = buildObsidianLinkInstruction("v").join("\n");
    expect(a).toBe(b);
  });
});

describe("buildWikilinkInstruction", () => {
  it("emits the [[basename]] template and explains it", () => {
    const joined = buildWikilinkInstruction().join("\n");
    expect(joined).toContain("[[<vault-relative-path-without-extension>]]");
    expect(joined).toContain("[[ep10-smartviz]]");
  });

  it("does NOT mention obsidian:// URLs (avoids vault-name lookup)", () => {
    const joined = buildWikilinkInstruction().join("\n");
    expect(joined).not.toContain("obsidian://");
    expect(joined).not.toContain("vault=");
  });

  it("instructs Claude to omit the .md extension", () => {
    const joined = buildWikilinkInstruction().join("\n");
    expect(joined.toLowerCase()).toContain("do not include the .md extension");
  });

  it("is deterministic — vault-name-free", () => {
    const a = buildWikilinkInstruction().join("\n");
    const b = buildWikilinkInstruction().join("\n");
    expect(a).toBe(b);
  });
});

describe("SystemPromptWriter", () => {
  let tmpDir: string;
  let writer: SystemPromptWriter;
  let vaultName: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "syspromptwriter-"));
    vaultName = "my-vault";
    writer = new SystemPromptWriter(tmpDir, () => vaultName);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("getPromptFilePath returns <pluginDir>/<MCP_PROMPT_FILE>", () => {
    expect(writer.getPromptFilePath()).toBe(path.join(tmpDir, MCP_PROMPT_FILE));
  });

  describe("writeBase", () => {
    it("writes a file containing the URL instruction", () => {
      writer.writeBase();
      const content = fs.readFileSync(writer.getPromptFilePath(), "utf8");
      expect(content).toContain("obsidian://open?vault=my-vault&path=");
    });

    it("does NOT include any context marker lines", () => {
      writer.writeBase();
      const content = fs.readFileSync(writer.getPromptFilePath(), "utf8");
      expect(content).not.toContain("[Obsidian] Open notes:");
      expect(content).not.toContain("Active note:");
    });

    it("is idempotent — two calls produce identical content", () => {
      writer.writeBase();
      const first = fs.readFileSync(writer.getPromptFilePath(), "utf8");
      writer.writeBase();
      const second = fs.readFileSync(writer.getPromptFilePath(), "utf8");
      expect(first).toBe(second);
    });
  });

  describe("writeWithContext", () => {
    it("writes context lines first, followed by the URL instruction", () => {
      writer.writeWithContext(["[Obsidian] Open notes: a.md", "Active note: a.md"]);
      const content = fs.readFileSync(writer.getPromptFilePath(), "utf8");
      const contextIdx = content.indexOf("[Obsidian] Open notes:");
      const urlIdx = content.indexOf("obsidian://open?vault=");
      expect(contextIdx).toBeGreaterThanOrEqual(0);
      expect(urlIdx).toBeGreaterThan(contextIdx);
    });

    it("empty context array produces same content as writeBase", () => {
      writer.writeWithContext([]);
      const withEmpty = fs.readFileSync(writer.getPromptFilePath(), "utf8");
      writer.writeBase();
      const base = fs.readFileSync(writer.getPromptFilePath(), "utf8");
      expect(withEmpty).toBe(base);
    });

    it("writeWithContext then writeBase strips context (no leakage)", () => {
      writer.writeWithContext(["[Obsidian] Open notes: x.md"]);
      writer.writeBase();
      const content = fs.readFileSync(writer.getPromptFilePath(), "utf8");
      expect(content).not.toContain("[Obsidian] Open notes:");
      expect(content).toContain("obsidian://open?vault=my-vault&path=");
    });
  });

  describe("vault name getter", () => {
    it("calls the getter on each write, not at construction", () => {
      writer.writeBase();
      const first = fs.readFileSync(writer.getPromptFilePath(), "utf8");
      expect(first).toContain("vault=my-vault&");

      vaultName = "renamed-vault";
      writer.writeBase();
      const second = fs.readFileSync(writer.getPromptFilePath(), "utf8");
      expect(second).toContain("vault=renamed-vault&");
      expect(second).not.toContain("vault=my-vault&");
    });
  });

  describe("link style", () => {
    it("default (no closure) uses URL syntax — backwards compatible", () => {
      writer.writeBase();
      const content = fs.readFileSync(writer.getPromptFilePath(), "utf8");
      expect(content).toContain("obsidian://open?vault=my-vault");
      expect(content).not.toContain("[[<vault-relative-path");
    });

    it("wikilink style emits [[basename]] and no obsidian:// URL", () => {
      const wikiWriter = new SystemPromptWriter(
        tmpDir,
        () => "ignored",
        () => "wikilink",
      );
      wikiWriter.writeBase();
      const content = fs.readFileSync(wikiWriter.getPromptFilePath(), "utf8");
      expect(content).toContain("[[<vault-relative-path-without-extension>]]");
      expect(content).not.toContain("obsidian://");
      expect(content).not.toContain("vault=");
    });

    it("getLinkStyle is called on each write — toggle takes effect on next write", () => {
      let style: ObsidianLinkStyle = "url";
      const togglingWriter = new SystemPromptWriter(
        tmpDir,
        () => vaultName,
        () => style,
      );
      togglingWriter.writeBase();
      const beforeToggle = fs.readFileSync(
        togglingWriter.getPromptFilePath(),
        "utf8",
      );
      expect(beforeToggle).toContain("obsidian://open?vault=my-vault");

      style = "wikilink";
      togglingWriter.writeBase();
      const afterToggle = fs.readFileSync(
        togglingWriter.getPromptFilePath(),
        "utf8",
      );
      expect(afterToggle).toContain("[[<vault-relative-path");
      expect(afterToggle).not.toContain("obsidian://");
    });

    it("wikilink style + writeWithContext keeps context but swaps the link block", () => {
      const wikiWriter = new SystemPromptWriter(
        tmpDir,
        () => "ignored",
        () => "wikilink",
      );
      wikiWriter.writeWithContext([
        "[Obsidian] Open notes: a.md",
        "Active note: a.md",
      ]);
      const content = fs.readFileSync(wikiWriter.getPromptFilePath(), "utf8");
      const ctxIdx = content.indexOf("[Obsidian] Open notes:");
      const wikiIdx = content.indexOf("[[<vault-relative-path");
      expect(ctxIdx).toBeGreaterThanOrEqual(0);
      expect(wikiIdx).toBeGreaterThan(ctxIdx);
      expect(content).not.toContain("obsidian://open");
    });
  });

  describe("dispose", () => {
    it("removes the prompt file", () => {
      writer.writeBase();
      expect(fs.existsSync(writer.getPromptFilePath())).toBe(true);
      writer.dispose();
      expect(fs.existsSync(writer.getPromptFilePath())).toBe(false);
    });

    it("tolerates missing file (no throw)", () => {
      expect(() => writer.dispose()).not.toThrow();
    });
  });

  describe("atomic write behavior", () => {
    it("leaves no .tmp file behind on successful write", () => {
      writer.writeBase();
      const entries = fs.readdirSync(tmpDir);
      expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
    });
  });
});
