# Byte c1J1u — evaluation reproduction

## Harness

`scripts/byte-eval/run-eval.mjs` compares the upstream-Pi baseline arm against the
byte-c1j1u treatment arm on fixed tasks, in this exact checkout, with deterministic
acceptance checks:

- **Baseline arm**: `--model ark/doubao-seed-2-1-lite-260915` — stock Pi agent loop, no
  virtual model, no System One calls.
- **Treatment arm**: `--model byte-c1j1u/auto` — System One complexity classification on
  new goals, then Ark physical models.

Both arms use the same cwd, the same tool environment, and the same model family, so the
only variable is the decision layer. Metrics per arm: task success, wrong completions
(replied but failed the check), errors (process failure), latency p50/max.

```bash
export ARK_API_KEY=...
node scripts/byte-eval/run-eval.mjs [--tasks N] [--repeats R]
```

Reports land in `.artifacts/byte-eval/eval-*.json` with the git head recorded.

## Recorded results (2026-10-16, this fork @ 15 commits past baseline)

Two runs (`--repeats 2`, 4 tasks × 2 arms × 2 repeats = 16 executions):

| Arm | Tasks | Success | Wrong completions | Errors | p50 | max |
|---|---|---|---|---|---|---|
| baseline (ark lite) | 8 | 100% | 0 | 0 | 5072ms | 8365ms |
| byte-c1j1u/auto | 8 | 100% | 0 | 0 | 4598ms | 13455ms |

Interpretation (with stated limits):

- Both arms satisfy the constraint gates (100% success, zero wrong completions) on this
  task set; the set is small (4 tasks) and skews simple, so it establishes **no
  regression and correct wiring**, not an advantage claim.
- The routing arm adds one System One classification per new session goal (sub-second,
  input-only billed, cached in router state for the session), which is visible in single
  trivial-task latencies (t1: 2915ms vs 1995ms) and amortized in multi-tool tasks
  (t2: 4324ms vs 6080ms — the treatment arm was faster where model choice mattered).
- Live protocol verification (5/5) and 164+ unit tests cover the compat and decision
  layers; the eval covers end-to-end task behavior.

## Cost accounting

System One bills input tokens only at the catalog price. The live e2e suite logs its
token usage per run (`[ark-e2e] total input tokens`), and the classifier's `usage` is
surfaced through decision records.

## Full test suite and environment-dependent failures

`./test.sh` runs every workspace. On this machine (macOS arm64, Node 26, no Rust
toolchain build, checkout path contains a space) the following fail **identically on the
pristine upstream baseline** (verified in a clean worktree at `698a2d2`) and are not
regressions:

| Suite | Count | Cause |
|---|---|---|
| `packages/env` (conformance, differential, remote, ssh, ssh-external, terminal) | 6 suites | requires `npm run build:daemon` (Rust) |
| `packages/codemode` worker-lifetime | 3 | Bun worker environment tests |
| `coding-agent` package-command-paths | 2 | same two fail on baseline |
| `coding-agent` external-editor | 3 | upstream `command.split(" ")` cannot handle spaces in the checkout path; source files are byte-identical to upstream |
| coding-agent tools.test / find regressions 3302/3303 | flaky | pass standalone; fail only under the full parallel suite (resource contention) |

Everything attributable to byte-c1j1u passes: 20 ark transport tests, 15 plugin tests,
7 capability-catalog tests, 9 decision-service tests, 52 hook tests, 36 skills-ext
tests, 14 decision-application tests, 10 subagent-scheduler tests, 16 compatibility
tests, 5 live Ark e2e tests, plus 2831 passing coding-agent package tests.
