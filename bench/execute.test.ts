// Model-free protocol tests; these do not substitute for the archived live CLI run.
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { executeTask, type Ops } from "./execute";
import { scenario } from "./scenarios";
import { emptyMetrics } from "./run";
import { score, assess } from "./fixture";

for (const scope of ["lifecycle", "followup"] as const) test(`orchestration ${scope}: isolated declarations, source revision, exact grading and single-count usage`, async () => {
	const root = await mkdtemp(join(tmpdir(), "omp-history-protocol-test-"));
	try {
		const data = scenario("changed-source", "protocol", 1, 2);
		const context = [{ role: "user", content: "Unrelated retained context" }];
		const launches: Array<{history:boolean;resume:boolean;work:string}> = [];
		const row: Record<string, any> = { trial: 1 };
		const ops: Ops = {
			empty: emptyMetrics, save: async () => {}, stop: async () => {},
			launch: async (dir, work, history, resume) => {
				launches.push({history,resume:resume !== undefined,work});
				await mkdir(dir, { recursive: true });
				const sessionFile = join(dir, "source.jsonl");
				await writeFile(sessionFile, '{"type":"session","id":"fixture-only"}\n');
				await writeFile(join(dir,"status.json"),JSON.stringify({sessionFile}));
				return { dir, work, status: { activeTools: history ? ["grep","session_grep","session_read"] : ["grep"] }, c: { promptAndWait: async () => {}, getMessages: async () => context } as unknown as RpcClient };
			},
			compact: async () => { const metrics = emptyMetrics(); metrics.elapsedMs = 2; return {context,metrics}; },
			phase: async (_c, text, gold) => {
				const metrics = emptyMetrics(); metrics.modelCalls = 1; metrics.input = 10; metrics.elapsedMs = 5;
				if (text === data.question) {
					for (const launch of launches.filter(l => l.resume)) for (const [path, content] of Object.entries(data.followupFiles)) expect(await readFile(join(launch.work,path),"utf8")).toBe(content);
				}
				return {...metrics,completed:true,score:score(JSON.stringify(gold),gold),assessment:assess(JSON.stringify(gold),gold)};
			},
		};
		await executeTask(row,root,data,[{name:"baseline"},{name:"history",extension:"/trusted/fixture-only.ts"}],scope,ops);
		expect(row.eligible).toBe(true);
		expect(row.arms.history.score.correct).toBe(16);
		expect(row.arms.baseline.score.correct).toBe(16);
		if (scope === "lifecycle") {
			expect(launches.map(l => l.history)).toEqual([false,false,true,true]);
			expect(launches[0].work).not.toBe(launches[2].work);
			for (const arm of Object.values(row.arms) as any[]) {
				expect(arm.lifecycle.modelCalls).toBe(2);
				expect(arm.lifecycle.input).toBe(20);
				expect(arm.lifecycle.elapsedMs).toBe(12);
			}
		} else {
			expect(launches.map(l => l.history)).toEqual([false,false,true]);
			expect(row.seed.metrics.modelCalls).toBe(1);
			expect(row.arms.history.lifecycle).toBeUndefined();
		}
	} finally { await rm(root,{recursive:true,force:true}); }
});
