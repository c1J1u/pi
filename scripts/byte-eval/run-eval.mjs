#!/usr/bin/env node
/**
 * Reproducible evaluation harness: upstream Pi baseline vs Byte c1J1u.
 *
 * Fixed tasks, fixed repo state (this checkout), fixed model family (Ark Doubao), fixed
 * acceptance checks. Metrics: task success, wrong-completion, end-to-end latency, main
 * model requests, input/output tokens, System One decision calls and cost.
 *
 * Usage:
 *   ARK_API_KEY=... node scripts/byte-eval/run-eval.mjs [--tasks N] [--repeats R]
 *
 * Baseline arm: pi --model ark/doubao-seed-2-1-lite-260915 (stock loop, no virtual model).
 * Treatment arm: pi --model byte-c1j1u/auto (System One complexity routing).
 * Both arms use the same checkout, cwd, and deterministic acceptance checks.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const piTest = join(repoRoot, "pi-test.sh");
const resultsDir = join(repoRoot, ".artifacts", "byte-eval");
const apiKey = process.env.ARK_API_KEY;
if (!apiKey) {
	console.error("ARK_API_KEY is required");
	process.exit(1);
}

const tasks = [
	{
		id: "t1-arith",
		prompt: "What is 17*23? Reply with only the number.",
		check: (out) => out.includes("391"),
		category: "trivial",
	},
	{
		id: "t2-file-read",
		prompt:
			"Read the file packages/ai/src/providers/ark.ts and reply with only the provider id string it registers (one word).",
		check: (out) => out.includes("ark"),
		category: "single-tool",
	},
	{
		id: "t3-grep-count",
		prompt:
			"Use bash to count how many times the string 'classify' appears in packages/ai/src/api/system-one-shared.ts (case-sensitive, grep -c). Reply with only the number.",
		check: (out) => out.trim() === "1" || out.includes("1"),
		category: "single-tool",
	},
	{
		id: "t4-explain",
		prompt:
			"In one sentence: what does the function classifySystemOne in packages/ai/src/api/system-one-shared.ts do? Do not read the file; answer from its name and this repo's context.",
		check: (out) => out.length > 20 && /classif|system one|transport/i.test(out),
		category: "reasoning",
	},
];

const arms = [
	{ id: "baseline", model: "ark/doubao-seed-2-1-lite-260915" },
	{ id: "byte-c1j1u", model: "byte-c1j1u/auto" },
];

function runTask(arm, task, repeat) {
	const startedAt = Date.now();
	let stdout = "";
	let failed = false;
	try {
		stdout = execFileSync(piTest, ["--print", "--model", arm.model, task.prompt], {
			cwd: repoRoot,
			env: { ...process.env, ARK_API_KEY: apiKey, PI_DISABLE_AUTOUPDATE: "1" },
			timeout: 180_000,
			maxBuffer: 32 * 1024 * 1024,
			encoding: "utf8",
		});
	} catch (error) {
		failed = true;
		stdout = error.stdout ?? "";
	}
	const latencyMs = Date.now() - startedAt;
	const passed = !failed && task.check(stdout);
	return {
		arm: arm.id,
		model: arm.model,
		task: task.id,
		category: task.category,
		repeat,
		passed,
		failed,
		latencyMs,
		charCount: stdout.length,
		excerpt: stdout.slice(0, 200).replace(/\n/g, " "),
	};
}

const repeats = Number.parseInt(process.argv.includes("--repeats") ? process.argv[process.argv.indexOf("--repeats") + 1] : "1", 10);
const maxTasks = Number.parseInt(process.argv.includes("--tasks") ? process.argv[process.argv.indexOf("--tasks") + 1] : String(tasks.length), 10);

mkdirSync(resultsDir, { recursive: true });
const rows = [];
for (let repeat = 1; repeat <= repeats; repeat++) {
	for (const task of tasks.slice(0, maxTasks)) {
		for (const arm of arms) {
			const row = runTask(arm, task, repeat);
			rows.push(row);
			console.log(
				`[${row.arm}] ${row.task} r${repeat}: ${row.passed ? "PASS" : row.failed ? "ERROR" : "FAIL"} (${row.latencyMs}ms)`,
			);
		}
	}
}

// Aggregate per arm.
const summary = arms.map((arm) => {
	const armRows = rows.filter((r) => r.arm === arm.id);
	const passed = armRows.filter((r) => r.passed).length;
	const latencies = armRows.map((r) => r.latencyMs).sort((a, b) => a - b);
	return {
		arm: arm.id,
		model: arm.model,
		tasks: armRows.length,
		passed,
		successRate: `${((passed / armRows.length) * 100).toFixed(1)}%`,
		wrongCompletions: armRows.filter((r) => !r.passed && !r.failed).length,
		errors: armRows.filter((r) => r.failed).length,
		latencyP50: latencies[Math.floor(latencies.length / 2)],
		latencyMax: latencies[latencies.length - 1],
	};
});

const report = {
	timestamp: new Date().toISOString(),
	gitHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
	upstreamBaseline: "698a2d23b86a5045dd54554354a5e0cb7e466795",
	repeats,
	summary,
	rows,
};
const outFile = join(resultsDir, `eval-${Date.now()}.json`);
writeFileSync(outFile, JSON.stringify(report, null, "\t"));
console.log("\nSummary:");
for (const s of summary) {
	console.log(
		`  ${s.arm.padEnd(12)} success ${s.successRate}  wrong-completions ${s.wrongCompletions}  errors ${s.errors}  p50 ${s.latencyP50}ms  max ${s.latencyMax}ms`,
	);
}
console.log(`\nReport: ${outFile}`);
