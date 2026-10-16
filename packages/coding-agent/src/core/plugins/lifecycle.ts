/**
 * Plugin lifecycle: install into the cache, enable/disable, update, uninstall.
 *
 * Cache layout follows the OpenAI Codex convention verified 2026-10-16:
 * `<pluginCacheDir>/$MARKETPLACE_NAME/$PLUGIN_NAME/$VERSION/` where local plugins use the
 * version `local`. Enabled state is recorded per `plugin@marketplace` key in the plugin
 * state file. Uninstall removes the cache copy; associated skills/MCP registrations are
 * re-derived from the remaining enabled plugin set (see the capability catalog).
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type PluginManifest, readPluginManifest } from "./manifest.ts";
import type { MarketplaceCatalog } from "./marketplace.ts";

export const LOCAL_VERSION = "local";

export interface InstalledPlugin {
	/** Cache root containing this install. */
	cacheRoot: string;
	marketplaceName: string;
	name: string;
	version: string;
	/** Absolute path of the installed plugin root. */
	rootDir: string;
	manifest: PluginManifest;
	enabled: boolean;
}

export interface PluginStateFile {
	schemaVersion: 1;
	enabled: Record<string, boolean>;
}

export interface PluginInstallResult {
	plugin?: InstalledPlugin;
	diagnostics: string[];
}

export class PluginLifecycle {
	private readonly cacheDir: string;
	private readonly stateFile: string;
	private state: PluginStateFile;

	constructor(options: { cacheDir: string; stateFile: string }) {
		this.cacheDir = options.cacheDir;
		this.stateFile = options.stateFile;
		this.state = this.loadState();
	}

	private loadState(): PluginStateFile {
		if (!existsSync(this.stateFile)) return { schemaVersion: 1, enabled: {} };
		try {
			const parsed = JSON.parse(readFileSync(this.stateFile, "utf8")) as Partial<PluginStateFile>;
			if (parsed.schemaVersion === 1 && typeof parsed.enabled === "object" && parsed.enabled !== null) {
				return { schemaVersion: 1, enabled: parsed.enabled };
			}
		} catch {}
		return { schemaVersion: 1, enabled: {} };
	}

	private saveState(): void {
		mkdirSync(dirname(this.stateFile), { recursive: true });
		writeFileSync(this.stateFile, `${JSON.stringify(this.state, null, "\t")}\n`);
	}

	pluginKey(marketplaceName: string, pluginName: string): string {
		return `${pluginName}@${marketplaceName}`;
	}

	isEnabled(marketplaceName: string, pluginName: string): boolean {
		return this.state.enabled[this.pluginKey(marketplaceName, pluginName)] === true;
	}

	setEnabled(marketplaceName: string, pluginName: string, enabled: boolean): void {
		this.state.enabled[this.pluginKey(marketplaceName, pluginName)] = enabled;
		this.saveState();
	}

