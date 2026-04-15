# TODO — obsidian-claude

## Thesis

**이전 방향:** VS Code Claude Code extension의 UX를 Obsidian 터미널 위에 올려쌓기.

**새 방향:** Anthropic 공식 IDE 확장을 따라잡는 패리티 레이스는 지는 게임입니다.
우리가 이길 수 있는 유일한 코너는 **Obsidian-native Claude 워크플로우 레이어** —
플랜, 대화, 의사결정이 전부 vault의 일급 노트가 되어서 backlink, tag, graph,
semantic search의 대상이 되는 것. VS Code가 구조적으로 못 하는 일.

실행 전략:

1. **터미널 모드 (xterm.js)**: 웹뷰 나올 때까지의 다리. 크리티컬 버그 + 명백한 UX
   회복만. 순수 VS Code 패리티 폴리시는 투자하지 않음.
2. **웹뷰 모드 (stream-json)**: 전략 축. 공식 확장과 같은 스트리밍 구조 채용해
   diff/permission/todo를 HTML 카드로 렌더. 일단 이게 깔리면 그 위에 진짜
   차별화가 얹힘.
3. **Obsidian-native 차별화**: 플랜을 노트로, 대화를 노트로, 체크포인트를 노트로.
   이게 moat.

이 순서가 중요합니다. 웹뷰 인프라 없이는 차별화 못 얹고, 차별화 없이는 VS Code
팔로워 제품일 뿐.

Credit: CEO/Eng dual-voice 리뷰가 지적한 "패리티 레이스 vs wedge" 프레이밍과
Codex가 웹검색으로 확인해준 Anthropic 공식 IDE 통합 현황이 이 재편의 계기.

---

## v0.5.x — Terminal mode maintenance (단기, ~1-2주)

웹뷰 전환 전까지 현재 UX를 깨지지 않게 유지. **이 섹션에는 순수한 터미널 폴리시
기능을 넣지 않습니다** — 추가 기능은 전부 웹뷰 이후로 미룸.

### [ ] Bare `obsidian://` URL 렌더링 회복

**What:** Claude가 `[text](obsidian://...)` markdown 래핑 없이 raw URL만 내보낼 때,
사용자에게 긴 URL이 그대로 노출되고 Cmd+Click도 안 됨. v0.5.1 OSC 8 전환 이전에는
`WebLinksAddon` + `OBSIDIAN_OPEN_URL_REGEX` 조합으로 raw URL도 clickable했는데
회귀됨.

**How (최소 수정):**
- `ObsidianLinkTransform`에 bare URL 감지 정규식 추가:
  `(?<!\x1b\]8;;)(obsidian:\/\/open\?[^\s)\]"<>]+)`
- path 파라미터에서 basename 추출해 OSC 8으로 래핑 → URL 숨기고 `foo.md` 같은 텍스트만 표시
- markdown 변환 후 bare 변환 순서 (이미 OSC 8된 URL 재매칭 방지는 lookbehind로)
- chunk 경계 가로지르는 bare URL도 `findPartialLinkStart`에서 버퍼링

**Effort:** ~30분 CC time.

**Note:** 웹뷰 모드로 가면 이 파일 통째로 폐기. stream-json assistant_message는
완성된 markdown이라 ANSI/chunk 문제가 없어 10줄짜리 파서 후처리면 충분.

---

### [ ] MCP setting toggle 런타임 반영

**What (기존 버그, /autoplan Codex 발견):** `src/settings.ts:119`에서 `enableMcp`
값만 업데이트하고 `setupMcp()` / `teardownMcp()`를 호출 안 함. 설정 바꿔도 플러그인
재로드 전까지 무반응. 실행 중인 claude CLI 자식 프로세스는 args를 spawn 시점에
스냅샷하므로 터미널 재시작도 필요.

**How:**
- `ClaudeTerminalSettingTab`에서 값 변경 후 플러그인 인스턴스의 `reconfigureMcp()` 호출
- 플러그인 쪽에 `reconfigureMcp()`: `teardownMcp()` → `setupMcp()`
- 기존 터미널은 그대로 둠 (재시작 권고 Notice 표시)

**Effort:** ~1시간.

---

### [ ] Release CI: built `main.js` artifact 배포

**What:** `main.js`가 `.gitignore`에 포함돼 있어 repo에 없음. 다른 사용자가
설치하려면 직접 `npm run build` 해야 함 (노드 + bun 등 의존성 요구). Obsidian
플러그인 관행은 **GitHub Release에 `main.js` + `manifest.json` + `styles.css`를
artifact로 올리기**.

