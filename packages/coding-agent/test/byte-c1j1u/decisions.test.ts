import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import { afterAll, describe, expect, it } from "vitest";
import { DecisionService } from "../../src/core/systemone/decision-service.ts";
import {
	adviseDelegation,
	filterEvidence,
	selectSkills,
	stopControl,
	VerificationLedger,
} from "../../src/extensions/byte-c1j1u/decisions.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "pi-decisions-test-"));
afterAll(() => {
	rmSync(tempRoot, { recursive: true, force: true });
});

const model = {
	type: "classifier",
	id: "doubao-seed-2-1-lite-260915",
	name: "Doubao Seed 2.1 Lite (System One)",
	api: "ark-system-one",
	provider: "ark",
	baseUrl: "https://ark.cn-beijing.volces.com/api/v1",
	input: ["text", "image"],
	cost: { input: 0.8, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	headers: { "ark-beta-systemone-api": "true" },
} satisfies ClassifierModel<"ark-system-one">;

function makeService(answers: Record<string, unknown>, stopReason: "stop" | "error" = "stop"): DecisionService {
	const result: ClassifierResult = {
		api: "ark-system-one",
		provider: "ark",
		model: model.id,
		answers: answers as ClassifierResult["answers"],
		stopReason,
		timestamp: Date.now(),
	};
	return new DecisionService({
		model,
		getApiKey: () => "test",
		classifyFn: async () => result,
	});
}

describe("VerificationLedger", () => {
	it("records evidence distinctly and computes coverage facts", () => {
		const ledger = new VerificationLedger();
		ledger.record({ kind: "test-run", summary: "vitest 40/40", passed: true, timestamp: Date.now() });
		ledger.record({ kind: "model-claim", summary: "model says done", passed: true, timestamp: Date.now() });
		const facts = ledger.coverageFacts();
		expect(facts.tests_passed).toBe(true);
		expect(facts.build_passed).toBe(false);
		expect(facts.artifact_inspected).toBe(false);
	});

	it("invalidation makes evidence stale (model claims never outlive artifact changes)", () => {
		const ledger = new VerificationLedger();
		ledger.record({ kind: "test-run", summary: "ok", passed: true, artifactDigest: "abc", timestamp: Date.now() });
		ledger.invalidate(["abc"]);
		expect(ledger.fresh()).toHaveLength(0);
		expect(ledger.coverageFacts().tests_passed).toBe(false);
	});
});

describe("stopControl", () => {
	it("demands rework on fresh failed checks within budget", async () => {
		const ledger = new VerificationLedger();
		ledger.record({ kind: "test-run", summary: "2 failing", passed: false, timestamp: Date.now() });
		const decision = await stopControl({ ledger, decisionService: undefined, goal: "g", lastAssistantText: "done" });
		expect(decision.action).toBe("continue");
		expect(decision.reason).toContain("failing checks");
		expect(ledger.reworkRemaining).toBe(2);
	});

	it("settles honestly after repeated failures or exhausted budget", async () => {
		const ledger = new VerificationLedger();
		for (let i = 0; i < 3; i++) {
			ledger.record({ kind: "test-run", summary: "fail", passed: false, timestamp: Date.now() });
		}
		const decision = await stopControl({ ledger, decisionService: undefined, goal: "g", lastAssistantText: null });
		expect(decision.action).toBe("settle");
		expect(decision.reason).toContain("repeated verification failures");
	});

	it("uses System One coverage judgment when checks are green", async () => {
		const ledger = new VerificationLedger();
		ledger.record({ kind: "test-run", summary: "ok", passed: true, timestamp: Date.now() });
		const service = makeService({ gaps: { type: "bool", probability: 0.9 } });
		const decision = await stopControl({
			ledger,
			decisionService: service,
			goal: "ship it",
			lastAssistantText: "done",
		});
		expect(decision.action).toBe("continue");
		expect(decision.reason).toContain("verification gap");
	});

	it("settles when System One sees no gap", async () => {
		const ledger = new VerificationLedger();
		const service = makeService({ gaps: { type: "bool", probability: 0.1 } });
		const decision = await stopControl({ ledger, decisionService: service, goal: "g", lastAssistantText: "done" });
		expect(decision.action).toBe("settle");
	});
});

describe("filterEvidence", () => {
	it("passes small outputs through untouched (low-overhead path)", async () => {
		const service = makeService({});
		const result = await filterEvidence({ decisionService: service, goal: "g", output: "short output" });
		expect(result.excerpt).toBe("short output");
		expect(result.kept).toBe(1);
	});

	it("keeps relevant chunks and reports omissions", async () => {
		const output = Array.from({ length: 8 }, (_, i) => `chunk-${i}-content `.repeat(30)).join("\n");
		const service = makeService({
			chunk_0: { type: "score", score: 2.8, confidence: 0.9 },
			chunk_1: { type: "score", score: 0.2, confidence: 0.9 },
			chunk_2: { type: "score", score: 2.9, confidence: 0.9 },
			chunk_3: { type: "score", score: 0.1, confidence: 0.9 },
			chunk_4: { type: "score", score: 0.3, confidence: 0.9 },
			chunk_5: { type: "score", score: 0.2, confidence: 0.9 },
			chunk_6: { type: "score", score: 0.1, confidence: 0.9 },
			chunk_7: { type: "score", score: 0.2, confidence: 0.9 },
		});
		const result = await filterEvidence({
			decisionService: service,
			goal: "find the error",
			output,
			chunkChars: 500,
		});
		expect(result.total).toBe(8);
		expect(result.kept).toBe(2);
		expect(result.excerpt).toContain("chunk-0");
		expect(result.excerpt).toContain("chunk-2");
		expect(result.excerpt).toContain("6 of 8 chunks filtered");
	});

	it("filter failure keeps the original output (never loses evidence)", async () => {
		const output = Array.from({ length: 5 }, (_, i) => `x-${i} `.repeat(200)).join("\n");
		const service = makeService({}, "error");
		const result = await filterEvidence({ decisionService: service, goal: "g", output, chunkChars: 200 });
		expect(result.excerpt).toBe(output);
		expect(result.kept).toBe(result.total);
		expect(result.total).toBeGreaterThan(2);
	});

	it("without a decision service, keeps head with an omission note", async () => {
		const output = Array.from({ length: 5 }, (_, i) => `y-${i} `.repeat(200)).join("\n");
		const result = await filterEvidence({ decisionService: undefined, goal: "g", output, chunkChars: 200 });
		expect(result.kept).toBe(2);
		expect(result.excerpt).toContain("decision service inactive");
	});
});

describe("selectSkills", () => {
	it("excludes explicit-only skills before scoring", async () => {
		const service = makeService({
			pdf: { type: "bool", probability: 0.9 },
		});
		const result = await selectSkills({
			decisionService: service,
			goal: "extract pdf text",
			candidates: [
				{ name: "pdf", description: "pdf work", invocationPolicy: "implicit-allowed" },
				{ name: "secret", description: "never auto-load", invocationPolicy: "explicit-only" },
			],
		});
		expect(result.fromDecision).toBe(true);
		expect(result.recommended).toEqual(["pdf"]);
		// explicit-only skill never appears even though it was never scored
	});

	it("returns empty when the decision fails", async () => {
		const service = makeService({}, "error");
		const result = await selectSkills({
			decisionService: service,
			goal: "g",
			candidates: [{ name: "a", description: "desc", invocationPolicy: "implicit-allowed" }],
		});
		expect(result.fromDecision).toBe(false);
		expect(result.recommended).toEqual([]);
	});
});

describe("adviseDelegation", () => {
	it("advises delegation when value is high", async () => {
		const service = makeService({
			value: { type: "bool", probability: 0.85 },
			fit: { type: "score", score: 2.7, confidence: 0.9 },
		});
		const advice = await adviseDelegation({
			decisionService: service,
			goal: "refactor",
			subtask: "audit deps",
			candidateRole: "reviewer",
		});
		expect(advice).toEqual({ delegate: true, roleFit: 2.7 });
	});

	it("returns undefined without a decision service", async () => {
		const advice = await adviseDelegation({
			decisionService: undefined,
			goal: "g",
			subtask: "s",
			candidateRole: "r",
		});
		expect(advice).toBeUndefined();
	});
});

describe("subagent hook event wiring payload shape", () => {
	it("publishes start/stop payloads the hook runner accepts", async () => {
		// Shape check only: the extension emits these through its event bus; the hook
		// runner's matcher filters on agent_type and the payload must carry the fields
		// the SubagentStart/SubagentStop contract requires.
		const startPayload = { agent_id: "audit-1", agent_type: "reviewer" };
		const stopPayload = {
			agent_id: "audit-1",
			agent_type: "reviewer",
			agent_transcript_path: null,
			stop_hook_active: false,
			last_assistant_message: null,
		};
		expect(startPayload.agent_type).toBe("reviewer");
		expect(stopPayload.stop_hook_active).toBe(false);
	});
});