	/** Install a local plugin from a marketplace entry into the cache and return its record. */
	installLocal(catalog: MarketplaceCatalog, pluginName: string): PluginInstallResult {
		const entry = catalog.plugins.find((p) => p.name === pluginName);
		if (!entry) {
			return { diagnostics: [`plugin "${pluginName}" not found in marketplace "${catalog.name}"`] };
		}
		if (entry.source.source !== "local") {
			return {
				diagnostics: [
					`plugin "${pluginName}" uses a ${entry.source.source} source; only local sources install synchronously`,
				],
			};
		}
		if (entry.policy.installation === "NOT_AVAILABLE") {
			return { diagnostics: [`plugin "${pluginName}" is marked NOT_AVAILABLE in its marketplace`] };
		}
		// Marketplace paths are ./-prefixed relative to the marketplace root.
		const sourceRoot = dirname(catalog.filePath);
		const sourceDir = join(sourceRoot, entry.source.path.replace(/^\.\//u, ""));
		if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
			return { diagnostics: [`plugin source directory does not exist: ${sourceDir}`] };
		}

		const manifestResult = readPluginManifest(sourceDir);
		if (manifestResult.status === "not-found") {
			return { diagnostics: [`no plugin.json or .codex-plugin/plugin.json in ${sourceDir}`] };
		}
		if (manifestResult.status === "invalid") {
			return { diagnostics: manifestResult.errors };
		}
		const manifest = manifestResult.manifest;
		if (manifest.name !== pluginName) {
			return {
				diagnostics: [`manifest name "${manifest.name}" does not match marketplace entry name "${pluginName}"`],
			};
		}

		const version = manifest.version ?? LOCAL_VERSION;
		const installDir = join(this.cacheDir, catalog.name, pluginName, version);
		// Versioned installs never hot-swap: refuse to overwrite an in-use version.
		if (existsSync(installDir) && this.isEnabled(catalog.name, pluginName)) {
			const existing = this.readInstalled(catalog.name, pluginName, version);
			if (existing) return { plugin: existing, diagnostics: [] };
		}
		rmSync(installDir, { recursive: true, force: true });
		mkdirSync(dirname(installDir), { recursive: true });
		cpSync(sourceDir, installDir, { recursive: true });

		const plugin: InstalledPlugin = {
			cacheRoot: this.cacheDir,
			marketplaceName: catalog.name,
			name: pluginName,
			version,
			rootDir: installDir,
			manifest,
			enabled: this.isEnabled(catalog.name, pluginName),
		};
		return { plugin, diagnostics: [] };
	}

	/** Read an installed plugin without reinstalling. */
	readInstalled(marketplaceName: string, pluginName: string, version: string): InstalledPlugin | undefined {
		const rootDir = join(this.cacheDir, marketplaceName, pluginName, version);
		if (!existsSync(rootDir)) return undefined;
		const manifestResult = readPluginManifest(rootDir);
		if (manifestResult.status !== "ok") return undefined;
		return {
			cacheRoot: this.cacheDir,
			marketplaceName,
			name: pluginName,
			version,
			rootDir,
			manifest: manifestResult.manifest,
			enabled: this.isEnabled(marketplaceName, pluginName),
		};
	}

	/** All installed plugins (every version directory present in the cache). */
	listInstalled(): InstalledPlugin[] {
		const installed: InstalledPlugin[] = [];
		if (!existsSync(this.cacheDir)) return installed;
		for (const marketplaceName of readdirSync(this.cacheDir)) {
			const marketDir = join(this.cacheDir, marketplaceName);
			if (!statSync(marketDir).isDirectory()) continue;
			for (const pluginName of readdirSync(marketDir)) {
				const pluginDir = join(marketDir, pluginName);
				if (!statSync(pluginDir).isDirectory()) continue;
				for (const version of readdirSync(pluginDir)) {
					const plugin = this.readInstalled(marketplaceName, pluginName, version);
					if (plugin) installed.push(plugin);
				}
			}
		}
		return installed;
	}

	/**
	 * Uninstall a plugin: remove its cache directory. Enabled flag is dropped so a later
	 * reinstall starts disabled. Caller re-derives capabilities from remaining plugins.
	 */
	uninstall(marketplaceName: string, pluginName: string): { diagnostics: string[] } {
		const pluginDir = join(this.cacheDir, marketplaceName, pluginName);
		if (!existsSync(pluginDir)) {
			return { diagnostics: [`plugin "${pluginName}@${marketplaceName}" is not installed`] };
		}
		rmSync(pluginDir, { recursive: true, force: true });
		delete this.state.enabled[this.pluginKey(marketplaceName, pluginName)];
		this.saveState();
		return { diagnostics: [] };
	}

	/** Content hash of a plugin root, used for update detection. */
	static pluginDigest(rootDir: string): string {
		const hash = createHash("sha256");
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir).sort()) {
				if (entry === ".DS_Store" || entry.startsWith(".git")) continue;
				const full = join(dir, entry);
				if (statSync(full).isDirectory()) {
					walk(full);
				} else {
					hash.update(entry);
					hash.update(readFileSync(full));
				}
			}
		};
		walk(rootDir);
		return hash.digest("hex");
	}
}
