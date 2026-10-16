import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { canonicalizePath } from "../../utils/paths.ts";
import { parseSkillFrontmatter } from "./frontmatter.ts";
import { parseOpenAiSkillConfig } from "./openai-config.ts";
import type { DiscoveredSkill, DiscoverOpenAiSkillsOptions, SkillScope } from "./types.ts";

/**
 * Discovery of skills in `.agents/skills` directories per the OpenAI Codex scopes
 * (docs/byte-c1j1u/spec-sources.md):
 *
 * - REPO: `<cwd>/.agents/skills` and every ancestor `.agents/skills` up to the repo root.
 *   The repo root is the nearest ancestor containing `.git`; without one, only `<cwd>`
 *   itself is scanned.
 * - USER: `<homeDir>/.agents/skills`
 * - ADMIN: `/etc/codex/skills` by default
 *
 * Symlinked skill directories are followed. The same physical skill directory reached
 * twice (e.g. a symlink inside `.agents/skills` plus the real directory in another
 * scanned scope) is reported once, under its first discovery site. Skills with the same
 * name are NOT merged: both stay in the result, later ones carry `duplicateOf` pointing
 * at the first one's SKILL.md path.
 */

const AGENTS_DIR_NAME = ".agents";
const SKILLS_DIR_NAME = "skills";
const OPENAI_CONFIG_RELATIVE_PATH = join("agents", "openai.yaml");
const DEFAULT_ADMIN_SKILLS_DIR = "/etc/codex/skills";

/**
 * Find the repository root for a working directory: the nearest ancestor that contains a
 * `.git` entry. Returns undefined when no ancestor has one, in which case only `cwd`
 * itself is scanned for repo-scope skills.
 */
export function findRepoRoot(cwd: string): string | undefined {
	let current = resolve(cwd);
	// A `.git` entry directly in the start directory counts too.
	for (;;) {
		if (existsSync(join(current, ".git"))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
}

/**
 * Repo-scope candidate directories, innermost first: `<cwd>/.agents/skills` and each
 * ancestor's up to (and including) the repo root. Without a repo root, only `<cwd>` is
 * used.
 */
function repoSkillDirs(cwd: string): string[] {
	const dirs: string[] = [];
	let current = resolve(cwd);
	const root = findRepoRoot(cwd);
	for (;;) {
		dirs.push(join(current, AGENTS_DIR_NAME, SKILLS_DIR_NAME));
		if (root === undefined || current === root) {
			break;
		}
		const parent = dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	return dirs;
}

function isDirectoryFollowSymlinks(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Load a skill directory: parse SKILL.md and the optional agents/openai.yaml overlay. */
function loadSkillDir(skillDir: string, scope: SkillScope): DiscoveredSkill | null {
	const skillMdPath = join(skillDir, "SKILL.md");
	if (!isFileFollowSymlinks(skillMdPath)) {
		return null;
	}

	let content: string;
	try {
		content = readFileSync(skillMdPath, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to read SKILL.md";
		return {
			name: basename(skillDir),
			skillDir,
			skillMdPath,
			scope,
			frontmatter: {},
			diagnostics: [{ type: "error", message, path: skillMdPath }],
		};
	}

	const expectedDirName = basename(skillDir);
	const { frontmatter, diagnostics } = parseSkillFrontmatter(content, expectedDirName);

	// Default the name to the directory name when frontmatter has none.
	const name = frontmatter.name ?? expectedDirName;

	const openaiConfigPath = join(skillDir, OPENAI_CONFIG_RELATIVE_PATH);
	if (isFileFollowSymlinks(openaiConfigPath)) {
		let configContent: string;
		try {
			configContent = readFileSync(openaiConfigPath, "utf-8");
		} catch (error) {
			diagnostics.push({
				type: "error",
				message: error instanceof Error ? error.message : "failed to read agents/openai.yaml",
				path: openaiConfigPath,
			});
			return {
				name,
				description: frontmatter.description,
				skillDir,
				skillMdPath,
				scope,
				frontmatter,
				diagnostics,
			};
		}

		const { config, diagnostics: configDiagnostics } = parseOpenAiSkillConfig(configContent);
		for (const diagnostic of configDiagnostics) {
			diagnostics.push({ ...diagnostic, path: openaiConfigPath });
		}
		if (config) {
			return {
				name,
				description: frontmatter.description,
				skillDir,
				skillMdPath,
				scope,
				frontmatter,
				openaiConfig: config,
				diagnostics,
			};
		}
	}

	return {
		name,
		description: frontmatter.description,
		skillDir,
		skillMdPath,
		scope,
		frontmatter,
		diagnostics,
	};
}

function isFileFollowSymlinks(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * Scan one `.agents/skills`-style directory. Every direct child directory is a skill
 * candidate; symlinked children are followed (broken ones are skipped). Returns skills in
 * directory-listing order, without name deduplication.
 */
function scanSkillsDir(dir: string, scope: SkillScope, seenRealPaths: Set<string>): DiscoveredSkill[] {
	if (!isDirectoryFollowSymlinks(dir)) {
		return [];
	}

	const skills: DiscoveredSkill[] = [];

	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	for (const entry of entries) {
		const skillDir = join(dir, entry.name);

		let isDirectory = entry.isDirectory();
		if (entry.isSymbolicLink()) {
			isDirectory = isDirectoryFollowSymlinks(skillDir);
		}
		if (!isDirectory) {
			continue;
		}

		// Deduplicate physical directories reached through symlinks or overlapping scopes.
		const realPath = canonicalizePath(skillDir);
		if (seenRealPaths.has(realPath)) {
			continue;
		}
		seenRealPaths.add(realPath);

		const skill = loadSkillDir(skillDir, scope);
		if (skill) {
			skills.push(skill);
		}
	}

	return skills;
}

/**
 * Discover skills across the OpenAI Codex scopes, plus optional `extraDirs` scanned with
 * "path" scope. Every discovered skill is returned with its own diagnostics; skills are
 * never dropped for having diagnostics (missing name/description included), so callers
 * can decide how strict to be.
 */
export function discoverOpenAiSkills(options: DiscoverOpenAiSkillsOptions): DiscoveredSkill[] {
	const cwd = resolve(options.cwd);
	const homeDir = resolve(options.homeDir);
	const adminDir = resolve(options.adminDir ?? DEFAULT_ADMIN_SKILLS_DIR);

	// Candidate directories in scope-priority order: repo (innermost first), then user,
	// then admin, then extra paths.
	const candidates: Array<{ dir: string; scope: SkillScope }> = [];
	for (const dir of repoSkillDirs(cwd)) {
		candidates.push({ dir, scope: "repo" });
	}
	candidates.push({ dir: join(homeDir, AGENTS_DIR_NAME, SKILLS_DIR_NAME), scope: "user" });
	candidates.push({ dir: adminDir, scope: "admin" });
	for (const dir of options.extraDirs ?? []) {
		candidates.push({ dir: resolve(cwd, dir), scope: "path" });
	}

	const skills: DiscoveredSkill[] = [];
	const seenRealPaths = new Set<string>();
	const firstByName = new Map<string, string>();

	for (const { dir, scope } of candidates) {
		for (const skill of scanSkillsDir(dir, scope, seenRealPaths)) {
			const first = firstByName.get(skill.name);
			if (first !== undefined) {
				skill.duplicateOf = first;
			} else {
				firstByName.set(skill.name, skill.skillMdPath);
			}
			skills.push(skill);
		}
	}

	return skills;
}