**How:**
- `.github/workflows/release.yml`: 태그(`v*`) 푸시되면 `npm ci && npm run build` 후
  `gh release create`로 세 파일 attach
- CHANGELOG 섹션을 release notes 본문으로 자동 투입
- `manifest.json`의 `minAppVersion` 확인

**Effort:** ~1시간.

---

### [ ] URL emission compliance 측정 (dogfood)

**What:** 이번 회귀 사건이 증명한 바 — "Claude가 시스템 프롬프트 지시를 100% 따른다"는
전제는 **측정되지 않음**. 스크린샷에서 Claude는 `[text](url)` 래퍼를 빼먹고 raw URL만
뱉음. 실제 비율을 모르고 그 위에 기능을 더 쌓으면 계속 찢어짐.

**How:**
- 세션 단위 카운터 (메모리만):
  - `linkMarkdownEmitted`: `[text](obsidian://...)` 형식으로 등장
  - `linkBareUrlEmitted`: bare URL 형식으로 등장
  - `vaultPathMentioned`: `foo.md` 같은 raw 경로 언급
- 세션 종료 시 developer console에 비율 로그
- 2주 dogfood → 70% 미만이면 시스템 프롬프트 강화 or MCP `open_note` 툴 폴백 추가

**Effort:** ~1시간 + 2주 관찰.

**Depends on:** 없음. bare URL 렌더 fix와 병행해도 무관.

---

### [ ] Session resume dropdown (cross-mode)

**What:** 과거 Claude Code 세션을 Obsidian에서 바로 재개. 터미널/웹뷰 양쪽에서 동일
데이터 소스(`~/.claude/projects/<slug>/*.jsonl`) 사용 가능하므로 인프라가 됨.

**How:**
- Claude 세션 저장소 파싱 (JSONL: 첫 user message + timestamp + session id 추출)
- `SuggestModal`: Today / Yesterday / Last 7 days 섹션 + 검색
- 선택 시 새 터미널(또는 웹뷰) 탭 열고 `claude --resume <id>` 실행

**Effort:** ~4시간. 세션 스토리지 포맷 안정성 먼저 확인 필요.

**Note:** 웹뷰 모드 가면 같은 모달이 그대로 재사용됨 (다만 터미널 spawn 대신 웹뷰
세션 초기화).

---

### [ ] Obsidian URI handler (cross-mode)

**What:** `obsidian://claude-code?prompt=...&session=...` URL로 외부에서 플러그인을
호출. 브라우저 북마클릿, 스크립트, 다른 앱에서 Claude로 보내기.

**How:**
- `this.registerObsidianProtocolHandler("claude-code", ...)` in `main.ts`
- 파라미터: `prompt` (주입할 텍스트), `session` (resume할 ID), `new` (강제 신규)

**Effort:** ~2시간.

**Note:** 웹뷰 모드에서도 같은 핸들러 그대로 재사용.

---

## v0.6.0 — Webview foundation (3-4주, THE 전략 축)

웹뷰 없이는 그 뒤 모든 차별화가 못 올라감. 이 릴리즈는 "기능 추가"가 아니라
**인프라 치환**.

### [ ] Custom webview with stream-json parsing

**What:** xterm.js를 대체(또는 옵션으로 공존)하는 커스텀 Obsidian 뷰. Claude Code를
`claude -p --output-format=stream-json --input-format=stream-json`로 실행해서
JSONL 이벤트 스트림을 파싱하고, assistant_message / tool_use / permission_request /
result 각각을 **구조화된 HTML 카드**로 렌더.

**Why:** 이 한 번의 치환으로 공식 IDE 확장이 제공하는 거의 모든 것 (diff, permission,
todo, context 표시, progress)이 **부산물로 따라옴**. 터미널 파싱의 fragility
(ANSI, chunk 경계, 포맷 변경 취약성)가 전부 사라짐.

**How:**
- 새 디렉토리 `src/webview/`:
  - `stream-json-parser.ts`: JSONL 파서 + 이벤트 타입
  - `event-cards/`: 각 이벤트 타입별 렌더러 (vanilla DOM 또는 Preact)
  - `input.ts`: 사용자 입력 → JSON line → stdin write
  - `webview.ts`: ItemView 호스트
