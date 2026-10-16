/**
 * The byte-c1j1u runtime integration: plugins, hooks, extended skills, the capability
 * catalog, and the System One decision service wired into Pi through the extension API.
 *
 * Loaded as a built-in extension so every interface (interactive TUI, print, JSON, RPC,
 * SDK) drives the same machinery. Everything degrades to stock Pi behavior when no Ark
 * key is configured or no plugins/hooks exist.
 *
 * Mapping to Pi boundaries (see docs/byte-c1j1u/architecture.md):
 * - PreToolUse  -> pi.on("tool_call") before execution (deny blocks)
 * - PostToolUse -> pi.on("tool_result")
 * - Stop        -> pi.on("agent_before_settle") (the settle boundary, not every turn_end)
 * - SessionStart/End, UserPromptSubmit -> the corresponding pi events
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClassifierModel } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../config.ts";
import { CapabilityCatalog, type SkillCapability } from "../../core/capabilities/catalog.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { parseHooksConfig } from "../../core/hooks/config.ts";
import { HookRunner, type HookRunnerOptions } from "../../core/hooks/runner.ts";
import { HookTrustStore } from "../../core/hooks/trust.ts";
import type { HookDiagnostic, HookEmitResult, HookEventName, ParsedHooksConfig } from "../../core/hooks/types.ts";
import {
	hooksFieldEntries,
	marketplaceLocations,
	PluginLifecycle,
	readMarketplaceCatalog,
	readPluginMcpConfig,
	resolvePluginPath,
} from "../../core/plugins/index.ts";
import { discoverOpenAiSkills } from "../../core/skills-ext/index.ts";
import { DecisionService } from "../../core/systemone/decision-service.ts";
import { stopControl, VerificationLedger } from "./decisions.ts";
import { createByteC1J1uRouter } from "./router.ts";

export interface ByteC1J1uOptions {
	/** Disable System One decisions (evaluation baseline). */
	disableDecisions?: boolean;
	/** Hook trust bypass, mirroring --dangerously-bypass-hook-trust. */
	bypassHookTrust?: boolean;
}

interface PluginLocations {
	cacheDir: string;
	stateFile: string;
	trustFile: string;
}

function pluginLocations(): PluginLocations {
	const agentDir = getAgentDir();
	return {
		cacheDir: join(agentDir, "plugins", "cache"),
		stateFile: join(agentDir, "plugins", "state.json"),
		trustFile: join(agentDir, "hooks-trust.json"),
	};
}

