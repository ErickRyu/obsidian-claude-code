# obsidian-claude v0.6.0 — Webview Foundation Implementation Plan

## Overview

v0.6.0는 `xterm.js` 터미널과 공존하는 **커스텀 웹뷰 (Obsidian `ItemView`)** 를 추가합니다.
`claude -p --output-format=stream-json --input-format=stream-json` 을 `child_process.spawn` 으로 실행해 JSONL 이벤트를 파싱하고, assistant 텍스트·tool_use·tool_result·result 를 구조화된 HTML 카드로 렌더합니다. Permission 은 `--allowedTools` + `--permission-mode` preset 드롭다운 (Safe / Standard / Full) 으로 사전 결정하며, VS Code 식 inline 승인은 v0.7.0 로 유보합니다.

이 릴리즈는 **"기능 추가"가 아니라 인프라 치환** 입니다. 이 foundation이 깔린 후에야 v0.7.0 diff accept/reject, v0.8.0 plan-as-note 가 얹힐 수 있습니다. 기존 `ClaudeTerminalView` 는 손대지 않고, `uiMode: "terminal" | "webview"` 토글로 공존시킵니다 — 기본값은 v0.6.0 Beta 단계에서 `terminal` 유지, 사용자가 opt-in.

## Must-have (MH-01 ~ MH-11) / Should-have (SH-01 ~ SH-07) Traceability Matrix

### Must-have (스파이크 리포트 Beta 기준)
| ID | 항목 | 구현 Phase | 검증 CMD 위치 |
|----|------|-----------|--------------|
| MH-01 | stream-json 파서 + 라인 버퍼 + graceful fallback | Phase 1 | 1-1 ~ 1-3 |
| MH-02 | assistant.text 카드 + msg-id 중복 방지 | Phase 2 | 2-4, 2-5 |
| MH-03 | assistant.tool_use 기본 카드 | Phase 4a | 4a-1 |
| MH-04 | user.tool_result 카드 | Phase 2 | 2-3 |
| MH-05 | result 카드 (토큰/비용/duration) | Phase 2 | 2-3 (cardKinds) |
| MH-06 | system:init 헤더 | Phase 2 | 2-3 |
| MH-07 | system:hook_* 기본 숨김 + debug 옵션 | Phase 5a | 5a-3 |
| MH-08 | 입력 textarea + JSONL stdin write | Phase 3 | 3-6 |
| MH-09 | Permission preset 드롭다운 + spawn 통합 | Phase 4b | 4b-1 ~ 4b-3 |
| MH-10 | uiMode 설정 토글 | Phase 0 | 0-5, 0-6 |
| MH-11 | 뷰 생명주기 가드 (child stream + DOM) | Phase 3 | 3-4, 3-5 |

### Should-have (v0.6.0 GA 기준 — 7개)
| ID | 항목 | 구현 Phase | 검증 CMD 위치 |
|----|------|-----------|--------------|
| SH-01 | thinking 블록 토글 | Phase 4a | 4a-5 |
| SH-02 | Edit/Write tool_use diff 뷰 (accept/reject 없음) | Phase 4a | 4a-1, 4a-2 |
| SH-03 | TodoWrite 사이드 패널 | Phase 4b | 4b-4, 4b-5 |
| SH-04 | compact_boundary 구분선 | Phase 5a | 5a-1 |
| SH-05 | system:status 스피너 | Phase 5a | 5a-3 (status-bar 테스트) |
| SH-06 | 토큰/컨텍스트 배지 (modelUsage) | Phase 5a | 5a-4 |
| SH-07 | 세션 직접 아카이브 (resume persistence) | Phase 5b | 5b-1, 5b-2, 5b-3 |

**규칙**: Phase 6 completion-matrix.json 에 **정확히 MH-01~11 + SH-01~07 = 18개 assertion 전부 `pass: true`** 여야 completion marker 생성 가능.

---

## Architecture

### 디렉토리 구조 (신규 `src/webview/`)

```
src/webview/
├── index.ts                     # 공개 API: wireWebview(plugin)
├── view.ts                      # ClaudeWebviewView (ItemView) — 마운트/언마운트, 생명주기 가드
├── settings-adapter.ts          # WebviewSettings 스키마 + DEFAULT_WEBVIEW_SETTINGS
├── event-bus.ts                 # 타입드 pub/sub (dispose()로 모든 리스너 해제)
│
├── session/
│   ├── session-controller.ts    # spawn/stdin/exit 관리, Bus로 이벤트 방출
│   ├── spawn-args.ts            # --allowedTools/--permission-mode/--mcp-config/--resume 조립
│   └── session-archive.ts       # Phase 5b: 직접 아카이브 (JSONL을 vault에 저장)
│
├── parser/
│   ├── line-buffer.ts           # stdout chunk → 라인 목록 (tail 조각 유지)
│   ├── stream-json-parser.ts    # line → StreamEvent, JSON 실패 graceful skip
│   ├── types.ts                 # StreamEvent discriminated union
│   └── fixture-replay.ts        # 테스트 helper (fixture 읽기 + feed)
│
├── renderers/
│   ├── card-registry.ts         # type+subtype → renderer 매핑
│   ├── assistant-text.ts        # msg-id upsert (replaceChildren 전략)
│   ├── assistant-tool-use.ts    # name + input JSON 카드
│   ├── assistant-thinking.ts    # <details> 토글
│   ├── user-tool-result.ts      # string/array content 둘 다
│   ├── system-init.ts           # 헤더 배지
│   ├── system-status.ts         # 스피너
│   ├── compact-boundary.ts      # 구분선 카드
│   ├── result.ts                # 토큰/비용/duration
│   ├── todo-panel.ts            # TodoWrite hoist (사이드 패널)
│   └── edit-diff.ts             # Edit/Write unified diff
│
└── ui/
    ├── layout.ts                # header / cards / todo-side / input-row 골격
    ├── input-bar.ts             # textarea + send + Cmd+Enter
    ├── permission-dropdown.ts   # Safe / Standard / Full preset
    └── status-bar.ts            # 모델 · preset · session_id · 토큰 배지
```

### 모듈 의존 관계

```
main.ts
  └─> webview/index.ts
        ├─> view.ts ──> session/session-controller ──> spawn-args, session-archive
        │       │                         │
        │       │                         └─> parser/line-buffer ──> stream-json-parser
        │       │                                                       └─> types
        │       ├─> event-bus (Controller와 View 양쪽이 구독)
        │       ├─> ui/{layout,input-bar,permission-dropdown,status-bar}
        │       └─> renderers/card-registry ──> 각 카드 렌더러
        └─> settings-adapter
```

**경계 규칙** (위반 시 lint 실패):
- `parser/*` 는 DOM · Obsidian · Node 전혀 의존하지 않음 (순수 함수, node -e 로 단독 테스트 가능)
- `renderers/*` 는 `{ app: App, container: HTMLElement, event: StreamEvent, state: ViewState }` 만 받음. `child_process` 접근 금지
- `session/*` 는 Node만 의존 (Obsidian 없음). DI로 `spawnImpl` 받아 테스트 가능
- `view.ts` 만 `ItemView` 상속. 세 계층을 결선하는 유일한 장소

### EventBus 시그니처

```ts
type BusEvent =
  | { kind: "parsed"; event: StreamEvent }               // parser → renderers
  | { kind: "session.spawning" }
  | { kind: "session.exit"; code: number | null }
  | { kind: "session.error"; message: string }
  | { kind: "ui.send"; text: string }                    // input-bar → controller
  | { kind: "ui.permission-change"; preset: PermissionPreset };

interface EventBus {
  on<K extends BusEvent["kind"]>(kind: K, fn: (e: Extract<BusEvent,{kind:K}>) => void): void;
  emit(e: BusEvent): void;
  dispose(): void;  // onClose 에서 호출 — 모든 리스너 제거 (생명주기 가드)
}
```

---

## Tech Stack

| 항목 | 선택 | 비고 |
|------|------|------|
| 언어 | TypeScript strict | `as any` / `@ts-ignore` 금지 (CI 게이트) |
| 빌드 | esbuild (`esbuild.config.mjs`) | 기존 설정 재사용, 번들 → `main.js` |
| 테스트 | vitest + jsdom | 기존 `test/__mocks__/obsidian.ts` 재사용 |
| CLI spawn | `child_process.spawn` | DI 가능, fake-spawn 으로 단위 테스트 |
| DOM | Vanilla + Obsidian API (`MarkdownRenderer`, `setIcon`) | React/Preact 금지 |
| Diff | 직접 구현 (unified 3-line context) | 라이브러리 추가 금지 |

---

## Mode 구분

| 구분 | 입력 | CLI spawn | 비고 |
|------|------|-----------|------|
| **Fixture** | `test/fixtures/stream-json/*.jsonl` | ✗ (fake-spawn) | Phase 0~5a 모든 PRODUCT 검증의 기본. 결정론적, 빠름, 무료 |
| **Real** | 사용자 입력 | ✓ (`claude -p ...`) | Phase 5b 끝에 1회 smoke. Phase 6 completion gate 에 포함 |

**원칙**: Fixture 로 통과된 기능이 Real 에서도 통과해야 함 (회귀 방지). Real 에서만 통과 / Fixture 에서 실패는 Ralph의 게이밍 신호.

---

## Phase 파일 Allowlist (Phase 경계 선점 방지 — PM-AP-3)

각 Phase 완료 시 `src/webview/**` 하위 **신규 파일** 은 아래 allowlist 에 정확히 일치해야 한다. `completion-gate.ts` 의 mini-gate 가 검증.

- **Phase 0 허용**: `index.ts`, `view.ts`, `settings-adapter.ts` (3개)
- **Phase 1 추가**: `parser/types.ts`, `parser/line-buffer.ts`, `parser/stream-json-parser.ts`, `parser/fixture-replay.ts` (+4)
- **Phase 2 추가**: `event-bus.ts`, `ui/layout.ts`, `renderers/card-registry.ts`, `renderers/assistant-text.ts`, `renderers/user-tool-result.ts`, `renderers/result.ts`, `renderers/system-init.ts`, `replay.ts` (fixture-replay 를 production 에 쓰기 위한 얇은 wrapper, feedChunk 공유) (+8)
- **Phase 3 추가**: `session/spawn-args.ts`, `session/session-controller.ts`, `ui/input-bar.ts` (+3)
- **Phase 4a 추가**: `renderers/assistant-tool-use.ts`, `renderers/assistant-thinking.ts`, `renderers/edit-diff.ts` (+3)
- **Phase 4b 추가**: `renderers/todo-panel.ts`, `ui/permission-dropdown.ts` (+2)
- **Phase 5a 추가**: `renderers/system-status.ts`, `renderers/compact-boundary.ts`, `ui/status-bar.ts` (+3)
- **Phase 5b 추가**: `session/session-archive.ts` (+1)
- **Phase 6 추가**: 없음 (src/webview/ 확장 금지, docs/scripts 만)