- 설정 추가: `uiMode: "terminal" | "webview"` (기본값은 v0.6.0에선 `terminal`로
  유지, 유저가 opt-in)
- 기존 `ClaudeTerminalView`는 손대지 않음 — 병행 유지

**Effort:** ~3주 CC time.

**Risks:**
- `stream-json` 스키마가 Claude Code 버전별로 불안정할 수 있음. 최소 버전 고정 필요.
- 슬래시 커맨드(`/compact`, `/mcp`), TAB-hold로 permission mode 변경 같은 TUI 전용
  상호작용이 `-p` 모드에서 될지 불확실. 확인 필요.
- 일부 Claude Code 기능이 TTY 요구할 수 있음 (폴백 필요).

**Spike 먼저:** 실제 구현 전 1-2일 스파이크 — `claude -p --output-format=stream-json`
실행해 JSONL을 stdout에 받아 파싱하고, 가장 단순한 "hello world" 뷰 (assistant
메시지 한 개 렌더) 만들기. 스키마 안정성 + 누락 기능 목록 확인 후 본 구현 시작.

**Files:** `src/webview/` (신규).

**Dependencies:** 스파이크에서 stream-json 스키마 안정성 확인이 선결.

---

## v0.7.0 — Webview parity (~2주, VS Code 동등)

v0.6.0 웹뷰가 돌아가면 아래는 거의 "이벤트 → 렌더러" 매핑만 하면 끝. 웹뷰 인프라의
**부산물**. VS Code가 이미 하는 것들이지만 사용자 기대치이므로 채움.

### [ ] Inline diff viewer with accept/reject
- `tool_use` (Edit/Write) 이벤트 → 사이드-by-사이드 diff 카드 (diff npm 패키지)
- Accept / Reject / "Tell Claude to do X instead" 버튼 → JSON response로 stdin
- Partial accept (줄 단위 선택)은 다음 단계
- **Effort:** ~1주 (웹뷰 이후)

### [ ] Permission prompts as Obsidian Modal
- `permission_request` 이벤트 → `Modal` 띄우고 허용/거부/"항상 허용" 버튼
- Response → stdin JSON
- **Effort:** ~2일

### [ ] Todo list side panel
- `tool_use` (TodoWrite) 이벤트 → 오른쪽 도킹된 sub-panel 또는 상단 sticky card
- 현재 todo 상태 유지 (pending/in_progress/completed)
- **Effort:** ~2일

### [ ] Context window indicator
- `result` 이벤트의 `usage` → 상단 바에 `42% ctx` 표시
- 50%/80% 경계에서 색 변화
- **Effort:** ~3시간 (웹뷰에선 free로 따라옴)

### [ ] Progress indicators
- 긴 tool call 실행 중 스피너 + 경과시간
- **Effort:** ~1일

### [ ] Session title auto-generation
- 첫 user message 후 Haiku에 "3-5 단어 타이틀 지어줘" 호출
- 탭 이름 + session browser에 표시
- 터미널 모드에서도 가능하지만 웹뷰 맥락에서 자연스러움
- **Effort:** ~3시간

### [ ] Permission mode 상태 표시
- stream-json에서 mode 이벤트 수신
- 상태 바 또는 인풋 근처에 `Normal / Plan / Auto-accept` 배지
- **Effort:** ~2시간

---

## v0.8.0 — Obsidian-native moat (~3주, THE 차별화)

여기서부터가 VS Code가 **구조적으로 못 하는** 영역. 여기에 투자한 시간이 누적될수록
moat이 깊어짐.

### [ ] Plan-as-note (THE killer feature)

**What:** Claude가 plan mode 진입해서 플랜을 내놓을 때, 터미널 텍스트로 휘발시키지
말고 **vault에 실제 마크다운 노트로 저장**. `_claude/plans/YYYY-MM-DD-slug.md`.
유저가 Obsidian 에디터로 열어서 **편집**한 다음 "Approve and continue". 수정된
플랜이 Claude에게 전달됨.

**Why this wins:**
- 플랜에 backlink → 그 플랜을 근거로 작성한 코드, 회의노트, 디자인 노트와 자동 연결
- tag (`#plan`, `#refactor`, `#feature`) → 향후 검색/필터
- embed query → 다른 노트에서 "지난 달 승인된 플랜 전부" 같은 조회
- graph view → 프로젝트 진화 경로 시각화
- **VS Code는 이게 구조적으로 안 됨**. 거기선 플랜이 UI 상태. 여기선 vault의 일급
  시민.

