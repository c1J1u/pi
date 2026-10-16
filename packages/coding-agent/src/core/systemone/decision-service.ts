/**
 * Shared System One decision service.
 *
 * All decision points (skill selection, model routing, evidence filtering, subtask
 * delegation, verification gaps) go through one interface so they share error handling,
 * caching, budget accounting, and audit logging.
 *
 * Constraints from docs/byte-c1j1u/architecture.md:
 * - Independent questions against one shared state are merged into a single call.
 * - Cache keys bind goal + evidence digest + candidate catalog digest + question
 *   definitions + model + policy version. Steering, file changes, and capability-set
 *   changes invalidate.
 * - Failures degrade to deterministic fallbacks with recorded reasons; they never block
 *   the caller and never widen authorization.
 * - Decision records are sanitized: no credentials, no full file contents.
 */

import { createHash } from "node:crypto";
import type {
	ClassifierAnswer,
	ClassifierContext,
	ClassifierModel,
	ClassifierOptions,
	ClassifierQuestion,
	ClassifierResult,
} from "@earendil-works/pi-ai";

export type DecisionQuestion = ClassifierQuestion;
export type DecisionAnswer = ClassifierAnswer;

export interface DecisionRequest {
	/** Decision domain: "skill-selection" | "model-routing" | ... */
	domain: string;
	/** Shared state judged by all questions: goal, task stage, candidate summaries, evidence. */
	state: ClassifierContext["state"];
	/** Independent questions; dependent questions must be split across requests. */
	questions: Record<string, DecisionQuestion>;
	/** Goal text for cache keying and logging. */
	goal: string;
	/** Digest of the evidence the state summarizes; empty for stateless domains. */
	evidenceDigest?: string;
	/** Candidate capability catalog digest; from CapabilityCatalog.digest(). */
	catalogDigest?: string;
	/** Budget: wall-clock timeout for the decision call. */
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface DecisionRecord {
	domain: string;
	goalDigest: string;
	questionIds: string[];
	stateDigest: string;
	catalogDigest?: string;
	answers?: Record<string, DecisionAnswer>;
	stopReason: "stop" | "error" | "aborted" | "cache-hit";
	errorMessage?: string;
	/** Fallback the caller applied, when the decision failed or was skipped. */
	fallback?: string;
	usageInputTokens?: number;
	latencyMs: number;
	timestamp: number;
	cacheHit: boolean;
}

export type ClassifyFn = (
	model: ClassifierModel<"ark-system-one">,
	context: ClassifierContext,
	options?: ClassifierOptions,
) => Promise<ClassifierResult>;

export interface DecisionCacheEntry {
	key: string;
	answers: Record<string, DecisionAnswer>;
	createdAt: number;
}

export interface DecisionServiceOptions {
	model: ClassifierModel<"ark-system-one">;
	getApiKey: () => string | undefined;
	classifyFn: ClassifyFn;
	/** Cache entries; default 512. */
	maxCacheEntries?: number;
	/** Policy version; bump to force cache misses across deployments. */
	policyVersion?: string;
	/** Where sanitized decision records are appended (JSONL). */
	logFile?: string;
	/** Max goal length stored in cache keys and logs (sanitization). */
	maxGoalLength?: number;
}

const DEFAULT_MAX_CACHE = 512;
const DEFAULT_MAX_GOAL = 2000;

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

export class DecisionService {
	private readonly options: DecisionServiceOptions;
	private readonly cache = new Map<string, DecisionCacheEntry>();
	private readonly records: DecisionRecord[] = [];

	constructor(options: DecisionServiceOptions) {
		this.options = options;
	}

	/**
	 * Ask a batch of independent questions over one shared state. Returns answers keyed by
	 * question id, or an error result when the call fails — callers apply deterministic
	 * fallbacks and record them via `recordFallback`.
	 */
	async ask(request: DecisionRequest): Promise<{
		answers: Record<string, DecisionAnswer>;
		stopReason: "stop" | "cache-hit" | "error" | "aborted";
		errorMessage?: string;
	}> {
		const started = Date.now();
		const key = this.cacheKey(request);
		const cached = this.cache.get(key);
		if (cached) {
			const record: DecisionRecord = {
				domain: request.domain,
				goalDigest: digest(this.truncateGoal(request.goal)),
				questionIds: Object.keys(request.questions),
				stateDigest: digest(request.state),
				catalogDigest: request.catalogDigest,
				answers: cached.answers,
				stopReason: "cache-hit",
				latencyMs: Date.now() - started,
				timestamp: started,
				cacheHit: true,
			};
			this.pushRecord(record);
			return { answers: cached.answers, stopReason: "cache-hit" };
		}

		const apiKey = this.options.getApiKey();
		if (!apiKey) {
			const record = this.errorRecord(request, started, "no Ark API key configured; skipped decision");
			this.pushRecord(record);
			return { answers: {}, stopReason: "error", errorMessage: record.errorMessage };
		}

		const context: ClassifierContext = {
			state: request.state,
			questions: request.questions,
		};
		const result = await this.options.classifyFn(this.options.model, context, {
			apiKey,
			signal: request.signal,
			...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
			maxRetries: 1,
		});

		const latencyMs = Date.now() - started;
		if (result.stopReason !== "stop") {
			const record = this.errorRecord(request, started, result.errorMessage ?? `classifier ${result.stopReason}`);
			record.usageInputTokens = result.usage?.input;
			this.pushRecord(record);
			return { answers: {}, stopReason: result.stopReason, errorMessage: record.errorMessage };
		}

		this.storeCache(key, request, result.answers);
		const record: DecisionRecord = {
			domain: request.domain,
			goalDigest: digest(this.truncateGoal(request.goal)),
			questionIds: Object.keys(request.questions),
			stateDigest: digest(request.state),
			catalogDigest: request.catalogDigest,
			answers: result.answers,
			stopReason: "stop",
			usageInputTokens: result.usage?.input,
			latencyMs,
			timestamp: started,
			cacheHit: false,
		};
		this.pushRecord(record);
		return { answers: result.answers, stopReason: "stop" };
	}

