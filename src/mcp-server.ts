import { App, Notice, TFile, WorkspaceLeaf } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import { MCP_CONTEXT_FILE, MCP_SERVER_SCRIPT, MCP_SERVER_NAME, MCP_PROMPT_FILE, CONTEXT_UPDATE_DEBOUNCE_MS } from "./constants";

interface ObsidianContext {
  vaultPath: string;
  activeFile: { path: string; basename: string } | null;
  openFiles: Array<{ path: string; basename: string }>;
  timestamp: number;
}

export class McpContextBridge {
  private readonly contextFilePath: string;
  private readonly serverScriptPath: string;
  private readonly promptFilePath: string;
  private updateTimeout: ReturnType<typeof setTimeout> | null = null;
  private scriptReady = false;

  constructor(
    private readonly app: App,
    private readonly pluginDir: string,
    private readonly vaultPath: string
  ) {
    this.contextFilePath = path.join(pluginDir, MCP_CONTEXT_FILE);
    this.serverScriptPath = path.join(pluginDir, MCP_SERVER_SCRIPT);
    this.promptFilePath = path.join(pluginDir, MCP_PROMPT_FILE);
  }

  getPromptFilePath(): string {
    return this.promptFilePath;
  }

  /** Returns false if setup failed (script could not be written). */
  setup(): boolean {
    this.scriptReady = this.writeServerScript();
    if (!this.scriptReady) {
      new Notice("MCP server script could not be written. MCP context sharing is disabled.");
      return false;
    }
    this.updateContext();
    return true;
  }

  scheduleContextUpdate(): void {
    if (this.updateTimeout) clearTimeout(this.updateTimeout);
    this.updateTimeout = setTimeout(() => this.updateContext(), CONTEXT_UPDATE_DEBOUNCE_MS);
  }

