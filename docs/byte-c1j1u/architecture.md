# Byte c1J1u architecture

Pi as the runtime base, Ark System One as the decision layer, OpenAI/Codex public formats as the
compatibility surface. This document describes the architecture as implemented; it is updated
together with the code. Baseline: upstream earendil-works/pi @ 698a2d23b86a5045dd54554354a5e0cb7e466795.

## Design principles

1. **One execution path.** CLI, print/JSON, RPC, SDK, and subagents all drive the same
   `AgentSession` -> `Agent` -> `agentLoop` pipeline (already true in Pi; we keep it that way).
   Every new subsystem (plugins, hooks, catalog, decisions) is a service owned by the session
   runtime, not a parallel loop.
2. **Deterministic policy, learned relevance.** System One advises on relevance, ordering, model
   choice, and verification gaps. It never widens authorization, never skips mandatory hooks, and
   never rewrites validated arguments without re-validation. Failure of a decision call falls back
   to Pi's existing behavior (keep candidates, configured baseline model).
3. **Compatibility as format + behavior, not as marketing.** Every supported field and semantic is
   traceable to a source in `spec-sources.md`. Unknown fields surface as diagnostics, never as
   silent drops.

## System map

```
┌────────────────────────────────────────────────────────────────────┐
│ Interfaces (unchanged): TUI / print / JSON / RPC / SDK              │
├────────────────────────────────────────────────────────────────────┤
│ AgentSession (coding-agent/core)                                   │
│  ├─ ResourceLoader ──► PluginManager ──► plugin.json / marketplace │
│  │        │                    │                                    │
│  │        ├─ skills (SKILL.md, .agents/skills, agents/openai.yaml) │
│  │        ├─ mcp servers (mcp.json, .mcp.json import, plugin decl) │
│  │        └─ hooks (hooks.json, [hooks] toml, plugin hooks/)       │
│  │                                                                  │
│  ├─ HookRunner ─── 12 Codex events mapped to Pi run boundaries     │
│  ├─ CapabilityCatalog ── unified identity/source/version/scope     │
│  ├─ DecisionService ── shared State, batched questions, cache      │
│  │        └─ ArkSystemOne adapter (pi-ai classifier transport)     │
│  ├─ ModelRuntime ── VirtualModel "byte-c1j1u/auto" (routing)       │
│  ├─ SubagentScheduler ── parallel/dep graph/cancel/isolation       │
│  └─ VerificationLedger ── evidence chain + stop control            │
├────────────────────────────────────────────────────────────────────┤
│ Agent loop (pi-agent-core): prepareRequest / beforeToolCall /      │
│  afterToolCall / finishTurn — the decision + hook integration points│
├────────────────────────────────────────────────────────────────────┤
│ pi-ai: providers (openai, anthropic, ... + ark) — chat + classifier│
│ pi-mcp: stdio + streamable-http MCP client                         │
│ pi-tui: unchanged (1:1 visual parity with upstream Pi)             │
└────────────────────────────────────────────────────────────────────┘
```

## Where System One decides (and where it must not)

| Decision point | Pi mechanism | System One role | Deterministic floor |
|---|---|---|---|
| Skill selection | skills in system prompt + `$skill` explicit | score relevance of candidate skills from catalog metadata on new user goal; suggest loadouts | explicit `$skill` and `disable-model-invocation` always honored; policy.allow_implicit_invocation=false never auto-selected |
| Namespace/tool search | tool_search BM25 + deferred exposure | re-rank BM25 candidates; decide whether to search at all | direct active tools always usable; low-cost path: no classifier call for single explicit read |
| Model routing | VirtualModel route(request) | complexity/phase/media/failure-aware model + thinking level per stage | route failure -> configured baseline; user-selected model respected; no routing recursion (direct/compaction requests bypass) |
| Subtask delegation | SubagentScheduler | delegation value, role fit, dedup, conflict risk | file ownership by deterministic scheduler; in-use plugin versions never hot-swapped |
| Evidence filtering | PostToolUse / compaction boundary | which tool results deserve model attention; keep/expire priorities | raw results or recoverable references always retained |
| Verification & stop | finishTurn boundary | coverage vs gaps on acceptance criteria | missing evidence -> explicit follow-up task (bounded rework budget); tests/build failures never reported as pass |

