import { arkSystemOneApi } from "../api/ark-system-one.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { ARK_CLASSIFIER_MODELS, ARK_MODELS } from "./ark.models.ts";

export function arkProvider(): Provider<"openai-completions"> {
	return createProvider<"openai-completions">({
		id: "ark",
		name: "Volcengine Ark",
		baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
		auth: { apiKey: envApiKeyAuth("Ark API key", ["ARK_API_KEY"]) },
		models: [...Object.values(ARK_MODELS), ...Object.values(ARK_CLASSIFIER_MODELS)],
		api: openAICompletionsApi(),
		// Ark serves the Jev-compatible System One protocol at /api/v1/systemone behind the
		// ark-beta-systemone-api header (carried on the classifier model's headers).
		classifiers: { "ark-system-one": arkSystemOneApi() },
	});
}
