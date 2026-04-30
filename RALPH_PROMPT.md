# obsidian-claude v0.6.0 Webview Foundation — Ralph Loop Iteration Prompt

> **매 iteration 마다 STEP 0 → 1 → 2 → 3 → 4 를 순서대로 수행하라.**
>
> 이 프롬프트는 RALPH_PLAN.md (Phase 0 ~ Phase 6 실행 계획) 와 함께 사용된다.
> 완료 조건: `V0.6.0_WEBVIEW_FOUNDATION_COMPLETE` 마커 파일이 생성되면 `<promise>V0.6.0_WEBVIEW_FOUNDATION_COMPLETE</promise>` 를 출력하고 종료.

---

## STEP 0: 상태 확인 (매 iteration 시작)

1. `RALPH_PLAN.md` 를 **전부** 읽어라. 특히 현재 Phase 의 태스크와 검증 매트릭스.
2. `PROGRESS.md` 를 읽어라 (없으면 초기화). 직전 iteration 의 체크마크 전부 확인.
3. 이전 체크마크가 여전히 통과하는지 **매 iteration 에서 재검증**:
   ```bash
   npm run build 2>&1 | tail -3 && test -f main.js && echo BUILD_OK
   npm run test 2>&1 | tail -3
   npx tsc --noEmit 2>&1 | tail -5
   bash scripts/check-no-any.sh 2>&1 | tail -3
   ```
   하나라도 깨졌으면 **새 Phase 진행 금지. 깨진 체크마크부터 복구.**
4. `git status` 로 의도치 않은 변경 확인.
5. 현재 Phase 결정: `PROGRESS.md` 의 마지막 완료 Phase 다음. Phase 0 → 1 → 2 → 3 → 4a → 4b → 5a → 5b → 6 순 (총 9 iteration).
6. **Phase Tag Gate**: Phase N 시작은 `git tag --list 'phase-*-complete' | wc -l === (N 이전 Phase 개수)` 일 때만 허용. Phase 건너뛰기 차단.
7. **Regression Log**: STEP 0 의 재검증 CMD 출력을 `artifacts/phase-<current>/regression-log-<iteration>.txt` 에 저장. CMD + timestamp + exit code + stdout 첫/끝 10 라인 각각 포함. PROGRESS.md 에서 이 파일 경로 인용.

---

## STEP 1: 현재 Phase 작업

### 1 iteration = 1 Phase 원칙

**한 iteration 에 여러 Phase 를 합치지 마라.** 합치면 후반 품질이 반드시 붕괴한다. Phase 가 너무 크게 느껴지면 a/b 로 분할하고 RALPH_PLAN.md 의 Phase 분해를 수정한 뒤 해당 iteration 을 종료하라.

### 태스크 분류 (모든 태스크는 태그 필수)

- `[PRODUCT]` 사용자가 직접 쓰는 기능. 런타임 실행으로 검증.
- `[TEST]` `[PRODUCT]` 검증 vitest.
- `[FIXTURE-INFRA]` fixture 기반 검증 인프라 (PRODUCT 아님).
- `[INFRA]` 빌드 / 설정 / docs / scripts.

### 프로덕트 축소 방지 — 금지 패턴 5개

1. `[PRODUCT]` 를 `TODO: implement` 또는 throw 로 스텁 → 검증 매트릭스의 런타임 exec 에서 실패해야 함. 못 하면 그 Phase 는 종료 불가.
2. `[PRODUCT]` 를 하드코딩 상수 반환으로 대체 → **차등 입력 테스트** (같은 함수에 다른 fixture 주면 다른 histogram) 를 RALPH_PLAN.md 에 명시. 통과하려면 실제 로직 필요.
3. `[FIXTURE-INFRA]` 를 `[PRODUCT]` 로 태그 ↔ 반대. 태그 자체를 본 RALPH_PROMPT.md 로 재검토해서 엄격하게 분리.
4. `[TEST]` 가 trivial (`expect(x).toBeTruthy()`) 로 통과 → 각 Phase 검증 항목에 **구체 expected value** 가 있어야 하며 (카드 수, 문자열 포함, exit code), 그걸 만족해야.
5. must-have / should-have 리스트에서 항목 "스킵" → Phase 6 completion-gate 에서 assertion ID 기반 (MH-01 ~ MH-11, SH-01 ~ SH-06) 전수 검증. 누락 불가.

