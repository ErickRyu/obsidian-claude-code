import type { IPty } from "node-pty";
import * as path from "path";

export type PtyDataCallback = (data: string) => void;
export type PtyExitCallback = (exitCode: number, signal?: number) => void;

export class TerminalManager {
  private pty: IPty | null = null;
  private disposed = false;

  spawn(
    claudePath: string,
    args: string[],
    cwd: string,
    pluginDir: string,
    cols: number,
    rows: number,
    onData: PtyDataCallback,
    onExit: PtyExitCallback
  ): void {
    if (this.pty) {
      this.kill();
    }

    // Load node-pty from the plugin directory since Obsidian doesn't resolve node_modules
    const nodePtyPath = path.join(pluginDir, "node-pty");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodePty = require(nodePtyPath) as typeof import("node-pty");

    // Obsidian (Electron) doesn't inherit the user's shell PATH,
    // so spawn a login shell that runs claude to get the full environment.
    const shell = process.env.SHELL || "/bin/zsh";
    const claudeCmd =
      [claudePath, ...args].map((a) => `'${a}'`).join(" ");

    this.pty = nodePty.spawn(shell, ["-l", "-c", claudeCmd], {
      name: "xterm-256color",
      cwd,
      cols,
      rows,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
    });

    this.pty.onData((data) => {
      if (!this.disposed) {
        onData(data);
      }
    });

    this.pty.onExit(({ exitCode, signal }) => {
      if (!this.disposed) {
        this.pty = null;
        onExit(exitCode, signal);
      }
    });
  }

  write(data: string): void {
    this.pty?.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.pty && cols > 0 && rows > 0) {
      try {
        this.pty.resize(cols, rows);
      } catch {
        // Ignore resize errors on dead processes
      }
    }
  }

  kill(): void {
    if (this.pty) {
      try {
        this.pty.kill();
      } catch {
        // Process may already be dead
      }
      this.pty = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.kill();
  }

  get isRunning(): boolean {
    return this.pty !== null;
  }
}
