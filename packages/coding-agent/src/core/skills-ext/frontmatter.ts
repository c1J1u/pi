import { parseFrontmatter } from "../../utils/frontmatter.ts";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import type { SkillFrontmatterExt } from "./types.ts";

/**
 * SKILL.md frontmatter parsing for the agentskills.io specification.
 *
 * Field rules (docs/byte-c1j1u/spec-sources.md):
 * - name: required, 1-64 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphen,
 *   no consecutive hyphens, must match the parent directory name
 * - description: required, 1-1024 chars, non-empty
 * - license: optional string
 * - compatibility: optional string, max 500 chars
 * - metadata: optional string -> string map; non-string values are diagnostics
 * - allowed-tools: optional, experimental; space-separated tool name list
 */

/** Max name length per spec */
const MAX_NAME_LENGTH = 64;

/** Max description length per spec */
const MAX_DESCRIPTION_LENGTH = 1024;

/** Max compatibility field length per spec */
const MAX_COMPATIBILITY_LENGTH = 500;

const KNOWN_FIELDS: ReadonlySet<string> = new Set([
	"name",
	"description",
	"license",
	"compatibility",
	"metadata",
	"allowed-tools",
]);

export interface ParseSkillFrontmatterResult {
	frontmatter: SkillFrontmatterExt;
	/** Body text after the frontmatter block, or the whole content when no frontmatter exists. */
	body: string;
	diagnostics: ResourceDiagnostic[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the name per the agentskills.io spec.
 * Matching the parent directory name is the caller's job (expectedDirName); see
 * parseSkillFrontmatter.
 */
function validateName(name: string): string[] {
	const errors: string[] = [];

	if (name.length > MAX_NAME_LENGTH) {
		errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	}

	if (name.length === 0) {
		errors.push("name must not be empty");
	} else {
		if (!/^[a-z0-9-]+$/.test(name)) {
			errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
		}
		if (name.startsWith("-") || name.endsWith("-")) {
			errors.push(`name must not start or end with a hyphen`);
		}
		if (name.includes("--")) {
			errors.push(`name must not contain consecutive hyphens`);
		}
	}

	return errors;
}

/**
 * Parse a SKILL.md document into frontmatter, body, and diagnostics.
 *
 * `expectedDirName` is the skill directory name the frontmatter name must match per spec;
 * pass undefined to skip that check (e.g. when there is no directory context).
 *
 * Diagnostics never remove fields from the result: a skill with a bad name still parses,
 * and the caller decides whether to keep it. Unknown frontmatter fields are preserved in
 * `frontmatter.unknown` and reported as diagnostics.
 */
export function parseSkillFrontmatter(content: string, expectedDirName?: string): ParseSkillFrontmatterResult {
	const diagnostics: ResourceDiagnostic[] = [];
	const frontmatter: SkillFrontmatterExt = {};

	let raw: Record<string, unknown>;
	let body: string;
	try {
		({ frontmatter: raw, body } = parseFrontmatter(content));
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to parse SKILL.md frontmatter";
		diagnostics.push({ type: "error", message });
		return { frontmatter, body: "", diagnostics };
	}

	if (!isRecord(raw)) {
		diagnostics.push({
			type: "error",
			message: "SKILL.md frontmatter must be a YAML mapping",
		});
		return { frontmatter, body: "", diagnostics };
	}

	// name
	const rawName = raw.name;
	if (rawName === undefined) {
		diagnostics.push({ type: "error", message: "name is required" });
	} else if (typeof rawName !== "string") {
		diagnostics.push({ type: "error", message: "name must be a string" });
	} else {
		frontmatter.name = rawName;
		for (const error of validateName(rawName)) {
			diagnostics.push({ type: "error", message: `name: ${error}` });
		}
		if (expectedDirName !== undefined && rawName !== expectedDirName) {
			diagnostics.push({
				type: "error",
				message: `name "${rawName}" does not match parent directory name "${expectedDirName}"`,
			});
		}
	}

	// description
	const rawDescription = raw.description;
	if (rawDescription === undefined) {
		diagnostics.push({ type: "error", message: "description is required" });
	} else if (typeof rawDescription !== "string") {
		diagnostics.push({ type: "error", message: "description must be a string" });
	} else if (rawDescription.trim() === "") {
		diagnostics.push({ type: "error", message: "description must not be empty" });
	} else {
		frontmatter.description = rawDescription;
		if (rawDescription.length > MAX_DESCRIPTION_LENGTH) {
			diagnostics.push({
				type: "error",
				message: `description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${rawDescription.length})`,
			});
		}
	}

	// license
	if (raw.license !== undefined) {
		if (typeof raw.license === "string") {
			frontmatter.license = raw.license;
		} else {
			diagnostics.push({ type: "warning", message: "license must be a string; ignoring it" });
		}
	}

	// compatibility
	if (raw.compatibility !== undefined) {
		if (typeof raw.compatibility === "string") {
			frontmatter.compatibility = raw.compatibility;
			if (raw.compatibility.length > MAX_COMPATIBILITY_LENGTH) {
				diagnostics.push({
					type: "error",
					message: `compatibility exceeds ${MAX_COMPATIBILITY_LENGTH} characters (${raw.compatibility.length})`,
				});
			}
		} else {
			diagnostics.push({ type: "warning", message: "compatibility must be a string; ignoring it" });
		}
	}

	// metadata: string -> string map; non-string values are diagnostics
	if (raw.metadata !== undefined) {
		if (isRecord(raw.metadata)) {
			const metadata: Record<string, string> = {};
			for (const [key, value] of Object.entries(raw.metadata)) {
				if (typeof value === "string") {
					metadata[key] = value;
				} else {
					diagnostics.push({
						type: "warning",
						message: `metadata value for key "${key}" must be a string; ignoring it`,
					});
				}
			}
			frontmatter.metadata = metadata;
		} else {
			diagnostics.push({
				type: "warning",
				message: "metadata must be a mapping of string keys to string values; ignoring it",
			});
		}
	}

	// allowed-tools: space-separated tool list (experimental)
	if (raw["allowed-tools"] !== undefined) {
		const allowedToolsRaw = raw["allowed-tools"];
		if (typeof allowedToolsRaw === "string") {
			const tools = allowedToolsRaw.split(/\s+/).filter((tool) => tool.length > 0);
			if (tools.length > 0) {
				frontmatter.allowedTools = tools;
			}
		} else if (Array.isArray(allowedToolsRaw) && allowedToolsRaw.every((t) => typeof t === "string")) {
			const tools = (allowedToolsRaw as string[]).filter((tool) => tool.trim().length > 0);
			if (tools.length > 0) {
				frontmatter.allowedTools = tools;
			}
		} else {
			diagnostics.push({
				type: "warning",
				message: "allowed-tools must be a space-separated string of tool names; ignoring it",
			});
		}
	}

	// unknown fields
	const unknown: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (KNOWN_FIELDS.has(key)) continue;
		unknown[key] = value;
		diagnostics.push({ type: "warning", message: `unknown frontmatter field "${key}"` });
	}
	if (Object.keys(unknown).length > 0) {
		frontmatter.unknown = unknown;
	}

	return { frontmatter, body, diagnostics };
}
