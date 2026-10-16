import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	discoverOpenAiSkills,
	findRepoRoot,
	parseOpenAiSkillConfig,
	parseSkillFrontmatter,
} from "../../src/core/skills-ext/index.ts";

let tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = join(tmpdir(), `pi-skills-ext-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs = [];
});

/** Write a skill directory under `parent` with SKILL.md content and optional openai.yaml. */
function writeSkill(
	parent: string,
	name: string,
	skillMd: string,
	openaiYaml?: string,
): { skillDir: string; skillMdPath: string } {
	const skillDir = join(parent, name);
	mkdirSync(skillDir, { recursive: true });
	const skillMdPath = join(skillDir, "SKILL.md");
	writeFileSync(skillMdPath, skillMd);
	if (openaiYaml !== undefined) {
		mkdirSync(join(skillDir, "agents"), { recursive: true });
		writeFileSync(join(skillDir, "agents", "openai.yaml"), openaiYaml);
	}
	return { skillDir, skillMdPath };
}

function makeSkillMd(fields: Record<string, string>): string {
	const lines = ["---"];
	for (const [key, value] of Object.entries(fields)) {
		lines.push(`${key}: ${value}`);
	}
	lines.push("---", "", "Body.");
	return lines.join("\n");
}

describe("parseSkillFrontmatter", () => {
	it("parses a valid SKILL.md with all optional fields", () => {
		const content = [
			"---",
			"name: my-skill",
			"description: Does a thing.",
			"license: MIT",
			"compatibility: requires node 22",
			"metadata:",
			"  author: someone",
			'  version: "1.0"',
			"allowed-tools: read bash edit",
			"---",
			"",
			"# Body",
		].join("\n");

		const { frontmatter, body, diagnostics } = parseSkillFrontmatter(content, "my-skill");

		expect(diagnostics).toHaveLength(0);
		expect(frontmatter.name).toBe("my-skill");
		expect(frontmatter.description).toBe("Does a thing.");
		expect(frontmatter.license).toBe("MIT");
		expect(frontmatter.compatibility).toBe("requires node 22");
		expect(frontmatter.metadata).toEqual({ author: "someone", version: "1.0" });
		expect(frontmatter.allowedTools).toEqual(["read", "bash", "edit"]);
		expect(body).toContain("# Body");
	});

	it("diagnoses name that does not match parent directory name", () => {
		const content = makeSkillMd({ name: "other-name", description: "Desc." });
		const { frontmatter, diagnostics } = parseSkillFrontmatter(content, "my-skill");

		expect(frontmatter.name).toBe("other-name");
		expect(
			diagnostics.some(
				(d) => d.type === "error" && d.message.includes('does not match parent directory name "my-skill"'),
			),
		).toBe(true);
	});

	it("diagnoses missing name and description", () => {
		const { diagnostics } = parseSkillFrontmatter("---\nlicense: MIT\n---\nBody", "my-skill");
		expect(diagnostics.some((d) => d.message === "name is required")).toBe(true);
		expect(diagnostics.some((d) => d.message === "description is required")).toBe(true);
	});

	it("diagnoses invalid name format", () => {
		const upper = makeSkillMd({ name: "MySkill", description: "Desc." });
		expect(
			parseSkillFrontmatter(upper, "MySkill").diagnostics.some((d) => d.message.includes("invalid characters")),
		).toBe(true);

		const hyphens = makeSkillMd({ name: "my--skill", description: "Desc." });
		expect(
			parseSkillFrontmatter(hyphens, "my--skill").diagnostics.some((d) => d.message.includes("consecutive hyphens")),
		).toBe(true);

		const leading = makeSkillMd({ name: "-skill", description: "Desc." });
		expect(parseSkillFrontmatter(leading, "-skill").diagnostics.some((d) => d.message.includes("hyphen"))).toBe(true);

		const long = makeSkillMd({ name: "a".repeat(65), description: "Desc." });
		expect(parseSkillFrontmatter(long).diagnostics.some((d) => d.message.includes("exceeds 64 characters"))).toBe(
			true,
		);
	});

	it("diagnoses non-string metadata values", () => {
		const content = [
			"---",
			"name: my-skill",
			"description: Desc.",
			"metadata:",
			"  author: someone",
			"  count: 3",
			"---",
			"",
			"Body.",
		].join("\n");

		const { frontmatter, diagnostics } = parseSkillFrontmatter(content, "my-skill");

		expect(frontmatter.metadata).toEqual({ author: "someone" });
		expect(diagnostics.some((d) => d.message.includes('metadata value for key "count" must be a string'))).toBe(true);
	});

	it("diagnoses compatibility over 500 characters", () => {
		const content = makeSkillMd({
			name: "my-skill",
			description: "Desc.",
			compatibility: "x".repeat(501),
		});
		const { frontmatter, diagnostics } = parseSkillFrontmatter(content, "my-skill");

		expect(frontmatter.compatibility).toBe("x".repeat(501));
		expect(diagnostics.some((d) => d.message.includes("compatibility exceeds 500 characters"))).toBe(true);
	});

	it("accepts compatibility at exactly 500 characters", () => {
		const content = makeSkillMd({
			name: "my-skill",
			description: "Desc.",
			compatibility: "x".repeat(500),
		});
		const { diagnostics } = parseSkillFrontmatter(content, "my-skill");
		expect(diagnostics).toHaveLength(0);
	});

	it("parses allowed-tools and ignores empty entries", () => {
		const content = makeSkillMd({
			name: "my-skill",
			description: "Desc.",
			"allowed-tools": "  read   bash  ",
		});
		const { frontmatter, diagnostics } = parseSkillFrontmatter(content, "my-skill");

		expect(frontmatter.allowedTools).toEqual(["read", "bash"]);
		expect(diagnostics).toHaveLength(0);
	});

	it("diagnoses broken YAML", () => {
		const content = "---\nname: [unclosed\n---\nBody";
		const { frontmatter, diagnostics } = parseSkillFrontmatter(content, "my-skill");

		expect(frontmatter.name).toBeUndefined();
		expect(diagnostics.some((d) => d.type === "error")).toBe(true);
	});

	it("preserves unknown fields and reports them", () => {
		const content = [
			"---",
			"name: my-skill",
			"description: Desc.",
			"author: someone",
			"version: 2",
			"---",
			"",
			"Body.",
		].join("\n");

		const { frontmatter, diagnostics } = parseSkillFrontmatter(content, "my-skill");

		expect(frontmatter.unknown).toEqual({ author: "someone", version: 2 });
		expect(diagnostics.some((d) => d.message.includes('unknown frontmatter field "author"'))).toBe(true);
		expect(diagnostics.some((d) => d.message.includes('unknown frontmatter field "version"'))).toBe(true);
	});

	it("diagnoses description over 1024 characters", () => {
		const content = makeSkillMd({ name: "my-skill", description: "d".repeat(1025) });
		const { diagnostics } = parseSkillFrontmatter(content, "my-skill");
		expect(diagnostics.some((d) => d.message.includes("description exceeds 1024 characters"))).toBe(true);
	});
});

describe("parseOpenAiSkillConfig", () => {
	it("parses interface, policy, and dependencies", () => {
		const yaml = [
			"interface:",
			"  display_name: My Skill",
			"  short_description: Short.",
			"  icon_small: icons/small.png",
			"  icon_large: icons/large.png",
			'  brand_color: "#112233"',
			"  default_prompt: Do the thing",
			"policy:",
			"  allow_implicit_invocation: false",
			"dependencies:",
			"  tools:",
			"    - type: mcp",
			"      value: github",
			"      description: GitHub tools",
			"      transport: streamable_http",
			"      url: https://mcp.example.com/mcp",
		].join("\n");

		const { config, diagnostics } = parseOpenAiSkillConfig(yaml);

		expect(diagnostics).toHaveLength(0);
		expect(config?.interface).toEqual({
			displayName: "My Skill",
			shortDescription: "Short.",
			iconSmall: "icons/small.png",
			iconLarge: "icons/large.png",
			brandColor: "#112233",
			defaultPrompt: "Do the thing",
		});
		expect(config?.policy.allowImplicitInvocation).toBe(false);
		expect(config?.dependencies?.tools).toEqual([
			{
				type: "mcp",
				value: "github",
				description: "GitHub tools",
				transport: "streamable_http",
				url: "https://mcp.example.com/mcp",
			},
		]);
	});

	it("defaults allow_implicit_invocation to true", () => {
		const { config, diagnostics } = parseOpenAiSkillConfig("interface:\n  display_name: X\n");
		expect(diagnostics).toHaveLength(0);
		expect(config?.policy.allowImplicitInvocation).toBe(true);
	});

	it("defaults policy for an empty document", () => {
		const { config, diagnostics } = parseOpenAiSkillConfig("");
		expect(diagnostics).toHaveLength(0);
		expect(config).toBeUndefined();
	});

	it("diagnoses unknown top-level fields and preserves them", () => {
		const { config, diagnostics } = parseOpenAiSkillConfig(
			"future_field: 1\npolicy:\n  allow_implicit_invocation: true\n",
		);

		expect(config?.unknown).toEqual({ future_field: 1 });
		expect(diagnostics.some((d) => d.message.includes('unknown field "future_field" in agents/openai.yaml'))).toBe(
			true,
		);
	});

	it("diagnoses non-boolean allow_implicit_invocation and keeps the default", () => {
		const { config, diagnostics } = parseOpenAiSkillConfig("policy:\n  allow_implicit_invocation: nope\n");

		expect(config?.policy.allowImplicitInvocation).toBe(true);
		expect(diagnostics.some((d) => d.message.includes("policy.allow_implicit_invocation must be a boolean"))).toBe(
			true,
		);
	});

	it("diagnoses broken YAML without returning a config", () => {
		const { config, diagnostics } = parseOpenAiSkillConfig("interface: [unclosed\n");

		expect(config).toBeUndefined();
		expect(diagnostics.some((d) => d.type === "error")).toBe(true);
	});

	it("diagnoses non-mapping documents", () => {
		const { config, diagnostics } = parseOpenAiSkillConfig("- just\n- a\n- list\n");

		expect(config).toBeUndefined();
		expect(diagnostics.some((d) => d.message.includes("must be a YAML mapping"))).toBe(true);
	});

	it("diagnoses non-mapping tool dependencies entries", () => {
		const yaml = ["dependencies:", "  tools:", "    - mcp", "    - type: mcp", "      value: x"].join("\n");
		const { config, diagnostics } = parseOpenAiSkillConfig(yaml);

		expect(diagnostics.some((d) => d.message.includes("dependencies.tools entries must be mappings"))).toBe(true);
		expect(config?.dependencies?.tools).toEqual([{ type: "mcp", value: "x" }]);
	});
});

describe("findRepoRoot", () => {
	it("finds the nearest ancestor with .git", () => {
		const base = makeTempDir("repo-root");
		mkdirSync(join(base, ".git"), { recursive: true });
		const nested = join(base, "a", "b");
		mkdirSync(nested, { recursive: true });

		expect(findRepoRoot(nested)).toBe(base);
		expect(findRepoRoot(base)).toBe(base);
	});

	it("returns undefined when no ancestor has .git", () => {
		const dir = makeTempDir("no-git");
		expect(findRepoRoot(dir)).toBeUndefined();
	});
});

describe("discoverOpenAiSkills", () => {
	it("discovers repo skills from cwd and ancestors up to the repo root", () => {
		const base = makeTempDir("scopes");
		mkdirSync(join(base, ".git"), { recursive: true });

		const mid = join(base, "pkg");
		const deep = join(mid, "sub");
		mkdirSync(deep, { recursive: true });

		writeSkill(
			join(base, ".agents", "skills"),
			"root-skill",
			makeSkillMd({ name: "root-skill", description: "Root." }),
		);
		writeSkill(join(mid, ".agents", "skills"), "mid-skill", makeSkillMd({ name: "mid-skill", description: "Mid." }));
		writeSkill(
			join(deep, ".agents", "skills"),
			"deep-skill",
			makeSkillMd({ name: "deep-skill", description: "Deep." }),
		);

		const home = makeTempDir("home-empty");

		const skills = discoverOpenAiSkills({ cwd: deep, homeDir: home });

		expect(skills.map((s) => s.name).sort()).toEqual(["deep-skill", "mid-skill", "root-skill"]);
		for (const skill of skills) {
			expect(skill.scope).toBe("repo");
			expect(skill.diagnostics).toHaveLength(0);
		}
	});

	it("does not scan above the repo root", () => {
		const base = makeTempDir("outer");
		const repo = join(base, "repo");
		mkdirSync(join(repo, ".git"), { recursive: true });
		mkdirSync(join(base, ".agents", "skills"), { recursive: true });
		writeSkill(
			join(base, ".agents", "skills"),
			"outside-skill",
			makeSkillMd({ name: "outside-skill", description: "Out." }),
		);

		const home = makeTempDir("home-empty2");
		const skills = discoverOpenAiSkills({ cwd: repo, homeDir: home });

		expect(skills.map((s) => s.name)).toEqual([]);
	});

	it("only scans cwd when there is no repo root", () => {
		const base = makeTempDir("no-repo");
		const parentSkills = join(base, ".agents", "skills");
		mkdirSync(parentSkills, { recursive: true });
		writeSkill(parentSkills, "parent-skill", makeSkillMd({ name: "parent-skill", description: "Parent." }));

		const cwd = join(base, "plain");
		const cwdSkills = join(cwd, ".agents", "skills");
		mkdirSync(cwdSkills, { recursive: true });
		writeSkill(cwdSkills, "cwd-skill", makeSkillMd({ name: "cwd-skill", description: "Cwd." }));

		const home = makeTempDir("home-empty3");
		const skills = discoverOpenAiSkills({ cwd, homeDir: home });

		expect(skills.map((s) => s.name)).toEqual(["cwd-skill"]);
	});

	it("discovers user-scope skills from homeDir/.agents/skills", () => {
		const repo = makeTempDir("repo-user");
		mkdirSync(join(repo, ".git"), { recursive: true });

		const home = makeTempDir("home");
		writeSkill(
			join(home, ".agents", "skills"),
			"user-skill",
			makeSkillMd({ name: "user-skill", description: "User." }),
		);

		const skills = discoverOpenAiSkills({ cwd: repo, homeDir: home });
		const userSkill = skills.find((s) => s.name === "user-skill");

		expect(userSkill).toBeDefined();
		expect(userSkill?.scope).toBe("user");
		expect(userSkill?.diagnostics).toHaveLength(0);
	});

	it("discovers admin-scope skills from adminDir", () => {
		const repo = makeTempDir("repo-admin");
		mkdirSync(join(repo, ".git"), { recursive: true });

		const admin = makeTempDir("admin");
		writeSkill(admin, "admin-skill", makeSkillMd({ name: "admin-skill", description: "Admin." }));

		const home = makeTempDir("home-empty4");
		const skills = discoverOpenAiSkills({ cwd: repo, homeDir: home, adminDir: admin });
		const adminSkill = skills.find((s) => s.name === "admin-skill");

		expect(adminSkill).toBeDefined();
		expect(adminSkill?.scope).toBe("admin");
	});

	it("does not merge same-name skills; later ones are marked duplicate-of the first", () => {
		const repo = makeTempDir("repo-dup");
		mkdirSync(join(repo, ".git"), { recursive: true });

		const repoSkills = join(repo, ".agents", "skills");
		const home = makeTempDir("home-dup");

		writeSkill(repoSkills, "shared", makeSkillMd({ name: "shared", description: "Repo copy." }));
		writeSkill(join(home, ".agents", "skills"), "shared", makeSkillMd({ name: "shared", description: "User copy." }));

		const skills = discoverOpenAiSkills({ cwd: repo, homeDir: home });
		const shared = skills.filter((s) => s.name === "shared");

		expect(shared).toHaveLength(2);
		expect(shared[0]?.scope).toBe("repo");
		expect(shared[0]?.duplicateOf).toBeUndefined();
		expect(shared[1]?.scope).toBe("user");
		expect(shared[1]?.duplicateOf).toBe(shared[0]?.skillMdPath);
	});

	it("follows symlinked skill directories", () => {
		const repo = makeTempDir("repo-symlink");
		mkdirSync(join(repo, ".git"), { recursive: true });
		const home = makeTempDir("home-symlink");

		// A real skill directory outside any scan root, symlinked into the user scope.
		const realSkillDir = join(home, "real-skills", "linked-skill");
		writeSkill(
			join(home, "real-skills"),
			"linked-skill",
			makeSkillMd({ name: "linked-skill", description: "Linked." }),
		);

		const userSkills = join(home, ".agents", "skills");
		mkdirSync(userSkills, { recursive: true });
		symlinkSync(realSkillDir, join(userSkills, "linked-skill"));

		const skills = discoverOpenAiSkills({ cwd: repo, homeDir: home });

		expect(skills).toHaveLength(1);
		expect(skills[0]?.name).toBe("linked-skill");
		expect(skills[0]?.scope).toBe("user");
		// The skill is reported at its discovery site, not resolved to the real path.
		expect(skills[0]?.skillMdPath).toBe(join(userSkills, "linked-skill", "SKILL.md"));
		expect(skills[0]?.skillDir).toBe(join(userSkills, "linked-skill"));
		expect(skills[0]?.diagnostics).toHaveLength(0);
	});

	it("deduplicates the same physical directory reached through two symlinks", () => {
		const repo = makeTempDir("repo-symlink2");
		mkdirSync(join(repo, ".git"), { recursive: true });
		const home = makeTempDir("home-symlink2");

		const realSkillDir = join(home, "real-skills", "one-skill");
		writeSkill(join(home, "real-skills"), "one-skill", makeSkillMd({ name: "one-skill", description: "One." }));

		const repoSkills = join(repo, ".agents", "skills");
		mkdirSync(repoSkills, { recursive: true });
		symlinkSync(realSkillDir, join(repoSkills, "one-skill"));

		const userSkills = join(home, ".agents", "skills");
		mkdirSync(userSkills, { recursive: true });
		symlinkSync(realSkillDir, join(userSkills, "one-skill"));

		const skills = discoverOpenAiSkills({ cwd: repo, homeDir: home });

		expect(skills).toHaveLength(1);
		expect(skills[0]?.name).toBe("one-skill");
		expect(skills[0]?.scope).toBe("repo");
	});

	it("skips broken symlinks and directories without SKILL.md", () => {
		const repo = makeTempDir("repo-broken");
		mkdirSync(join(repo, ".git"), { recursive: true });
		const home = makeTempDir("home-broken");

		const repoSkills = join(repo, ".agents", "skills");
		mkdirSync(repoSkills, { recursive: true });
		symlinkSync(join(home, "does-not-exist"), join(repoSkills, "broken-link"));
		mkdirSync(join(repoSkills, "no-skill-md"), { recursive: true });

		const skills = discoverOpenAiSkills({ cwd: repo, homeDir: home });
		expect(skills).toHaveLength(0);
	});

	it("loads the openai.yaml overlay next to SKILL.md", () => {
		const repo = makeTempDir("repo-overlay");
		mkdirSync(join(repo, ".git"), { recursive: true });
		const home = makeTempDir("home-overlay");

		writeSkill(
			join(repo, ".agents", "skills"),
			"overlaid",
			makeSkillMd({ name: "overlaid", description: "With overlay." }),
			["interface:", "  display_name: Overlaid", "policy:", "  allow_implicit_invocation: false"].join("\n"),
		);

		const skills = discoverOpenAiSkills({ cwd: repo, homeDir: home });

		expect(skills).toHaveLength(1);
		expect(skills[0]?.openaiConfig?.interface?.displayName).toBe("Overlaid");
		expect(skills[0]?.openaiConfig?.policy.allowImplicitInvocation).toBe(false);
		expect(skills[0]?.diagnostics).toHaveLength(0);
	});

	it("carries per-skill diagnostics without dropping the skill", () => {
		const repo = makeTempDir("repo-diag");
		mkdirSync(join(repo, ".git"), { recursive: true });
		const home = makeTempDir("home-diag");

		writeSkill(join(repo, ".agents", "skills"), "mismatch", makeSkillMd({ name: "different", description: "Desc." }));

		const skills = discoverOpenAiSkills({ cwd: repo, homeDir: home });

		expect(skills).toHaveLength(1);
		expect(skills[0]?.name).toBe("different");
		expect(skills[0]?.diagnostics.some((d) => d.message.includes("does not match parent directory"))).toBe(true);
	});

	it("reports broken openai.yaml as an error diagnostic on the skill", () => {
		const repo = makeTempDir("repo-bad-yaml");
		mkdirSync(join(repo, ".git"), { recursive: true });
		const home = makeTempDir("home-bad-yaml");

		writeSkill(
			join(repo, ".agents", "skills"),
			"bad-overlay",
			makeSkillMd({ name: "bad-overlay", description: "Desc." }),
			"interface: [unclosed\n",
		);

		const skills = discoverOpenAiSkills({ cwd: repo, homeDir: home });

		expect(skills).toHaveLength(1);
		expect(skills[0]?.openaiConfig).toBeUndefined();
		expect(skills[0]?.diagnostics.some((d) => d.type === "error" && d.path?.endsWith("openai.yaml"))).toBe(true);
	});

	it("scans extraDirs with path scope", () => {
		const repo = makeTempDir("repo-extra");
		mkdirSync(join(repo, ".git"), { recursive: true });
		const home = makeTempDir("home-extra");
		const extra = makeTempDir("extra");

		writeSkill(extra, "extra-skill", makeSkillMd({ name: "extra-skill", description: "Extra." }));

		const skills = discoverOpenAiSkills({ cwd: repo, homeDir: home, extraDirs: [extra] });
		const extraSkill = skills.find((s) => s.name === "extra-skill");

		expect(extraSkill).toBeDefined();
		expect(extraSkill?.scope).toBe("path");
	});

	it("defaults the skill name to the directory name when frontmatter omits it", () => {
		const repo = makeTempDir("repo-noname");
		mkdirSync(join(repo, ".git"), { recursive: true });
		const home = makeTempDir("home-noname");

		writeSkill(join(repo, ".agents", "skills"), "dir-named", makeSkillMd({ description: "Desc." }));

		const skills = discoverOpenAiSkills({ cwd: repo, homeDir: home });

		expect(skills).toHaveLength(1);
		expect(skills[0]?.name).toBe("dir-named");
		expect(skills[0]?.diagnostics.some((d) => d.message === "name is required")).toBe(true);
	});

	it("returns an empty list when nothing exists", () => {
		const repo = makeTempDir("repo-empty");
		const home = makeTempDir("home-empty5");
		const admin = makeTempDir("admin-empty");

		const skills = discoverOpenAiSkills({ cwd: repo, homeDir: home, adminDir: admin });
		expect(skills).toHaveLength(0);
	});
});