**검증**: 각 Phase 완료 시 `scripts/check-allowlist.sh <phase>` 실행. allowlist 밖 파일 있으면 exit 1. Phase 완료 선언 불가.

**Git Tag Gate**: Phase N 완료 시 `git tag phase-N-complete` 자동 생성. Phase N+1 시작은 `git tag --list 'phase-*-complete' | wc -l === N` 일 때만 허용.

---

## Package Export Contract

| 모듈 | 기본 export | 핵심 타입 |
|------|------------|-----------|
| `webview/index.ts` | `wireWebview(plugin: ClaudeTerminalPlugin): void` | — |
| `webview/view.ts` | `class ClaudeWebviewView extends ItemView` | `VIEW_TYPE_CLAUDE_WEBVIEW` |
| `webview/parser/stream-json-parser.ts` | `parseLine(line: string): ParseResult` | `type ParseResult = {ok:true, event:StreamEvent} \| {ok:false, raw:string}` |
| `webview/parser/line-buffer.ts` | `class LineBuffer` | `feed(chunk:string): string[]`, `flush(): string \| null` |
| `webview/session/spawn-args.ts` | `buildSpawnArgs(s: Settings, resumeId?: string): {cmd,args}` | — |
| `webview/session/session-controller.ts` | `class SessionController` | `start(userText)`, `send(userText)`, `dispose()` |
| `webview/event-bus.ts` | `createBus(): EventBus` | `BusEvent` union |
| `webview/renderers/card-registry.ts` | `createRegistry(ctx): CardRegistry` | `register(kind, fn)`, `dispatch(event)` |

---

## 태스크 분류 규칙

| 태그 | 의미 | 예시 |
|------|------|------|
| `[PRODUCT]` | 사용자가 직접 쓰는 기능. 런타임 실행으로 검증 | parser, renderers, view, session-controller |
| `[TEST]` | `[PRODUCT]`를 검증하는 vitest 테스트 | `test/webview/*.test.ts` |
| `[FIXTURE-INFRA]` | fixture 기반 검증 인프라 (PRODUCT 아님) | `fixture-replay.ts` helper, fake-spawn |
| `[INFRA]` | 빌드 / 설정 / docs / scripts | `scripts/check-no-any.sh`, `docs/*.md`, `CHANGELOG.md` |

**금지 패턴** (Ralph가 빠지기 쉬운 함정):
- `[FIXTURE-INFRA]` 를 `[PRODUCT]` 로 태그해서 완성도 부풀리기 → 검증 매트릭스에서 런타임 exec 요구
- `[PRODUCT]` 를 stub / TODO / 하드코딩 상수로 대체 → 차등 입력 테스트 강제
- `[TEST]` 를 trivial assertion (`expect(x).toBeTruthy()`) 로 우회 → 각 Phase 검증에 구체 expected value 명시
- `[INFRA]` 에 PRODUCT 기능 숨겨 넣기 (예: script 가 실제 렌더링 로직 포함) → `src/` 에 있는 것만 PRODUCT 로 인정

---

## Evidence 생성 규칙

모든 검증 증거는 아래 경로에 저장. **수동 작성 금지** — 스크립트 실행만 허용.

```
artifacts/
├── phase-0/
│   ├── ux-preflight-out.md
│   └── build-test-log.txt
├── phase-1/
│   ├── parser-fixtures-histogram.json   # scripts/replay-fixtures.ts 출력
│   └── tsc-noemit.txt
├── phase-2..5b/
│   ├── replay-<fixture>.txt             # 각 fixture 별 카드 종류/수
│   └── test-run.txt
├── phase-5b/
│   ├── smoke-claude-p.log               # 실제 `claude -p` 출력
│   └── smoke-claude-p.exit              # exit code 단독 파일
└── phase-6/
    ├── completion-matrix.json           # must-have 11 + should-have 7 각각 PASS/FAIL + 증거 경로
    └── regression-81-of-81.txt
```

### Evidence JSON schema

**Multi-fixture wrapping** (`artifacts/phase-1/parser-fixtures-histogram.json`, `artifacts/phase-6/completion-matrix.json`):

```json
{
  "generatedBy": "scripts/replay-fixtures.ts",
  "generatedAt": "2026-04-16T13:40:00Z",
  "subprocessPid": 12345,
  "subprocessExitCode": 0,
  "parserInvocationCount": 847,
  "fixtures": [
    {
      "fixture": "edit.jsonl",
      "firstLineSha256": "a1b2c3...",
      "eventCountByType": { "system": 1, "assistant": 4, "user": 2, "result": 1 },
      "cardCountByKind": { "system-init": 1, "assistant-text": 2, "assistant-tool-use": 1, "user-tool-result": 1, "result": 1 },
      "rawSkipped": 0,
      "renderSucceeded": true
    }
  ],
  "assertions": [
    { "id": "MH-01", "desc": "parser produced 0 {ok:false} lines across all fixtures", "actual": 0, "pass": true }
  ]
}
```

**Single-fixture** (`artifacts/phase-2/render-hello.json` 등): `fixtures` 대신 루트에 `fixture`, `eventCountByType`, `cardKinds`, `firstLineSha256` 직접.

**교차 검증 규칙** (전부 `scripts/check-evidence.sh <json>` 가 검증):
1. `generatedBy` 필드의 스크립트가 repo 에 존재해야 함 (`test -f`)
2. `generatedAt` 이 현재 시간 이내 (±1일, ISO8601 파싱)
3. 각 `fixture` 값의 파일이 `test/fixtures/stream-json/` 에 존재해야 함
4. **`firstLineSha256`** 가 실제 fixture 파일의 첫 라인 sha256 과 일치해야 함 (Ralph가 fixture 경로만 쓰고 실제 읽지 않았음을 차단)
5. **`subprocessPid`** 가 `process.pid` 와 다른 양의 정수 (스크립트가 서브프로세스로 parser 를 실행했음을 증빙)
6. **`parserInvocationCount`** 가 fixture 들의 총 라인 수 이상 (parser 가 실제로 각 라인 호출됨)
7. 각 assertion `id` 는 `MH-01..MH-11` 또는 `SH-01..SH-07` 규격 (다른 ID 거부)
8. `generatedBy` 스크립트 내용에 `import.*parser/stream-json-parser` 또는 `require.*parser/stream-json-parser` 문자열 존재 (grep 교차)

**수동 JSON 금지**: 위 8개 조건 동시 만족은 Ralph가 손으로 쓸 수 없음. `scripts/*.ts` 실행 없이 발행 불가.

---

## Phase Definitions

**규칙**: 한 iteration 에 1 Phase. Phase 5 는 5a / 5b 로 분할됨. 총 8 iteration (Phase 0, 1, 2, 3, 4, 5a, 5b, 6).

---

### Phase 0 — UX Preflight & Scaffolding

**목표**: 사용자 여정 정의 + 빈 웹뷰 뷰 등록 + `uiMode` 토글.

**스킬 호출**: `/sungjin-core:ux-preflight`

#### 태스크

1. `[INFRA]` `/sungjin-core:ux-preflight` 실행 → `docs/user-journeys.md` 산출. 3개 핵심 여정 (첫 대화 · 코드 수정 요청 · 세션 재개) + 글로벌 UI 3개 (sticky 헤더 · 카드 영역 · 하단 입력 바) + 빈/에러 상태 시나리오 포함. 실행 로그를 `artifacts/phase-0/ux-preflight-out.md` 에 저장.
2. `[PRODUCT]` `src/constants.ts` 에 `VIEW_TYPE_CLAUDE_WEBVIEW = "claude-webview"` 추가.
3. `[PRODUCT]` `src/webview/index.ts` — `export function wireWebview(plugin): void` (플러그인 등록 엔트리).
4. `[PRODUCT]` `src/webview/view.ts` — `ClaudeWebviewView extends ItemView` 스텁 (getViewType / getDisplayText / onOpen 에서 빈 div + "Webview coming soon" 텍스트).
5. `[PRODUCT]` `src/webview/settings-adapter.ts` — 기존 `ClaudeTerminalSettings` 에 병합될 필드 정의: `uiMode: "terminal" | "webview"` (default `"terminal"`), `permissionPreset: "safe" | "standard" | "full"` (default `"standard"`), `showDebugSystemEvents: boolean` (default `false`), `showThinking: boolean` (default `false`), `lastSessionId: string` (default `""`).
6. `[PRODUCT]` `src/settings.ts` — 기존 settings에 위 필드 추가 + SettingTab 에 uiMode 드롭다운 추가. onChange 시 Notice 로 "웹뷰 적용을 위해 Obsidian 재시작 필요" 표시.
7. `[PRODUCT]` `src/main.ts` — `uiMode === "webview"` 일 때만 `registerView(VIEW_TYPE_CLAUDE_WEBVIEW, ...)` + 커맨드 `claude-webview:open` 추가. `uiMode === "terminal"` 이면 기존 동작만.
8. `[TEST]` `test/webview/view-registration.test.ts` — mock Plugin 에 uiMode "webview" 로 wireWebview 호출 → `registerView` 가 `VIEW_TYPE_CLAUDE_WEBVIEW` 로 호출됨. "terminal" 로 호출 시 registerView 호출 0.
9. `[INFRA]` `scripts/check-no-any.sh` 작성 — `src/webview/**/*.ts` 에서 `\bas any\b | @ts-ignore | @ts-expect-error` 금지. 추가로 `\bas\s+[A-Z]\w+\s*&` (교집합 캐스팅 오용) + `\[key:\s*string\]:\s*unknown` (과도한 인덱스 시그니처) 금지. 발견 시 exit 1.
10. `[INFRA]` `scripts/check-allowlist.sh <phase>` 작성 — RALPH_PLAN.md 의 "Phase 파일 Allowlist" 에 정의된 대로, 현재 Phase 까지의 허용 파일 목록과 `src/webview/` 하위 실제 파일 목록이 정확히 일치하는지 검증. 불일치 시 exit 1 + 불일치 파일 목록 출력.
11. `[INFRA]` `scripts/dump-defaults.js` — `DEFAULT_SETTINGS` 를 `src/settings.ts` 에서 import 해서 `module.exports` 로 노출. 테스트 검증용 (0-5, 0-6). esbuild 로 pre-bundle 또는 tsx 로 require.
12. `[INFRA]` `scripts/check-evidence.sh` — Evidence JSON 의 8개 교차검증 조건 (generatedBy 존재, firstLineSha256 일치, subprocessPid, parserInvocationCount 등) 을 검증하는 범용 스크립트.
13. `[INFRA]` `package.json` devDependencies 에 `tsx` 추가 (`npm install -D tsx`). `scripts/` 의 .ts 파일 실행용.
14. `[INFRA]` `test/__mocks__/obsidian.ts` 확장 — `MarkdownRenderer.render = vi.fn(async (app, text, el) => { el.innerHTML = text; })` + `setIcon` 등 웹뷰가 쓸 Obsidian API 목. jsdom 에서 동작하는 수준.
15. `[INFRA]` `artifacts/phase-0/` 디렉토리 생성 + `.gitkeep`.
16. `[INFRA]` Phase 0 완료 시 `git tag phase-0-complete` 생성.

