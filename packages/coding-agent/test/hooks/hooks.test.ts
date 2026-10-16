// biome-ignore-all lint/suspicious/noTemplateCurlyInString: mcp_tool hook inputs use literal ${field} placeholders by design.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	applyAdditionalContextLimit,
	DEFAULT_HOOK_TIMEOUT_S,
	effectiveTimeoutMs,
	expandMcpToolInput,
	FAST_HOOK_TIMEOUT_MAX_S,
	FAST_HOOK_TIMEOUT_S,
	HookRunner,
	HookTrustStore,
	matchRawMatcher,
	parseHooksConfig,
	readHooksFile,
} from "../../src/core/hooks/index.ts";
import { computeHookHandlerHash, describeHookDefinition } from "../../src/core/hooks/trust.ts";
import type { HookEmitOptions, ParsedHooksConfig } from "../../src/core/hooks/types.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "pi-hooks-test-"));
afterAll(() => {
	rmSync(tempRoot, { recursive: true, force: true });
});

// ============================================================================
// Helpers
// ============================================================================

interface Harness {
	dir: string;
	trustStore: HookTrustStore;
	parsed: ParsedHooksConfig;
	runner: HookRunner;
}

let caseCounter = 0;
let scriptCounter = 0;

/** The directory the next setup() call will use (created eagerly). */
function nextCaseDir(): string {
	const dir = join(tempRoot, `case-${caseCounter + 1}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Write hooks.json into a fresh temp dir, trust every valid handler by
 * default, and build the runner. Hook command builders need the dir before
 * setup() runs: pass nextCaseDir() to them inside the config object.
 */
function setup(config: Record<string, unknown>, options?: { trustAll?: boolean; outputDir?: string }): Harness {
	caseCounter += 1;
	const dir = join(tempRoot, `case-${caseCounter}`);
	mkdirSync(dir, { recursive: true });
	const hooksFile = join(dir, "hooks.json");
	writeFileSync(hooksFile, JSON.stringify(config));
	const trustStore = new HookTrustStore({ stateFile: join(dir, "trust.json") });
	const parsed = readHooksFile(hooksFile);
	if (!parsed) throw new Error("hooks.json not found");
	if (options?.trustAll !== false) {
		for (const handler of parsed.handlers) {
			if (handler.hash) trustStore.trust(handler.hash);
		}
	}
	const runner = new HookRunner({ config: parsed, trustStore, outputDir: options?.outputDir });
	return { dir, trustStore, parsed, runner };
}

/** Write a Node ESM script acting as a hook command; returns `node <path>`. */
function nodeHook(dir: string, script: string): string {
	scriptCounter += 1;
	const file = join(dir, `hook-${scriptCounter}.mjs`);
	writeFileSync(file, script);
	return `node ${JSON.stringify(file)}`;
}

/** A hook that responds with canned stdout/stderr/exit code after reading stdin. */
function echoHook(
	dir: string,
	respond: { stdout?: string; exitCode?: number; stderr?: string; delayMs?: number },
): string {
	const respondJson = JSON.stringify(respond);
	const script = `
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
	const respond = ${respondJson};
	if (respond.delayMs) {
		const start = Date.now();
		while (Date.now() - start < respond.delayMs) {}
	}
	if (respond.stderr) process.stderr.write(respond.stderr);
	if (respond.stdout !== undefined) process.stdout.write(respond.stdout);
	process.exit(respond.exitCode ?? 0);
});
`;
	return nodeHook(dir, script);
}

/** A hook whose stdout is the given JSON object. */
function jsonHook(dir: string, output: Record<string, unknown>): string {
	return echoHook(dir, { stdout: JSON.stringify(output) });
}

/** A hook that writes the stdin JSON it received to a file. */
function captureHook(dir: string, outFile: string): string {
	const script = `
import { writeFileSync } from "node:fs";
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
	writeFileSync(${JSON.stringify(outFile)}, input);
});
`;
	return nodeHook(dir, script);
}

/** A hook that writes a marker file (proves it ran). */
function markerHook(dir: string, markerFile: string): string {
	const script = `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(markerFile)}, "ran");
`;
	return nodeHook(dir, script);
}

function emitOptions(harness: Harness, extra?: Partial<HookEmitOptions>): HookEmitOptions {
	return {
		cwd: harness.dir,
		session_id: "sess-1",
		transcript_path: join(harness.dir, "transcript.jsonl"),
		model: "test-model",
		...extra,
	};
}

/** A slow async hook script body that writes a marker after a delay. */
function SLOW_ASYNC_SCRIPT(markerFile: string): string {
	return `
