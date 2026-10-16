/**
 * OpenAI Codex-compatible hooks types.
 *
 * Sources verified 2026-10-16 (see docs/byte-c1j1u/spec-sources.md):
 * - https://developers.openai.com/codex/hooks/ (events, matcher, input/output
 *   schema, trust model).
 *
 * A hooks config is `{description?, hooks: {[EventName]: [matcherGroup...]}}`;
 * a matcher group is `{matcher?, hooks: [handler...]}`. Handler types:
 * `command` (subprocess) and `mcp_tool` (call on a connected MCP server).
 * `prompt`/`agent` handlers parse but never execute.
 */

// ============================================================================
// Config format
// ============================================================================

/** The 12 hook events. */
export type HookEventName =
	| "SessionStart"
	| "SessionEnd"
	| "UserPromptSubmit"
	| "PreToolUse"
	| "PermissionRequest"
	| "PostToolUse"
	| "PreCompact"
	| "PostCompact"
	| "SubagentStart"
	| "SubagentStop"
	| "Stop"
	| "Interrupt";

export const HOOK_EVENT_NAMES: readonly HookEventName[] = [
	"SessionStart",
	"SessionEnd",
	"UserPromptSubmit",
	"PreToolUse",
	"PermissionRequest",
	"PostToolUse",
	"PreCompact",
	"PostCompact",
	"SubagentStart",
	"SubagentStop",
	"Stop",
	"Interrupt",
];

/** Handler kinds that parse but never execute. */
export type HookSkippedHandlerType = "prompt" | "agent";

/** Subprocess handler. `command` runs in the session cwd; `commandWindows` on Windows only. */
export interface CommandHookHandler {
	type: "command";
	command: string;
	commandWindows?: string;
	/** Timeout in seconds. Default 600; SessionEnd/Interrupt default 1s (max 3s). */
	timeout?: number;
	statusMessage?: string;
	/** additionalContext token budget. Default ~2500 tokens (4 chars/token estimate). */
	additionalContextLimit?: number;
	/** Run in the background; results cannot block. Max 8 concurrent. */
	async?: boolean;
}

/** MCP tool handler. `input` supports `${field.nested}` interpolation from the event. */
export interface McpToolHookHandler {
	type: "mcp_tool";
	server: string;
	tool: string;
	input?: unknown;
	/** Timeout in seconds. Default 600; SessionEnd/Interrupt default 1s (max 3s). */
	timeout?: number;
	statusMessage?: string;
}

export type HookHandler = CommandHookHandler | McpToolHookHandler;

/** Parsed-but-skipped handler (`prompt`/`agent` types produce diagnostics, never execute). */
export interface SkippedHookHandler {
	type: HookSkippedHandlerType;
}

/** A matcher group: handlers run when the event's matcher field matches the regex. */
export interface HookMatcherGroup {
	/** Regex on the event's matcher field; "*", "", or omitted = match all. */
	matcher?: string;
	hooks: Array<HookHandler | SkippedHookHandler>;
}

/** hooks.json shape. */
export interface HooksFileConfig {
	description?: string;
	hooks: Partial<Record<HookEventName, HookMatcherGroup[]>>;
}

/** A handler as parsed from config, with validation status and provenance. */
export interface ParsedHookHandler {
	/** Valid command/mcp_tool handlers, or the original skipped type. */
	handler: HookHandler | SkippedHookHandler;
	/** Index within its matcher group. */
	index: number;
	/** sha256 of the handler's canonical JSON. Empty for skipped handlers. */
	hash: string;
	/** True for plugin-sourced hooks (untrusted by default). */
	fromPlugin: boolean;
	/** Config file the handler came from. */
	sourcePath: string;
}

/** A parsed matcher group. */
export interface ParsedHookMatcherGroup {
	matcher: string | undefined;
	/** Compiled matcher; undefined for match-all or invalid patterns. */
	regex: RegExp | undefined;
	/** Invalid matcher pattern diagnostic, when compilation fails. */
	matcherError: string | undefined;
	handlers: ParsedHookHandler[];
}

