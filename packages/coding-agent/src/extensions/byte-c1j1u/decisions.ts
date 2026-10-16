/**
 * System One decision applications on the agent loop: evidence filtering before the
 * model sees large results, verification/stop control at the settle boundary, and
 * skill-selection advice. All applications respect the deterministic floors from
 * docs/byte-c1j1u/architecture.md:
 *
 * - Simple operations keep a low-overhead path: explicit single reads never trigger a
 *   remote decision.
 * - Tool success, process exit, and model claims are never conflated; the verification
 *   ledger records evidence types separately.
 * - Stop control has a bounded rework budget and repeated-failure detection so a Stop
 *   loop cannot spin forever.
 */

import type { DecisionAnswer, DecisionService } from "../../core/systemone/decision-service.ts";
import { boolAnswer, type choiceAnswer, scoreAnswer } from "../../core/systemone/decision-service.ts";

/** Evidence kinds recorded distinctly; "tool said ok" is never proof of acceptance. */
export type EvidenceKind =
	| "test-run"
	| "build-run"
	| "static-check"
	| "interface-result"
	| "artifact-inspection"
	| "model-claim";

export interface EvidenceEntry {
	kind: EvidenceKind;
	/** Human summary shown in reports. */
	summary: string;
	/** Content digest of the artifact the evidence binds to. */
	artifactDigest?: string;
	/** True when the check actually passed. */
	passed: boolean;
	timestamp: number;
	/** Invalidated by later modifications; stale evidence never supports completion. */
	stale?: boolean;
}

export class VerificationLedger {
	private entries: EvidenceEntry[] = [];
	private reworkBudget = 3;
	private consecutiveFailures = 0;

	record(entry: EvidenceEntry): void {
		this.entries.push(entry);
		if (!entry.passed) this.consecutiveFailures++;
		else this.consecutiveFailures = 0;
	}

	/** Invalidate evidence bound to artifacts changed by later modifications. */
	invalidate(artifactDigests: string[]): void {
		const stale = new Set(artifactDigests);
		for (const entry of this.entries) {
			if (entry.artifactDigest !== undefined && stale.has(entry.artifactDigest)) entry.stale = true;
		}
	}

	fresh(): EvidenceEntry[] {
		return this.entries.filter((e) => !e.stale);
	}

	/** Coverage facts for the System One coverage question. */
	coverageFacts(): Record<string, boolean> {
		const fresh = this.fresh();
		const has = (kind: EvidenceKind) => fresh.some((e) => e.kind === kind && e.passed);
		return {
			tests_passed: has("test-run"),
			build_passed: has("build-run"),
			static_checks_passed: has("static-check"),
			artifact_inspected: has("artifact-inspection"),
			any_failed_check: fresh.some((e) => !e.passed),
		};
	}

	/** Bounded rework: budget exhaustion or repeated failures stop the loop. */
	get reworkRemaining(): number {
		return this.reworkBudget;
	}

	consumeRework(): void {
		this.reworkBudget = Math.max(0, this.reworkBudget - 1);
	}

	get failureStreak(): number {
		return this.consecutiveFailures;
	}
}

export interface StopDecision {
	action: "settle" | "continue";
	/** Follow-up instruction when continuing. */
	reason?: string;
}

/**
 * Stop control at the settle boundary. Deterministic rules first (failed checks must not
 * settle as success; budget exhaustion settles with an accurate status), then System One
 * judges coverage vs gaps.
 */
