import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fixture, keys, missingFacts, score, summary, tail } from "./fixture";
import { permittedPath } from "./control";
import { options, addUsage, emptyMetrics, classifyToolError, readArgumentShape } from "./run";

describe("model-free benchmark checks", () => {
	test("deterministic fixture has a four-record evidence chain and no prompt answer leakage", () => {
		const f = fixture("test-seed", 2, 4);
		expect(f).toEqual(fixture("test-seed", 2, 4));
		expect(f.sha256).not.toBe(fixture("different", 2, 4).sha256);
		expect(Object.keys(f.files)).toHaveLength(8);
		let ref = f.service;
		const lines = Object.values(f.files).flatMap(s => s.split("\n"));
		for (let stage = 0; stage < 4; stage++) {
			const record = lines.find(line => line.startsWith(`${ref};`))!;
			expect(record).toBeDefined();
			for (const key of keys.slice(stage * 2, stage * 2 + 2)) expect(record).toContain(`${key}=${f.gold[key]}`);
			ref = record.split("; next=")[1];
		}
		expect(missingFacts([f.prompt, f.question, summary, tail], f.gold)).toEqual([...keys]);
	});
	test("grades exact JSON fields, not prose mentions or approximate values", () => {
		const { gold } = fixture("grading", 1, 1);
		expect(score(`Brief\n\`\`\`json\n${JSON.stringify(gold)}\n\`\`\``, gold).allCorrect).toBe(true);
		expect(score(JSON.stringify({ ...gold, endpoint: "invented" }), gold).correct).toBe(7);
		expect(score(Object.values(gold).join(" "), gold).correct).toBe(0);
		expect(score("null", gold).correct).toBe(0);
		expect(score("{}", gold).allCorrect).toBe(false);
		expect(missingFacts([gold], gold)).toEqual([]);
	});
	test("rejects traversal, absolute escapes and internal/remote URLs", () => {
		for (const path of [".", "sources/record.txt", "sources/*.txt"]) expect(permittedPath("/tmp/fixture", path)).toBe(true);
		for (const path of ["..", "../auth", "/home/user/auth", "artifact://secret", "https://example.invalid", "../../*.json", "~/.omp/agent/auth", "file:/etc/passwd", null]) expect(permittedPath("/tmp/fixture", path)).toBe(false);
	});
	test("requires explicit paid-run consent and disallows OpenRouter and unbounded runs", () => {
		const base = ["--model", "openai-codex/gpt-5.5"];
		expect(() => options(base)).toThrow();
		expect(options([...base, "--dry-run"]).live).toBe(false);
		expect(options([...base, "--allow-model-calls"]).live).toBe(true);
		for (const args of [["--model", "openrouter/model", "--dry-run"], [...base, "--dry-run", "--trials", "100"], [...base, "--dry-run", "--timeout-seconds", "Infinity"], [...base, "--dry-run", "--compaction", "unknown"], [...base, "--dry-run", "--trials"]]) expect(() => options(args)).toThrow();
	});
	test("published aggregate evidence agrees with the human-facing figures", async () => {
		const evidence = await Bun.file(resolve(import.meta.dir, "evidence/controlled-2026-10-01.json")).json();
		const readme = await Bun.file(resolve(import.meta.dir, "../README.md")).text();
		expect(evidence.failure).toBeNull();
		expect(evidence.trials).toHaveLength(3);
		const totals = { history: emptyMetrics(), baseline: emptyMetrics() };
		for (const trial of evidence.trials) {
			expect(trial.eligible).toBe(true);
			expect(trial.missingFields).toEqual([...keys]);
			for (const name of ["history", "baseline"] as const) {
				const arm = trial.arms[name];
				expect(arm.score).toEqual({ correct: 8, total: 8, allCorrect: true });
				totals[name].modelCalls += arm.modelCalls;
				totals[name].totalTokens += arm.totalTokens;
			}
		}
		expect(readme).toContain(`${totals.history.modelCalls} vs ${totals.baseline.modelCalls} model calls`);
		expect(readme).toContain(`${totals.history.totalTokens.toLocaleString("en-US")} vs ${totals.baseline.totalTokens.toLocaleString("en-US")} reported total tokens`);
		const serialized = JSON.stringify(evidence);
		for (const forbidden of ['"sessionFile":', '"messages":', '"arguments":', '"content":', '"access_token":', '"refresh_token":', "Bearer ", "/home/"]) expect(serialized).not.toContain(forbidden);
	});
	test("revised three-way evidence retains failed arms and matches the README", async () => {
		const evidence = await Bun.file(resolve(import.meta.dir, "evidence/sparse-search-2026-10-01.json")).json();
		const readme = (await Bun.file(resolve(import.meta.dir, "../README.md")).text()).replace(/\s+/g, " ");
		expect(evidence.failure).toBeNull();
		expect(evidence.trials).toHaveLength(3);
		const totals = { history: emptyMetrics(), baseline: emptyMetrics() };
		for (const trial of evidence.trials) {
			expect(trial.eligible).toBe(true);
			expect(trial.missingFields).toEqual([...keys]);
			for (const name of ["history", "baseline"] as const) {
				const arm = trial.arms[name];
				expect(arm.completed).toBe(true);
				expect(arm.score.correct).toBe(8);
				expect(arm.toolErrors).toBe(0);
				totals[name].modelCalls += arm.modelCalls;
				totals[name].totalTokens += arm.totalTokens;
			}
		}
		const failed = evidence.trials[2].arms.previous_history;
		expect(failed.completed).toBe(false);
		expect(failed.failure).toBe("phase_budget_exhausted");
		expect(failed.toolCalls).toBeGreaterThan(16);
		expect(failed.totalTokens).toBeGreaterThan(0);
		expect(failed.score.correct).toBe(0);
		expect(evidence.trials[1].arms.previous_history.errorCategories.excerpt_arguments).toBe(6);
		expect(evidence.trials[1].arms.history.readArgumentShapes.ordinary_no_characters).toBe(1);
		expect(readme).toContain(`${totals.history.modelCalls} vs ${totals.baseline.modelCalls} model calls`);
		expect(readme).toContain(`${totals.history.totalTokens.toLocaleString("en-US")} vs ${totals.baseline.totalTokens.toLocaleString("en-US")} reported total tokens`);
		for (const file of ["sparse-search-2026-10-01.json", "sparse-search-diagnostic-2026-10-01.json"]) {
			const text = await Bun.file(resolve(import.meta.dir, "evidence", file)).text();
			for (const forbidden of ['"sessionFile":', '"messages":', '"arguments":', '"content":', '"access_token":', '"refresh_token":', "Bearer ", "/home/"]) expect(text).not.toContain(forbidden);
		}
	});
	test("diagnostics classify actionable read errors without exporting raw error text", () => {
		expect(classifyToolError("For a character excerpt supply line_count=1, start_column>=1")).toBe("excerpt_arguments");
		expect(classifyToolError("Session or transcript changed. Run session_grep again.")).toBe("snapshot_changed");
		expect(classifyToolError("Requested 60 session lines; maximum is 50.")).toBe("line_range");
		expect(classifyToolError("Unknown private error text")).toBe("other");
		expect(readArgumentShape({line_count:12,start_column:1,char_count:4096})).toBe("multi_line_with_characters");
		expect(readArgumentShape({line_count:12})).toBe("ordinary_no_characters");
		expect(readArgumentShape({line_count:1,start_column:1,char_count:100})).toBe("single_line_with_characters");
		expect(options(["--model", "openai-codex/gpt-5.5", "--dry-run", "--previous-extension", "/tmp/previous/index.ts"]).previousExtension).toBe("/tmp/previous/index.ts");
	});
	test("keeps cached and uncached provider tokens separate", () => {
		const m = emptyMetrics();
		addUsage(m, { input: 10, output: 3, cacheRead: 90, cacheWrite: 2, totalTokens: 105, cost: { total: 0.01 } });
		addUsage(m, { input: 5, output: 1, totalTokens: 6 });
		expect(m.input).toBe(15);
		expect(m.cacheRead).toBe(90);
		expect(m.totalTokens).toBe(111);
		expect(m.estimatedCostUsd).toBe(0.01);
	});
});
