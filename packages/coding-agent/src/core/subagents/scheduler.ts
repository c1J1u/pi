/**
 * Subagent scheduler: task graph with ids, dependencies, concurrency caps, budget,
 * timeout, cancel, and result collection. File ownership is deterministic — owned by the
 * scheduler, never by model scores. Subagents run the same agent pipeline with scoped
 * tool sets; results land in the parent session as structured entries.
 *
 * System One's role is advisory (adviseDelegation); it cannot widen permissions or
 * override ownership.
 */

import { EventEmitter } from "node:events";

export type SubtaskState = "pending" | "running" | "done" | "failed" | "cancelled" | "timeout";

export interface SubtaskSpec {
	/** Stable task id, unique in the graph. */
	id: string;
	/** Task instruction for the subagent. */
	instruction: string;
	/** Role hint used for delegation advice and model selection. */
	role?: string;
	/** Ids of tasks that must complete before this one starts. */
	dependsOn?: string[];
	/** Files this task may write; ownership conflicts are scheduler decisions. */
	writes?: string[];
	/** Per-task timeout in ms. */
	timeoutMs?: number;
	/** Restrict the subagent to these tools. */
	allowedTools?: string[];
}

export interface SubtaskResult {
	id: string;
	state: Exclude<SubtaskState, "pending" | "running">;
	/** Final assistant text of the subagent. */
	output?: string;
	error?: string;
	durationMs: number;
	startedAt: number;
	finishedAt: number;
}

export interface SubtaskRun {
	spec: SubtaskSpec;
	state: SubtaskState;
	result?: SubtaskResult;
}

export type SubtaskExecutor = (
	spec: SubtaskSpec,
	context: { signal: AbortSignal; parentSessionId: string },
) => Promise<{ output?: string; error?: string }>;

export interface SchedulerOptions {
	executor: SubtaskExecutor;
	/** Maximum concurrently running subagents. Default 4. */
	maxConcurrency?: number;
	/** Graph-wide wall-clock budget in ms. Default 10 minutes. */
	budgetMs?: number;
	signal?: AbortSignal;
	onEvent?: (event: SubagentEvent) => void;
}

export type SubagentEvent =
	| { type: "subagent_start"; id: string; role?: string }
	| { type: "subagent_stop"; id: string; state: SubtaskResult["state"]; error?: string };

/** Emits SubagentStart / SubagentStop hook-shaped events. */
export class SubagentScheduler {
	private readonly runs = new Map<string, SubtaskRun>();
	private readonly options: SchedulerOptions;
	private readonly events = new EventEmitter();
	private readonly controller: AbortController;
	private deadline: number;
	private started = false;

	constructor(options: SchedulerOptions) {
		this.options = options;
		this.controller = new AbortController();
		this.deadline = Date.now() + (options.budgetMs ?? 10 * 60_000);
		if (options.signal) {
			options.signal.addEventListener("abort", () => this.cancelAll(), { once: true });
		}
		this.events.setMaxListeners(50);
	}

	add(spec: SubtaskSpec): { ok: true } | { ok: false; error: string } {
		if (this.runs.has(spec.id)) return { ok: false, error: `duplicate task id: ${spec.id}` };
		for (const dep of spec.dependsOn ?? []) {
			if (!this.runs.has(dep) && dep !== spec.id) {
			}
		}
		this.runs.set(spec.id, { spec, state: "pending" });
		return { ok: true };
	}

	/** Detect dependency cycles and missing dependencies before starting. */
	validate(): string[] {
		const errors: string[] = [];
		const visiting = new Set<string>();
		const visited = new Set<string>();
		const visit = (id: string, chain: string[]): void => {
			if (visited.has(id)) return;
			if (visiting.has(id)) {
				errors.push(`dependency cycle: ${[...chain, id].join(" -> ")}`);
				return;
			}
			visiting.add(id);
			const run = this.runs.get(id);
			for (const dep of run?.spec.dependsOn ?? []) {
				if (!this.runs.has(dep)) errors.push(`task ${id} depends on missing task ${dep}`);
				else visit(dep, [...chain, id]);
			}
			visiting.delete(id);
			visited.add(id);
		};
		for (const id of this.runs.keys()) visit(id, []);
		return errors;
	}

	/** File ownership: two tasks writing the same file must be ordered by dependency. */
	ownershipConflicts(): Array<{ file: string; tasks: string[] }> {
		const byFile = new Map<string, string[]>();
		for (const run of this.runs.values()) {
			for (const file of run.spec.writes ?? []) {
				byFile.set(file, [...(byFile.get(file) ?? []), run.spec.id]);
			}
		}
		const conflicts: Array<{ file: string; tasks: string[] }> = [];
		for (const [file, tasks] of byFile) {
			if (tasks.length < 2) continue;
			// Ordered by an explicit dependency? Then it is not a conflict.
			const ordered = tasks.every((task, index) => {
				if (index === 0) return true;
				const run = this.runs.get(task);
				return (run?.spec.dependsOn ?? []).includes(tasks[index - 1]!);
			});
			if (!ordered) conflicts.push({ file, tasks });
		}
		return conflicts;
	}

