import { ItemView, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_CLAUDE_WEBVIEW } from "../constants";

/**
 * ClaudeWebviewView — Phase 0 stub.
 *
 * The Phase 0 contract: registering this view must not break the existing
 * `ClaudeTerminalView`. We only mount a placeholder div. Subsequent phases
 * fill in the layout, renderers, session controller, and event bus.
 *
 * Namespace log prefix: `[claude-webview]` (distinct from `[claude-terminal]`).
 */
export class ClaudeWebviewView extends ItemView {
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_CLAUDE_WEBVIEW;
  }

  getDisplayText(): string {
    return "Claude Webview";
  }

  getIcon(): string {
    return "claude-ai";
  }

  async onOpen(): Promise<void> {
    // Phase 0 placeholder. Phase 2 installs the real layout.
    const containerChild: unknown = this.containerEl.children[1];
    const root = containerChild as {
      empty?: () => void;
      createDiv?: (cls: string) => HTMLElement;
    };
    if (root.empty) root.empty();
    if (root.createDiv) {
      const placeholder = root.createDiv("claude-wv-placeholder");
      placeholder.textContent = "Webview coming soon";
    }
    // eslint-disable-next-line no-console
    console.log("[claude-webview] view mounted (Phase 0 stub)");
  }

  async onClose(): Promise<void> {
    // eslint-disable-next-line no-console
    console.log("[claude-webview] view unmounted");
  }
}
