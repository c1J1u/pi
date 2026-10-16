import type { ResourceDiagnostic } from "../diagnostics.ts";

/**
 * Types for the Agent Skills specification (https://agentskills.io) extended with the
 * OpenAI Codex skill overlay (agents/openai.yaml). See docs/byte-c1j1u/spec-sources.md.
 */

/** Where a skill was found. */
export type SkillScope = "repo" | "user" | "admin" | "path" | "plugin";

/** Parsed SKILL.md frontmatter per the agentskills.io specification. */
export interface SkillFrontmatterExt {
	/** Required. Lowercase alphanumeric + hyphens, max 64 chars, must match the parent directory name. */
	name?: string;
	/** Required. Max 1024 chars, non-empty. */
	description?: string;
	/** Optional. */
	license?: string;
	/** Optional. Max 500 chars. */
	compatibility?: string;
	/** Optional. String -> string map. Non-string values are diagnostics, not hard errors. */
	metadata?: Record<string, string>;
	/** Optional, experimental. Space-separated tool names, split into a list. */
	allowedTools?: string[];
	/** Unknown fields are preserved here and reported as diagnostics. */
	unknown?: Record<string, unknown>;
}

/** `interface` section of agents/openai.yaml. All fields optional. */
export interface OpenAiSkillInterface {
	displayName?: string;
	shortDescription?: string;
	iconSmall?: string;
	iconLarge?: string;
	brandColor?: string;
	defaultPrompt?: string;
}

/** `policy` section of agents/openai.yaml. */
export interface OpenAiSkillPolicy {
	/**
	 * Whether the skill may be activated implicitly by model choice. Default true.
	 * When false, the skill is only invocable through an explicit `$skill` reference.
	 */
	allowImplicitInvocation: boolean;
}

/** One entry of `dependencies.tools` in agents/openai.yaml. */
export interface OpenAiSkillToolDependency {
	/** Dependency type, e.g. "mcp". */
	type?: string;
	/** Dependency value, e.g. the server name. */
	value?: string;
	description?: string;
	/** Transport, e.g. "streamable_http". */
	transport?: string;
	url?: string;
}

/** Parsed agents/openai.yaml overlay (OpenAI Codex skill extension). */
export interface OpenAiSkillConfig {
	interface?: OpenAiSkillInterface;
	policy: OpenAiSkillPolicy;
	dependencies?: {
		tools?: OpenAiSkillToolDependency[];
	};
	/** Top-level keys outside interface/policy/dependencies, preserved and reported as diagnostics. */
	unknown?: Record<string, unknown>;
}

/** A skill directory found by discovery, with its parsed metadata and diagnostics. */
export interface DiscoveredSkill {
	/** Frontmatter name if present, otherwise the skill directory name. */
	name: string;
	/** Frontmatter description if present. */
	description?: string;
	/** Directory containing SKILL.md. */
	skillDir: string;
	skillMdPath: string;
	scope: SkillScope;
	frontmatter: SkillFrontmatterExt;
	/** Parsed agents/openai.yaml overlay, when the file exists and parses. */
	openaiConfig?: OpenAiSkillConfig;
	/**
	 * Path of another skill with the same name that was discovered first.
	 * Duplicate names are not merged; both skills stay discoverable.
	 */
	duplicateOf?: string;
	diagnostics: ResourceDiagnostic[];
}

/** Options for discoverOpenAiSkills. */
export interface DiscoverOpenAiSkillsOptions {
	/** Session working directory; repo-scope discovery starts here and walks up to the repo root. */
	cwd: string;
	/** Home directory; user-scope skills are read from `<homeDir>/.agents/skills`. */
	homeDir: string;
	/** Admin skills directory. Default: /etc/codex/skills. */
	adminDir?: string;
	/** Extra directories to scan with "path" scope, in addition to the standard scopes. */
	extraDirs?: string[];
}
