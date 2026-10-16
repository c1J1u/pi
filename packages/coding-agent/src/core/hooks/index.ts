/**
 * OpenAI Codex-compatible hooks runtime.
 *
 * See docs/byte-c1j1u/spec-sources.md (Hooks section, verified 2026-10-16)
 * for the specification this module implements.
 */

export {
	asHookMatcherGroup,
	eventIgnoresMatcher,
	isHookEventName,
	isHooksFileConfig,
	matcherFieldValue,
	matcherGroupMatches,
	matchRawMatcher,
	parseHooksConfig,
	readHooksConfigFromDir,
	readHooksFile,
	toolNameMatchesPattern,
} from "./config.ts";
export type { HookRunnerOptions } from "./runner.ts";
export {
	applyAdditionalContextLimit,
	CHARS_PER_TOKEN,
	DEFAULT_ADDITIONAL_CONTEXT_TOKENS,
	DEFAULT_HOOK_TIMEOUT_S,
	effectiveTimeoutMs,
	expandMcpToolInput,
	FAST_HOOK_TIMEOUT_MAX_S,
	FAST_HOOK_TIMEOUT_S,
	HookRunner,
	MAX_ASYNC_CONCURRENCY,
	SPILL_PREVIEW_CHARS,
} from "./runner.ts";
export type { HookTrustEntry, HookTrustStoreOptions, TrustableHookDefinition } from "./trust.ts";
export {
	computeHookHandlerHash,
	describeHookDefinition,
	HookTrustStore,
} from "./trust.ts";
export type {
	CallMcpToolFn,
	CommandHookHandler,
	HookDiagnostic,
	HookEmitOptions,
	HookEmitResult,
	HookEventName,
	HookEventPayloads,
	HookHandler,
	HookHandlerResult,
	HookInput,
	HookJsonOutput,
	HookMatcherGroup,
	HookPermissionMode,
	HookSkippedHandlerType,
	HookSpecificOutputs,
	HooksFileConfig,
	McpToolHookHandler,
	ParsedHookHandler,
	ParsedHookMatcherGroup,
	ParsedHooksConfig,
	SkippedHookHandler,
} from "./types.ts";
export { HOOK_EVENT_NAMES } from "./types.ts";
