import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LOCAL_VERSION, PluginLifecycle } from "../../src/core/plugins/lifecycle.ts";
import { hooksFieldEntries, readPluginManifest, resolvePluginPath } from "../../src/core/plugins/manifest.ts";
import { marketplaceLocations, readMarketplaceCatalog } from "../../src/core/plugins/marketplace.ts";
import { readPluginMcpConfig } from "../../src/core/plugins/mcp-config.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "pi-plugins-test-"));
afterAll(() => {
	rmSync(tempRoot, { recursive: true, force: true });
});

function writePortablePlugin(dir: string, options: { withExtension?: boolean; withOverlay?: boolean }): void {
	mkdirSync(dir, { recursive: true });
	const manifest: Record<string, unknown> = {
		$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
		name: "my-plugin",
		version: "0.1.0",
		description: "test plugin",
	};
	if (options.withExtension) {
		manifest.extensions = {
			"com.openai": {
				hooks: "./hooks/hooks.json",
				interface: { displayName: "My Plugin" },
			},
		};
	}
	writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, "\t"));
	if (options.withOverlay) {
		mkdirSync(join(dir, ".codex-plugin"), { recursive: true });
		writeFileSync(
			join(dir, ".codex-plugin", "plugin.json"),
			JSON.stringify({ hooks: "./overlay-hooks.json", interface: { displayName: "Overlay" } }),
		);
	}
}

describe("plugin manifest", () => {
	it("reads a portable manifest", () => {
		const dir = join(tempRoot, "portable");
		writePortablePlugin(dir, {});
		const result = readPluginManifest(dir);
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.manifest.name).toBe("my-plugin");
		expect(result.manifest.version).toBe("0.1.0");
		expect(result.manifest.openaiExtension).toBeUndefined();
	});

	it("extensions.com.openai replaces the compat overlay (no merge)", () => {
		const dir = join(tempRoot, "extension-wins");
		writePortablePlugin(dir, { withExtension: true, withOverlay: true });
		const result = readPluginManifest(dir);
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.manifest.openaiFromCompatOverlay).toBe(false);
		// The overlay's interface.displayName "Overlay" must NOT appear.
		expect(result.manifest.openaiExtension?.interface?.displayName).toBe("My Plugin");
		expect(result.manifest.openaiExtension?.hooks).toBe("./hooks/hooks.json");
	});

	it("falls back to .codex-plugin/plugin.json when extensions.com.openai is absent", () => {
		const dir = join(tempRoot, "overlay-fallback");
		writePortablePlugin(dir, { withOverlay: true });
		const result = readPluginManifest(dir);
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.manifest.openaiFromCompatOverlay).toBe(true);
		expect(result.manifest.openaiExtension?.interface?.displayName).toBe("Overlay");
	});

	it("rejects invalid names and unknown fields", () => {
		const dir = join(tempRoot, "invalid");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "plugin.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
				name: "Bad_Name",
				bogus: 1,
			}),
		);
		const result = readPluginManifest(dir);
		expect(result.status).toBe("invalid");
		if (result.status !== "invalid") return;
		expect(result.errors.some((e) => e.includes("name"))).toBe(true);
		expect(result.errors.some((e) => e.includes('unknown field "bogus"'))).toBe(true);
	});

	it("reports not-found for directories without manifests", () => {
		const dir = join(tempRoot, "empty");
		mkdirSync(dir, { recursive: true });
		expect(readPluginManifest(dir).status).toBe("not-found");
	});

	it("enforces path containment for ./ paths", () => {
		const dir = join(tempRoot, "portable");
		expect(resolvePluginPath(dir, "./skills/hello/SKILL.md")).toMatchObject({
			path: join(dir, "skills", "hello", "SKILL.md"),
		});
		const escape = resolvePluginPath(dir, "../../etc/passwd");
		expect("error" in escape).toBe(true);
		const nonRelative = resolvePluginPath(dir, "skills/hello");
		expect("error" in nonRelative).toBe(true);
	});

	it("expands hooks field entries", () => {
		expect(hooksFieldEntries("./a.json")).toEqual({ paths: ["./a.json"], inline: [] });
		expect(hooksFieldEntries(["./a.json", { SessionStart: [] }] as string | string[])).toEqual({
			paths: ["./a.json"],
			inline: [{ SessionStart: [] }],
		});
		expect(hooksFieldEntries({ Stop: [] })).toEqual({ paths: [], inline: [{ Stop: [] }] });
	});
});

describe("marketplace", () => {
	it("reads a repo marketplace catalog", () => {
		const repoRoot = join(tempRoot, "repo");
		const pluginDir = join(repoRoot, "plugins", "my-plugin");
		writePortablePlugin(pluginDir, {});
		mkdirSync(join(repoRoot, ".agents", "plugins"), { recursive: true });
		const marketplaceFile = join(repoRoot, ".agents", "plugins", "marketplace.json");
		writeFileSync(
			marketplaceFile,
			JSON.stringify({
				name: "local-repo",
				plugins: [
					{
						name: "my-plugin",
						source: { source: "local", path: "./plugins/my-plugin" },
						policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
						category: "Productivity",
					},
				],
			}),
		);
		const result = readMarketplaceCatalog(marketplaceFile, "repo");
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.catalog.name).toBe("local-repo");
		expect(result.catalog.plugins).toHaveLength(1);
		expect(result.catalog.plugins[0]?.policy.installation).toBe("AVAILABLE");
	});

	it("rejects catalogs with invalid policies", () => {
		const dir = join(tempRoot, "bad-marketplace");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "marketplace.json");
		writeFileSync(
			file,
			JSON.stringify({
				name: "bad",
				plugins: [{ name: "x", source: "./x", policy: { installation: "SOMETIMES" } }],
			}),
		);
		const result = readMarketplaceCatalog(file, "repo");
		expect(result.status).toBe("invalid");
	});

	it("lists standard marketplace locations", () => {
		const locations = marketplaceLocations("/repo", "/home");
		expect(locations.map((l) => l.kind)).toEqual(["repo", "legacy-repo", "personal"]);
		expect(locations[0]?.filePath).toBe(join("/repo", ".agents", "plugins", "marketplace.json"));
	});
});

