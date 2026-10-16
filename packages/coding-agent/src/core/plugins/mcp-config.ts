/**
 * Portable mcp.json (Agent Plugins 1.0.0) and Codex-style .mcp.json reading.
 *
 * Sources verified 2026-10-16 (see docs/byte-c1j1u/spec-sources.md):
 * - Portable: `mcp.json` at plugin root with `$schema` mcp.schema.json; servers keyed by
 *   name under `mcpServers` with strict per-type fields (stdio / streamable-http / sse).
 * - Codex plugin compat: `.mcp.json` with camelCase `oauth.clientId` etc.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface PortableMcpStdioServer {
	type: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

export interface PortableMcpHttpServer {
	type: "streamable-http" | "sse";
	url: string;
	headers?: Record<string, string>;
}

export type PortableMcpServer = PortableMcpStdioServer | PortableMcpHttpServer;

export interface PortableMcpConfig {
	/** File the config was read from. */
	filePath: string;
	servers: Record<string, PortableMcpServer>;
	diagnostics: string[];
}

const STDIO_FIELDS = new Set(["type", "command", "args", "env", "cwd"]);
const HTTP_FIELDS = new Set(["type", "url", "headers", "oauth", "extensions"]);
const CWD_PATTERN = /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read `mcp.json` (portable) with `.mcp.json` (Codex compat) as a secondary source.
 * The portable file wins; `.mcp.json` is read only when `mcp.json` is absent.
 */
export function readPluginMcpConfig(pluginRoot: string): PortableMcpConfig | undefined {
	for (const [filename, kind] of [
		["mcp.json", "portable"],
		[".mcp.json", "codex-compat"],
	] as const) {
		const filePath = join(pluginRoot, filename);
		if (!existsSync(filePath)) continue;
		return parseMcpConfigFile(filePath, kind);
	}
	return undefined;
}

function parseMcpConfigFile(filePath: string, kind: "portable" | "codex-compat"): PortableMcpConfig {
	const diagnostics: string[] = [];
	const servers: Record<string, PortableMcpServer> = {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error) {
		diagnostics.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		return { filePath, servers, diagnostics };
	}
	if (!isRecord(parsed)) {
		diagnostics.push(`${filePath}: must be a JSON object`);
		return { filePath, servers, diagnostics };
	}
	const mcpServers = parsed.mcpServers;
	if (mcpServers === undefined) {
		diagnostics.push(`${filePath}: missing mcpServers object`);
		return { filePath, servers, diagnostics };
	}
	if (!isRecord(mcpServers)) {
		diagnostics.push(`${filePath}: mcpServers must be an object`);
		return { filePath, servers, diagnostics };
	}
	if (
		kind === "portable" &&
		parsed.$schema !== undefined &&
		parsed.$schema !== "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"
	) {
		diagnostics.push(`${filePath}: unsupported $schema "${String(parsed.$schema)}"`);
	}

	for (const [name, rawServer] of Object.entries(mcpServers)) {
		if (!isRecord(rawServer)) {
			diagnostics.push(`${filePath}: server "${name}" must be an object`);
			continue;
		}
		const server = parseServer(name, rawServer, kind, diagnostics, filePath);
		if (server) servers[name] = server;
	}
	return { filePath, servers, diagnostics };
}

function parseServer(
	name: string,
	value: Record<string, unknown>,
	kind: "portable" | "codex-compat",
	diagnostics: string[],
	filePath: string,
): PortableMcpServer | undefined {
	// Portable format requires an explicit type; the Codex compat format infers it:
	// command -> stdio, url -> http.
	let type = value.type;
	if (typeof type !== "string") {
		if (kind === "codex-compat" && typeof value.command === "string") type = "stdio";
		else if (kind === "codex-compat" && typeof value.url === "string") type = "http";
		else {
			diagnostics.push(`${filePath}: server "${name}" requires a type`);
			return undefined;
		}
	}
	if (type === "stdio" || (kind === "codex-compat" && type === "command")) {
		if (typeof value.command !== "string" || value.command.length === 0) {
			diagnostics.push(`${filePath}: stdio server "${name}" requires command`);
			return undefined;
		}
		const server: PortableMcpStdioServer = { type: "stdio", command: value.command };
		if (Array.isArray(value.args)) {
			server.args = value.args.filter((a): a is string => typeof a === "string");
		}
		if (isRecord(value.env)) {
			const env: Record<string, string> = {};
			for (const [key, val] of Object.entries(value.env)) {
				// PLUGIN_ROOT/PLUGIN_DATA are reserved; the transport injects them.
				if (key === "PLUGIN_ROOT" || key === "PLUGIN_DATA") {
					diagnostics.push(`${filePath}: stdio server "${name}": env "${key}" is reserved`);
					continue;
				}
				if (typeof val === "string") env[key] = val;
			}
			server.env = env;
		}
		if (typeof value.cwd === "string") {
			if (kind === "portable" && !CWD_PATTERN.test(value.cwd)) {
				diagnostics.push(
					`${filePath}: stdio server "${name}": cwd must be plugin-relative (./) or PLUGIN_ROOT/PLUGIN_DATA-rooted`,
				);
			} else {
				server.cwd = value.cwd;
			}
		}
		if (kind === "portable") {
			for (const key of Object.keys(value)) {
				if (!STDIO_FIELDS.has(key)) {
					diagnostics.push(`${filePath}: stdio server "${name}": unknown field "${key}"`);
				}
			}
		}
		return server;
	}
	if (type === "streamable-http" || type === "http" || type === "sse") {
		if (typeof value.url !== "string" || value.url.length === 0) {
			diagnostics.push(`${filePath}: http server "${name}" requires url`);
			return undefined;
		}
		const normalizedType = type === "http" ? "streamable-http" : (type as "streamable-http" | "sse");
		const server: PortableMcpHttpServer = { type: normalizedType, url: value.url };
		if (isRecord(value.headers)) {
			const headers: Record<string, string> = {};
			for (const [key, val] of Object.entries(value.headers)) {
				if (typeof val === "string") headers[key] = val;
			}
			server.headers = headers;
		}
		// OAuth declarations describe connection settings, not credentials; they are surfaced
		// through diagnostics so the host can run its own auth flow. Declared secrets are
		// rejected: the manifest must not carry credentials.
		if (isRecord(value.oauth)) {
			if ("clientSecret" in value.oauth) {
				diagnostics.push(`${filePath}: http server "${name}": oauth.clientSecret must not be in the package`);
			}
			diagnostics.push(`${filePath}: http server "${name}" declares oauth settings (host handles the auth flow)`);
		}
		if (kind === "portable") {
			for (const key of Object.keys(value)) {
				if (!HTTP_FIELDS.has(key)) {
					diagnostics.push(`${filePath}: http server "${name}": unknown field "${key}"`);
				}
			}
		}
		return server;
	}
	diagnostics.push(`${filePath}: server "${name}": unsupported type "${type}"`);
	return undefined;
}
