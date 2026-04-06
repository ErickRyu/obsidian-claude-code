import { Editor, MarkdownView, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import * as path from "path";
import {
  VIEW_TYPE_CLAUDE_TERMINAL,
  COMMAND_TOGGLE_TERMINAL,
  COMMAND_SEND_SELECTION,
  COMMAND_SEND_FILE,
  COMMAND_FOCUS_TERMINAL,
} from "./constants";
import { ClaudeTerminalView, wrapBackticks } from "./claude-terminal-view";
import {
  ClaudeTerminalSettings,
  ClaudeTerminalSettingTab,
  DEFAULT_SETTINGS,
} from "./settings";

export default class ClaudeTerminalPlugin extends Plugin {
  settings: ClaudeTerminalSettings = DEFAULT_SETTINGS;
  private lastNonTerminalLeaf: WorkspaceLeaf | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_CLAUDE_TERMINAL, (leaf) => {
      return new ClaudeTerminalView(
        leaf,
        () => this.settings,
        () => this.getVaultBasePath(),
        () => this.getPluginDir()
      );
    });

    // Track last non-terminal leaf for focus toggle
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (
          leaf &&
          leaf.view.getViewType() !== VIEW_TYPE_CLAUDE_TERMINAL
        ) {
          this.lastNonTerminalLeaf = leaf;
        }
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

        const terminalLeaf = terminalLeaves[0];
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

        // Focus terminal
        this.app.workspace.revealLeaf(terminalLeaf);
        const view = terminalLeaf.view as ClaudeTerminalView;
        view.focusTerminal();
      },
    });

    this.addSettingTab(new ClaudeTerminalSettingTab(this.app, this));
  }

  async onunload(): Promise<void> {
    // Don't detach leaves — Obsidian will reinitialize them on plugin update
  }

  private async toggleView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(
      VIEW_TYPE_CLAUDE_TERMINAL
    );

    if (existing.length > 0) {
      existing.forEach((leaf) => leaf.detach());
      return;
    }

    await this.ensureView();
  }

  private async ensureView(): Promise<ClaudeTerminalView | null> {
    const existing = this.app.workspace.getLeavesOfType(
      VIEW_TYPE_CLAUDE_TERMINAL
    );

    if (existing.length > 0) {
      const leaf = existing[0];
      this.app.workspace.revealLeaf(leaf);
      return leaf.view as ClaudeTerminalView;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return null;

    await leaf.setViewState({
      type: VIEW_TYPE_CLAUDE_TERMINAL,
      active: true,
    });
    this.app.workspace.revealLeaf(leaf);
    return leaf.view as ClaudeTerminalView;
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
