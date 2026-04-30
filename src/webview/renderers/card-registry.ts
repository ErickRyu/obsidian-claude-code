/**
 * Card registry / dispatcher for webview renderers.
 *
 * A `CardRenderer` takes a `StreamEvent` plus a `RenderContext` and mutates
 * `ctx.cardsEl` by appending new cards via `replaceChildren` (see layout.ts
 * rules). The dispatcher looks up a renderer by event key — for example:
 *
 *   `user` -> userToolResultRenderer
 *   `result` -> resultRenderer
 *   `system:init` -> systemInitRenderer  (future Sub-AC)
 *   `assistant` -> assistantTextRenderer  (future Sub-AC)
 *   `__unknown__:<type>` or any unregistered key -> default handler
 *
 * The default handler MUST render a collapsed `<details>` card showing the
 * raw JSON so schema drift is visible to debug users (ux-transparency).
 */
import type { StreamEvent, SystemEvent } from "../parser/types";

export interface RenderState {
  /** In-insertion-order array of mounted card elements. */
  cards: HTMLElement[];
  /** Map of assistant msg.id -> card element, for msg-id upsert (future). */
  messageCards: Map<string, HTMLElement>;
}

export interface RenderContext {
  readonly doc: Document;
  readonly cardsEl: HTMLElement;
  readonly state: RenderState;
}

export type CardRenderer = (event: StreamEvent, ctx: RenderContext) => void;

export interface CardRegistry {
  register(key: string, renderer: CardRenderer): void;
  dispatch(event: StreamEvent): void;
}

export function createRegistry(ctx: RenderContext): CardRegistry {
  const handlers = new Map<string, CardRenderer>();

  return {
    register(key: string, renderer: CardRenderer): void {
      handlers.set(key, renderer);
    },
    dispatch(event: StreamEvent): void {
      const key = eventKey(event);
      const handler = handlers.get(key) ?? defaultUnknownHandler;
      handler(event, ctx);
    },
  };
}

export function eventKey(event: StreamEvent): string {
  switch (event.type) {
    case "__unknown__":
      return `__unknown__:${event.originalType}`;
    case "system":
      return `system:${subtypeOf(event)}`;
    default:
      return event.type;
  }
}

function subtypeOf(event: SystemEvent): string {
  return event.subtype;
}

/**
 * UnknownEvent fallback: render a collapsed details/summary card dumping the
 * raw JSON so the debug user can inspect schema drift.
 */
export const defaultUnknownHandler: CardRenderer = (event, ctx) => {
  const doc = ctx.doc;
  const card = doc.createElement("div");
  const kind = event.type === "__unknown__" ? event.originalType : event.type;
  card.className = `claude-wv-card claude-wv-card--unknown`;
  card.setAttribute("data-unknown-type", kind);

  const details = doc.createElement("details");
  const summary = doc.createElement("summary");
  summary.textContent = `Unknown event: ${kind}`;
  const pre = doc.createElement("pre");
  pre.className = "claude-wv-unknown-json";
  try {
    pre.textContent = JSON.stringify(event, null, 2);
  } catch {
    pre.textContent = "[unserializable]";
  }
  details.replaceChildren(summary, pre);
  card.replaceChildren(details);

  ctx.state.cards.push(card);
  ctx.cardsEl.replaceChildren(...ctx.state.cards);
};