import { writeFileSync } from "node:fs";
await new Promise((r) => setTimeout(r, 300));
writeFileSync(${JSON.stringify(markerFile)}, "done");
process.stdout.write("late context");
`;
}

// ============================================================================
// Config parsing
// ============================================================================

describe("hooks config parsing", () => {
	it("parses the documented shape with matchers and handlers", () => {
		const parsed: ParsedHooksConfig = parseHooksConfig(
			{
				description: "test hooks",
				hooks: {
					PreToolUse: [
						{
							matcher: "bash|edit",
							hooks: [
								{ type: "command", command: "echo hi", timeout: 5, statusMessage: "running", async: true },
							],
						},
					],
					SessionStart: [
						{ hooks: [{ type: "mcp_tool", server: "docs", tool: "search", input: { q: "${prompt}" } }] },
					],
				},
			},
			"hooks.json",
		);
		expect(parsed.diagnostics).toEqual([]);
		expect(parsed.events.PreToolUse?.[0]?.matcher).toBe("bash|edit");
		expect(parsed.events.PreToolUse?.[0]?.handlers[0]?.handler).toMatchObject({
			type: "command",
			command: "echo hi",
			timeout: 5,
			async: true,
		});
		expect(parsed.events.SessionStart?.[0]?.handlers[0]?.handler).toMatchObject({
			type: "mcp_tool",
			server: "docs",
			tool: "search",
		});
	});

	it("reports diagnostics for unknown events, fields, and handler types", () => {
		const parsed: ParsedHooksConfig = parseHooksConfig(
			{
				bogusTop: 1,
				hooks: {
					NotAnEvent: [],
					Stop: [
						{
							badGroupField: true,
							hooks: [
								{ type: "command", command: "ok", nonsense: 1 },
								{ type: "command" },
								{ type: "carrier-pigeon", command: "x" },
							],
						},
					],
				},
			},
			"hooks.json",
		);
		const messages = parsed.diagnostics.map((d) => d.message);
		expect(messages.some((m) => m.includes('unknown field "bogusTop"'))).toBe(true);
		expect(messages.some((m) => m.includes('unknown hook event "NotAnEvent"'))).toBe(true);
		expect(messages.some((m) => m.includes('unknown field "badGroupField"'))).toBe(true);
		expect(messages.some((m) => m.includes('unknown field "nonsense"'))).toBe(true);
		expect(messages.some((m) => m.includes("require a non-empty command"))).toBe(true);
		expect(messages.some((m) => m.includes("unsupported handler type"))).toBe(true);
		// Only the valid command survived.
		const handlers = parsed.events.Stop?.[0]?.handlers ?? [];
		expect(handlers).toHaveLength(1);
		expect(handlers[0]?.handler).toMatchObject({ type: "command", command: "ok" });
	});

	it("parses prompt/agent handlers but marks them skipped", () => {
		const parsed: ParsedHooksConfig = parseHooksConfig(
			{ hooks: { Stop: [{ hooks: [{ type: "prompt" }, { type: "agent" }] }] } },
			"hooks.json",
		);
		const handlers = parsed.events.Stop?.[0]?.handlers ?? [];
		expect(handlers.map((h) => h.handler.type)).toEqual(["prompt", "agent"]);
		expect(handlers.every((h) => h.hash === "")).toBe(true);
		expect(parsed.diagnostics.some((d) => d.message.includes("parsed but not executed"))).toBe(true);
	});

	it("rejects invalid matcher regexes with a diagnostic", () => {
		const parsed: ParsedHooksConfig = parseHooksConfig(
			{ hooks: { PreToolUse: [{ matcher: "([unclosed", hooks: [{ type: "command", command: "x" }] }] } },
			"hooks.json",
		);
		expect(parsed.events.PreToolUse?.[0]?.regex).toBeUndefined();
		expect(parsed.diagnostics.some((d) => d.message.includes("invalid matcher regex"))).toBe(true);
	});

	it("reports diagnostics for invalid hooks key shapes", () => {
		const parsed: ParsedHooksConfig = parseHooksConfig({ hooks: "nope" }, "hooks.json");
		expect(parsed.diagnostics.some((d) => d.message.includes('missing or invalid "hooks"'))).toBe(true);
		const notGroups: ParsedHooksConfig = parseHooksConfig({ hooks: { Stop: "nope" } }, "hooks.json");
		expect(notGroups.diagnostics.some((d) => d.message.includes("array of matcher groups"))).toBe(true);
	});
});

// ============================================================================
// Matcher semantics
// ============================================================================

describe("matcher semantics", () => {
	it("matches tool names with regex, *, empty, and omitted matchers", () => {
		expect(matchRawMatcher("PreToolUse", "bash|edit", "bash")).toBe(true);
		expect(matchRawMatcher("PreToolUse", "bash|edit", "read")).toBe(false);
		expect(matchRawMatcher("PostToolUse", "^bash$", "bash")).toBe(true);
		expect(matchRawMatcher("PermissionRequest", "write", "read")).toBe(false);
		expect(matchRawMatcher("PreToolUse", "*", "anything")).toBe(true);
		expect(matchRawMatcher("PreToolUse", "", "anything")).toBe(true);
		expect(matchRawMatcher("PreToolUse", undefined, "anything")).toBe(true);
		expect(matchRawMatcher("PreToolUse", "bash", undefined)).toBe(false);
	});

	it("aliases apply_patch to Edit and Write", () => {
		expect(matchRawMatcher("PreToolUse", "apply_patch", "Edit")).toBe(true);
		expect(matchRawMatcher("PreToolUse", "apply_patch", "Write")).toBe(true);
		expect(matchRawMatcher("PreToolUse", "apply_patch", "read")).toBe(false);
		expect(matchRawMatcher("PreToolUse", "^Edit$", "apply_patch")).toBe(true);
		expect(matchRawMatcher("PostToolUse", "Write", "apply_patch")).toBe(true);
	});

	it("matches source, reason, trigger, and agent_type per event", () => {
		expect(matchRawMatcher("SessionStart", "startup|resume", "resume")).toBe(true);
		expect(matchRawMatcher("SessionStart", "startup", "clear")).toBe(false);
		expect(matchRawMatcher("SessionEnd", "other", "other")).toBe(true);
		expect(matchRawMatcher("SessionEnd", "logout", "other")).toBe(false);
		expect(matchRawMatcher("PreCompact", "manual", "auto")).toBe(false);
		expect(matchRawMatcher("PreCompact", "manual|auto", "auto")).toBe(true);
		expect(matchRawMatcher("PostCompact", "auto", "auto")).toBe(true);
		expect(matchRawMatcher("SubagentStart", "research", "research")).toBe(true);
		expect(matchRawMatcher("SubagentStop", "^general$", "general")).toBe(true);
	});

	it("ignores matchers for UserPromptSubmit, Stop, and Interrupt", () => {
		expect(matchRawMatcher("UserPromptSubmit", "never-matches", undefined)).toBe(true);
		expect(matchRawMatcher("Stop", "never-matches", undefined)).toBe(true);
		expect(matchRawMatcher("Interrupt", "never-matches", undefined)).toBe(true);
	});
});

// ============================================================================
// Trust store
// ============================================================================

describe("hook trust store", () => {
	it("records trust per handler hash and re-trusts after changes", () => {
		const trustFile = join(tempRoot, "trust", "trust.json");
		const store = new HookTrustStore({ stateFile: trustFile });
		const hash = computeHookHandlerHash({ type: "command", command: "echo one" });
		expect(store.isTrusted(hash)).toBe(false);
		store.trust(hash);
		expect(store.isTrusted(hash)).toBe(true);
		expect(store.list()).toEqual([hash]);

		const changed = computeHookHandlerHash({ type: "command", command: "echo two" });
		expect(store.isTrusted(changed)).toBe(false);

		store.untrust(hash);
		expect(store.isTrusted(hash)).toBe(false);
		expect(store.list()).toEqual([]);
	});

	it("hashes canonical JSON: key order does not matter", () => {
		const a = { type: "command" as const, command: "echo hi", timeout: 5 };
		const b = { timeout: 5, command: "echo hi", type: "command" as const };
		expect(computeHookHandlerHash(a)).toBe(computeHookHandlerHash(b));
		expect(computeHookHandlerHash(a)).not.toBe(computeHookHandlerHash({ ...a, command: "echo bye" }));
	});

	it("bypass trusts everything", () => {
		const store = new HookTrustStore({ stateFile: join(tempRoot, "trust-bypass.json"), bypass: true });
		expect(store.isTrusted("deadbeef")).toBe(true);
		expect(store.isBypassed()).toBe(true);
	});

	it("persists trust across store instances", () => {
		const trustFile = join(tempRoot, "trust-persist.json");
		const hash = computeHookHandlerHash({ type: "command", command: "echo persist" });
		new HookTrustStore({ stateFile: trustFile }).trust(hash);
		const reloaded = new HookTrustStore({ stateFile: trustFile });
		expect(reloaded.isTrusted(hash)).toBe(true);
		expect(reloaded.list()).toEqual([hash]);
	});

	it("describes hook definitions for listing", () => {
		expect(describeHookDefinition({ type: "command", command: "ls" })).toBe("command: ls");
		expect(describeHookDefinition({ type: "mcp_tool", server: "s", tool: "t" })).toBe("mcp_tool: s/t");
		expect(describeHookDefinition({ type: "prompt" })).toBe("prompt (skipped)");
	});
});

// ============================================================================
// Runner: matching + execution contract
// ============================================================================

describe("hook runner", () => {
	it("runs only handlers whose matcher matches", async () => {
		const dir = join(tempRoot, "matcher-case");
		mkdirSync(dir, { recursive: true });
		const hitFile = join(dir, "hit.txt");
		const missFile = join(dir, "miss.txt");
		const harness = setup({
			hooks: {
				PreToolUse: [
					{ matcher: "^bash$", hooks: [{ type: "command", command: markerHook(dir, hitFile) }] },
					{ matcher: "^edit$", hooks: [{ type: "command", command: markerHook(dir, missFile) }] },
				],
			},
		});
		const result = await harness.runner.emit(
			"PreToolUse",
			{ tool_name: "bash", tool_input: {} },
			emitOptions(harness),
		);
		await result.asyncSettled;
		expect(result.results).toHaveLength(1);
		expect(result.results[0]?.status).toBe("success");
		expect(existsSync(hitFile)).toBe(true);
		expect(existsSync(missFile)).toBe(false);
	});

	it("sends the documented stdin JSON to the hook", async () => {
		const dir = join(tempRoot, "stdin-case");
		mkdirSync(dir, { recursive: true });
		const captureFile = join(dir, "stdin.json");
		const harness = setup({
			hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: captureHook(dir, captureFile) }] }] },
		});
		const result = await harness.runner.emit(
			"UserPromptSubmit",
			{ prompt: "hello hooks" },
			emitOptions(harness, { permission_mode: "default", turn_id: "turn-9" }),
		);
		await result.asyncSettled;
		expect(result.results[0]?.status).toBe("success");
		const captured = JSON.parse(readFileSync(captureFile, "utf8")) as Record<string, unknown>;
		expect(captured.hook_event_name).toBe("UserPromptSubmit");
		expect(captured.session_id).toBe("sess-1");
		expect(captured.cwd).toBe(harness.dir);
		expect(captured.transcript_path).toContain("transcript.jsonl");
		expect(captured.model).toBe("test-model");
		expect(captured.permission_mode).toBe("default");
		expect(captured.turn_id).toBe("turn-9");
		expect(captured.prompt).toBe("hello hooks");
	});

	it("omits turn_id for non-turn events", async () => {
		const dir = join(tempRoot, "stdin-noturn");
		mkdirSync(dir, { recursive: true });
		const captureFile = join(dir, "stdin.json");
		const harness = setup({
			hooks: { SessionStart: [{ hooks: [{ type: "command", command: captureHook(dir, captureFile) }] }] },
		});
		const result = await harness.runner.emit(
			"SessionStart",
			{ source: "startup" },
			emitOptions(harness, { turn_id: "turn-1" }),
		);
		await result.asyncSettled;
		const captured = JSON.parse(readFileSync(captureFile, "utf8")) as Record<string, unknown>;
		expect(captured.turn_id).toBeUndefined();
		expect(captured.source).toBe("startup");
		expect(captured.permission_mode).toBeUndefined();
	});

	it("exit 0 with no output continues", async () => {
		const harness = setup({
			hooks: { Stop: [{ hooks: [{ type: "command", command: echoHook(nextCaseDir(), {}) }] }] },
		});
		const result = await harness.runner.emit("Stop", {}, emitOptions(harness));
		await result.asyncSettled;
		expect(result.continue).toBe(true);
		expect(result.results[0]?.status).toBe("success");
	});

	it("exit 2 denies with stderr as reason", async () => {
		const harness = setup({
			hooks: {
				PreToolUse: [
					{
						hooks: [
							{
								type: "command",
								command: echoHook(nextCaseDir(), { exitCode: 2, stderr: "bash not allowed here" }),
							},
						],
					},
				],
			},
		});
		const result = await harness.runner.emit(
			"PreToolUse",
			{ tool_name: "bash", tool_input: {} },
			emitOptions(harness),
		);
		await result.asyncSettled;
		expect(result.continue).toBe(false);
		expect(result.reason).toBe("bash not allowed here");
		expect(result.results[0]?.status).toBe("denied");
	});

	it("parses JSON output: allow with updatedInput", async () => {
		const harness = setup({
			hooks: {
				PreToolUse: [
					{
						hooks: [
							{
								type: "command",
								command: jsonHook(nextCaseDir(), {
									hookSpecificOutput: {
										permissionDecision: "allow",
										updatedInput: { command: "ls -la" },
									},
								}),
							},
						],
					},
				],
			},
		});
		const result = await harness.runner.emit(
			"PreToolUse",
			{ tool_name: "bash", tool_input: { command: "ls" } },
			emitOptions(harness),
		);
		await result.asyncSettled;
		expect(result.continue).toBe(true);
		expect(result.permissionDecision).toBe("allow");
		expect(result.updatedInput).toEqual({ command: "ls -la" });
	});

	it("parses JSON output: deny with permissionDecisionReason", async () => {
		const harness = setup({
			hooks: {
				PreToolUse: [
					{
						hooks: [
							{
								type: "command",
								command: jsonHook(nextCaseDir(), {
									hookSpecificOutput: {
										permissionDecision: "deny",
										permissionDecisionReason: "dangerous command",
									},
								}),
							},
						],
					},
				],
			},
		});
		const result = await harness.runner.emit(
			"PreToolUse",
			{ tool_name: "bash", tool_input: {} },
			emitOptions(harness),
		);
		await result.asyncSettled;
		expect(result.continue).toBe(false);
		expect(result.permissionDecision).toBe("deny");
		expect(result.permissionDecisionReason).toBe("dangerous command");
	});

	it("PermissionRequest decision.behavior deny with message", async () => {
		const harness = setup({
			hooks: {
				PermissionRequest: [
					{
						hooks: [
							{
								type: "command",
								command: jsonHook(nextCaseDir(), {
									hookSpecificOutput: { decision: { behavior: "deny", message: "blocked by policy" } },
								}),
							},
						],
					},
				],
			},
		});
		const result = await harness.runner.emit(
			"PermissionRequest",
			{ tool_name: "bash", tool_input: {} },
			emitOptions(harness),
		);
		await result.asyncSettled;
		expect(result.decisionBehavior).toBe("deny");
		expect(result.decisionMessage).toBe("blocked by policy");
		expect(result.continue).toBe(false);
	});

	it("PermissionRequest decision.behavior allow", async () => {
		const harness = setup({
			hooks: {
				PermissionRequest: [
					{
						hooks: [
							{
								type: "command",
								command: jsonHook(nextCaseDir(), {
									hookSpecificOutput: { decision: { behavior: "allow", message: "go ahead" } },
								}),
							},
						],
					},
				],
			},
		});
		const result = await harness.runner.emit(
			"PermissionRequest",
			{ tool_name: "bash", tool_input: {} },
			emitOptions(harness),
		);
		await result.asyncSettled;
		expect(result.decisionBehavior).toBe("allow");
		expect(result.decisionMessage).toBe("go ahead");
		expect(result.continue).toBe(true);
	});

	it("SessionStart JSON additionalContext and plain-text context merge", async () => {
		const harness = setup({
			hooks: {
				SessionStart: [
					{
						hooks: [
							{
								type: "command",
								command: jsonHook(nextCaseDir(), { hookSpecificOutput: { additionalContext: "from json" } }),
							},
							{ type: "command", command: echoHook(nextCaseDir(), { stdout: "from plain text" }) },
						],
					},
				],
			},
		});
		const result = await harness.runner.emit("SessionStart", { source: "startup" }, emitOptions(harness));
		await result.asyncSettled;
		expect(result.additionalContext).toBe("from json\n\nfrom plain text");
	});

	it("PostToolUse plain text is ignored", async () => {
		const harness = setup({
			hooks: {
				PostToolUse: [
					{ hooks: [{ type: "command", command: echoHook(nextCaseDir(), { stdout: "ignored text" }) }] },
				],
			},
		});
		const result = await harness.runner.emit(
			"PostToolUse",
			{ tool_name: "bash", tool_input: {}, tool_response: "done" },
			emitOptions(harness),
		);
		await result.asyncSettled;
		expect(result.additionalContext).toBeUndefined();
		expect(result.results[0]?.ignoredPlainText).toBe("ignored text");
	});

	it("PostToolUse JSON additionalContext is honored", async () => {
		const harness = setup({
			hooks: {
				PostToolUse: [
					{
						hooks: [
							{
								type: "command",
								command: jsonHook(nextCaseDir(), {
									hookSpecificOutput: { additionalContext: "post-tool context" },
								}),
							},
						],
					},
				],
			},
		});
		const result = await harness.runner.emit(
			"PostToolUse",
			{ tool_name: "bash", tool_input: {}, tool_response: "done" },
			emitOptions(harness),
		);
		await result.asyncSettled;
		expect(result.additionalContext).toBe("post-tool context");
	});

	it("Stop plain text records a diagnostic and has no effect", async () => {
		const harness = setup({
			hooks: { Stop: [{ hooks: [{ type: "command", command: echoHook(nextCaseDir(), { stdout: "no effect" }) }] }] },
		});
		const result = await harness.runner.emit("Stop", {}, emitOptions(harness));
		await result.asyncSettled;
		expect(result.continue).toBe(true);
		expect(result.results[0]?.diagnostics.some((d) => d.includes("no effect"))).toBe(true);
	});

	it("Stop decision block + reason continues the run with the reason", async () => {
		const harness = setup({
			hooks: {
				Stop: [
					{
						hooks: [
							{
								type: "command",
								command: jsonHook(nextCaseDir(), { decision: "block", reason: "run the tests first" }),
							},
						],
					},
				],
			},
		});
		const result = await harness.runner.emit("Stop", {}, emitOptions(harness));
		await result.asyncSettled;
		expect(result.blockReason).toBe("run the tests first");
		// block on Stop continues the run; it must not stop the session.
		expect(result.continue).toBe(true);
	});

	it("Stop continue:false wins over another hook's block", async () => {
		const harness = setup({
			hooks: {
				Stop: [
					{
						hooks: [
							{ type: "command", command: jsonHook(nextCaseDir(), { decision: "block", reason: "keep going" }) },
							{ type: "command", command: jsonHook(nextCaseDir(), { continue: false, stopReason: "all done" }) },
						],
					},
				],
			},
		});
		const result = await harness.runner.emit("Stop", {}, emitOptions(harness));
		await result.asyncSettled;
		expect(result.continue).toBe(false);
		expect(result.reason).toBe("all done");
		expect(result.blockReason).toBe("keep going");
	});

	it("continue:false wins over another hook's continue", async () => {
		const harness = setup({
			hooks: {
				UserPromptSubmit: [
					{
						hooks: [
							{ type: "command", command: echoHook(nextCaseDir(), { stdout: "fine to proceed" }) },
							{
								type: "command",
								command: jsonHook(nextCaseDir(), { continue: false, stopReason: "blocked prompt" }),
							},
						],
					},
				],
			},
		});
		const result = await harness.runner.emit("UserPromptSubmit", { prompt: "go" }, emitOptions(harness));
		await result.asyncSettled;
		expect(result.continue).toBe(false);
		expect(result.reason).toBe("blocked prompt");
	});

	it("unsupported JSON fields for the event fail the hook but the operation continues", async () => {
		const harness = setup({
			hooks: {
				// continue:false is unsupported on PreToolUse per spec examples.
				PreToolUse: [{ hooks: [{ type: "command", command: jsonHook(nextCaseDir(), { continue: false }) }] }],
			},
		});
		const result = await harness.runner.emit(
			"PreToolUse",
			{ tool_name: "bash", tool_input: {} },
			emitOptions(harness),
		);
		await result.asyncSettled;
		expect(result.results[0]?.status).toBe("failed");
		expect(result.results[0]?.diagnostics[0]).toContain("continue");
		// The failed hook does not block the operation.
		expect(result.continue).toBe(true);
	});

	it("unsupported hookSpecificOutput fields fail the hook", async () => {
		const harness = setup({
			hooks: {
				PostToolUse: [
					{
						hooks: [
							{
								type: "command",
								command: jsonHook(nextCaseDir(), {
									hookSpecificOutput: { permissionDecision: "allow" },
								}),
							},
						],
					},
				],
			},
		});
		const result = await harness.runner.emit(
			"PostToolUse",
			{ tool_name: "bash", tool_input: {}, tool_response: "x" },
			emitOptions(harness),
		);
		await result.asyncSettled;
		expect(result.results[0]?.status).toBe("failed");
		expect(result.results[0]?.diagnostics[0]).toContain("permissionDecision");
		expect(result.continue).toBe(true);
	});

	it("systemMessage and suppressOutput pass through", async () => {
		const harness = setup({
			hooks: {
				SessionStart: [
					{
						hooks: [
							{
								type: "command",
								command: jsonHook(nextCaseDir(), { systemMessage: "hello user", suppressOutput: true }),
							},
						],
					},
				],
			},
		});
		const result = await harness.runner.emit("SessionStart", { source: "startup" }, emitOptions(harness));
		await result.asyncSettled;
		expect(result.systemMessage).toBe("hello user");
		expect(result.suppressOutput).toBe(true);
	});

	it("times out long-running hooks", async () => {
		const harness = setup({
			hooks: {
				PreToolUse: [
					{ hooks: [{ type: "command", command: echoHook(nextCaseDir(), { delayMs: 4000 }), timeout: 0.5 }] },
				],
			},
		});
		const start = Date.now();
		const result = await harness.runner.emit(
			"PreToolUse",
			{ tool_name: "bash", tool_input: {} },
			emitOptions(harness),
		);
		await result.asyncSettled;
		expect(Date.now() - start).toBeLessThan(3500);
		expect(result.results[0]?.status).toBe("timeout");
		// A timeout does not deny the operation.
		expect(result.continue).toBe(true);
	}, 10000);

	it("SessionEnd defaults to a 1s timeout and caps at 3s", async () => {
		expect(effectiveTimeoutMs("SessionEnd", undefined)).toBe(FAST_HOOK_TIMEOUT_S * 1000);
		expect(effectiveTimeoutMs("Interrupt", undefined)).toBe(FAST_HOOK_TIMEOUT_S * 1000);
		expect(effectiveTimeoutMs("SessionEnd", 1)).toBe(1000);
		expect(effectiveTimeoutMs("SessionEnd", 30)).toBe(FAST_HOOK_TIMEOUT_MAX_S * 1000);
		expect(effectiveTimeoutMs("Interrupt", 99)).toBe(FAST_HOOK_TIMEOUT_MAX_S * 1000);
		expect(effectiveTimeoutMs("Stop", undefined)).toBe(DEFAULT_HOOK_TIMEOUT_S * 1000);
		expect(effectiveTimeoutMs("PreToolUse", 5)).toBe(5000);

		const harness = setup({
			hooks: { SessionEnd: [{ hooks: [{ type: "command", command: echoHook(nextCaseDir(), { delayMs: 4000 }) }] }] },
		});
		const start = Date.now();
		const result = await harness.runner.emit("SessionEnd", { reason: "other" }, emitOptions(harness));
		await result.asyncSettled;
		expect(Date.now() - start).toBeLessThan(3500);
		expect(result.results[0]?.status).toBe("timeout");
	}, 10000);

	it("async handlers run in the background and cannot block", async () => {
		const slowFile = join(tempRoot, "async-slow-done.txt");
		rmSync(slowFile, { force: true });
		const harness = setup({
			hooks: {
				SessionStart: [
					{
						hooks: [
							{ type: "command", command: nodeHook(nextCaseDir(), SLOW_ASYNC_SCRIPT(slowFile)), async: true },
						],
					},
				],
			},
		});
		const start = Date.now();
		const result = await harness.runner.emit("SessionStart", { source: "startup" }, emitOptions(harness));
		// The emission must return before the async handler finishes.
		expect(Date.now() - start).toBeLessThan(250);
		expect(existsSync(slowFile)).toBe(false);
		await result.asyncSettled;
		expect(existsSync(slowFile)).toBe(true);
		expect(result.continue).toBe(true);
		// Async results arrive at the next safe point (asyncSettled), not in the
		// synchronous decision.
		expect(result.results).toHaveLength(0);
		const asyncResults = await result.asyncSettled;
		expect(asyncResults).toHaveLength(1);
	});

	it("skips untrusted handlers with a diagnostic", async () => {
		const ranFile = join(tempRoot, "untrusted-ran.txt");
		rmSync(ranFile, { force: true });
		const dir = join(tempRoot, "untrusted-case");
		mkdirSync(dir, { recursive: true });
		const harness = setup(
			{
				hooks: {
					SessionStart: [{ hooks: [{ type: "command", command: markerHook(dir, ranFile) }] }],
				},
			},
			{ trustAll: false },
		);
		const result = await harness.runner.emit("SessionStart", { source: "startup" }, emitOptions(harness));
		await result.asyncSettled;
		expect(result.results).toHaveLength(0);
		expect(result.continue).toBe(true);
		expect(result.diagnostics.some((d) => d.includes("skipping untrusted handler"))).toBe(true);
		expect(existsSync(ranFile)).toBe(false);

		// Trusting the hash makes it run.
		const hash = harness.parsed.handlers[0]?.hash;
		expect(hash).toBeTruthy();
		harness.trustStore.trust(hash!);
		const result2 = await harness.runner.emit("SessionStart", { source: "startup" }, emitOptions(harness));
		await result2.asyncSettled;
		expect(result2.results).toHaveLength(1);
		expect(existsSync(ranFile)).toBe(true);
	});

	it("skips prompt/agent handlers at emit time with a diagnostic", async () => {
		const harness = setup({
			hooks: { Stop: [{ hooks: [{ type: "prompt" }, { type: "agent" }] }] },
		});
		const result = await harness.runner.emit("Stop", {}, emitOptions(harness));
		await result.asyncSettled;
		expect(result.results).toHaveLength(0);
		expect(result.diagnostics.filter((d) => d.includes("not executed"))).toHaveLength(2);
	});

	it("aggregates multiple hooks: deny (exit 2) wins over allow", async () => {
		const harness = setup({
			hooks: {
				PreToolUse: [
					{
						hooks: [
							{
								type: "command",
								command: jsonHook(nextCaseDir(), {
									hookSpecificOutput: { permissionDecision: "allow", updatedInput: { command: "ls -la" } },
								}),
							},
							{
								type: "command",
								command: echoHook(nextCaseDir(), { exitCode: 2, stderr: "denied by second hook" }),
							},
						],
					},
				],
			},
		});
		const result = await harness.runner.emit(
			"PreToolUse",
			{ tool_name: "bash", tool_input: {} },
			emitOptions(harness),
		);
		await result.asyncSettled;
		expect(result.continue).toBe(false);
		expect(result.reason).toBe("denied by second hook");
		expect(result.permissionDecision).toBe("deny");
	});

	it("aggregates allow decisions across hooks", async () => {
		const harness = setup({
			hooks: {
				PreToolUse: [
					{
						hooks: [
							{
								type: "command",
								command: jsonHook(nextCaseDir(), { hookSpecificOutput: { permissionDecision: "allow" } }),
							},
							{
								type: "command",
								command: jsonHook(nextCaseDir(), {
									hookSpecificOutput: { permissionDecision: "allow", updatedInput: { command: "ls" } },
								}),
							},
						],
					},
				],
			},
		});
		const result = await harness.runner.emit(
			"PreToolUse",
			{ tool_name: "bash", tool_input: {} },
			emitOptions(harness),
		);
		await result.asyncSettled;
		expect(result.continue).toBe(true);
		expect(result.permissionDecision).toBe("allow");
		expect(result.updatedInput).toEqual({ command: "ls" });
	});

	it("runs the command in the session cwd", async () => {
		const harness = setup({
			hooks: {
				SessionStart: [
					{
						hooks: [
							{
								type: "command",
								command: nodeHook(
									nextCaseDir(),
									`import { writeFileSync } from "node:fs"; writeFileSync("cwd-probe.txt", "x");`,
								),
							},
						],
					},
				],
			},
		});
		const result = await harness.runner.emit("SessionStart", { source: "startup" }, emitOptions(harness));
		await result.asyncSettled;
		expect(existsSync(join(harness.dir, "cwd-probe.txt"))).toBe(true);
	});

	it("commands can use shell syntax", async () => {
		const dir = nextCaseDir();
		const harness = setup({
			hooks: {
				SessionStart: [
					{
						hooks: [
							{
								type: "command",
								command: `echo shell-ok > ${JSON.stringify(join(dir, "shell-out.txt"))}`,
							},
						],
					},
				],
			},
		});
		const result = await harness.runner.emit("SessionStart", { source: "startup" }, emitOptions(harness));
		await result.asyncSettled;
		expect(readFileSync(join(harness.dir, "shell-out.txt"), "utf8").trim()).toBe("shell-ok");
	});

	it("inherits process.env and merges injected env", async () => {
		const harness = setup({
			hooks: {
				SessionStart: [
					{
						hooks: [
							{
								type: "command",
								command: nodeHook(
									nextCaseDir(),
									`import { writeFileSync } from "node:fs";
