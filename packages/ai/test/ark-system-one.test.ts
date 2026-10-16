import { describe, expect, it, vi } from "vitest";
import { classify } from "../src/api/ark-system-one.ts";
import type { ClassifierContext, ClassifierModel } from "../src/types.ts";

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

const context: ClassifierContext = {
	state: { text: "客户反馈：杯子收到时有裂纹，我要退款，不换货。" },
	questions: {
		refund_requested: {
			type: "bool",
			instructions: "客户是否明确要求退款？",
			criteria: { true: "要求退款", false: "未要求退款" },
		},
		intent: {
			type: "choice",
			instructions: "客户的主要诉求是什么？",
			criteria: { refund: "退款", exchange: "换货", other: "其他" },
		},
		clarity: {
			type: "score",
			instructions: "客户诉求表述有多明确？",
			criteria: ["无法确定诉求", "诉求含糊", "明确说明处理方式"],
		},
	},
};

/** Wire shape observed from the live endpoint on 2026-10-16. */
const wireAnswers = {
	refund_requested: { type: "noul", noul: 0.9999 },
	intent: {
		type: "choice",
		choice: "refund",
		probabilities: { refund: 0.9997, exchange: 0.0002, other: 0.00003 },
		confidence: 0.9977,
	},
	clarity: { type: "score", score: 1.9999, confidence: 0.9999 },
};

describe("Ark System One", () => {
	it("posts to /api/v1/systemone with the beta header and noul wire questions", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			expect(String(_input)).toBe("https://ark.cn-beijing.volces.com/api/v1/systemone");
			const headers = new Headers(init?.headers);
			expect(headers.get("ark-beta-systemone-api")).toBe("true");
			expect(headers.get("authorization")).toBe("Bearer secret");
			const payload = JSON.parse(String(init?.body)) as {
				model: string;
				state: unknown;
				questions: Record<string, { type: string }>;
			};
			expect(payload.model).toBe("doubao-seed-2-1-lite-260915");
			expect(payload.state).toEqual(context.state);
			expect(payload.questions.refund_requested?.type).toBe("noul");
			expect(payload.questions.intent?.type).toBe("choice");
			expect(payload.questions.clarity?.type).toBe("score");
			return Response.json({ answers: wireAnswers, usage: { input_tokens: 446, output_tokens: 0 } });
		});

		const result = await classify(model, context, { apiKey: "secret", fetch });

		expect(fetch).toHaveBeenCalledOnce();
		expect(result.stopReason).toBe("stop");
		expect(result.answers.refund_requested).toEqual({ type: "bool", probability: 0.9999 });
		expect(result.answers.intent).toMatchObject({ type: "choice", choice: "refund" });
		expect(result.answers.clarity).toEqual({ type: "score", score: 1.9999, confidence: 0.9999 });
		// Output tokens are free on System One; usage reports input only, priced from the catalog.
		expect(result.usage).toMatchObject({ input: 446, output: 0 });
	});

	it("adds the beta header even when the model definition omits it", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			expect(new Headers(init?.headers).get("ark-beta-systemone-api")).toBe("true");
			return Response.json({ answers: wireAnswers });
		});
		const result = await classify({ ...model, headers: undefined }, context, { apiKey: "secret", fetch });

		expect(result.stopReason).toBe("stop");
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("keeps model-defined headers alongside the injected beta header", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			expect(headers.get("ark-beta-systemone-api")).toBe("true");
			expect(headers.get("x-custom")).toBe("model");
			return Response.json({ answers: wireAnswers });
		});
		const result = await classify({ ...model, headers: { "x-custom": "model" } }, context, {
			apiKey: "secret",
			fetch,
		});

		expect(result.stopReason).toBe("stop");
	});

	it("folds images into a multimodal state array with the state as leading text", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const payload = JSON.parse(String(init?.body)) as { state: Array<Record<string, unknown>> };
			expect(Array.isArray(payload.state)).toBe(true);
			expect(payload.state[0]).toEqual({ type: "text", text: JSON.stringify(context.state) });
			expect(payload.state[1]).toEqual({ type: "image", image_url: "data:image/png;base64,aW1hZ2U=" });
			return Response.json({ answers: wireAnswers });
		});
		const result = await classify(
			model,
			{ ...context, images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] },
			{ apiKey: "secret", fetch },
		);

		expect(result.stopReason).toBe("stop");
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("rejects models for other classifier APIs", async () => {
		const fetch = vi.fn(async () => Response.json({ answers: wireAnswers }));
		const result = await classify({ ...model, api: "typesafe-system-one" }, context, {
			apiKey: "secret",
			fetch,
		});

		expect(fetch).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Unsupported classifier API: typesafe-system-one");
	});

	it("reports HTTP errors with the Ark label", async () => {
		const result = await classify(model, context, {
			apiKey: "secret",
			maxRetries: 0,
			fetch: async () => new Response("no auth", { status: 401 }),
		});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Ark System One API error (401)");
	});

	it("returns missing answers as classifier errors while keeping billed usage", async () => {
		const result = await classify(model, context, {
			apiKey: "secret",
			fetch: async () => Response.json({ answers: { intent: wireAnswers.intent }, usage: { input_tokens: 100 } }),
		});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("did not return an answer for refund_requested");
		expect(result.usage).toMatchObject({ input: 100 });
	});

	it("rejects non-finite probabilities as errors", async () => {
		const result = await classify(model, context, {
			apiKey: "secret",
			fetch: async () =>
				Response.json({
					answers: { ...wireAnswers, refund_requested: { type: "noul", noul: "yes" } },
				}),
		});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("invalid probability");
	});

	it("marks caller cancellation as aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await classify(model, context, {
			apiKey: "secret",
			signal: controller.signal,
			fetch: async () => {
				throw new Error("unreachable");
			},
		});

		expect(result.stopReason).toBe("aborted");
	});

	it("marks request timeouts as errors", async () => {
		const result = await classify(model, context, {
			apiKey: "secret",
			timeoutMs: 5,
			maxRetries: 0,
			fetch: async (_input, init) => {
				const signal = init?.signal;
				if (!signal) throw new Error("missing request signal");
				return new Promise<Response>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			},
		});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Request timed out after 5ms");
	});
});
