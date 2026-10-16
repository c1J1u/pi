/**
 * Unified capability catalog: the single source of truth for plugins, skills, MCP servers,
 * tools, and hooks — their identity, source, version, scope, availability, dependencies,
 * and execution constraints.
 *
 * Design rules (see docs/byte-c1j1u/architecture.md):
 * - Registered ≠ discovered ≠ listed ≠ selected ≠ authorized: each state is explicit.
 * - The catalog provides capability facts; the System One decision service judges relevance.
 * - Invalidation propagates: plugin updates, MCP disconnects, and skill disables bump the
 *   catalog version so decision caches cannot return stale capabilities.
 */

import { createHash } from "node:crypto";

export type CapabilityKind = "plugin" | "skill" | "mcp-server" | "tool" | "hook" | "model";

export type CapabilityScope = "user" | "project" | "plugin" | "builtin";

/** Lifecycle states, deliberately distinct so callers cannot conflate them. */
export type PluginState = "installed" | "enabled" | "disabled" | "uninstalled";
export type SkillState = "discovered" | "listed" | "invoked";
export type McpServerState = "configured" | "connecting" | "connected" | "needs-auth" | "failed" | "closed";
export type ToolState = "registered" | "exposed" | "active" | "selected";
export type HookState = "configured" | "trusted" | "untrusted" | "running";

export interface CapabilityRecordBase {
	kind: CapabilityKind;
	/** Stable id within the kind, e.g. "my-plugin", "mcp__github__create_issue". */
	id: string;
	name: string;
	description?: string;
	version?: string;
	scope: CapabilityScope;
	/** Origin: plugin name, "builtin", settings file path, etc. */
	source: string;
	state: string;
	/** True when the capability is currently usable end to end. */
	available: boolean;
	dependencies?: string[];
	/** Catalog-level constraints surfaced to the decision service. */
	constraints?: {
		invocationPolicy?: "explicit-only" | "implicit-allowed";
		mediaSupport?: string[];
		readonly?: boolean;
	};
	updatedAt: number;
}

export interface PluginCapability extends CapabilityRecordBase {
	kind: "plugin";
	state: PluginState;
	marketplaceName?: string;
	/** Content digest of the installed plugin, for update detection. */
	digest?: string;
}

export interface SkillCapability extends CapabilityRecordBase {
	kind: "skill";
	state: SkillState;
	skillDir: string;
	invocationPolicy: "explicit-only" | "implicit-allowed";
	/** Tool dependencies declared via agents/openai.yaml dependencies.tools. */
	toolDependencies?: Array<{ type: string; value: string }>;
}

export interface McpServerCapability extends CapabilityRecordBase {
	kind: "mcp-server";
	state: McpServerState;
	transport: "stdio" | "streamable-http" | "sse";
	toolCount?: number;
}

export interface ToolCapability extends CapabilityRecordBase {
	kind: "tool";
	state: ToolState;
	/** Owning plugin or MCP server, or "builtin". */
	owner: string;
	exposure: "direct" | "model-only" | "codemode" | "deferred" | "hidden";
}

export interface HookCapability extends CapabilityRecordBase {
	kind: "hook";
	state: HookState;
	event: string;
	/** Trust hash of the hook definition. */
	definitionHash?: string;
	async: boolean;
}

export interface ModelCapability extends CapabilityRecordBase {
	kind: "model";
	state: "registered";
	provider: string;
	api: string;
	inputModalities: string[];
	contextWindow: number;
	/** Input cost per million tokens, when known. */
	inputCostPerMTokens?: number;
}

export type CapabilityRecord =
	| PluginCapability
	| SkillCapability
	| McpServerCapability
	| ToolCapability
	| HookCapability
	| ModelCapability;

export interface CatalogSnapshot {
	schemaVersion: 1;
	/** Monotonic version; bumps on any mutation. Decision caches key on this. */
	version: number;
	records: CapabilityRecord[];
	timestamp: number;
}

