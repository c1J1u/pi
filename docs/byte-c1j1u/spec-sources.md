# Specification sources and support scope

Audit date: 2026-10-16. All documents fetched and read from the primary sources on that date.
This file records what Byte c1J1u implements, which specification each behavior follows,
and where product-specific boundaries apply.

## Layers

| Layer | Specification | Version / page | Source URL |
|---|---|---|---|
| Plugin packaging | Agent Plugins (referenced by OpenAI "Package your plugin") | schema 1.0.0 | https://agent-plugins.org/schemas/1.0.0/plugin.schema.json |
| Plugin MCP config | Agent Plugins mcp.json | schema 1.0.0 | https://agent-plugins.org/schemas/1.0.0/mcp.schema.json |
| OpenAI plugin overlay | OpenAI Codex docs, "Package your plugin" | accessed 2026-10-16 | https://developers.openai.com/codex/plugins/build/ |
| Agent Skills | Agent Skills open standard | accessed 2026-10-16 | https://agentskills.io/specification |
| OpenAI skill overlay | OpenAI Codex docs, "Build skills" (agents/openai.yaml, .agents/skills discovery) | accessed 2026-10-16 | https://developers.openai.com/codex/skills/ |
| MCP protocol | Model Context Protocol | 2025-11-25 (latest), 2025-06-18, 2025-03-26, 2024-11-05 (client negotiates; pi-mcp accepts all four) | https://modelcontextprotocol.io/specification/2025-06-18/basic |
| OpenAI MCP config | OpenAI Codex docs, "MCP" (config.toml `[mcp_servers.*]`) | accessed 2026-10-16 | https://developers.openai.com/codex/mcp/ |
| Hooks | OpenAI Codex docs, "Hooks" (events, matcher, input/output schema, trust) | accessed 2026-10-16 | https://developers.openai.com/codex/hooks/ |

## What the official documents actually specify (verified 2026-10-16)

### Plugin packaging (OpenAI "Package your plugin" + Agent Plugins 1.0.0)

- Portable manifest: root `plugin.json` with `$schema` of Agent Plugins, `name` (kebab-case, max 64,
  pattern `^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$`), optional `version`, `description`,
  `author{name,email,url}`, `homepage`, `repository`, `license`, `keywords`, `extensions` (namespace
  keyed, reverse-domain). Schema is `additionalProperties: false`; `$schema` and `name` required.
- Fixed package paths: `skills/` (auto-discovered, no manifest field needed), `mcp.json` (portable
  MCP config), `assets/`. OpenAI-specific data goes under `extensions["com.openai"]` in the root
  manifest: `apps`, `hooks`, `interface{...}`, `onboardingSkill`.
- Precedence: when `extensions.com.openai` is an object, it **replaces** the
  `.codex-plugin/plugin.json` overlay entirely (not merged). When absent, `.codex-plugin/plugin.json`
  is the compatibility fallback for OpenAI-specific settings. Root identity fields stay canonical.
- `.codex-plugin/plugin.json` layout from `@plugin-creator`: optional `hooks` (string | array |
  inline object), `apps` field pointing to `./.app.json`, `skills: "./skills/"`.
- Marketplace: JSON catalog at `$REPO_ROOT/.agents/plugins/marketplace.json` (repo) or
  `~/.agents/plugins/marketplace.json` (personal); legacy `.claude-plugin/marketplace.json` also
  read. Entries: `name`, `source` (`local` path `./...`, `git-subdir` with url/ref, `npm` package),
  `policy.installation` (AVAILABLE | INSTALLED_BY_DEFAULT | NOT_AVAILABLE),
  `policy.authentication` (ON_INSTALL | ON_FIRST_USE), `category`, `interface.displayName`.
- Install cache: `~/.codex/plugins/cache/$MARKETPLACE/$PLUGIN/$VERSION/`; local plugins use version
  `local`. Enable/disable per plugin via `[plugins."name@marketplace"]` in config.toml.
- Path rules: paths inside `extensions.com.openai` or compatibility manifests are `./`-prefixed,
  relative to plugin root, and must stay inside the plugin root. Hook env vars: `PLUGIN_ROOT`,
  `PLUGIN_DATA` (plus `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` compat).
- Portable `mcp.json`: `{"mcpServers": {name: {type: "stdio"|"streamable-http"|"sse", ...}}}` with
  strict per-type fields (stdio: command/args/env/cwd with containment patterns; http: url/headers).
  Plugin-provided Codex-style `.mcp.json` uses camelCase `oauth.clientId` etc.

### Agent Skills (agentskills.io) + OpenAI overlay

- Skill = directory with `SKILL.md` (YAML frontmatter + Markdown body). Required: `name`
  (max 64, lowercase alphanumeric + hyphens, no leading/trailing/double hyphen, **must match parent
  directory name**), `description` (max 1024, non-empty). Optional: `license`, `compatibility`
  (max 500), `metadata` (string->string map), `allowed-tools` (experimental).
