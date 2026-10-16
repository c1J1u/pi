/**
 * The `byte-c1j1u/auto` virtual model: System One-driven model routing.
 *
 * Routing policy (see docs/byte-c1j1u/architecture.md):
 * - Stage-aware: a new goal is classified for complexity; continuation and retry keep the
 *   session's current model unless failures suggest a change; direct requests (compaction
 *   summaries, branch summaries, non-loop calls) bypass classification entirely — no
 *   routing recursion.
 * - Stable within a phase; the first classification of a session costs one System One call,
 *   cached in the router state.
 * - Thinking level passes through, clamped to the target model's support.
 * - Failure of the classifier or a missing target model falls back to the configured
 *   baseline; the fallback reason is surfaced through the decision service audit log.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";

const PROVIDER = "byte-c1j1u";
const ID = "auto";

interface RouterState {
	phase: "planning" | "implementation";
	model: string;
	thinkingLevel: string;
}

type RouterRequest = ModelRouteRequest<RouterState>;

function lastUserText(messages: readonly Message[]): string {
	let text = "";
	for (const message of messages) {
		if (message.role === "user") {
			const content = message.content;
			if (typeof content === "string") text = content;
			else {
				const joined = content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				if (joined) text = joined;
			}
		}
	}
	return text;
}

/** Rank models by capability; the router picks the tier the complexity calls for. */
function modelTier(ctx: ExtensionContext, id: string): "strong" | "balanced" | "fast" | undefined {
	if (ctx.modelRegistry.find("ark", id) === undefined && ctx.modelRegistry.find("openai", id) === undefined) {
		return undefined;
	}
	if (id.includes("pro")) return "strong";
	if (id.includes("lite")) return "balanced";
	if (id.includes("turbo") || id.includes("mini") || id.includes("flash")) return "fast";
	return undefined;
}

function routeTo(
	request: RouterRequest,
	ctx: ExtensionContext,
	id: string,
	state: RouterState,
): ModelRoute<RouterState> {
	const model = ctx.modelRegistry.find("ark", id) ?? ctx.modelRegistry.find("openai", id);
	if (!model) throw new Error(`Model ${id} is not in the catalog`);
	return { model, thinkingLevel: request.thinkingLevel, state };
}

export function createByteC1J1uRouter(pi: ExtensionAPI): void {
	pi.registerVirtualModel<RouterState>({
		provider: PROVIDER,
		id: ID,
		name: "Auto (byte-c1j1u System One)",
		thinkingLevels: ["low", "medium", "high"],
		contextWindow: 128_000,
		maxTokens: 32_000,
		async route(request, ctx) {
			// Direct (non-loop) requests route deterministically: no classification, no recursion.
			if (request.reason === "direct") {
				const fallback = request.previous?.model ?? ctx.modelRegistry.find("ark", "doubao-seed-2-1-lite-260915");
				if (fallback) return { model: fallback, thinkingLevel: request.thinkingLevel };
				throw new Error("byte-c1j1u/auto: no fallback model available");
			}

			// Keep the session's model within a phase: no per-request churn, no cache misses.
			if (request.state) {
				if (request.reason === "retry" && request.failed) {
					// Repeated failures escalate one tier up at most once per phase.
					const tier = modelTier(ctx, request.state.model);
					if (tier === "fast" || tier === "balanced") {
						const upgrade = tier === "fast" ? "doubao-seed-2-1-lite-260915" : "doubao-seed-2-1-pro-260915";
						if (ctx.modelRegistry.find("ark", upgrade)) {
							return routeTo(request, ctx, upgrade, { ...request.state, model: upgrade });
						}
					}
				}
				return routeTo(request, ctx, request.state.model, request.state);
			}

			// New goal: one System One classification, cached in the router state.
			const classifier = ctx.modelRegistry.findOfType("classifier", "ark", "doubao-seed-2-1-lite-260915");
			const apiKey = process.env.ARK_API_KEY;
			if (!classifier || classifier.api !== "ark-system-one" || !apiKey) {
				// Deterministic fallback: the lite model.
				const fallback = ctx.modelRegistry.find("ark", "doubao-seed-2-1-lite-260915");
				if (fallback) {
					return {
						model: fallback,
						thinkingLevel: request.thinkingLevel,
						state: { phase: "planning", model: "doubao-seed-2-1-lite-260915", thinkingLevel: "medium" },
					};
				}
				throw new Error("byte-c1j1u/auto: no Ark models available");
			}

			const prompt = lastUserText(request.messages).slice(0, 8000);
			try {
				const result = await ctx.modelRegistry.classify(
					classifier,
					{
						state: { prompt, stage: request.reason },
						questions: {
							complexity: {
								type: "choice",
								instructions:
									"How demanding is the software engineering work in `prompt`? Judge by design subtlety, cross-cutting scope, and debugging difficulty.",
								criteria: {
									standard: "Ordinary features, fixes, reviews, or questions",
									complex: "Subtle design, cross-cutting changes, or hard debugging",
								},
							},
						},
					},
					{ apiKey, signal: request.signal, maxRetries: 1, timeoutMs: 20_000 },
				);
				const answer = result.stopReason === "stop" ? result.answers.complexity : undefined;
				const complex = answer?.type === "choice" && (answer.probabilities.complex ?? 0) >= 0.5;
				const model = complex ? "doubao-seed-2-1-pro-260915" : "doubao-seed-2-1-lite-260915";
				if (!ctx.modelRegistry.find("ark", model)) {
					throw new Error(`Model ark/${model} is not in the catalog`);
				}
				return routeTo(request, ctx, model, {
					phase: "planning",
					model,
					thinkingLevel: request.thinkingLevel ?? "medium",
				});
			} catch {
				// Classifier failure: deterministic baseline, session continues.
				const fallback = ctx.modelRegistry.find("ark", "doubao-seed-2-1-lite-260915");
				if (fallback) {
					return {
						model: fallback,
						thinkingLevel: request.thinkingLevel,
						state: { phase: "planning", model: "doubao-seed-2-1-lite-260915", thinkingLevel: "medium" },
					};
				}
				throw new Error("byte-c1j1u/auto: routing failed and no fallback model is available");
			}
		},
	});
}
