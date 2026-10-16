/**
 * Hook trust storage.
 *
 * Sources verified 2026-10-16 (see docs/byte-c1j1u/spec-sources.md):
 * - https://developers.openai.com/codex/hooks/ (trust model).
 *
 * Every hook definition is hashed (sha256 of its canonical JSON). Trust is
 * recorded against the hash in a JSON file mapping hash -> trusted. Untrusted
 * hooks are skipped with a diagnostic; changing a hook changes its hash and it
 * must be trusted again. Plugin-sourced hooks are untrusted by default.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HookHandler, SkippedHookHandler } from "./types.ts";

/** A single hook definition as stored/compared for trust. */
export type TrustableHookDefinition = HookHandler | SkippedHookHandler;

interface TrustFile {
	schemaVersion: 1;
	trusted: Record<string, true>;
}

function readTrustFile(path: string): TrustFile {
	if (!existsSync(path)) return { schemaVersion: 1, trusted: {} };
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			const record = parsed as { schemaVersion?: unknown; trusted?: unknown };
			if (record.schemaVersion === 1 && typeof record.trusted === "object" && record.trusted !== null) {
				const trusted: Record<string, true> = {};
				for (const [hash, value] of Object.entries(record.trusted as Record<string, unknown>)) {
					if (value === true) trusted[hash] = true;
				}
				return { schemaVersion: 1, trusted };
			}
		}
	} catch {}
	return { schemaVersion: 1, trusted: {} };
}

function writeTrustFile(path: string, data: TrustFile): void {
	mkdirSync(dirname(path), { recursive: true });
	const sorted: Record<string, true> = {};
	for (const hash of Object.keys(data.trusted).sort()) {
		sorted[hash] = true;
	}
	writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, trusted: sorted }, null, 2)}\n`, "utf8");
}

/** Compute the canonical-JSON sha256 hash of a hook definition. */
export function computeHookHandlerHash(handler: HookHandler): string {
	return createHash("sha256").update(canonicalJson(handler)).digest("hex");
}

/**
 * Canonical JSON: recursively sorted object keys, no insignificant whitespace,
 * JSON.stringify for primitives and strings. Stable across key reorderings.
 */
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const entries = Object.keys(value as Record<string, unknown>)
		.filter((key) => (value as Record<string, unknown>)[key] !== undefined)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
	return `{${entries.join(",")}}`;
}

/** An entry in the trust list. */
export interface HookTrustEntry {
	hash: string;
	/** Handler summary for display. */
	label: string;
}

export interface HookTrustStoreOptions {
	/** File backing the store. */
	stateFile: string;
	/** Trust everything without reading or writing the file (the Codex `--dangerously-bypass-hook-trust` equivalent). */
	bypass?: boolean;
}

/** Trust state store: hash -> trusted, persisted to a JSON file. */
export class HookTrustStore {
	private readonly stateFile: string;
	private readonly bypass: boolean;
	private cache: TrustFile | undefined;

	constructor(options: HookTrustStoreOptions) {
		this.stateFile = options.stateFile;
		this.bypass = options.bypass ?? false;
	}

	private data(): TrustFile {
		if (this.bypass) return { schemaVersion: 1, trusted: {} };
		if (!this.cache) this.cache = readTrustFile(this.stateFile);
		return this.cache;
	}

	/** True when trust checks are bypassed (all hooks trusted). */
	isBypassed(): boolean {
		return this.bypass;
	}

	isTrusted(hash: string): boolean {
		if (this.bypass) return true;
		if (!hash) return false;
		return this.data().trusted[hash] === true;
	}

	/** Mark a hash trusted. */
	trust(hash: string): void {
		if (this.bypass || !hash) return;
		const data = this.data();
		data.trusted[hash] = true;
		this.cache = data;
		writeTrustFile(this.stateFile, data);
	}

	/** Remove trust for a hash. */
	untrust(hash: string): void {
		if (this.bypass || !hash) return;
		const data = this.data();
		delete data.trusted[hash];
		this.cache = data;
		writeTrustFile(this.stateFile, data);
	}

	/** All trusted hashes. */
	list(): string[] {
		return Object.keys(this.data().trusted).sort();
	}

	/** Forget all trusted hashes. */
	clear(): void {
		if (this.bypass) return;
		this.cache = { schemaVersion: 1, trusted: {} };
		writeTrustFile(this.stateFile, this.cache);
	}
}

/** Summarize a hook definition for trust-listing display. */
export function describeHookDefinition(handler: TrustableHookDefinition): string {
	if (handler.type === "command") return `command: ${handler.command}`;
	if (handler.type === "mcp_tool") return `mcp_tool: ${handler.server}/${handler.tool}`;
	return `${handler.type} (skipped)`;
}
