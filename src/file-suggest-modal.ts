import {
  App,
  SuggestModal,
  TFile,
  TFolder,
  prepareFuzzySearch,
} from "obsidian";
import type { SearchResult } from "obsidian";

interface FileSuggestion {
  readonly type: "file";
  readonly file: TFile;
  readonly match: SearchResult | null;
}

interface HeadingSuggestion {
  readonly type: "heading";
  readonly file: TFile;
  readonly heading: string;
  readonly level: number;
}

type SuggestionItem = FileSuggestion | HeadingSuggestion;

export class FileSuggestModal extends SuggestModal<SuggestionItem> {
  private readonly allFiles: readonly TFile[];
  private previewEl: HTMLElement | null = null;
  private previewDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    app: App,
    private readonly onSelect: (path: string) => void
  ) {
    super(app);
    this.allFiles = this.app.vault.getFiles();
    this.setPlaceholder("Type to search vault files...");
    this.setInstructions([
      { command: "#", purpose: "heading reference" },
      { command: "/", purpose: "filter by folder" },
    ]);

    this.modalEl.addClass("file-suggest-with-preview");
    this.previewEl = this.modalEl.createDiv({
      cls: "file-suggest-preview",
    });
  }

  onClose(): void {
    if (this.previewDebounceTimer) {
      clearTimeout(this.previewDebounceTimer);
      this.previewDebounceTimer = null;
    }
  }

  getSuggestions(query: string): SuggestionItem[] {
    if (!query) {
      const sorted = [...this.allFiles].sort(
        (a, b) => b.stat.mtime - a.stat.mtime
      );
      return sorted.slice(0, 30).map((f) => ({
        type: "file",
        file: f,
        match: null,
      }));
    }

    // # heading mode
    if (query.includes("#")) {
      return this.getHeadingSuggestions(query);
    }

    // / folder filter
    if (query.endsWith("/")) {
      return this.getFolderFilteredSuggestions(query);
    }

    return this.getFuzzyFileSuggestions(query);
  }

  renderSuggestion(item: SuggestionItem, el: HTMLElement): void {
    if (item.type === "heading") {
      const indent = "\u00A0\u00A0".repeat(item.level - 1);
      el.createEl("span", {
        text: `${indent}# ${item.heading}`,
        cls: "file-suggest-name",
      });
      el.createEl("small", {
        text: item.file.path,
        cls: "file-suggest-path",
      });
    } else {
      el.createEl("span", {
        text: item.file.basename,
        cls: "file-suggest-name",
      });
      el.createEl("small", {
        text: item.file.path,
        cls: "file-suggest-path",
      });
    }

    el.addEventListener("mouseenter", () => {
      this.showPreviewDebounced(item);
    });
  }

  onChooseSuggestion(item: SuggestionItem): void {
    if (item.type === "heading") {
      this.onSelect(`${item.file.path}#${item.heading}`);
    } else {
      this.onSelect(item.file.path);
    }
  }

  private getHeadingSuggestions(query: string): SuggestionItem[] {
    const [fileQuery, headingQuery] = query.split("#", 2);
    const fuzzy = prepareFuzzySearch(fileQuery);
    const matchedFile = this.allFiles.find((f) => fuzzy(f.path) !== null);

    if (!matchedFile) {
      return [];
    }

    const cache = this.app.metadataCache.getFileCache(matchedFile);
    const headings = cache?.headings ?? [];

    if (!headingQuery) {
      return headings.map((h) => ({
        type: "heading" as const,
        file: matchedFile,
        heading: h.heading,
        level: h.level,
      }));
    }

    const headingFuzzy = prepareFuzzySearch(headingQuery);
    return headings
      .filter((h) => headingFuzzy(h.heading) !== null)
      .map((h) => ({
        type: "heading" as const,
        file: matchedFile,
        heading: h.heading,
        level: h.level,
      }));
  }

  private getFolderFilteredSuggestions(query: string): SuggestionItem[] {
    const folderQuery = query.slice(0, -1).toLowerCase();
    return this.allFiles
      .filter((f) =>
        f.parent?.path.toLowerCase().includes(folderQuery)
      )
      .slice(0, 30)
      .map((f) => ({ type: "file" as const, file: f, match: null }));
  }

  private getFuzzyFileSuggestions(query: string): SuggestionItem[] {
    const fuzzy = prepareFuzzySearch(query);
    const results: SuggestionItem[] = [];

    for (const file of this.allFiles) {
      const match = fuzzy(file.path);
      if (match) {
        results.push({ type: "file", file, match });
      }
    }

    // Sort by match score (higher = better)
    results.sort((a, b) => {
      const scoreA = a.type === "file" ? (a.match?.score ?? -Infinity) : 0;
      const scoreB = b.type === "file" ? (b.match?.score ?? -Infinity) : 0;
      return scoreB - scoreA;
    });

    return results.slice(0, 30);
  }

  private showPreviewDebounced(item: SuggestionItem): void {
    if (this.previewDebounceTimer) {
      clearTimeout(this.previewDebounceTimer);
    }
    this.previewDebounceTimer = setTimeout(() => {
      this.showPreview(item);
    }, 80);
  }

  private async showPreview(item: SuggestionItem): Promise<void> {
    if (!this.previewEl) return;

    const file = item.file;
    const ext = file.extension.toLowerCase();
    const binaryExts = [
      "png", "jpg", "jpeg", "gif", "svg", "webp",
      "pdf", "mp3", "mp4", "wav", "zip", "tar", "gz",
    ];

    if (binaryExts.includes(ext)) {
      this.previewEl.empty();
      this.previewEl.createEl("div", {
        text: `${file.basename}.${ext} (${Math.round(file.stat.size / 1024)}KB)`,
        cls: "file-suggest-binary-info",
      });
      return;
    }

    const content = await this.app.vault.cachedRead(file);

    // Guard: modal may have closed during await
    if (!this.previewEl?.isConnected) return;

    const lines = content.split("\n").slice(0, 20).join("\n");
    this.previewEl.empty();
    this.previewEl.createEl("pre", { text: lines });
  }
}