- Optional directories: `scripts/`, `references/`, `assets/`. Relative file references from skill
  root. Progressive disclosure: metadata at startup, body on activation, resources on demand.
- OpenAI overlay `agents/openai.yaml`: `interface` (display_name, short_description, icons,
  brand_color, default_prompt), `policy.allow_implicit_invocation` (default true; false = explicit
  `$skill` invocation only), `dependencies.tools[]` (type/value/description/transport/url).
- Discovery scopes (Codex): `$CWD/.agents/skills`, ancestors up to repo root `$REPO_ROOT/.agents/skills`,
  user `~/.agents/skills`, admin `/etc/codex/skills`, SYSTEM bundled. Symlinked skill folders
  followed. Same-name skills are NOT merged; both appear in selectors. Skills list budget: 2% of
  context window or 8,000 chars default; `skills.max_context_tokens` up to 10,000.

### MCP protocol (pi-mcp client)

- Negotiated versions: 2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05.
- Implemented client-side: initialize + initialized, ping, tools/list (pagination), tools/call,
  resources/list, resources/templates/list, resources/read, notifications (progress, cancelled,
  message, tools/list_changed), roots/list inbound. Cancellation, progress tokens.
- Transports: stdio (newline-delimited JSON-RPC), Streamable HTTP (POST + optional GET SSE,
  Mcp-Session-Id, Last-Event-ID resume, 401/403 OAuth recovery, DELETE close). No legacy
  SSE-only transport (matches current spec direction; `type: "sse"` plugin entries are mapped
  where possible).
- Not implemented (documented boundary): prompts/*, sampling, elicitation, completions, logging,
  resources/subscribe.

### Hooks (OpenAI Codex)

- Events: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse,
  PreCompact, PostCompact, SubagentStart, SubagentStop, Stop, Interrupt.
- Sources: `hooks.json` + inline `[hooks]` in config layers; plugin-bundled hooks via manifest
  `hooks` field or default `hooks/hooks.json`. All matching hooks run; higher layers do not replace
  lower ones.
- Handler types: `command` (subprocess) and `mcp_tool` (call on connected server).
  `prompt`/`agent` parsed but skipped. Fields: `command`, `commandWindows`, `timeout` (seconds,
  default 600; SessionEnd/Interrupt 1s default, max 3s), `statusMessage`,
  `additionalContextLimit` (default ~2500 tokens; spill to
  `<temp>/hook_outputs/<session_id>/<uuid>.txt`), `async: true` (background, max 8 concurrent,
  results delivered at next safe point, cannot block).
- Trust: non-managed hooks require review; trust recorded against hook definition hash; changed
  hooks re-enter review. `--dangerously-bypass-hook-trust` exists for vetted automation.
- Matcher: regex on event-specific field (tool name, source, trigger, agent_type, reason);
  `*`/""/omitted = match all. UserPromptSubmit/Stop/Interrupt ignore matcher.
- Input (stdin JSON): session_id, transcript_path, cwd, hook_event_name, model, permission_mode,
  turn_id + event fields (source/reason, tool_name, tool_use_id, tool_input, tool_response,
  prompt, trigger, agent_id, agent_type, agent_transcript_path, stop_hook_active,
  last_assistant_message).
- Output contract: exit 0 + JSON. Common fields: continue, stopReason, systemMessage,
  suppressOutput. Event-specific: SessionStart/UserPromptSubmit/SubagentStart
  hookSpecificOutput.additionalContext; PreToolUse permissionDecision
  (allow+updatedInput | deny+permissionDecisionReason); PermissionRequest decision.behavior
  allow/deny(+message); PostToolUse decision: block + reason (replaces tool result, cannot undo
  side effects); Stop/SubagentStop decision: block + reason (continue with reason as new prompt).
  Exit code 2 = block/deny with stderr as reason. Plain text: SessionStart/UserPromptSubmit added
  as developer context; ignored for PreToolUse/PostToolUse; invalid for Stop/SubagentStop/Interrupt.
- Codemapping: nested tool calls from code mode run through the same hook path.

## Product-specific boundaries (explicitly NOT claimed)

- No ChatGPT built-in connectors, no universal plugin directory access, no OpenAI official
  marketplace listing, no sign-in-with-ChatGPT, no cloud Work sync. These require OpenAI products
  and accounts.
- Byte c1J1u implements format compatibility (parse/execute the public formats above) and
  behavioral compatibility (documented runtime semantics) for the surfaces Pi controls.
- `openai-decisions` classifier API and the OpenAI Decisions wire format are supported by
  pi-ai upstream; Byte c1J1u adds the Ark System One classifier transport (`ark-system-one`)
  per the internal One Pager (model doubao-seed-2-1-lite-260915, beta header
  `ark-beta-systemone-api: true`, POST /api/v1/systemone, 128K input window, noul/choice/score).
