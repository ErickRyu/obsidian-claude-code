import { Plugin, WorkspaceLeaf, normalizePath } from "obsidian";
import * as path from "path";
import { VIEW_TYPE_CLAUDE_TERMINAL, COMMAND_TOGGLE_TERMINAL } from "./constants";
import { ClaudeTerminalView } from "./claude-terminal-view";
import {
  ClaudeTerminalSettings,
  ClaudeTerminalSettingTab,
  DEFAULT_SETTINGS,
} from "./settings";

export default class ClaudeTerminalPlugin extends Plugin {
  settings: ClaudeTerminalSettings = DEFAULT_SETTINGS;

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

    this.addCommand({
      id: COMMAND_TOGGLE_TERMINAL,
      name: "Toggle Claude Code terminal",
      callback: () => this.toggleView(),
    });

    this.addSettingTab(new ClaudeTerminalSettingTab(this.app, this));
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CLAUDE_TERMINAL);
  }

  private async toggleView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(
      VIEW_TYPE_CLAUDE_TERMINAL
    );

    if (existing.length > 0) {
      existing.forEach((leaf) => leaf.detach());
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({
        type: VIEW_TYPE_CLAUDE_TERMINAL,
        active: true,
      });
      this.app.workspace.revealLeaf(leaf);
    }
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