#### 파일
- 신규: `src/webview/{index,view,settings-adapter}.ts`, `docs/user-journeys.md`, `test/webview/view-registration.test.ts`, `scripts/check-no-any.sh`, `artifacts/phase-0/`
- 수정: `src/main.ts`, `src/settings.ts`, `src/constants.ts`

#### 검증 매트릭스

| # | 구분 | 항목 | CMD | EXPECT |
|---|------|------|-----|--------|
| 0-1 | INFRA | ux-preflight 실행 기록 | `test -f artifacts/phase-0/ux-preflight-out.md && wc -l < artifacts/phase-0/ux-preflight-out.md` | `>= 30` |
| 0-2 | PRODUCT | user-journeys.md 여정 수 | `grep -c '^## 여정' docs/user-journeys.md` | `>= 3` |
| 0-3 | PRODUCT | 글로벌 UI 3개 언급 | `grep -cE '(sticky 헤더\|sticky header\|카드 영역\|cards area\|입력 바\|input bar)' docs/user-journeys.md` | `>= 3` |
| 0-4 | PRODUCT | VIEW_TYPE 상수 존재 | `grep -c 'VIEW_TYPE_CLAUDE_WEBVIEW' src/constants.ts` | `>= 1` |
| 0-5 | PRODUCT | settings 필드 4개 | `node -e "const s=require('./scripts/dump-defaults.js'); const keys=['uiMode','permissionPreset','showDebugSystemEvents','lastSessionId']; const ok=keys.every(k=>k in s); process.exit(ok?0:1)"` | exit 0 |
| 0-6 | PRODUCT | 기본 uiMode terminal | `node -e "const s=require('./scripts/dump-defaults.js'); process.exit(s.uiMode==='terminal'?0:1)"` | exit 0 |
| 0-7 | TEST | vitest 회귀 | `npm run test 2>&1 \| tail -3` | `Tests  \d+ passed`, exit 0, 기존 81 + 신규 ≥ 82 |
| 0-8 | INFRA | 빌드 통과 | `npm run build 2>&1 \| tail -3 && test -f main.js && echo BUILD_OK` | `BUILD_OK` |
| 0-9 | INFRA | no-any gate | `bash scripts/check-no-any.sh` | exit 0 |
| 0-10 | INFRA | 타입 체크 | `npx tsc --noEmit 2>&1 \| tail -5` | exit 0 |
| 0-11 | TEST | view-registration 검증 | `npx vitest run test/webview/view-registration.test.ts --reporter=basic` | 2/2 pass |
| 0-12 | INFRA | tsx devDep 설치 + 실행 smoke | `npx tsx -e "console.log('tsx_ok')"` | `tsx_ok`, exit 0 |
| 0-13 | INFRA | allowlist 게이트 통과 | `bash scripts/check-allowlist.sh 0` | exit 0 |
| 0-14 | INFRA | MarkdownRenderer mock 확장됨 | `grep -c "MarkdownRenderer" test/__mocks__/obsidian.ts` | `>= 1` |
| 0-15 | INFRA | Phase 0 git tag | `git tag --list 'phase-0-complete' \| wc -l` | `1` |

**Ralph 함정**:
1. ux-preflight 스킬을 호출하지 않고 journeys.md 를 임의로 작성 — `ux-preflight-out.md` 파일이 스킬 실행 결과여야 하며 Phase 0 검증에서 이 파일 존재 필수
2. uiMode 토글이 런타임에 뷰를 재등록하지 않음 — 수동 smoke checklist 에 "Obsidian 재시작 후 uiMode 변경 시 웹뷰 뜨는지" 항목 추가
3. `scripts/dump-defaults.js` 에서 DEFAULT_SETTINGS 를 하드코딩 — `grep -E "require.*settings\|import.*settings" scripts/dump-defaults.js` 검증 0-5 에 포함해 차단

---

### Phase 1 — Parser Core (DOM-free)

**목표**: `StreamEvent` discriminated union + 8개 fixture 100% 파싱.

#### 태스크

1. `[PRODUCT]` `src/webview/parser/types.ts` — stream-json-schema-notes 에서 파생:
   - `type StreamEvent = SystemEvent | UserEvent | AssistantEvent | RateLimitEvent | ResultEvent | UnknownEvent`
   - `SystemEvent`: `subtype: "init" | "hook_started" | "hook_response" | "status" | "compact_boundary"`
   - `AssistantEvent.message.content`: `AssistantBlock[]` where `AssistantBlock = TextBlock | ThinkingBlock | ToolUseBlock`
   - `UserEvent.message.content`: `UserBlock[]` where `UserBlock = TextBlock | ToolResultBlock` (content는 string OR block[])
   - **`parent_tool_use_id?: string | null`** 옵셔널 필드 (sub-agent 이벤트 식별). `[key: string]: unknown` 같은 과도한 인덱스 시그니처 금지.
2. `[PRODUCT]` `src/webview/parser/line-buffer.ts` — `feed(chunk: string): string[]`, `flush(): string | null`. CR/LF 정규화. 중간 잘림 처리. **UTF-8 멀티바이트 경계 안전**: 입력 stream 에 `setEncoding('utf8')` 가 선행된다고 가정 (session-controller 에서 보장), 하지만 buffer 자체는 string 만 취급.
3. `[PRODUCT]` `src/webview/parser/stream-json-parser.ts` — `parseLine(line: string): {ok:true, event:StreamEvent} | {ok:false, raw:string}`. 비-JSON / type 없음 → `{ok:false}`. 알 수 없는 type → `UnknownEvent`. 런타임 스키마 검증: type/subtype 필드 존재 확인, 없으면 `{ok:false}`.
4. `[FIXTURE-INFRA]` `src/webview/parser/fixture-replay.ts` — test helper: `replayFixture(path): {events, rawSkipped, firstLineSha256, parserInvocationCount}`. sha256 은 node `crypto` 사용.
5. `[INFRA]` `scripts/replay-fixtures.ts` — 8개 fixture 전부 replay → `artifacts/phase-1/parser-fixtures-histogram.json` 생성. 필수 필드: `generatedBy`, `generatedAt`, `subprocessPid` (= `process.pid`), `parserInvocationCount`, `fixtures[].firstLineSha256`. 스크립트 최상단에 `import { parseLine } from "../src/webview/parser/stream-json-parser"` 필수.
6. `[TEST]` `test/webview/line-buffer.test.ts` — 6 케이스: split mid-line / empty line skip / CR LF / final flush / **한글 3-byte chunk boundary (UTF-8 경계 시 문자 깨짐 없음)** / 매우 긴 단일 라인 (64KB+).
7. `[TEST]` `test/webview/parser.test.ts` — 8 fixture 각각 eventCountByType 스냅샷, rawSkipped === 0 (init hook 라인까지 JSON 맞음).
8. `[TEST]` `test/webview/parser-schema.test.ts` — 고의적 malformed line (`{type:null}`, `{subtype:"x"}` type 없음) 주입 → `{ok:false}` 반환 검증. `parent_tool_use_id` 필드 존재하는 이벤트 파싱 확인.

#### 파일
- 신규: `src/webview/parser/{types,line-buffer,stream-json-parser,fixture-replay}.ts`, `scripts/replay-fixtures.ts`, `test/webview/{line-buffer,parser}.test.ts`

#### 검증 매트릭스

| # | 구분 | 항목 | CMD | EXPECT |
|---|------|------|-----|--------|
| 1-1 | PRODUCT | parser 8 fixture 에러 0 | `npx tsx scripts/replay-fixtures.ts && node -e "const h=require('./artifacts/phase-1/parser-fixtures-histogram.json'); const errs=h.fixtures.reduce((s,f)=>s+f.rawSkipped,0); process.exit(errs===0?0:1)"` | exit 0 |
| 1-2 | PRODUCT | histogram generatedBy 교차검증 | `node -e "const h=require('./artifacts/phase-1/parser-fixtures-histogram.json'); const fs=require('fs'); process.exit(fs.existsSync(h.generatedBy)?0:1)"` | exit 0 |
| 1-3 | PRODUCT | 8 fixture 전부 처리됨 | `node -e "const h=require('./artifacts/phase-1/parser-fixtures-histogram.json'); process.exit(h.fixtures.length===8?0:1)"` | exit 0 |
| 1-4 | PRODUCT | hello.jsonl 에 assistant 이벤트 ≥1 | `node -e "const h=require('./artifacts/phase-1/parser-fixtures-histogram.json'); const hello=h.fixtures.find(f=>f.fixture==='hello.jsonl'); process.exit(hello && hello.eventCountByType.assistant>=1?0:1)"` | exit 0 |
| 1-5 | PRODUCT | edit.jsonl 에 assistant ≥ 2 (tool_use + text 턴) | `node -e "const h=require('./artifacts/phase-1/parser-fixtures-histogram.json'); const e=h.fixtures.find(f=>f.fixture==='edit.jsonl'); process.exit(e && e.eventCountByType.assistant>=2?0:1)"` | exit 0 |
| 1-6 | PRODUCT | 차등 입력 구체 기대값 (canonical 비교) | `node -e "const h=require('./artifacts/phase-1/parser-fixtures-histogram.json'); const a=h.fixtures.find(f=>f.fixture==='hello.jsonl'); const b=h.fixtures.find(f=>f.fixture==='edit.jsonl'); const ok=(a.eventCountByType.assistant===1 && a.eventCountByType.user===undefined && b.eventCountByType.assistant>=2 && b.eventCountByType.user>=1); process.exit(ok?0:1)"` | exit 0 |
| 1-7 | PRODUCT | Evidence 교차검증 (firstLineSha256) | `bash scripts/check-evidence.sh artifacts/phase-1/parser-fixtures-histogram.json` | exit 0 (8개 조건 전부 통과) |
| 1-8 | PRODUCT | parserInvocationCount ≥ fixture 라인 총합 | `node -e "const h=require('./artifacts/phase-1/parser-fixtures-histogram.json'); const fs=require('fs'); const totalLines=h.fixtures.reduce((s,f)=>s+fs.readFileSync('./test/fixtures/stream-json/'+f.fixture,'utf8').split('\n').filter(Boolean).length,0); process.exit(h.parserInvocationCount>=totalLines?0:1)"` | exit 0 |
| 1-9 | PRODUCT | schema 검증 negative test | `npx vitest run test/webview/parser-schema.test.ts --reporter=basic` | 전부 pass |
| 1-10 | TEST | vitest parser + line-buffer (UTF-8 경계 포함) | `npx vitest run test/webview/parser.test.ts test/webview/line-buffer.test.ts --reporter=basic` | 전부 pass, 6 line-buffer 케이스 |
| 1-11 | INFRA | no-any gate (교집합 캐스팅 금지 포함) | `bash scripts/check-no-any.sh` | exit 0 |
| 1-12 | INFRA | 타입 체크 | `npx tsc --noEmit` | exit 0 |
| 1-13 | INFRA | 빌드 통과 | `npm run build 2>&1 \| tail -3 && test -f main.js && echo BUILD_OK` | `BUILD_OK` |
| 1-14 | INFRA | allowlist 게이트 | `bash scripts/check-allowlist.sh 1` | exit 0 |
| 1-15 | INFRA | phase-1 git tag | `git tag phase-1-complete 2>/dev/null; git tag --list 'phase-1-complete' \| wc -l` | `1` |
| 1-16 | TEST | 81 회귀 유지 | `npm run test 2>&1 \| tail -3` | exit 0, 기존 ≥ 81 pass |

