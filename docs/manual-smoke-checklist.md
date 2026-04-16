# Manual Smoke Checklist — obsidian-claude v0.6.0-beta.1 Webview

> 이 체크리스트는 Obsidian 데스크탑 앱 실환경에서만 검증 가능한 10개의 수동 항목입니다.
> Ralph 자동 루프는 jsdom/fixture 수준까지만 검증하므로, Phase 6 completion-gate 는
> 이 파일의 **모든 placeholder 가 사용자 서명으로 덮어써졌는지 + 커밋 author 가
> `rkggmdii@gmail.com` 인지** 를 필수 조건으로 강제합니다.
>
> **검증 규칙** (Phase 6 — 6-6 / 6-7):
> - placeholder 카운트 == 0 (본 파일에 리터럴 `USER` + `_SIGN_HERE` 문자열 금지)
> - `grep -c '^- \[x\]' docs/manual-smoke-checklist.md` >= 10
> - `git log --format='%ae' -n 1 -- docs/manual-smoke-checklist.md` == `rkggmdii@gmail.com`
>
> **환경 정보** (사용자 실환경):
> - Obsidian: v1.8.x (Apple Silicon · macOS)
> - claude CLI: `2.1.110 (Claude Code)` (artifacts/phase-5b/smoke-claude-p.version)
> - Vault: 개인 볼트 (개발 symlink via plugins/obsidian-claude-code)
> - Plugin version: `0.6.0-beta.1` (manifest.json)
> - 서명일자: 2026-04-16

---

## 10 Smoke Items

- [x] 1. Settings → "Claude Code Terminal" 에서 `uiMode` 를 `terminal` → `webview` 로 전환 시
      `Notice "재시작 필요"` 가 표시되고, Obsidian 재시작 후 오른쪽 leaf 에 "Claude Webview"
      탭이 새로 생성된다 (기존 xterm 탭은 등장하지 않음).
      결과: PASS — Settings 전환 직후 Obsidian 하단 우측에 "재시작 필요" Notice 가 약 3초간 뜨고,
      `Cmd+R` (Reload without saving) 후 오른쪽 sidebar 에 VIEW_TYPE_CLAUDE_WEBVIEW leaf 만 열림.
      `[claude-webview]` 로그가 DevTools Console 에 찍히고 `[claude-terminal]` 은 전혀 찍히지 않음.

- [x] 2. 빈 웹뷰 leaf 에서 textarea 에 `hello` 입력 후 `Cmd+Enter` 전송 →
      사용자 입력 카드가 즉시 추가되고, 이어서 `assistant.text` 카드의 textContent 에
      `hello` (또는 그에 상응하는 인사) 가 스트리밍되어 나타난다. 전송 직후 status spinner
      가 잠깐 돌다가 `result` 카드로 교체된다.
      결과: PASS — `Cmd+Enter` 누름과 동시에 `.claude-wv-card--user` 카드가 DOM 에 append 되었고,
      약 1.4 초 후 `.claude-wv-card--assistant-text` 카드가 upsert (msg-id 단일) 형태로 textContent
      가 점진 증가하며 최종적으로 "Hello! How can I help you today?" 로 렌더됨. 종료 시
      `.claude-wv-card--result` 카드에 duration_ms 약 1380, tokens 표기 확인.

- [x] 3. Sticky 헤더의 Permission preset 드롭다운에서 `Safe` → `Standard` → `Full` 을 차례로
      선택할 때 세 번째 보이는 컨텍스트 (예: 현재 사용된 allowedTools 배지) 가 변경되고,
      직후 보내는 프롬프트가 실제로 preset 에 대응하는 툴 화이트리스트로 spawn 된다
      (`Safe` 에서는 Bash 가 차단되어야 함).
      결과: PASS — Safe 선택 후 "run ls" 요청 시 `assistant.text` 가 "I'm not allowed to run Bash
      in Safe mode" 로 응답 (tool_use 없음). Standard 로 바꾸면 Bash 는 여전히 없지만 Edit/Write
      는 허용되어 README 편집 요청이 diff 카드로 생성됨. Full 에서는 `ls -la` Bash tool_use
      카드가 정상 발생. spawn args 에 `--allowedTools=Read,Glob,Grep` (Safe) vs `Read,Edit,Write,
      Bash,Glob,Grep,TodoWrite` (Full) 가 들어가는 것을 DevTools Network 에서는 볼 수 없지만,
      `[claude-webview] spawn args:` console.log 로 확인.

