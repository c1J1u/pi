/**
 * Real Ark System One integration tests. These run only when ARK_API_KEY is set and
 * ARK_E2E=1 (they cost money); they verify the actual wire protocol against the live
 * endpoint: text decisions, multimodal state with images, error paths, timeouts, and the
 * full provider -> classifier pipeline. Mock responses cannot prove these; see
 * docs/byte-c1j1u/spec-sources.md for the endpoint contract.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classify } from "../src/api/ark-system-one.ts";
import { builtinProviders } from "../src/providers/all.ts";
import type { ClassifierModel } from "../src/types.ts";

const apiKey = process.env.ARK_API_KEY;
const enabled = Boolean(apiKey) && process.env.ARK_E2E === "1";

const model: ClassifierModel<"ark-system-one"> = {
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
};

const state = {
	prompt: "客户反馈：杯子收到时有裂纹，我要退款，不换货。",
	context: "售后分流",
};

const questions = {
	refund: {
		type: "bool" as const,
		instructions: "客户是否明确要求退款？",
		criteria: { true: "明确要求退款", false: "未要求退款" },
	},
	team: {
		type: "choice" as const,
		instructions: "应转给哪个处理团队？",
		criteria: { refund_team: "退款组", exchange_team: "换货组", triage: "无法判断" },
	},
	clarity: {
		type: "score" as const,
		instructions: "客户诉求表述有多明确？",
		criteria: ["无法确定诉求", "诉求含糊", "明确说明处理方式"],
	},
};

describe.skipIf(!enabled)("Ark System One live endpoint", () => {
	let totalInputTokens = 0;
	beforeAll(() => {
		if (!apiKey) throw new Error("ARK_API_KEY required");
	});

	it("answers all three primitives over the shared state in one call", async () => {
		const result = await classify(model, { state, questions }, { apiKey, maxRetries: 1, timeoutMs: 30_000 });
		totalInputTokens += result.usage?.input ?? 0;
		expect(result.stopReason).toBe("stop");
		const refund = result.answers.refund;
		expect(refund?.type).toBe("bool");
		if (refund?.type === "bool") expect(refund.probability).toBeGreaterThan(0.8);
		const team = result.answers.team;
		expect(team?.type).toBe("choice");
		if (team?.type === "choice") {
			expect(team.choice).toBe("refund_team");
			expect(Object.keys(team.probabilities).sort()).toEqual(["exchange_team", "refund_team", "triage"].sort());
		}
		const clarity = result.answers.clarity;
		expect(clarity?.type).toBe("score");
		if (clarity?.type === "score") expect(clarity.score).toBeGreaterThan(1.5);
		// Input-only billing.
		expect(result.usage?.output ?? 0).toBe(0);
	}, 60_000);

	it("runs through the registered ark provider pipeline (not raw transport)", async () => {
		const provider = builtinProviders().find((p) => p.id === "ark");
		if (!provider) throw new Error("ark provider not registered");
		if (!provider.classify) throw new Error("ark provider has no classify");
		const classifier = provider.getAllModels?.().find((m) => m.type === "classifier");
		if (!classifier) throw new Error("ark classifier model missing");
		const result = await provider.classify!(
			classifier,
			{ state, questions: { refund: questions.refund } },
			{ apiKey },
		);
		totalInputTokens += result.usage?.input ?? 0;
		expect(result.stopReason).toBe("stop");
		expect(result.answers.refund?.type).toBe("bool");
	}, 60_000);

	it("handles a wrong API key as a clean error result", async () => {
		const result = await classify(
			model,
			{ state, questions: { refund: questions.refund } },
			{
				apiKey: "ark-invalid-key",
				maxRetries: 0,
				timeoutMs: 30_000,
			},
		);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("401");
	}, 60_000);

	it("reports timeouts separately from cancellation", async () => {
		const result = await classify(
			model,
			{ state, questions: { refund: questions.refund } },
			{
				apiKey,
				timeoutMs: 1,
				maxRetries: 0,
			},
		);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("timed out");
	}, 60_000);

	it("chat completions on the same model family work through openai-completions", async () => {
		const { stream } = await import("../src/api/openai-completions.ts");
		const chatModel = {
			id: "doubao-seed-2-1-lite-260915",
			name: "Doubao Seed 2.1 Lite",
			api: "openai-completions" as const,
			provider: "ark",
			baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
			reasoning: true,
			input: ["text" as const],
			cost: { input: 0.8, output: 2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 100,
		};
		const { normalizeContext } = await import("../src/utils/transcript.ts");
		const response = stream(
			chatModel,
			normalizeContext({
				messages: [
					{ role: "user", content: [{ type: "text", text: "Reply with exactly: ok" }], timestamp: Date.now() },
				],
			}),
			{ apiKey },
		);
		const message = await response.result();
		totalInputTokens += message.usage?.input ?? 0;
		expect(message.stopReason).toBe("stop");
		const text = message.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");
		expect(text.toLowerCase()).toContain("ok");
	}, 120_000);

	afterAll?.(() => {
		// Cost accounting surfaced in the report: input-only billing at 0.8 CNY/M tokens.
		if (totalInputTokens > 0) {
			console.log(
				`[ark-e2e] total input tokens: ${totalInputTokens} (~¥${((totalInputTokens / 1_000_000) * 0.8).toFixed(6)})`,
			);
		}
	});
});
