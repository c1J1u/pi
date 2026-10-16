import type { ProviderClassifier } from "../types.ts";

export const arkSystemOneApi = (): ProviderClassifier => ({
	classify: async (model, context, options) => (await import("./ark-system-one.ts")).classify(model, context, options),
});