export async function stopControl(options: {
	ledger: VerificationLedger;
	decisionService: DecisionService | undefined;
	goal: string;
	lastAssistantText: string | null;
}): Promise<StopDecision> {
	const { ledger, decisionService, goal, lastAssistantText } = options;

	// Deterministic floor 1: failed fresh checks demand at least one rework pass,
	// but repeated failures must not spin: after 3 consecutive failures settle honestly.
	if (ledger.failureStreak >= 3) {
		return {
			action: "settle",
			reason: "repeated verification failures; settling with an accurate status report",
		};
	}
	if (ledger.fresh().some((e) => !e.passed)) {
		if (ledger.reworkRemaining <= 0) {
			return { action: "settle", reason: "rework budget exhausted with failing checks" };
		}
		ledger.consumeRework();
		return { action: "continue", reason: "verification found failing checks; fix them before finishing" };
	}

	if (!decisionService) return { action: "settle" };

	const coverage = ledger.coverageFacts();
	const result = await decisionService.ask({
		domain: "verification-stop",
		goal,
		state: {
			goal,
			last_assistant_summary: (lastAssistantText ?? "").slice(0, 2000),
			coverage,
			rework_budget: ledger.reworkRemaining,
		},
		questions: {
			gaps: {
				type: "bool",
				instructions:
					"Given the goal and coverage facts, does the work still have a material verification gap that one more pass would close?",
				criteria: { true: "a concrete gap a rework pass can close", false: "no material gap" },
			},
		},
		evidenceDigest: undefined,
	});

	const gap = boolAnswer(result.answers, "gaps");
	if (result.stopReason === "stop" && gap && gap.probability >= 0.6 && ledger.reworkRemaining > 0) {
		ledger.consumeRework();
		return {
			action: "continue",
			reason: "System One flagged an open verification gap; run one more focused pass",
		};
	}
	return { action: "settle" };
}

export interface EvidenceFilterResult {
	/** Filtered excerpt the model sees. */
	excerpt: string;
	/** Number of chunks kept out of the total. */
	kept: number;
	total: number;
}

/**
 * Evidence filtering for large tool outputs before they reach the main model. Split into
 * chunks, score relevance to the goal in one batched decision, keep the relevant ones,
 * and always report what was filtered out (no silent truncation).
 */
export async function filterEvidence(options: {
	decisionService: DecisionService | undefined;
	goal: string;
	output: string;
	chunkChars?: number;
	maxChunks?: number;
	signal?: AbortSignal;
}): Promise<EvidenceFilterResult> {
	const { decisionService, goal, output } = options;
	const chunkChars = options.chunkChars ?? 1600;
	const maxChunks = options.maxChunks ?? 8;

	const chunks: string[] = [];
	for (let i = 0; i < output.length && chunks.length < maxChunks; i += chunkChars) {
		chunks.push(output.slice(i, i + chunkChars));
	}
	if (chunks.length === 0) return { excerpt: output, kept: 0, total: 0 };

	// Low-overhead path: small outputs pass through untouched.
	if (chunks.length <= 2) return { excerpt: output, kept: chunks.length, total: chunks.length };

	if (!decisionService) {
		// No decision service: pass through head and tail with an omission note.
		const head = chunks.slice(0, 2).join("\n");
		return {
			excerpt: `${head}\n[… ${chunks.length - 2} of ${chunks.length} chunks unfiltered; decision service inactive …]`,
			kept: 2,
			total: chunks.length,
		};
	}

	const questions: Record<string, { type: "score"; instructions: string; criteria: string[] }> = {};
	for (let i = 0; i < chunks.length; i++) {
		questions[`chunk_${i}`] = {
			type: "score",
			instructions: `Chunk ${i}: how relevant is this output to the current goal?`,
			criteria: ["irrelevant to the goal", "background context", "directly relevant evidence"],
		};
	}

	const result = await decisionService.ask({
		domain: "evidence-filter",
		goal,
		state: { goal, chunks: chunks.map((c) => c.slice(0, 600)) },
		questions,
		signal: options.signal,
	});

	if (result.stopReason !== "stop") {
		// Filter failure keeps the original: recommendations may fail, evidence may not be lost.
		return { excerpt: output, kept: chunks.length, total: chunks.length };
	}

	const kept: string[] = [];
	let keptCount = 0;
	for (let i = 0; i < chunks.length; i++) {
		const score = scoreAnswer(result.answers, `chunk_${i}`);
		if (score && score.score >= 1.5) {
			kept.push(chunks[i]);
			keptCount++;
		}
	}
	if (keptCount === 0) {
		// Nothing scored relevant: keep the first chunk and say why.
		return {
			excerpt: `${chunks[0]}\n[… ${chunks.length - 1} chunks scored below the relevance floor …]`,
			kept: 1,
			total: chunks.length,
		};
	}
	const omitted = chunks.length - keptCount;
	return {
		excerpt:
			omitted > 0
				? `${kept.join("\n")}\n[… ${omitted} of ${chunks.length} chunks filtered as irrelevant …]`
				: kept.join("\n"),
		kept: keptCount,
		total: chunks.length,
	};
}

