# Byte c1J1u — troubleshooting

## System One decisions are inactive

Symptom: `/byte-c1j1u` shows `decision service: inactive`.

- `ARK_API_KEY` must be set in the environment that launches pi.
- The classifier model must resolve: check `pi --list-models | grep ark` shows
  `ark/doubao-seed-2-1-lite-260915`. If not, the model data is stale — run
  `node packages/ai/scripts/generate-models.ts --data-only` (needs network) or copy a
  hydrated `packages/ai/src/providers/data/` from another checkout.
- Decisions degrade silently to stock Pi behavior when inactive — nothing breaks, routing
  falls back to the selected model.

## 401 / 403 from Ark

- `ARK_API_KEY` invalid or expired: chat calls fail with 401 from
  `ark.cn-beijing.volces.com`; classifier results return `stopReason: "error"` with the
  status in `errorMessage`.
- The System One route additionally requires the beta header
  `ark-beta-systemone-api: true` — it is carried on the classifier model definition; a
  custom models.json override that drops `headers` breaks it.

## Model data missing or stale

`Cannot find module './data/<provider>.json'` during tests or build: the generated model
data is gitignored and must be hydrated:

```bash
node packages/ai/scripts/generate-models.ts --data-only
```

The generator fetches upstream catalogs (models.dev, OpenRouter, Vercel AI Gateway,
Radius). If a catalog host is unreachable the generator tolerates it except when a
provider shard has no data source; the Vercel gateway (ai-gateway.vercel.sh) is required
for `vercel-ai-gateway` — a fetch shim that serves the pi.dev runtime catalog works
offline (see the hydration note in the repo history).

## Plugin does not appear in /plugins

- Marketplace file must be at `.agents/plugins/marketplace.json` (repo) or
  `~/.agents/plugins/marketplace.json` (personal). `source.path` is relative to the
  marketplace file's directory, `./`-prefixed.
- The manifest name must match the marketplace entry name exactly.
- `/plugins install` reports diagnostics: invalid manifests (bad name pattern, unknown
  fields), `NOT_AVAILABLE` policy entries, and non-local sources are refused with the
  reason. Git and npm sources resolve at install time only in the marketplace spec; the
  synchronous install path handles local sources.

## Hooks never run

- `/hooks` lists every configured handler with its trust state. Untrusted handlers are
  skipped with a diagnostic until trusted (hash recorded against the exact definition —
  editing the command re-enters review).
- Plugin hooks are untrusted by default even when the plugin is enabled.
- Matcher is a regex on the event-specific field (tool name, session source, trigger,
  agent type). `UserPromptSubmit`, `Stop`, and `Interrupt` ignore matchers.
- A hook that returns unsupported fields for its event (e.g. `continue` on PreToolUse)
  is marked failed and the operation proceeds; check the emit diagnostics.

## Hook output vanished

`additionalContext` above the token limit spills to
`~/.pi/agent/hook_outputs/<session>/<uuid>.txt`; the model sees a head-and-tail preview
plus the file path. Raise `additionalContextLimit` on the handler if the full text must
stay inline (raises context cost).

## byte-c1j1u/auto routes to the wrong tier

- Routing classifies only on new goals (`reason: "user"`), keeps the session model within
  a phase, and escalates one tier on retry after failures. A misjudged first
  classification persists for the session by design (cache-miss cost).
- Direct requests (compaction summaries, extension calls) bypass classification and use
  the last physical model — no routing recursion.
- Classifier failure falls back to `doubao-seed-2-1-lite-260915` and the session
  continues; the failure is in the decision audit records.

## Evaluation numbers look different

The harness pins the checkout, tasks, and acceptance checks but not wall-clock: run
`--repeats 3+` for stable comparisons, and compare arms within one run only (network and
load variance between runs exceeds arm differences). Reports record the git head; verify
you are on the commit the report names.

## Test suite failures on this machine

See the environment-dependent failure table in
[evaluation.md](./evaluation.md): pi-env daemon suites, codemode Bun workers,
package-command-paths, and external-editor (space-in-path) fail identically on the
pristine upstream baseline and are not byte-c1j1u regressions. `tools.test` and the find
regression tests are parallel-suite flakes; run them standalone to confirm.
