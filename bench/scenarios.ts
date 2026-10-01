import { createHash } from "node:crypto";
import { fixture, keys } from "./fixture";

export const scenarioNames = ["cheap", "deep", "user-decision", "changed-source"] as const;
export type ScenarioName = typeof scenarioNames[number];
export type Answers = Record<string, string>;
export interface Scenario {
	name: ScenarioName;
	initial: ReturnType<typeof fixture>;
	phases: Array<{ prompt: string; gold: Answers }>;
	retrievalGold: Answers;
	gold: Answers;
	question: string;
	followupFiles: Record<string, string>;
	groups: Record<string, string[]>;
}
export const mixedSummary = "Read-only migration work completed; earlier conversation contains briefs and decisions. Some tasks distinguish drafts, user approvals, historical results, and current sources. Do not assume those agree. Await the next question.";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const facts = (seed: string, label: string): Answers => Object.fromEntries(keys.map(key => [key, `${label}-${key}-${hash(`${seed}/${label}/${key}`).slice(0, 16)}`]));
const uncertainty = " Return a single flat JSON object with the requested keys. Use null for a value you cannot establish; do not substitute a draft, assume equality, or invent a value. Do not write files.";

function deep(seed: string, shards: number, rows: number) {
	const base = fixture(seed, shards, rows);
	const target = parseInt(hash(seed).slice(0, 8), 16) % (shards * rows);
	const id = (stage: number, row: number) => `${stage === 0 ? "service" : `hop${stage}`}-${hash(`${seed}/${stage}/${row}`).slice(0, 16)}`;
	const files: Record<string, string> = {};
	for (let stage = 0; stage < 8; stage++) for (let shard = 0; shard < shards; shard++) {
		const lines = [`# Synthetic hop ${stage} registry shard ${shard}`];
		for (let row = shard * rows; row < (shard + 1) * rows; row++) {
			const key = keys[stage];
			const value = `${key}-${hash(`${seed}/${row}/${key}`).slice(0, 16)}`;
			lines.push(`${id(stage, row)}; ${key}=${value}${stage < 7 ? `; next=${id(stage + 1, row)}` : ""}`);
		}
		files[`sources/hop${stage}-${shard.toString().padStart(3, "0")}.txt`] = `${lines.join("\n")}\n`;
	}
	const prompt = base.prompt.replace("through service, route, policy, and rollback records", "across eight dependent records (hop0 through hop7)");
	return { ...base, service: id(0, target), files, prompt, sha256: hash(JSON.stringify(files)), bytes: Object.values(files).reduce((n, text) => n + Buffer.byteLength(text), 0) };
}

export function scenario(name: ScenarioName, seed: string, shards = 32, rows = 64): Scenario {
	const initial = name === "deep" ? deep(seed, shards, rows) : fixture(seed, shards, rows);
	const result: Scenario = { name, initial, phases: [{ prompt: initial.prompt, gold: initial.gold }], retrievalGold: initial.gold, gold: initial.gold, question: initial.question + uncertainty, followupFiles: initial.files, groups: { recalled: [...keys] } };
	if (name === "user-decision") {
		const approved = facts(seed, "approved");
		result.phases.push({
			prompt: `The previous migration brief for ${initial.service} was a DRAFT and is superseded. I approve the following eight values instead. They are a user decision, NOT stored in the sources, and override the earlier draft. Acknowledge them with the heading "Approved migration brief ${initial.service}" and a pretty-printed JSON object with exactly these keys and values. Do not modify files.\n${JSON.stringify(approved, null, 2)}`,
			gold: approved,
		});
		result.retrievalGold = approved; result.gold = approved;
		result.question = `What were the LATEST USER-APPROVED values for ${initial.service}, superseding its earlier draft migration brief? The sources contain only the unapproved draft, not this user decision. Requested keys: ${keys.join(", ")}.` + uncertainty;
		result.groups = { userDecision: [...keys] };
	}
	if (name === "changed-source") {
		const current = facts(seed, "current");
		result.followupFiles = Object.fromEntries(Object.entries(initial.files).map(([path, text]) => {
			for (const key of keys) text = text.replaceAll(initial.gold[key], current[key]);
			return [path, text];
		}));
		result.gold = Object.fromEntries(keys.flatMap(key => [[`historical_${key}`, initial.gold[key]], [`current_${key}`, current[key]]]));
		result.question = `For ${initial.service}, distinguish the eight values recorded AT THE TIME OF THE EARLIER MIGRATION BRIEF from the eight values CURRENTLY in sources/. The source revision has changed since the brief and contains no historical backup. Verify current values from the files; do not treat earlier history as proof of current state. Requested flat keys: ${Object.keys(result.gold).join(", ")}.` + uncertainty;
		result.groups = { historical: keys.map(key => `historical_${key}`), current: keys.map(key => `current_${key}`) };
	}
	return result;
}

export function taskPlan(suite: "linked-registry-v1" | "mixed-v2", seed: string, repeats: number) {
	return Array.from({ length: repeats }, (_, repeat) => (suite === "mixed-v2" ? scenarioNames : ["cheap"] as const).map(name => {
		const data = scenario(name, suite === "mixed-v2" ? `${seed}/${repeat}/${name}` : `${seed}/${repeat}`);
		// Preserve the original question byte-for-byte for old comparison mode.
		if (suite === "linked-registry-v1") data.question = data.initial.question;
		return { repeat: repeat + 1, data };
	})).flat();
}