**How:**
- stream-json의 plan_mode_enter 이벤트 (또는 동등한 시그널) 후킹
- 플랜 텍스트 추출 → vault에 파일 생성 → MarkdownView로 열기
- 상단에 커스텀 decoration으로 "Approve" / "Edit & approve" 버튼 (CodeMirror
  decoration 또는 MarkdownPostProcessor)
- Approve → 현재 노트 내용을 Claude에 JSON으로 전달 (stream-json input)

**Effort:** ~1주 (웹뷰 이후).

**Files:** `src/webview/plan-as-note.ts`, `src/webview/plan-approval-buttons.ts`.

---

### [ ] Conversation-as-note

**What:** 각 Claude 세션을 `_claude/sessions/YYYY-MM-DD-HHMM-slug.md`로 저장. 세션
종료 시 (또는 실시간 append) assistant 메시지, 주요 tool calls, 결정 사항을 vault
노트에 기록. 세션에서 참조된 파일/플랜은 Obsidian wikilink로 자동 삽입.

**Why this wins:**
- "작년에 auth 리팩토링할 때 뭐라고 결정했지?" → Obsidian 전체 검색으로 찾음
- Personal wiki + 코딩 히스토리가 같은 graph에서 연결됨
- 회고/weekly review 때 Claude와의 상호작용을 리뷰 대상에 넣음
- **VS Code는 과거 대화가 앱 상태로 휘발**. 여기선 영구 아카이브.

**How:**
- `WriteStream`으로 세션 노트에 event batch 단위로 append
- 타이틀 생성 (v0.7.0 session title) 재사용
- 참조된 `@file.md`는 wikilink `[[file]]`로 변환해 저장
- frontmatter: `session_id`, `started`, `ended`, `model`, `tokens_used`, `commit_sha` (있으면)

**Effort:** ~1주.

**Files:** `src/webview/conversation-as-note.ts`.

---

### [ ] Checkpoint-as-note-with-git-ref

**What:** 대화 중 임의 시점에 체크포인트 생성 → vault 노트 + git ref (stash/tag/branch)
묶음. 나중에 UI로 rewind하면 코드 상태 + 대화 상태 둘 다 그 시점으로 복원.

**Why this wins:**
- VS Code의 체크포인트는 앱 메모리. 재시작하면 날아감.
- 여기선 **체크포인트가 vault의 일급 노트** + git ref. 재시작해도 남음, 검색 가능,
  graph에서 "이 기능 개발 궤적" 시각화.
- 실험적 개발 장려 — "이거 망쳐도 돌릴 수 있으니까 대범하게 리팩토링" 가능.

**How:**
- 메시지 hover 시 rewind 버튼 (웹뷰 카드에)
- 3가지 rewind 옵션:
  - Fork conversation (코드 유지, 대화만 분기)
  - Rewind code only (git reset, 대화 유지)
  - Rewind both (full time travel)
- 체크포인트 노트: 대화 스냅샷 + git SHA + 생성 시각
- `_claude/checkpoints/<session>-<index>.md`

**Effort:** ~1주 (웹뷰 이후).

**Files:** `src/webview/checkpoint.ts`, `src/git-ref.ts`.

---

## v1.0.0 — Consolidation & polish (~1-2주)

### [ ] Onboarding walkthrough
Plugin 첫 활성화 시 "Learn" 체크리스트. @-mention, plan-as-note, checkpoint 같은
핵심 UX를 "Show me" 버튼으로 인터랙티브 투어.

### [ ] MCP management GUI
MCP 서버 enable/disable, 도구 목록 뷰, marketplace 추가를 설정 패널에서. 현재는
JSON 수동 편집.

### [ ] Per-session working directory
현재는 전역 `cwdOverride` 하나. 세션별(또는 터미널/웹뷰 탭별) CWD 지정 — 멀티
프로젝트 vault에 유용.

### [ ] 터미널 모드 deprecation 결정
웹뷰가 안정되면 터미널 모드를 유지할지, 모드 삭제하고 웹뷰 단일로 갈지, 특정 유스케이스만
터미널로 둘지 판단.

---

## Backlog / Optional

임팩트 낮거나 크리티컬 패스 아님. 시간 남을 때 또는 개별 요청 시.

