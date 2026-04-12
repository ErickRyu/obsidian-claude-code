# Changelog

All notable changes to obsidian-claude-code will be documented in this file.

## [0.4.0] - 2026-04-12

### Added
- **@-mention file picker**: 터미널에서 `@`를 누르면 vault 파일을 퍼지 검색하고 선택할 수 있는 팝업이 열립니다
- **파일 미리보기 패널**: 파일 선택 전 내용을 확인할 수 있는 2-column 레이아웃
- **헤딩 참조**: `@file#heading` 구문으로 특정 헤딩을 참조할 수 있습니다
- **폴더 필터**: 쿼리 끝에 `/`를 입력하면 해당 폴더 내 파일만 표시됩니다
- **vitest 테스트 인프라**: Obsidian API 모킹 + 20개 유닛 테스트

### Fixed
- Escape로 파일 선택 팝업을 닫으면 `@` 문자가 정상적으로 입력됩니다
- 바이너리 파일이나 1MB 이상 파일의 미리보기가 안전하게 처리됩니다

## [0.3.0] - 2026-04-10

### Added
- MCP context server: Claude Code가 열린 노트, 활성 파일, vault 검색에 접근 가능
- 시스템 프롬프트 자동 주입으로 열린 노트를 Claude에 알려줌
- `.mcp.json` 및 도구 권한 자동 설정

## [0.2.0] - 2026-04-06

### Added
- 멀티 탭 터미널 지원
- Claude AI 아이콘

## [0.1.0] - 2026-04-05

### Added
- Obsidian 사이드바에 Claude Code 터미널 임베딩
- xterm.js + node-pty 기반
- Shift+Enter 멀티라인 입력
- 테마 자동 동기화
- node-pty 네이티브 바이너리 자동 다운로드
