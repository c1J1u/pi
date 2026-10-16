import { describe, expect, it, vi } from "vitest";
import { SubagentScheduler, type SubtaskSpec } from "../../src/core/subagents/scheduler.ts";

function spec(id: string, overrides: Partial<SubtaskSpec> = {}): SubtaskSpec {
	return { id, instruction: `do ${id}`, ...overrides };
}

function okExecutor(output = "done") {
	return async (task: SubtaskSpec) => {
		await new Promise((resolve) => setTimeout(resolve, 10));
		return { output: `${output}:${task.id}` };
	};
}

describe("SubagentScheduler", () => {
	it("runs independent tasks with a concurrency cap", async () => {
		let running = 0;
		let peak = 0;
		const executor = async (task: SubtaskSpec) => {
			running++;
			peak = Math.max(peak, running);
			await new Promise((resolve) => setTimeout(resolve, 20));
			running--;
			return { output: task.id };
		};
		const scheduler = new SubagentScheduler({ executor, maxConcurrency: 2 });
		for (const id of ["a", "b", "c", "d"]) scheduler.add(spec(id));
		const results = await scheduler.run();
		expect(results).toHaveLength(4);
		expect(results.every((r) => r.state === "done")).toBe(true);
		expect(peak).toBeLessThanOrEqual(2);
	});

	it("respects dependencies in order", async () => {
		const order: string[] = [];
		const executor = async (task: SubtaskSpec) => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			order.push(task.id);
			return { output: task.id };
		};
		const scheduler = new SubagentScheduler({ executor, maxConcurrency: 4 });
		scheduler.add(spec("first"));
		scheduler.add(spec("second", { dependsOn: ["first"] }));
		scheduler.add(spec("third", { dependsOn: ["second"] }));
		await scheduler.run();
		expect(order).toEqual(["first", "second", "third"]);
	});

	it("rejects cycles and missing dependencies before running", () => {
		const scheduler = new SubagentScheduler({ executor: okExecutor() });
		scheduler.add(spec("a", { dependsOn: ["b"] }));
		scheduler.add(spec("b", { dependsOn: ["a"] }));
		scheduler.add(spec("c", { dependsOn: ["missing"] }));
		const errors = scheduler.validate();
		expect(errors.some((e) => e.includes("cycle"))).toBe(true);
		expect(errors.some((e) => e.includes("missing"))).toBe(true);
	});

	it("marks graph-invalid tasks failed without executing", async () => {
		const executor = vi.fn(okExecutor());
		const scheduler = new SubagentScheduler({ executor });
		scheduler.add(spec("a", { dependsOn: ["b"] }));
		scheduler.add(spec("b", { dependsOn: ["a"] }));
		const results = await scheduler.run();
		expect(executor).not.toHaveBeenCalled();
		expect(results.every((r) => r.state === "failed")).toBe(true);
	});

	it("propagates dependency failure as cancellation downstream", async () => {
		const scheduler = new SubagentScheduler({
			executor: async (task) => (task.id === "boom" ? { error: "exploded" } : { output: "ok" }),
		});
		scheduler.add(spec("boom"));
		scheduler.add(spec("after", { dependsOn: ["boom"] }));
		const results = await scheduler.run();
		const boom = results.find((r) => r.id === "boom");
		const after = results.find((r) => r.id === "after");
		expect(boom?.state).toBe("failed");
		expect(after?.state).toBe("cancelled");
		expect(after?.error).toContain("dependency boom");
	});

	it("detects file ownership conflicts unless ordered by dependencies", () => {
		const scheduler = new SubagentScheduler({ executor: okExecutor() });
		scheduler.add(spec("w1", { writes: ["src/a.ts"] }));
		scheduler.add(spec("w2", { writes: ["src/a.ts"] }));
		expect(scheduler.ownershipConflicts()).toEqual([{ file: "src/a.ts", tasks: ["w1", "w2"] }]);

		const ordered = new SubagentScheduler({ executor: okExecutor() });
		ordered.add(spec("w1", { writes: ["src/a.ts"] }));
		ordered.add(spec("w2", { writes: ["src/a.ts"], dependsOn: ["w1"] }));
		expect(ordered.ownershipConflicts()).toEqual([]);
	});

	it("enforces the graph budget", async () => {
		const scheduler = new SubagentScheduler({
			executor: () => new Promise(() => {}),
			budgetMs: 30,
		});
		scheduler.add(spec("stuck"));
		const results = await scheduler.run();
		expect(results[0]?.state).toBe("timeout");
		expect(results[0]?.error).toContain("budget");
	}, 10_000);

	it("cancelAll stops pending and running tasks", async () => {
		const scheduler = new SubagentScheduler({
			executor: (task, { signal }) =>
				new Promise((resolve) => {
					const timer = setTimeout(() => resolve({ output: task.id }), 500);
					signal.addEventListener("abort", () => {
						clearTimeout(timer);
						resolve({ error: "aborted" });
					});
				}),
		});
		scheduler.add(spec("long"));
		scheduler.add(spec("never", { dependsOn: ["long"] }));
		const running = scheduler.run();
		await new Promise((resolve) => setTimeout(resolve, 10));
		scheduler.cancelAll();
		const results = await running;
		expect(results.every((r) => r.state === "cancelled" || r.state === "failed")).toBe(true);
	});

	it("emits subagent_start and subagent_stop events", async () => {
		const events: Array<{ type: string; id: string }> = [];
		const scheduler = new SubagentScheduler({
			executor: okExecutor(),
			onEvent: (event) => events.push({ type: event.type, id: event.id }),
		});
		scheduler.add(spec("solo"));
		await scheduler.run();
		expect(events).toEqual([
			{ type: "subagent_start", id: "solo" },
			{ type: "subagent_stop", id: "solo" },
		]);
	});

	it("rejects duplicate task ids", () => {
		const scheduler = new SubagentScheduler({ executor: okExecutor() });
		expect(scheduler.add(spec("x"))).toEqual({ ok: true });
		expect(scheduler.add(spec("x")).ok).toBe(false);
	});
});