export class CapabilityCatalog {
	private records = new Map<string, CapabilityRecord>();
	private version = 1;
	private readonly invalidationListeners: Array<() => void> = [];

	private key(kind: CapabilityKind, id: string): string {
		return `${kind}:${id}`;
	}

	/** Register or replace one record. Bumps the catalog version when content changes. */
	upsert(record: CapabilityRecord): void {
		const key = this.key(record.kind, record.id);
		const existing = this.records.get(key);
		if (existing && catalogRecordEquals(existing, record) && existing.updatedAt === record.updatedAt) {
			return;
		}
		this.records.set(key, record);
		this.bump();
	}

	/** Update the state of one record without replacing it. */
	transition(kind: CapabilityKind, id: string, state: string, patch?: Partial<CapabilityRecord>): void {
		const key = this.key(kind, id);
		const existing = this.records.get(key);
		if (!existing) return;
		const next = { ...existing, ...(patch ?? {}), state, updatedAt: Date.now() } as CapabilityRecord;
		if (catalogRecordEquals(existing, next) && existing.state === state) return;
		this.records.set(key, next);
		this.bump();
	}

	remove(kind: CapabilityKind, id: string): void {
		if (this.records.delete(this.key(kind, id))) this.bump();
	}

	get(kind: CapabilityKind, id: string): CapabilityRecord | undefined {
		return this.records.get(this.key(kind, id));
	}

	list(kind?: CapabilityKind): CapabilityRecord[] {
		const all = Array.from(this.records.values());
		return kind ? all.filter((r) => r.kind === kind) : all;
	}

	/** Capabilities currently usable, optionally filtered by kind. */
	available(kind?: CapabilityKind): CapabilityRecord[] {
		return this.list(kind).filter((r) => r.available);
	}

	/** Skills whose policy allows implicit invocation (System One may rank them). */
	implicitlyInvocableSkills(): SkillCapability[] {
		return this.list("skill").filter(
			(r): r is SkillCapability => r.kind === "skill" && r.invocationPolicy === "implicit-allowed" && r.available,
		);
	}

	snapshot(): CatalogSnapshot {
		return {
			schemaVersion: 1,
			version: this.version,
			records: Array.from(this.records.values()),
			timestamp: Date.now(),
		};
	}

	/** Digest of the current catalog content, for decision cache keys. */
	digest(): string {
		const hash = createHash("sha256");
		for (const record of Array.from(this.records.values()).sort((a, b) =>
			`${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`),
		)) {
			hash.update(`${record.kind}:${record.id}:${record.state}:${record.version ?? ""}:${String(record.available)}`);
		}
		return hash.digest("hex");
	}

	get currentVersion(): number {
		return this.version;
	}

	/** Drop every record from one source (plugin uninstall/update) and bump. */
	removeBySource(source: string): number {
		let removed = 0;
		for (const [key, record] of Array.from(this.records.entries())) {
			if (record.source === source) {
				this.records.delete(key);
				removed++;
			}
		}
		if (removed > 0) this.bump();
		return removed;
	}

	onInvalidation(listener: () => void): () => void {
		this.invalidationListeners.push(listener);
		return () => {
			const index = this.invalidationListeners.indexOf(listener);
			if (index >= 0) this.invalidationListeners.splice(index, 1);
		};
	}

	private bump(): void {
		this.version++;
		for (const listener of this.invalidationListeners) {
			try {
				listener();
			} catch {
				// Invalidation listeners must not break catalog updates.
			}
		}
	}
}

function catalogRecordEquals(a: CapabilityRecord, b: CapabilityRecord): boolean {
	if (a.kind !== b.kind || a.id !== b.id || a.state !== b.state || a.available !== b.available) return false;
	if (a.version !== b.version || a.scope !== b.scope || a.source !== b.source) return false;
	return JSON.stringify(a.constraints ?? null) === JSON.stringify(b.constraints ?? null);
}
