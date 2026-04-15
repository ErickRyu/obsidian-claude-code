import { addIcon, Editor, MarkdownView, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import * as path from "path";
import {
  VIEW_TYPE_CLAUDE_TERMINAL,
  COMMAND_TOGGLE_TERMINAL,
  COMMAND_SEND_SELECTION,
  COMMAND_SEND_FILE,
  COMMAND_FOCUS_TERMINAL,
  COMMAND_NEW_TERMINAL,
} from "./constants";
import { ClaudeTerminalView, wrapBackticks } from "./claude-terminal-view";
import {
  ClaudeTerminalSettings,
  ClaudeTerminalSettingTab,
  DEFAULT_SETTINGS,
} from "./settings";
import { ensureNodePty } from "./native-bootstrap";
import { McpContextBridge } from "./mcp-server";
import { SystemPromptWriter } from "./system-prompt-writer";
import { EmissionMetrics } from "./emission-metrics";

export default class ClaudeTerminalPlugin extends Plugin {
  settings: ClaudeTerminalSettings = DEFAULT_SETTINGS;
  private lastNonTerminalLeaf: WorkspaceLeaf | null = null;
  private lastActiveTerminalLeaf: WorkspaceLeaf | null = null;
  private mcpBridge: McpContextBridge | null = null;
  private promptWriter: SystemPromptWriter | null = null;
  private emissionMetrics: EmissionMetrics | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Register Claude AI logo icon for sidebar
    addIcon(
      "claude-ai",
      `<g transform="scale(6.25)"><path fill="currentColor" d="m3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871z"/></g>`
    );


    // Auto-download node-pty native binary if missing
    const pluginDir = this.getPluginDir();
    ensureNodePty(pluginDir).catch(() => {
      // Logged via Notice inside ensureNodePty
    });

    // Prompt file must exist before any terminal view spawns claude CLI,
    // including views Obsidian restores from a prior session. Create the
    // writer and write its baseline BEFORE registerView.
    this.promptWriter = new SystemPromptWriter(
      pluginDir,
      () => this.app.vault.getName()
    );
    this.promptWriter.writeBase();

    // Shared across all terminal views so ratios reflect the whole session,
    // not a single tab. Logged on plugin unload via `EmissionMetrics.report`.
    this.emissionMetrics = new EmissionMetrics();

    this.registerView(VIEW_TYPE_CLAUDE_TERMINAL, (leaf) => {
      return new ClaudeTerminalView(
        leaf,
        () => this.settings,
        () => this.getVaultBasePath(),
        () => this.getPluginDir(),
        () => this.promptWriter?.getPromptFilePath() ?? null,
        () => this.emissionMetrics
      );
    });

    // Track last active leaves for focus toggle and send target
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (!leaf) return;
        if (leaf.view.getViewType() === VIEW_TYPE_CLAUDE_TERMINAL) {
          this.lastActiveTerminalLeaf = leaf;
        } else {
          this.lastNonTerminalLeaf = leaf;
        }
        this.mcpBridge?.scheduleContextUpdate();
      })
    );

    // MCP context bridge — lets Claude access open notes.
    // Event listeners stay registered for the lifetime of the plugin and
    // no-op when the bridge is torn down, so `reconfigureMcp()` can swap
    // the bridge in/out without re-registering (which would leak handlers).
    this.setupMcp();
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.mcpBridge?.scheduleContextUpdate();
      })
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.mcpBridge?.scheduleContextUpdate();
      })
    );

    this.addCommand({
      id: COMMAND_TOGGLE_TERMINAL,
      name: "Toggle Claude Code terminal",
      callback: () => this.toggleView(),
    });

    this.addCommand({
      id: COMMAND_SEND_SELECTION,
      name: "Send selection to Claude",
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        const selection = editor.getSelection();
        if (!selection) {
          new Notice("텍스트를 선택해주세요");
          return;
        }

        const file = view.file;
        const from = editor.getCursor("from");
        const to = editor.getCursor("to");

        const terminalView = await this.ensureView();
        if (!terminalView) return;

        try {
          await terminalView.ensureReady();
        } catch {
          return;
        }

        const vaultBase = this.getVaultBasePath();
        const filePath = file
          ? `${vaultBase}/${file.path}:${from.line + 1}-${to.line + 1}`
          : "";
        const wrappedSelection = wrapBackticks(selection);
        const payload = filePath
          ? `${filePath}\n${wrappedSelection}`
          : wrappedSelection;

        terminalView.sendText(payload);
      },
    });

    this.addCommand({
      id: COMMAND_SEND_FILE,
      name: "Send current file to Claude",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("열린 파일이 없습니다");
          return;
        }

        const terminalView = await this.ensureView();
        if (!terminalView) return;

        try {
          await terminalView.ensureReady();
        } catch {
          return;
        }

        const absolutePath = `${this.getVaultBasePath()}/${file.path}`;
        terminalView.sendText(`@${absolutePath} `);
      },
    });

    this.addCommand({
      id: COMMAND_FOCUS_TERMINAL,
      name: "Focus Claude Code terminal",
      callback: () => {
        const terminalLeaves = this.app.workspace.getLeavesOfType(
          VIEW_TYPE_CLAUDE_TERMINAL
        );

        if (terminalLeaves.length === 0) {
          this.ensureView();
          return;
        }

        const activeView = this.app.workspace.getActiveViewOfType(
          ClaudeTerminalView
        );

        // If terminal is active, go back to previous leaf
        if (activeView) {
          if (this.lastNonTerminalLeaf) {
            this.app.workspace.setActiveLeaf(this.lastNonTerminalLeaf, {
              focus: true,
            });
          }
          return;
        }

        // Focus the last active terminal, or the first one
        const targetLeaf =
          this.lastActiveTerminalLeaf && terminalLeaves.includes(this.lastActiveTerminalLeaf)
            ? this.lastActiveTerminalLeaf
            : terminalLeaves[0];
        this.app.workspace.revealLeaf(targetLeaf);
        const view = targetLeaf.view as ClaudeTerminalView;
        view.focusTerminal();
      },
    });

    this.addCommand({
      id: COMMAND_NEW_TERMINAL,
      name: "New Claude Code terminal",
      callback: () => this.createNewTerminal(),
    });

    this.addSettingTab(new ClaudeTerminalSettingTab(this.app, this));
  }

  async onunload(): Promise<void> {
    // Don't detach leaves — Obsidian will reinitialize them on plugin update
    this.teardownMcp();
    this.promptWriter?.dispose();
    this.promptWriter = null;
    this.emissionMetrics?.report();
    this.emissionMetrics = null;
  }

  private async toggleView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(
      VIEW_TYPE_CLAUDE_TERMINAL
    );

    if (existing.length > 0) {
      // If a terminal is focused, close only that one
      const activeTerminal = this.app.workspace.getActiveViewOfType(ClaudeTerminalView);
      if (activeTerminal) {
        activeTerminal.leaf.detach();
      } else {
        // No terminal focused — close the most recent one
        existing[existing.length - 1].detach();
      }
      return;
    }

    await this.ensureView();
  }

  private async ensureView(): Promise<ClaudeTerminalView | null> {
    const existing = this.app.workspace.getLeavesOfType(
      VIEW_TYPE_CLAUDE_TERMINAL
    );

    if (existing.length > 0) {
      // Prefer the last active terminal (tracked across focus changes)
      if (this.lastActiveTerminalLeaf && existing.includes(this.lastActiveTerminalLeaf)) {
        const view = this.lastActiveTerminalLeaf.view as ClaudeTerminalView;
        this.app.workspace.revealLeaf(this.lastActiveTerminalLeaf);
        return view;
      }
      const leaf = existing[0];
      this.app.workspace.revealLeaf(leaf);
      return leaf.view as ClaudeTerminalView;
    }

    return this.createNewTerminal();
  }

  private async createNewTerminal(): Promise<ClaudeTerminalView | null> {
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return null;

    await leaf.setViewState({
      type: VIEW_TYPE_CLAUDE_TERMINAL,
      active: true,
    });
    this.app.workspace.revealLeaf(leaf);
    return leaf.view as ClaudeTerminalView;
  }

  private setupMcp(): void {
    if (!this.settings.enableMcp) return;

    const vaultPath = this.getVaultBasePath();
    if (!vaultPath) return;
    if (!this.promptWriter) return;

    const pluginDir = this.getPluginDir();
    this.mcpBridge = new McpContextBridge(
      this.app,
      pluginDir,
      vaultPath,
      this.promptWriter
    );

    if (!this.mcpBridge.setup()) {
      this.mcpBridge = null;
      return;
    }

    const cwd = this.settings.cwdOverride || vaultPath;
    this.mcpBridge.writeMcpConfig(cwd);
  }

  /**
   * Apply the current `enableMcp` setting at runtime by tearing down the
   * existing bridge (if any) and re-running setup. Safe to call regardless
   * of current state: teardown is a no-op when no bridge exists, and setup
   * early-returns when the setting is disabled.
   *
   * Does NOT restart any already-spawned Claude CLI child processes — their
   * `--mcp-config` arg was snapshotted at spawn time, so existing terminals
   * keep the previous MCP state until the user restarts them.
   */
  async reconfigureMcp(): Promise<void> {
    this.teardownMcp();
    this.setupMcp();
  }

  private teardownMcp(): void {
    if (!this.mcpBridge) return;

    const vaultPath = this.getVaultBasePath();
    const cwd = this.settings.cwdOverride || vaultPath;
    this.mcpBridge.removeMcpConfig(cwd);
    this.mcpBridge.dispose();
    this.mcpBridge = null;
    // Plugin orchestrates writer lifecycle — restore baseline after bridge teardown
    // so the prompt file still carries the URL instruction for Cmd+Click.
    this.promptWriter?.writeBase();
  }

  private getVaultBasePath(): string {
    const adapter = this.app.vault.adapter as {
      basePath?: string;
      getBasePath?: () => string;
    };
    if (adapter.getBasePath) {
      return adapter.getBasePath();
    }
    if (adapter.basePath) {
      return adapter.basePath;
    }
    return "";
  }

  private getPluginDir(): string {
    const vaultPath = this.getVaultBasePath();
    return path.join(vaultPath, ".obsidian", "plugins", this.manifest.id);
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = { ...DEFAULT_SETTINGS, ...data };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
