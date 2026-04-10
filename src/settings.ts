import { App, PluginSettingTab, Setting } from "obsidian";
import type ClaudeTerminalPlugin from "./main";
import {
  DEFAULT_CLAUDE_PATH,
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
} from "./constants";

export interface ClaudeTerminalSettings {
  claudePath: string;
  fontSize: number;
  fontFamily: string;
  extraArgs: string;
  cwdOverride: string;
  enableMcp: boolean;
}

export const DEFAULT_SETTINGS: ClaudeTerminalSettings = {
  claudePath: DEFAULT_CLAUDE_PATH,
  fontSize: DEFAULT_FONT_SIZE,
  fontFamily: DEFAULT_FONT_FAMILY,
  extraArgs: "",
  cwdOverride: "",
  enableMcp: true,
};

export class ClaudeTerminalSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ClaudeTerminalPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Claude CLI path")
      .setDesc("Path to the Claude CLI executable")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_CLAUDE_PATH)
          .setValue(this.plugin.settings.claudePath)
          .onChange(async (value) => {
            this.plugin.settings = {
              ...this.plugin.settings,
              claudePath: value || DEFAULT_CLAUDE_PATH,
            };
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Font size")
      .setDesc("Terminal font size in pixels")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_FONT_SIZE))
          .setValue(String(this.plugin.settings.fontSize))
          .onChange(async (value) => {
            const parsed = parseInt(value, 10);
            if (!isNaN(parsed) && parsed > 0) {
              this.plugin.settings = {
                ...this.plugin.settings,
                fontSize: parsed,
              };
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Font family")
      .setDesc("Terminal font family (CSS value)")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_FONT_FAMILY)
          .setValue(this.plugin.settings.fontFamily)
          .onChange(async (value) => {
            this.plugin.settings = {
              ...this.plugin.settings,
              fontFamily: value || DEFAULT_FONT_FAMILY,
            };
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Extra CLI arguments")
      .setDesc("Additional arguments passed to Claude CLI")
      .addText((text) =>
        text
          .setPlaceholder("e.g. --model sonnet")
          .setValue(this.plugin.settings.extraArgs)
          .onChange(async (value) => {
            this.plugin.settings = {
              ...this.plugin.settings,
              extraArgs: value,
            };
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Working directory")
      .setDesc("Override working directory (empty = vault root)")
      .addText((text) =>
        text
          .setPlaceholder("Leave empty for vault root")
          .setValue(this.plugin.settings.cwdOverride)
          .onChange(async (value) => {
            this.plugin.settings = {
              ...this.plugin.settings,
              cwdOverride: value,
            };
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("MCP context server")
      .setDesc(
        "Enable MCP server so Claude can access open notes, active file, and vault search. Requires terminal restart."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableMcp)
          .onChange(async (value) => {
            this.plugin.settings = {
              ...this.plugin.settings,
              enableMcp: value,
            };
            await this.plugin.saveSettings();
          })
      );
  }
}