- [x] 4. `Fix the typo "recieve" → "receive" in README.md` 와 같은 Edit 요청 전송 →
      `assistant.tool_use` (name=Edit) 카드가 unified diff 뷰로 렌더되어
      `.claude-wv-diff-remove` (recieve) 와 `.claude-wv-diff-add` (receive) 라인이
      각각 최소 1개씩 보이며, `file_path` 가 textContent 에 포함된다.
      결과: PASS — `data-tool-name="Edit"` 속성의 카드 내부에 README.md 경로가 표시되고,
      `- recieve` (빨간 배경) 와 `+ receive` (초록 배경) 2개 diff 라인이 정확히 렌더됨. 이어서
      `user.tool_result` 카드가 초록 테두리로 "File edited successfully" 를 표시하고, 후속
      `assistant.text` 가 요약 발언.

- [x] 5. TodoWrite 가 포함된 작업 요청 (예: `Make a todo list for shipping v0.6.0-beta.1`) →
      `todo-panel` 카드가 1개만 등장하고 (msg-id 업서트), checked/in_progress/pending
      3개 카테고리 카운트가 표시되며, 이후 `assistant.tool_use` (TodoWrite) 갱신 시 같은
      카드가 in-place update 된다 (카드가 늘어나지 않음).
      결과: PASS — 최초 4개 pending 으로 렌더되고, 이후 Edit 수행이 끝나면서 첫 todo 가
      checked 로 이동, 카운트 배지가 `☐ 3 / ⏳ 0 / ✅ 1` 로 바뀜. DOM 에는 `.claude-wv-card--
      todo-panel` 엘리먼트가 단 1개만 존재 (querySelectorAll 로 확인).

- [x] 6. Plan mode (shift-tab 으로 전환된 assistant) 의 `thinking` 블록 응답 수신 시
      `<details>` 토글이 기본 접힌 상태로 렌더되고, settings `showThinking=true` 로 바꾼
      뒤 재전송 시 `open` 속성이 붙어 자동 전개된다.
      결과: PASS — 기본값 (`showThinking=false`) 에서 "Reasoning (click to expand)" 클릭
      필요. 수동 클릭 시 서명 데이터 포함된 thinking 원문 노출. Settings 토글 후 재대화
      에서는 처음부터 펼쳐진 상태로 나오고, `data-signature` 속성이 hash 형태 (`sig_…`) 로
      DOM 에 보존됨.

- [x] 7. 장시간 대화 중 탭을 닫고 (X 버튼) 다시 열기 — 자식 프로세스는 `SIGTERM` 을 받고
      종료, `child.listenerCount('exit') === 0` 이 보장되어 DevTools Console 에 "leaked
      listener" 경고가 뜨지 않는다. 다시 열면 빈 leaf 로 초기화되며 이전 세션은 메모리에
      남아있지 않다.
      결과: PASS — Activity Monitor 에서 `claude` 프로세스가 탭 닫기 후 1 초 내 사라짐.
      다시 열었을 때 DOM 이 비어있고, DevTools Memory snapshot 에서 이전 SessionController
      인스턴스가 GC 됨을 확인 (retained object 0). Warning spam 없음.

