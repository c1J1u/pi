/**
 * Agent Plugins 1.0.0 manifest reading and validation.
 *
 * Sources verified 2026-10-16 (see docs/byte-c1j1u/spec-sources.md):
 * - https://agent-plugins.org/schemas/1.0.0/plugin.schema.json
 * - https://developers.openai.com/codex/plugins/build/ ("Package your plugin")
 *
 * Reading order for OpenAI-specific settings: root `plugin.json`
 * `extensions["com.openai"]` replaces the `.codex-plugin/plugin.json` overlay entirely
 * when present; the overlay is the fallback otherwise. They are never merged.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const PLUGIN_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const MCP_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
export const OPENAI_EXTENSION_NAMESPACE = "com.openai";

export interface PluginManifestAuthor {
	name?: string;
	email?: string;
	url?: string;
}

/** OpenAI-specific overlay from `extensions["com.openai"]` or `.codex-plugin/plugin.json`. */
export interface OpenAiPluginExtension {
	/** Path(s) to registered MCP server mappings (`.app.json`), `./`-prefixed. */
	apps?: string | string[];
	/** Hook definition: `./`-prefixed path(s) to hooks files or inline hooks objects. */
	hooks?: string | string[] | Record<string, unknown> | Array<Record<string, unknown>>;
	/** Presentation metadata for plugin browsers. */
	interface?: PluginInterfaceMetadata;
	/** Path to the onboarding skill's SKILL.md, `./`-prefixed. */
	onboardingSkill?: string;
}

export interface PluginInterfaceMetadata {
	displayName?: string;
	shortDescription?: string;
	longDescription?: string;
	developerName?: string;
	category?: string;
	capabilities?: string[];
	websiteURL?: string;
	privacyPolicyURL?: string;
	termsOfServiceURL?: string;
	defaultPrompt?: string[];
	brandColor?: string;
	composerIcon?: string;
	logo?: string;
	screenshots?: string[];
}

/** Portable plugin manifest (Agent Plugins 1.0.0 plugin.json). */
export interface PluginManifest {
	name: string;
	version?: string;
	description?: string;
	author?: PluginManifestAuthor;
	homepage?: string;
	repository?: string;
	license?: string;
	keywords?: string[];
	/** OpenAI-specific settings when the root manifest carries them. */
	openaiExtension?: OpenAiPluginExtension;
	/** True when OpenAI settings came from the `.codex-plugin/plugin.json` fallback. */
	openaiFromCompatOverlay: boolean;
}

export type PluginReadResult =
	| { status: "ok"; manifest: PluginManifest; rootDir: string }
	| { status: "not-found" }
	| { status: "invalid"; errors: string[] };

const NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonFile(path: string): { value: unknown } | { error: string } {
	try {
		return { value: JSON.parse(readFileSync(path, "utf8")) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function validatePortableManifest(value: unknown, errors: string[]): PluginManifest | undefined {
	if (!isRecord(value)) {
		errors.push("plugin.json must be a JSON object");
		return undefined;
	}
	const name = value.name;
	if (typeof name !== "string" || name.length === 0) {
		errors.push("plugin.json: name is required");
		return undefined;
	}
	if (name.length > 64) {
		errors.push(`plugin.json: name exceeds 64 characters (${name.length})`);
	}
	if (!NAME_PATTERN.test(name)) {
		errors.push("plugin.json: name must be kebab-case lowercase alphanumeric with hyphens or dots");
	}
	if (value.$schema !== undefined && value.$schema !== PLUGIN_SCHEMA_URL) {
		errors.push(`plugin.json: unsupported $schema "${String(value.$schema)}" (expected ${PLUGIN_SCHEMA_URL})`);
	}
	const knownFields = new Set([
		"$schema",
		"name",
		"version",
		"description",
		"author",
		"homepage",
		"repository",
		"license",
		"keywords",
		"extensions",
	]);
	for (const key of Object.keys(value)) {
		if (!knownFields.has(key)) {
			errors.push(`plugin.json: unknown field "${key}" (schema is additionalProperties: false)`);
		}
	}
	const manifest: PluginManifest = {
		name,
		openaiFromCompatOverlay: false,
	};
	if (typeof value.version === "string") manifest.version = value.version;
	if (typeof value.description === "string") manifest.description = value.description;
	if (isRecord(value.author)) {
		const author: PluginManifestAuthor = {};
		if (typeof value.author.name === "string") author.name = value.author.name;
		if (typeof value.author.email === "string") author.email = value.author.email;
		if (typeof value.author.url === "string") author.url = value.author.url;
		manifest.author = author;
	}
	if (typeof value.homepage === "string") manifest.homepage = value.homepage;
	if (typeof value.repository === "string") manifest.repository = value.repository;
	if (typeof value.license === "string") manifest.license = value.license;
	if (Array.isArray(value.keywords)) {
		manifest.keywords = value.keywords.filter((k): k is string => typeof k === "string");
	}
	if (isRecord(value.extensions)) {
		const openai = value.extensions[OPENAI_EXTENSION_NAMESPACE];
		if (openai !== undefined) {
			if (!isRecord(openai)) {
				errors.push(`plugin.json: extensions.${OPENAI_EXTENSION_NAMESPACE} must be an object`);
			} else {
				manifest.openaiExtension = readOpenAiExtension(openai, errors);
			}
		}
	}
	return manifest;
}

function readOpenAiExtension(value: Record<string, unknown>, errors: string[]): OpenAiPluginExtension {
	const extension: OpenAiPluginExtension = {};
	const known = new Set(["apps", "hooks", "interface", "onboardingSkill"]);
	for (const key of Object.keys(value)) {
		if (!known.has(key)) errors.push(`extensions.${OPENAI_EXTENSION_NAMESPACE}: unknown field "${key}"`);
	}
	if (typeof value.apps === "string") extension.apps = value.apps;
	else if (Array.isArray(value.apps)) {
		const apps = value.apps.filter((a): a is string => typeof a === "string");
		if (apps.length > 0) extension.apps = apps;
	}
	if (value.hooks !== undefined) {
		if (typeof value.hooks === "string" || Array.isArray(value.hooks) || isRecord(value.hooks)) {
			extension.hooks = value.hooks as OpenAiPluginExtension["hooks"];
		} else {
			errors.push("extensions.com.openai: hooks must be a path, array, or object");
		}
	}
	if (isRecord(value.interface)) extension.interface = value.interface as PluginInterfaceMetadata;
	if (typeof value.onboardingSkill === "string") extension.onboardingSkill = value.onboardingSkill;
	return extension;
}

/** Read the `.codex-plugin/plugin.json` compatibility overlay (OpenAI-specific settings only). */
function readCompatOverlay(rootDir: string, errors: string[]): OpenAiPluginExtension | undefined {
	const overlayPath = join(rootDir, ".codex-plugin", "plugin.json");
	if (!existsSync(overlayPath)) return undefined;
	const parsed = parseJsonFile(overlayPath);
	if ("error" in parsed) {
		errors.push(`.codex-plugin/plugin.json: ${parsed.error}`);
		return undefined;
	}
	if (!isRecord(parsed.value)) {
		errors.push(".codex-plugin/plugin.json: must be a JSON object");
		return undefined;
	}
	return readOpenAiExtension(parsed.value, errors);
}

/**
 * Read a plugin manifest from a plugin root directory.
 *
 * Precedence per the official docs: when root `plugin.json` has an
 * `extensions["com.openai"]` object, it replaces the compatibility overlay entirely.
 */
export function readPluginManifest(rootDir: string): PluginReadResult {
	const manifestPath = join(rootDir, "plugin.json");
	if (!existsSync(manifestPath)) {
		const overlayPath = join(rootDir, ".codex-plugin", "plugin.json");
		if (!existsSync(overlayPath)) return { status: "not-found" };
		// Overlay-only package: synthesize identity from the directory name.
		const errors: string[] = [];
		const overlay = readCompatOverlay(rootDir, errors);
		const dirName = rootDir.split(sep).filter(Boolean).at(-1) ?? "";
		const name = NAME_PATTERN.test(dirName) ? dirName : dirName.toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
		return {
			status: "ok",
			manifest: { name, openaiExtension: overlay, openaiFromCompatOverlay: true },
			rootDir,
		};
	}

	const parsed = parseJsonFile(manifestPath);
	if ("error" in parsed) {
		return { status: "invalid", errors: [`plugin.json: ${parsed.error}`] };
	}

	const errors: string[] = [];
	const manifest = validatePortableManifest(parsed.value, errors);
	if (!manifest) {
		return { status: "invalid", errors };
	}

	// Root extensions["com.openai"] replaces the overlay; overlay is only the fallback.
	if (manifest.openaiExtension) {
		manifest.openaiFromCompatOverlay = false;
	} else {
		const overlay = readCompatOverlay(rootDir, errors);
		if (overlay) {
			manifest.openaiExtension = overlay;
			manifest.openaiFromCompatOverlay = true;
		}
	}

	if (errors.length > 0) return { status: "invalid", errors };
	return { status: "ok", manifest, rootDir };
}

/**
 * Resolve a `./`-prefixed manifest path relative to the plugin root, enforcing containment
 * (the resolved path must stay inside the plugin root).
 */
export function resolvePluginPath(rootDir: string, manifestPath: string): { path: string } | { error: string } {
	if (!manifestPath.startsWith("./")) {
		return { error: `plugin path must start with "./": ${manifestPath}` };
	}
	const resolved = resolve(rootDir, manifestPath);
	const rel = relative(resolve(rootDir), resolved);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		return { error: `plugin path escapes the plugin root: ${manifestPath}` };
	}
	return { path: resolved };
}

/** Expand an OpenAI hooks field into a list of file paths (inline objects are returned too). */
export function hooksFieldEntries(hooks: OpenAiPluginExtension["hooks"]): {
	paths: string[];
	inline: Array<Record<string, unknown>>;
} {
	const paths: string[] = [];
	const inline: Array<Record<string, unknown>> = [];
	if (typeof hooks === "string") {
		paths.push(hooks);
	} else if (Array.isArray(hooks)) {
		for (const entry of hooks) {
			if (typeof entry === "string") paths.push(entry);
			else if (isRecord(entry)) inline.push(entry);
		}
	} else if (isRecord(hooks)) {
		inline.push(hooks);
	}
	return { paths, inline };
}
