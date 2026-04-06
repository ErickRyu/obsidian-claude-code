import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { VIEW_TYPE_CLAUDE_TERMINAL, RESIZE_DEBOUNCE_MS } from "./constants";
import { TerminalManager } from "./terminal-manager";
import { buildXtermTheme } from "./theme-sync";
import type { ClaudeTerminalSettings } from "./settings";

export class ClaudeTerminalView extends ItemView {
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private terminalManager: TerminalManager | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeTimeout: ReturnType<typeof setTimeout> | null = null;
  private wrapperEl: HTMLElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly getSettings: () => ClaudeTerminalSettings,
    private readonly getVaultPath: () => string,
    private readonly getPluginDir: () => string
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_CLAUDE_TERMINAL;
  }

  getDisplayText(): string {
    return "Claude Code";
  }

  getIcon(): string {
    return "terminal";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("claude-terminal-container");

    this.wrapperEl = container.createDiv({ cls: "claude-terminal-wrapper" });

    const settings = this.getSettings();
    const theme = buildXtermTheme();

    this.terminal = new Terminal({
      theme,
      fontSize: settings.fontSize,
      fontFamily: settings.fontFamily,
      cursorBlink: true,
      cursorStyle: "block",
      allowProposedApi: true,
      scrollback: 10000,
      convertEol: true,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new WebLinksAddon());

    this.terminal.open(this.wrapperEl);

    // Initial fit after DOM layout
    requestAnimationFrame(() => {
      this.fitAddon?.fit();
      this.spawnClaude();
    });

    // Handle resize
    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimeout) {
        clearTimeout(this.resizeTimeout);
      }
      this.resizeTimeout = setTimeout(() => {
        this.fitAddon?.fit();
        if (this.terminal && this.terminalManager) {
          this.terminalManager.resize(this.terminal.cols, this.terminal.rows);
        }
      }, RESIZE_DEBOUNCE_MS);
    });
    this.resizeObserver.observe(this.wrapperEl);

    // Handle user input → PTY
    this.terminal.onData((data) => {
      this.terminalManager?.write(data);
    });

    // Handle paste
    this.terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown" && event.metaKey && event.key === "v") {
        navigator.clipboard.readText().then((text) => {
          this.terminalManager?.write(text);
        });
        return false;
      }
      // Cmd+C for copy when there's a selection
      if (
        event.type === "keydown" &&
        event.metaKey &&
        event.key === "c" &&
        this.terminal?.hasSelection()
      ) {
        const selection = this.terminal.getSelection();
        navigator.clipboard.writeText(selection);
        return false;
      }
      return true;
    });

    // Listen for theme changes
    this.registerEvent(
      this.app.workspace.on("css-change", () => {
        if (this.terminal) {
          this.terminal.options.theme = buildXtermTheme();
        }
      })
    );
  }

  private spawnClaude(): void {
    const settings = this.getSettings();
    const vaultPath = this.getVaultPath();
    const cwd = settings.cwdOverride || vaultPath;

    const args: string[] = [];
    if (settings.extraArgs.trim()) {
      args.push(...settings.extraArgs.trim().split(/\s+/));
    }

    this.terminalManager = new TerminalManager();

    try {
      this.terminalManager.spawn(
        settings.claudePath,
        args,
        cwd,
        this.getPluginDir(),
        this.terminal?.cols ?? 80,
        this.terminal?.rows ?? 24,
        (data) => {
          this.terminal?.write(data);
        },
        (exitCode) => {
          this.terminal?.write(
            `\r\n\x1b[90m[Claude Code exited with code ${exitCode}. Press any key to restart]\x1b[0m\r\n`
          );
          this.terminalManager = null;

          // Restart on any key
          const disposable = this.terminal?.onData(() => {
            disposable?.dispose();
            this.spawnClaude();
          });
        }
      );
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : "Unknown error";
      new Notice(
        `Failed to start Claude Code: ${msg}. Check that the Claude CLI is installed and the path is correct in settings.`
      );
      this.terminal?.write(
        `\r\n\x1b[31mError: ${msg}\x1b[0m\r\n\x1b[90mEnsure Claude CLI is installed: npm install -g @anthropic-ai/claude-code\x1b[0m\r\n`
      );
    }
  }

  async onClose(): Promise<void> {
    if (this.resizeTimeout) {
      clearTimeout(this.resizeTimeout);
    }
    this.resizeObserver?.disconnect();
    this.terminalManager?.dispose();
    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
    this.terminalManager = null;
    this.resizeObserver = null;
    this.wrapperEl = null;
  }

  updateTheme(): void {
    if (this.terminal) {
      this.terminal.options.theme = buildXtermTheme();
    }
  }
}
