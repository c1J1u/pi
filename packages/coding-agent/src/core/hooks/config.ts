/**
 * hooks.json parsing and matcher evaluation.
 *
 * Sources verified 2026-10-16 (see docs/byte-c1j1u/spec-sources.md):
 * - https://developers.openai.com/codex/hooks/ (config format, matcher
 *   semantics, prompt/agent handlers being parsed but skipped).
 *
 * Format: `{description?, hooks: {<EventName>: [matcherGroup...]}}` where a
 * matcher group is `{matcher?: string, hooks: [handler...]}`. Unknown events
 * and unknown handler fields produce diagnostics. Matchers are regexes on the
 * event's matcher field (tool name, source, reason, trigger, agent_type);
 * "*", "", and omitted match everything. UserPromptSubmit/Stop/Interrupt
 * ignore matchers.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripBom } from "../../utils/text.ts";
import { computeHookHandlerHash } from "./trust.ts";
import type {
	HookDiagnostic,
	HookEventName,
	HookHandler,
	HookMatcherGroup,
	HooksFileConfig,
	ParsedHookHandler,
	ParsedHookMatcherGroup,
	ParsedHooksConfig,
	SkippedHookHandler,
} from "./types.ts";
import { HOOK_EVENT_NAMES } from "./types.ts";

export function isHookEventName(value: string): value is HookEventName {
	return (HOOK_EVENT_NAMES as readonly string[]).includes(value);
}

/** Events whose matcher is a no-op: every handler runs. */
export function eventIgnoresMatcher(event: HookEventName): boolean {
	return event === "UserPromptSubmit" || event === "Stop" || event === "Interrupt";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const COMMAND_HANDLER_FIELDS = new Set([
	"type",
	"command",
	"commandWindows",
	"timeout",
	"statusMessage",
	"additionalContextLimit",
	"async",
]);
const MCP_TOOL_HANDLER_FIELDS = new Set(["type", "server", "tool", "input", "timeout", "statusMessage"]);
const MATCHER_GROUP_FIELDS = new Set(["matcher", "hooks"]);
const TOP_LEVEL_FIELDS = new Set(["description", "hooks", "$schema"]);

function parseHandler(
	value: unknown,
	index: number,
	sourcePath: string,
	fromPlugin: boolean,
	diagnostics: HookDiagnostic[],
): ParsedHookHandler | undefined {
	const where = `${sourcePath}: hooks handler #${index + 1}`;
	if (!isRecord(value)) {
		diagnostics.push({ type: "error", message: `${where}: must be an object` });
		return undefined;
	}
	const type = value.type;
	if (type === "prompt" || type === "agent") {
		for (const key of Object.keys(value)) {
			if (key !== "type") {
				diagnostics.push({ type: "warning", message: `${where}: unknown field "${key}" on ${type} handler` });
			}
		}
		diagnostics.push({
			type: "info",
			message: `${where}: ${type} handlers are parsed but not executed`,
		});
		const handler: SkippedHookHandler = { type };
		return { handler, index, hash: "", fromPlugin, sourcePath };
	}
	if (type === "command") {
		const unknown = Object.keys(value).filter((key) => !COMMAND_HANDLER_FIELDS.has(key));
		for (const key of unknown) {
			diagnostics.push({ type: "warning", message: `${where}: unknown field "${key}"` });
		}
		if (typeof value.command !== "string" || value.command.length === 0) {
			diagnostics.push({ type: "error", message: `${where}: command handlers require a non-empty command` });
			return undefined;
		}
		const handler: HookHandler = { type: "command", command: value.command };
		if (typeof value.commandWindows === "string" && value.commandWindows.length > 0) {
			handler.commandWindows = value.commandWindows;
		}
		if (typeof value.timeout === "number" && Number.isFinite(value.timeout) && value.timeout > 0) {
			handler.timeout = value.timeout;
		} else if (value.timeout !== undefined) {
			diagnostics.push({ type: "warning", message: `${where}: timeout must be a positive number (seconds)` });
		}
		if (typeof value.statusMessage === "string") handler.statusMessage = value.statusMessage;
		if (typeof value.additionalContextLimit === "number" && Number.isFinite(value.additionalContextLimit)) {
			handler.additionalContextLimit = value.additionalContextLimit;
		} else if (value.additionalContextLimit !== undefined) {
			diagnostics.push({ type: "warning", message: `${where}: additionalContextLimit must be a number` });
		}
		if (value.async === true) handler.async = true;
		return { handler, index, hash: computeHookHandlerHash(handler), fromPlugin, sourcePath };
	}
	if (type === "mcp_tool") {
		const unknown = Object.keys(value).filter((key) => !MCP_TOOL_HANDLER_FIELDS.has(key));
		for (const key of unknown) {
			diagnostics.push({ type: "warning", message: `${where}: unknown field "${key}"` });
		}
		if (typeof value.server !== "string" || value.server.length === 0) {
			diagnostics.push({ type: "error", message: `${where}: mcp_tool handlers require a non-empty server` });
			return undefined;
		}
		if (typeof value.tool !== "string" || value.tool.length === 0) {
			diagnostics.push({ type: "error", message: `${where}: mcp_tool handlers require a non-empty tool` });
			return undefined;
		}
		const handler: HookHandler = { type: "mcp_tool", server: value.server, tool: value.tool };
		if (value.input !== undefined) handler.input = value.input;
		if (typeof value.timeout === "number" && Number.isFinite(value.timeout) && value.timeout > 0) {
			handler.timeout = value.timeout;
		} else if (value.timeout !== undefined) {
			diagnostics.push({ type: "warning", message: `${where}: timeout must be a positive number (seconds)` });
		}
		if (typeof value.statusMessage === "string") handler.statusMessage = value.statusMessage;
		return { handler, index, hash: computeHookHandlerHash(handler), fromPlugin, sourcePath };
	}
	diagnostics.push({
		type: "error",
		message: `${where}: unsupported handler type ${JSON.stringify(type ?? null)} (expected command or mcp_tool)`,
	});
	return undefined;
}

function parseMatcherGroup(
	value: unknown,
	event: HookEventName,
	sourcePath: string,
	fromPlugin: boolean,
	diagnostics: HookDiagnostic[],
): ParsedHookMatcherGroup | undefined {
	const where = `${sourcePath}: ${event} matcher group`;
	if (!isRecord(value)) {
		diagnostics.push({ type: "error", message: `${where}: must be an object` });
		return undefined;
	}
	for (const key of Object.keys(value)) {
		if (!MATCHER_GROUP_FIELDS.has(key)) {
			diagnostics.push({ type: "warning", message: `${where}: unknown field "${key}"` });
		}
	}
	let matcher: string | undefined;
	if (value.matcher !== undefined) {
		if (typeof value.matcher !== "string") {
			diagnostics.push({ type: "error", message: `${where}: matcher must be a string (regex)` });
			return undefined;
		}
		matcher = value.matcher;
	}
	if (!Array.isArray(value.hooks)) {
		diagnostics.push({ type: "error", message: `${where}: hooks must be an array` });
		return undefined;
	}
	const handlers: ParsedHookHandler[] = [];
	value.hooks.forEach((rawHandler, index) => {
		const parsed = parseHandler(rawHandler, index, sourcePath, fromPlugin, diagnostics);
		if (parsed) handlers.push(parsed);
	});
	let regex: RegExp | undefined;
	let matcherError: string | undefined;
	if (matcher !== undefined && matcher !== "*" && matcher !== "") {
		try {
			regex = new RegExp(matcher);
		} catch (error) {
			matcherError = error instanceof Error ? error.message : String(error);
			diagnostics.push({ type: "error", message: `${where}: invalid matcher regex: ${matcherError}` });
		}
	}
	return { matcher, regex, matcherError, handlers };
}

/**
 * Parse a hooks config value. `sourcePath` labels diagnostics; `fromPlugin`
 * marks handlers as plugin-sourced (untrusted by default).
 */
export function parseHooksConfig(
	value: unknown,
	sourcePath: string,
	options?: { fromPlugin?: boolean },
): ParsedHooksConfig {
	const fromPlugin = options?.fromPlugin ?? false;
	const diagnostics: HookDiagnostic[] = [];
	const events: Partial<Record<HookEventName, ParsedHookMatcherGroup[]>> = {};
	const handlers: ParsedHookHandler[] = [];
	if (!isRecord(value)) {
		diagnostics.push({ type: "error", message: `${sourcePath}: hooks config must be a JSON object` });
		return { events, handlers, diagnostics };
	}
	for (const key of Object.keys(value)) {
		if (!TOP_LEVEL_FIELDS.has(key)) {
			diagnostics.push({ type: "warning", message: `${sourcePath}: unknown field "${key}"` });
		}
	}
	const hooksValue = value.hooks;
	if (!isRecord(hooksValue)) {
		diagnostics.push({ type: "error", message: `${sourcePath}: missing or invalid "hooks" object` });
		return { events, handlers, diagnostics };
	}
	for (const [event, groups] of Object.entries(hooksValue)) {
		if (!isHookEventName(event)) {
			diagnostics.push({ type: "error", message: `${sourcePath}: unknown hook event "${event}"` });
			continue;
		}
		if (!Array.isArray(groups)) {
			diagnostics.push({ type: "error", message: `${sourcePath}: ${event} must be an array of matcher groups` });
			continue;
		}
		const parsedGroups: ParsedHookMatcherGroup[] = [];
		for (const group of groups) {
			const parsed = parseMatcherGroup(group, event, sourcePath, fromPlugin, diagnostics);
			if (parsed) {
				parsedGroups.push(parsed);
				handlers.push(...parsed.handlers);
			}
		}
		events[event] = parsedGroups;
	}
	return { events, handlers, diagnostics };
}

/** Read and parse a hooks.json file. Returns undefined when the file does not exist. */
export function readHooksFile(filePath: string, options?: { fromPlugin?: boolean }): ParsedHooksConfig | undefined {
	if (!existsSync(filePath)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(readFileSync(filePath, "utf8")));
	} catch (error) {
		return {
			events: {},
			handlers: [],
			diagnostics: [
				{ type: "error", message: `${filePath}: ${error instanceof Error ? error.message : String(error)}` },
			],
		};
	}
	return parseHooksConfig(parsed, filePath, options);
}

