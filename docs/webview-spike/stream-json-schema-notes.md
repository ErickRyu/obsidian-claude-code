# stream-json Schema Notes

**실측 환경**: Claude Code `2.1.109`, macOS, `claude -p --output-format=stream-json --input-format=stream-json --verbose`.
**측정일**: 2026-04-15.
**샘플 위치**: `spike/samples/*.jsonl` (6개 시나리오).
**공식 문서**: 이벤트 타입별 TypeScript 정의는 [`@anthropic-ai/claude-code`](https://www.npmjs.com/package/@anthropic-ai/claude-code) SDK가 게시됐는지 최종 리포트 작성 시 Context7으로 재확인. 본 문서는 **실측 JSON 기준**.

---

## Top-level 이벤트 타입

관측된 최상위 `type` 값:

| type | subtype | 의미 | 실측 빈도 |
|------|---------|------|-----------|
| `system` | `init` | 세션 시작, 메타 전부 | 세션당 1 |
| `system` | `hook_started` / `hook_response` | 사용자 훅 실행 | 훅 수 × 2 |
| `system` | `status` | `status: "compacting"` 등 런타임 상태 | 필요 시 |
| `system` | `compact_boundary` | `/compact` 경계 | `/compact` 사용 시 |
| `user` | — | 사용자 턴. tool_result도 여기 들어옴 | 턴당 1+ |
| `assistant` | — | 모델 응답 턴. text/thinking/tool_use 블록 포함 | 턴당 1+ |
| `rate_limit_event` | — | 시작 시 한 번 | 세션당 1 |
| `result` | `success` / (error?) | 세션 종료, 총 usage/cost | 세션당 1 |

**핵심 관찰**: `assistant_message`, `tool_use`, `tool_result`, `permission_request`는 **별도 최상위 타입이 아님**. Anthropic Messages API와 동일하게 `user`/`assistant`의 `.message.content[]` 블록 안에 섞여 있음. 스파이크 시작 전 핸드오프에서 가정한 "`assistant_message`" 이벤트명은 **틀림**.

---

## `system:init`

세션 시작 직후, 가장 유용한 메타.

```json
{
  "type": "system",
  "subtype": "init",
  "session_id": "d318d71a-...",
  "uuid": "...",
  "cwd": "/Users/sungjin/.../pure-gliding-pike",
  "model": "claude-opus-4-6[1m]",
  "permissionMode": "acceptEdits",
  "claude_code_version": "2.1.109",
  "apiKeySource": "...",
  "fast_mode_state": "off",
  "mcp_servers": [ /* 이름+상태 배열 */ ],
  "tools": [ /* 사용 가능 도구 이름 배열, 예시 116개 */ ],
  "slash_commands": [ /* 425개 */ ],
  "agents": [...],
  "memory_paths": [...],
  "output_style": "...",
  "plugins": [...],
  "skills": [...]
}
```

**웹뷰에 유용**: `session_id`, `model`, `permissionMode`, `cwd`, `mcp_servers`, `tools`, `slash_commands`. 헤더 배지와 슬래시 커맨드 자동완성 소스로 쓸 수 있음.

---

## `assistant`

모델의 한 턴. `.message`는 Anthropic Messages API 포맷 그대로.

```json
{
  "type": "assistant",
  "message": {
    "id": "msg_...",
    "type": "message",
    "role": "assistant",
    "model": "claude-opus-4-6",
    "content": [ /* 블록 배열 — 아래 참조 */ ],
    "stop_reason": null | "end_turn" | ...,
    "stop_sequence": null,
    "stop_details": null,
    "usage": { "input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "cache_creation": {...}, "service_tier", "inference_geo" },
    "context_management": null
  },
  "parent_tool_use_id": null,
  "session_id": "...",
  "uuid": "..."
}
```

### `.message.content[]` 블록 종류

| block.type | 페이로드 | 실측 예시 |
|------------|----------|-----------|
| `text` | `{ type, text }` | `{"type":"text","text":"hello"}` |
| `thinking` | `{ type, thinking, signature }` | plan mode 또는 extended thinking 활성 시. signature는 서명된 blob (그대로 보존해야 함) |
| `tool_use` | `{ type, id, name, input, caller }` | `{"type":"tool_use","id":"toolu_01...","name":"Edit","input":{...},"caller":{"type":"direct"}}` |
| `tool_result` | **여기엔 안 옴**. `user` 이벤트 쪽. | — |

**중요**: 한 `assistant` 이벤트가 여러 블록 담을 수 있지만, 실측에선 블록당 1 이벤트(스트리밍 중간 상태 포함)로 쪼개져 오는 경우도 보임. 파서는 같은 `message.id`로 누적해야 함.

---

## `user`

사용자 턴 또는 tool_result 회신.

### 순수 사용자 입력 (우리가 stdin으로 보낸 것)

입력 포맷 그대로 에코:

```json
{
  "type": "user",
  "message": { "role": "user", "content": "Respond with one word: hello" }
}
```
(최상위에 `session_id`, `uuid`는 없을 수도 있음 — 우리가 보낸 입력 라인이 그대로 찍히는 듯)

### tool_result 회신 (Claude가 자기 자신에게 보내는 턴)

`.message.content[]` 블록:

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      { "type": "tool_result", "tool_use_id": "toolu_01...", "content": "1\tHello from spike\n2\t" }
    ]
  },
  "parent_tool_use_id": null,
  "session_id": "...",
  "uuid": "..."
}
```

`content` 필드는 **string** 또는 **array of blocks** (이미지 등 가능). 파서가 둘 다 처리해야 함.

---

## `rate_limit_event`

```json
{
  "type": "rate_limit_event",
  "rate_limit_info": {
    "status": "allowed",
    "resetsAt": 1776261600,
    "rateLimitType": "five_hour",
    "overageStatus": "allowed",
    "overageResetsAt": 1777593600,
    "isUsingOverage": false
  },
  "uuid": "...",
  "session_id": "..."
}
```

웹뷰에선 배지 (`status !== "allowed"`일 때 경고 표시) 정도에 유용.

---

## `result`

세션 종료. 요약 + 최종 usage/cost.

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 6762,
  "duration_api_ms": 6522,
  "num_turns": 2,
  "result": "<최종 사용자 대상 텍스트 1줄 요약>",
  "stop_reason": "end_turn",
  "session_id": "...",
  "total_cost_usd": 0.27178,
  "usage": { /* 전체 토큰 합 + per-iteration 배열 */ },
  "modelUsage": {
    "claude-opus-4-6[1m]": {
      "inputTokens", "outputTokens", "cacheReadInputTokens",
      "cacheCreationInputTokens", "webSearchRequests", "costUSD",
      "contextWindow", "maxOutputTokens"
    }
  },
  "permission_denials": [],
  "terminal_reason": "completed" | ...,
  "fast_mode_state": "off",
  "uuid": "..."
}
```

