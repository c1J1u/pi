import { parse } from "yaml";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import type { OpenAiSkillConfig, OpenAiSkillInterface, OpenAiSkillPolicy, OpenAiSkillToolDependency } from "./types.ts";

/**
 * Parsing for the OpenAI Codex skill overlay `agents/openai.yaml`.
 * See docs/byte-c1j1u/spec-sources.md for the field inventory.
 *
 * Known top-level sections:
 * - interface: display_name, short_description, icon_small, icon_large, brand_color, default_prompt
 * - policy: allow_implicit_invocation (default true)
 * - dependencies: tools[] with type/value/description/transport/url
 *
 * Unknown top-level fields produce diagnostics and are preserved in `config.unknown`.
 */

const KNOWN_TOP_LEVEL_FIELDS: ReadonlySet<string> = new Set(["interface", "policy", "dependencies"]);

const KNOWN_INTERFACE_FIELDS: ReadonlySet<string> = new Set([
	"display_name",
	"short_description",
	"icon_small",
	"icon_large",
	"brand_color",
	"default_prompt",
]);

const KNOWN_POLICY_FIELDS: ReadonlySet<string> = new Set(["allow_implicit_invocation"]);

const KNOWN_TOOL_DEPENDENCY_FIELDS: ReadonlySet<string> = new Set(["type", "value", "description", "transport", "url"]);

export interface ParseOpenAiSkillConfigResult {
	config?: OpenAiSkillConfig;
	diagnostics: ResourceDiagnostic[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInterfaceSection(raw: Record<string, unknown>, diagnostics: ResourceDiagnostic[]): OpenAiSkillInterface {
	const result: OpenAiSkillInterface = {};

	const stringFields: Array<[keyof OpenAiSkillInterface, string]> = [
		["displayName", "display_name"],
		["shortDescription", "short_description"],
		["iconSmall", "icon_small"],
		["iconLarge", "icon_large"],
		["brandColor", "brand_color"],
		["defaultPrompt", "default_prompt"],
	];
	for (const [field, yamlKey] of stringFields) {
		const value = raw[yamlKey];
		if (value === undefined) continue;
		if (typeof value === "string") {
			result[field] = value;
		} else {
			diagnostics.push({
				type: "warning",
				message: `interface.${yamlKey} must be a string; ignoring it`,
			});
		}
	}

	for (const key of Object.keys(raw)) {
		if (!KNOWN_INTERFACE_FIELDS.has(key)) {
			diagnostics.push({ type: "warning", message: `unknown interface field "${key}"` });
		}
	}

	return result;
}

function parsePolicySection(raw: Record<string, unknown>, diagnostics: ResourceDiagnostic[]): OpenAiSkillPolicy {
	let allowImplicitInvocation = true;
	const value = raw.allow_implicit_invocation;
	if (value !== undefined) {
		if (typeof value === "boolean") {
			allowImplicitInvocation = value;
		} else {
			diagnostics.push({
				type: "warning",
				message: "policy.allow_implicit_invocation must be a boolean; defaulting to true",
			});
		}
	}

	for (const key of Object.keys(raw)) {
		if (!KNOWN_POLICY_FIELDS.has(key)) {
			diagnostics.push({ type: "warning", message: `unknown policy field "${key}"` });
		}
	}

	return { allowImplicitInvocation };
}

function parseToolDependency(
	raw: Record<string, unknown>,
	diagnostics: ResourceDiagnostic[],
): OpenAiSkillToolDependency {
	const result: OpenAiSkillToolDependency = {};

	const stringFields: Array<[keyof OpenAiSkillToolDependency, string]> = [
		["type", "type"],
		["value", "value"],
		["description", "description"],
		["transport", "transport"],
		["url", "url"],
	];
	for (const [field, yamlKey] of stringFields) {
		const value = raw[yamlKey];
		if (value === undefined) continue;
		if (typeof value === "string") {
			result[field] = value;
		} else {
			diagnostics.push({
				type: "warning",
				message: `dependencies.tools entry field "${yamlKey}" must be a string; ignoring it`,
			});
		}
	}

	for (const key of Object.keys(raw)) {
		if (!KNOWN_TOOL_DEPENDENCY_FIELDS.has(key)) {
			diagnostics.push({ type: "warning", message: `unknown dependencies.tools field "${key}"` });
		}
	}

	return result;
}

/**
 * Parse agents/openai.yaml content. Returns a config plus diagnostics for malformed or
 * unknown fields. A config is still returned when the document is a valid mapping with
 * only recoverable problems (wrong value types, unknown fields); it is omitted only when
 * the document cannot be parsed or is not a mapping.
 */
export function parseOpenAiSkillConfig(content: string): ParseOpenAiSkillConfigResult {
	const diagnostics: ResourceDiagnostic[] = [];

	let parsed: unknown;
	try {
		parsed = parse(content);
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to parse agents/openai.yaml";
		diagnostics.push({ type: "error", message });
		return { diagnostics };
	}

	if (parsed === null || parsed === undefined) {
		// Empty document: no overlay configuration.
		return { diagnostics };
	}

	if (!isRecord(parsed)) {
		diagnostics.push({ type: "error", message: "agents/openai.yaml must be a YAML mapping" });
		return { diagnostics };
	}

	const config: OpenAiSkillConfig = { policy: { allowImplicitInvocation: true } };

	// interface
	const rawInterface = parsed.interface;
	if (rawInterface !== undefined) {
		if (isRecord(rawInterface)) {
			config.interface = parseInterfaceSection(rawInterface, diagnostics);
		} else {
			diagnostics.push({ type: "warning", message: "interface must be a mapping; ignoring it" });
		}
	}

	// policy
	const rawPolicy = parsed.policy;
	if (rawPolicy !== undefined) {
		if (isRecord(rawPolicy)) {
			config.policy = parsePolicySection(rawPolicy, diagnostics);
		} else {
			diagnostics.push({ type: "warning", message: "policy must be a mapping; ignoring it" });
		}
	}

	// dependencies
	const rawDependencies = parsed.dependencies;
	if (rawDependencies !== undefined) {
		if (isRecord(rawDependencies)) {
			const rawTools = rawDependencies.tools;
			if (rawTools !== undefined) {
				if (Array.isArray(rawTools)) {
					const tools: OpenAiSkillToolDependency[] = [];
					for (const entry of rawTools) {
						if (isRecord(entry)) {
							tools.push(parseToolDependency(entry, diagnostics));
						} else {
							diagnostics.push({
								type: "warning",
								message: "dependencies.tools entries must be mappings; ignoring one",
							});
						}
					}
					config.dependencies = { tools };
				} else {
					diagnostics.push({
						type: "warning",
						message: "dependencies.tools must be a list; ignoring it",
					});
				}
			}
		} else {
			diagnostics.push({ type: "warning", message: "dependencies must be a mapping; ignoring it" });
		}
	}

	// unknown top-level fields
	const unknown: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (KNOWN_TOP_LEVEL_FIELDS.has(key)) continue;
		unknown[key] = value;
		diagnostics.push({ type: "warning", message: `unknown field "${key}" in agents/openai.yaml` });
	}
	if (Object.keys(unknown).length > 0) {
		config.unknown = unknown;
	}

	return { config, diagnostics };
}
