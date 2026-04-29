/**
 * Mounts a small "v0.6.0-beta.1 · 1349bc2" badge into the webview header.
 *
 * Build-time identity (manifest version + git short hash + ISO timestamp)
 * is injected by esbuild's `define`. See esbuild.config.mjs and
 * src/build-info.d.ts for the declarations.
 *
 * Discovered necessary on 2026-04-29 dogfood: a user reloading Obsidian
 * after a fresh `npm run build` could not visually confirm the build had
 * landed. Now the header carries the build's git short hash so a stale
 * build is obvious at a glance.
 */
export interface VersionBadgeOptions {
  readonly version: string;
  readonly gitShort: string;
  readonly buildIso: string;
}

export function buildVersionBadge(
  parent: HTMLElement,
  opts: VersionBadgeOptions,
): HTMLElement {
  const doc = parent.ownerDocument;
  if (!doc) {
    throw new Error(
      "[claude-webview] buildVersionBadge: parent has no ownerDocument",
    );
  }
  const badge = doc.createElement("span");
  badge.className = "claude-wv-version-badge";
  badge.textContent = `v${opts.version} · ${opts.gitShort}`;
  badge.setAttribute(
    "title",
    `obsidian-claude-code v${opts.version}\nbuild: ${opts.gitShort}\nat: ${opts.buildIso}`,
  );
  badge.setAttribute(
    "aria-label",
    `Plugin version ${opts.version} build ${opts.gitShort}`,
  );
  parent.appendChild(badge);
  return badge;
}
