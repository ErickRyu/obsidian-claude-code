# obsidian-claude v0.6.0 Webview — User Journeys

> Generated during Phase 0 UX Preflight. 3 core journeys + 3 global UI elements + empty/error states.
> Source of reference: `artifacts/phase-0/ux-preflight-out.md`.

## 글로벌 UI (Global UI shells)

1. **Sticky 헤더** — 모델 배지, permission preset 드롭다운, 세션 id 라벨.
   `[claude-wv-header]`. 스크롤 시 상단 고정. 컨텍스트 배지 (tokens / %) 는 Phase 5a 에서 주입.
2. **카드 영역 (cards area)** — 대화 흐름을 카드 리스트로. 각 카드는 `claude-wv-card claude-wv-card--<kind>`
   클래스를 가진다 (`assistant-text`, `assistant-tool-use`, `user-tool-result`, `result`, …).
   스크롤 영역. 최신 카드가 아래.
3. **하단 입력 바 (input bar)** — textarea + Send 버튼. `Cmd/Ctrl+Enter` 로 전송.
   Phase 3 에서 실제 JSONL stdin write 와 결선.

## 여정 1: 첫 대화 (First conversation)

**시작 상태**: uiMode 가 "webview" 로 전환되어 Obsidian 재시작된 직후. 웹뷰 leaf 가 빈 상태로 열림.

**스텝**:
1. 사용자가 오른쪽 leaf 의 "Claude Webview" 탭을 활성화.
2. 빈 상태 placeholder — "무엇을 도와드릴까요?" 메시지 + 아래 입력 바.
3. 사용자가 "hello" 타이핑 → `Cmd+Enter`.
4. 즉시 사용자 입력 카드가 카드 영역에 추가 (낙관적 렌더).
5. `system.init` 이벤트 도착 → sticky 헤더에 모델/permission 배지 갱신.
6. `assistant.text` 카드가 msg-id 를 키로 upsert 되면서 토큰 단위 스트리밍 업데이트.
7. `result` 이벤트 도착 → duration/토큰/cost 배지가 있는 종료 카드 생성.

**에러 경로**: `claude` 바이너리 없음 → `session.error` 이벤트 → 카드 영역에 "Claude CLI 를 찾을 수 없습니다" 카드.

## 여정 2: 코드 수정 요청 (Edit/Write tool use)

**시작 상태**: 이미 세션이 실행 중 (system.init 완료).

**스텝**:
1. 사용자가 "Fix the typo in README.md" 등을 입력.
2. `assistant.text` 가 진행 상황을 설명.
3. `assistant.tool_use` (name=Edit) 카드 — unified diff 뷰 (Phase 4a) 로 +/- 라인.
4. `user.tool_result` 카드 — 성공/에러.
5. 다음 `assistant.text` 가 요약을 표시.
6. `result` 카드가 최종 비용/토큰을 표시.

**빈 상태**: tool_use 가 없는 순수 텍스트 응답 → diff 카드 건너뜀, assistant.text + result 만.

**에러 경로**: Edit 결과가 is_error=true → user-tool-result 카드가 빨간 배경으로 stderr 노출.

## 여정 3: 세션 재개 (Resume)

**시작 상태**: 이전 세션이 있고 `settings.lastSessionId` 가 저장되어 있음. (Phase 5a 에서 결선).

**스텝**:
1. 사용자가 커맨드 "Open Claude Webview (resume last)" 실행.
2. `buildSpawnArgs` 가 `--resume <id>` 를 조립.
3. `claude -p` 가 이전 대화 히스토리를 stream 으로 replay.
4. 기존 카드들이 순차적으로 복원된다.
5. 새로운 사용자 입력이 이어서 들어간다.

**폴백 경로** (Phase 5b): `--resume` 이 is_error=true 반환 → `session-archive` 에서 로컬 JSONL 을 로드해서 같은 렌더 경로로 replay.

**에러 경로**: lastSessionId 가 비어있음 → 일반 신규 세션으로 fall-through.

## 빈 상태 / 에러 상태 카탈로그

- **Empty leaf**: "무엇을 도와드릴까요?" placeholder + 입력 바만.
- **스폰 실패**: stderr + exit code 카드 ("Claude CLI 실행 실패 — 경로 설정 확인").
- **EPIPE**: 자식 프로세스 조기 종료 → session.error → 카드 영역 하단에 배너.
- **UnknownEvent**: 파서가 모르는 type → `<details>` collapsed JSON dump 카드 (디버그 친화적).
- **Parse error**: 비-JSON 라인 → rawSkipped 카운터만 증가, DOM 영향 없음.

## 접근성 메모

- 카드 영역은 `aria-live="polite"` (Phase 5a 에서 결선).
- 입력 바는 `Cmd/Ctrl+Enter` 와 Send 버튼 동일하게 동작.
- 토글 (thinking / debug) 은 체크박스 `<input type="checkbox">` 로 스크린 리더 친화.

## 테마 일관성

- CSS 네임스페이스는 전부 `claude-wv-` prefix. 기존 `.claude-terminal-*` 클래스와 충돌 없음.
- Obsidian 의 `var(--background-primary)` / `--text-normal` 등 CSS 변수만 사용 (하드코딩 색상 금지).

## 알려진 제약 (v0.6.0 Beta)

- Inline permission prompt (accept/reject per tool_use) — v0.7.0.
- `/mcp` slash 커맨드는 웹뷰에서 렌더되지 않음. 사용자에게 "Terminal 모드에서 /mcp 를 사용하세요" 안내.
- 스크린샷 / GIF 는 GA 릴리즈에서.