	/** Run the graph to completion (or budget/cancel). Returns every task result. */
	async run(): Promise<SubtaskResult[]> {
		if (this.started) throw new Error("scheduler already started");
		this.started = true;
		const errors = this.validate();
		if (errors.length > 0) {
			for (const run of this.runs.values()) {
				if (run.state === "pending") {
					run.state = "failed";
					run.result = {
						id: run.spec.id,
						state: "failed",
						error: `graph invalid: ${errors[0]}`,
						durationMs: 0,
						startedAt: Date.now(),
						finishedAt: Date.now(),
					};
				}
			}
			return this.results();
		}
		const maxConcurrency = this.options.maxConcurrency ?? 4;
		const inFlight = new Set<Promise<void>>();

		const ready = (): SubtaskRun[] =>
			Array.from(this.runs.values()).filter(
				(run) =>
					run.state === "pending" &&
					(run.spec.dependsOn ?? []).every((dep) => {
						const state = this.runs.get(dep)?.state;
						return state === "done" || state === "failed" || state === "cancelled" || state === "timeout";
					}),
			);

		while (Array.from(this.runs.values()).some((run) => run.state === "pending" || run.state === "running")) {
			if (this.controller.signal.aborted) break;
			if (Date.now() > this.deadline) {
				for (const run of this.runs.values()) {
					if (run.state === "pending" || run.state === "running") {
						this.finish(run, "timeout", { error: "graph budget exhausted" });
					}
				}
				break;
			}
			while (inFlight.size < maxConcurrency) {
				const next = ready()[0];
				if (!next) break;
				// Dependencies that failed propagate as cancelled downstream work.
				const failedDep = (next.spec.dependsOn ?? []).find((dep) => {
					const state = this.runs.get(dep)?.state;
					return state === "failed" || state === "cancelled" || state === "timeout";
				});
				if (failedDep) {
					this.finish(next, "cancelled", { error: `dependency ${failedDep} did not succeed` });
					continue;
				}
				inFlight.add(this.runOne(next));
			}
			if (inFlight.size === 0) {
				// No progress possible: remaining tasks are stuck (should not happen after validate).
				for (const run of this.runs.values()) {
					if (run.state === "pending") this.finish(run, "cancelled", { error: "unschedulable" });
				}
				break;
			}
			// Race the in-flight work against the deadline so a hung executor cannot outlive
			// the budget: the timer resolves the race, pending/running tasks are marked timeout.
			const nextSettlement = Promise.race(inFlight);
			const budgetHit = new Promise<"budget">((resolve) => {
				const remaining = this.deadline - Date.now();
				const timer = setTimeout(() => resolve("budget"), Math.max(0, remaining));
				nextSettlement.then(
					() => clearTimeout(timer),
					() => clearTimeout(timer),
				);
			});
			const settled = await Promise.race([nextSettlement.then(() => "task" as const), budgetHit]);
			if (settled === "budget") {
				this.controller.abort();
				for (const run of this.runs.values()) {
					if (run.state === "pending" || run.state === "running") {
						this.finish(run, "timeout", { error: "graph budget exhausted" });
					}
				}
				break;
			}
			for (const promise of Array.from(inFlight)) {
				await promise.then(() => inFlight.delete(promise)).catch(() => inFlight.delete(promise));
			}
		}
		// After a budget abort the executors may hang forever; do not wait for them. Normal
		// completion drains in the loop above, so only settled promises remain here.
		if (!this.controller.signal.aborted) {
			await Promise.allSettled(inFlight);
		}
		return this.results();
	}

	private async runOne(run: SubtaskRun): Promise<void> {
		run.state = "running";
		this.options.onEvent?.({ type: "subagent_start", id: run.spec.id, role: run.spec.role });
		const startedAt = Date.now();
		const timeoutMs = run.spec.timeoutMs ?? Math.max(0, this.deadline - startedAt);
		const timer = setTimeout(() => this.controller.abort(), timeoutMs);
		try {
			const outcome = await this.options.executor(run.spec, {
				signal: this.controller.signal,
				parentSessionId: "",
			});
			const durationMs = Date.now() - startedAt;
			if (outcome.error) {
				this.finish(run, "failed", { error: outcome.error, durationMs, startedAt });
			} else {
				this.finish(run, "done", { output: outcome.output, durationMs, startedAt });
			}
		} catch (error) {
			this.finish(run, "failed", {
				error: error instanceof Error ? error.message : String(error),
				durationMs: Date.now() - startedAt,
				startedAt,
			});
		} finally {
			clearTimeout(timer);
		}
	}

	private finish(run: SubtaskRun, state: SubtaskResult["state"], partial: Partial<SubtaskResult> = {}): void {
		run.state = state;
		run.result = {
			id: run.spec.id,
			state,
			output: partial.output,
			error: partial.error,
			durationMs: partial.durationMs ?? 0,
			startedAt: partial.startedAt ?? Date.now(),
			finishedAt: Date.now(),
		};
		this.options.onEvent?.({ type: "subagent_stop", id: run.spec.id, state, error: partial.error });
	}

	cancelAll(): void {
		this.controller.abort();
		for (const run of this.runs.values()) {
			if (run.state === "pending" || run.state === "running") {
				this.finish(run, "cancelled", { error: "cancelled" });
			}
		}
	}

	results(): SubtaskResult[] {
		return Array.from(this.runs.values())
			.map((run) => run.result)
			.filter((result): result is SubtaskResult => result !== undefined);
	}

	status(): Array<{ id: string; state: SubtaskState }> {
		return Array.from(this.runs.values()).map((run) => ({ id: run.spec.id, state: run.state }));
	}
}