Anti-goals (hard rules): System One cannot alter trust state, cannot disable hooks, cannot bypass
argument validation or permission checks, and its cached results are invalidated by steering
messages, file modifications, plugin set changes, and policy version bumps.

## Subsystem responsibilities

### 1. Ark provider (`packages/ai`)

- `providers/ark.ts`: chat models via `openai-completions` (Ark is OpenAI-compatible), classifier
  model `doubao-seed-2-1-lite-260915` via new `api/ark-system-one.ts` transport.
- Transport details from the One Pager: `POST {baseUrl}/api/v1/systemone`, header
  `ark-beta-systemone-api: true`, request `{model, state, questions}`, answers keyed by question
  id with noul/choice/score shapes, usage input-only. Public `bool` questions map to wire `noul`
  (same mapping as the existing typesafe transport). Multimodal `state` arrays
  (text/image/audio/video blocks) supported; classifier context `images` map to state image
  blocks. Errors, timeouts, cancellation, missing answers, unknown choices, and non-finite
  numbers are handled and surfaced as `ClassifierResult` error/aborted states.

### 2. Capability catalog (`coding-agent/core/capability-catalog`)

Single source of truth for: plugins (identity, version, origin, scope, enabled, trusted), skills
(name, description, source, invocation policy, dependencies), MCP servers (config source,
transport, connection state), tools (name, owner plugin/server, exposure, active state), hooks
(event, source, trust hash). States are explicit and distinct: registered ≠ discovered ≠ listed ≠
selected ≠ authorized. Invalidations propagate (plugin update, MCP disconnect, skill disable) so
decision caches cannot return stale capabilities. Persisted under the agent dir as JSON with a
schema version; session branches reference catalog versions for reproducibility.

### 3. Decision service (`coding-agent/core/systemone`)

- `DecisionService.ask(sharedState, questions[])`: one HTTP call per state; independent questions
  merged; dependent questions staged across calls. Question ids are stable and versioned with
  policy version.
- Cache keyed by (goal, evidence digest, candidate catalog version, question definitions, model,
  policy version). Invalidation hooks: steering/follow-up messages, file changes, plugin/skill/MCP
  set changes, user steering.
- Every decision logs a sanitized record (no credentials, no full file contents): timestamp,
  question ids, state digest, answers with probabilities, latency, cache hit/miss, fallback
  reason. Records append to a session-scoped JSONL for auditability.
- Budget: per-decision timeout, cancellation via session abort, cost accounting from usage fields.
  All failures degrade to deterministic fallbacks with recorded reasons.

### 4. Plugin system (`coding-agent/core/plugins`)

- Manifest reading order: root `plugin.json` (Agent Plugins 1.0.0 schema, validated strictly);
  OpenAI-specific settings from `extensions["com.openai"]` when present, else from
  `.codex-plugin/plugin.json` (never merged — replacement semantics per official docs).
- Sources: local marketplace catalogs (`$REPO_ROOT/.agents/plugins/marketplace.json`,
  `~/.agents/plugins/marketplace.json`, legacy `.claude-plugin/marketplace.json`), plus Pi's
  existing npm/git package sources adapted through the same lifecycle.
- Lifecycle: install (copy to cache dir), enable/disable (config layer), update (version swap only
  at safe boundaries — no hot swap mid-turn), uninstall (remove associated skills, MCP
  registrations, hooks, caches; orphan processes reaped). Name conflicts and invalid manifests are
  diagnostics, not crashes.
- Trust: installing/enabling never implies hook trust or MCP auth; those have independent states.

### 5. Skills (`coding-agent/core/skills` extended)

- Keep Pi's SKILL.md engine (already aligned with agentskills.io: name/description rules,
  progressive disclosure, scripts/references/assets).