### 에이전트 활용 가이드

독립적 리뷰 / 빌드 / 테스트는 **항상 병렬** (단일 메시지에 `Task` 여러 개):

- Phase 2, 4, 5a 후: `code-reviewer` + `typescript-reviewer` 병렬 리뷰
- Phase 3 후: `code-reviewer` + `security-reviewer` 병렬 (spawn / stdin 보안)
- 빌드 에러: `build-error-resolver`
- 타입 에러 깊은 건: `typescript-reviewer`
- 코드 리뷰: 리뷰 결과 `output/reviews/phase-N-<timestamp>.md` 로 저장. CRITICAL/HIGH 수정 후 **re-review 필수**.

### 비용 관리

- `claude -p` smoke 는 Phase 5b 에서 단 1회 실행. 다른 Phase 에서 `claude` 호출 금지.
- fixture replay 는 무제한 허용 (로컬, 무료, 결정론적).

---

## STEP 2: Phase 완료 검증

### 검증 매트릭스 전수 실행

현재 Phase 의 RALPH_PLAN.md 검증 매트릭스에 있는 **모든 행의 CMD 를 실제로 실행** 하고 출력을 캡처하라.

### 자기 선언 금지 — 증거 기반

각 체크마크에 대해 **CMD 의 실제 stdout 을 PROGRESS.md 에 그대로 붙여넣기**. "작동함", "테스트 통과" 같은 서술 금지. 예시:

```markdown
| 2-1 | PRODUCT | hello.jsonl 렌더 카드 수 | CMD: `npx tsx scripts/render-fixture.ts hello.jsonl && ...` | OUT: `exit 0\n{cardCount: 4}` | EXPECT: `>= 3` | PASS: YES |
```

### exit code 검증

모든 검증 CMD 는 성공 = exit 0, 실패 = exit 1. exit code 를 출력에 포함.

### 리뷰 결과 처리 (Ralph 자기 재분류 차단)

코드 리뷰 실행 후:
1. 리뷰 에이전트에게 **구조화된 JSON 출력 강제** 요청: `[{severity: "CRITICAL|HIGH|MEDIUM|LOW", issue, file, line}]`. 결과를 `output/reviews/phase-N-<timestamp>.json` 으로 저장.
2. 자동 검증: `node -e "const r=require('./output/reviews/...'); const bad=r.filter(i=>i.severity==='CRITICAL'||i.severity==='HIGH'); process.exit(bad.length===0?0:1)"`. Ralph 가 "이건 CRITICAL 아님" 으로 재분류 불가 — JSON 필드 그대로 기계 판정.
3. `bad.length > 0` 이면 **전부 수정** 후 **re-review** (두 번째 호출). 두 번째 JSON 에서도 CRITICAL/HIGH = 0 이어야 Phase 완료 허용.
4. 리뷰 JSON 경로 + 두 번째 JSON 경로 둘 다 PROGRESS.md 에 인용.

### 이전 체크마크 재검증

이번 Phase 검증에 더해 **이전 Phase 들의 핵심 게이트도 재실행**:
- `npm run build` BUILD_OK
- `npm run test` 전부 pass (기존 81 + 신규)
- `bash scripts/check-no-any.sh` exit 0
- `npx tsc --noEmit` exit 0

이전 Phase 가 깨졌으면 이번 Phase 완료 선언 불가. 회귀부터 고쳐라.

---

## STEP 3: PROGRESS.md 업데이트

### 구조

