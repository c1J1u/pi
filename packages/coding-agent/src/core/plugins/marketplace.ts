/**
 * Plugin marketplace catalogs (OpenAI Codex format).
 *
 * Sources verified 2026-10-16 (see docs/byte-c1j1u/spec-sources.md):
 * - Repo marketplace: `$REPO_ROOT/.agents/plugins/marketplace.json`
 * - Personal marketplace: `~/.agents/plugins/marketplace.json`
 * - Legacy-compatible: `$REPO_ROOT/.claude-plugin/marketplace.json`
 * - Codex installs to `~/.codex/plugins/cache/$MARKETPLACE/$PLUGIN/$VERSION/`; Byte c1J1u
 *   intentionally keeps its cache under the Pi agent dir (`~/.pi/agent/plugins/cache/...`) so a
 *   user's real Codex installation is never touched (product-boundary decision, see
 *   docs/byte-c1j1u/spec-sources.md).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type MarketplaceSource =
	| { source: "local"; path: string }
	| { source: "git-subdir"; url: string; path: string; ref?: string; sha?: string }
	| { source: "npm"; package: string; version?: string; registry?: string };

export type InstallationPolicy = "AVAILABLE" | "INSTALLED_BY_DEFAULT" | "NOT_AVAILABLE";
export type AuthenticationPolicy = "ON_INSTALL" | "ON_FIRST_USE";

export interface MarketplacePluginEntry {
	name: string;
	source: MarketplaceSource;
	policy: {
		installation: InstallationPolicy;
		authentication: AuthenticationPolicy;
	};
	category?: string;
	interface?: { displayName?: string };
}

export interface MarketplaceCatalog {
	name: string;
	/** File the catalog was read from. */
	filePath: string;
	/** `repo`, `personal`, or `legacy-repo`. */
	kind: "repo" | "personal" | "legacy-repo";
	interface?: { displayName?: string };
	plugins: MarketplacePluginEntry[];
}

export type MarketplaceReadResult =
	| { status: "ok"; catalog: MarketplaceCatalog }
	| { status: "not-found" }
	| { status: "invalid"; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSource(value: unknown, errors: string[]): MarketplaceSource | undefined {
	if (typeof value === "string") {
		// Local entries can also be a plain string path.
		return { source: "local", path: value };
	}
	if (!isRecord(value)) {
		errors.push("marketplace entry: source must be an object or a plain path string");
		return undefined;
	}
	switch (value.source) {
		case "local":
			if (typeof value.path !== "string") {
				errors.push("marketplace entry: local source requires path");
				return undefined;
			}
			return { source: "local", path: value.path };
		case "url":
		case "git-subdir": {
			if (typeof value.url !== "string") {
				errors.push("marketplace entry: git source requires url");
				return undefined;
			}
			const entry: MarketplaceSource = { source: "git-subdir", url: value.url, path: "./" };
			if (typeof value.path === "string") entry.path = value.path;
			if (typeof value.ref === "string") entry.ref = value.ref;
			if (typeof value.sha === "string") entry.sha = value.sha;
			return entry;
		}
		case "npm": {
			if (typeof value.package !== "string") {
				errors.push("marketplace entry: npm source requires package");
				return undefined;
			}
			const entry: MarketplaceSource = { source: "npm", package: value.package };
			if (typeof value.version === "string") entry.version = value.version;
			if (typeof value.registry === "string") entry.registry = value.registry;
			return entry;
		}
		default:
			errors.push(`marketplace entry: unsupported source type "${String(value.source)}"`);
			return undefined;
	}
}

/**
 * Read one marketplace catalog file. `kind` is derived from the caller's location;
 * only git-backed and npm entries resolve lazily at install time.
 */
export function readMarketplaceCatalog(filePath: string, kind: MarketplaceCatalog["kind"]): MarketplaceReadResult {
	if (!existsSync(filePath)) return { status: "not-found" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error) {
		return { status: "invalid", errors: [error instanceof Error ? error.message : String(error)] };
	}
	if (!isRecord(parsed)) {
		return { status: "invalid", errors: ["marketplace.json must be a JSON object"] };
	}
	const errors: string[] = [];
	const name = parsed.name;
	if (typeof name !== "string" || name.length === 0) {
		return { status: "invalid", errors: ["marketplace.json: name is required"] };
	}
	const catalog: MarketplaceCatalog = {
		name,
		filePath,
		kind,
		plugins: [],
	};
	if (isRecord(parsed.interface) && typeof parsed.interface.displayName === "string") {
		catalog.interface = { displayName: parsed.interface.displayName };
	}
	if (!Array.isArray(parsed.plugins)) {
		return { status: "invalid", errors: ["marketplace.json: plugins must be an array"] };
	}
	for (const rawEntry of parsed.plugins) {
		if (!isRecord(rawEntry)) {
			errors.push("marketplace.json: plugins entries must be objects");
			continue;
		}
		const entryName = rawEntry.name;
		if (typeof entryName !== "string" || entryName.length === 0) {
			errors.push("marketplace.json: plugin entry requires name");
			continue;
		}
		const source = readSource(rawEntry.source, errors);
		if (!source) continue;
		const policyRaw = isRecord(rawEntry.policy) ? rawEntry.policy : {};
		const installation = policyRaw.installation;
		const authentication = policyRaw.authentication;
		if (installation !== "AVAILABLE" && installation !== "INSTALLED_BY_DEFAULT" && installation !== "NOT_AVAILABLE") {
			errors.push(`marketplace.json: ${entryName}: invalid policy.installation "${String(installation)}"`);
			continue;
		}
		if (authentication !== "ON_INSTALL" && authentication !== "ON_FIRST_USE") {
			errors.push(`marketplace.json: ${entryName}: invalid policy.authentication "${String(authentication)}"`);
			continue;
		}
		const entry: MarketplacePluginEntry = {
			name: entryName,
			source,
			policy: { installation, authentication },
		};
		if (typeof rawEntry.category === "string") entry.category = rawEntry.category;
		if (isRecord(rawEntry.interface) && typeof rawEntry.interface.displayName === "string") {
			entry.interface = { displayName: rawEntry.interface.displayName };
		}
		catalog.plugins.push(entry);
	}
	if (errors.length > 0) return { status: "invalid", errors };
	return { status: "ok", catalog };
}

/** Standard marketplace file locations for a repo root and a user home. */
export function marketplaceLocations(
	repoRoot: string,
	homeDir: string,
): Array<{
	filePath: string;
	kind: MarketplaceCatalog["kind"];
}> {
	return [
		{ filePath: join(repoRoot, ".agents", "plugins", "marketplace.json"), kind: "repo" },
		{ filePath: join(repoRoot, ".claude-plugin", "marketplace.json"), kind: "legacy-repo" },
		{ filePath: join(homeDir, ".agents", "plugins", "marketplace.json"), kind: "personal" },
	];
}
