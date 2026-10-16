# Byte c1J1u — developing plugins, skills, MCP servers, and hooks

Practical guide for authoring compatible capabilities. Formats follow the specifications
audited in [spec-sources.md](./spec-sources.md) (accessed 2026-10-16); when this guide and
the spec differ, the spec wins.

## Layout

Capabilities load from these locations:

| Capability | User scope | Project scope |
|---|---|---|
| Marketplace | `~/.agents/plugins/marketplace.json` | `$REPO/.agents/plugins/marketplace.json` |
| Plugin cache | `~/.pi/agent/plugins/cache/$MARKET/$PLUGIN/$VERSION/` | same cache, per-user |
| Skills (Codex scopes) | `~/.agents/skills` | `$CWD/.agents/skills` up to repo root |
| Skills (Pi scopes) | `~/.pi/agent/skills` | `$CWD/.pi/skills` |
| Hooks | `~/.pi/agent/hooks.json` | `$CWD/.codex/hooks.json` |
| MCP | `~/.pi/agent/mcp.json` | `$CWD/.pi/mcp.json` (trusted projects) |

## Plugins

Minimal portable plugin (Agent Plugins 1.0.0):

```
my-plugin/
  plugin.json          # required
  skills/hello/SKILL.md
  mcp.json             # optional, portable MCP config
  hooks/hooks.json     # optional
  assets/
```

`plugin.json`:

```json
{
	"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
	"name": "my-plugin",
	"version": "1.0.0",
	"description": "Reusable greeting workflow"
}
```

OpenAI-specific settings go under `extensions["com.openai"]` in the root manifest — this
object **replaces** a `.codex-plugin/plugin.json` overlay when present (official
replacement semantics; they are never merged):

```json
{
	"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
	"name": "my-plugin",
	"version": "0.1.0",
	"extensions": {
		"com.openai": {
			"hooks": "./hooks/hooks.json",
			"interface": { "displayName": "My Plugin" }
		}
	}
}
```

`.codex-plugin/plugin.json` remains supported as the fallback when the extension object is
absent. Paths inside `extensions.com.openai` must be `./`-prefixed and stay inside the
plugin root.

Install from a marketplace:

```bash
# .agents/plugins/marketplace.json
{
	"name": "local-repo",
	"plugins": [
		{
			"name": "my-plugin",
			"source": { "source": "local", "path": "./plugins/my-plugin" },
			"policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
			"category": "Productivity"
		}
	]
}
```

```
/plugins list
/plugins install my-plugin
/plugins enable my-plugin     # restart to load
/plugins uninstall my-plugin
```

Enabling a plugin loads its skills and records its MCP servers; hook execution still
requires trust review, and MCP connections still require authentication — install ≠
trust ≠ auth.

## Skills

`SKILL.md` with agentskills.io frontmatter:

```markdown
---
name: pdf-processing
description: Extract PDF text, fill forms, merge files. Use when handling PDFs.
license: Apache-2.0
compatibility: Requires Python 3.14+ and uv
metadata:
  author: example-org
  version: "1.0"
allowed-tools: Bash(jq:*) Read
---

Instructions here. Reference files with relative paths.
```

Rules enforced: name ≤64 chars lowercase/digits/hyphens (must match the directory name),
description ≤1024 chars required. Optional `agents/openai.yaml` overlay:

```yaml
policy:
  allow_implicit_invocation: false   # explicit-only: System One never auto-selects it
dependencies:
  tools:
    - type: "mcp"
      value: "my-server"
      transport: "streamable_http"
      url: "https://example.com/mcp"
```

## MCP servers

Portable `mcp.json` (in a plugin):

```json
{
	"$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
	"mcpServers": {
		"docs": { "type": "streamable-http", "url": "https://example.com/mcp" },
		"local": { "type": "stdio", "command": "node", "args": ["server.js"], "cwd": "./" }
	}
}
```

Reserved env keys (`PLUGIN_ROOT`, `PLUGIN_DATA`) are rejected in declarations — the host
injects them. Codex-style `.mcp.json` (camelCase oauth, type inference) is read when
`mcp.json` is absent. Standalone servers still use Pi's `mcp.json` at
`~/.pi/agent/mcp.json` / `.pi/mcp.json` with stdio and streamable-http transports, OAuth,
and exposure control — see [Pi's MCP docs](../packages/coding-agent/docs/mcp.md).

## Hooks

`hooks.json` (user or project scope, or plugin-bundled):

```json
{
	"hooks": {
		"PreToolUse": [
			{
				"matcher": "Bash",
				"hooks": [
					{
						"type": "command",
						"command": "/usr/bin/python3 \"$REPO/.codex/hooks/policy.py\"",
						"timeout": 30,
						"statusMessage": "Checking Bash command"
					}
				]
			}
		]
	}
}
```

- Events: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PermissionRequest,
  PostToolUse, PreCompact, PostCompact, SubagentStart, SubagentStop, Stop, Interrupt.
- Handlers: `command` (subprocess) and `mcp_tool` (tool call on a connected server).
- Input arrives as one JSON object on stdin; output contract: exit 0 + JSON (or plain
  text where documented), exit 2 = block/deny with stderr as the reason.
- Every handler runs only after you trust its exact definition (hash); `/hooks` lists
  review state. Plugin hooks are never auto-trusted.
- Timeouts: 600s default; SessionEnd/Interrupt 1s default (3s max). `async: true` runs in
  the background (max 8 concurrent) and cannot block.
- `additionalContext` over ~2500 tokens spills to disk with a preview + file path.

Event mapping onto Pi boundaries: PreToolUse fires inside `tool_call` before side effects
(deny blocks); PostToolUse in `tool_result` (cannot undo); Stop at the settle boundary
(`agent_before_settle`), not every turn; SessionStart/End at session lifecycle.

## System One decision points

With `ARK_API_KEY` set, decisions run at: new-goal model routing
(`byte-c1j1u/auto`), skill selection advice (implicit-allowed candidates only),
evidence filtering of large tool outputs, verification coverage at stop, and subtask
delegation advice. Every decision has a deterministic fallback; no decision can widen
authorization or skip mandatory hooks. Decision records (sanitized: digests only) are
queryable via the service's audit log and surface in `/byte-c1j1u`.