/** Read `<dir>/hooks.json`. */
export function readHooksConfigFromDir(dir: string, options?: { fromPlugin?: boolean }): ParsedHooksConfig | undefined {
	return readHooksFile(join(dir, "hooks.json"), options);
}

/**
 * The matcher field value for an event: tool name, source, reason, trigger, or
 * agent_type. apply_patch matches Edit/Write aliases. Returns undefined for
 * events that ignore matchers.
 */
export function matcherFieldValue(event: HookEventName, payload: Record<string, unknown>): string | undefined {
	switch (event) {
		case "PreToolUse":
		case "PostToolUse":
		case "PermissionRequest": {
			const toolName = payload.tool_name;
			return typeof toolName === "string" ? toolName : undefined;
		}
		case "SessionStart":
			return typeof payload.source === "string" ? payload.source : undefined;
		case "SessionEnd":
			return typeof payload.reason === "string" ? payload.reason : undefined;
		case "PreCompact":
		case "PostCompact":
			return typeof payload.trigger === "string" ? payload.trigger : undefined;
		case "SubagentStart":
		case "SubagentStop":
			return typeof payload.agent_type === "string" ? payload.agent_type : undefined;
		default:
			return undefined;
	}
}

/** tool_name matcher aliases: apply_patch matches Edit and Write. */
export function toolNameMatchesPattern(toolName: string, pattern: RegExp): boolean {
	if (pattern.test(toolName)) return true;
	if (toolName === "apply_patch" && (pattern.test("Edit") || pattern.test("Write"))) return true;
	if ((toolName === "Edit" || toolName === "Write") && pattern.test("apply_patch")) return true;
	return false;
}

