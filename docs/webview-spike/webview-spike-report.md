# Webview Spike Report — v0.6.0 stream-json

**Status**: 1일 스파이크 완료 (2026-04-15).
**Branch**: `spike/webview-stream-json` (base: `main` at `10be3d3`, PR #4 merge 후).
**Claude Code 버전 측정**: `2.1.109`.
**아티팩트**:
- `spike/stream-json-schema-notes.md`
- `spike/feature-coverage-report.md`
- `spike/samples/*.jsonl` (7개 샘플)
- `spike/webview-proto.ts` + `src/main.ts` 배선 (빌드 OK, 테스트 81/81 통과)
- 본 리포트

---

## Executive Summary

**가능합니다. 3주 일정 유지 가능. 단, permission UX가 **단독 해결 불가능한 큰 unknown**이고, 이걸 어떻게 처리할지가 v0.6.0 설계의 핵심 결정.**

- `stream-json` 이벤트는 안정적. 포맷은 **Anthropic Messages API 블록 스키마와 동일**해서 배울 것이 적음.
- 사전 가정했던 이벤트 이름(`assistant_message`, `tool_use`, `permission_request` 등)은 **틀림**. 실측 타입은 `system` / `user` / `assistant` / `rate_limit_event` / `result`. tool_use/tool_result는 `content[]` 블록 안에 내장.
- `/compact`, `/clear` 같은 일부 슬래시는 작동. **`/mcp` 등 TUI 전용은 "Unknown command" 반환**. 폴백 설계 필요.
- **`-p` 모드는 interactive permission prompt를 지원하지 않음**. `permission_request` 이벤트 없음. pre-decided mode 4개만 (`default` / `acceptEdits` / `plan` / `bypassPermissions`). VS Code식 inline 승인 UX를 구현하려면 ① `bypassPermissions`에서 tool_use를 클라이언트가 가로채 자체 승인 모달 → 재실행, 또는 ② `--permission-prompt-tool`(MCP 툴 기반, 미검증)로 hook, 또는 ③ PTY 모드 하이브리드 중 하나를 골라야 함.

**일정 권고: 3주 유지. Permission 문제는 SDK `canUseTool` 콜백으로 해결 가능 (아래 참조).**

### Permission UX 해결: CLI `--allowedTools` + permission preset UX

~~SDK `canUseTool` 콜백이 이상적이지만, SDK는 API 키 인증을 요구 (구독 인증 금지).~~
사용자층이 Claude 구독자이므로 **CLI `-p` 모드 유지가 필수**.

**해결 방법: `--allowedTools` 기반 permission preset**
- `--allowedTools "Read,Glob,Grep"` → Safe 모드 (읽기 전용)
- `--allowedTools "Read,Edit,Write,Glob,Grep"` → Standard 모드 (편집 허용)
- `--allowedTools "Read,Edit,Write,Bash,Glob,Grep"` → Full 모드 (전부 허용)
- `--permission-mode acceptEdits` 또는 `dontAsk`과 조합

**UX 흐름:**
1. 웹뷰 세션 시작 시 permission preset 선택 드롭다운
2. 선택에 따라 `--allowedTools` + `--permission-mode` 조합으로 `claude -p` spawn
3. 허용 안 된 도구 사용 시도 → `result.permission_denials` 보고 → "이 도구를 허용하시겠습니까?" 모달 → `--resume` + 추가 `--allowedTools`로 세션 이어감

**추가 발견 (headless 문서):**
- `--include-partial-messages` → 토큰 단위 스트리밍 (`stream_event` 타입). 타이핑 효과 구현 가능.
- `--resume <session_id>` → 세션 이어가기 CLI에서 정상 동작
- `--mcp-config` → MCP 서버 주입 가능
- `--bare` → 깔끔한 시작 (hooks/skills/plugins 스킵). CI용이지만 웹뷰 세션에도 유용할 수 있음
- inline 건별 승인(VS Code식)은 CLI만으론 불가. 하지만 preset + resume로 **실용적 동등** 달성.

**결론: SDK 전환 불필요. CLI `-p` + `--allowedTools`로 구독 인증 유지하면서 permission UX 해결.**

### 최종 결정 (2026-04-16)

**CLI `claude -p` spawn 확정.** SDK(`@anthropic-ai/claude-agent-sdk`)는 API 키 인증 전용이며,
제3자가 구독 인증(OAuth 토큰 포함)을 자기 제품에 사용하는 것을 Anthropic TOS가 금지.
사용자층이 Claude Max/Pro 구독자이므로 CLI spawn이 유일하게 합법적이고 구독 호환되는 방법.

---

## 스키마 맵 요약

| Top-level type | subtype | 빈도 | 렌더 우선순위 |
|----------------|---------|------|---------------|
| `system` | `init` | 세션 1회 | 필수 (model/mcp/session meta) |
| `system` | `hook_started` / `hook_response` | 훅당 2 | **숨김** (debug 옵션) |
| `system` | `status` | 가변 | 스피너 트리거 |
| `system` | `compact_boundary` | `/compact` 시 | 구분선 카드 |
| `user` | — | 턴마다 | tool_result 블록만 카드화 (stdin echo는 스킵) |
| `assistant` | — | 턴마다 | **메인 카드** — text/thinking/tool_use 블록 처리 |
| `rate_limit_event` | — | 시작 1회 | 배지 |
| `result` | `success` / `error_during_execution` | 세션 1회 | 최종 카드 + 토큰/비용 |

블록 레벨:
- `text`: `MarkdownRenderer.render()`로 그대로.
- `thinking`: `signature` 보존, 기본 접힘 토글.
- `tool_use`: name별 전용 카드 (Edit→diff, Bash→output, TodoWrite→사이드 패널).
- `tool_result`: `user.message.content[].type==="tool_result"`. `content`가 string 또는 block array.

상세: `spike/stream-json-schema-notes.md`.

---

## 커버리지 결과 (요약)

| 기능 | 결과 |
|------|------|
| 간단 Q&A | O |
| 파일 편집 (Edit tool) | O |
| **Permission prompt** | **X — 별도 설계 필요** |
| Plan mode | 부분 (`--permission-mode=plan` 기동은 OK, ExitPlanMode 이벤트 형태 미확정) |
| TodoWrite | O |
| `/compact` | O (`compact_boundary` 이벤트) |
| `/mcp` | X (Unknown command) |
| Session resume | 부분 (플래그 작동, 단 `-p` 세션이 on-disk store에 저장되는지 확인 필요) |
| MCP 서버 주입 | O (기존 obsidian-context MCP 재사용 가능) |

상세: `spike/feature-coverage-report.md`.

---

## 발견한 제약

1. **Permission UX (최대 unknown)**. `-p` 모드는 런타임에 유저가 허용/거부를 고르는 경로 없음. VS Code의 inline 승인 UX를 재현하려면 별도 메커니즘 필요.
2. **TUI-only 슬래시 커맨드**. `/mcp`, `/plugins` 등은 작동 안 함. 웹뷰 클라이언트가 자체 슬래시 팔레트를 구현하거나 xterm.js 모드 폴백이 필요.
3. **Session resume persistence**. `-p` 모드 세션이 `~/.claude/projects/<slug>/*.jsonl`에 저장되는지 불확실. 저장 안 되면 플러그인이 직접 stream을 vault에 아카이브하고 replay하는 구조 필요 (그게 v0.8.0 conversation-as-note와 맞물려 유리할 수도).
4. **hooks 노이즈**. 사용자 훅이 stream에 대량 끼어듦. 기본 필터 필수.
5. **`thinking` 블록**. plan mode나 extended thinking 활성 시 기본으로 등장. UI에서 숨김/펴기 토글 필수.
6. **파싱 견고성**. stderr 로그가 stdout에 섞일 가능성 대비 `try/catch` + 비 JSON 라인 skip 필수. 실측에서 resume 실패 시 첫 라인이 non-JSON 에러였음.
7. **스키마 드리프트**. Claude Code 버전 업그레이드 시 이벤트 추가/필드 변경 가능성. 미지 이벤트는 graceful fallback (collapsed JSON dump) 필수.
8. **TTY 요구 기능**. `fast_mode_state`, `output_style`, 일부 slash는 TTY 기능일 수 있음. `-p` 모드로 안 되는 건 명시적으로 터미널 모드에 위임.

---

## v0.6.0 일정 조정

**기존 추정**: 3주.
**본 스파이크 후 권고**: **3주 유지. 단, 내부 구성을 다음과 같이.**

### Week 1 — Permission UX 결정 + 인프라
- 연구/POC:
  - `--permission-prompt-tool <mcp-tool>` 실증 (공식 문서 + SDK 확인 + 1일 POC).
  - `bypassPermissions` + 클라이언트 자체 승인 UX POC.
  - PTY 모드 하이브리드 (위험한 tool은 xterm.js로 위임) 설계.
- 결정: 3개 중 하나 선택 → 설계 문서 1페이지.
- 인프라:
  - `src/webview/stream-json-parser.ts` (라인 버퍼 + 타입 가드).
  - `src/webview/event-bus.ts` (이벤트 큐 + 메시지 ID 누적).
  - `src/webview/webview.ts` (`ItemView`, 기본 카드 컨테이너).
  - 세팅: `uiMode: "terminal" | "webview"` (기본 `terminal`).

### Week 2 — 카드 렌더러 (우선 구현)
- `event-cards/text.ts` — assistant text 블록 → markdown.
- `event-cards/thinking.ts` — toggle.
- `event-cards/tool-use-*.ts` — Edit(diff), Write, Read, Bash, Glob/Grep, TodoWrite 별 전용 렌더.
- `event-cards/tool-result.ts` — string/block array 모두 처리.
- `event-cards/result.ts` — 세션 종료 카드, 토큰/비용/컨텍스트 %.
- `event-cards/compact-boundary.ts` — 구분선.
- Todo 사이드 패널 (v0.7.0 원래 계획인데 v0.6.0에 포함 권고 — TodoWrite 렌더링하는 김에).

### Week 3 — 입력, 세션, 폴백, Beta
- 입력: textarea + 슬래시 팔레트(클라이언트 측 하드코딩 + `system:init.slash_commands` 동적 필터) + `@` 파일 피커 재사용.
- 세션:
  - `-p` 세션의 persistence 검증 → 안 되면 **직접 아카이브** (stream JSONL을 `_claude/sessions/<id>.jsonl`로 저장, resume 시 replay).
  - `--resume` integration.
- 폴백:
  - `/mcp`, `/plugins` 같은 TUI 슬래시는 "이 커맨드는 터미널 모드에서" 안내 + 원클릭 터미널 전환.
- 설정 토글 공개 (opt-in).
- Beta dogfooding.

**권고 순서 변화 (vs 원 TODO)**: Todo 사이드 패널은 v0.7.0 원래 계획이지만, 블록 렌더를 건드리는 김에 v0.6.0에 포함. 대신 diff accept/reject는 v0.7.0 유지 (permission 결정 후 자연스럽게 따라옴).

---

## 브레이크다운 제안 (우선순위 순)

### Must-have (v0.6.0 Beta)
1. stream-json 파서 + 라인 버퍼 + graceful fallback
2. `assistant.text` 카드 (markdown) — **스파이크 버그: 같은 `message.id`로 여러 이벤트가 올 경우 블록이 중복 append됨. 블록 인덱스 기반 upsert 또는 매 이벤트에 replaceChildren로 재렌더 필요.**
3. `assistant.tool_use` 기본 카드 (name + input dump)
4. `user.tool_result` 카드
5. `result` 카드 (토큰/비용/duration)
6. `system:init` 헤더 (model/mcp/session)
7. `system:hook_*` 기본 숨김 + debug 옵션
8. 입력 textarea + JSONL stdin write
9. **Permission 결정 구현** (선택한 한 가지)
10. `uiMode` 설정 토글
11. **뷰 생명주기 가드**: child process `exit`/`error`/stdout 콜백이 detached DOM에 setText/append하지 않도록 `onClose`에서 리스너 제거 또는 `this.leaf.view === this` 가드 (스파이크 `spike/webview-proto.ts:160`의 미완 부분).

### Should-have (v0.6.0 GA)
11. `thinking` 블록 토글
12. `Edit` / `Write` tool_use → diff 뷰 (가벼운 버전, accept/reject 없이)
13. `TodoWrite` → 사이드 패널
14. `compact_boundary` 구분선
15. `system:status` 스피너
16. 토큰/컨텍스트 배지 (`modelUsage` 활용)
17. 세션 직접 아카이브 (resume persistence 문제 해결)

### Could-have (v0.7.0로 미룸)
- diff accept/reject (permission 결정에 의존)
- 슬래시 팔레트
- 이미지 입력
- 진행 중 tool call 스피너 (long-running bash)
- session browser modal

### Won't-have (v0.6.0)
- 터미널 모드 deprecation — v0.8.0 평가 대상
- plan-as-note — v0.8.0 (차별화 축)
- checkpoint rewind — v0.8.0

---

## 다음 단계 제안

1. 이 리포트 리뷰 → Permission UX 세 안 중 결정.
2. 승인 시: `spike/webview-stream-json` 브랜치는 merge하지 **않고** reference로 유지. 새 브랜치 `feat/webview-v0.6.0`을 main에서 개시.
3. spike 브랜치의 `spike/webview-proto.ts`는 v0.6.0 구현 첫 커밋에 `src/webview/webview.ts`로 이식 (주석 정리 + 타입 강화).
4. Permission POC 1일: `--permission-prompt-tool` 작동 여부부터. 작동하면 설계 대폭 단순화.

**스파이크 종료. 실제 플러그인 UI 검증은 아직** — 빌드/테스트/타입 체크는 통과했으나 Obsidian에서 reload해 "Open Webview Proto" 커맨드가 assistant 카드를 렌더하는지 최종 눈 확인은 사용자 환경에서 필요. (검증 체크리스트: 플러그인 reload → 커맨드 팔레트 "Open Webview Proto" → textarea에 "hello" → Send → 초록색 assistant 카드 렌더.)