**Ralph 함정**:
1. parser 에 `message.id` upsert 로직을 밀어 넣음 (renderer 책임) — types.ts 및 parser 코드에 `upsert` / `merge` 키워드 0개 검증
2. UnknownEvent 를 무시 (throw or skip) — `rawSkipped` 는 JSON 파싱 실패만, UnknownEvent 는 별도 `unknownEventCount` 추적

---

### Phase 2 — Renderer Skeleton + assistant.text 중복 버그 수정

**목표**: `hello.jsonl` 과 `edit.jsonl` 을 fixture replay 모드로 DOM 렌더. msg-id 중복 방지. **spawn 경로와 replay 경로가 동일 feedChunk 함수 공유** (G-6 방지).

#### 태스크

1. `[PRODUCT]` `src/webview/event-bus.ts` — `createBus()` 반환. `on/emit/dispose`. 내부 `Map<kind, Set<fn>>`, dispose 시 전부 clear.
2. `[PRODUCT]` `src/webview/ui/layout.ts` — `buildLayout(root): {headerEl, cardsEl, todoSideEl, inputRowEl}`. CSS class 는 `claude-wv-*` 네임스페이스.
3. `[PRODUCT]` `src/webview/renderers/card-registry.ts` — `createRegistry(ctx: RenderContext): {dispatch(event)}`. 내부에 `Map<EventKey, Renderer>` 등록 + default handler (UnknownEvent → collapsed JSON dump). **카드는 반드시 CSS class `claude-wv-card claude-wv-card--<kind>` 부여**.
4. `[PRODUCT]` `src/webview/renderers/assistant-text.ts` — **msg-id 기반 upsert**: `state.messages.get(msg.id)?.cardEl ?? createCard()`. 같은 msg.id 재출현 시 **`cardEl.replaceChildren(...newChildren)` 만** 사용. append / innerHTML / insertAdjacentHTML / insertBefore 전부 금지.
5. `[PRODUCT]` `src/webview/renderers/user-tool-result.ts` — content 가 string 이면 `<pre>`, array 면 각 block 렌더. 카드 classList 에 `claude-wv-card--user-tool-result` 부여.
6. `[PRODUCT]` `src/webview/renderers/result.ts` — `result.subtype` / `duration_ms` / `total_cost_usd` / `usage.input_tokens+output_tokens` 카드.
7. `[PRODUCT]` `src/webview/renderers/system-init.ts` — `system.model` / `mcp_servers.length` / `session_id` 헤더 배지.
8. `[PRODUCT]` `src/webview/replay.ts` — **production 코드**: `feedChunk(ctx, chunk: string): void` + `replayEvents(ctx, events: StreamEvent[]): void` export. `view.ts` (spawn 경로) 와 replay 경로 **모두** 이 함수를 호출. fixture-replay.ts 는 테스트 헬퍼로 남음.
9. `[PRODUCT]` `src/webview/view.ts` — `onOpen()` 에서 `buildLayout` + `createBus` + `createRegistry`. spawn stdout chunk → `feedChunk(ctx, chunk)` 호출. 테스트 전용 entrypoint 는 `createWebviewContext({replayEvents})` factory 로 분리 (view.ts 에 replayFixture 옵션 **없음**).
10. `[INFRA]` `scripts/render-fixture.ts` — jsdom 로드 + `createWebviewContext` + `replayEvents(ctx, events)` (view.ts 와 동일 함수) + `cardsEl.outerHTML` 를 `artifacts/phase-2/render-<fixture>.html` 에 저장 + assertion 결과 JSON (generatedBy/firstLineSha256 포함).
11. `[TEST]` `test/webview/render-hello.test.ts` — hello.jsonl replay → cardsEl.children.length ≥ 3 (init + assistant + result), assistant card `textContent.includes('hello')`, `cardEl.classList.contains('claude-wv-card--assistant-text')`.
12. `[TEST]` `test/webview/render-duplicate-msg-id.test.ts` — 같은 msg.id 로 텍스트 "A" → "A" → "B" 3회 주입 → (a) cards Map size === 1, (b) cardEl.textContent.trim() === "B" (마지막 상태만 유지), (c) `cardEl.querySelectorAll('.claude-wv-text-block').length === 1`.
13. `[TEST]` `test/webview/render-edit.test.ts` — edit.jsonl replay → `.claude-wv-card--assistant-tool-use` 카드 ≥ 1 (tool name "Edit" textContent 포함), `.claude-wv-card--user-tool-result` 카드 ≥ 1.
14. `[TEST]` `test/webview/replay-path-parity.test.ts` — 동일 edit.jsonl 을 (a) `feedChunk` 전체 chunk 로 주입 / (b) `replayEvents` 파싱 후 주입. 두 결과의 `cardKinds` Set 이 **동일**.

#### 파일
- 신규: `src/webview/{event-bus.ts,ui/layout.ts,renderers/{card-registry,assistant-text,user-tool-result,result,system-init}.ts}`, `scripts/render-fixture.ts`, `test/webview/render-*.test.ts` × 3
- 수정: `src/webview/view.ts`

#### 검증 매트릭스

| # | 구분 | 항목 | CMD | EXPECT |
|---|------|------|-----|--------|
| 2-1 | PRODUCT | hello.jsonl 렌더 카드 수 ≥ 3 | `npx tsx scripts/render-fixture.ts hello.jsonl && node -e "const r=require('./artifacts/phase-2/render-hello.json'); process.exit(r.cardCount>=3?0:1)"` | exit 0 |
| 2-2 | PRODUCT | hello 카드에 'hello' 포함 | `node -e "const r=require('./artifacts/phase-2/render-hello.json'); process.exit(r.textContainsHello===true?0:1)"` | exit 0 |
| 2-3 | PRODUCT | edit.jsonl 에 tool_use + tool_result | `npx tsx scripts/render-fixture.ts edit.jsonl && node -e "const r=require('./artifacts/phase-2/render-edit.json'); process.exit(r.cardKinds.includes('assistant-tool-use') && r.cardKinds.includes('user-tool-result')?0:1)"` | exit 0 |
| 2-4 | PRODUCT | msg-id 중복 방지 (assertion MH-02) | `npx vitest run test/webview/render-duplicate-msg-id.test.ts --reporter=basic` | 1/1 pass |
| 2-5 | PRODUCT | append / innerHTML / insertAdjacent 금지 (renderers + ui 전체) | `grep -rE '(\.appendChild\(\|\.append\(\|innerHTML\s*[+=]\|insertAdjacentHTML\|insertBefore)' src/webview/renderers/ src/webview/ui/` | 0 매치 |
| 2-6 | PRODUCT | Registry UnknownEvent default handler 런타임 | `npx vitest run test/webview/render-*.test.ts -t 'unknown event' --reporter=basic` | 1/1 pass (주입된 unknown 이벤트가 collapsed 카드로 렌더됨) |
| 2-7 | PRODUCT | spawn/replay 경로 parity | `npx vitest run test/webview/replay-path-parity.test.ts --reporter=basic` | 1/1 pass |
| 2-8 | PRODUCT | Evidence 교차검증 | `bash scripts/check-evidence.sh artifacts/phase-2/render-hello.json && bash scripts/check-evidence.sh artifacts/phase-2/render-edit.json` | exit 0 전부 |
| 2-9 | TEST | render-* vitest | `npx vitest run test/webview/render-*.test.ts --reporter=basic` | 4/4 pass |
| 2-10 | INFRA | 타입 / no-any / 빌드 | `bash scripts/check-no-any.sh && npx tsc --noEmit && npm run build 2>&1 \| tail -3 && test -f main.js` | exit 0 전부 |
| 2-11 | INFRA | allowlist 게이트 + Phase 2 tag | `bash scripts/check-allowlist.sh 2 && git tag phase-2-complete 2>/dev/null; git tag --list 'phase-2-complete' \| wc -l` | exit 0, `1` |
| 2-12 | TEST | 전체 vitest 회귀 | `npm run test 2>&1 \| tail -3` | exit 0, 기존 81 + 신규 ≥ 85 |

**Ralph 함정**:
1. msg-id upsert를 `if (!cards.has(id)) createCard()` 후 `appendChild(newBlock)` 로 구현 — 블록 중복 발생. 검증 2-5 에서 append 금지 + 2-4 런타임 테스트로 이중 차단
2. `replayFixture` 를 production code (`view.ts`) 가 아닌 test 전용 코드에만 배치 → renderer 는 테스트만 통과하고 실제 spawn 경로 미결선. Phase 3 spawn 통합에서 같은 render-dispatch 경로를 타는지 재검증

---

### Phase 3 — Session Controller + 실제 spawn + Input Bar

**목표**: 웹뷰에서 실제 `claude -p` 대화 가능. 단위 테스트는 fake-spawn 으로. 수동 smoke 체크리스트 생성.

#### 태스크