**컨텍스트 인디케이터 (`42% ctx`) 구현은 여기에서 free**. `modelUsage.<model>.inputTokens / contextWindow` 또는 assistant.message.usage 누적으로 계산.

---

## `system:hook_started` / `system:hook_response`

사용자가 설정한 SessionStart/Stop/... 훅이 실행되면 stream에 섞임.

```json
{
  "type": "system",
  "subtype": "hook_started",
  "hook_id": "5cad8c38-...",
  "hook_name": "SessionStart:startup",
  "hook_event": "SessionStart",
  "uuid": "...",
  "session_id": "..."
}
```

```json
{
  "type": "system",
  "subtype": "hook_response",
  "hook_id": "...",
  "hook_name": "SessionStart:startup",
  "hook_event": "SessionStart",
  "output": "ouroboros: update check failed: ...\nSuccess\n",
  "stdout": "Success\n",
  "stderr": "ouroboros: update check failed: ...\n",
  "exit_code": 0,
  "outcome": "success",
  "uuid": "...",
  "session_id": "..."
}
```

**웹뷰 권고**: 기본값으로 숨김. "Developer" 또는 debug 패널에서만 노출. 노이즈 대부분이 여기서 나옴.

---

## `system:status` (실측)

`/compact` 중 두 번 관측:

```json
{"type":"system","subtype":"status","status":"compacting","session_id":"...","uuid":"..."}
{"type":"system","subtype":"status","status":null,"compact_result":"success","session_id":"...","uuid":"..."}
```

다른 런타임 상태(요약/요청 지연 등)에도 쓰이는 듯. **웹뷰에서 로딩/스피너 트리거로 활용 가능**.

---

## `system:compact_boundary`

`/compact` 완료 마크.

```json
{
  "type": "system",
  "subtype": "compact_boundary",
  "session_id": "...",
  "uuid": "...",
  "compact_metadata": {
    "trigger": "manual" | "auto",
    "pre_tokens": 1601,
    "post_tokens": 3632,
    "duration_ms": 13428
  }
}
```

웹뷰에서 "여기서 대화가 요약됨 | -80% tokens" 같은 구분선 카드에 쓸 수 있음.

---

## 관측되지 않은 / 확인 못 한 타입

- `permission_request` — `-p --permission-mode=default` 에서도 **나오지 않음**. `-p` 모드는 interactive permission prompt를 지원하지 않는 것으로 보임. `result.permission_denials`는 사후 보고용.
- `permission_response` (stdin 입력 예약) — 사용 불가 추정. 별도 검증 필요.
- plan mode의 `ExitPlanMode` 이벤트 — plan-mode.jsonl에서 모델이 clarifying question에서 턴 종료해 구체 블록 못 봄. `--permission-mode=plan` + 더 강한 프롬프트로 재실측 필요.
- `tool_use` block types 중 `BashOutput`, `KillBash` 등 long-running bash 관련 — 미관측.
- `MCP` 이벤트 (MCP 서버가 produce하는 notification/progress) — 별도 샘플 필요.

---

## 파서 설계 힌트

1. **라인 버퍼링**: 각 JSONL 라인은 독립 JSON. `\n` split, 마지막 조각은 버퍼에 유지.
2. **파싱 실패 허용**: 이론상 모든 라인 유효하나, 로그 섞임 가능성 대비 `try { JSON.parse } catch { console.warn(line) }`.
3. **이벤트 분류**:
   - 기본 화면 표시 대상: `assistant`, `user` (tool_result만), `system/init`, `system/compact_boundary`, `result`.
   - 기본 숨김: `system/hook_*`, `rate_limit_event`, `system/status`.
4. **메시지 누적**: 같은 `message.id`는 하나의 카드. `content[]` 블록이 여러 이벤트에 걸쳐 올 수 있으면 append (실측에선 한 번에 다 옴 but 스트리밍 모드에선 chunked 가능).
5. **Markdown 렌더**: `text` 블록은 `MarkdownRenderer.render(app, text, el, cwd, view)`로. `thinking` 블록은 토글 접기/펴기.
6. **tool_use 카드**:
   - `Read` / `Glob` / `Grep` → 결과 요약 inline
   - `Edit` / `Write` → diff 뷰어 (accept/reject 불가, 이미 적용됨 — acceptEdits mode)
   - `Bash` → 명령 + 출력
   - `TodoWrite` → 전용 패널로 hoist
7. **result 이벤트**: 세션 종료 표시 + 토큰/비용 배지 업데이트.
