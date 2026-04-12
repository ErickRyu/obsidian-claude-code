import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockTFile, createMockApp } from "./mock-obsidian";
import { FileSuggestModal } from "../src/file-suggest-modal";

describe("FileSuggestModal", () => {
  const files = [
    createMockTFile("notes/meeting.md", { stat: { mtime: 1000, ctime: 1000, size: 512 } } as any),
    createMockTFile("notes/todo.md", { stat: { mtime: 3000, ctime: 1000, size: 256 } } as any),
    createMockTFile("src/main.ts", { stat: { mtime: 2000, ctime: 1000, size: 1024 } } as any),
    createMockTFile("assets/logo.png", { stat: { mtime: 500, ctime: 500, size: 50000 } } as any),
  ];

  let modal: FileSuggestModal;
  let onSelect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const app = createMockApp({
      files,
      headings: {
        "notes/meeting.md": [
          { heading: "Introduction", level: 1, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } } },
          { heading: "Action Items", level: 2, position: { start: { line: 5, col: 0, offset: 0 }, end: { line: 5, col: 0, offset: 0 } } },
        ],
      },
    });
    onSelect = vi.fn();
    modal = new FileSuggestModal(app, onSelect);
  });

  describe("getSuggestions", () => {
    it("returns recent files sorted by mtime when query is empty", () => {
      const results = modal.getSuggestions("");
      expect(results.length).toBe(4);
      // Most recent first (todo.md mtime=3000)
      expect(results[0].file.path).toBe("notes/todo.md");
      expect(results[1].file.path).toBe("src/main.ts");
    });

    it("returns fuzzy matched files for a query", () => {
      const results = modal.getSuggestions("meeting");
      expect(results.length).toBe(1);
      expect(results[0].file.path).toBe("notes/meeting.md");
    });

    it("returns fuzzy matched files across path segments", () => {
      const results = modal.getSuggestions("main");
      expect(results.length).toBe(1);
      expect(results[0].file.path).toBe("src/main.ts");
    });

    it("returns empty array for no match", () => {
      const results = modal.getSuggestions("nonexistent");
      expect(results.length).toBe(0);
    });

    it("filters by folder when query ends with /", () => {
      const results = modal.getSuggestions("notes/");
      expect(results.length).toBe(2);
      expect(results.every((r) => r.file.path.startsWith("notes/"))).toBe(true);
    });

    it("returns headings when query contains #", () => {
      const results = modal.getSuggestions("meeting#");
      expect(results.length).toBe(2);
      expect(results[0].type).toBe("heading");
      if (results[0].type === "heading") {
        expect(results[0].heading).toBe("Introduction");
      }
    });

    it("filters headings by query after #", () => {
      const results = modal.getSuggestions("meeting#Action");
      expect(results.length).toBe(1);
      if (results[0].type === "heading") {
        expect(results[0].heading).toBe("Action Items");
      }
    });

    it("returns empty when heading file not found", () => {
      const results = modal.getSuggestions("nonexistent#heading");
      expect(results.length).toBe(0);
    });
  });

  describe("onChooseSuggestion", () => {
    it("calls onSelect with file path for file items", () => {
      const item = { type: "file" as const, file: files[0], match: null };
      modal.onChooseSuggestion(item);
      expect(onSelect).toHaveBeenCalledWith("notes/meeting.md");
    });

    it("calls onSelect with path#heading for heading items", () => {
      const item = {
        type: "heading" as const,
        file: files[0],
        heading: "Introduction",
        level: 1,
      };
      modal.onChooseSuggestion(item);
      expect(onSelect).toHaveBeenCalledWith("notes/meeting.md#Introduction");
    });
  });

  describe("onClose", () => {
    it("clears debounce timer without error", () => {
      // Should not throw
      modal.onClose();
    });
  });
});
