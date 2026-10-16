/**
 * Hook runner: dispatches events to matching handlers and applies the Codex
 * hooks input/output contract.
 *
 * Sources verified 2026-10-16 (see docs/byte-c1j1u/spec-sources.md):
 * - https://developers.openai.com/codex/hooks/ (events, input JSON, output
 *   JSON, exit code 2, plain-text rules, timeouts, async, additionalContext
 *   spill, trust model).
 *
 * Contract summary:
 * - exit 0, no output: success, continue.
 * - exit 0 + JSON: continue/stopReason/systemMessage/suppressOutput plus
 *   event-specific hookSpecificOutput. Unsupported fields for the event fail
 *   the hook; the operation continues.
 * - exit 2: block/deny, stderr is the reason.
 * - Plain text on stdout: additional developer context for
 *   SessionStart/UserPromptSubmit (SubagentStart follows the same shape),
 *   ignored for PreToolUse/PostToolUse, a diagnostic for
 *   Stop/SubagentStop/Interrupt.
 * - Stop/SubagentStop `decision: "block"` + reason keeps the run going with
 *   the reason as a new prompt.
 * - additionalContext over ~2500 tokens (4 chars/token) spills to
 *   `<tmp>/hook_outputs/<session_id>/<uuid>.txt` with a head/tail preview.
 * - Timeouts: default 600s; SessionEnd/Interrupt default 1s, capped at 3s.
 * - async:true handlers run in the background (max 8 concurrent) and cannot
 *   block the emission result.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForChildProcess } from "../../utils/child-process.ts";
import { matcherGroupMatches } from "./config.ts";
import type { HookTrustStore } from "./trust.ts";
import type {
	HookDiagnostic,
	HookEmitOptions,
	HookEmitResult,
	HookEventName,
	HookHandlerResult,
	HookJsonOutput,
	ParsedHookHandler,
	ParsedHooksConfig,
} from "./types.ts";

/** Default handler timeout in seconds. */
export const DEFAULT_HOOK_TIMEOUT_S = 600;
/** SessionEnd/Interrupt default timeout in seconds. */
export const FAST_HOOK_TIMEOUT_S = 1;
/** SessionEnd/Interrupt maximum timeout in seconds. */
export const FAST_HOOK_TIMEOUT_MAX_S = 3;
/** Default additionalContext budget, estimated at 4 chars per token. */
export const DEFAULT_ADDITIONAL_CONTEXT_TOKENS = 2500;
export const CHARS_PER_TOKEN = 4;
/** Preview head and tail sizes for spilled context. */
export const SPILL_PREVIEW_CHARS = 200;
/** Maximum concurrently running async handlers. */
export const MAX_ASYNC_CONCURRENCY = 8;

const PLAIN_TEXT_CONTEXT_EVENTS: ReadonlySet<string> = new Set(["SessionStart", "UserPromptSubmit", "SubagentStart"]);
const PLAIN_TEXT_INVALID_EVENTS: ReadonlySet<string> = new Set(["Stop", "SubagentStop", "Interrupt"]);
const EVENTS_WITH_PERMISSION_MODE: ReadonlySet<string> = new Set([
	"SessionStart",
	"PreToolUse",
	"PermissionRequest",
	"PostToolUse",
	"UserPromptSubmit",
	"SubagentStart",
	"SubagentStop",
	"Stop",
	"Interrupt",
]);
const EVENTS_WITH_TURN_ID: ReadonlySet<string> = new Set([
	"UserPromptSubmit",
	"PreToolUse",
	"PermissionRequest",
	"PostToolUse",
	"SubagentStart",
	"SubagentStop",
	"Stop",
	"Interrupt",
]);

