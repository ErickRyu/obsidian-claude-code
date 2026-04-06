export const VIEW_TYPE_CLAUDE_TERMINAL = "claude-terminal-view";
export const COMMAND_TOGGLE_TERMINAL = "open-claude-terminal";
export const COMMAND_SEND_SELECTION = "send-selection-to-claude";
export const COMMAND_SEND_FILE = "send-file-to-claude";
export const COMMAND_FOCUS_TERMINAL = "focus-claude-terminal";
export const DEFAULT_CLAUDE_PATH = "claude";
export const DEFAULT_FONT_SIZE = 14;
export const DEFAULT_FONT_FAMILY =
  "Menlo, Monaco, 'Courier New', monospace";
export const RESIZE_DEBOUNCE_MS = 100;

export enum TerminalState {
  Closed = "closed",
  Opening = "opening",
  Ready = "ready",
  Exited = "exited",
}
