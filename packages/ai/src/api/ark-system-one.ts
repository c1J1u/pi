import type { ClassifierFunction, ClassifierOptions, JsonObject } from "../types.ts";
import { classifySystemOne, type SystemOneTransport } from "./system-one-shared.ts";

/**
 * Volcengine Ark's System One endpoint. Doubao Seed 2.1 Lite serves the Jev-compatible System One
 * protocol behind `POST {baseUrl}/api/v1/systemone` with the beta header
 * `ark-beta-systemone-api: true`. Pure-text requests are wire-compatible with the TypeSafe
 * System One transport; Ark additionally accepts multimodal `state` arrays (text/image/audio/
 * video blocks), which the shared TypeSafe transport does not support.
 */

const BETA_HEADER = "ark-beta-systemone-api";

type StateContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; image_url: string }
	| { type: "audio"; audio_url: string }
	| { type: "video"; video_url: string; fps?: number };

function imageContentBlock(image: { data: string; mimeType: string }): StateContentBlock {
	return { type: "image", image_url: `data:${image.mimeType};base64,${image.data}` };
}

/**
 * Ark accepts either a JSON value or an array of content blocks as `state`. Text-only states use
 * the JSON object (matching the Jev-compatible wire format); images are carried as inline content
 * blocks after the state text.
 */
function arkState(
	state: JsonObject,
	images: readonly { data: string; mimeType: string }[],
): JsonObject | StateContentBlock[] {
	if (images.length === 0) return state;
	return [{ type: "text", text: JSON.stringify(state) }, ...images.map(imageContentBlock)];
}

const transport: SystemOneTransport = {
	api: "ark-system-one",
	label: "Ark System One API",
	supportsImages: true,
	// `new URL(path, base)` drops the last base segment, so append the path to a trimmed base
	// instead of resolving it relative: baseUrl "…/api/v1" must yield "…/api/v1/systemone".
	url: (model) => new URL(`${model.baseUrl.replace(/\/+$/u, "")}/systemone`),
	payload: (model, request) => ({
		model: model.id,
		state: arkState(request.state, request.images ?? []),
		questions: request.questions,
	}),
	output: (body) => {
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			throw new Error("Ark System One API returned an unexpected response");
		}
		return body as Record<string, unknown>;
	},
};

/** Ark System One classification with the beta header and multimodal state support. */
export const classify: ClassifierFunction<ClassifierOptions> = (model, context, options) =>
	// The beta header rides on the model's own headers so it survives the shared transport's
	// header merge (provider defaults < model.headers < options.headers).
	classifySystemOne(transport, { ...model, headers: { [BETA_HEADER]: "true", ...model.headers } }, context, options);