function allowedJsonFields(event: HookEventName): Set<string> {
	const common = ["continue", "stopReason", "systemMessage", "suppressOutput", "hookSpecificOutput"];
	switch (event) {
		case "Stop":
		case "SubagentStop":
			return new Set([...common, "decision", "reason"]);
		// Tool-flow events express block/deny through their event-specific
		// decision fields; the common continue/stopReason pair is unsupported
		// for them (spec example: continue:false on PreToolUse fails the hook).
		case "PreToolUse":
		case "PermissionRequest":
		case "PostToolUse":
			return new Set(["systemMessage", "suppressOutput", "hookSpecificOutput"]);
		default:
			return new Set(common);
	}
}

function allowedHookSpecificFields(event: HookEventName): Set<string> {
	switch (event) {
		case "SessionStart":
		case "UserPromptSubmit":
		case "SubagentStart":
		case "PostToolUse":
			return new Set(["additionalContext"]);
		case "PreToolUse":
			return new Set(["permissionDecision", "permissionDecisionReason", "updatedInput"]);
		case "PermissionRequest":
			return new Set(["decision"]);
		default:
			return new Set();
	}
}

/** Per-event timeout in milliseconds after applying the documented defaults and caps. */
export function effectiveTimeoutMs(event: HookEventName, timeoutS: number | undefined): number {
	const isFast = event === "SessionEnd" || event === "Interrupt";
	if (isFast) {
		const seconds = Math.min(timeoutS ?? FAST_HOOK_TIMEOUT_S, FAST_HOOK_TIMEOUT_MAX_S);
		return Math.max(seconds, FAST_HOOK_TIMEOUT_S) * 1000;
	}
	return Math.max(timeoutS ?? DEFAULT_HOOK_TIMEOUT_S, 0.001) * 1000;
}

/** Expand `${field.nested}` placeholders in an mcp_tool input template. */
export function expandMcpToolInput(template: unknown, input: Record<string, unknown>): unknown {
	return expandValue(template, input);
}

function expandValue(value: unknown, input: Record<string, unknown>): unknown {
	if (typeof value === "string") {
		if (value.startsWith("${") && value.endsWith("}") && !value.slice(2, -1).includes("${")) {
			// Whole-value placeholder: preserve the JSON type of the referenced value.
			const resolved = resolveFieldPath(value.slice(2, -1), input);
			if (resolved !== undefined) return resolved;
		}
		return interpolateString(value, input);
	}
	if (Array.isArray(value)) return value.map((item) => expandValue(item, input));
	if (typeof value === "object" && value !== null) {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			result[key] = expandValue(item, input);
		}
		return result;
	}
	return value;
}

function interpolateString(text: string, input: Record<string, unknown>): string {
	return text.replace(/\$\{([^}]+)\}/g, (whole, path: string) => {
		const resolved = resolveFieldPath(path.trim(), input);
		if (resolved === undefined) return whole;
		if (typeof resolved === "string") return resolved;
		return JSON.stringify(resolved);
	});
}

function resolveFieldPath(path: string, input: Record<string, unknown>): unknown {
	if (path.length === 0) return undefined;
	let current: unknown = input;
	for (const segment of path.split(".")) {
		if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
		current = (current as Record<string, unknown>)[segment];
		if (current === undefined) return undefined;
	}
	return current;
}

