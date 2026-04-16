# Feature Coverage Report — `claude -p --output-format=stream-json`

**환경**: Claude Code `2.1.109`, macOS. `claude -p --input-format=stream-json --output-format=stream-json --verbose`.
**측정일**: 2026-04-15.
**샘플 위치**: `spike/samples/`.

범례: **O** = 작동 / **X** = 작동 안 함 / **부분** = workaround 필요 / **모름** = 미완전 검증.

---

| # | 기능 | 결과 | 시도 방법 | 실측 결과 / workaround | 샘플 |
|---|------|------|-----------|--------------------------|------|
| 1 | 간단한 질문 → 답변 | **O** | stdin으로 `{"type":"user","message":{"role":"user","content":"Respond with one word"}}` | `assistant` 이벤트에 `.message.content[{type:"text",text:"hello"}]`. 이어 `result/success`. 기본 흐름 완성. | `hello.jsonl` |
| 2 | 파일 편집 툴 호출 (Edit) | **O** | `/tmp/spike-test-edit.md` 수정 요청. `--permission-mode=acceptEdits`. | `assistant.content[{type:"tool_use",name:"Edit",input:{file_path,old_string,new_string}}]` → `user.content[{type:"tool_result",tool_use_id,content:"..."}]` → 다음 `assistant` text. tool_use/tool_result는 **별도 최상위 이벤트가 아니라** Anthropic Messages API 블록 포맷 그대로. | `edit.jsonl` |
| 3 | Permission prompt | **X (중대)** | `--permission-mode=default`로 write 요청. | `permission_request` 이벤트 **나오지 않음**. `-p` 모드는 interactive permission prompt를 지원하지 않고 pre-decided mode (`acceptEdits` / `plan` / `bypassPermissions` / `default`)로만 동작. `default`에서 허용 불가 작업은 그대로 통과하거나 `result.permission_denials`에 사후 보고. **웹뷰에서 VS Code식 inline 승인 UX는 stream-json 단독으론 불가**. 해결책 후보: ① `--permission-prompt-tool <mcp-tool>` 플래그 (확인 필요), ② `bypassPermissions`로 돌리고 클라이언트에서 tool_use를 가로채 자체 승인 모달 후 재시도, ③ PTY 모드와 하이브리드. | `permission.jsonl` |
| 4 | Plan mode 진입 | **부분** | `--permission-mode=plan`으로 시작. | 세션이 plan mode로 기동됨 (`permissionMode: "plan"` in `system:init`). 모델이 `thinking` 블록 + clarifying question까지 찍고 턴 종료. ExitPlanMode 시 전용 이벤트/툴콜은 이번 샘플에선 미관측 — 구체 플랜을 받으려면 "구체 요구사항 제공 + 플랜만 달라" 재시도 필요. 런타임 중 모드 전환(TAB shift 등)은 `-p` 단발 세션에선 시도 안 함. | `plan-mode.jsonl` |
| 5 | TodoWrite 호출 | **O** | "Use TodoWrite to create a 3-item plan…" | `assistant.content[{type:"tool_use",name:"TodoWrite",input:{todos:[...]}}]` → `user.content[{type:"tool_result",content:"..."}]`. 정상. 웹뷰에서 `todos` 배열을 추출해 사이드 패널로 hoist 가능. | `todo.jsonl` |
| 6a | 슬래시 커맨드 `/compact` | **O** | stdin으로 `{"type":"user","message":{"role":"user","content":"/compact"}}`. | 작동. 이벤트 시퀀스: `system:status {status:"compacting"}` → `system:compact_boundary {pre_tokens, post_tokens, duration_ms}` → `system:status {compact_result:"success"}` → `result/success`. 웹뷰에서 구분선 카드 렌더 근거 충분. | `slash-compact.jsonl` |
| 6b | 슬래시 커맨드 `/mcp` | **X** | 같은 방식으로 `"/mcp"`. | `result.result: "Unknown command: /mcp"`, assistant 블록 0개. `-p` 모드에서 TUI 전용 슬래시는 **인식 안 됨**. Workaround: 웹뷰 클라이언트가 자체적으로 슬래시 팔레트를 제공하거나, TUI 의존 커맨드는 xterm.js 모드로 폴백. | `slash-mcp.jsonl` |
| 7 | Session resume (`--resume <id>`) | **부분** | 직전 `hello.jsonl`의 `session_id`로 `--resume` 시도. | `result/error_during_execution`, `errors: ["No conversation found with session ID: ..."]`. `-p` 모드로 생성한 세션이 on-disk persisted store(`~/.claude/projects/<slug>/*.jsonl`)에 저장되는지 불확실. Obsidian 플러그인이 세션 관리를 직접 해야 할 수도(stream 원본을 vault에 save + stdin으로 replay). 플래그 자체는 수용되고 에러도 JSON으로 반환됨. | `resume.jsonl` |
| 8 | MCP 서버 주입 | **O** | `-p` 단발 세션 시작 후 `system:init.mcp_servers` 확인. | 8개 MCP 서버 중 7개 `status:"connected"`, 1개 `failed` (설정 이슈, stream-json과 무관). `.mcp.json` 자동 탐색 + 플러그인 MCP 모두 `-p` 모드에서도 활성화됨. 기존 obsidian-context MCP는 `.mcp.json` 경유 주입으로 그대로 재사용 가능. | `hello.jsonl` |

---

## 추가 발견 (요약)

- **이벤트 이름 정정**: `assistant_message` / `user_message` / `tool_use` / `tool_result` / `permission_request` 같은 최상위 타입은 **없음**. 실측 타입: `system` / `user` / `assistant` / `rate_limit_event` / `result`. 스파이크 핸드오프 프롬프트의 가정은 부정확. 본 구현은 실측 기준으로 진행해야 함.
- **block 타입**: `text`, `thinking`(signed), `tool_use`, `tool_result`. thinking 블록이 plan mode나 extended thinking 활성 시 기본으로 등장 — 웹뷰에서 토글 UI 필수.
- **hooks**: 사용자 훅이 stream을 오염시킴. 기본 렌더는 `type==="system" && subtype.startsWith("hook_")` 필터링.
- **result 메타**: 토큰/비용/duration 전부 포함. 컨텍스트 인디케이터(`42% ctx`)는 `modelUsage.<model>.inputTokens / contextWindow`로 즉시 계산 가능.
- **이미지 입력**: 이번 스파이크 범위 외. `user.message.content`가 block array를 받을 수 있으니 이론상 가능. 별도 검증 필요.
