<p align="center">
  <a href="https://pi.dev">
    <img alt="Pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>

# Byte c1J1u

**Pi as the runtime base · Ark System One as the decision layer · OpenAI/Codex public formats as the compatibility surface.**

Byte c1J1u is a fork of [Pi](https://github.com/earendil-works/pi) (upstream baseline
[`698a2d2`](https://github.com/earendil-works/pi/commit/698a2d23b86a5045dd54554354a5e0cb7e466795)) that adds two intertwined capabilities:

1. **An agent engineering system** where OpenAI/Codex-public-format plugins, skills, MCP
   servers, and hooks are discovered, installed, configured, loaded, and used correctly —
   through Pi's single execution path (interactive TUI, print, JSON, RPC, and SDK all
   share the same pipeline).
2. **A decision control layer** powered by Volcengine Ark's System One API
   (`doubao-seed-2-1-lite-260915`) that improves capability selection, model routing,
   evidence filtering, subtask delegation, and verification control — always behind
   deterministic floors, never widening authorization.

The TUI is byte-for-byte identical to upstream Pi (zero changes under `packages/tui` and
`src/modes/interactive`); every capability is added through Pi's native extension
mechanism. All upstream Pi documentation under [docs/](./docs) still applies.

## Quick start

```bash
npm install --ignore-scripts
npm run build:offline          # or: node packages/ai/scripts/generate-models.ts --data-only
export ARK_API_KEY=...         # Volcengine Ark key

./pi-test.sh                            # interactive TUI (1:1 upstream Pi)
./pi-test.sh --model ark/doubao-seed-2-1-lite-260915 -p "hello"   # plain chat
./pi-test.sh --model byte-c1j1u/auto -p "fix the failing test"    # System One routing
```

Inside the TUI: `/plugins` (manage plugins), `/hooks` (trust review), `/byte-c1j1u`
(subsystem status). System One is inactive without `ARK_API_KEY`; everything else works.

## What was added

| Subsystem | Location | What it does |
|---|---|---|
| Ark provider | `src/../ai/src/providers/ark.ts`, `ai/src/api/ark-system-one.ts` | Doubao chat models over OpenAI-compatible completions + the System One classifier transport (beta header, multimodal state, input-only billing) |
| Plugin system | `src/core/plugins/` | Agent Plugins 1.0.0 manifests with official `extensions.com.openai` replacement semantics, marketplace catalogs (repo/personal/legacy), versioned install cache without hot-swapping enabled plugins, portable `mcp.json` + Codex `.mcp.json` parsing |
| Skills extension | `src/core/skills-ext/` | agentskills.io frontmatter (license/compatibility/metadata/allowed-tools), `agents/openai.yaml` overlay (`policy.allow_implicit_invocation`, tool dependencies), `.agents/skills` discovery scopes |
| Hooks runtime | `src/core/hooks/` | All 12 Codex hook events with official matcher semantics, command + mcp_tool handlers, stdin/stdout JSON contract, exit codes, timeouts, async background hooks, per-definition-hash trust |
| Capability catalog | `src/core/capabilities/` | Unified identity/source/version/scope/state for plugins, skills, MCP servers, tools, hooks; registered ≠ discovered ≠ listed ≠ selected ≠ authorized; content digest for decision cache keys |
| Decision service | `src/core/systemone/` | One classify call per shared state with merged independent questions; cache keyed on goal+evidence+catalog+questions+model+policy; sanitized audit records; deterministic fallback recording |
| Model routing | `src/extensions/byte-c1j1u/router.ts` | `byte-c1j1u/auto` virtual model: System One complexity classification on new goals, phase-stable continuations, retry escalation, no routing recursion on direct requests |
| Decision applications | `src/extensions/byte-c1j1u/decisions.ts` | Evidence filtering (chunked relevance, never loses evidence on failure), verification ledger + stop control (bounded rework, honest settling), skill-selection advice, delegation advice |
| Subagent scheduler | `src/core/subagents/` | Task graph: ids, dependencies, cycle validation, deterministic file-ownership conflicts, concurrency caps, budget with abort-on-hang, cancellation propagation |
| Integration | `src/extensions/byte-c1j1u/index.ts` | Builtin extension wiring everything into every Pi interface; event mapping (PreToolUse→tool_call, Stop→agent_before_settle, …); `/plugins`, `/hooks`, `/byte-c1j1u` commands |

## Documentation

- [Specification sources and support scope](../../docs/byte-c1j1u/spec-sources.md) — every
  implemented field traced to its official spec, with access dates and explicit boundaries
- [Architecture](../../docs/byte-c1j1u/architecture.md)
- [Plugin & skill & hook development](../../docs/byte-c1j1u/developing.md)
- [Evaluation reproduction](../../docs/byte-c1j1u/evaluation.md)
- [Troubleshooting](../../docs/byte-c1j1u/troubleshooting.md)
- All upstream [Pi docs](./docs) (extensions, skills, MCP, codemode, SDK, …)

## Compatibility: verified, not claimed

Format and behavioral compatibility is defined by the compatibility test suite
(`test/compat/`) against fixtures mirroring the specifications' own examples, plus live
protocol tests (`packages/ai/test/ark-e2e.test.ts`, opt-in). Product-specific services
(ChatGPT connectors, the universal plugin directory, official marketplace listing,
sign-in-with-ChatGPT) are out of scope and never claimed — see the support-scope document
for the exact boundary.

## Tests

```bash
./test.sh                       # full suite (environment notes in evaluation.md)
node node_modules/vitest/dist/cli.js --run test/compat/compatibility.test.ts   # from packages/coding-agent
ARK_API_KEY=... ARK_E2E=1 node node_modules/vitest/dist/cli.js --run test/ark-e2e.test.ts  # live, from packages/ai
```

## License

MIT, as upstream Pi. This fork adds no additional restrictions.