- Add: `.agents/skills` discovery scopes (cwd up to repo root, user, admin), `agents/openai.yaml`
  parsing (`policy.allow_implicit_invocation` integrated with existing
  `disable-model-invocation`), `allowed-tools`/`license`/`compatibility`/`metadata` frontmatter
  fields parsed and exposed, plugin-bundled skills surfaced with plugin identity.
- Explicit invocation (`$skill:name`, `/skill:name`) and implicit invocation policies both
  enforced before System One relevance scoring.

### 6. Hooks (`coding-agent/core/hooks`)

- `hooks.json` + inline `[hooks]` (TOML) at user/project/plugin layers; all matching hooks run;
  plugin hooks use `hooks/hooks.json` default or manifest `hooks` field (replacement semantics).
- Handler types: `command` (subprocess, stdin JSON in, stdout JSON/plain contract, exit codes 0/2,
  timeout seconds, async background with delivery at next safe point, output spill to disk with
  preview) and `mcp_tool` (call on connected server with `${field}` argument templating).
- Event mapping to Pi boundaries (documented per event): PreToolUse inside agent-loop
  `beforeToolCall` before side effects; PostToolUse in `afterToolCall` (cannot undo); Stop at the
  agent-before-settle boundary (not every turn_end); SessionStart/End at session lifecycle;
  Pre/PostCompact around compaction; SubagentStart/Stop at scheduler boundaries; Interrupt on
  abort; UserPromptSubmit before prompt enters the queue; PermissionRequest exposed as a Pi
  extension hook (Pi has no native permission prompt; documented as extension semantics).
- Trust: per-hook-definition hash, review flow surfaced through TUI `/hooks`-equivalent command;
  managed-by-policy hooks skipped from auto-trust; plugin hooks never auto-trusted.

### 7. Model routing (`virtual model byte-c1j1u/auto`)

VirtualModel whose `route()` consults the DecisionService: stage-aware (new goal vs continuation
vs retry vs direct), complexity/媒体/budget/failure-count driven, stable within a phase, cache
miss cost considered, thinking level clamped to model support. Baseline fallback: first configured
available model. Compaction/branch-summary/direct requests route deterministically (no recursion).

### 8. Subagent scheduler (`coding-agent/core/subagents`)

Task graph with explicit ids, deps, concurrency caps, budget, timeout, cancel, resume; workspace
isolation via git worktrees when tasks may write concurrently, else ownership assignment enforced
by the scheduler (file-level locks). Subagents run the same AgentSession pipeline with scoped
tool sets and inherited-but-narrowed permissions; trigger SubagentStart/Stop hooks; results
collected into the parent session as structured entries with evidence links.

### 9. Verification ledger + stop control

Evidence chain binding acceptance criteria to artifacts: test/build/lint runs, interface checks,
artifact inspections — each bound to artifact versions (content hashes). System One judges
coverage vs gaps; gaps become explicit follow-up tasks within a bounded rework budget; repeated
failure detection stops the loop with an accurate status. Post-modification invalidation of stale
evidence; subagent failure/cancel never counts as success evidence. Stop boundary integrates with
the Stop hook semantics (continue-with-reason creates a continuation prompt; stop_hook_active
guards infinite loops).

## Implementation order

1. Ark provider + classifier transport + tests (unblocks all decision work; pure pi-ai layer).
2. Capability catalog (foundation for plugins/skills/hooks/mcp wiring and decision caching).
3. Plugin system (manifests, marketplace, lifecycle) + skill extensions + MCP config import.
4. Hook runner with event mapping + trust model.
5. Decision service on top of catalog + Ark transport.
6. Model routing virtual model.
7. Tool selection/evidence filtering integration into agent loop boundaries.
8. Subagent scheduler.
9. Verification ledger + stop control.
10. Compatibility test suite + fault injection + real-Ark integration tests.
11. Evaluation harness (upstream Pi vs Byte c1J1u) + TUI parity checks.
12. Documentation set + release.

Steps 2–4 are independent of 5–7 once interfaces are fixed; tests accompany each step.
