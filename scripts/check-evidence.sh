#!/usr/bin/env bash
# Evidence JSON cross-validator. Implements the 8 conditions from RALPH_PLAN.md:
#   1. generatedBy refers to an existing script
#   2. generatedAt is within ±1 day (ISO8601)
#   3. each fixture file exists under test/fixtures/stream-json/
#   4. firstLineSha256 matches actual fixture first-line sha256
#   5. subprocessPid is a positive integer != current process.pid
#   6. parserInvocationCount >= total non-empty lines across fixtures
#   7. each assertion.id matches MH-NN or SH-NN
#   8. generatedBy source contains parser/stream-json-parser import or require
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <evidence.json>"
  exit 2
fi

EVIDENCE="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -f "$EVIDENCE" ]; then
  echo "FAIL: evidence file missing: $EVIDENCE"
  exit 1
fi

node --input-type=module -e '
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const evidencePath = process.argv[1];
const root = process.argv[2];
const data = JSON.parse(fs.readFileSync(evidencePath, "utf8"));

function fail(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
}

// condition 1
fail(typeof data.generatedBy === "string" && data.generatedBy.length > 0, "generatedBy missing");
const generatorPath = path.resolve(root, data.generatedBy);
fail(fs.existsSync(generatorPath), `generatedBy script not found: ${data.generatedBy}`);

// condition 2
fail(typeof data.generatedAt === "string", "generatedAt missing");
const generatedAt = Date.parse(data.generatedAt);
fail(Number.isFinite(generatedAt), "generatedAt not ISO8601");
const driftMs = Math.abs(Date.now() - generatedAt);
fail(driftMs <= 24 * 60 * 60 * 1000, `generatedAt drift > 1d: ${driftMs}ms`);

// condition 5
fail(Number.isInteger(data.subprocessPid) && data.subprocessPid > 0, "subprocessPid not positive int");
fail(data.subprocessPid !== process.pid, "subprocessPid equals checker pid (did not run in subprocess)");

// single-fixture vs multi-fixture
const fixtures = Array.isArray(data.fixtures) ? data.fixtures : (data.fixture ? [{
  fixture: data.fixture,
  firstLineSha256: data.firstLineSha256,
}] : []);
fail(fixtures.length > 0, "no fixtures listed");

let totalLines = 0;
for (const entry of fixtures) {
  // condition 3
  const fixtureRel = path.join("test", "fixtures", "stream-json", entry.fixture);
  const fixtureAbs = path.resolve(root, fixtureRel);
  fail(fs.existsSync(fixtureAbs), `fixture not found: ${fixtureRel}`);
  // condition 4
  const content = fs.readFileSync(fixtureAbs, "utf8");
  const firstLine = content.split(/\r?\n/).find((l) => l.length > 0) || "";
  const sha = crypto.createHash("sha256").update(firstLine, "utf8").digest("hex");
  fail(typeof entry.firstLineSha256 === "string" && entry.firstLineSha256 === sha,
    `firstLineSha256 mismatch for ${entry.fixture}: expected ${sha}, got ${entry.firstLineSha256}`);
  totalLines += content.split(/\r?\n/).filter((l) => l.length > 0).length;
}

// condition 6
if (typeof data.parserInvocationCount === "number") {
  fail(data.parserInvocationCount >= totalLines,
    `parserInvocationCount ${data.parserInvocationCount} < total fixture lines ${totalLines}`);
}

// condition 7
if (Array.isArray(data.assertions)) {
  for (const a of data.assertions) {
    fail(/^(MH-(0[1-9]|1[01])|SH-(0[1-7]))$/.test(a.id),
      `invalid assertion id: ${a.id}`);
  }
}

// condition 8
const genSrc = fs.readFileSync(generatorPath, "utf8");
fail(
  /import[^;]*parser\/stream-json-parser/.test(genSrc) ||
  /require\([^)]*parser\/stream-json-parser/.test(genSrc),
  `generatedBy script does not import parser/stream-json-parser: ${data.generatedBy}`
);

console.log("check-evidence: OK");
' -- "$EVIDENCE" "$ROOT"
