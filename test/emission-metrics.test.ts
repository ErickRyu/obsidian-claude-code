import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmissionMetrics } from "../src/emission-metrics";

describe("EmissionMetrics", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("starts at zero for every counter", () => {
    const m = new EmissionMetrics();
    expect(m.snapshot()).toEqual({
      linkMarkdownEmitted: 0,
      linkBareUrlEmitted: 0,
      vaultPathMentioned: 0,
    });
  });

  it("increments each counter independently", () => {
    const m = new EmissionMetrics();
    m.recordMarkdownLink();
    m.recordMarkdownLink(2);
    m.recordBareUrl();
    m.recordVaultPathMentioned(5);
    expect(m.snapshot()).toEqual({
      linkMarkdownEmitted: 3,
      linkBareUrlEmitted: 1,
      vaultPathMentioned: 5,
    });
  });

  it("is silent on report when nothing was emitted", () => {
    new EmissionMetrics().report();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("reports ratios on non-empty sessions", () => {
    const m = new EmissionMetrics();
    m.recordMarkdownLink(7);
    m.recordBareUrl(1);
    m.recordVaultPathMentioned(2);
    m.report();
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [label, payload] = logSpy.mock.calls[0];
    expect(label).toBe("[obsidian-claude-code] emission compliance");
    expect(payload).toMatchObject({
      markdown: 7,
      bare: 1,
      rawPath: 2,
      total: 10,
      clickableShare: 0.8,
      markdownShare: 0.7,
    });
  });
});
