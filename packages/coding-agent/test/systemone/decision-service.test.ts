import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ClassifyFn } from "../../src/core/systemone/decision-service.ts";
import { boolAnswer, choiceAnswer, DecisionService, scoreAnswer } from "../../src/core/systemone/decision-service.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "pi-decision-test-"));
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

function stopResult(answers: Record<string, unknown>): ClassifierResult {
	return {
		api: "ark-system-one",
		provider: "ark",
		model: model.id,
		answers: answers as ClassifierResult["answers"],
		stopReason: "stop",
		usage: {
			input: 300,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 300,
			cost: { input: 0.00024, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.00024 },
		},
		timestamp: Date.now(),
	};
}

function makeService(classifyFn: ClassifyFn, options: { policyVersion?: string } = {}) {
	return new DecisionService({
		model,
		getApiKey: () => "test-key",
		classifyFn,
		policyVersion: options.policyVersion,
	});
}

const request = {
	domain: "skill-selection",
	goal: "Fix the failing PDF export test",
	state: { prompt: "Fix the failing PDF export test", stage: "planning" },
	questions: {
		relevant: {
			type: "bool" as const,
			instructions: "Is the pdf-processing skill relevant?",
			criteria: { true: "relevant", false: "not relevant" },
		},
		priority: {
			type: "choice" as const,
			instructions: "Which capability should load first?",
			criteria: { skill: "load the skill", tool: "load the tool", none: "neither" },
		},
	},
	catalogDigest: "abc123",
};

describe("DecisionService", () => {
	it("merges independent questions into one classify call and caches by full key", async () => {
		const classify = vi.fn(async () =>
			stopResult({
				relevant: { type: "bool", probability: 0.94 },
				priority: {
					type: "choice",
					choice: "skill",
					probabilities: { skill: 0.9, tool: 0.08, none: 0.02 },
					confidence: 0.9,
				},
			}),
		);
		const service = makeService(classify);

		const first = await service.ask(request);
		expect(classify).toHaveBeenCalledOnce();
		expect(first.stopReason).toBe("stop");
		expect(first.answers.relevant).toEqual({ type: "bool", probability: 0.94 });

		const second = await service.ask(request);
		expect(second.stopReason).toBe("cache-hit");
		expect(classify).toHaveBeenCalledOnce();

		// Any key component change misses the cache.
		await service.ask({ ...request, catalogDigest: "changed" });
		await service.ask({ ...request, goal: "Different goal" });
		await service.ask({ ...request, questions: { ...request.questions, extra: request.questions.relevant } });
		expect(classify).toHaveBeenCalledTimes(4);
	});

	it("falls back deterministically when no API key is configured", async () => {
		const classify = vi.fn();
		const service = new DecisionService({ model, getApiKey: () => undefined, classifyFn: classify });
		const result = await service.ask(request);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("no Ark API key");
		expect(classify).not.toHaveBeenCalled();
	});

	it("propagates classifier errors without throwing and records them", async () => {
		const classify = vi.fn(
			async () =>
				({
					api: "ark-system-one",
					provider: "ark",
					model: model.id,
					answers: {},
					stopReason: "error",
					errorMessage: "Ark System One API error (500)",
					timestamp: Date.now(),
				}) as ClassifierResult,
		);
		const service = makeService(classify);
		const result = await service.ask(request);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("500");
		const last = service.auditLog().at(-1);
		expect(last?.stopReason).toBe("error");
		expect(last?.domain).toBe("skill-selection");
	});

	it("records fallbacks separately and keeps sanitized audit records", async () => {
		const service = makeService(vi.fn());
		service.recordFallback("model-routing", "router unavailable; kept configured model");
		const last = service.auditLog().at(-1);
		expect(last?.fallback).toContain("kept configured model");
		// Audit records never carry raw state or goal text, only digests.
		expect(JSON.stringify(service.auditLog())).not.toContain("Fix the failing PDF export test");
	});

	it("invalidateCache drops entries", async () => {
		const classify = vi.fn(async () => stopResult({ relevant: { type: "bool", probability: 0.5 } }));
		const service = makeService(classify);
		await service.ask({ ...request, questions: { relevant: request.questions.relevant } });
		service.invalidateCache();
		await service.ask({ ...request, questions: { relevant: request.questions.relevant } });
		expect(classify).toHaveBeenCalledTimes(2);
	});

	it("policy version participates in the cache key", async () => {
		const classify = vi.fn(async () => stopResult({ relevant: { type: "bool", probability: 0.5 } }));
		const a = makeService(classify, { policyVersion: "v1" });
		const b = makeService(classify, { policyVersion: "v2" });
		const req = { ...request, questions: { relevant: request.questions.relevant } };
		await a.ask(req);
		await b.ask(req);
		expect(classify).toHaveBeenCalledTimes(2);
	});
});

describe("answer extraction helpers", () => {
	const answers = {
		flag: { type: "bool" as const, probability: 0.87 },
		pick: {
			type: "choice" as const,
			choice: "tool",
			probabilities: { skill: 0.3, tool: 0.6, none: 0.1 },
			confidence: 0.8,
		},
		rank: { type: "score" as const, score: 1.4, confidence: 0.9 },
	};

	it("boolAnswer extracts probabilities", () => {
		expect(boolAnswer(answers, "flag")).toEqual({ probability: 0.87 });
		expect(boolAnswer(answers, "missing")).toBeUndefined();
	});

	it("choiceAnswer respects the probability floor", () => {
		expect(choiceAnswer(answers, "pick", 0.5)).toEqual({
			choice: "tool",
			probabilities: { skill: 0.3, tool: 0.6, none: 0.1 },
		});
		expect(choiceAnswer(answers, "pick", 0.9)).toBeUndefined();
	});

	it("scoreAnswer extracts scores", () => {
		expect(scoreAnswer(answers, "rank")).toEqual({ score: 1.4 });
	});
});
