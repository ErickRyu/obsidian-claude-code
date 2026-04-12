import { vi } from "vitest";

export class ItemView {
  app: any;
  leaf: any;
  containerEl: any = { children: [null, { empty: vi.fn(), createDiv: vi.fn(), addClass: vi.fn() }] };
  icon = "";
  constructor(leaf: any) { this.leaf = leaf; this.app = leaf?.app; }
  getViewType() { return ""; }
  getDisplayText() { return ""; }
  getIcon() { return ""; }
  registerEvent(_: any) {}
}

export class Notice {
  constructor(_msg: string) {}
}

export class WorkspaceLeaf {
  app: any;
  view: any;
}

export class App {}

export class SuggestModal<T> {
  app: any;
  modalEl: any;
  scope: any = {};
  inputEl: any = {};
  resultContainerEl: any = {};

  constructor(app: any) {
    this.app = app;
    this.modalEl = {
      addClass: vi.fn(),
      createDiv: vi.fn(() => ({
        empty: vi.fn(),
        createEl: vi.fn(),
        isConnected: true,
      })),
      querySelector: vi.fn(() => null),
    };
  }

  setPlaceholder(_text: string) {}
  setInstructions(_instructions: any[]) {}
  open() {}
  close() {}
  onOpen() {}
  onClose() {}
  getSuggestions(_query: string): T[] { return []; }
  renderSuggestion(_item: T, _el: HTMLElement) {}
  onChooseSuggestion(_item: T, _evt: MouseEvent | KeyboardEvent) {}
}

export class TFile {
  path = "";
  name = "";
  basename = "";
  extension = "";
  stat = { mtime: 0, ctime: 0, size: 0 };
  vault: any;
  parent: any;
}

export class TFolder {
  path = "";
  name = "";
  children: any[] = [];
  isRoot() { return false; }
  vault: any;
  parent: any;
}

export function prepareFuzzySearch(query: string) {
  const lowerQuery = query.toLowerCase();
  return (text: string) => {
    if (text.toLowerCase().includes(lowerQuery)) {
      return { score: -text.length + 100, matches: [] };
    }
    return null;
  };
}

export function addIcon(_id: string, _svg: string) {}

export class Plugin {
  app: any;
  manifest: any = { id: "test" };
  async loadData() { return {}; }
  async saveData(_data: any) {}
  addCommand(_cmd: any) {}
  addSettingTab(_tab: any) {}
  registerView(_type: string, _factory: any) {}
  registerEvent(_event: any) {}
}

export class PluginSettingTab {
  app: any;
  containerEl: any = { empty: vi.fn() };
  constructor(app: any, _plugin: any) { this.app = app; }
}

export class Setting {
  constructor(_el: any) {}
  setName(_name: string) { return this; }
  setDesc(_desc: string) { return this; }
  addText(_cb: any) { return this; }
  addToggle(_cb: any) { return this; }
}

export type SearchResult = { score: number; matches: any[] };
export type CachedMetadata = { headings?: Array<{ heading: string; level: number; position: any }> };
export type Instruction = { command: string; purpose: string };