describe("plugin lifecycle", () => {
	it("installs a local plugin into the versioned cache and tracks enablement", () => {
		const cacheDir = join(tempRoot, "cache");
		const stateFile = join(tempRoot, "state", "plugins.json");
		const lifecycle = new PluginLifecycle({ cacheDir, stateFile });

		const repoRoot = join(tempRoot, "lifecycle-repo");
		// source.path resolves relative to the marketplace root (.agents/plugins), so the
		// plugin lives beside marketplace.json under ./plugins/.
		const pluginDir = join(repoRoot, ".agents", "plugins", "plugins", "my-plugin");
		writePortablePlugin(pluginDir, {});
		const marketplaceFile = join(repoRoot, ".agents", "plugins", "marketplace.json");
		writeFileSync(
			marketplaceFile,
			JSON.stringify({
				name: "local-repo",
				plugins: [
					{
						name: "my-plugin",
						source: { source: "local", path: "./plugins/my-plugin" },
						policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
						category: "Productivity",
					},
				],
			}),
		);
		const catalog = readMarketplaceCatalog(marketplaceFile, "repo");
		if (catalog.status !== "ok") throw new Error("marketplace setup failed");
		const install = lifecycle.installLocal(catalog.catalog, "my-plugin");
		expect(install.diagnostics).toEqual([]);
		expect(install.plugin).toBeDefined();
		expect(install.plugin?.version).toBe("0.1.0");
		expect(install.plugin?.enabled).toBe(false);

		lifecycle.setEnabled("local-repo", "my-plugin", true);
		expect(lifecycle.isEnabled("local-repo", "my-plugin")).toBe(true);
		expect(lifecycle.listInstalled()).toHaveLength(1);

		// Enabled installs are never hot-swapped: reinstall returns the existing record.
		const again = lifecycle.installLocal(catalog.catalog, "my-plugin");
		expect(again.plugin?.rootDir).toBe(install.plugin?.rootDir);

		const uninstall = lifecycle.uninstall("local-repo", "my-plugin");
		expect(uninstall.diagnostics).toEqual([]);
		expect(lifecycle.listInstalled()).toHaveLength(0);
		expect(lifecycle.isEnabled("local-repo", "my-plugin")).toBe(false);
	});

	it("uses version local when the manifest omits version", () => {
		const dir = join(tempRoot, "unversioned");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "plugin.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
				name: "unversioned",
			}),
		);
		const result = readPluginManifest(dir);
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.manifest.version).toBeUndefined();

		const cacheDir = join(tempRoot, "cache2");
		const stateFile = join(tempRoot, "state2", "plugins.json");
		const lifecycle = new PluginLifecycle({ cacheDir, stateFile });
		// Reuse the installed-listing path with LOCAL_VERSION semantics.
		expect(LOCAL_VERSION).toBe("local");
		expect(lifecycle.listInstalled()).toHaveLength(0);
	});
});

describe("plugin mcp config", () => {
	it("reads portable mcp.json with typed servers", () => {
		const dir = join(tempRoot, "mcp-portable");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "mcp.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					docs: { type: "streamable-http", url: "https://example.com/mcp" },
					local: { type: "stdio", command: "node", args: ["server.js"], cwd: "./" },
				},
			}),
		);
		const config = readPluginMcpConfig(dir);
		expect(config).toBeDefined();
		expect(config?.servers.docs).toEqual({ type: "streamable-http", url: "https://example.com/mcp" });
		expect(config?.servers.local).toMatchObject({ type: "stdio", command: "node" });
		expect(config?.diagnostics).toEqual([]);
	});

	it("rejects reserved env keys and escaping cwd in portable format", () => {
		const dir = join(tempRoot, "mcp-invalid");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					bad: {
						type: "stdio",
						command: "node",
						env: { PLUGIN_ROOT: "/elsewhere" },
						cwd: "/absolute/escape",
						bogus: true,
					},
				},
			}),
		);
		const config = readPluginMcpConfig(dir);
		expect(config?.diagnostics.some((d) => d.includes("PLUGIN_ROOT"))).toBe(true);
		expect(config?.diagnostics.some((d) => d.includes("cwd"))).toBe(true);
		expect(config?.diagnostics.some((d) => d.includes('unknown field "bogus"'))).toBe(true);
	});

	it("reads codex-compat .mcp.json only when mcp.json is absent", () => {
		const dir = join(tempRoot, "mcp-compat");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					sample: {
						type: "http",
						url: "https://mcp.example.com/mcp",
						oauth: { clientId: "my-client", callbackUrl: "http://127.0.0.1/callback/registered" },
					},
				},
			}),
		);
		const config = readPluginMcpConfig(dir);
		expect(config?.servers.sample).toMatchObject({ type: "streamable-http" });
		// OAuth declarations surface as diagnostics; secrets are rejected.
		writeFileSync(
			join(dir, ".mcp.json"),
			JSON.stringify({
				mcpServers: { s: { type: "http", url: "https://x", oauth: { clientId: "c", clientSecret: "shh" } } },
			}),
		);
		const rejected = readPluginMcpConfig(dir);
		expect(rejected?.diagnostics.some((d) => d.includes("clientSecret"))).toBe(true);
	});
});
