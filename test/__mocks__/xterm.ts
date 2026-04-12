import { vi } from "vitest";

export class Terminal {
  options: any = {};
  cols = 80;
  rows = 24;
  constructor(_opts?: any) {}
  open(_el: any) {}
  write(_data: string) {}
  dispose() {}
  loadAddon(_addon: any) {}
  focus() {}
  hasSelection() { return false; }
  getSelection() { return ""; }
  onData(_cb: (data: string) => void) { return { dispose: vi.fn() }; }
  attachCustomKeyEventHandler(_cb: (event: KeyboardEvent) => boolean) {}
}