export interface ParsedHooksConfig {
	/** Valid handlers per event. */
	events: Partial<Record<HookEventName, ParsedHookMatcherGroup[]>>;
	/** All handlers (valid and skipped) for trust listing. */
	handlers: ParsedHookHandler[];
	diagnostics: HookDiagnostic[];
}

export interface HookDiagnostic {
	type: "info" | "warning" | "error";
	message: string;
}

// ============================================================================
// Hook input (stdin JSON)
// ============================================================================

export type HookPermissionMode = "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions";

/** Event-specific payload fields, keyed by event name. */
export interface HookEventPayloads {
	SessionStart: { source: "startup" | "resume" | "clear" | "compact" | "fork" };
	SessionEnd: { reason: string };
	UserPromptSubmit: { prompt: string };
	PreToolUse: {
		tool_name: string;
		tool_use_id?: string;
		tool_input: Record<string, unknown>;
	};
	PermissionRequest: {
		tool_name: string;
		tool_input: Record<string, unknown>;
	};
	PostToolUse: {
		tool_name: string;
		tool_use_id?: string;
		tool_input: Record<string, unknown>;
		tool_response: unknown;
	};
	PreCompact: { trigger: "manual" | "auto" };
	PostCompact: { trigger: "manual" | "auto" };
	SubagentStart: {
		agent_id: string;
		agent_type: string;
	};
	SubagentStop: {
		agent_id: string;
		agent_type: string;
		agent_transcript_path?: string;
		stop_hook_active?: boolean;
		last_assistant_message?: string;
	};
	Stop: {
		stop_hook_active?: boolean;
		last_assistant_message?: string;
	};
	Interrupt: { turn_id: string };
}

/** Full stdin JSON object a hook process receives. */
export type HookInput<E extends HookEventName = HookEventName> = {
	session_id: string;
	transcript_path: string;
	cwd: string;
	hook_event_name: E;
	model?: string;
} & (E extends keyof HookEventPayloads
	? { permission_mode?: HookPermissionMode }
	: { permission_mode?: HookPermissionMode }) &
	(E extends "SessionEnd" | "PreCompact" | "PostCompact" ? object : { turn_id?: string }) &
	HookEventPayloads[E];

// ============================================================================
// Hook output (stdout contract)
// ============================================================================

/** `hookSpecificOutput` per event. */
export interface HookSpecificOutputs {
	SessionStart: { additionalContext?: string };
	UserPromptSubmit: { additionalContext?: string };
	SubagentStart: { additionalContext?: string };
	PreToolUse: {
		permissionDecision?: "allow" | "deny";
		permissionDecisionReason?: string;
		updatedInput?: Record<string, unknown>;
	};
	PermissionRequest: {
		decision?: { behavior?: "allow" | "deny"; message?: string };
	};
	PostToolUse: {
		additionalContext?: string;
		decision?: { decision?: string; reason?: string };
	};
	Stop: {
		decision?: "block" | string;
		reason?: string;
	};
	SubagentStop: {
		decision?: "block" | string;
		reason?: string;
	};
}

/** Union of all hookSpecificOutput shapes. */
export type AnyHookSpecificOutput =
	| HookSpecificOutputs["SessionStart"]
	| HookSpecificOutputs["UserPromptSubmit"]
	| HookSpecificOutputs["SubagentStart"]
	| HookSpecificOutputs["PreToolUse"]
	| HookSpecificOutputs["PermissionRequest"]
	| HookSpecificOutputs["PostToolUse"]
	| HookSpecificOutputs["Stop"]
	| HookSpecificOutputs["SubagentStop"];

/** JSON an exit-0 hook may print on stdout. Unknown fields for the event fail the hook. */
export interface HookJsonOutput {
	continue?: boolean;
	stopReason?: string;
	systemMessage?: string;
	suppressOutput?: boolean;
	hookSpecificOutput?: AnyHookSpecificOutput;
	/** Stop/SubagentStop top-level form. */
	decision?: "block" | string;
	reason?: string;
}