1. `[PRODUCT]` `src/webview/session/spawn-args.ts` — `buildSpawnArgs(settings, resumeId?): {cmd, args}`. preset → `--allowedTools`: Safe="Read,Glob,Grep", Standard="Read,Edit,Write,Glob,Grep,TodoWrite", Full="Read,Edit,Write,Bash,Glob,Grep,TodoWrite". 기본 args: `-p --output-format=stream-json --input-format=stream-json --verbose --include-partial-messages --permission-mode=acceptEdits`. mcp-config 옵션, `--resume <id>` 조건부. **ESM export** (default export 아님, named export 로 dynamic import 가능해야).
2. `[PRODUCT]` `src/webview/session/session-controller.ts` — `class SessionController { constructor({settings, bus, spawnImpl}); start(text); send(text); dispose() }`.
   - spawn 직후 `child.stdout!.setEncoding('utf8')` 필수 (UTF-8 경계 안전).
   - stdin JSONL write: `child.stdin!.write(json + '\n')`. **EPIPE 방어**: `child.stdin.destroyed` 체크, write 반환 false 면 `drain` 대기 후 다음 write. error 이벤트 → `bus.emit({kind:'session.error'})`.
   - stdout chunk → LineBuffer → parser → bus.
   - exit/error → bus.
   - **dispose 에서 반드시**: (a) `child.stdout.removeAllListeners()`, (b) `child.stderr.removeAllListeners()`, (c) `child.removeAllListeners()`, (d) `child.kill('SIGTERM')`, (e) bus subscription 해제.
3. `[PRODUCT]` `src/webview/ui/input-bar.ts` — `buildInputBar(root, bus): HTMLElement`. textarea (auto-resize) + Send 버튼 + Cmd/Ctrl+Enter 바인딩. 전송 시 `bus.emit({kind:'ui.send', text})`. keydown 핸들러는 실제 `e.metaKey || e.ctrlKey` + `e.key === 'Enter'` 검사.
4. `[PRODUCT]` `src/webview/view.ts` — 실제 spawn 경로 결선: `new SessionController({bus, settings})`. onOpen에서 `bus.on('ui.send', text => controller.send(text))`. onClose 에서 `this.disposed = true` **먼저**, 그 후 `controller.dispose()` + `bus.dispose()`.
5. `[PRODUCT]` **Double-guard 생명주기**: view 의 `dispatchToRenderer(event)` 함수 상단에 `if (this.disposed || this.leaf.view !== this) return`. session-controller 의 stdout 리스너도 `if (this.disposed) return` 체크.
6. `[PRODUCT]` 플러그인 unload orphan 방지: `wireWebview(plugin)` 이 `plugin.register(() => disposeAllWebviewControllers())` 훅 등록. 전역 WeakSet 으로 생성된 controller 추적.
7. `[TEST]` `test/webview/spawn-args.test.ts` — 3 preset × 2 resume(있음/없음) = 6 스냅샷 + `{cmd, args[]}` 의 `args` 내 정확한 플래그 존재 검증.
8. `[TEST]` `test/webview/session-controller.test.ts` — fake ChildProcess (stdin 은 writable stream, stdout 은 readable stream). edit.jsonl 내용을 stdout 에 chunk 단위로 흘려 보내고 bus 이벤트 순서 assertion. **추가 케이스**: (a) stdin.destroyed=true 에서 send() → `session.error` emit, (b) stdin.write() false 반환 → drain 이벤트 후 재시도, (c) stdout.emit('error', EPIPE) → `session.error` emit.
9. `[TEST]` `test/webview/view-lifecycle.test.ts` — **핵심 검증 (MH-11)**:
   - (a) onOpen → onClose → `child.stdout.listenerCount('data') === 0`, `child.listenerCount('exit') === 0`.
   - (b) onClose 후 `child.stdout.emit('data', JSON.stringify({type:'assistant',message:{id:'x',content:[{type:'text',text:'SHOULD_NOT_RENDER'}]}}))` → `cardsEl.textContent.includes('SHOULD_NOT_RENDER') === false`.
   - (c) onClose 후 `child.emit('exit', 0)` → DOM 에 result 카드 생성되지 않음.
   - (d) bus listener 카운트 0 (모든 kind).
10. `[INFRA]` `docs/manual-smoke-checklist.md` 생성 — 10 개 항목. 각 항목 포맷:
    ```
    - [ ] 1. Obsidian 에서 "Reload without saving" 실행 후 웹뷰 leaf 가 새로 생성됨.
          결과: __USER_SIGN_HERE__
    ```
    `__USER_SIGN_HERE__` placeholder 는 Phase 6 검증에서 **0 카운트** 강제 (사용자가 전부 덮어써야 함).

#### 파일
- 신규: `src/webview/session/{spawn-args,session-controller}.ts`, `src/webview/ui/input-bar.ts`, `test/webview/{spawn-args,session-controller,view-lifecycle}.test.ts`, `docs/manual-smoke-checklist.md`
- 수정: `src/webview/view.ts`

#### 검증 매트릭스

| # | 구분 | 항목 | CMD | EXPECT |
|---|------|------|-----|--------|
| 3-1 | PRODUCT | spawn-args preset 차등 (canonical) | `npx vitest run test/webview/spawn-args.test.ts -t 'preset produces distinct allowedTools' --reporter=basic` | 1/1 pass (safe/standard/full args 전부 다름 + Safe 는 Bash 없음) |
| 3-2 | PRODUCT | spawn-args resume flag | `npx vitest run test/webview/spawn-args.test.ts -t 'resume includes session id' --reporter=basic` | 1/1 pass |
| 3-3 | PRODUCT | session-controller fake-spawn 이벤트 시퀀스 + EPIPE 처리 | `npx vitest run test/webview/session-controller.test.ts --reporter=basic` | 전부 pass (최소 6 케이스: spawn/send/exit/error/stdin.destroyed/drain) |
| 3-4 | PRODUCT | **MH-11 생명주기 가드 런타임**: onClose 후 stdout.emit('data') → DOM mutation 0 | `npx vitest run test/webview/view-lifecycle.test.ts -t 'onClose then stdout emit does not mutate DOM' --reporter=basic` | 1/1 pass |
| 3-5 | PRODUCT | 모든 child listener 제거 | `npx vitest run test/webview/view-lifecycle.test.ts -t 'dispose removes all child listeners' --reporter=basic` | 1/1 pass (stdout/stderr/child 전부 listenerCount=0) |
| 3-6 | PRODUCT | bus listener count 0 after dispose | `npx vitest run test/webview/view-lifecycle.test.ts -t 'dispose clears bus listeners' --reporter=basic` | 1/1 pass |
| 3-7 | PRODUCT | Double-guard 존재 (view + controller 양측) | `grep -E '(disposed\|this\.leaf\.view !== this)' src/webview/view.ts \| wc -l` | `>= 2` (double-guard 확인, 단 런타임 검증 3-4 가 주요 게이트) |
| 3-8 | PRODUCT | input-bar Cmd+Enter 런타임 | `npx vitest run test/webview/input-bar.test.ts -t 'Cmd+Enter emits ui.send' --reporter=basic` | 1/1 pass (keydown simulate) |
| 3-9 | INFRA | smoke checklist 10 항목 + USER_SIGN_HERE 플레이스홀더 | `grep -c '^- \[ \]' docs/manual-smoke-checklist.md && grep -c '__USER_SIGN_HERE__' docs/manual-smoke-checklist.md` | 10, 10 (일치) |
| 3-10 | INFRA | 타입 / no-any / 빌드 | `bash scripts/check-no-any.sh && npx tsc --noEmit && npm run build 2>&1 \| tail -3 && test -f main.js` | exit 0 전부 |
| 3-11 | INFRA | allowlist + phase-3 tag | `bash scripts/check-allowlist.sh 3 && git tag phase-3-complete 2>/dev/null; git tag --list 'phase-3-complete' \| wc -l` | exit 0, `1` |
| 3-12 | TEST | 전체 vitest 회귀 | `npm run test 2>&1 \| tail -3` | exit 0 |

**Ralph 함정**:
1. `session-controller.dispose()` 가 `child.kill` 만 하고 listener 제거 누락 → view-lifecycle 테스트 3-5 로 이중 차단
2. view.ts 의 생명주기 가드가 `if (!this.leaf) return` 같은 항상-truthy 체크로 우회 → fake-spawn 테스트에서 onClose 후 stdout emit 시 렌더러 spy 가 0 호출이어야

---

### Phase 4a — Tool-use Cards + Thinking + Edit/Write Diff

**목표**: `edit.jsonl` 의 Edit tool_use 가 diff 뷰로 렌더. `plan-mode.jsonl` 의 thinking 블록 토글. 기본 tool_use 카드.

#### 태스크

1. `[PRODUCT]` `src/webview/renderers/assistant-tool-use.ts` — 기본 카드: `<name> · <input JSON preview>`. Edit/Write/TodoWrite 인 경우 **별도 renderer 로 delegate** (실제 delegation 등록은 이 파일에서). `claude-wv-card--assistant-tool-use` + `data-tool-name="<Name>"` 속성.
2. `[PRODUCT]` `src/webview/renderers/assistant-thinking.ts` — `<details>` 로 감싸고 settings `showThinking` (기본 false) 일 때만 `open` 속성. signature 필드 보존 (data-signature 속성).
3. `[PRODUCT]` `src/webview/renderers/edit-diff.ts` — Edit/Write input 에서 `file_path` + `old_string` + `new_string` 추출. **직접 구현 unified diff** (3-line context, +/- 라인 prefix + 색상 class). 라이브러리 추가 금지. 각 `+` / `-` 라인은 별도 `<span class="claude-wv-diff-add">` / `.claude-wv-diff-remove`.
4. `[TEST]` `test/webview/render-edit-diff.test.ts` — edit.jsonl replay → edit-diff 카드에 `file_path` textContent 포함, `.claude-wv-diff-add` 최소 1개, `.claude-wv-diff-remove` 최소 1개.
5. `[TEST]` `test/webview/render-thinking.test.ts` — plan-mode.jsonl replay → thinking `<details>` 요소 발견, `open` 속성 부재 (기본 접힘). settings `showThinking=true` 설정 후 재렌더 → open 속성 존재.
6. `[TEST]` `test/webview/render-tool-use-basic.test.ts` — 임의 tool (e.g. Bash) → `data-tool-name="Bash"` 속성 + input JSON preview textContent 포함.
7. `[INFRA]` `scripts/render-fixture.ts` 확장 — edit/plan-mode 지원.

#### 파일
- 신규: `src/webview/renderers/{assistant-tool-use,assistant-thinking,edit-diff}.ts`, `test/webview/{render-edit-diff,render-thinking,render-tool-use-basic}.test.ts`
- 수정: `scripts/render-fixture.ts`

#### 검증 매트릭스

