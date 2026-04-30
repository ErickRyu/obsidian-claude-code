// Minimal "obsidian" shim used only by scripts/dump-defaults.js so
// `src/settings.ts` can be imported under Node without pulling in Obsidian.
// Only the symbols settings.ts references at module top-level need to be present.
module.exports = {
  App: class App {},
  Notice: class Notice { constructor(_m) {} },
  PluginSettingTab: class PluginSettingTab {
    constructor(_app, _plugin) {}
  },
  Setting: class Setting {
    constructor(_el) {}
    setName() { return this; }
    setDesc() { return this; }
    addText() { return this; }
    addToggle() { return this; }
    addDropdown() { return this; }
  },
};
