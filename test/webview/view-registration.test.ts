import { describe, it, expect, vi } from "vitest";
import { Plugin } from "obsidian";
import { wireWebview, type WebviewPluginHost } from "../../src/webview";
import {
  VIEW_TYPE_CLAUDE_WEBVIEW,
  COMMAND_OPEN_WEBVIEW,
  COMMAND_RESUME_WEBVIEW,
} from "../../src/constants";

function makeHost(uiMode: "terminal" | "webview"): WebviewPluginHost {
  const plugin = new Plugin() as unknown as WebviewPluginHost;
  plugin.settings = { uiMode };
  plugin.registerView = vi.fn();
  plugin.addCommand = vi.fn();
  return plugin;
}

describe("wireWebview", () => {
  it("registers VIEW_TYPE_CLAUDE_WEBVIEW + open + resume commands when uiMode === webview", () => {
    const host = makeHost("webview");

    wireWebview(host);

    const regMock = host.registerView as unknown as ReturnType<typeof vi.fn>;
    expect(regMock).toHaveBeenCalledTimes(1);
    expect(regMock.mock.calls[0][0]).toBe(VIEW_TYPE_CLAUDE_WEBVIEW);
    expect(typeof regMock.mock.calls[0][1]).toBe("function");

    const cmdMock = host.addCommand as unknown as ReturnType<typeof vi.fn>;
    // Phase 5a adds a second command (resume last). Assert both are present
    // rather than asserting exact invocation count so future 5b additions
    // do not force a cascading test edit.
    const registeredIds = cmdMock.mock.calls.map(
      (c: unknown[]) => (c[0] as { id: string }).id,
    );
    expect(registeredIds).toContain(COMMAND_OPEN_WEBVIEW);
    expect(registeredIds).toContain(COMMAND_RESUME_WEBVIEW);
  });

  it("does not register anything when uiMode === terminal (zero regression)", () => {
    const host = makeHost("terminal");

    wireWebview(host);

    const regMock = host.registerView as unknown as ReturnType<typeof vi.fn>;
    expect(regMock).not.toHaveBeenCalled();
    const cmdMock = host.addCommand as unknown as ReturnType<typeof vi.fn>;
    expect(cmdMock).not.toHaveBeenCalled();
  });
});