| # | 구분 | 항목 | CMD | EXPECT |
|---|------|------|-----|--------|
| 4a-1 | PRODUCT | edit-diff 카드 — file_path + +/- 라인 (SH-02) | `npx tsx scripts/render-fixture.ts edit.jsonl && bash scripts/check-evidence.sh artifacts/phase-4a/render-edit.json && node -e "const r=require('./artifacts/phase-4a/render-edit.json'); process.exit(r.editDiffHasFilePath && r.diffAddedCount>=1 && r.diffRemovedCount>=1?0:1)"` | exit 0 |
| 4a-2 | PRODUCT | 직접 diff (라이브러리 import 금지) | `grep -rE "(from ['\"]diff['\"]\|from ['\"]jsdiff['\"]\|require\(['\"]diff['\"])" src/webview/` | 0 매치 |
| 4a-3 | PRODUCT | thinking 기본 접힘 (SH-01) — 런타임 | `npx vitest run test/webview/render-thinking.test.ts --reporter=basic` | 전부 pass (접힘 + showThinking=true 시 펼침 2 케이스) |
| 4a-4 | PRODUCT | tool_use basic (MH-03) data-tool-name | `npx vitest run test/webview/render-tool-use-basic.test.ts --reporter=basic` | 전부 pass |
| 4a-5 | PRODUCT | append/innerHTML 금지 재검증 | `grep -rE '(\.appendChild\(\|\.append\(\|innerHTML\s*[+=]\|insertAdjacentHTML\|insertBefore)' src/webview/renderers/ src/webview/ui/` | 0 매치 |
| 4a-6 | INFRA | 타입 / no-any / 빌드 | `bash scripts/check-no-any.sh && npx tsc --noEmit && npm run build 2>&1 \| tail -3 && test -f main.js` | exit 0 전부 |
| 4a-7 | INFRA | allowlist + phase-4a tag | `bash scripts/check-allowlist.sh 4a && git tag phase-4a-complete 2>/dev/null; git tag --list 'phase-4a-complete' \| wc -l` | exit 0, `1` |
| 4a-8 | TEST | 전체 vitest 회귀 | `npm run test 2>&1 \| tail -3` | exit 0 |

**Ralph 함정**:
1. edit-diff 를 "그냥 old_string + new_string 을 nl로 붙여 표시" 로 구현 → 4a-1 에서 `.claude-wv-diff-add` / `-remove` 노드 카운트 요구
2. thinking 토글을 CSS 로만 구현 → 4a-3 에서 DOM 의 `open` 속성 런타임 검증

---

### Phase 4b — TodoWrite Panel + Permission UX Integration (MH-09)

**목표**: `todo.jsonl` 의 TodoWrite 를 사이드 패널로 hoist. Permission 드롭다운이 실제 다음 spawn args 에 반영 (MH-09 핵심).

#### 태스크

1. `[PRODUCT]` `src/webview/renderers/todo-panel.ts` — TodoWrite tool_use input 을 `ui/layout.ts` 의 `todoSideEl` 에 hoist. 체크박스 · 상태 (pending/in_progress/completed) · 컨텐츠 표시. assistant tool_use 카드 자체는 "→ todos updated (N)" summary 로 축소 (별도 renderer path).
2. `[PRODUCT]` `src/webview/ui/permission-dropdown.ts` — `buildPermissionDropdown(root, settings, bus): HTMLElement`. Safe/Standard/Full 3개 option. 변경 시 `bus.emit({kind:'ui.permission-change', preset})` + `plugin.saveSettings()`.
3. `[PRODUCT]` `view.ts` — `bus.on('ui.permission-change', preset => { settings.permissionPreset = preset; this.plugin.saveSettings(); })`. **다음 spawn 에서 반영**: `SessionController.start()` 는 호출 시점에 `buildSpawnArgs(settings)` 재계산.
4. `[TEST]` `test/webview/render-todo-panel.test.ts` — todo.jsonl replay → `todoSideEl.children.length >= N` (N=TodoWrite input 의 todos 배열 길이). assistant tool_use 카드 textContent 에 "todos updated" 포함.
5. `[TEST]` `test/webview/permission-dropdown.test.ts` — 드롭다운 change 이벤트 → bus emit 발생 + settings 저장 (spy). settings.permissionPreset 값 변경됨.
6. `[TEST]` `test/webview/permission-integration.test.ts` — **MH-09 핵심**: (a) 초기 preset="standard" 로 `controller.start()` → spawnImpl 가 받은 args 에 "Read,Edit,Write,Glob,Grep,TodoWrite" 포함. (b) 드롭다운 "full" 변경 → bus emit → settings 업데이트. (c) 두 번째 `controller.start()` → spawnImpl 가 받은 args 에 "Bash" 포함 (첫 번째와 다름). spy 로 spawnImpl 호출 전수 관찰.

#### 파일
- 신규: `src/webview/renderers/todo-panel.ts`, `src/webview/ui/permission-dropdown.ts`, `test/webview/{render-todo-panel,permission-dropdown,permission-integration}.test.ts`
- 수정: `src/webview/view.ts`, `scripts/render-fixture.ts`

#### 검증 매트릭스

| # | 구분 | 항목 | CMD | EXPECT |
|---|------|------|-----|--------|
| 4b-1 | PRODUCT | **MH-09 integration — 드롭다운 변경 → 다음 spawn args** | `npx vitest run test/webview/permission-integration.test.ts --reporter=basic` | 전부 pass (3 단계 시퀀스 전부 검증) |
| 4b-2 | PRODUCT | 드롭다운 bus emit + settings save | `npx vitest run test/webview/permission-dropdown.test.ts --reporter=basic` | 전부 pass |
| 4b-3 | PRODUCT | 다음 spawn 에서 preset 반영 (spy 로) | `npx vitest run test/webview/permission-integration.test.ts -t 'preset change reflects in next spawn args' --reporter=basic` | 1/1 pass |
| 4b-4 | PRODUCT | TodoPanel hoist (SH-03) | `npx tsx scripts/render-fixture.ts todo.jsonl && bash scripts/check-evidence.sh artifacts/phase-4b/render-todo.json && node -e "const r=require('./artifacts/phase-4b/render-todo.json'); process.exit(r.todoSideItemCount>0 && r.assistantToolUseCardIsSummary===true?0:1)"` | exit 0 |
| 4b-5 | PRODUCT | TodoWrite assistant 카드 "todos updated" summary | `node -e "const r=require('./artifacts/phase-4b/render-todo.json'); process.exit(r.assistantToolUseTextIncludes.includes('todos updated')?0:1)"` | exit 0 |
| 4b-6 | INFRA | 타입 / no-any / 빌드 | `bash scripts/check-no-any.sh && npx tsc --noEmit && npm run build 2>&1 \| tail -3 && test -f main.js` | exit 0 전부 |
| 4b-7 | INFRA | allowlist + phase-4b tag | `bash scripts/check-allowlist.sh 4b && git tag phase-4b-complete 2>/dev/null; git tag --list 'phase-4b-complete' \| wc -l` | exit 0, `1` |
| 4b-8 | TEST | 전체 vitest 회귀 | `npm run test 2>&1 \| tail -3` | exit 0 |

**스킬 호출**: Phase 4b 종료 후 `/sungjin-core:ai-ux-gate` 실행 — 5개 게이트 중 4 이상 PASS. 결과를 `artifacts/phase-4b/ai-ux-gate-report.md` 에 저장.

**Ralph 함정**:
1. Permission 드롭다운 변경이 bus emit 만 하고 **다음 spawn 에 반영 안 됨** → 4b-1 의 3단계 시퀀스 테스트로 차단 (spy 로 spawnImpl 호출 args 비교)
2. TodoPanel hoist 가 안 되고 assistant 카드에 전체 todo JSON 그대로 덤프 → 4b-5 summary 문자열 검증

---

### Phase 5a — System Events + Compact Boundary + Status Spinner + Resume 시도

**목표**: `slash-compact.jsonl`, `slash-mcp.jsonl`, `resume.jsonl` 완전 렌더. 노이즈 필터링. `--resume` 플래그 통합.

#### 태스크

1. `[PRODUCT]` `src/webview/renderers/system-status.ts` — `system.subtype === "status"` + `status` 필드에 따라 `headerEl` 스피너 토글 (indeterminate progress bar OR 회전 아이콘).
2. `[PRODUCT]` `src/webview/renderers/compact-boundary.ts` — `compact_boundary` 이벤트 → 구분선 카드 (가로 선 + "Conversation compacted · <pre>→<post> tokens · <Nms>").
3. `[PRODUCT]` `src/webview/renderers/card-registry.ts` 확장 — `system.subtype === "hook_started"` / `"hook_response"` 는 settings `showDebugSystemEvents=false` 면 렌더 skip. true 면 collapsed JSON.
4. `[PRODUCT]` `src/webview/ui/status-bar.ts` — `result` 카드의 `modelUsage.<model>` 파싱 → `inputTokens + output_tokens` / `contextWindow` 비율 배지. `total_cost_usd` 표시.
5. `[PRODUCT]` `src/webview/session/session-controller.ts` 확장 — spawn 완료 시 `result.session_id` 를 받아 `settings.lastSessionId` 에 저장. view.ts 에서 "Open Claude Webview (resume last)" 커맨드 추가, 이 커맨드는 `buildSpawnArgs(settings, settings.lastSessionId)` 사용.
6. `[TEST]` `test/webview/render-slash-compact.test.ts` — slash-compact.jsonl replay → compact-boundary 카드 1 + 앞뒤 대화 구분됨.
7. `[TEST]` `test/webview/render-slash-mcp.test.ts` — slash-mcp.jsonl replay → "Unknown command" 에러 메시지가 사용자에게 친화적 카드로 표시됨 (raw JSON 덤프 아님).
8. `[TEST]` `test/webview/render-hook-events.test.ts` — hook_* 이벤트가 기본 숨김, `showDebugSystemEvents=true` 설정 시 렌더됨.
9. `[TEST]` `test/webview/status-bar.test.ts` — result 카드에 토큰 / 비용 / ctx% 표시.
10. `[TEST]` `test/webview/resume-integration.test.ts` — fake session 완료 후 `settings.lastSessionId` 저장됨. 재start 시 spawn-args 에 `--resume <id>` 포함.

#### 파일
- 신규: `src/webview/renderers/{system-status,compact-boundary}.ts`, `src/webview/ui/status-bar.ts`, `test/webview/{render-slash-compact,render-slash-mcp,render-hook-events,status-bar,resume-integration}.test.ts`
- 수정: `src/webview/session/session-controller.ts`, `src/webview/renderers/card-registry.ts`, `src/main.ts` (커맨드 추가)

