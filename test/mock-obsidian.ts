import { vi } from "vitest";
import type { TFile, App, CachedMetadata } from "obsidian";

export function createMockTFile(
  path: string,
  overrides: Partial<TFile> = {}
): TFile {
  const parts = path.split("/");
  const basename = parts[parts.length - 1].replace(/\.[^.]+$/, "");
  const extension = path.split(".").pop() ?? "md";
  const parentPath = parts.slice(0, -1).join("/") || "/";

  return {
    path,
    name: parts[parts.length - 1],
    basename,
    extension,
    stat: { mtime: Date.now(), ctime: Date.now(), size: 1024 },
    vault: {} as any,
    parent: { path: parentPath, name: parts[parts.length - 2] ?? "", children: [], isRoot: () => parentPath === "/", vault: {} as any } as any,
    ...overrides,
  } as TFile;
}

export function createMockApp(options: {
  files?: TFile[];
  fileContents?: Record<string, string>;
  headings?: Record<string, Array<{ heading: string; level: number; position: any }>>;
} = {}): App {
  const files = options.files ?? [];
  const fileContents = options.fileContents ?? {};
  const headings = options.headings ?? {};

  return {
    vault: {
      getFiles: vi.fn(() => files),
      getMarkdownFiles: vi.fn(() => files.filter((f) => f.extension === "md")),
      getAllLoadedFiles: vi.fn(() => files),
      cachedRead: vi.fn(async (file: TFile) => fileContents[file.path] ?? ""),
    },
    metadataCache: {
      getFileCache: vi.fn((file: TFile): CachedMetadata | null => {
        const h = headings[file.path];
        if (!h) return null;
        return { headings: h } as CachedMetadata;
      }),
    },
  } as unknown as App;
}