export function createByteC1J1uExtension(options: ByteC1J1uOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		// The System One-driven virtual model: pi --model byte-c1j1u/auto
		createByteC1J1uRouter(pi);

		const catalog = new CapabilityCatalog();
		const pluginRootsByHash = new Map<string, string>();
		let hookRunner: HookRunner | undefined;
		let hookTrust: HookTrustStore | undefined;
		const ledger = new VerificationLedger();
		let decisionService: DecisionService | undefined;
		let currentSessionId = "";
		let currentTranscript: string | null = null;
		let currentModel = "";

		function buildHookRunner(ctx: ExtensionContext): HookRunner {
			const locations = pluginLocations();
			const diagnostics: HookDiagnostic[] = [];
			const events: ParsedHooksConfig["events"] = {};
			const handlers: ParsedHooksConfig["handlers"] = [];
			pluginRootsByHash.clear();

			const mergeConfig = (value: unknown, source: string, fromPlugin: boolean, rootDir?: string): void => {
				const parsed = parseHooksConfig(value, source, { fromPlugin });
				diagnostics.push(...parsed.diagnostics);
				for (const [event, groups] of Object.entries(parsed.events)) {
					const key = event as HookEventName;
					events[key] = [...(events[key] ?? []), ...(groups ?? [])];
				}
				handlers.push(...parsed.handlers);
				// Plugin hook commands receive PLUGIN_ROOT/PLUGIN_DATA environment variables.
				if (rootDir) {
					for (const handler of parsed.handlers) {
						if (handler.handler.type === "command") {
							pluginRootsByHash.set(handler.hash, rootDir);
						}
					}
				}
			};

			const agentDir = getAgentDir();
			const fileCandidates: Array<{ path: string; source: string; fromPlugin: boolean; rootDir?: string }> = [
				{ path: join(agentDir, "hooks.json"), source: "user hooks.json", fromPlugin: false },
				{ path: join(ctx.cwd, ".codex", "hooks.json"), source: "project hooks.json", fromPlugin: false },
			];

			// Enabled plugins contribute hooks: manifest `hooks` field or default hooks/hooks.json.
			const lifecycle = new PluginLifecycle({
				cacheDir: locations.cacheDir,
				stateFile: locations.stateFile,
			});
			for (const plugin of lifecycle.listInstalled()) {
				if (!plugin.enabled) continue;
				const extension = plugin.manifest.openaiExtension;
				if (extension?.hooks) {
					const entries = hooksFieldEntries(extension.hooks);
					for (const hookPath of entries.paths) {
						const resolved = resolvePluginPath(plugin.rootDir, hookPath);
						if ("path" in resolved) {
							fileCandidates.push({
								path: resolved.path,
								source: `plugin ${plugin.name}: ${hookPath}`,
								fromPlugin: true,
								rootDir: plugin.rootDir,
							});
						}
					}
					for (const inline of entries.inline) {
						mergeConfig(inline, `plugin ${plugin.name}: inline hooks`, true, plugin.rootDir);
					}
				} else {
					fileCandidates.push({
						path: join(plugin.rootDir, "hooks", "hooks.json"),
						source: `plugin ${plugin.name}: hooks/hooks.json`,
						fromPlugin: true,
						rootDir: plugin.rootDir,
					});
				}
			}

			for (const candidate of fileCandidates) {
				try {
					const text = readFileSync(candidate.path, "utf8");
					mergeConfig(JSON.parse(text), candidate.source, candidate.fromPlugin, candidate.rootDir);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
						diagnostics.push({
							type: "error",
							message: `${candidate.source}: ${error instanceof Error ? error.message : String(error)}`,
						});
					}
				}
			}

			const trustStore = new HookTrustStore({
				stateFile: locations.trustFile,
				...(options.bypassHookTrust ? { bypass: true } : {}),
			});
			hookTrust = trustStore;
			const runnerOptions: HookRunnerOptions = {
				config: { events, handlers, diagnostics },
				trustStore,
				outputDir: join(agentDir, "hook_outputs"),
				getEnv: (hash) => {
					// Plugin hook commands receive PLUGIN_ROOT/PLUGIN_DATA (and the
					// CLAUDE_* compat aliases) pointing at their installed plugin root.
					const rootDir = hash ? pluginRootsByHash.get(hash) : undefined;
					if (!rootDir) return {};
					return {
						PLUGIN_ROOT: rootDir,
						PLUGIN_DATA: join(rootDir, ".data"),
						CLAUDE_PLUGIN_ROOT: rootDir,
						CLAUDE_PLUGIN_DATA: join(rootDir, ".data"),
					};
				},
			};
			return new HookRunner(runnerOptions);
		}

		function refreshCatalog(ctx: ExtensionContext): void {
			const locations = pluginLocations();
			const lifecycle = new PluginLifecycle({
				cacheDir: locations.cacheDir,
				stateFile: locations.stateFile,
			});

			// OpenAI-scope skills (.agents/skills) with invocation policy from openai.yaml.
			const discovered = discoverOpenAiSkills({ cwd: ctx.cwd, homeDir: homedir() });
			for (const skill of discovered) {
				const record: SkillCapability = {
					kind: "skill",
					id: skill.name,
					name: skill.name,
					description: skill.description,
					scope: skill.scope === "repo" ? "project" : skill.scope === "user" ? "user" : "plugin",
					source: `.agents/skills(${skill.scope})`,
					state: "discovered",
					available: true,
					skillDir: skill.skillDir,
					invocationPolicy:
						skill.openaiConfig?.policy?.allowImplicitInvocation === false ? "explicit-only" : "implicit-allowed",
					toolDependencies: skill.openaiConfig?.dependencies?.tools?.map((tool) => ({
						type: tool.type ?? "",
						value: tool.value ?? "",
					})),
					updatedAt: Date.now(),
				};
				catalog.upsert(record);
			}

			// Installed plugins and their portable MCP server declarations.
			const installed = lifecycle.listInstalled();
			for (const plugin of installed) {
				catalog.upsert({
					kind: "plugin",
					id: `${plugin.name}@${plugin.marketplaceName}`,
					name: plugin.manifest.name,
					description: plugin.manifest.description,
					version: plugin.version,
					scope: "plugin",
					source: plugin.marketplaceName,
					state: plugin.enabled ? "enabled" : "disabled",
					available: plugin.enabled,
					updatedAt: Date.now(),
				});
				if (!plugin.enabled) continue;
				const mcp = readPluginMcpConfig(plugin.rootDir);
				if (!mcp) continue;
				for (const [name, server] of Object.entries(mcp.servers)) {
					catalog.upsert({
						kind: "mcp-server",
						id: `${plugin.name}/${name}`,
						name,
						scope: "plugin",
						source: plugin.name,
						state: "configured",
						available: true,
						transport: server.type === "stdio" ? "stdio" : server.type,
						updatedAt: Date.now(),
					});
				}
			}
		}

		pi.on("session_start", (event, ctx) => {
			currentSessionId = ctx.sessionManager.getSessionId();
			currentTranscript = ctx.sessionManager.getSessionFile() ?? null;
			currentModel = ctx.model?.id ?? "";

			refreshCatalog(ctx);
			hookRunner = buildHookRunner(ctx);

			// Decision service on the Ark System One classifier.
			if (!options.disableDecisions) {
				const found = ctx.modelRegistry.findOfType("classifier", "ark", "doubao-seed-2-1-lite-260915");
				const classifier =
					found && found.api === "ark-system-one" ? (found as ClassifierModel<"ark-system-one">) : undefined;
				if (classifier) {
					decisionService = new DecisionService({
						model: classifier,
						getApiKey: () => process.env.ARK_API_KEY,
						classifyFn: (model, ctx2, opts) => ctx.modelRegistry.classify(model, ctx2, opts),
						policyVersion: "byte-c1j1u-1",
					});
					catalog.onInvalidation(() => decisionService?.invalidateCache());
				}
			}

			const source =
				event.reason === "resume" ? "resume" : event.reason === "startup" ? "startup" : (event.reason ?? "startup");
			void emitHooks("SessionStart", ctx, { source });
		});

		pi.on("session_shutdown", (_event, ctx) => {
			void emitHooks("SessionEnd", ctx, { reason: "other" });
		});

		pi.on("input", (event, ctx) => {
			const text = typeof event.text === "string" ? event.text : "";
			void emitHooks("UserPromptSubmit", ctx, { prompt: text });
		});

		pi.on("tool_call", async (event, ctx) => {
			if (!hookRunner) return;
			const result = await emitHooks("PreToolUse", ctx, {
				tool_name: event.toolName,
				tool_use_id: event.toolCallId,
				tool_input: event.input as Record<string, unknown>,
			});
			if (result && result.permissionDecision === "deny") {
				return {
					block: true,
					reason: `PreToolUse hook denied ${event.toolName}: ${result.permissionDecisionReason ?? result.reason ?? "blocked by hook"}`,
				};
			}
			return undefined;
		});

		pi.on("tool_result", (event, ctx) => {
			void emitHooks("PostToolUse", ctx, {
				tool_name: event.toolName,
				tool_use_id: event.toolCallId,
				tool_input: event.input as Record<string, unknown>,
				tool_response: { content: event.content, isError: event.isError },
			});
		});

		pi.on("agent_before_settle", async (event, ctx) => {
			// Stop control: deterministic ledger rules first, then the Stop hook contract.
			// A continue decision queues the reason as a follow-up so the next model
			// request receives it (the official Stop semantics: reason as new prompt).
			const goal = lastUserGoal(ctx);
			const stop = await stopControl({
				ledger,
				decisionService,
				goal,
				lastAssistantText: lastAssistantText(ctx),
			});
			if (stop.action === "continue" && stop.reason) {
				// The official Stop semantics: continue with the reason as a new prompt.
				pi.sendUserMessage(stop.reason, { deliverAs: "followUp" });
				return { continue: true };
			}

			const result = await emitHooks("Stop", ctx, {
				stop_hook_active: false,
				last_assistant_message: lastAssistantText(ctx),
			});
			if (result?.blockReason) {
				pi.sendUserMessage(result.blockReason, { deliverAs: "followUp" });
				return { continue: true };
			}
			return undefined;
		});

		function lastUserGoal(ctx: ExtensionContext): string {
			for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
				if (entry.type !== "message" || entry.message.role !== "user") continue;
				const content = entry.message.content;
				if (typeof content === "string") return content.slice(0, 2000);
				return content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n")
					.slice(0, 2000);
			}
			return "";
		}

		function lastAssistantText(ctx: ExtensionContext): string | null {
			for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
				if (entry.type !== "message" || entry.message.role !== "assistant") continue;
				const content = entry.message.content;
				if (typeof content === "string") return content || null;
				const text = content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");
				return text || null;
			}
			return null;
		}

		async function emitHooks(
			event: HookEventName,
			ctx: ExtensionContext,
			payload: Record<string, unknown>,
		): Promise<HookEmitResult | undefined> {
			if (!hookRunner) return undefined;
			currentModel = ctx.model?.id ?? currentModel;
			return hookRunner.emit(
				event,
				{
					...payload,
					session_id: currentSessionId,
					transcript_path: currentTranscript,
					cwd: ctx.cwd,
					hook_event_name: event,
					model: currentModel,
				},
				{
					cwd: ctx.cwd,
					session_id: currentSessionId,
					transcript_path: currentTranscript ?? undefined,
					model: currentModel,
					permission_mode: "default",
					signal: ctx.signal,
				},
			);
		}

		// ---- Management commands: /plugins, /hooks, /byte-c1j1u ----

		pi.registerCommand("plugins", {
			description: "Manage byte-c1j1u plugins: list, install, uninstall, enable, disable",
			handler: async (args, ctx) => {
				const [action, name] = args.trim().split(/\s+/);
				const locations = pluginLocations();
				const lifecycle = new PluginLifecycle({
					cacheDir: locations.cacheDir,
					stateFile: locations.stateFile,
				});
				if (!action) {
					const installed = lifecycle.listInstalled();
					const lines = installed.length
						? installed.map(
								(p) =>
									`${p.enabled ? "[x]" : "[ ]"} ${p.name}@${p.marketplaceName} ${p.version}${p.manifest.description ? ` — ${p.manifest.description}` : ""}`,
							)
						: [
								"No plugins installed. Marketplaces: .agents/plugins/marketplace.json (repo) or ~/.agents/plugins/marketplace.json (personal).",
							];
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
				if (action === "install" && name) {
					for (const location of marketplaceLocations(ctx.cwd, homedir())) {
						const result = readMarketplaceCatalog(location.filePath, location.kind);
						if (result.status !== "ok") continue;
						const install = lifecycle.installLocal(result.catalog, name);
						if (install.plugin) {
							lifecycle.setEnabled(result.catalog.name, name, true);
							ctx.ui.notify(`Installed and enabled ${name}@${result.catalog.name}. Restart to load it.`, "info");
							return;
						}
						if (install.diagnostics.length > 0) {
							ctx.ui.notify(install.diagnostics.join("\n"), "error");
							return;
						}
					}
					ctx.ui.notify(`Plugin "${name}" not found in any marketplace.`, "error");
					return;
				}
				if (action === "uninstall" && name) {
					const installed = lifecycle.listInstalled().filter((p) => p.name === name);
					if (installed.length === 0) {
						ctx.ui.notify(`Plugin "${name}" is not installed.`, "error");
						return;
					}
					for (const plugin of installed) lifecycle.uninstall(plugin.marketplaceName, plugin.name);
					ctx.ui.notify(`Uninstalled ${name}.`, "info");
					return;
				}
				if ((action === "enable" || action === "disable") && name) {
					const installed = lifecycle.listInstalled().filter((p) => p.name === name);
					if (installed.length === 0) {
						ctx.ui.notify(`Plugin "${name}" is not installed.`, "error");
						return;
					}
					for (const plugin of installed) {
						lifecycle.setEnabled(plugin.marketplaceName, plugin.name, action === "enable");
					}
					ctx.ui.notify(`${action === "enable" ? "Enabled" : "Disabled"} ${name}. Restart to apply.`, "info");
					return;
				}
				ctx.ui.notify("Usage: /plugins [list|install|uninstall|enable|disable] [name]", "info");
			},
		});

		pi.registerCommand("hooks", {
			description: "List hooks; trust or untrust hook definitions (/hooks trust <n>)",
			handler: async (args, ctx) => {
				if (!hookRunner || !hookTrust) {
					ctx.ui.notify("Hooks are not loaded in this session.", "info");
					return;
				}
				const trust = hookTrust;
				const [action, indexArg] = args.trim().split(/\s+/);
				const entries = hookRunnerEntries(hookRunner);
				if (action === "trust" || action === "untrust") {
					const index = Number.parseInt(indexArg ?? "", 10);
					const entry = entries[index];
					if (entry === undefined || Number.isNaN(index)) {
						ctx.ui.notify(`Usage: /hooks ${action} <n> (see /hooks for numbers)`, "info");
						return;
					}
					if (action === "trust") trust.trust(entry.hash);
					else trust.untrust(entry.hash);
					ctx.ui.notify(`${action === "trust" ? "Trusted" : "Untrusted"} #${index}: ${entry.label}`, "info");
					return;
				}
				const lines = entries.map((entry, index) => {
					const trusted = trust.isTrusted(entry.hash);
					return `${index} ${trusted ? "[trusted]" : "[review]"} ${entry.event} ${entry.label}`;
				});
				ctx.ui.notify(
					lines.length ? `${lines.join("\n")}\nTrust with: /hooks trust <n>` : "No hooks configured.",
					"info",
				);
			},
		});

		pi.registerCommand("byte-c1j1u", {
			description: "Show byte-c1j1u status: catalog, decision service, plugins, hooks",
			handler: async (_args, ctx) => {
				const hookCount = hookRunnerEntries(hookRunner).length;
				const lines = [
					`capabilities: ${catalog.list().length} records (version ${catalog.currentVersion})`,
					`skills (implicit-allowed): ${catalog.implicitlyInvocableSkills().length}`,
					`plugins enabled: ${catalog.list("plugin").filter((p) => p.available).length}`,
					`decision service: ${decisionService ? "ark-system-one ready" : "inactive (set ARK_API_KEY to enable)"}`,
					`hooks configured: ${hookCount}`,
				];
				ctx.ui.notify(lines.join("\n"), "info");
			},
		});
	};
}

/** Read-only view of the runner's parsed hook handlers with their definition hashes. */
function hookRunnerEntries(runner: HookRunner | undefined): Array<{ event: string; hash: string; label: string }> {
	const events = (runner as unknown as { config?: { events?: Record<string, unknown> } } | undefined)?.config?.events;
	if (!events) return [];
	const entries: Array<{ event: string; hash: string; label: string }> = [];
	for (const [event, groups] of Object.entries(events)) {
		if (!Array.isArray(groups)) continue;
		for (const group of groups) {
			const handlers = (group as { handlers?: unknown[] }).handlers ?? [];
			for (const h of handlers) {
				const parsed = h as {
					handler: { type: string; command?: string; server?: string; tool?: string };
					hash: string;
				};
				const label =
					parsed.handler.type === "command"
						? (parsed.handler.command ?? "")
						: parsed.handler.type === "mcp_tool"
							? `${parsed.handler.server}/${parsed.handler.tool}`
							: parsed.handler.type;
				entries.push({ event, hash: parsed.hash, label });
			}
		}
	}
	return entries;
}

export default createByteC1J1uExtension();