#### 검증 매트릭스

| # | 구분 | 항목 | CMD | EXPECT |
|---|------|------|-----|--------|
| 5a-1 | PRODUCT | compact-boundary 카드 렌더 (SH-04) | `npx tsx scripts/render-fixture.ts slash-compact.jsonl && bash scripts/check-evidence.sh artifacts/phase-5a/render-slash-compact.json && node -e "const r=require('./artifacts/phase-5a/render-slash-compact.json'); process.exit(r.compactBoundaryCount>=1?0:1)"` | exit 0 |
| 5a-2 | PRODUCT | slash-mcp 친화적 에러 (raw JSON 아님) | `npx tsx scripts/render-fixture.ts slash-mcp.jsonl && node -e "const r=require('./artifacts/phase-5a/render-slash-mcp.json'); process.exit(r.friendlyErrorShown===true && r.rawJsonDumpShown===false?0:1)"` | exit 0 |
| 5a-3 | PRODUCT | hook 이벤트 기본 숨김 (MH-07) + status 스피너 (SH-05) | `npx vitest run test/webview/render-hook-events.test.ts test/webview/render-status-spinner.test.ts --reporter=basic` | 전부 pass |
| 5a-4 | PRODUCT | status-bar 토큰 — **result.modelUsage source of truth** (SH-06) | `npx vitest run test/webview/status-bar.test.ts -t 'derives from result.modelUsage not assistant.usage' --reporter=basic` | 1/1 pass (assistant.usage 와 다른 값의 modelUsage 주입 시 status-bar 가 modelUsage 값 표시) |
| 5a-5 | PRODUCT | 차등 fixture 로 다른 토큰 값 | `npx vitest run test/webview/status-bar.test.ts -t 'different fixtures produce different token badges' --reporter=basic` | 1/1 pass |
| 5a-6 | PRODUCT | resume 통합 (settings.lastSessionId) | `npx vitest run test/webview/resume-integration.test.ts --reporter=basic` | 전부 pass |
| 5a-7 | PRODUCT | resume 커맨드 런타임 등록 확인 | `npx vitest run test/webview/resume-integration.test.ts -t 'resume command registers and spawns with --resume flag' --reporter=basic` | 1/1 pass |
| 5a-8 | INFRA | 타입 / no-any / 빌드 | `bash scripts/check-no-any.sh && npx tsc --noEmit && npm run build 2>&1 \| tail -3 && test -f main.js` | exit 0 전부 |
| 5a-9 | INFRA | allowlist + phase-5a tag | `bash scripts/check-allowlist.sh 5a && git tag phase-5a-complete 2>/dev/null; git tag --list 'phase-5a-complete' \| wc -l` | exit 0, `1` |
| 5a-10 | TEST | 전체 vitest 회귀 | `npm run test 2>&1 \| tail -3` | exit 0, 모든 기존 유지 |

**Ralph 함정**:
1. 토큰 배지를 assistant.usage 누적으로 구현 → result.modelUsage 와 불일치. 검증 5a-4 에서 **result.modelUsage 를 source of truth** 로 강제 (assertion에 modelUsage path 명시)
2. hook 이벤트 숨김을 CSS display:none 로 구현 → DOM 은 여전히 생성 (성능 문제 + 복잡도). 검증: hook 이벤트 대응 카드가 `container.children` 에 아예 없어야 함 (display:none 금지)

---

### Phase 5b — Session Archive + Resume Fallback + `claude -p` Smoke

**목표**: `--resume` 실패 대응 직접 아카이브. 실제 `claude -p` smoke 1회 통과.

#### 태스크

1. `[PRODUCT]` `src/webview/session/session-archive.ts` — `class SessionArchive { append(event); load(sessionId): StreamEvent[] }`. 경로: `<pluginDir>/archives/<session_id>.jsonl`. 첫 줄에 `{type:"archive_meta", version:1, session_id, saved_at}` 헤더.
2. `[PRODUCT]` `session-controller.ts` 통합 — 모든 parsed 이벤트를 archive.append(). exit 시 archive flush.
3. `[PRODUCT]` `view.ts` — "Resume last session" 명령이 `--resume` 시도 → result.is_error=true 감지 시 `archive.load(sessionId)` 로 폴백, fixture replay 경로 재사용.
4. `[INFRA]` `scripts/smoke-claude-p.sh` — 절차:
   - (a) `claude --version` 실행 → `artifacts/phase-5b/smoke-claude-p.version` 에 저장.
   - (b) `claude -p "say hello in one word" --output-format=stream-json --input-format=stream-json --permission-mode=acceptEdits --allowedTools Read` 실행 (timeout 30s).
   - (c) stdout JSONL 을 `artifacts/phase-5b/smoke-claude-p.log` 로 기록.
   - (d) exit code 를 `artifacts/phase-5b/smoke-claude-p.exit` 로 별도 기록.
   - (e) 로그에서 result 이벤트 추출 후 `result.result` 에 "hello" 포함 + system.init 의 session_id 가 UUID 형식이면 `echo SMOKE_OK > artifacts/phase-5b/smoke-claude-p.verdict`.
5. `[INFRA]` `scripts/smoke-claude-p.sh` 에 `CLAUDE_SMOKE_SKIP=1` 환경변수 감지. 설정 시:
   - `HUMAN_ACTION_REQUIRED.md` 파일 존재 + `grep -c '^signoff: rkggmdii@gmail.com' HUMAN_ACTION_REQUIRED.md >= 1` 일 때만 `SKIP_USER_APPROVED` verdict 기록 + exit 0.
   - 그 조건 불충족이면 "SKIP_NOT_APPROVED" 기록 + exit 1 (Ralph 자체 SKIP 차단).
   - Phase 6 completion-gate 는 `SMOKE_OK` 또는 `SKIP_USER_APPROVED` 만 수용.
6. `[TEST]` `test/webview/session-archive.test.ts` — 아카이브 write → 새 인스턴스로 load → 동일 StreamEvent 시퀀스 복원. DOM replay → cardsEl 동일 (hash 비교).
7. `[TEST]` `test/webview/resume-fallback.test.ts` — fake spawn 이 즉시 exit code 1 with "session not found" → archive.load 호출 되고 replay 카드 렌더 확인.

#### 파일
- 신규: `src/webview/session/session-archive.ts`, `scripts/smoke-claude-p.sh`, `test/webview/{session-archive,resume-fallback}.test.ts`
- 수정: `src/webview/session/session-controller.ts`, `src/webview/view.ts`

#### 검증 매트릭스

| # | 구분 | 항목 | CMD | EXPECT |
|---|------|------|-----|--------|
| 5b-1 | PRODUCT | archive write + load 라운드트립 (SH-07) | `npx vitest run test/webview/session-archive.test.ts --reporter=basic` | 전부 pass |
| 5b-2 | PRODUCT | archive 헤더 structure | `node -e "const fs=require('fs'); const d=fs.readdirSync('./.webview-test-archives'); const first=d.find(f=>f.endsWith('.jsonl')); const meta=JSON.parse(fs.readFileSync('./.webview-test-archives/'+first,'utf8').split('\n')[0]); process.exit(meta.type==='archive_meta' && meta.version===1 && meta.session_id && meta.saved_at?0:1)"` | exit 0 |
| 5b-3 | PRODUCT | resume fallback → archive load | `npx vitest run test/webview/resume-fallback.test.ts --reporter=basic` | 전부 pass |
| 5b-4 | PRODUCT | smoke `claude -p` 실제 실행 (Ralph SKIP 금지) | `bash scripts/smoke-claude-p.sh && cat artifacts/phase-5b/smoke-claude-p.verdict` | `SMOKE_OK` (단 HUMAN_ACTION_REQUIRED.md 에 rkggmdii@gmail.com 서명 있을 때만 `SKIP_USER_APPROVED`) |
| 5b-5 | PRODUCT | smoke exit code | `cat artifacts/phase-5b/smoke-claude-p.exit` | `0` |
| 5b-6 | PRODUCT | smoke log 실제 stream-json (위조 방지) | `node -e "const fs=require('fs'); const lines=fs.readFileSync('./artifacts/phase-5b/smoke-claude-p.log','utf8').split('\n').filter(Boolean); const parsed=lines.map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean); const init=parsed.find(e=>e.type==='system' && e.subtype==='init'); const uuidRe=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; const result=parsed.find(e=>e.type==='result'); process.exit(parsed.length>=3 && init && uuidRe.test(init.session_id) && result && result.duration_ms>100?0:1)"` | exit 0 (session_id UUID 형식 + duration > 100ms) |
| 5b-7 | PRODUCT | smoke session_id 가 fixture session_id 와 불일치 (위조 차단) | `node -e "const fs=require('fs'); const smoke=JSON.parse(fs.readFileSync('./artifacts/phase-5b/smoke-claude-p.log','utf8').split('\n').filter(Boolean).find(l=>{try{const p=JSON.parse(l);return p.type==='system' && p.subtype==='init'}catch{return false}})); const fixtures=fs.readdirSync('./test/fixtures/stream-json').map(f=>fs.readFileSync('./test/fixtures/stream-json/'+f,'utf8')); const collision=fixtures.some(c=>c.includes(smoke.session_id)); process.exit(collision?1:0)"` | exit 0 (fixture 와 다른 session_id) |
| 5b-8 | PRODUCT | claude CLI version 기록 | `test -f artifacts/phase-5b/smoke-claude-p.version && grep -E '^[0-9]+\.[0-9]+' artifacts/phase-5b/smoke-claude-p.version` | `>= 1 매치` (e.g. `2.1.109`) |
| 5b-9 | INFRA | 타입 / no-any / 빌드 | `bash scripts/check-no-any.sh && npx tsc --noEmit && npm run build 2>&1 \| tail -3 && test -f main.js` | exit 0 전부 |
| 5b-10 | INFRA | allowlist + phase-5b tag | `bash scripts/check-allowlist.sh 5b && git tag phase-5b-complete 2>/dev/null; git tag --list 'phase-5b-complete' \| wc -l` | exit 0, `1` |
| 5b-11 | TEST | 전체 vitest 회귀 | `npm run test 2>&1 \| tail -3` | exit 0, 모든 기존 유지 |

**에스컬레이션** (Phase 5b smoke 실패 시):
- 네트워크 / 인증 / CLI 미설치 이유로 3회 이상 실패하면 `HUMAN_ACTION_REQUIRED.md` 생성. `CLAUDE_SMOKE_SKIP=1` 플래그 요청. Completion marker 는 사용자 SKIP 승인 후에만 생성.