  writeMcpConfig(cwd: string): void {
    if (!this.scriptReady) return;

    const resolvedCwd = path.resolve(cwd);
    if (!fs.existsSync(resolvedCwd) || !fs.statSync(resolvedCwd).isDirectory()) {
      return;
    }

    const mcpConfigPath = path.join(resolvedCwd, ".mcp.json");
    let config: Record<string, unknown> = {};

    try {
      if (fs.existsSync(mcpConfigPath)) {
        config = JSON.parse(fs.readFileSync(mcpConfigPath, "utf8")) as Record<string, unknown>;
      }
    } catch {
      // Invalid JSON — start fresh
    }

    const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
    servers[MCP_SERVER_NAME] = {
      command: "node",
      args: [this.serverScriptPath, this.contextFilePath],
    };
    config.mcpServers = servers;

    try {
      fs.writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2));
    } catch {
      new Notice("Failed to write MCP config to .mcp.json");
    }

    this.writeToolPermissions(resolvedCwd);
  }

  private writeToolPermissions(cwd: string): void {
    const claudeDir = path.join(cwd, ".claude");
    try {
      if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
      }
    } catch {
      return;
    }

    const settingsPath = path.join(claudeDir, "settings.local.json");
    let settings: Record<string, unknown> = {};

    try {
      if (fs.existsSync(settingsPath)) {
        settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
      }
    } catch {
      // Invalid JSON — start fresh
    }

    const permissions = (settings.permissions ?? {}) as Record<string, unknown>;
    const allowList = (permissions.allow ?? []) as string[];
    const mcpPattern = `mcp__${MCP_SERVER_NAME}`;

    if (!allowList.includes(mcpPattern)) {
      allowList.push(mcpPattern);
      permissions.allow = allowList;
      settings.permissions = permissions;

      try {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      } catch {
        // Best effort
      }
    }
  }

  removeMcpConfig(cwd: string): void {
    const resolvedCwd = path.resolve(cwd);

    // Remove MCP server entry from .mcp.json
    const mcpConfigPath = path.join(resolvedCwd, ".mcp.json");
    try {
      if (fs.existsSync(mcpConfigPath)) {
        const config = JSON.parse(fs.readFileSync(mcpConfigPath, "utf8")) as Record<string, unknown>;
        const servers = config.mcpServers as Record<string, unknown> | undefined;
        if (servers && MCP_SERVER_NAME in servers) {
          delete servers[MCP_SERVER_NAME];
          if (Object.keys(servers).length === 0) {
            delete config.mcpServers;
          }
          fs.writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2));
        }
      }
    } catch {
      // Best effort cleanup
    }

    // Remove tool permission from .claude/settings.local.json
    const settingsPath = path.join(resolvedCwd, ".claude", "settings.local.json");
    try {
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
        const permissions = settings.permissions as Record<string, unknown> | undefined;
        const allowList = permissions?.allow as string[] | undefined;
        if (allowList) {
          const mcpPattern = `mcp__${MCP_SERVER_NAME}`;
          const filtered = allowList.filter((p) => p !== mcpPattern);
          if (filtered.length !== allowList.length) {
            permissions!.allow = filtered;
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
          }
        }
      }
    } catch {
      // Best effort cleanup
    }
  }

  dispose(): void {
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
      this.updateTimeout = null;
    }
    try {
      fs.unlinkSync(this.contextFilePath);
    } catch {
      // File may not exist
    }
  }

  private updateContext(): void {
    const activeFile = this.app.workspace.getActiveFile();
    const openFiles = this.getOpenFiles();

    const context: ObsidianContext = {
      vaultPath: this.vaultPath,
      activeFile: activeFile
        ? { path: activeFile.path, basename: activeFile.basename }
        : null,
      openFiles,
      timestamp: Date.now(),
    };

    try {
      fs.writeFileSync(this.contextFilePath, JSON.stringify(context, null, 2));
    } catch (err) {
      console.error("[obsidian-claude] Failed to write MCP context file:", err);
    }

    this.writeSystemPrompt(activeFile, openFiles);
  }

  private writeSystemPrompt(
    activeFile: TFile | null,
    openFiles: Array<{ path: string; basename: string }>
  ): void {
    const lines: string[] = [];

    if (openFiles.length > 0) {
      const paths = openFiles.map((f) => f.path).join(", ");
      lines.push(`[Obsidian] Open notes: ${paths}`);
    } else {
      lines.push("[Obsidian] No notes currently open.");
    }

    if (activeFile) {
      lines.push(`Active note: ${activeFile.path}`);
    }

    lines.push("(Use get_active_note or read_note MCP tools for note content)");

    const encodedVault = encodeURIComponent(this.app.vault.getName());
    lines.push(
      "",
      "When you reference a vault note in your reply, format it as an Obsidian URL so the user can Cmd/Ctrl+click it:",
      `  [<basename>](obsidian://open?vault=${encodedVault}&path=<url-encoded-vault-relative-path-with-extension>)`,
      `Example: [llm-strategic-bias](obsidian://open?vault=${encodedVault}&path=personal-wiki%2Fconcepts%2Fllm-strategic-bias.md)`,
      "Use this format only for files that exist in the user's vault. Always include the file extension.",
      "CRITICAL: percent-encode the entire path. Spaces must become %20, Korean and other non-ASCII chars must be encodeURIComponent'd. A literal space in the URL breaks click handling when the line wraps in the sidebar."
    );

    try {
      fs.writeFileSync(this.promptFilePath, lines.join("\n") + "\n");
    } catch {
      // Best effort
    }
  }

  private getOpenFiles(): Array<{ path: string; basename: string }> {
    const seen = new Set<string>();
    const files: Array<{ path: string; basename: string }> = [];

    this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
      const file = (leaf.view as unknown as { file?: TFile }).file;
      if (file instanceof TFile && !seen.has(file.path)) {
        seen.add(file.path);
        files.push({ path: file.path, basename: file.basename });
      }
    });

    return files;
  }

  private writeServerScript(): boolean {
    const script = buildMcpServerScript();
    try {
      fs.writeFileSync(this.serverScriptPath, script, { mode: 0o755 });
      return true;
    } catch {
      return false;
    }
  }
}