	/** Record the deterministic fallback a caller applied after a failed/skipped decision. */
	recordFallback(domain: string, reason: string): void {
		this.pushRecord({
			domain,
			goalDigest: "",
			questionIds: [],
			stateDigest: "",
			stopReason: "error",
			errorMessage: reason,
			fallback: reason,
			latencyMs: 0,
			timestamp: Date.now(),
			cacheHit: false,
		});
	}

	/** Drop every cache entry (capability-set change, policy bump, user steering). */
	invalidateCache(): void {
		this.cache.clear();
	}

	private cacheKey(request: DecisionRequest): string {
		return digest({
			domain: request.domain,
			goal: this.truncateGoal(request.goal),
			state: request.state,
			evidence: request.evidenceDigest ?? "",
			catalog: request.catalogDigest ?? "",
			questions: request.questions,
			model: `${this.options.model.provider}/${this.options.model.id}`,
			policy: this.options.policyVersion ?? "",
		});
	}

	private storeCache(key: string, request: DecisionRequest, answers: Record<string, DecisionAnswer>): void {
		this.cache.set(key, { key, answers, createdAt: Date.now() });
		while (this.cache.size > (this.options.maxCacheEntries ?? DEFAULT_MAX_CACHE)) {
			const oldest = Array.from(this.cache.values()).sort((a, b) => a.createdAt - b.createdAt)[0];
			if (!oldest) break;
			this.cache.delete(oldest.key);
		}
		// A new decision for a changed capability set must not be answered from stale entries.
		if (request.catalogDigest !== undefined) {
			for (const [k, entry] of Array.from(this.cache.entries())) {
				if (k !== key && entry.createdAt < Date.now() - 30 * 60_000) this.cache.delete(k);
			}
		}
	}

	private errorRecord(request: DecisionRequest, started: number, message: string): DecisionRecord {
		return {
			domain: request.domain,
			goalDigest: digest(this.truncateGoal(request.goal)),
			questionIds: Object.keys(request.questions),
			stateDigest: digest(request.state),
			catalogDigest: request.catalogDigest,
			stopReason: "error",
			errorMessage: message,
			latencyMs: Date.now() - started,
			timestamp: started,
			cacheHit: false,
		};
	}

	private truncateGoal(goal: string): string {
		const max = this.options.maxGoalLength ?? DEFAULT_MAX_GOAL;
		return goal.length > max ? `${goal.slice(0, max)}…` : goal;
	}

	private pushRecord(record: DecisionRecord): void {
		this.records.push(record);
		if (this.records.length > 1000) this.records.splice(0, this.records.length - 1000);
	}

	/** Sanitized decision records for auditability and the evaluation harness. */
	auditLog(): readonly DecisionRecord[] {
		return this.records;
	}
}

/** Convenience: extract a bool answer's probability with a confidence floor. */
export function boolAnswer(answers: Record<string, DecisionAnswer>, id: string): { probability: number } | undefined {
	const answer = answers[id];
	if (answer?.type === "bool") return { probability: answer.probability };
	return undefined;
}

/** Convenience: extract a choice answer above a probability floor. */
export function choiceAnswer(
	answers: Record<string, DecisionAnswer>,
	id: string,
	floor = 0.5,
): { choice: string; probabilities: Record<string, number> } | undefined {
	const answer = answers[id];
	if (answer?.type === "choice" && (answer.probabilities[answer.choice] ?? 0) >= floor) {
		return { choice: answer.choice, probabilities: answer.probabilities };
	}
	return undefined;
}

/** Convenience: extract a score answer. */
export function scoreAnswer(answers: Record<string, DecisionAnswer>, id: string): { score: number } | undefined {
	const answer = answers[id];
	if (answer?.type === "score") return { score: answer.score };
	return undefined;
}
