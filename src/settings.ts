import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ClaudeTerminalPlugin from "./main";
import {
  DEFAULT_CLAUDE_PATH,
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
} from "./constants";
import {
  DEFAULT_WEBVIEW_SETTINGS,
  PermissionPreset,
  UiMode,
  WebviewSettings,
} from "./webview/settings-adapter";

export interface ClaudeTerminalSettings extends WebviewSettings {
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
  ...DEFAULT_WEBVIEW_SETTINGS,
};

export type { UiMode, PermissionPreset, WebviewSettings };

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
      .setName("UI mode")
      .setDesc(
        "Choose between the xterm.js terminal (default, stable) and the new Webview (v0.6.0 beta, opt-in). Switching requires an Obsidian restart."
      )
      .addDropdown((drop) => {
        drop.addOption("terminal", "Terminal (xterm.js — default)");
        drop.addOption("webview", "Webview (beta)");
        drop.setValue(this.plugin.settings.uiMode);
        drop.onChange(async (value: string) => {
          const next = (value === "webview" ? "webview" : "terminal") as UiMode;
          this.plugin.settings = {
            ...this.plugin.settings,
            uiMode: next,
          };
          await this.plugin.saveSettings();
          new Notice(
            "웹뷰 적용을 위해 Obsidian 재시작 필요 (Restart Obsidian to apply UI mode change)"
          );
        });
      });

    new Setting(containerEl)
      .setName("Permission preset (Webview)")
      .setDesc(
        "allowedTools bundle passed to claude -p. Safe: Read/Glob/Grep. Standard: +Edit/Write/TodoWrite. Full: +Bash. Applies to the next spawn."
      )
      .addDropdown((drop) => {
        drop.addOption("safe", "Safe");
        drop.addOption("standard", "Standard");
        drop.addOption("full", "Full");
        drop.setValue(this.plugin.settings.permissionPreset);
        drop.onChange(async (value: string) => {
          const next = (value === "safe" || value === "full" ? value : "standard") as PermissionPreset;
          this.plugin.settings = {
            ...this.plugin.settings,
            permissionPreset: next,
          };
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Show debug system events (Webview)")
      .setDesc("Render hook_started / hook_response cards as collapsed JSON. Off by default to reduce noise.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showDebugSystemEvents)
          .onChange(async (value) => {
            this.plugin.settings = {
              ...this.plugin.settings,
              showDebugSystemEvents: value,
            };
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Show thinking blocks expanded (Webview)")
      .setDesc("When on, assistant thinking <details> elements are open by default.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showThinking)
          .onChange(async (value) => {
            this.plugin.settings = {
              ...this.plugin.settings,
              showThinking: value,
            };
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("MCP context server")
      .setDesc(
        "Enable MCP server so Claude can access open notes, active file, and vault search. Existing terminals keep their previous state — restart them to pick up the change."
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
            await this.plugin.reconfigureMcp();
            new Notice(
              value
                ? "MCP enabled. Restart existing terminals to apply."
                : "MCP disabled. Restart existing terminals to apply."
            );
          })
      );
  }
}