/** Trim additionalContext to the token budget, spilling the full text to a file. */
export function applyAdditionalContextLimit(
	text: string,
	options: { limitTokens?: number; outputDir: string; sessionId: string },
): { context: string; spillFile?: string } {
	const limitTokens = options.limitTokens ?? DEFAULT_ADDITIONAL_CONTEXT_TOKENS;
	const charLimit = limitTokens * CHARS_PER_TOKEN;
	if (text.length <= charLimit) return { context: text };
	const dir = join(options.outputDir, options.sessionId);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${randomUUID()}.txt`);
	writeFileSync(file, text, "utf8");
	const head = text.slice(0, SPILL_PREVIEW_CHARS);
	const tail = text.slice(-SPILL_PREVIEW_CHARS);
	const omitted = text.length - head.length - tail.length;
	const context = `${head}\n\n[... ${omitted} characters omitted; full output: ${file}]\n\n${tail}`;
	return { context, spillFile: file };
}

export interface HookRunnerOptions {
	/** Parsed hooks config to run. */
	config: ParsedHooksConfig;
	/** Trust store gating handler execution. */
	trustStore: HookTrustStore;
	/** Spill directory override. Defaults to `<tmpdir>/hook_outputs`. */
	outputDir?: string;
	/** Diagnostics sink for events like skipped untrusted hooks (in addition to emit results). */
	onDiagnostic?: (diagnostic: HookDiagnostic) => void;
}

interface ExecOutcome {
	stdout: string;
	stderr: string;
	code: number;
	timedOut: boolean;
}

/** Runs parsed hook handlers for the 12 Codex hook events. */
export class HookRunner {
	private readonly config: ParsedHooksConfig;
	private readonly trustStore: HookTrustStore;
	private readonly outputDir: string;
	private readonly onDiagnostic: ((diagnostic: HookDiagnostic) => void) | undefined;
	private asyncSlots = MAX_ASYNC_CONCURRENCY;
	private readonly asyncQueue: Array<() => void> = [];

	constructor(options: HookRunnerOptions) {
		this.config = options.config;
		this.trustStore = options.trustStore;
		this.outputDir = options.outputDir ?? join(tmpdir(), "hook_outputs");
		this.onDiagnostic = options.onDiagnostic;
	}

	/**
	 * Emit an event: run every matching handler and aggregate the results.
	 * Async handlers run in the background; `asyncSettled` resolves when they
	 * finish. Async results never affect the synchronous decision.
	 */
	async emit<E extends HookEventName>(
		event: E,
		payload: Record<string, unknown>,
		options: HookEmitOptions,
	): Promise<HookEmitResult> {
		const groups = this.config.events[event] ?? [];
		const matched: ParsedHookHandler[] = [];
		for (const group of groups) {
			if (!matcherGroupMatches(event, group, payload)) continue;
			matched.push(...group.handlers);
		}

		const diagnostics: HookDiagnostic[] = [];
		const emitDiagnostics: string[] = [];
		const runnable: ParsedHookHandler[] = [];
		for (const parsed of matched) {
			if (parsed.handler.type === "prompt" || parsed.handler.type === "agent") {
				const message = `hooks: ${parsed.handler.type} handler ${parsed.index + 1} (${parsed.sourcePath}) is not executed`;
				diagnostics.push({ type: "info", message });
				emitDiagnostics.push(message);
				this.onDiagnostic?.({ type: "info", message });
				continue;
			}
			if (!this.trustStore.isTrusted(parsed.hash)) {
				const handler = parsed.handler;
				if (handler.type !== "command" && handler.type !== "mcp_tool") continue;
				const label = handler.type === "command" ? handler.command : `${handler.server}/${handler.tool}`;
				const message = `hooks: skipping untrusted handler (${handler.type}: ${label}, hash ${parsed.hash.slice(0, 12)}…, from ${parsed.sourcePath})`;
				diagnostics.push({ type: "warning", message });
				emitDiagnostics.push(message);
				this.onDiagnostic?.({ type: "warning", message });
				continue;
			}
			runnable.push(parsed);
		}

		const syncHandlers = runnable.filter((parsed) => !handlerIsAsync(parsed));
		const asyncHandlers = runnable.filter((parsed) => handlerIsAsync(parsed));

		const results: HookHandlerResult[] = [];
		for (const parsed of syncHandlers) {
			results.push(await this.runHandler(event, parsed, payload, options));
		}
		const asyncSettled = this.runAsyncHandlers(event, asyncHandlers, payload, options);
		const aggregated = this.aggregate(event, results);
		return { ...aggregated, event, results, diagnostics: emitDiagnostics, asyncSettled };
	}

	private async runAsyncHandlers(
		event: HookEventName,
		handlers: ParsedHookHandler[],
		payload: Record<string, unknown>,
		options: HookEmitOptions,
	): Promise<HookHandlerResult[]> {
		if (handlers.length === 0) return [];
		const results: HookHandlerResult[] = [];
		const run = async (parsed: ParsedHookHandler): Promise<void> => {
			await this.acquireAsyncSlot();
			try {
				results.push(await this.runHandler(event, parsed, payload, options));
			} finally {
				this.releaseAsyncSlot();
			}
		};
		await Promise.all(handlers.map(run));
		return results;
	}

	private async acquireAsyncSlot(): Promise<void> {
		if (this.asyncSlots > 0) {
			this.asyncSlots -= 1;
			return;
		}
		await new Promise<void>((resolve) => {
			this.asyncQueue.push(() => {
				this.asyncSlots -= 1;
				resolve();
			});
		});
	}

	private releaseAsyncSlot(): void {
		const next = this.asyncQueue.shift();
		if (next) {
			// Hand the slot directly to the waiting handler.
			next();
			return;
		}
		this.asyncSlots += 1;
	}

	private async runHandler(
		event: HookEventName,
		parsed: ParsedHookHandler,
		payload: Record<string, unknown>,
		options: HookEmitOptions,
	): Promise<HookHandlerResult> {
		if (parsed.handler.type === "mcp_tool") {
			return this.runMcpToolHandler(event, parsed, payload, options);
		}
		return this.runCommandHandler(event, parsed, payload, options);
	}

	private async runCommandHandler(
		event: HookEventName,
		parsed: ParsedHookHandler,
		payload: Record<string, unknown>,
		options: HookEmitOptions,
	): Promise<HookHandlerResult> {
		const handler = parsed.handler;
		if (handler.type !== "command") throw new Error("runCommandHandler called with a non-command handler");
		const command = process.platform === "win32" && handler.commandWindows ? handler.commandWindows : handler.command;
		const input = this.buildHookInput(event, payload, options);
		const result: HookHandlerResult = {
			hash: parsed.hash,
			type: "command",
			label: command,
			status: "success",
			diagnostics: [],
		};
		try {
			const outcome = await this.spawnHook(command, input, options, effectiveTimeoutMs(event, handler.timeout));
			return this.interpretCommandOutput(event, parsed, outcome, options);
		} catch (error) {
			result.status = "failed";
			result.reason = error instanceof Error ? error.message : String(error);
			result.diagnostics.push(`hook command failed: ${result.reason}`);
			return result;
		}
	}

	private spawnHook(
		command: string,
		input: Record<string, unknown>,
		options: HookEmitOptions,
		timeoutMs: number,
	): Promise<ExecOutcome> {
		return new Promise<ExecOutcome>((resolve) => {
			const extraEnv = options.getEnv?.() ?? {};
			const env: Record<string, string> = {};
			for (const [key, value] of Object.entries(process.env)) {
				if (value !== undefined) env[key] = value;
			}
			for (const [key, value] of Object.entries(extraEnv)) {
				if (value !== undefined) env[key] = value;
			}
			const proc = spawn(command, {
				shell: true,
				cwd: options.cwd,
				env,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			let settled = false;
			proc.stdout?.on("data", (data) => {
				stdout += String(data);
			});
			proc.stderr?.on("data", (data) => {
				stderr += String(data);
			});
			const timer = setTimeout(() => {
				timedOut = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			}, timeoutMs);
			const abort = () => {
				proc.kill("SIGTERM");
			};
			if (options.signal) {
				if (options.signal.aborted) abort();
				else options.signal.addEventListener("abort", abort, { once: true });
			}
			const finish = (outcome: ExecOutcome) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", abort);
				resolve(outcome);
			};
			waitForChildProcess(proc)
				.then((code) => {
					finish({ stdout, stderr, code: code ?? 0, timedOut });
				})
				.catch((error) => {
					finish({
						stdout,
						stderr,
						code: 1,
						timedOut,
					});
					if (!(error instanceof Error)) throw error;
				});
			proc.stdin?.on("error", () => {
				// The hook may have exited before reading stdin; the exit code decides.
			});
			proc.stdin?.end(JSON.stringify(input), "utf8");
		});
	}

	private interpretCommandOutput(
		event: HookEventName,
		parsed: ParsedHookHandler,
		outcome: ExecOutcome,
		options: HookEmitOptions,
	): HookHandlerResult {
		const handler = parsed.handler;
		if (handler.type !== "command") throw new Error("interpretCommandOutput called with a non-command handler");
		const label = handler.command;
		const result: HookHandlerResult = {
			hash: parsed.hash,
			type: "command",
			label,
			status: "success",
			diagnostics: [],
		};
		if (outcome.timedOut) {
			result.status = "timeout";
			result.reason = `hook timed out after ${handler.timeout ?? (event === "SessionEnd" || event === "Interrupt" ? FAST_HOOK_TIMEOUT_S : DEFAULT_HOOK_TIMEOUT_S)}s`;
			result.diagnostics.push(`hook command timed out: ${label}`);
			return result;
		}
		if (outcome.code === 2) {
			result.status = "denied";
			result.reason = outcome.stderr.trim() || "hook blocked the operation";
			return result;
		}
		if (outcome.code !== 0) {
			result.status = "failed";
			result.reason = outcome.stderr.trim() || `hook exited with code ${outcome.code}`;
			result.diagnostics.push(result.reason);
			return result;
		}
		return this.interpretStdout(event, parsed, outcome.stdout.trim(), handler.additionalContextLimit, options);
	}

	private interpretStdout(
		event: HookEventName,
		parsed: ParsedHookHandler,
		stdout: string,
		additionalContextLimit: number | undefined,
		options: HookEmitOptions,
	): HookHandlerResult {
		const handler = parsed.handler;
		const label = handler.type === "command" ? handler.command : "";
		const result: HookHandlerResult = {
			hash: parsed.hash,
			type: "command",
			label,
			status: "success",
			diagnostics: [],
		};
		if (stdout.length === 0) return result;

		if (stdout.startsWith("{")) {
			let parsedJson: unknown;
			try {
				parsedJson = JSON.parse(stdout);
			} catch {
				result.status = "failed";
				result.diagnostics.push("hook stdout looked like JSON but failed to parse");
				return result;
			}
			if (typeof parsedJson !== "object" || parsedJson === null || Array.isArray(parsedJson)) {
				result.status = "failed";
				result.diagnostics.push("hook stdout JSON must be an object");
				return result;
			}
			return this.applyJsonOutput(event, parsed, parsedJson as Record<string, unknown>, options);
		}

		// Plain text.
		if (PLAIN_TEXT_CONTEXT_EVENTS.has(event)) {
			const { context, spillFile } = applyAdditionalContextLimit(stdout, {
				limitTokens: additionalContextLimit,
				outputDir: this.outputDir,
				sessionId: options.session_id,
			});
			result.additionalContext = context;
			result.spillFile = spillFile;
			return result;
		}
		if (PLAIN_TEXT_INVALID_EVENTS.has(event)) {
			result.diagnostics.push("hook plain-text stdout has no effect for this event");
			result.ignoredPlainText = stdout;
			return result;
		}
		// PreToolUse/PostToolUse and the remaining events: plain text is ignored.
		result.ignoredPlainText = stdout;
		return result;
	}

	private applyJsonOutput(
		event: HookEventName,
		parsed: ParsedHookHandler,
		output: Record<string, unknown>,
		options: HookEmitOptions,
	): HookHandlerResult {
		const handler = parsed.handler;
		if (handler.type !== "command" && handler.type !== "mcp_tool") {
			throw new Error("applyJsonOutput called with a skipped handler");
		}
		const additionalContextLimit = handler.type === "command" ? handler.additionalContextLimit : undefined;
		const label = handler.type === "command" ? handler.command : `${handler.server}/${handler.tool}`;
		const result: HookHandlerResult = {
			hash: parsed.hash,
			type: "command",
			label,
			status: "success",
			diagnostics: [],
		};
		const json = output as unknown as HookJsonOutput;
		const allowed = allowedJsonFields(event);
		const unsupported = Object.keys(output).filter((key) => !allowed.has(key));
		if (unsupported.length > 0) {
			result.status = "failed";
			result.diagnostics.push(`unsupported JSON field(s) for ${event}: ${unsupported.join(", ")}`);
			return result;
		}
		if (json.continue === false) {
			result.stopRequested = true;
			result.status = "blocked";
			result.reason = typeof json.stopReason === "string" ? json.stopReason : "hook requested stop";
			if (typeof json.stopReason === "string") result.stopReason = json.stopReason;
		}
		if (typeof json.systemMessage === "string") result.systemMessage = json.systemMessage;
		if (json.suppressOutput === true) result.suppressOutput = true;
		if (typeof json.stopReason === "string" && result.stopReason === undefined) {
			result.stopReason = json.stopReason;
		}

		if (event === "Stop" || event === "SubagentStop") {
			if (json.decision === "block") {
				result.blockReason = typeof json.reason === "string" ? json.reason : "";
			}
		}

		const specific = output.hookSpecificOutput;
		if (typeof specific === "object" && specific !== null && !Array.isArray(specific)) {
			const specificAllowed = allowedHookSpecificFields(event);
			const specificRecord = specific as Record<string, unknown>;
			const specificUnsupported = Object.keys(specificRecord).filter((key) => !specificAllowed.has(key));
			if (specificUnsupported.length > 0) {
				result.status = "failed";
				result.diagnostics.push(
					`unsupported hookSpecificOutput field(s) for ${event}: ${specificUnsupported.join(", ")}`,
				);
				return result;
			}
			this.applyHookSpecificOutput(event, result, specificRecord, additionalContextLimit, options);
		}
		return result;
	}
	private applyHookSpecificOutput(
		event: HookEventName,
		result: HookHandlerResult,
		specific: Record<string, unknown>,
		additionalContextLimit: number | undefined,
		options: HookEmitOptions,
	): void {
		if (event === "SessionStart" || event === "UserPromptSubmit" || event === "SubagentStart") {
			if (typeof specific.additionalContext === "string") {
				const { context, spillFile } = applyAdditionalContextLimit(specific.additionalContext, {
					limitTokens: additionalContextLimit,
					outputDir: this.outputDir,
					sessionId: options.session_id,
				});
				result.additionalContext = context;
				result.spillFile = spillFile;
			}
			return;
		}
		if (event === "PreToolUse") {
			const decision = specific.permissionDecision;
			if (decision === "allow" || decision === "deny") result.permissionDecision = decision;
			if (result.permissionDecision === "deny") {
				// A deny decision blocks the operation like exit code 2.
				result.stopRequested = true;
				result.status = "denied";
				result.reason =
					typeof specific.permissionDecisionReason === "string"
						? specific.permissionDecisionReason
						: "hook denied the operation";
				if (typeof specific.permissionDecisionReason === "string") {
					result.permissionDecisionReason = specific.permissionDecisionReason;
				}
				return;
			}
			if (typeof specific.permissionDecisionReason === "string") {
				result.permissionDecisionReason = specific.permissionDecisionReason;
			}
			if (
				result.permissionDecision === "allow" &&
				typeof specific.updatedInput === "object" &&
				specific.updatedInput !== null &&
				!Array.isArray(specific.updatedInput)
			) {
				result.updatedInput = { ...(specific.updatedInput as Record<string, unknown>) };
			}
			return;
		}
		if (event === "PermissionRequest") {
			const decision = specific.decision;
			if (typeof decision === "object" && decision !== null && !Array.isArray(decision)) {
				const record = decision as Record<string, unknown>;
				if (record.behavior === "allow" || record.behavior === "deny") {
					result.decisionBehavior = record.behavior;
				}
				if (result.decisionBehavior === "deny") {
					// A deny behavior blocks the operation like exit code 2.
					result.stopRequested = true;
					result.status = "denied";
					result.reason = typeof record.message === "string" ? record.message : "hook denied the operation";
				}
				if (typeof record.message === "string") result.decisionMessage = record.message;
			}
			return;
		}
		if (event === "PostToolUse") {
			if (typeof specific.additionalContext === "string") {
				const { context, spillFile } = applyAdditionalContextLimit(specific.additionalContext, {
					limitTokens: additionalContextLimit,
					outputDir: this.outputDir,
					sessionId: options.session_id,
				});
				result.additionalContext = context;
				result.spillFile = spillFile;
			}
		}
	}

	private async runMcpToolHandler(
		event: HookEventName,
		parsed: ParsedHookHandler,
		payload: Record<string, unknown>,
		options: HookEmitOptions,
	): Promise<HookHandlerResult> {
		const handler = parsed.handler;
		if (handler.type !== "mcp_tool") throw new Error("runMcpToolHandler called with a non-mcp_tool handler");
		const label = `${handler.server}/${handler.tool}`;
		const result: HookHandlerResult = {
			hash: parsed.hash,
			type: "mcp_tool",
			label,
			status: "success",
			diagnostics: [],
		};
		if (!options.callMcpTool) {
			result.status = "failed";
			result.diagnostics.push(`no MCP tool caller available for hook ${label}`);
			return result;
		}
		const input = expandMcpToolInput(handler.input ?? {}, payload);
		const args = typeof input === "object" && input !== null && !Array.isArray(input) ? input : {};
		try {
			const timeoutMs = effectiveTimeoutMs(event, handler.timeout);
			const value = await options.callMcpTool(handler.server, handler.tool, args, {
				signal: options.signal,
				timeoutMs,
			});
			// MCP tool results carry no hook decision fields; surface text content
			// as additionalContext where the event accepts it.
			const text = mcpResultToText(value);
			if (text !== undefined && (PLAIN_TEXT_CONTEXT_EVENTS.has(event) || event === "PostToolUse")) {
				const { context, spillFile } = applyAdditionalContextLimit(text, {
					outputDir: this.outputDir,
					sessionId: options.session_id,
				});
				result.additionalContext = context;
				result.spillFile = spillFile;
			}
			return result;
		} catch (error) {
			result.status = "failed";
			result.reason = error instanceof Error ? error.message : String(error);
			result.diagnostics.push(`mcp_tool hook ${label} failed: ${result.reason}`);
			return result;
		}
	}

	private buildHookInput<E extends HookEventName>(
		event: E,
		payload: Record<string, unknown>,
		options: HookEmitOptions,
	): Record<string, unknown> {
		const input: Record<string, unknown> = {
			session_id: options.session_id,
			transcript_path: options.transcript_path ?? "",
			cwd: options.cwd,
			hook_event_name: event,
		};
		if (options.model !== undefined) input.model = options.model;
		if (EVENTS_WITH_PERMISSION_MODE.has(event) && options.permission_mode !== undefined) {
			input.permission_mode = options.permission_mode;
		}
		if (EVENTS_WITH_TURN_ID.has(event) && options.turn_id !== undefined) {
			input.turn_id = options.turn_id;
		}
		for (const [key, value] of Object.entries(payload)) {
			input[key] = value;
		}
		return input;
	}

	private aggregate(
		event: HookEventName,
		results: HookHandlerResult[],
	): Omit<HookEmitResult, "event" | "results" | "diagnostics" | "asyncSettled"> {
		let shouldContinue = true;
		let reason: string | undefined;
		const systemMessages: string[] = [];
		const contexts: string[] = [];
		let permissionDecision: "allow" | "deny" | undefined;
		let permissionDecisionReason: string | undefined;
		let updatedInput: Record<string, unknown> | undefined;
		let decisionBehavior: "allow" | "deny" | undefined;
		let decisionMessage: string | undefined;
		let blockReason: string | undefined;
		let suppressOutput = false;

		for (const result of results) {
			if (result.systemMessage !== undefined) systemMessages.push(result.systemMessage);
			if (result.suppressOutput === true) suppressOutput = true;
			if (result.additionalContext !== undefined) contexts.push(result.additionalContext);

			// continue:false from any hook wins over every other hook's decision to continue.
			if (result.stopRequested) {
				shouldContinue = false;
				if (reason === undefined) reason = result.reason;
			}
			// Denies (exit 2, deny decisions) block the operation.
			if (result.status === "denied") {
				shouldContinue = false;
				if (reason === undefined) reason = result.reason;
				// An exit-2 deny outranks another hook's allow decision.
				if (event === "PreToolUse" && permissionDecision !== "deny") {
					permissionDecision = "deny";
					if (permissionDecisionReason === undefined) {
						permissionDecisionReason = result.permissionDecisionReason ?? result.reason;
					}
				}
				if (event === "PermissionRequest" && decisionBehavior !== "deny") {
					decisionBehavior = "deny";
					if (decisionMessage === undefined) decisionMessage = result.decisionMessage ?? result.reason;
				}
			}
			if (event === "PreToolUse") {
				if (result.permissionDecision === "deny") {
					permissionDecision = "deny";
					if (permissionDecisionReason === undefined) {
						permissionDecisionReason = result.permissionDecisionReason ?? result.reason;
					}
				} else if (result.permissionDecision === "allow" && permissionDecision !== "deny") {
					if (permissionDecision !== "allow") permissionDecision = "allow";
					if (result.updatedInput !== undefined) updatedInput = { ...result.updatedInput };
					if (permissionDecisionReason === undefined && result.permissionDecisionReason !== undefined) {
						permissionDecisionReason = result.permissionDecisionReason;
					}
				}
			}
			if (event === "PermissionRequest") {
				if (result.decisionBehavior === "deny") {
					decisionBehavior = "deny";
					if (decisionMessage === undefined) decisionMessage = result.decisionMessage ?? result.reason;
				} else if (result.decisionBehavior === "allow" && decisionBehavior !== "deny") {
					decisionBehavior = "allow";
					if (decisionMessage === undefined && result.decisionMessage !== undefined) {
						decisionMessage = result.decisionMessage;
					}
				}
			}
			if ((event === "Stop" || event === "SubagentStop") && result.blockReason !== undefined) {
				// Block keeps the run going with the reason as a new prompt; it does not stop the session.
				if (blockReason === undefined) blockReason = result.blockReason;
			}
		}

		return {
			continue: shouldContinue,
			reason,
			systemMessage: systemMessages.length > 0 ? systemMessages.join("\n") : undefined,
			suppressOutput: suppressOutput || undefined,
			additionalContext: contexts.length > 0 ? contexts.join("\n\n") : undefined,
			permissionDecision,
			permissionDecisionReason,
			updatedInput,
			decisionBehavior,
			decisionMessage,
			blockReason,
		};
	}
}

function handlerIsAsync(parsed: ParsedHookHandler): boolean {
	return parsed.handler.type === "command" && parsed.handler.async === true;
}

/** Best-effort text extraction from an MCP tool result (content array or plain text). */
function mcpResultToText(value: unknown): string | undefined {
	if (typeof value === "string") return value.length > 0 ? value : undefined;
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (Array.isArray(record.content)) {
		const parts: string[] = [];
		for (const item of record.content) {
			if (typeof item === "object" && item !== null) {
				const text = (item as Record<string, unknown>).text;
				if (typeof text === "string") parts.push(text);
			} else if (typeof item === "string") {
				parts.push(item);
			}
		}
		return parts.length > 0 ? parts.join("\n") : undefined;
	}
	if (typeof record.text === "string") return record.text.length > 0 ? record.text : undefined;
	return undefined;
}
