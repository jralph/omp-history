import { expect, test } from "bun:test";
import { assess, keys, missingFacts, score } from "./fixture";
import { mixedSummary, scenario, taskPlan } from "./scenarios";
import { emptyMetrics, options } from "./run";
import { sumMetrics } from "./execute";

test("deep scenario requires eight dependent records with unchanged exact field semantics", () => {
	const s = scenario("deep", "deep-test", 2, 4);
	const lines = Object.values(s.initial.files).flatMap(text => text.split("\n"));
	let ref = s.initial.service;
	for (const key of keys) {
		const line = lines.find(line => line.startsWith(`${ref};`))!;
		expect(line).toContain(`${key}=${s.gold[key]}`);
		ref = line.split("; next=")[1];
	}
	expect(ref).toBeUndefined();
	expect(Object.keys(s.initial.files)).toHaveLength(16);
	expect(missingFacts([s.question, mixedSummary], s.retrievalGold)).toHaveLength(8);
});

test("user-approved decision supersedes a real draft phase and cannot be rebuilt from files", () => {
	const s = scenario("user-decision", "decision-test", 1, 2);
	expect(s.phases).toHaveLength(2);
	const source = JSON.stringify(s.followupFiles);
	for (const key of keys) {
		expect(source).toContain(s.phases[0].gold[key]);
		expect(source).not.toContain(s.gold[key]);
		expect(s.phases[1].prompt).toContain(s.gold[key]);
		expect(s.gold[key]).not.toBe(s.phases[0].gold[key]);
	}
	expect(missingFacts([s.question, mixedSummary], s.retrievalGold)).toHaveLength(8);
});

test("changed-source scenario separates historical truth from verifiable current values", () => {
	const s = scenario("changed-source", "changed-test", 1, 2);
	const before = JSON.stringify(s.initial.files), after = JSON.stringify(s.followupFiles);
	expect(Object.keys(s.gold)).toHaveLength(16);
	for (const key of keys) {
		expect(before).toContain(s.gold[`historical_${key}`]);
		expect(after).not.toContain(s.gold[`historical_${key}`]);
		expect(after).toContain(s.gold[`current_${key}`]);
		expect(before).not.toContain(s.gold[`current_${key}`]);
	}
	expect(s.groups.current).toHaveLength(8);
	expect(missingFacts([s.question, mixedSummary], s.gold)).toHaveLength(16);
});

test("grading distinguishes explicit uncertainty, wrong claims, missing fields and invalid JSON", () => {
	const gold = { old: "old-token", now: "current-token", approved: "decision-token", other: "other-token" };
	expect(assess('{"old":null,"now":"current-token","approved":"draft-token"}', gold)).toEqual({validJson:true,correct:1,unknown:1,incorrectClaims:1,missing:1});
	expect(assess("I need clarification", gold)).toEqual({validJson:false,correct:0,unknown:0,incorrectClaims:0,missing:4});
	expect(score(JSON.stringify(gold), gold)).toEqual({correct:4,total:4,allCorrect:true});
	expect(score(JSON.stringify({old:"old-token"}), gold).correct).toBe(1);
});

test("lifecycle sums actual phases once, including cache, calls, errors and elapsed time", () => {
	const setup = emptyMetrics(), compact = emptyMetrics(), followup = emptyMetrics();
	setup.input = 10; setup.cacheRead = 100; setup.modelCalls = 3; setup.elapsedMs = 1000; setup.tools.grep = 2;
	compact.input = 5; compact.modelCalls = 1; compact.elapsedMs = 20;
	followup.input = 4; followup.cacheRead = 8; followup.modelCalls = 2; followup.elapsedMs = 300; followup.tools.session_read = 1;
	const total = sumMetrics([setup, compact, followup], emptyMetrics);
	expect(total.input).toBe(19); expect(total.cacheRead).toBe(108);
	expect(total.modelCalls).toBe(6); expect(total.elapsedMs).toBe(1320);
	expect(total.tools).toEqual({grep:2,session_read:1});
	expect(setup.modelCalls).toBe(3);
});

test("archived lifecycle evidence reconciles all phases and published accuracy/cost figures", async () => {
	const report = await Bun.file(new URL("./evidence/mixed-lifecycle-2026-10-01.json", import.meta.url)).json();
	expect(report.failure).toBeNull(); expect(report.trials).toHaveLength(8);
	for (const [name, expected] of Object.entries({ baseline: {correct:48,unknown:32,calls:120,tokens:1402717,cost:2.44124}, history: {correct:80,unknown:0,calls:84,tokens:1053029,cost:1.847593} })) {
		const arms = report.trials.map((r: any) => r.arms[name]);
		expect(arms.every((a: any) => a.eligible && a.completed && a.setup.allCorrect)).toBe(true);
		expect(arms.reduce((n: number,a: any) => n+a.score.correct,0)).toBe(expected.correct);
		expect(arms.reduce((n: number,a: any) => n+a.assessment.unknown,0)).toBe(expected.unknown);
		expect(arms.reduce((n: number,a: any) => n+a.assessment.incorrectClaims,0)).toBe(0);
		expect(arms.reduce((n: number,a: any) => n+a.lifecycle.modelCalls,0)).toBe(expected.calls);
		expect(arms.reduce((n: number,a: any) => n+a.lifecycle.totalTokens,0)).toBe(expected.tokens);
		expect(arms.reduce((n: number,a: any) => n+a.lifecycle.estimatedCostUsd,0)).toBeCloseTo(expected.cost,6);
		for (const a of arms) {
			expect(a.missingFields).toHaveLength(8);
			const sum = sumMetrics([a.setup.metrics,a.compactionUsage,a],emptyMetrics);
			expect(a.lifecycle).toEqual(sum);
			expect(a.setup.metrics.tools.session_grep).toBeUndefined();
		}
	}
	for (let i=0;i<4;i++) expect(report.trials[i].armOrder).toEqual([...report.trials[i+4].armOrder].reverse());
});

test("suite and scope are explicit, bounded, and preserve legacy workload prompts", () => {
	const base = ["--model", "openai-codex/gpt-5.5", "--dry-run"];
	expect(options([...base,"--suite","mixed-v2","--scope","lifecycle","--max-tool-calls","32"]).scope).toBe("lifecycle");
	for (const args of [["--scope","invalid"],["--suite","invalid"],["--max-tool-calls","100"]]) expect(() => options([...base,...args])).toThrow();
	const plan = taskPlan("mixed-v2", "plan-test", 2);
	expect(plan).toHaveLength(8);
	expect(plan.map(p => p.repeat)).toEqual([1,1,1,1,2,2,2,2]);
	const legacy = taskPlan("linked-registry-v1", "legacy", 1)[0].data;
	expect(legacy.question).toBe(legacy.initial.question);
});
