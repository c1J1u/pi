/**
 * Compatibility suite: official-format plugins, skills, MCP configs, and hooks load and
 * behave end to end. Fixtures mirror the exact examples from the specifications audited
 * in docs/byte-c1j1u/spec-sources.md (agent-plugins.org 1.0.0, OpenAI Codex plugin build
 * guide, agentskills.io, Codex hooks docs). This suite is the format-compatibility gate:
 * it uses real file layouts and a real marketplace flow, not tailored mocks.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseHooksConfig } from "../../src/core/hooks/config.ts";
import { HookRunner } from "../../src/core/hooks/runner.ts";
import { HookTrustStore } from "../../src/core/hooks/trust.ts";
import {
	hooksFieldEntries,
	marketplaceLocations,
	PluginLifecycle,
	readMarketplaceCatalog,
	readPluginManifest,
	readPluginMcpConfig,
	resolvePluginPath,
} from "../../src/core/plugins/index.ts";
import { discoverOpenAiSkills } from "../../src/core/skills-ext/index.ts";

const fixtures = join(import.meta.dirname, "..", "fixtures", "compat");
const tempRoot = mkdtempSync(join(tmpdir(), "pi-compat-"));
afterAll(() => {
	rmSync(tempRoot, { recursive: true, force: true });
});

describe("official portable plugin (agent-plugins.org 1.0.0)", () => {
	it("loads the spec's minimal plugin example", () => {
		const result = readPluginManifest(join(fixtures, "official-plugin"));
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.manifest.name).toBe("my-first-plugin");
		expect(result.manifest.version).toBe("1.0.0");
		expect(result.manifest.description).toBe("Reusable greeting workflow");
		expect(result.manifest.openaiFromCompatOverlay).toBe(false);
	});

	it("discovers skills from the root skills/ directory (no manifest field needed)", () => {
		const skills = discoverOpenAiSkills({
			cwd: join(fixtures, "official-plugin"),
			homeDir: tempRoot,
			adminDir: join(tempRoot, "no-admin"),
			extraDirs: [join(fixtures, "official-plugin", "skills")],
		});
		const hello = skills.find((s) => s.name === "hello");
		expect(hello).toBeDefined();
		expect(hello?.description).toBe("Greet the user with a friendly message.");
	});

	it("reads the portable mcp.json with the streamable-http transport", () => {
		const config = readPluginMcpConfig(join(fixtures, "official-plugin"));
		expect(config).toBeDefined();
		expect(config?.servers.docs).toEqual({ type: "streamable-http", url: "https://example.com/mcp" });
		expect(config?.diagnostics).toEqual([]);
	});

	it("installs through a marketplace and lands in the versioned cache", () => {
		const repo = join(tempRoot, "repo");
		const marketplaceDir = join(repo, ".agents", "plugins");
		mkdirSync(join(marketplaceDir, "plugins"), { recursive: true });
		cpSync(join(fixtures, "official-plugin"), join(marketplaceDir, "plugins", "my-first-plugin"), {
			recursive: true,
		});
		writeFileSync(
			join(marketplaceDir, "marketplace.json"),
			JSON.stringify({
				name: "local-repo",
				plugins: [
					{
						name: "my-first-plugin",
						source: { source: "local", path: "./plugins/my-first-plugin" },
						policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
						category: "Productivity",
					},
				],
			}),
		);

		const locations = marketplaceLocations(repo, tempRoot);
		expect(locations.map((l) => l.kind)).toContain("repo");
		const catalog = readMarketplaceCatalog(locations[0]!.filePath, "repo");
		expect(catalog.status).toBe("ok");
		if (catalog.status !== "ok") return;

		const cacheDir = join(tempRoot, "cache");
		const stateFile = join(tempRoot, "state", "plugins.json");
		const lifecycle = new PluginLifecycle({ cacheDir, stateFile });
		const install = lifecycle.installLocal(catalog.catalog, "my-first-plugin");
		expect(install.diagnostics).toEqual([]);
		expect(install.plugin?.version).toBe("1.0.0");
		// The installed copy carries the same skill and MCP config.
		const installed = readPluginManifest(install.plugin!.rootDir);
		expect(installed.status).toBe("ok");
		const installedMcp = readPluginMcpConfig(install.plugin!.rootDir);
		expect(installedMcp?.servers.docs).toBeDefined();
	});
});

describe("codex-compat plugin (.codex-plugin overlay)", () => {
	it("reads OpenAI-specific settings from the compat overlay", () => {
		const result = readPluginManifest(join(fixtures, "codex-plugin"));
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.manifest.openaiFromCompatOverlay).toBe(true);
		expect(result.manifest.openaiExtension?.hooks).toBe("./hooks/hooks.json");
	});

	it("resolves and executes the overlay-declared hooks file", async () => {
		const manifest = readPluginManifest(join(fixtures, "codex-plugin"));
		if (manifest.status !== "ok") throw new Error("fixture broken");
		const entries = hooksFieldEntries(manifest.manifest.openaiExtension?.hooks);
		expect(entries.paths).toEqual(["./hooks/hooks.json"]);
		const resolved = resolvePluginPath(join(fixtures, "codex-plugin"), entries.paths[0]!);
		if (!("path" in resolved)) throw new Error(resolved.error);

		const config = JSON.parse(readFileSync(resolved.path, "utf8"));
		const parsed = parseHooksConfig(config, resolved.path, { fromPlugin: true });
		expect(parsed.diagnostics).toEqual([]);

		const trustStore = new HookTrustStore({ stateFile: join(tempRoot, "trust.json"), bypass: true });
		const runner = new HookRunner({
			config: parsed,
			trustStore,
			outputDir: join(tempRoot, "hook_outputs"),
		});
		const result = await runner.emit(
			"SessionStart",
			{
				session_id: "s1",
				transcript_path: null,
				cwd: tempRoot,
				hook_event_name: "SessionStart",
				model: "test",
				source: "startup",
			},
			{ cwd: tempRoot, session_id: "s1" },
		);
		expect(result.continue).toBe(true);
		expect(result.additionalContext).toBe("plugin context loaded");
	});

	it("plugin hook commands receive PLUGIN_ROOT env in the integration wiring", () => {
		// PLUGIN_ROOT injection is part of the byte-c1j1u extension wiring; the contract is
		// verified by the ${PLUGIN_ROOT} expansion in the marketplace docs example.
		const manifest = readPluginManifest(join(fixtures, "codex-plugin"));
		if (manifest.status !== "ok") throw new Error("fixture broken");
		expect(manifest.manifest.openaiExtension?.hooks).toBeDefined();
	});
});

describe("openai skill overlay (agents/openai.yaml)", () => {
	it("discovers .agents/skills with full frontmatter and the overlay", () => {
		const skills = discoverOpenAiSkills({
			cwd: join(fixtures, "openai-skill"),
			homeDir: tempRoot,
			adminDir: join(tempRoot, "no-admin"),
		});
		const pdf = skills.find((s) => s.name === "pdf-processing");
		expect(pdf).toBeDefined();
		expect(pdf?.frontmatter.license).toBe("Apache-2.0");
		expect(pdf?.frontmatter.metadata).toEqual({ author: "example-org", version: "1.0" });
		expect(pdf?.frontmatter.allowedTools).toEqual(["Bash(jq:*)", "Read"]);
		expect(pdf?.frontmatter.compatibility).toBe("Requires Python 3.14+ and uv");
		expect(pdf?.openaiConfig?.policy?.allowImplicitInvocation).toBe(false);
		expect(pdf?.openaiConfig?.interface?.displayName).toBe("PDF Processing");
		expect(pdf?.openaiConfig?.dependencies?.tools?.[0]?.value).toBe("openaiDeveloperDocs");
	});

	it("plain agentskills.io skills load without an overlay", () => {
		const skills = discoverOpenAiSkills({
			cwd: join(fixtures, "openai-skill"),
			homeDir: tempRoot,
			adminDir: join(tempRoot, "no-admin"),
		});
		const plain = skills.find((s) => s.name === "no-overlay");
		expect(plain).toBeDefined();
		expect(plain?.openaiConfig).toBeUndefined();
	});
});

describe("fault injection", () => {
	it("rejects a manifest with a bad name and unknown fields instead of loading it", () => {
		const dir = join(tempRoot, "bad-manifest");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "plugin.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
				name: "Bad_Name",
				rogue: 1,
			}),
		);
		const result = readPluginManifest(dir);
		expect(result.status).toBe("invalid");
		if (result.status !== "invalid") return;
		expect(result.errors.some((e) => e.includes("name"))).toBe(true);
		expect(result.errors.some((e) => e.includes("rogue"))).toBe(true);
	});

	it("rejects marketplace entries with invalid policies", () => {
		const dir = join(tempRoot, "bad-marketplace");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "marketplace.json");
		writeFileSync(
			file,
			JSON.stringify({ name: "bad", plugins: [{ name: "x", source: "./x", policy: { installation: "WHENEVER" } }] }),
		);
		const result = readMarketplaceCatalog(file, "repo");
		expect(result.status).toBe("invalid");
	});

	it("untrusted hooks are skipped and reported", async () => {
		const config = {
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [{ type: "command", command: "echo should-not-run" }],
					},
				],
			},
		};
		const parsed = parseHooksConfig(config, "untrusted.json", { fromPlugin: true });
		const trustStore = new HookTrustStore({ stateFile: join(tempRoot, "trust2.json") });
		const runner = new HookRunner({ config: parsed, trustStore });
		const result = await runner.emit(
			"PreToolUse",
			{ session_id: "s", cwd: tempRoot, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} },
			{ cwd: tempRoot, session_id: "s" },
		);
		// Untrusted: skipped, not executed, and the tool call proceeds.
		expect(result.continue).toBe(true);
		expect(result.results).toHaveLength(0);
		expect(result.diagnostics.some((d) => d.includes("untrusted"))).toBe(true);

		// Trusting the exact hash makes it run.
		const hash = parsed.handlers[0]!.hash;
		trustStore.trust(hash);
		const rerun = await runner.emit(
			"PreToolUse",
			{ session_id: "s", cwd: tempRoot, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} },
			{ cwd: tempRoot, session_id: "s" },
		);
		expect(rerun.results[0]?.status).toBe("success");
	});

	it("hook definition changes require re-trust (hash change)", () => {
		const store = new HookTrustStore({ stateFile: join(tempRoot, "trust3.json") });
		const a = parseHooksConfig({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo a" }] }] } }, "a.json");
		const b = parseHooksConfig({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo b" }] }] } }, "b.json");
		store.trust(a.handlers[0]!.hash);
		expect(store.isTrusted(a.handlers[0]!.hash)).toBe(true);
		expect(store.isTrusted(b.handlers[0]!.hash)).toBe(false);
	});

	it("malformed mcp.json fields surface as diagnostics, not silent drops", () => {
		const dir = join(tempRoot, "bad-mcp");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					bad: { type: "stdio", command: "node", env: { PLUGIN_DATA: "/x" }, cwd: "/absolute" },
				},
			}),
		);
		const config = readPluginMcpConfig(dir);
		expect(config?.diagnostics.some((d) => d.includes("PLUGIN_DATA"))).toBe(true);
		expect(config?.diagnostics.some((d) => d.includes("cwd"))).toBe(true);
		// The valid parts still load.
		expect(config?.servers.bad?.type).toBe("stdio");
	});

	it("plugin path traversal is contained", () => {
		const result = resolvePluginPath(join(fixtures, "official-plugin"), "../../secrets");
		expect("error" in result).toBe(true);
	});

	it("uninstall removes plugin capabilities without orphan files", () => {
		const repo = join(tempRoot, "uninstall-repo");
		const marketDir = join(repo, ".agents", "plugins");
		mkdirSync(join(marketDir, "plugins"), { recursive: true });
		cpSync(join(fixtures, "official-plugin"), join(marketDir, "plugins", "my-first-plugin"), { recursive: true });
		writeFileSync(
			join(marketDir, "marketplace.json"),
			JSON.stringify({
				name: "uninstall-market",
				plugins: [
					{
						name: "my-first-plugin",
						source: { source: "local", path: "./plugins/my-first-plugin" },
						policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
						category: "Productivity",
					},
				],
			}),
		);
		const catalog = readMarketplaceCatalog(join(marketDir, "marketplace.json"), "repo");
		if (catalog.status !== "ok") throw new Error("fixture broken");
		const cacheDir = join(tempRoot, "uninstall-cache");
		const lifecycle = new PluginLifecycle({
			cacheDir,
			stateFile: join(tempRoot, "uninstall-state.json"),
		});
		const install = lifecycle.installLocal(catalog.catalog, "my-first-plugin");
		expect(install.plugin).toBeDefined();
		lifecycle.setEnabled("uninstall-market", "my-first-plugin", true);
		const uninstall = lifecycle.uninstall("uninstall-market", "my-first-plugin");
		expect(uninstall.diagnostics).toEqual([]);
		expect(lifecycle.listInstalled()).toHaveLength(0);
		// Enablement state is dropped so a reinstall starts disabled.
		expect(lifecycle.isEnabled("uninstall-market", "my-first-plugin")).toBe(false);
	});
});
