/**
 * DOM skeleton for ClaudeWebviewView.
 *
 * Returns the four persistent region elements. Renderers mount cards into
 * `cardsEl`; future phases populate `headerEl`, `todoSideEl`, and `inputRowEl`.
 *
 * Pattern constraints (enforced via grep in Phase 2 gate 2-5):
 *   - Direct DOM-mutation APIs are banned in src/webview/renderers
 *     and src/webview/ui. See RALPH_PLAN.md gate 2-5 for the exact list.
 *   - All DOM assembly uses `createElement` + `replaceChildren(...)`.
 */
export interface WebviewLayout {
  readonly headerEl: HTMLElement;
  readonly cardsEl: HTMLElement;
  readonly todoSideEl: HTMLElement;
  readonly inputRowEl: HTMLElement;
}

export function buildLayout(root: HTMLElement): WebviewLayout {
  const doc = root.ownerDocument;
  if (!doc) {
    throw new Error("[claude-webview] buildLayout: root has no ownerDocument");
  }

  root.classList.add("claude-wv-root");

  const headerEl = doc.createElement("div");
  headerEl.className = "claude-wv-header";

  const main = doc.createElement("div");
  main.className = "claude-wv-main";

  const cardsEl = doc.createElement("div");
  cardsEl.className = "claude-wv-cards";

  const todoSideEl = doc.createElement("div");
  todoSideEl.className = "claude-wv-todo-side";
  todoSideEl.setAttribute("aria-label", "Claude todo panel");

  main.replaceChildren(cardsEl, todoSideEl);

  const inputRowEl = doc.createElement("div");
  inputRowEl.className = "claude-wv-input-row";
  inputRowEl.setAttribute("role", "group");

  root.replaceChildren(headerEl, main, inputRowEl);

  return { headerEl, cardsEl, todoSideEl, inputRowEl };
}