// ============================================================================
// Runner
// ============================================================================

/** Injected MCP tool caller for `mcp_tool` handlers. */
export type CallMcpToolFn = (
	server: string,
	tool: string,
	args: unknown,
	options?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<unknown>;

export interface HookEmitOptions {
	/** Working directory for handler commands; part of the stdin payload. */
	cwd: string;
	/** Session id; part of the stdin payload. */
	session_id: string;
	/** Session transcript file; part of the stdin payload. */
	transcript_path?: string;
	/** Current model id; part of the stdin payload. */
	model?: string;
	/** Permission mode for the events that carry it. */
	permission_mode?: HookPermissionMode;
	/** Turn id for turn-level events. */
	turn_id?: string;
	/** Abort emission; running handlers get SIGTERM. */
	signal?: AbortSignal;
	/** MCP tool caller for `mcp_tool` handlers. */
	callMcpTool?: CallMcpToolFn;
	/**
	 * Extra environment for handler processes (merged over process.env). Receives the
	 * executing handler's definition hash so plugin-sourced handlers can resolve their
	 * PLUGIN_ROOT/PLUGIN_DATA.
	 */
	getEnv?: (handlerHash?: string) => Record<string, string | undefined>;
	/** Spill directory override. Defaults to `<tmpdir>/hook_outputs`. */
	outputDir?: string;
}

/** Result of one handler execution. */
export interface HookHandlerResult {
	/** Handler identity (hash empty for skipped handlers). */
	hash: string;
	/** "command" or "mcp_tool". */
	type: "command" | "mcp_tool" | "skipped";
	/** Command string, server/tool, or skipped type. */
	label: string;
	status: "success" | "denied" | "blocked" | "failed" | "skipped" | "timeout";
	/** Exit-code-2 stderr or deny reason. */
	reason?: string;
	/** User-facing message from JSON `systemMessage`. */
	systemMessage?: string;
	stopReason?: string;
	suppressOutput?: boolean;
	/** additionalContext (already spill-trimmed). */
	additionalContext?: string;
	/** PreToolUse decision. */
	permissionDecision?: "allow" | "deny";
	permissionDecisionReason?: string;
	/** PreToolUse allow with patched input. */
	updatedInput?: Record<string, unknown>;
	/** PermissionRequest decision. */
	decisionBehavior?: "allow" | "deny";
	decisionMessage?: string;
	/** Stop/SubagentStop block decision; the reason continues the run as a new prompt. */
	blockReason?: string;
	/** continue:false from JSON output. */
	stopRequested?: boolean;
	/** Plain-text stdout for events where it is invalid (recorded as a diagnostic). */
	ignoredPlainText?: string;
	/** Spill file written for over-limit additionalContext. */
	spillFile?: string;
	/** Execution diagnostics (unknown fields, invalid output, etc.). */
	diagnostics: string[];
}

/** Aggregated result of emitting one event. */
export interface HookEmitResult {
	event: HookEventName;
	/** False when any matching handler denied or blocked, or set continue:false. */
	continue: boolean;
	/** Deny/block reason (exit 2 stderr, deny decision reason, or stopReason). */
	reason?: string;
	/** Merged systemMessage values, newline-joined. */
	systemMessage?: string;
	suppressOutput?: boolean;
	/** Merged additionalContext (SessionStart/UserPromptSubmit/SubagentStart/PostToolUse). */
	additionalContext?: string;
	/** PreToolUse aggregated decision. */
	permissionDecision?: "allow" | "deny";
	permissionDecisionReason?: string;
	updatedInput?: Record<string, unknown>;
	/** PermissionRequest aggregated decision. */
	decisionBehavior?: "allow" | "deny";
	decisionMessage?: string;
	/** Stop/SubagentStop block reason; the run continues with it as a new prompt. */
	blockReason?: string;
	results: HookHandlerResult[];
	diagnostics: string[];
	/** Promise resolving when all async handlers have settled. */
	asyncSettled: Promise<HookHandlerResult[]>;
}