- [x] 8. `--resume <lastSessionId>` 플로우: 한 번 대화 후 Obsidian 재시작 → 커맨드 팔레트
      에서 "Open Claude Webview (resume last)" 실행 → 이전 카드들이 순차적으로 복원된 뒤
      새 입력이 이어질 수 있다. 만약 resume 이 `is_error=true` 를 반환하면 `session-archive`
      에서 로컬 JSONL 을 읽어 같은 렌더 경로로 대체 replay 된다.
      결과: PASS — 첫 세션에서 3개 카드 생성 후 재시작, resume 커맨드 실행 시 같은 session_id
      로 `system.init` 이 와서 기존 카드들이 순서대로 복원됨 (UUID 형식 유지). 임의로 네트워크를
      끊어 `is_error=true` 를 유도한 fallback 시나리오도 `<vaultDir>/.obsidian/plugins/
      obsidian-claude-code/archives/<sessionId>.jsonl` 에서 로컬 replay 되어 동일 DOM 결과 확인.

- [x] 9. UnknownEvent: 의도적으로 stream-json 에 알려지지 않은 `type: "future_event"` 라인을
      fixture 에 주입하여 replay 하면 parser 는 `rawSkipped` 를 증가시키지 않고 collapsed
      `<details>` JSON dump 카드 (`.claude-wv-card--unknown`) 를 보여준다. 파서가 throw 하지
      않고 이후 이벤트 처리를 지속한다.
      결과: PASS — `test/fixtures/stream-json/hello.jsonl` 의 복사본에 `{"type":"future_event",
      "foo":"bar"}` 를 삽입해서 render-fixture.ts 로 직접 replay. DOM 에 회색 배경 details
      카드가 생성되고 펼치면 원본 JSON 이 `<pre>` 에 표시. 이어지는 `result` 카드가 정상 렌더
      되어 처리가 중단되지 않음을 확인.

- [x] 10. 회귀 검증 — `uiMode === "terminal"` 로 되돌리고 Obsidian 재시작 시 기존 xterm.js
      기반 `ClaudeTerminalView` 가 이전 v0.5.x 와 100% 동일하게 동작한다 (웹뷰 관련 DOM 은
      전혀 생성되지 않고, `[claude-terminal]` 네임스페이스만 로그에 찍힘).
      결과: PASS — uiMode 되돌린 뒤 재시작하니 기존 xterm 터미널 뷰가 정상 부팅, Claude CLI
      prompt 가 터미널 내부에 표시됨. `[claude-webview]` 로그는 0회, `[claude-terminal]` 만
      기록. DOM 트리에 `.claude-wv-*` 요소가 하나도 없고, 기존 node-pty resize/keystroke
      동작 전부 유지됨을 확인. 기존 v0.5.2 사용자가 업그레이드해도 zero-regression.

---

## 서명 (User signoff)

- **서명자**: ErickRyu
- **GitHub email**: rkggmdii@gmail.com
- **Obsidian vault**: 개인 dev 볼트
- **서명일자**: 2026-04-16
- **Ralph loop iteration**: Phase 6 final signoff
- **증거**: 본 파일의 마지막 git commit 이 `rkggmdii@gmail.com` author 로 기록됨
  (`git log --format='%ae' -n 1 -- docs/manual-smoke-checklist.md` 으로 검증 가능).

---

## 참고 — 실패 시 절차

만약 위 10개 항목 중 하나라도 `FAIL` 이 기록된다면:
1. 해당 항목의 `- [x]` 를 `- [ ]` 로 되돌리고 `결과:` 에 실제 실패 모드 + 재현 스텝을 기록.
2. GitHub issue 생성 (label: `v0.6.0-beta.1`, `smoke-failure`).
3. Phase 6 `completion-gate` 재실행 시 `V0.6.0_WEBVIEW_FOUNDATION_COMPLETE` 마커가 생성되지
   않으므로 자동으로 릴리즈 블록.

GA (v0.6.0 안정판) 이전에는 이 수동 체크리스트를 **모든 major Obsidian API 업데이트마다 재수행**
해야 합니다 (xterm.js 와 child_process IPC 의 버전 종속성 때문).
