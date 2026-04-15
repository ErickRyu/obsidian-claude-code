import { ItemView, Notice, WorkspaceLeaf, App } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import {
  VIEW_TYPE_CLAUDE_TERMINAL,
  RESIZE_DEBOUNCE_MS,
  TerminalState,
} from "./constants";
import { TerminalManager } from "./terminal-manager";
import { buildXtermTheme } from "./theme-sync";
import type { ClaudeTerminalSettings } from "./settings";
import { FileSuggestModal } from "./file-suggest-modal";
import { createObsidianOsc8LinkHandler } from "./obsidian-link-provider";
import { VaultPathLinkProvider } from "./vault-path-link-provider";
import { ObsidianLinkTransform } from "./obsidian-link-transform";

export function sanitizeForPty(text: string): string {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

export function wrapBackticks(text: string): string {
  if (text.includes("```")) {
    return "````\n" + text + "\n````";
  }
  return text;
}

interface ReadyPromiseCallbacks {
  resolve: () => void;
  reject: (reason: Error) => void;
}

export class ClaudeTerminalView extends ItemView {
  private static nextInstanceId = 1;

  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private terminalManager: TerminalManager | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeTimeout: ReturnType<typeof setTimeout> | null = null;
  private wrapperEl: HTMLElement | null = null;
  private linkTransform: ObsidianLinkTransform | null = null;
  private state: TerminalState = TerminalState.Closed;
  private readyCallbacks: ReadyPromiseCallbacks[] = [];
  private readonly instanceId: number;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly getSettings: () => ClaudeTerminalSettings,
    private readonly getVaultPath: () => string,
    private readonly getPluginDir: () => string,
    private readonly getSystemPromptFile: () => string | null = () => null
  ) {
    super(leaf);
    this.icon = "claude-ai";
    this.instanceId = ClaudeTerminalView.nextInstanceId++;
  }

  getViewType(): string {
    return VIEW_TYPE_CLAUDE_TERMINAL;
  }

  getDisplayText(): string {
    return this.instanceId === 1 ? "Claude Code" : `Claude Code #${this.instanceId}`;
  }

  getIcon(): string {
    return "claude-ai";
  }

  getTerminalState(): TerminalState {
    return this.state;
  }

  async ensureReady(): Promise<void> {
    if (this.state === TerminalState.Ready) {
      return;
    }
    if (this.state === TerminalState.Exited) {
      this.spawnClaude();
    }
    // Queue a resolver for Opening and Closed states
    if (
      this.state === TerminalState.Opening ||
      this.state === TerminalState.Closed
    ) {
      return new Promise<void>((resolve, reject) => {
        this.readyCallbacks.push({ resolve, reject });
      });
    }
  }

  sendText(text: string): void {
    if (this.state !== TerminalState.Ready) {
      return;
    }
    const sanitized = sanitizeForPty(text);
    if (this.terminalManager?.isRunning) {
      this.terminalManager.write(sanitized);
    }
  }

  focusTerminal(): void {
    this.terminal?.focus();
  }

  async onOpen(): Promise<void> {
    this.state = TerminalState.Opening;

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
      linkHandler: createObsidianOsc8LinkHandler(this.app),
    });

    this.linkTransform = new ObsidianLinkTransform();

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new WebLinksAddon());
    this.terminal.registerLinkProvider(new VaultPathLinkProvider(this.terminal, this.app));

    this.terminal.open(this.wrapperEl);

    requestAnimationFrame(() => {
      this.fitAddon?.fit();
      this.spawnClaude();
    });

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

    this.terminal.onData((data) => {
      this.terminalManager?.write(data);
    });

    this.terminal.attachCustomKeyEventHandler((event) => {
      // @-mention file picker: intercept @ key to open vault file search
      if (
        event.type === "keydown" &&
        event.key === "@" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.isComposing
      ) {
        event.preventDefault();
        event.stopPropagation();
        const tm = this.terminalManager;
        new FileSuggestModal(
          this.app,
          (selectedPath: string) => {
            tm?.write("@" + selectedPath + " ");
          },
          () => {
            // User dismissed modal without selecting — write literal @
            tm?.write("@");
          }
        ).open();
        return false;
      }
      // Send kitty keyboard protocol sequence for Shift+Enter
      // so Claude Code CLI recognizes it as multiline input.
      // Use keyCode fallback for IME composition states where event.key may differ.
      if (
        event.type === "keydown" &&
        event.shiftKey &&
        !event.isComposing &&
        (event.key === "Enter" || event.keyCode === 13 || event.code === "Enter")
      ) {
        event.preventDefault();
        event.stopPropagation();
        this.terminalManager?.write("\x1b[13;2u");
        return false;
      }
      if (event.type === "keydown" && event.metaKey && event.key === "v") {
        navigator.clipboard.readText().then((text) => {
          this.terminalManager?.write(text);
        });
        return false;
      }
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

    this.registerEvent(
      this.app.workspace.on("css-change", () => {
        if (this.terminal) {
          this.terminal.options.theme = buildXtermTheme();
        }
      })
    );
  }

  private spawnClaude(): void {
    this.state = TerminalState.Opening;

    const settings = this.getSettings();
    const vaultPath = this.getVaultPath();
    const cwd = settings.cwdOverride || vaultPath;

    const args: string[] = [];
    if (settings.extraArgs.trim()) {
      args.push(...settings.extraArgs.trim().split(/\s+/));
    }

    const promptFile = this.getSystemPromptFile();
    if (promptFile) {
      args.push("--append-system-prompt-file", promptFile);
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
          const transformed = this.linkTransform
            ? this.linkTransform.transform(data)
            : data;
          if (transformed.length > 0) {
            this.terminal?.write(transformed);
          }
          if (this.state === TerminalState.Opening) {
            this.state = TerminalState.Ready;
            this.resolveAllCallbacks();
          }
        },
        (exitCode) => {
          this.state = TerminalState.Exited;
          this.terminal?.write(
            `\r\n\x1b[90m[Claude Code exited with code ${exitCode}. Press any key to restart]\x1b[0m\r\n`
          );
          this.terminalManager = null;

          const disposable = this.terminal?.onData(() => {
            disposable?.dispose();
            this.spawnClaude();
          });
        }
      );
    } catch (error) {
      this.state = TerminalState.Exited;
      const msg = error instanceof Error ? error.message : "Unknown error";
      new Notice(
        `Failed to start Claude Code: ${msg}. Check that the Claude CLI is installed and the path is correct in settings.`
      );
      this.terminal?.write(
        `\r\n\x1b[31mError: ${msg}\x1b[0m\r\n\x1b[90mEnsure Claude CLI is installed: npm install -g @anthropic-ai/claude-code\x1b[0m\r\n`
      );
      this.rejectAllCallbacks(
        new Error(`Claude Code failed to start: ${msg}`)
      );
    }
  }

  private resolveAllCallbacks(): void {
    const callbacks = [...this.readyCallbacks];
    this.readyCallbacks = [];
    callbacks.forEach((cb) => cb.resolve());
  }

  private rejectAllCallbacks(reason: Error): void {
    const callbacks = [...this.readyCallbacks];
    this.readyCallbacks = [];
    callbacks.forEach((cb) => cb.reject(reason));
  }

  async onClose(): Promise<void> {
    this.state = TerminalState.Closed;
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
    this.linkTransform = null;
    this.rejectAllCallbacks(new Error("Terminal view closed"));
  }
}