### [ ] Slash command menu (`/` trigger)
Claude Code 슬래시 커맨드(`/compact`, `/mcp`, `/plugins`, `/clear` 등) +
`.claude/commands/*.md` 사용자 정의 커맨드를 SuggestModal로. 웹뷰 인풋 박스에서는
자연스럽게 구현 가능. 터미널 모드에선 xterm 키 인터셉트 필요.

### [ ] `@terminal:name` references
특정 터미널 출력을 `@terminal:1`로 참조. 현재는 파일 참조만.

### [ ] Keyboard shortcut for @-mention active file
현재 활성 노트를 prompt에 빠르게 추가하는 단축키. VS Code의 `Opt+K` 대응.

### [ ] Tab 상태 배지
웹뷰 이벤트 기반으로 permission pending / response complete를 탭 아이콘 배지로 표시.
웹뷰 인프라 있으면 쉽고, 터미널 모드에선 터미널 출력 파싱이라 fragile.

---

## Dropped (won't do)

이전 로드맵에 있었지만, 제품 thesis 재정비 후 재평가해서 드롭하는 항목. 패리티
레이스의 손해 큰 항목들. 필요성 생기면 재논의.

### [~] Cmd+Click — line jump support
VS Code 터미널 패리티. /autoplan CEO dual-voice가 지적한 바: URL emission
compliance가 측정되지 않은 상태에서 이 위에 기능 쌓으면 깨지기 쉬움. 웹뷰 모드의
markdown 렌더는 `[text](url#L42)` 앵커를 자연스럽게 처리하므로 거기서 free로 따라옴.

### [~] Permission mode pill (터미널 모드)
Claude Code 출력을 파싱해서 mode 추적하는 게 fragile. 웹뷰 모드에선 stream-json
이벤트로 free.

### [~] Context window indicator (터미널 모드)
ANSI-stripped 터미널 텍스트에서 토큰 숫자 추출은 brittle. 웹뷰 모드에선 `result`
이벤트의 `usage` 필드로 정확.

### [~] Diagnostic sharing (VS Code 패리티)
VS Code의 Problems 패널 자동 공유 대응. Obsidian은 코드 에디터가 아니라 린터/컴파일러
개념 없음. 코드 편집은 VS Code에 양보하는 게 thesis에 맞음.

### [~] 터미널 모드용 tab 상태 dot (fragile 버전)
터미널 출력 파싱 기반. 웹뷰 버전으로 대체 (위 backlog 참조).

---

## Completed

### v0.5.1 (2026-04-15)
- **ESC-aware link transform 회귀 픽스** — 터미널 시작 시 `^[[?1;2c` 노출 + 타이핑
  지연 두 버그 수정. `findPartialLinkStart`가 ANSI CSI 시퀀스 내부의 `[`를 markdown
  링크 시작으로 오인하던 문제. negative lookbehind + ESC/경계 가드 추가
- **OSC 8 hyperlinks** — `[name](obsidian://...)` markdown을 OSC 8 터미널
  하이퍼링크로 변환, 화면엔 이름만 표시, Cmd+Click 유지
- **SystemPromptWriter 추출** — `obsidian://` URL 포맷 지시문이 MCP 설정 무관하게 항상
  Claude에 전달되도록. 원자적 파일 쓰기, vault 이름 getter로 런타임 rename 대응
- Reviewed via /autoplan (CEO + Eng dual voices)

### v0.5.0 (2026-04-15)
- **Cmd/Ctrl+click vault notes** — 터미널 출력의 vault path/`obsidian://` URL을
  클릭해서 노트 열기
- **Smart path detection** — 공백, 한글, markdown 링크 포맷 처리. vault에 실제
  존재하는 경로만 하이라이트

### v0.4.0 (2026-04-12)
- **@-mention file picker** — 터미널에서 `@` 입력 시 fuzzy 파일 검색 모달
- **File preview panel** — 2-column 레이아웃, 선택 전 파일 내용 미리보기
- **Heading reference** — `@file#heading` 문법
- **Folder filter** — 쿼리 끝에 `/` 붙이면 폴더 내부만 필터
- **vitest infrastructure** — Obsidian API mocks + 20개 단위 테스트

### v0.3.0 (2026-04-10)
- **MCP context server with automatic workspace awareness** — 빌트인 MCP 서버가
  열린 노트, 활성 파일, vault 검색을 Claude에 노출. 시스템 프롬프트 주입으로 Claude가
  현재 열린 노트를 자동 인지. `.mcp.json`과 도구 권한 자동 생성.