function buildMcpServerScript(): string {
  return `#!/usr/bin/env node
"use strict";

var fs = require("fs");
var path = require("path");
var readline = require("readline");

var CONTEXT_FILE = process.argv[2];
if (!CONTEXT_FILE) {
  process.stderr.write("Usage: node obsidian-mcp-server.cjs <context-file-path>\\n");
  process.exit(1);
}

function readContext() {
  try {
    var ctx = JSON.parse(fs.readFileSync(CONTEXT_FILE, "utf8"));
    if (!ctx.vaultPath) return null;
    return ctx;
  } catch (e) {
    return null;
  }
}

function isInsideVault(vaultPath, targetPath) {
  var resolved = path.resolve(vaultPath, targetPath);
  var vaultResolved = path.resolve(vaultPath) + path.sep;
  return resolved.startsWith(vaultResolved) || resolved === path.resolve(vaultPath);
}

function readFileContent(vaultPath, notePath) {
  if (!isInsideVault(vaultPath, notePath)) return null;
  try {
    return fs.readFileSync(path.resolve(vaultPath, notePath), "utf8");
  } catch (e) {
    return null;
  }
}

var TOOLS = [
  {
    name: "get_active_note",
    description: "Get the currently active/focused note in Obsidian. Returns the vault-relative path and full content of the note the user is currently viewing.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "list_open_notes",
    description: "List all currently open notes (tabs) in Obsidian. Returns an array of vault-relative paths for each open note.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "read_note",
    description: "Read the full content of a note by its vault-relative path.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Vault-relative path to the note (e.g. 'folder/note.md')"
        }
      },
      required: ["path"]
    }
  },
  {
    name: "search_notes",
    description: "Search for notes in the Obsidian vault by filename pattern. Returns matching file paths (max 50).",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to match against file names (case-insensitive substring match)"
        }
      },
      required: ["query"]
    }
  }
];

var MAX_WALK_FILES = 10000;

function walkDir(dir, base, counter) {
  var results = [];
  if (counter.n >= MAX_WALK_FILES) return results;
  try {
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      if (counter.n >= MAX_WALK_FILES) break;
      var entry = entries[i];
      if (entry.name.startsWith(".")) continue;
      var rel = base ? base + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        results = results.concat(walkDir(path.join(dir, entry.name), rel, counter));
      } else if (entry.name.endsWith(".md")) {
        results.push(rel);
        counter.n++;
      }
    }
  } catch (e) { /* skip unreadable dirs */ }
  return results;
}

function contextUnavailableError() {
  return {
    content: [{ type: "text", text: "Obsidian context is unavailable. The plugin may not be running." }],
    isError: true
  };
}

function handleToolCall(name, args) {
  var ctx = readContext();
  if (!ctx) return contextUnavailableError();

  switch (name) {
    case "get_active_note": {
      if (!ctx.activeFile) {
        return { content: [{ type: "text", text: "No active note open in Obsidian." }] };
      }
      var content = readFileContent(ctx.vaultPath, ctx.activeFile.path);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            path: ctx.activeFile.path,
            basename: ctx.activeFile.basename,
            content: content != null ? content : "(unable to read file)"
          }, null, 2)
        }]
      };
    }

    case "list_open_notes": {
      if (!ctx.openFiles || ctx.openFiles.length === 0) {
        return { content: [{ type: "text", text: "No notes are currently open in Obsidian." }] };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify(ctx.openFiles, null, 2)
        }]
      };
    }

    case "read_note": {
      var notePath = args && args.path;
      if (!notePath) {
        return { content: [{ type: "text", text: "Error: 'path' parameter is required." }], isError: true };
      }
      if (!isInsideVault(ctx.vaultPath, notePath)) {
        return { content: [{ type: "text", text: "Error: path is outside the vault." }], isError: true };
      }
      var noteContent = readFileContent(ctx.vaultPath, notePath);
      if (noteContent == null) {
        return { content: [{ type: "text", text: "Note not found: " + notePath }], isError: true };
      }
      return { content: [{ type: "text", text: noteContent }] };
    }

    case "search_notes": {
      var query = args && args.query;
      if (!query) {
        return { content: [{ type: "text", text: "Error: 'query' parameter is required." }], isError: true };
      }
      var allFiles = walkDir(ctx.vaultPath, "", { n: 0 });
      var lowerQuery = query.toLowerCase();
      var matches = allFiles.filter(function(f) {
        return f.toLowerCase().indexOf(lowerQuery) !== -1;
      }).slice(0, 50);
      if (matches.length === 0) {
        return { content: [{ type: "text", text: "No notes matching: " + query }] };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify(matches, null, 2)
        }]
      };
    }

    default:
      return { content: [{ type: "text", text: "Unknown tool: " + name }], isError: true };
  }
}

// MCP stdio transport — newline-delimited JSON-RPC 2.0
var rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

rl.on("line", function(line) {
  var request;
  try {
    request = JSON.parse(line);
  } catch (e) {
    return;
  }

  var id = request.id;
  var method = request.method;
  var params = request.params || {};

  // Notifications (no id) — no response
  if (id === undefined || id === null) return;

  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "obsidian-context", version: "0.1.0" }
        }
      });
      break;

    case "tools/list":
      send({
        jsonrpc: "2.0",
        id: id,
        result: { tools: TOOLS }
      });
      break;

    case "tools/call":
      try {
        var result = handleToolCall(params.name, params.arguments || {});
        send({ jsonrpc: "2.0", id: id, result: result });
      } catch (err) {
        send({
          jsonrpc: "2.0",
          id: id,
          result: {
            content: [{ type: "text", text: "Error: " + (err.message || String(err)) }],
            isError: true
          }
        });
      }
      break;

    case "ping":
      send({ jsonrpc: "2.0", id: id, result: {} });
      break;

    default:
      send({
        jsonrpc: "2.0",
        id: id,
        error: { code: -32601, message: "Method not found: " + method }
      });
  }
});

process.stdin.resume();
`;
}
