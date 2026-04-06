import type { ITheme } from "@xterm/xterm";

function getCssVar(name: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

export function buildXtermTheme(): ITheme {
  return {
    background: getCssVar("--background-primary") || "#1e1e1e",
    foreground: getCssVar("--text-normal") || "#d4d4d4",
    cursor: getCssVar("--text-accent") || "#528bff",
    cursorAccent: getCssVar("--background-primary") || "#1e1e1e",
    selectionBackground: getCssVar("--text-selection") || "#264f7844",
    selectionForeground: undefined,
    black: "#000000",
    red: "#cd3131",
    green: "#0dbc79",
    yellow: "#e5e510",
    blue: "#2472c8",
    magenta: "#bc3fbc",
    cyan: "#11a8cd",
    white: "#e5e5e5",
    brightBlack: "#666666",
    brightRed: "#f14c4c",
    brightGreen: "#23d18b",
    brightYellow: "#f5f543",
    brightBlue: "#3b8eea",
    brightMagenta: "#d670d6",
    brightCyan: "#29b8db",
    brightWhite: "#ffffff",
  };
}
