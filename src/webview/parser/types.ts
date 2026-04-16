/**
 * StreamEvent discriminated union.
 * Derived from docs/webview-spike/stream-json-schema-notes.md — claude -p --output-format=stream-json
 *
 * NOTE: keep types structural; avoid over-broad index signatures and avoid `any`.
 */

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  caller?: { type: string };
}

export type AssistantBlock = TextBlock | ThinkingBlock | ToolUseBlock;

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<TextBlock | ToolResultBlockImage>;
  is_error?: boolean;
}

export interface ToolResultBlockImage {
  type: "image";
  source: unknown;
}

export type UserBlock = TextBlock | ToolResultBlock;

// ---------- System events ----------

export interface SystemInitEvent {
  type: "system";
  subtype: "init";
  session_id: string;
  uuid: string;
  cwd?: string;
  model?: string;
  permissionMode?: string;
  claude_code_version?: string;
  apiKeySource?: string;
  fast_mode_state?: string;
  mcp_servers?: Array<{ name: string; status: string }>;
  tools?: string[];
  slash_commands?: string[];
  agents?: string[];
  output_style?: string;
}

export interface SystemHookStartedEvent {
  type: "system";
  subtype: "hook_started";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  uuid: string;
  session_id: string;
}

export interface SystemHookResponseEvent {
  type: "system";
  subtype: "hook_response";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  output?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  outcome?: string;
  uuid: string;
  session_id: string;
}

export interface SystemStatusEvent {
  type: "system";
  subtype: "status";
  status: string | null;
  compact_result?: string;
  session_id: string;
  uuid: string;
}

export interface SystemCompactBoundaryEvent {
  type: "system";
  subtype: "compact_boundary";
  session_id: string;
  uuid: string;
  compact_metadata?: {
    trigger?: string;
    pre_tokens?: number;
    post_tokens?: number;
    duration_ms?: number;
  };
}

export type SystemEvent =
  | SystemInitEvent
  | SystemHookStartedEvent
  | SystemHookResponseEvent
  | SystemStatusEvent
  | SystemCompactBoundaryEvent;

// ---------- Assistant / User / Rate / Result ----------

export interface AssistantMessage {
  id: string;
  type: "message";
  role: "assistant";
  model?: string;
  content: AssistantBlock[];
  stop_reason?: string | null;
  stop_sequence?: string | null;
  usage?: Record<string, unknown>;
}

export interface AssistantEvent {
  type: "assistant";
  message: AssistantMessage;
  parent_tool_use_id?: string | null;
  session_id: string;
  uuid: string;
}

export interface UserMessage {
  role: "user";
  content: string | UserBlock[];
}

export interface UserEvent {
  type: "user";
  message: UserMessage;
  parent_tool_use_id?: string | null;
  session_id?: string;
  uuid?: string;
}

export interface RateLimitEvent {
  type: "rate_limit_event";
  rate_limit_info: {
    status: string;
    resetsAt?: number;
    rateLimitType?: string;
    overageStatus?: string;
    overageResetsAt?: number;
    isUsingOverage?: boolean;
  };
  uuid: string;
  session_id: string;
}

export interface ResultEvent {
  type: "result";
  subtype: string;
  is_error?: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  result?: string;
  stop_reason?: string;
  session_id: string;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  permission_denials?: unknown[];
  terminal_reason?: string;
  uuid: string;
}

/**
 * UnknownEvent wraps any JSON object whose `type` is not in our known set.
 * Parser MUST preserve the original JSON so the renderer can render a collapsed JSON dump card.
 */
export interface UnknownEvent {
  type: "__unknown__";
  originalType: string;
  raw: Record<string, unknown>;
}

export type StreamEvent =
  | SystemEvent
  | AssistantEvent
  | UserEvent
  | RateLimitEvent
  | ResultEvent
  | UnknownEvent;