/**
 * Skill-selection advice from the catalog. Explicit-only skills are excluded before any
 * scoring; the decision ranks the remaining candidates for implicit loading.
 */
export async function selectSkills(options: {
	decisionService: DecisionService | undefined;
	goal: string;
	candidates: Array<{ name: string; description: string; invocationPolicy: "explicit-only" | "implicit-allowed" }>;
	signal?: AbortSignal;
}): Promise<{ recommended: string[]; fromDecision: boolean }> {
	const { decisionService, goal, candidates } = options;
	const eligible = candidates.filter((c) => c.invocationPolicy === "implicit-allowed" && c.description);
	if (eligible.length === 0 || !decisionService) return { recommended: [], fromDecision: false };

	const questions: Record<string, { type: "bool"; instructions: string; criteria: { true: string; false: string } }> =
		{};
	for (const candidate of eligible.slice(0, 16)) {
		questions[candidate.name] = {
			type: "bool",
			instructions: `Skill "${candidate.name}": ${candidate.description}. Is it relevant to the current goal?`,
			criteria: { true: "relevant to the goal", false: "not relevant" },
		};
	}

	const result = await decisionService.ask({
		domain: "skill-selection",
		goal,
		state: { goal },
		questions,
		signal: options.signal,
	});
	if (result.stopReason !== "stop") return { recommended: [], fromDecision: false };

	const recommended = eligible
		.map((c) => ({ name: c.name, answer: boolAnswer(result.answers, c.name) }))
		.filter((c) => c.answer && c.answer.probability >= 0.6)
		.map((c) => c.name);
	return { recommended, fromDecision: true };
}

/**
 * Delegation advice for subtasks: whether to delegate at all, and the role fit of the
 * candidate. Deterministic scheduling (ownership, concurrency) stays with the scheduler.
 */
export async function adviseDelegation(options: {
	decisionService: DecisionService | undefined;
	goal: string;
	subtask: string;
	candidateRole: string;
	signal?: AbortSignal;
}): Promise<{ delegate: boolean; roleFit: number } | undefined> {
	const { decisionService, goal, subtask, candidateRole } = options;
	if (!decisionService) return undefined;
	const result = await decisionService.ask({
		domain: "subtask-delegation",
		goal,
		state: { goal, subtask, candidate_role: candidateRole },
		questions: {
			value: {
				type: "bool",
				instructions:
					"Is delegating this subtask to a separate agent worth the coordination cost? Consider isolation, parallelism, and context separation.",
				criteria: { true: "worth delegating", false: "keep in the main thread" },
			},
			fit: {
				type: "score",
				instructions: "How well does the candidate role fit the subtask?",
				criteria: ["poor fit", "acceptable", "strong fit"],
			},
		},
		signal: options.signal,
	});
	if (result.stopReason !== "stop") return undefined;
	const value = boolAnswer(result.answers, "value");
	const fit = scoreAnswer(result.answers, "fit");
	if (!value) return undefined;
	return { delegate: value.probability >= 0.6, roleFit: fit?.score ?? 0 };
}

export type { DecisionAnswer, choiceAnswer };