**Ralph 함정**:
1. smoke 실패 시 `CLAUDE_SMOKE_SKIP=1` 을 Ralph 가 스스로 설정 → Phase 6 에서 `env | grep CLAUDE_SMOKE_SKIP` 기록 요구, 사용자 수동 승인 필요
2. archive 경로를 vault 루트에 쓰기 (git commit 위험) → 경로 검증: `<pluginDir>/archives/` 하위만 허용. grep 으로 경로 규칙 검증

---

### Phase 6 — Completion Gate + Docs + Release Bump

**목표**: 7개 완료 기준 (a~g) 전부 증거로 증명. `V0.6.0_WEBVIEW_FOUNDATION_COMPLETE` 마커 생성.

#### 스킬 호출 (최종 게이트)
- `/sungjin-core:completion-gate` — must-have 11개 + should-have 7개 완성도 검증

**Advisory (Phase 6 completion-gate 설계 메모)**:
- `completion-gate.ts` 는 각 assertion 에 `evidencePath` 필드 + `reVerifiedAt` 타임스탬프 추가. Phase 1~5b 의 evidence JSON 을 `scripts/check-evidence.sh` 로 재검증 후 `pass:true` 기입 (G-14 방지).
- Phase tag 가 해당 Phase 의 파일 변경 커밋에 부착되었는지 `git rev-list phase-N-complete | head -1` 가 allowlist 확장 커밋과 일치하는지 검증 (G-13 방지). 첫 iteration 에 모든 tag 선점 차단.
- `subprocessPid` 의미: "evidence generator 본인의 process.pid" (검증자 프로세스와 다른 양의 정수 보장). 검증자 `node -e` 가 다른 pid 로 실행되므로 현재 규칙 5 가 자연스럽게 성립.
- `/sungjin-core:dead-end-detector` — 사용자 여정 3개 대비 막다른 페이지 탐지 (Obsidian 앱 필요해서 수동 체크리스트로 대체 — 사용자 승인)

#### 태스크

1. `[INFRA]` `scripts/completion-gate.ts` — 8개 fixture 전부 replay → 각각 assertion. must-have 11 + should-have 7 각 ID 별 PASS/FAIL + 증거 경로 (`artifacts/phase-*/...`). 출력: `artifacts/phase-6/completion-matrix.json`.
2. `[INFRA]` `docs/WEBVIEW_FOUNDATION_COMPLETE.md` — 7개 완료 기준 (a~g) 각각 증거 인용 + 매뉴얼 체크리스트 체크 상태.
3. `[INFRA]` `CHANGELOG.md` v0.6.0 Beta 섹션 — 웹뷰 모드 opt-in, permission preset, diff 카드, TodoWrite 패널, compact boundary, session archive, 알려진 제약 (inline permission 미지원, `/mcp` 슬래시 미지원, v0.7.0 에서 해결).
4. `[INFRA]` `manifest.json` / `VERSION` / `versions.json` → `0.6.0-beta.1`.
5. `[INFRA]` `TODO.md` v0.6.0 섹션 체크박스 업데이트.
6. `[TEST]` `test/webview/completion-gate.test.ts` — completion-matrix.json 의 모든 assertion pass=true 이고, 사용자 SKIP 없음이면 `V0.6.0_WEBVIEW_FOUNDATION_COMPLETE` 마커 파일 생성 허용.
7. `[INFRA]` `V0.6.0_WEBVIEW_FOUNDATION_COMPLETE` 마커 파일 (루트) — 내용: completion-matrix.json 의 요약 + smoke verdict + 수동 체크리스트 사용자 signoff 섹션.
8. `[INFRA]` 기존 81 테스트 회귀 + 신규 테스트 전부 pass.

#### 파일
- 신규: `scripts/completion-gate.ts`, `docs/WEBVIEW_FOUNDATION_COMPLETE.md`, `test/webview/completion-gate.test.ts`, `V0.6.0_WEBVIEW_FOUNDATION_COMPLETE`
- 수정: `CHANGELOG.md`, `TODO.md`, `manifest.json`, `VERSION`, `versions.json`

#### 검증 매트릭스 (최종 — 모든 이전 Phase 체크포인트 재실행)

| # | 구분 | 항목 | CMD | EXPECT |
|---|------|------|-----|--------|
| 6-1 | PRODUCT | completion-matrix 생성 + 교차검증 | `npx tsx scripts/completion-gate.ts && bash scripts/check-evidence.sh artifacts/phase-6/completion-matrix.json` | exit 0 전부 |
| 6-2 | PRODUCT | must-have 11 전부 PASS | `node -e "const m=require('./artifacts/phase-6/completion-matrix.json'); const mh=m.assertions.filter(a=>a.id.startsWith('MH-')); const fail=mh.filter(a=>!a.pass); console.log('MH fails:',fail.map(f=>f.id).join(',')); process.exit(fail.length===0 && mh.length===11?0:1)"` | exit 0, "MH fails:" 비어있음 |
| 6-3 | PRODUCT | should-have 7 전부 PASS | `node -e "const m=require('./artifacts/phase-6/completion-matrix.json'); const sh=m.assertions.filter(a=>a.id.startsWith('SH-')); const fail=sh.filter(a=>!a.pass); console.log('SH fails:',fail.map(f=>f.id).join(',')); process.exit(fail.length===0 && sh.length===7?0:1)"` | exit 0, "SH fails:" 비어있음 |
| 6-4 | PRODUCT | 8 fixture 전부 replay 성공 | `node -e "const m=require('./artifacts/phase-6/completion-matrix.json'); process.exit(m.fixtures.length===8 && m.fixtures.every(f=>f.renderSucceeded)?0:1)"` | exit 0 |
| 6-5 | PRODUCT | smoke verdict 수용 | `v=$(cat artifacts/phase-5b/smoke-claude-p.verdict); echo "$v"; test "$v" = "SMOKE_OK" \|\| test "$v" = "SKIP_USER_APPROVED"` | `SMOKE_OK` 또는 `SKIP_USER_APPROVED`, exit 0 |
| 6-6 | PRODUCT | 수동 체크리스트 USER_SIGN_HERE 전부 덮어써짐 | `test $(grep -c '__USER_SIGN_HERE__' docs/manual-smoke-checklist.md) -eq 0 && test $(grep -c '^- \[x\]' docs/manual-smoke-checklist.md) -ge 10` | exit 0 (placeholder 0 + 체크박스 10) |
| 6-7 | PRODUCT | 수동 체크리스트 커밋의 author 검증 | `git log --format='%ae' -n 1 -- docs/manual-smoke-checklist.md` | `rkggmdii@gmail.com` (사용자만 수정 가능) |
| 6-8 | PRODUCT | 기존 81 회귀 | `npm run test 2>&1 \| grep -E "Tests.*passed" \| tail -1` | `Tests  N passed` where N >= 81 + 신규 개수 |
| 6-9 | INFRA | 모든 Phase tag 존재 (건너뛰기 방지) | `git tag --list 'phase-*-complete' \| wc -l` | `8` (phase-0,1,2,3,4a,4b,5a,5b-complete) |
| 6-10 | INFRA | uiMode 토글 존재 | `grep -c 'uiMode' src/settings.ts` | `>= 1` |
| 6-11 | INFRA | version bump | `grep -E '"version":' manifest.json` | `0.6.0-beta.1` |
| 6-12 | INFRA | CHANGELOG v0.6.0 섹션 | `grep -c '## \[0.6.0' CHANGELOG.md` | `>= 1` |
| 6-13 | INFRA | 빌드 + 타입 + no-any 최종 | `bash scripts/check-no-any.sh && npx tsc --noEmit && npm run build 2>&1 \| tail -3 && test -f main.js` | exit 0 전부 |
| 6-14 | INFRA | allowlist 최종 (Phase 6 는 src/webview 확장 금지) | `bash scripts/check-allowlist.sh 6` | exit 0 |
| 6-15 | INFRA | Completion marker 생성 조건 | `test -f V0.6.0_WEBVIEW_FOUNDATION_COMPLETE && grep -E '(SMOKE_OK\|SKIP_USER_APPROVED)' V0.6.0_WEBVIEW_FOUNDATION_COMPLETE && grep -c 'user_signoff_verified: true' V0.6.0_WEBVIEW_FOUNDATION_COMPLETE` | exit 0, 둘 다 >=1 |

**사용자 signoff 조건** (Ralph 가 기술적으로 만족시킬 수 없음):
1. `docs/manual-smoke-checklist.md` 의 10개 항목 각 `결과: __USER_SIGN_HERE__` 가 사용자의 실제 결과 텍스트로 교체되어 있어야 함 (placeholder 0 카운트).
2. `[x]` 체크 10개.
3. 해당 파일의 **마지막 git commit author email** 이 `rkggmdii@gmail.com` (Ralph/CI 계정이 아닌 사용자).
4. `scripts/completion-gate.ts` 가 위 3 조건 전부 검증 후에만 `V0.6.0_WEBVIEW_FOUNDATION_COMPLETE` 파일 생성.

---

## 스킬 호출 가이드 (Phase별 배치)

| Phase | 호출 시점 | 스킬 | 이유 |
|-------|----------|------|------|
| 0 | Phase 시작 | `/sungjin-core:ux-preflight` | 사용자 여정 + 글로벌 UI 정의 (UI 프로젝트 필수) |
| 4 | Phase 종료 | `/sungjin-core:ai-ux-gate` | AI 응답 카드 품질 (맥락 주입 · 마크업 · 정보 위계) 5개 게이트 |
| 6 | Phase 종료 | `/sungjin-core:completion-gate` | must-have + should-have 최종 검증 |
| 6 | Phase 종료 (선택) | `/sungjin-core:dead-end-detector` | Obsidian 실환경 필요 — 수동 체크리스트로 대체 |
| 6 | Phase 종료 | `/sungjin-core:real-content-gate` | fixture 만 통과하고 real 에서 깨지지 않는지 (smoke 검증과 겹침) |

---

## ECC 에이전트 활용 가이드

| Phase | 추천 에이전트 (병렬 가능) | 용도 |
|-------|------------------------|------|
| 0, 1 | `typescript-reviewer` | 초기 타입 설계 리뷰 |
| 2, 4, 5a | `code-reviewer` | 카드 렌더러 품질 (CRITICAL/HIGH 수정 + re-review) |
| 3 | `code-reviewer` + `security-reviewer` 병렬 | spawn/stdin 보안 + 생명주기 가드 |
| 5b | `build-error-resolver` (필요 시) | smoke 환경 이슈 |
| 6 | `code-reviewer` 최종 + `doc-updater` | 릴리즈 문서 일관성 |

**원칙**: 독립적 리뷰는 항상 병렬 (단일 메시지에 Task 여러 개). CRITICAL/HIGH 수정 후 re-review 필수.
