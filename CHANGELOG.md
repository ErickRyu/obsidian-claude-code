# Changelog

All notable changes to obsidian-claude-code will be documented in this file.

## [0.5.0] - 2026-04-15

### Added
- **Cmd/Ctrl+click vault notes**: Click any vault path or `obsidian://open` URL Claude prints in the terminal to jump straight to the note in Obsidian
- **Smart path detection**: Recognizes paths with spaces, Korean characters, and Markdown link syntax — only highlights paths that actually exist in your vault

### Changed
- **System prompt now instructs Claude to format vault references as clickable Obsidian URLs** with percent-encoded paths so click-to-open works reliably even when the terminal wraps long lines

## [0.4.0] - 2026-04-12

### Added
- **@-mention file picker**: Type `@` in the terminal to open a fuzzy file search popup for vault files
- **File preview panel**: 2-column layout showing file content preview before selection
- **Heading reference**: Use `@file#heading` syntax to reference specific headings
- **Folder filter**: Append `/` to the query to filter files within a specific folder
- **vitest test infrastructure**: Obsidian API mocks + 20 unit tests

### Fixed
- Dismissing the file picker with Escape now correctly types the literal `@` character
- Binary files and files over 1MB are safely handled in the preview panel

## [0.3.0] - 2026-04-10

### Added
- MCP context server exposing open notes, active file, and vault search to Claude Code
- Auto-inject open notes into Claude's system prompt
- Auto-configure `.mcp.json` and tool permissions on load

## [0.2.0] - 2026-04-06

### Added
- Multi-tab terminal support
- Claude AI sidebar icon

## [0.1.0] - 2026-04-05

### Added
- Embed Claude Code terminal in Obsidian's sidebar
- xterm.js + node-pty based terminal
- Shift+Enter multiline input
- Automatic theme synchronization
- Auto-download node-pty native binary on first launch
