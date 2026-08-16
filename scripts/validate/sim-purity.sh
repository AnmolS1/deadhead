#!/usr/bin/env bash
#
# S-02 — the purity gate, shell half.
#
# The ESLint half (packages/sim/eslint.purity.mjs) reads source. This half reads
# what actually ships, checks the things a linter cannot see, and then proves the
# ESLint half still bites. Neither is sufficient alone.
#
#   1. the gate is live      — ESLint is really linting the sim, not silently
#                              ignoring every file while exiting 0
#   2. the build is clean    — no forbidden global or Math member survives into
#                              packages/*/dist
#   3. no dependencies       — sim and proto pull in nothing outside @deadhead/*
#   4. the gate still bites  — deliberate violations are rejected, one probe per
#                              rule family, so a single broken rule is visible
#
# Usage: npm run lint:sim-purity   (which builds first — steps 2 and 4 need dist
#                                   and node_modules respectively)

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RESET=$'\033[0m'
fail() { printf '%s✗ %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }
pass() { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
step() { printf '\n%s%s%s\n' "$DIM" "$*" "$RESET"; }

PURE_PACKAGES=(packages/sim packages/proto)
PROBE_GLOB='packages/sim/src/__purity_probe_*.ts'
# shellcheck disable=SC2064
trap "rm -f ${PROBE_GLOB}" EXIT

# ---------------------------------------------------------------------------
step '1/4  the gate is live'
# ---------------------------------------------------------------------------
# ESLint 10 resolves the nearest config file from the *linted file's* directory.
# A stray eslint.config.mjs under packages/sim/ therefore displaces the root
# config, and if its globs do not match, every sim file is silently "ignored"
# while eslint still exits 0. A purity gate that lints nothing passes forever,
# so assert the file count rather than trusting the exit code.

LINTED=$(node --input-type=module -e '
  import { loadESLint } from "eslint";
  const ESLint = await loadESLint({ useFlatConfig: true });
  const eslint = new ESLint();
  const results = await eslint.lintFiles(["packages/sim/src/**/*.ts"]);
  const ignored = results.filter((r) =>
    r.messages.some((m) => /no matching configuration/.test(m.message)),
  );
  console.log(JSON.stringify({ total: results.length, ignored: ignored.length }));
')
total=$(node -e "console.log(JSON.parse(process.argv[1]).total)" "$LINTED")
ignored=$(node -e "console.log(JSON.parse(process.argv[1]).ignored)" "$LINTED")

[ "$total" -gt 0 ] || fail "ESLint linted 0 files under packages/sim/src — the gate is not running."
[ "$ignored" -eq 0 ] || fail "$ignored file(s) under packages/sim/src matched no ESLint config. The gate is not covering them."
pass "ESLint is covering $total source file(s) under packages/sim/src"

# ---------------------------------------------------------------------------
step '2/4  the build is clean'
# ---------------------------------------------------------------------------
# Comments are stripped first. packages/sim/src/index.ts documents the ban in
# its own docstring, so the words "Math.random" and "Date.now" appear verbatim
# in dist/index.js. A naive grep flags the file that exists to prevent
# violations. (Recorded on S-02 in TASKS.md when S-01 hit it.)
#
# Keep this list in sync with packages/sim/eslint.purity.mjs. It is duplicated
# rather than shared because this half must be able to run against a build whose
# source is not present.

for pkg in "${PURE_PACKAGES[@]}"; do
  [ -d "$pkg/dist" ] || fail "$pkg/dist does not exist. Run 'npm run build' first."
done

node --input-type=module -e '
  import { readdirSync, readFileSync, statSync } from "node:fs";
  import { join } from "node:path";

  const FORBIDDEN = [
    [/\bwindow\b/, "window"],
    [/\bdocument\b/, "document"],
    [/\bnavigator\b/, "navigator"],
    [/\blocalStorage\b/, "localStorage"],
    [/\bsessionStorage\b/, "sessionStorage"],
    [/\brequestAnimationFrame\b/, "requestAnimationFrame"],
    [/\bperformance\s*\./, "performance"],
    [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
    [/\bWebSocket\b/, "WebSocket"],
    [/\bglobalThis\b/, "globalThis"],
    [/\bprocess\s*\./, "process"],
    [/\bfetch\s*\(/, "fetch()"],
    [/\bcrypto\s*\./, "crypto"],
    [/\bsetTimeout\s*\(/, "setTimeout()"],
    [/\bsetInterval\s*\(/, "setInterval()"],
    [/\brequire\s*\(/, "require() — this must stay pure ESM"],
    [/\bDate\s*\.\s*now\b/, "Date.now"],
    [/\bnew\s+Date\b/, "new Date"],
    [
      /\bMath\s*\.\s*(random|sin|cos|tan|asin|acos|atan|atan2|sqrt|cbrt|pow|exp|expm1|log|log2|log10|log1p|hypot|sinh|cosh|tanh|asinh|acosh|atanh)\b/,
      "an implementation-approximated Math member",
    ],
  ];

  /** Remove block and line comments. The `[^:]` guard keeps `https://` intact. */
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  const walk = (dir) =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });

  const failures = [];
  let scanned = 0;

  for (const pkg of process.argv.slice(1)) {
    for (const file of walk(join(pkg, "dist")).filter((f) => f.endsWith(".js"))) {
      scanned += 1;
      const lines = stripComments(readFileSync(file, "utf8")).split("\n");
      lines.forEach((line, i) => {
        for (const [pattern, label] of FORBIDDEN) {
          if (pattern.test(line)) {
            failures.push(`${file}:${i + 1}  ${label}\n      ${line.trim()}`);
          }
        }
      });
    }
  }

  if (failures.length > 0) {
    console.error(failures.map((f) => `    ${f}`).join("\n"));
    process.exit(1);
  }
  console.log(scanned);
' "${PURE_PACKAGES[@]}" > /tmp/.sim-purity-scanned || fail "forbidden reference(s) in built output (listed above)"
pass "$(cat /tmp/.sim-purity-scanned) built file(s) free of forbidden references"
rm -f /tmp/.sim-purity-scanned

# ---------------------------------------------------------------------------
step '3/4  no runtime dependencies'
# ---------------------------------------------------------------------------
# "Zero runtime dependencies, ever" (CLAUDE.md). Workspace-internal @deadhead/*
# is the only permitted specifier; anything else is a third-party dependency
# that would have to exist in the browser, in a DO, and in the validator.

node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const offenders = [];
  for (const pkg of process.argv.slice(1)) {
    const json = JSON.parse(readFileSync(`${pkg}/package.json`, "utf8"));
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const name of Object.keys(json[field] ?? {})) {
        if (!name.startsWith("@deadhead/")) offenders.push(`${pkg} -> ${field}.${name}`);
      }
    }
  }
  if (offenders.length > 0) {
    console.error(offenders.map((o) => `    ${o}`).join("\n"));
    process.exit(1);
  }
' "${PURE_PACKAGES[@]}" || fail "third-party runtime dependency in a pure package (listed above)"
pass "packages/sim and packages/proto depend only on @deadhead/*"

# ---------------------------------------------------------------------------
step '4/4  the gate still bites'
# ---------------------------------------------------------------------------
# One probe per rule family, checked individually. Running them as a single file
# would let one working rule mask five broken ones.

write_probe() { printf '%s\n' "$2" > "packages/sim/src/__purity_probe_$1.ts"; }

write_probe random 'export const v = Math.random();'
write_probe date   'export const v = Date.now();'
write_probe trig   'export const v = Math.sin(1);'
write_probe sqrt   'export const v = Math.sqrt(2);'
write_probe dom    'export const v = typeof window;'
write_probe import "import { readFileSync } from 'node:fs';
export const v = readFileSync;"
write_probe any    'export const v: any = 1;'

node --input-type=module -e '
  import { loadESLint } from "eslint";
  const ESLint = await loadESLint({ useFlatConfig: true });
  const eslint = new ESLint();
  const results = await eslint.lintFiles(["packages/sim/src/__purity_probe_*.ts"]);

  const undetected = results
    .filter((r) => r.errorCount === 0)
    .map((r) => r.filePath.replace(/^.*__purity_probe_/, "").replace(/\.ts$/, ""));

  if (results.length === 0) {
    console.error("    no probe files were linted at all");
    process.exit(1);
  }
  if (undetected.length > 0) {
    console.error(`    the gate did NOT reject: ${undetected.join(", ")}`);
    process.exit(1);
  }
  console.log(results.length);
' > /tmp/.sim-purity-probes || fail "the purity gate failed to reject a deliberate violation (listed above)"
pass "$(cat /tmp/.sim-purity-probes) deliberate violation(s) rejected"
rm -f /tmp/.sim-purity-probes

printf '\n%ssim purity: OK%s\n' "$GREEN" "$RESET"