/** Whether a parsed matcher group matches the event payload. */
export function matcherGroupMatches(
	event: HookEventName,
	group: ParsedHookMatcherGroup,
	payload: Record<string, unknown>,
): boolean {
	if (eventIgnoresMatcher(event)) return true;
	if (group.matcher === undefined || group.matcher === "*" || group.matcher === "") return true;
	if (group.regex === undefined) return false;
	const value = matcherFieldValue(event, payload);
	if (value === undefined) return false;
	if (event === "PreToolUse" || event === "PostToolUse" || event === "PermissionRequest") {
		return toolNameMatchesPattern(value, group.regex);
	}
	return group.regex.test(value);
}

/** Convenience for raw config objects (tests, plugin inline hooks). */
export function matchRawMatcher(event: HookEventName, matcher: string | undefined, value: string | undefined): boolean {
	if (eventIgnoresMatcher(event)) return true;
	if (matcher === undefined || matcher === "*" || matcher === "") return true;
	if (value === undefined) return false;
	let regex: RegExp;
	try {
		regex = new RegExp(matcher);
	} catch {
		return false;
	}
	if (event === "PreToolUse" || event === "PostToolUse" || event === "PermissionRequest") {
		return toolNameMatchesPattern(value, regex);
	}
	return regex.test(value);
}

/** Type guard for a raw hooks config object (hooks.json shape). */
export function isHooksFileConfig(value: unknown): value is HooksFileConfig {
	if (!isRecord(value)) return false;
	if (!isRecord(value.hooks)) return false;
	return Object.keys(value).every((key) => TOP_LEVEL_FIELDS.has(key));
}

/** Narrow a raw matcher group for typed access. */
export function asHookMatcherGroup(value: unknown): HookMatcherGroup | undefined {
	if (!isRecord(value) || !Array.isArray(value.hooks)) return undefined;
	const group: HookMatcherGroup = { hooks: value.hooks as HookMatcherGroup["hooks"] };
	if (typeof value.matcher === "string") group.matcher = value.matcher;
	return group;
}