```markdown
# PROGRESS.md

## Current Phase: <Phase N 제목>
## Last Iteration: YYYY-MM-DD HH:MM (iteration #N)

## Phase 완료 현황
- [x] Phase 0 — UX Preflight & Scaffolding (완료 iteration #1, YYYY-MM-DD)
- [x] Phase 1 — Parser Core (iteration #2)
- [ ] Phase 2 — Renderer Skeleton (in progress)
- [ ] Phase 3 — ...

## 현재 Phase 검증 매트릭스

| # | 구분 | 항목 | CMD | OUT | EXPECT | PASS |
|---|------|------|-----|-----|--------|------|
| 2-1 | PRODUCT | ... | ... | ... | ... | YES/NO |
...

## 이전 Phase 재검증 (매 iteration)

| Phase | CMD | 결과 |
|-------|-----|------|
| build | `npm run build ... && test -f main.js` | BUILD_OK |
| test | `npm run test` | 84 passed, exit 0 |
| no-any | `bash scripts/check-no-any.sh` | exit 0 |
| tsc | `npx tsc --noEmit` | exit 0 |

## Pre-mortem 자기진단 (CMD + 실제 출력 필수)

각 항목은 **CMD 실행 결과** 를 붙여 넣어야 함. 단순 `[x]` 체크 금지.

**PM-1 (Fixture Fortress)**:
- CMD: `bash scripts/check-evidence.sh artifacts/phase-<N>/*.json 2>&1 | tail -5`
  OUT: <실제 stdout 붙여넣기>
- CMD: `grep -rE 'return (\[\]|{}|"todos updated"|42)' src/webview/ | wc -l`
  OUT: <값>

**PM-2 (Evidence 조작)**:
- CMD: `node -e "const h=require('./artifacts/phase-<N>/<file>.json'); const fs=require('fs'); console.log('script exists:', fs.existsSync(h.generatedBy)); console.log('age seconds:', (Date.now()-new Date(h.generatedAt).getTime())/1000); console.log('pid:', h.subprocessPid, 'parseCount:', h.parserInvocationCount)"`
  OUT: <실제 stdout>

**PM-3 (Context 과부하)**:
- CMD: `grep -c '^| ' RALPH_PLAN.md | head -1` (현재 Phase 검증 행 수)
- CMD: `ls output/reviews/phase-<N>-*.json 2>&1 | wc -l` (리뷰 파일 개수)

**PM-AP-1 (Vitest 과의존)**:
- CMD: `grep -cE '(disposed|this\.leaf\.view !== this)' src/webview/view.ts src/webview/session/session-controller.ts`
  OUT: <값>, 2 이상이면 OK

**PM-AP-2 (타입 회피)**:
- CMD: `bash scripts/check-no-any.sh 2>&1 | tail -3` — exit 0 여야
  OUT: <stdout>

**PM-AP-3 (Phase 경계 선점)**:
- CMD: `bash scripts/check-allowlist.sh <current-phase> 2>&1 | tail -3` — exit 0 여야
  OUT: <stdout>
- CMD: `git tag --list 'phase-*-complete' | wc -l`
  OUT: <값>, 이전 Phase 개수 정확히 일치

**AP-1 (금지 grep 전수)**:
- CMD: `grep -rE '(\.appendChild\(|\.append\(|innerHTML\s*[+=]|insertAdjacentHTML|insertBefore)' src/webview/renderers/ src/webview/ui/`
  OUT: <stdout>, 0 매치

**AP-2 (접근성)**:
- CMD: `grep -rE 'aria-(label|role|live)' src/webview/ui/ | wc -l`
  OUT: <값>, `>= 3` 권장 (Phase 4b 이후)

**AP-4 (스코프 팽창)**:
- CMD: `git diff phase-0-complete..HEAD --name-only src/webview/ | wc -l` 과 allowlist 누적 파일 수 비교
  OUT: <값>

Ralph 가 위 CMD 결과를 붙여넣지 않으면 해당 Phase PASS 거부.

## 이슈 로그

- iteration #N: <이슈 제목> — <상태: 해결됨/진행중> — <노트>
```

### 갱신 규칙

- 매 iteration 종료 시 **반드시** PROGRESS.md 갱신. 없으면 다음 iteration 에서 STEP 0 재검증 기준 없음.
- Phase 완료 시 `[x]` 체크.
- 이슈는 날짜 + iteration 번호 + 상태 기록.

---

## STEP 4: 다음 Phase 전환 또는 완료 선언

### 다음 Phase 전환 조건

현재 Phase 검증 매트릭스의 **모든 행 `PASS = YES`** 이고, 이전 Phase 재검증도 전부 통과.

- 통과: PROGRESS.md 에 현재 Phase `[x]` + 다음 Phase "in progress". iteration 종료 (다음 iteration 에서 STEP 0 으로).
- 미통과: 실패한 행의 번호 / CMD / OUT / 기대값을 PROGRESS.md 이슈 로그에 기록. iteration 종료 (다음 iteration 에서 같은 Phase 재시도).

### 완료 선언 (Phase 6 종료 시에만)

다음 조건 **전부 만족** 시에만 `<promise>V0.6.0_WEBVIEW_FOUNDATION_COMPLETE</promise>` 출력:

1. `V0.6.0_WEBVIEW_FOUNDATION_COMPLETE` 파일이 루트에 존재 (scripts/completion-gate.ts 가 조건부 생성).
2. `artifacts/phase-6/completion-matrix.json` 의 must-have 11 + should-have 6 전부 `pass: true`.
3. `artifacts/phase-5b/smoke-claude-p.verdict` === `SMOKE_OK` (SKIP 허용 안 됨 — 사용자 승인 있어야만, 그 경우 HUMAN_ACTION_REQUIRED.md 로 에스컬레이션 후 사용자 서명).
4. `docs/manual-smoke-checklist.md` 의 10 개 항목이 전부 `[x]` 체크 **+ 결과 칸 작성됨** (Ralph 가 체크 불가, 사용자만 가능).
5. `npm run test` / `npm run build` / `tsc --noEmit` / `check-no-any` 전부 exit 0.
6. `RALPH_PLAN.md` 의 could-have 항목이 v0.6.0 에 포함되지 않았는지 (스코프 유지).

이 중 하나라도 실패하면 completion promise 출력 금지. PROGRESS.md 이슈 로그에 원인 기록.

---

## 핵심 규칙 14개

1. **1 iteration = 1 Phase** (+ git tag gate). Phase 완료 시 `git tag phase-N-complete`. 다음 Phase 시작은 이전 tag 개수 정확히 맞을 때만.
2. **증거 기반 검증**. CMD 실제 stdout 을 PROGRESS.md 에 붙여넣기 없으면 `PASS = NO`.
3. **리뷰 결과 JSON 강제**. `output/reviews/*.json` 의 `severity === CRITICAL || HIGH` 카운트 **자동 검증**. Ralph 의 재분류 개입 차단.
4. **빌드 통과 ≠ 런타임 성공**. fixture replay + smoke 로 실제 실행 확인.
5. **거짓 promise 금지**. Completion 6 조건 전부 증명했을 때만.
6. **TDD 필수**. `[TEST]` 를 먼저 **분리된 git commit** 으로 (product 파일 없는 상태에서 `npx vitest` 가 RED 로그 남김). `artifacts/phase-N/red-log.txt` 에 RED 출력 캡처 후 다음 커밋에서 product 구현.
7. **코드 리뷰 필수**. Phase 2/3/4a/4b/5a/5b/6 끝에 `output/reviews/` 에 JSON 파일 저장.
8. **에이전트 병렬 실행**. 독립적 리뷰 / 탐색은 항상 병렬 (단일 메시지 여러 Task).
9. **Fixture 회귀**. Phase 5b real smoke 추가해도 fixture 8개 전부 항상 통과.
10. **이전 체크마크 재검증 + regression-log**. 매 iteration STEP 0 에서 build / test / tsc / no-any / check-allowlist 재실행. `artifacts/phase-<current>/regression-log-<iteration>.txt` 에 CMD + timestamp + exit + head/tail 10 라인 저장.
11. **[PRODUCT] 축소 금지**. stub / TODO / 하드코딩 대체 전부 금지. 검증 매트릭스로 차단.
12. **evidence 스크립트 생성 + subprocess 증빙**. `artifacts/phase-*/` 의 JSON 은 `scripts/*.ts` 가 서브프로세스에서 parser 를 실제 호출. `generatedBy` + `subprocessPid` + `parserInvocationCount` + `firstLineSha256` 8-point 교차검증 (scripts/check-evidence.sh).
13. **Phase 파일 allowlist**. 매 Phase 완료 시 `scripts/check-allowlist.sh <phase>` 로 `src/webview/` 신규 파일이 allowlist 와 정확히 일치. 선점된 다음-Phase 파일 차단.
14. **no-any + 교집합 캐스팅 + 인덱스 시그니처 금지**. `bash scripts/check-no-any.sh` 는 `as any`, `@ts-ignore`, `as Foo & Bar`, `[key: string]: unknown` 전부 차단. 에러 회피 리팩터링 패턴 방어.

---

## Pre-mortem 실패 시나리오 및 방지책

### PM-1: Fixture Fortress

**시나리오**: fixture 인프라 (replay script, fake-spawn) 만 완벽하게 만들고, 실제 웹뷰는 빈 카드만 그림. fixture 테스트는 전부 통과하지만 Obsidian 에서 열어 보면 아무것도 안 됨.

**방지책**:
- `[FIXTURE-INFRA]` 태그 분리 — `scripts/replay-fixtures.ts`, `fixture-replay.ts` 등은 명확히 구분.
- Phase 2 부터는 `[PRODUCT]` 를 실제 `view.ts` 의 onOpen 경로에 결선. 테스트는 view.ts 를 마운트해서 fixture replay (test 전용 경로가 아닌 production 경로) 를 검증.
- Phase 5b smoke: 실제 `claude -p` spawn 후 stdout 을 parser 에 흘려 보내고 assistant 카드 하나라도 렌더되었는지 확인 (테스트 환경 한계는 log 로 우회 검증).
- 차등 입력 테스트: `hello.jsonl` 히스토그램 ≠ `edit.jsonl` 히스토그램 (Phase 1 검증 1-6).

### PM-2: Evidence 조작

**시나리오**: `artifacts/phase-*/` 아래 JSON 을 Ralph 가 직접 작성해서 "generated" 처럼 위장. 실제 스크립트는 없음.

**방지책**:
- 모든 증거 JSON 에 `generatedBy: "scripts/<name>.ts"` 필드 필수.
- 검증 매트릭스에서 `test -f $(generatedBy)` 로 스크립트 실재 확인.
- `generatedAt` 이 현재 시간 ± 1일인지 (Phase 마다 재생성 강제).
- smoke 결과는 `scripts/smoke-claude-p.sh` 가 직접 `exit` 파일과 `verdict` 파일에 쓰고, 사람이 읽을 수 있는 `log` 도 동시 생성 — 3개 파일 중 하나라도 조작되면 불일치.

### PM-3: Context 과부하 (후반 Phase 품질 붕괴)

**시나리오**: Phase 4/5a/5b/6 이 한 iteration 에 너무 많은 태스크를 품어서 각 assertion 이 부실하게 통과.

**방지책**:
- Phase 4 는 4a (Tool-use + Edit-diff + Thinking) / 4b (TodoWrite + Permission UX) 로 분할. Phase 5 는 5a / 5b 분할.
- 각 Phase 검증 매트릭스 행 수 **≥ 8** 이어야 (assertion 밀도).
- 리뷰 JSON 파일 Phase 당 **≥ 1개** (output/reviews/*.json).
- PROGRESS.md 의 AP-4 에 "스코프 팽창 — could-have 가 v0.6.0 에 밀어 넣어졌는가" 체크.

### PM-AP-1: Vitest 과의존 → Runtime Lifecycle 블라인드

**시나리오**: Ralph 가 vitest 를 과하게 신뢰. Obsidian `ItemView` 의 실제 leaf lifecycle (`detach` 후 `onClose` 타이밍) 은 jsdom mock 에서 재현 안 됨. view-lifecycle.test 는 통과하지만 Obsidian 실환경에서 detached DOM 에 setText → plugin crash.

**방지책**:
- view.ts 와 session-controller 양쪽에 **double-guard** (`this.disposed` 플래그 + `this.leaf.view !== this` 체크) 둘 다 강제. Phase 3 검증 3-7 에서 확인.
- Phase 3 의 MH-11 검증 (3-4) 는 `child.stdout.emit('data', ...)` 실제 emit 후 DOM mutation 0 — fake 가 아닌 EventEmitter 기반 runtime 검증.
- Phase 6 수동 체크리스트 항목: "Obsidian 에서 'Reload without saving' → 웹뷰 재오픈 시 console.error 0건". 사용자 수동 확인.

### PM-AP-2: 에러 메시지 회피 리팩터링 (교집합 캐스팅 등)

**시나리오**: Ralph 가 TypeScript 에러를 만나면 메시지 회피 우선. `as any` 는 no-any gate 가 막음. 대안: `as Foo & Bar` (교집합 캐스팅), `[key: string]: unknown` (과도한 인덱스 시그니처), `JSON.parse(x) as StreamEvent` (validation 없는 cast).

**방지책**:
- `scripts/check-no-any.sh` 에 패턴 추가: `as\s+[A-Z]\w+\s*&`, `\[key:\s*string\]:\s*unknown`. 규칙 14.
- parser 입구에 **runtime schema 검증** (`parseLine` 은 type 필드 존재 확인, 없으면 `{ok:false}`). Phase 1 태스크 3.
- Phase 1 parser-schema.test 가 고의적 malformed 주입 → `{ok:false}` 반환 검증.

### PM-AP-3: Phase 경계 선점 (Premature Implementation)

**시나리오**: Ralph 가 "어차피 Phase 4 에 할 건데 지금 해두자" 유혹. Phase 2 에서 Phase 4 의 edit-diff renderer 를 부분 구현. Phase 4 도착 시 "이미 됨" 으로 skim-pass. TDD 순서 깨짐, 검증 허술.

**방지책**:
- **Phase 파일 allowlist** (RALPH_PLAN.md). 매 Phase 완료 시 `scripts/check-allowlist.sh <phase>` 로 신규 파일이 allowlist 와 정확히 일치.
- Git tag gate (규칙 1): Phase N 시작 전 `git tag --list 'phase-*-complete' | wc -l === (N 이전 Phase 개수)`.
- 각 Phase 커밋 직전 `git diff --name-only phase-(N-1)-complete..HEAD --stat` 를 regression-log 에 포함 + 파일 목록이 allowlist 와 일치.

---

## 에스컬레이션 프로토콜 (Phase 5b smoke 실패)

**조건**: `bash scripts/smoke-claude-p.sh` 가 3회 연속 실패 (network / auth / CLI 부재 등).

**절차**:
1. Ralph 가 `HUMAN_ACTION_REQUIRED.md` 초안 생성 — 증상, 실행 로그 경로 (`artifacts/phase-5b/smoke-claude-p.log`), exit code, 재현 CMD 포함. Ralph 자신의 서명 금지.
2. 이번 iteration 은 Phase 5b 미완료로 종료. `V0.6.0_WEBVIEW_FOUNDATION_COMPLETE` 마커 생성 불가.
3. **사용자만** 다음 작업 수행: (a) `HUMAN_ACTION_REQUIRED.md` 하단에 한 줄 추가 `signoff: rkggmdii@gmail.com YYYY-MM-DD`. (b) 이 파일 변경을 **사용자 email 의 git commit author** 로 커밋.
4. 다음 iteration STEP 0 에서 두 조건 동시 확인:
   - `grep -c '^signoff: rkggmdii@gmail.com' HUMAN_ACTION_REQUIRED.md >= 1`
   - `git log --format='%ae' -n 1 -- HUMAN_ACTION_REQUIRED.md === rkggmdii@gmail.com`
   둘 다 만족일 때만 SKIP 모드로 Phase 5b 완료 허용.
5. `CLAUDE_SMOKE_SKIP=1` 로 `scripts/smoke-claude-p.sh` 재실행 시 `verdict` 를 `SKIP_USER_APPROVED` 로 기록.
6. Phase 6 completion-gate.ts 는 `SMOKE_OK` 또는 `SKIP_USER_APPROVED` 만 수용. `completion-matrix.json` 에 `smokeSkipped: true` + `smokeSkipApprovedBy: "rkggmdii@gmail.com"` + `smokeSkipCommitSha` 필수.

**Ralph 자가 서명 차단**: git commit author email 검증이 핵심. Ralph 계정으로 커밋하면 email 불일치로 STEP 0 에서 실패.

---

## 도구 불가 시 대체 검증

### Obsidian 앱 실행 불가 (Ralph 자동 환경)

Ralph 는 Obsidian 앱을 띄울 수 없다. 해결:

- `[PRODUCT]` 검증은 **vitest + jsdom + mock-obsidian** 으로 DOM 생성까지 커버.
- ItemView 인스턴스화는 `test/__mocks__/obsidian.ts` 의 mock `ItemView` 사용 (기존 81 테스트와 동일 방식).
- 최종 "Obsidian 에서 reload 후 눈으로 확인" 은 `docs/manual-smoke-checklist.md` 10 항목으로 사용자 수동 체크.

### gstack / browser QA 도구 불가

해당 프로젝트는 웹앱이 아닌 Obsidian 플러그인. gstack / design-review 생략. 대신 `docs/manual-smoke-checklist.md` 가 그 자리를 대체.

### tsx / ts-node 불가

`npx tsx` 가 설치 안 된 환경: `package.json` devDependencies 에 `tsx` 추가 (Phase 0 또는 Phase 1 의 INFRA 태스크에 포함). 대안으로 `esbuild` 로 번들한 뒤 `node` 실행.

---

## Appendix: 검증 CMD 작성 가이드라인

### 반드시 지킬 것

1. **런타임 실행**: `node -e "..."` 또는 `npx vitest run` 또는 `npx tsx` — grep 으로 소스만 검사 금지 (경계 검사 제외).
2. **exit code**: `process.exit(ok ? 0 : 1)` 패턴.
3. **Promise 에러**: `.catch(e => { console.error(e); process.exit(1) })`.
4. **차등 입력 테스트**: 같은 함수에 다른 입력 → 다른 출력 확인 (Phase 1 의 1-6, Phase 3 의 3-1 참고).
5. **교차 검증**: evidence JSON → 원본 fixture 파일 존재 → scripts 파일 존재 → generatedAt 시간 범위.
6. **빌드 체크**: `npm run build 2>&1 | tail -3 && test -f main.js && echo BUILD_OK`. `grep -i error` 금지 ("error handling" 같은 정상 텍스트 매치).

### 피할 것

1. `grep -c 'keyword' file.ts >= N` — 주석에 키워드 넣어 게이밍 가능.
2. `wc -l file.ts >= N` — 빈 줄로 부풀리기.
3. `ls file.ts` — 파일 존재만, 내용 검증 없음.
4. `cat file.json` 수동 작성 — scripts 실행 강제로 차단.

### 허용되는 grep 사용 (부정 검증)

- 없어야 하는 것 확인: `grep -rE "\bas any\b|@ts-ignore" src/webview/` 가 0 매치.
- 금지 라이브러리 import 확인: `grep -rE "from ['\"]diff['\"]" src/webview/` 가 0 매치.
- 보조 확인 (런타임 검증이 주): grep 은 추가 증빙으로만.

---

## 실행 시작

1. 이 프롬프트 (`RALPH_PROMPT.md`) 전부 읽었음 확인.
2. `RALPH_PLAN.md` 읽기.
3. `PROGRESS.md` 읽기 (없으면 Phase 0 부터 시작).
4. STEP 0 → 1 → 2 → 3 → 4 순서대로 진행.
5. `V0.6.0_WEBVIEW_FOUNDATION_COMPLETE` 마커 생성 + 6개 조건 충족 시 `<promise>V0.6.0_WEBVIEW_FOUNDATION_COMPLETE</promise>` 출력.