writeFileSync("env-out.txt", process.env.PATH + "\\n" + process.env.PI_HOOK_TEST_VAR);`,
								),
							},
						],
					},
				],
			},
		});
		const result = await harness.runner.emit(
			"SessionStart",
			{ source: "startup" },
			emitOptions(harness, { getEnv: () => ({ PI_HOOK_TEST_VAR: "injected" }) }),
		);
		await result.asyncSettled;
		const content = readFileSync(join(harness.dir, "env-out.txt"), "utf8");
		expect(content).toContain("injected");
		expect(content).toContain(process.env.PATH ?? "");
	});
});

// ============================================================================
// additionalContext limit and spill
// ============================================================================

describe("additionalContext limit and spill", () => {
	it("keeps context within the default ~2500 token budget", () => {
		const text = "a".repeat(2500 * 4);
		const { context, spillFile } = applyAdditionalContextLimit(text, {
			outputDir: join(tempRoot, "spill"),
			sessionId: "s1",
		});
		expect(spillFile).toBeUndefined();
		expect(context).toBe(text);
	});

	it("spills over-limit context to a file with head/tail preview", () => {
		const text = `${"h".repeat(5000)}MIDDLE${"t".repeat(5000)}`;
		const { context, spillFile } = applyAdditionalContextLimit(text, {
			outputDir: join(tempRoot, "spill"),
			sessionId: "s1",
		});
		expect(spillFile).toBeDefined();
		expect(existsSync(spillFile!)).toBe(true);
		expect(readFileSync(spillFile!, "utf8")).toBe(text);
		expect(context).toContain(text.slice(0, 200));
		expect(context).toContain(text.slice(-200));
		expect(context).toContain("characters omitted");
		expect(context).toContain(spillFile!);
		expect(context.length).toBeLessThan(text.length);
		// Spill path follows <outputDir>/<session_id>/<uuid>.txt.
		expect(spillFile!.split(/[\\/]/).at(-2)).toBe("s1");
		expect(spillFile!.endsWith(".txt")).toBe(true);
	});

	it("honors a custom additionalContextLimit", () => {
		const text = "x".repeat(1000);
		const within = applyAdditionalContextLimit(text, {
			limitTokens: 300,
			outputDir: join(tempRoot, "spill"),
			sessionId: "s2",
		});
		expect(within.spillFile).toBeUndefined();
		const over = applyAdditionalContextLimit(text, {
			limitTokens: 100,
			outputDir: join(tempRoot, "spill"),
			sessionId: "s2",
		});
		expect(over.spillFile).toBeDefined();
	});

	it("spills SessionStart plain-text context from a live hook", async () => {
		const bigText = `${"A".repeat(400)}CENTER${"B".repeat(400)}`;
		const harness = setup({
			hooks: {
				SessionStart: [
					{
						hooks: [
							{
								type: "command",
								command: echoHook(nextCaseDir(), { stdout: bigText }),
								additionalContextLimit: 100,
							},
						],
					},
				],
			},
		});
		const outputDir = join(harness.dir, "hook_outputs");
		const runner = new HookRunner({ config: harness.parsed, trustStore: harness.trustStore, outputDir });
		const result = await runner.emit(
			"SessionStart",
			{ source: "startup" },
			{ ...emitOptions(harness), session_id: "spill-sess" },
		);
		await result.asyncSettled;
		expect(result.additionalContext).toBeDefined();
		expect(result.additionalContext).toContain("characters omitted");
		const spill = result.results[0]?.spillFile;
		expect(spill).toBeDefined();
		expect(readFileSync(spill!, "utf8")).toBe(bigText);
	});
});

// ============================================================================
// mcp_tool handlers
// ============================================================================

describe("mcp_tool handlers", () => {
	it("expands ${field.nested} placeholders preserving JSON types", () => {
		const input = {
			prompt: "${prompt}",
			nested: { tool: "${tool_name}", raw: 7 },
			list: ["${tool_name}", { deep: "${tool_input.path}" }],
			wholeNumber: "${tool_input.count}",
			mixed: "prefix ${tool_name} suffix",
			missing: "${nope}",
		};
		const expanded = expandMcpToolInput(input, {
			prompt: "find bugs",
			tool_name: "bash",
			tool_input: { path: "src/main.ts", count: 3 },
		}) as Record<string, unknown>;
		expect(expanded.prompt).toBe("find bugs");
		expect((expanded.nested as Record<string, unknown>).tool).toBe("bash");
		expect((expanded.nested as Record<string, unknown>).raw).toBe(7);
		expect((expanded.list as unknown[])[0]).toBe("bash");
		expect(((expanded.list as unknown[])[1] as Record<string, unknown>).deep).toBe("src/main.ts");
		// Whole-value placeholder keeps the JSON type (number, not string).
		expect(expanded.wholeNumber).toBe(3);
		expect(expanded.mixed).toBe("prefix bash suffix");
		// Unresolvable placeholders stay verbatim.
		expect(expanded.missing).toBe("${nope}");
	});

	it("runs the tool through the injected callMcpTool callback", async () => {
		const calls: Array<{ server: string; tool: string; args: unknown }> = [];
		const harness = setup({
			hooks: {
				UserPromptSubmit: [
					{
						hooks: [
							{
								type: "mcp_tool",
								server: "docs",
								tool: "search",
								input: { query: "${prompt}", limit: "${limit}" },
							},
						],
					},
				],
			},
		});
		const result = await harness.runner.emit(
			"UserPromptSubmit",
			{ prompt: "find hooks", limit: 7 },
			{
				...emitOptions(harness),
				callMcpTool: async (server, tool, args) => {
					calls.push({ server, tool, args });
					return { content: [{ type: "text", text: "mcp says hi" }] };
				},
			},
		);
		await result.asyncSettled;
		expect(calls).toEqual([{ server: "docs", tool: "search", args: { query: "find hooks", limit: 7 } }]);
		expect(result.results[0]?.status).toBe("success");
		expect(result.additionalContext).toBe("mcp says hi");
	});

	it("missing caller or failing tool does not block", async () => {
		const harness = setup({
			hooks: {
				PreToolUse: [{ matcher: "bash", hooks: [{ type: "mcp_tool", server: "gone", tool: "noop" }] }],
			},
		});

		// No callMcpTool injected.
		const noCaller = await harness.runner.emit(
			"PreToolUse",
			{ tool_name: "bash", tool_input: {} },
			emitOptions(harness),
		);
		await noCaller.asyncSettled;
		expect(noCaller.continue).toBe(true);
		expect(noCaller.results[0]?.status).toBe("failed");

		// callMcpTool throws (missing server / tool unavailable).
		const failing = await harness.runner.emit(
			"PreToolUse",
			{ tool_name: "bash", tool_input: {} },
			{
				...emitOptions(harness),
				callMcpTool: async () => {
					throw new Error("server not connected");
				},
			},
		);
		await failing.asyncSettled;
		expect(failing.continue).toBe(true);
		expect(failing.results[0]?.status).toBe("failed");
		expect(failing.results[0]?.diagnostics[0]).toContain("server not connected");
	});
});

// ============================================================================
// Misc
// ============================================================================

describe("misc", () => {
	it("reads hooks.json and reports missing files", () => {
		const dir = join(tempRoot, "read-dir");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "hooks.json"),
			JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] } }),
		);
		const parsed = readHooksFile(join(dir, "hooks.json"));
		expect(parsed?.events.Stop).toBeDefined();
		expect(readHooksFile(join(dir, "missing.json"))).toBeUndefined();
	});

	it("handles a hooks file that is not valid JSON", () => {
		const dir = join(tempRoot, "bad-json");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "hooks.json"), "{not json");
		const parsed = readHooksFile(join(dir, "hooks.json"));
		expect(parsed?.diagnostics[0]?.type).toBe("error");
		expect(parsed?.handlers).toEqual([]);
	});
});

describe("plugin env injection (review fix C2)", () => {
	it("getEnv receives the executing handler's hash", async () => {
		const seenHashes: Array<string | undefined> = [];
		const config = {
			hooks: {
				SessionStart: [
					{ hooks: [{ type: "command", command: "node -e process.exit(0)" }] },
					{ hooks: [{ type: "command", command: "node -e process.exit(0)" }] },
				],
			},
		};
		const parsed = parseHooksConfig(config, "env-test.json", { fromPlugin: true });
		const trustStore = new HookTrustStore({ stateFile: join(tmpdir(), `pi-trust-env-${Date.now()}.json`) });
		for (const handler of parsed.handlers) trustStore.trust(handler.hash);
		const runner = new HookRunner({
			config: parsed,
			trustStore,
			getEnv: (hash) => {
				seenHashes.push(hash);
				return hash === parsed.handlers[0]?.hash ? { PLUGIN_ROOT: "/plugin/a" } : {};
			},
		});
		await runner.emit(
			"SessionStart",
			{ session_id: "s", cwd: tmpdir(), hook_event_name: "SessionStart", source: "startup" },
			{ cwd: tmpdir(), session_id: "s" },
		);
		expect(seenHashes).toHaveLength(2);
		expect(seenHashes[0]).toBe(parsed.handlers[0]?.hash);
		expect(seenHashes[1]).toBe(parsed.handlers[1]?.hash);
	});
});
