import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { missingFacts, writeFixture } from "./fixture";
import type { Scenario } from "./scenarios";
import type { Metrics } from "./run";

export interface Agent { c: RpcClient; status: { activeTools: string[] }; dir: string; work: string }
export interface Condition { name: string; extension?: string }
export interface Ops {
	launch(dir: string, work: string, history: boolean, resume?: string, extension?: string): Promise<Agent>;
	phase(c: RpcClient, text: string, gold: Record<string, string>, groups?: Record<string, string[]>): Promise<Record<string, any>>;
	compact(c: RpcClient): Promise<{ context: unknown; metrics: Metrics }>;
	stop(agent: Agent): Promise<void>;
	empty(): Metrics;
	save(): Promise<void>;
}
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function sumMetrics(parts: Metrics[], empty: () => Metrics): Metrics {
	const out = empty();
	for (const part of parts) {
		for (const key of ["elapsedMs", "modelCalls", "toolCalls", "toolErrors", "toolOutputBytes", "input", "output", "cacheRead", "cacheWrite", "totalTokens", "estimatedCostUsd"] as const) out[key] += part[key];
		for (const key of ["tools", "errorCategories", "errorTools", "nullOptionalArguments", "readArgumentShapes"] as const) for (const [name, count] of Object.entries(part[key])) out[key][name] = (out[key][name] ?? 0) + count;
		for (const key of ["exact", "different", "unknown"] as const) out.readSnapshotCopies[key] += part.readSnapshotCopies[key];
	}
	return out;
}
async function clone(serialized: string, dir: string, work: string) {
	await mkdir(dir, { recursive: true });
	const lines = serialized.trimEnd().split("\n");
	const header = JSON.parse(lines[0]); header.id = randomUUID(); header.cwd = work;
	lines[0] = JSON.stringify(header);
	const path = join(dir, "session.jsonl");
	await writeFile(path, `${lines.join("\n")}\n`, { mode: 0o600 });
	return path;
}
async function investigate(agent: Agent, data: Scenario, ops: Ops) {
	const phases: Array<Record<string, any>> = [];
	for (const phase of data.phases) {
		const result = await ops.phase(agent.c, phase.prompt, phase.gold);
		phases.push(result);
		if (!result.completed || !result.score.allCorrect) break;
	}
	return { phases, metrics: sumMetrics(phases as Metrics[], ops.empty), allCorrect: phases.length === data.phases.length && phases.every(p => p.completed && p.score.allCorrect) };
}
async function prepare(agent: Agent, data: Scenario, ops: Ops) {
	await agent.c.promptAndWait("/bench_pad", undefined, 30_000);
	const { context, metrics } = await ops.compact(agent.c);
	const missing = missingFacts(context, data.retrievalGold);
	await agent.c.promptAndWait("/bench_status", undefined, 30_000);
	const status = JSON.parse(await readFile(join(agent.dir, "status.json"), "utf8"));
	const serialized = await readFile(status.sessionFile, "utf8");
	return { context, metrics, missing, serialized, eligible: missing.length === Object.keys(data.retrievalGold).length };
}
async function followup(dir: string, work: string, condition: Condition, data: Scenario, prepared: Awaited<ReturnType<typeof prepare>>, ops: Ops) {
	const path = await clone(prepared.serialized, dir, work);
	const agent = await ops.launch(dir, work, condition.extension !== undefined, path, condition.extension);
	const restored = await agent.c.getMessages();
	if (digest(restored) !== digest(prepared.context) || missingFacts(restored, data.retrievalGold).length !== Object.keys(data.retrievalGold).length) throw new Error("Restored context mismatch");
	const result = await ops.phase(agent.c, data.question, data.gold, data.groups);
	await ops.stop(agent);
	const unchanged = await Promise.all(Object.entries(data.followupFiles).map(async ([name, text]) => await readFile(join(work, name), "utf8") === text));
	if (unchanged.some(equal => !equal)) throw new Error("Fixture changed");
	return { ...result, activeTools: agent.status.activeTools };
}
export async function executeTask(row: Record<string, any>, dir: string, data: Scenario, conditions: Condition[], scope: "followup" | "lifecycle", ops: Ops) {
	row.task = data.name;
	row.answerFields = Object.keys(data.gold).length;
	row.groups = data.groups;
	row.fixtureSha256 = data.initial.sha256;
	row.followupFixtureSha256 = digest(data.followupFiles);
	row.fixtureFiles = Object.keys(data.initial.files).length;
	row.fixtureBytes = data.initial.bytes;
	row.initialPromptBytes = data.phases.reduce((n, p) => n + Buffer.byteLength(p.prompt), 0);
	row.armOrder = conditions.map(c => c.name);
	row.eligible = false; row.arms = {};
	if (scope === "followup") {
		const work = join(dir, "work");
		await writeFixture(work, data.initial);
		const seed = await ops.launch(join(dir, "seed"), work, false);
		const setup = await investigate(seed, data, ops);
		row.seed = setup;
		if (!setup.allCorrect) { row.ineligibleReason = "seed_answer_incorrect"; await ops.stop(seed); return; }
		const prepared = await prepare(seed, data, ops);
		row.compactionUsage = prepared.metrics;
		row.missingFields = prepared.missing;
		row.compactedContextSha256 = digest(prepared.context);
		row.compactedContextBytes = Buffer.byteLength(JSON.stringify(prepared.context));
		await ops.stop(seed);
		if (!prepared.eligible) { row.ineligibleReason = "facts_retained_in_compacted_context"; return; }
		row.eligible = true;
		await writeFixture(work, { files: data.followupFiles });
		for (const condition of conditions) {
			console.log(`${row.trial} ${data.name}: ${condition.name} follow-up`);
			row.arms[condition.name] = await followup(join(dir, condition.name), work, condition, data, prepared, ops);
			await ops.save();
		}
		return;
	}
	for (const condition of conditions) {
		console.log(`${row.trial} ${data.name}: ${condition.name} full lifecycle`);
		const start = performance.now();
		const armDir = join(dir, condition.name), work = join(armDir, "work");
		await writeFixture(work, data.initial);
		const agent = await ops.launch(join(armDir, "seed"), work, condition.extension !== undefined, undefined, condition.extension);
		const setup = await investigate(agent, data, ops);
		const arm: Record<string, any> = { setup, eligible: false, completed: false };
		row.arms[condition.name] = arm;
		if (!setup.allCorrect) {
			arm.ineligibleReason = "seed_answer_incorrect";
			arm.lifecycle = setup.metrics;
			await ops.stop(agent); await ops.save(); continue;
		}
		const prepared = await prepare(agent, data, ops);
		arm.compactionUsage = prepared.metrics;
		arm.missingFields = prepared.missing;
		arm.compactedContextSha256 = digest(prepared.context);
		arm.compactedContextBytes = Buffer.byteLength(JSON.stringify(prepared.context));
		await ops.stop(agent);
		arm.eligible = prepared.eligible;
		if (!prepared.eligible) {
			arm.ineligibleReason = "facts_retained_in_compacted_context";
			arm.lifecycle = sumMetrics([setup.metrics, prepared.metrics], ops.empty);
			await ops.save(); continue;
		}
		await writeFixture(work, { files: data.followupFiles });
		Object.assign(arm, await followup(join(armDir, "followup"), work, condition, data, prepared, ops));
		arm.lifecycle = sumMetrics([setup.metrics, prepared.metrics, arm as Metrics], ops.empty);
		arm.wallElapsedMs = Math.round(performance.now() - start);
		await ops.save();
	}
	row.eligible = conditions.every(c => row.arms[c.name].eligible);
}
