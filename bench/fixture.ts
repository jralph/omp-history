import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const keys = ["endpoint", "region", "queue", "retryPolicy", "owner", "timeoutPolicy", "rollbackCode", "checksum"] as const;
export type Facts = Record<(typeof keys)[number], string>;
export const tail = "BENCHMARK_RETAINED_TAIL: The read-only investigation is complete. Await the next question.";
export const summary = "A read-only migration investigation completed. Its migration brief is in earlier conversation. Original registry records remain under sources/. No source files changed. Awaiting the next question.";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export function fixture(seed: string, shards = 32, rows = 64) {
	const target = parseInt(hash(seed).slice(0, 8), 16) % (shards * rows);
	const id = (stage: number, row: number) => `${["service", "route", "policy", "rollback"][stage]}-${hash(`${seed}/${stage}/${row}`).slice(0, 16)}`;
	const facts = (row: number): Facts => Object.fromEntries(keys.map(key => [key, `${key}-${hash(`${seed}/${row}/${key}`).slice(0, 16)}`])) as Facts;
	const files: Record<string, string> = {};
	for (let stage = 0; stage < 4; stage++) {
		for (let shard = 0; shard < shards; shard++) {
			const lines = [`# Synthetic ${["service", "route", "policy", "rollback"][stage]} registry shard ${shard}`];
			for (let row = shard * rows; row < (shard + 1) * rows; row++) {
				const f = facts(row);
				lines.push(`${id(stage, row)}; ${keys[stage * 2]}=${f[keys[stage * 2]]}; ${keys[stage * 2 + 1]}=${f[keys[stage * 2 + 1]]}${stage < 3 ? `; next=${id(stage + 1, row)}` : ""}`);
			}
			files[`sources/${["service", "route", "policy", "rollback"][stage]}-${shard.toString().padStart(3, "0")}.txt`] = `${lines.join("\n")}\n`;
		}
	}
	const service = id(0, target);
	const background = Array.from({ length: 240 }, (_, i) => `Historical migration note ${i}: unrelated component ${hash(`${seed}/background/${i}`).slice(0, 16)} passed staging review; rollout sequencing and documentation were discussed. No target registry values are contained in this note.`).join("\n");
	return {
		service, gold: facts(target), files,
		sha256: hash(JSON.stringify(files)),
		bytes: Object.values(files).reduce((n, s) => n + Buffer.byteLength(s), 0),
		prompt: `Investigate the synthetic migration for ${service}. Search the local sources/ registry files, following each next reference through service, route, policy, and rollback records. Extract these exact string fields: ${keys.join(", ")}. Do not write files or notes. Finish with the heading "Migration brief ${service}", followed by a pretty-printed JSON object containing all eight fields. Use evidence, not guesses.\n\nUnrelated prior project context:\n${background}`,
		question: `What were the exact eight values recorded in the earlier migration brief for ${service}? Return a JSON object with these keys: ${keys.join(", ")}. Use available evidence, not guesses. The original sources/ registry files are still available if needed. Do not write files.`,
	};
}

export async function writeFixture(root: string, data: ReturnType<typeof fixture>) {
	await mkdir(join(root, "sources"), { recursive: true });
	await Promise.all(Object.entries(data.files).map(([name, text]) => writeFile(join(root, name), text)));
}

export function score(text: string, gold: Facts) {
	let parsed: Record<string, unknown> = {};
	try {
		parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
	} catch { /* An unparseable answer earns no exact-match credit. */ }
	const correct = keys.filter(key => parsed?.[key] === gold[key]);
	return { correct: correct.length, total: keys.length, allCorrect: correct.length === keys.length };
}

export function missingFacts(context: unknown, gold: Facts) {
	const text = JSON.stringify(context);
	return keys.filter(key => !text.includes(gold[key]));
}
