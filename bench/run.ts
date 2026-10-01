import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { setTransports } from "@oh-my-pi/pi-utils/logger";
import { fixture, writeFixture, score, missingFacts, keys, assess } from "./fixture";
import { taskPlan } from "./scenarios";
import { executeTask } from "./execute";

export interface Options {
	model: string; trials: number; seed: string; timeoutSeconds: number;
	compaction: "controlled" | "natural"; output: string; live: boolean; dryRun: boolean; previousExtension?: string;
	suite: "linked-registry-v1" | "mixed-v2"; scope: "followup" | "lifecycle"; maxToolCalls: number;
}
export function options(args: string[]): Options {
	const o: Options = { model: "", trials: 3, seed: "omp-history-linked-registry-v1", timeoutSeconds: 180, compaction: "controlled", output: `bench-results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`, live: false, dryRun: false, suite: "linked-registry-v1", scope: "followup", maxToolCalls: 16 };
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--") continue;
		if (a === "--allow-model-calls") { o.live = true; continue; }
		if (a === "--dry-run") { o.dryRun = true; continue; }
		const v = args[++i];
		if (!v || v.startsWith("--")) throw new Error("Missing benchmark option value");
		if (a === "--model") o.model = v;
		else if (a === "--trials") o.trials = Number(v);
		else if (a === "--seed") o.seed = v;
		else if (a === "--timeout-seconds") o.timeoutSeconds = Number(v);
		else if (a === "--output") o.output = v;
		else if (a === "--previous-extension") o.previousExtension = resolve(v);
		else if (a === "--suite" && (v === "linked-registry-v1" || v === "mixed-v2")) o.suite = v;
		else if (a === "--scope" && (v === "followup" || v === "lifecycle")) o.scope = v;
		else if (a === "--max-tool-calls") o.maxToolCalls = Number(v);
		else if (a === "--compaction" && (v === "controlled" || v === "natural")) o.compaction = v;
		else throw new Error("Unknown benchmark option");
	}
	if (!/^[-a-z0-9]+\/[^\s]+$/i.test(o.model) || o.model.split("/")[0].toLowerCase().includes("openrouter")) throw new Error("Specify an explicit non-OpenRouter provider/model");
	if (!Number.isInteger(o.trials) || o.trials < 1 || o.trials > 10) throw new Error("Trials must be 1–10");
	if (!Number.isInteger(o.timeoutSeconds) || o.timeoutSeconds < 10 || o.timeoutSeconds > 600) throw new Error("Timeout must be 10–600 seconds");
	if (!Number.isInteger(o.maxToolCalls) || o.maxToolCalls < 16 || o.maxToolCalls > 48) throw new Error("Tool-call cap must be 16–48");
	if (!o.output.endsWith(".json")) throw new Error("Output must be a JSON report path");
	if (!o.live && !o.dryRun) throw new Error("Live runs require --allow-model-calls; use --dry-run for a model-free plan");
	return o;
}

export function emptyMetrics() {
	return { elapsedMs: 0, modelCalls: 0, toolCalls: 0, toolErrors: 0, toolOutputBytes: 0, tools: {} as Record<string, number>, errorCategories: {} as Record<string, number>, errorTools: {} as Record<string, number>, nullOptionalArguments: {} as Record<string, number>, readSnapshotCopies: { exact: 0, different: 0, unknown: 0 }, readArgumentShapes: {} as Record<string, number>, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, estimatedCostUsd: 0 };
}
export type Metrics = ReturnType<typeof emptyMetrics>;
export function addUsage(m: Metrics, usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } }) {
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) m[key] += usage[key] ?? 0;
	m.estimatedCostUsd += usage.cost?.total ?? 0;
}
export function readArgumentShape(args: Record<string, unknown>): string {
	const column = args.start_column, count = args.char_count;
	if (column === undefined && count === undefined) return "ordinary_no_characters";
	if (column === 0 && count === 0) return "zero_character_pair";
	if ((args.line_count ?? 1) !== 1) return "multi_line_with_characters";
	if (column === undefined || count === undefined) return "incomplete_character_pair";
	return "single_line_with_characters";
}
export function classifyToolError(text: string): string {
	if (text.includes("Session or transcript changed")) return "snapshot_changed";
	if (text.includes("Invalid or stale history reference")) return "snapshot_invalid";
	if (text.includes("For a character excerpt supply")) return "excerpt_arguments";
	if (/Requested \d+ session lines; maximum|line_count must|start_line must|does not exist/.test(text)) return "line_range";
	if (/32 KiB|read output budget/.test(text)) return "read_budget";
	if (/[Ss]earch is too broad/.test(text)) return "search_budget";
	if (/all_of must/.test(text)) return "anchor_arguments";
	if (/[Vv]alidation|[Ii]nvalid.*[Aa]rgument|[Ss]chema|[Ss]napshot|[Tt]oo (big|small)|[Ee]xpected.*(number|string)/.test(text)) return "argument_validation";
	if (/No such file|os error 2|not found/i.test(text)) return "not_found";
	return "other";
}
const resultText = (result: any): string => typeof result === "string" ? result : (result?.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n");
async function extensionHash(path: string) {
	return digest(await Promise.all(["index.ts", "transcript.ts", "snapshot.ts"].map(name => readFile(name === "index.ts" ? path : resolve(path, "..", name), "utf8"))));
}
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
class Failure extends Error { constructor(readonly code: string, readonly metrics?: Metrics) { super(code); } }
async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Failure("timeout")), milliseconds); })]); }
	finally { clearTimeout(timer!); }
}

async function main(o: Options) {
	const plan = taskPlan(o.suite, o.seed, o.trials);
	if (o.dryRun && (o.suite === "mixed-v2" || o.scope === "lifecycle")) {
		console.log(JSON.stringify({ mode: "model-free-plan", suite: o.suite, scope: o.scope, model: o.model, tasks: plan.map(p => ({ repeat: p.repeat, scenario: p.data.name, initialFiles: Object.keys(p.data.initial.files).length, initialBytes: p.data.initial.bytes, seedPhases: p.data.phases.length, answerFields: Object.keys(p.data.gold).length })), conditions: o.previousExtension ? 3 : 2, maxToolCallsPerPhase: o.maxToolCalls, timeoutSeconds: o.timeoutSeconds }, null, 2));
		return;
	}
	if (o.dryRun) {
		const f = fixture(`${o.seed}/0`);
		console.log(JSON.stringify({ mode: "model-free-plan", model: o.model, trials: o.trials, conditions: o.previousExtension ? ["baseline", "previous_history", "history"] : ["baseline", "history"], compaction: o.compaction, fixtureFiles: Object.keys(f.files).length, fixtureBytes: f.bytes, initialPromptBytes: Buffer.byteLength(f.prompt), answerFields: keys.length, maxToolCallsPerPhase: o.maxToolCalls, timeoutSeconds: o.timeoutSeconds }, null, 2));
		return;
	}
	if (await Bun.file(resolve(o.output)).exists()) throw new Failure("output_already_exists");
	const extensionVersion = (await Bun.file(resolve(import.meta.dir, "../package.json")).json()).version as string;
	const extensionSourceSha256 = await extensionHash(resolve(import.meta.dir, "../index.ts"));
	const previousExtensionSourceSha256 = o.previousExtension ? await extensionHash(o.previousExtension) : undefined;
	// Do not route auth-broker diagnostics or secrets to logs/artifacts.
	setTransports({ console: false, file: false });
	const root = await mkdtemp(join(tmpdir(), "omp-history-bench-")); // mkdtemp creates mode 0700
	const clients = new Set<RpcClient>();
	const report = { schemaVersion: o.suite === "mixed-v2" || o.scope === "lifecycle" ? 2 : 1, workload: o.suite, measurementScope: o.scope, maxToolCallsPerPhase: o.maxToolCalls, createdAt: new Date().toISOString(), model: o.model, thinking: "low", compaction: o.compaction, seed: o.seed, requestedTrials: o.trials, runtimeVersion: "", extensionVersion, extensionSourceSha256, previousExtensionSourceSha256, notes: ["Synthetic paired experiment; not a population estimate.", "Fixed lossy summary in controlled mode; natural mode keeps OMP's summarizer.", o.scope === "lifecycle" ? "Independent seed investigations include active tool declarations from the start; lifecycle sums setup, compaction and follow-up." : "Shared seed investigation is reported separately, not charged twice.", "Input excludes separately reported cacheRead/cacheWrite; totalTokens is provider-reported.", "Cost is OMP's catalog estimate, not an invoice. Timing excludes process startup.", o.previousExtension ? "Normal prompt caching remains enabled; three-condition order rotates." : "Normal prompt caching remains enabled; arm order alternates.", "Only aggregate measurements are exported; temporary sessions/homes are deleted."], trials: [] as Array<Record<string, unknown>>, failure: null as string | null, terminalPhase: null as Record<string, unknown> | null };
	const save = async () => { await mkdir(resolve(o.output, ".."), { recursive: true }); await writeFile(resolve(o.output), `${JSON.stringify(report, null, 2)}\n`); };
	let broker: ReturnType<typeof startAuthBroker> | undefined;
	let auth: Awaited<ReturnType<typeof discoverAuthStorage>> | undefined;
	try {
		const version = Bun.spawnSync(["omp", "--version"], { stdout: "pipe", stderr: "pipe" });
		report.runtimeVersion = version.stdout.toString().match(/\d+\.\d+\.\d+/)?.[0] ?? "unknown";
		if (version.exitCode !== 0 || report.runtimeVersion !== "18.4.4") throw new Failure("requires_omp_18_4_4");
		// The vault stays in its existing location. No credentials or configuration
		// are copied into the isolated homes. Only an in-memory loopback bearer is passed.
		auth = await discoverAuthStorage();
		const token = randomBytes(32).toString("hex");
		broker = startAuthBroker({ storage: auth, bind: "127.0.0.1:0", bearerTokens: [token], disableRefresher: true });
		const config = join(root, "config.yml");
		await writeFile(config, "disabledProviders: [openrouter]\nmemory:\n  backend: off\nproviders:\n  cacheWarming: off\ncompaction:\n  enabled: false\n  asyncEnabled: false\n  idleEnabled: false\n  autoContinue: false\n  keepRecentTokens: 0\n  methodOrder: [soft]\nretry:\n  enabled: false\n  modelFallback: false\n");
		const launch = async (dir: string, work: string, history: boolean, resume?: string, extension = resolve(import.meta.dir, "../index.ts")) => {
			const home = join(dir, "home");
			await mkdir(home, { recursive: true });
			const env: Record<string, string> = { HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"), PI_CODING_AGENT_DIR: join(home, ".omp/agent"), PI_PROFILE: "", OMP_PROFILE: "", OPENROUTER_API_KEY: "", OMP_AUTH_BROKER_URL: broker!.url, OMP_AUTH_BROKER_TOKEN: token, OMP_BENCH_CWD: work, OMP_BENCH_HISTORY: history ? "1" : "0", OMP_BENCH_COMPACTION: o.compaction, OMP_BENCH_SUITE: o.suite, OMP_BENCH_STATUS_FILE: join(dir, "status.json") };
			const args = ["--no-ui", "--no-extensions", "--no-rules", "--no-skills", "--no-title", "--no-lsp", "--no-pty", "--thinking", "low", "--smol", o.model, "--slow", o.model, "--plan", o.model, "--config", config, "--tools", "read,grep,glob", "--cwd", work, "-e", resolve(import.meta.dir, "control.ts")];
			if (history) args.push("-e", extension);
			if (resume) args.push("--resume", resume);
			const c = new RpcClient({ command: ["omp"], cwd: work, env, model: o.model, sessionDir: join(dir, "sessions"), args });
			clients.add(c);
			await bounded(c.start(), 60_000);
			const state = await c.getState();
			if (!state.model || `${state.model.provider}/${state.model.id}` !== o.model) throw new Failure("model_mismatch");
			await c.promptAndWait("/bench_status", undefined, 30_000);
			const status = JSON.parse(await readFile(env.OMP_BENCH_STATUS_FILE, "utf8")) as { activeTools: string[]; sessionFile?: string };
			return { c, status, dir, work };
		};
		let totalEstimatedCost = 0;
		const prompt = async (c: RpcClient, text: string) => {
			const m = emptyMetrics();
			let failed: string | null = null;
			let lastSnapshot: string | undefined;
			const unsubscribeResult = c.onPromptResult(result => { if (result.status !== "completed") failed ??= "prompt_not_completed"; });
			const unsubscribe = c.onEvent(event => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					const msg = event.message;
					m.modelCalls++;
					if (`${msg.provider}/${msg.model}` !== o.model) failed = "model_mismatch";
					if (msg.usage) { addUsage(m, msg.usage); totalEstimatedCost += msg.usage.cost.total; }
					for (const block of msg.content) if (block.type === "toolCall") {
						m.toolCalls++; m.tools[block.name] = (m.tools[block.name] ?? 0) + 1;
						if (block.name === "session_read" || block.name === "session_grep") {
							for (const key of ["kind", "context_lines", "all_of", "line_count", "start_column", "char_count"]) if (block.arguments[key] === null) {
								const label = `${block.name}.${key}`;
								m.nullOptionalArguments[label] = (m.nullOptionalArguments[label] ?? 0) + 1;
							}
							if (block.name === "session_read") {
								m.readSnapshotCopies[lastSnapshot === undefined ? "unknown" : block.arguments.snapshot === lastSnapshot ? "exact" : "different"]++;
								const shape = readArgumentShape(block.arguments);
								m.readArgumentShapes[shape] = (m.readArgumentShapes[shape] ?? 0) + 1;
							}
						}
					}
					if (m.toolCalls > o.maxToolCalls || m.modelCalls > o.maxToolCalls + 2 || totalEstimatedCost > 5 || failed) {
						failed ??= totalEstimatedCost > 5 ? "cost_budget_exhausted" : "phase_budget_exhausted";
						void c.abort().catch(() => {});
					}
				}
				if (event.type === "tool_execution_end") {
					if (event.isError) {
						m.toolErrors++;
						const category = classifyToolError(resultText(event.result));
						m.errorCategories[category] = (m.errorCategories[category] ?? 0) + 1;
						m.errorTools[event.toolName] = (m.errorTools[event.toolName] ?? 0) + 1;
					}
					for (const block of event.result?.content ?? []) if (block.type === "text") m.toolOutputBytes += Buffer.byteLength(block.text);
					if (event.toolName === "session_grep" && !event.isError) lastSnapshot = resultText(event.result).match(/Snapshot: (v3:\d+:[a-f0-9]{64})/)?.[1];
				}
			});
			const start = performance.now();
			try {
				await c.promptAndWait(text, undefined, o.timeoutSeconds * 1000);
				if (failed) throw new Failure(failed);
				return { metrics: m, answer: await c.getLastAssistantText() ?? "" };
			} catch (error) {
				throw new Failure(failed ?? (error instanceof Failure ? error.code : "phase_runtime_failure"), m);
			} finally { m.elapsedMs = Math.round(performance.now() - start); unsubscribe(); unsubscribeResult(); }
		};
		if (o.suite === "mixed-v2" || o.scope === "lifecycle") {
			for (const [index, { repeat, data }] of plan.entries()) {
				const row: Record<string, any> = { trial: index + 1, repeat };
				report.trials.push(row);
				const conditions = o.previousExtension
					? [{ name: "baseline", extension: undefined }, { name: "previous_history", extension: o.previousExtension }, { name: "history", extension: resolve(import.meta.dir, "../index.ts") }]
					: [{ name: "baseline", extension: undefined }, { name: "history", extension: resolve(import.meta.dir, "../index.ts") }];
				for (let i = 0; i < (repeat - 1) % conditions.length; i++) conditions.push(conditions.shift()!);
				await executeTask(row, join(root, String(index)), data, conditions, o.scope, {
					launch, empty: emptyMetrics, save,
					stop: async agent => { await agent.c.stop(); clients.delete(agent.c); },
					phase: async (c, text, gold, groups = {}) => {
						try {
							const result = await prompt(c, text);
							return { ...result.metrics, completed: true, score: score(result.answer, gold), assessment: assess(result.answer, gold), assessmentGroups: Object.fromEntries(Object.entries(groups).map(([name, fields]) => [name, assess(result.answer, Object.fromEntries(fields.map(f => [f, gold[f]])))])) };
						} catch (error) {
							if (!(error instanceof Failure) || !error.metrics) throw error;
							if (error.code === "model_mismatch" || error.code === "cost_budget_exhausted") {
								report.terminalPhase = { ...error.metrics, completed: false, failure: error.code, score: score("", gold) };
								throw error;
							}
							return { ...error.metrics, completed: false, failure: error.code, score: score("", gold), assessment: assess("", gold) };
						}
					},
					compact: async c => {
						const before = new Set((await c.getEntries()).entries.map(e => e.id));
						const start = performance.now();
						await bounded(c.compact(), o.timeoutSeconds * 1000);
						const metrics = emptyMetrics(); metrics.elapsedMs = Math.round(performance.now() - start);
						for (const entry of (await c.getEntries()).entries) {
							if (entry.type !== "model_usage" || before.has(entry.id)) continue;
							if (`${entry.provider}/${entry.model}` !== o.model) throw new Failure("compaction_model_mismatch");
							metrics.modelCalls++; addUsage(metrics, entry.usage); totalEstimatedCost += entry.usage.cost.total;
						}
						if (totalEstimatedCost > 5) throw new Failure("cost_budget_exhausted");
						return { metrics, context: await c.getMessages() };
					},
				});
				await save();
			}
		} else {
		for (let trial = 0; trial < o.trials; trial++) {
			console.log(`Trial ${trial + 1}/${o.trials}: seed investigation`);
			const data = fixture(`${o.seed}/${trial}`);
			const trialDir = join(root, String(trial));
			const work = join(trialDir, "work");
			await writeFixture(work, data);
			const seed = await launch(join(trialDir, "seed"), work, false);
			const initial = await prompt(seed.c, data.prompt);
			const row: Record<string, unknown> = { trial: trial + 1, fixtureSha256: data.sha256, fixtureFiles: Object.keys(data.files).length, fixtureBytes: data.bytes, initialPromptBytes: Buffer.byteLength(data.prompt), seed: { ...initial.metrics, score: score(initial.answer, data.gold) }, eligible: false, arms: {} };
			report.trials.push(row);
			await save();
			if (!score(initial.answer, data.gold).allCorrect) { row.ineligibleReason = "seed_answer_incorrect"; await seed.c.stop(); clients.delete(seed.c); continue; }
			await seed.c.promptAndWait("/bench_pad", undefined, 30_000);
			const priorEntries = new Set((await seed.c.getEntries()).entries.map(e => e.id));
			const compactStart = performance.now();
			await bounded(seed.c.compact(), o.timeoutSeconds * 1000);
			row.compactionMs = Math.round(performance.now() - compactStart);
			const compactUsage = emptyMetrics();
			compactUsage.elapsedMs = row.compactionMs as number;
			for (const entry of (await seed.c.getEntries()).entries) {
				if (entry.type !== "model_usage" || priorEntries.has(entry.id)) continue;
				if (`${entry.provider}/${entry.model}` !== o.model) throw new Failure("compaction_model_mismatch");
				compactUsage.modelCalls++;
				addUsage(compactUsage, entry.usage);
				totalEstimatedCost += entry.usage.cost.total;
			}
			row.compactionUsage = compactUsage;
			if (totalEstimatedCost > 5) throw new Failure("budget_exhausted");
			const context = await seed.c.getMessages();
			const missing = missingFacts(context, data.gold);
			row.missingFields = missing;
			row.compactedContextBytes = Buffer.byteLength(JSON.stringify(context));
			if (missing.length !== keys.length) { row.ineligibleReason = "facts_retained_in_compacted_context"; await seed.c.stop(); clients.delete(seed.c); await save(); continue; }
			await seed.c.promptAndWait("/bench_status", undefined, 30_000);
			const status = JSON.parse(await readFile(join(seed.dir, "status.json"), "utf8")) as { sessionFile: string };
			const serialized = await readFile(status.sessionFile, "utf8");
			await seed.c.stop(); clients.delete(seed.c);
			const contextHash = digest(context);
			row.compactedContextSha256 = contextHash;
			row.eligible = true;
			const arms = row.arms as Record<string, unknown>;
			const conditions = o.previousExtension
				? [{ name: "baseline", extension: undefined }, { name: "previous_history", extension: o.previousExtension }, { name: "history", extension: resolve(import.meta.dir, "../index.ts") }]
				: (trial % 2 === 0 ? [true, false] : [false, true]).map(history => ({ name: history ? "history" : "baseline", extension: history ? resolve(import.meta.dir, "../index.ts") : undefined }));
			if (o.previousExtension) for (let i = 0; i < trial % 3; i++) conditions.push(conditions.shift()!);
			row.armOrder = conditions.map(c => c.name);
			for (const { name, extension } of conditions) {
				const history = extension !== undefined;
				console.log(`Trial ${trial + 1}/${o.trials}: ${name} follow-up`);
				const dir = join(trialDir, name);
				await mkdir(dir, { recursive: true });
				const lines = serialized.trimEnd().split("\n");
				const header = JSON.parse(lines[0]); header.id = randomUUID(); header.cwd = work;
				lines[0] = JSON.stringify(header);
				const session = join(dir, "session.jsonl");
				await writeFile(session, `${lines.join("\n")}\n`, { mode: 0o600 });
				const arm = await launch(dir, work, history, session, extension);
				const restored = await arm.c.getMessages();
				if (digest(restored) !== contextHash || missingFacts(restored, data.gold).length !== keys.length) throw new Failure("restored_context_mismatch");
				try {
					const result = await prompt(arm.c, data.question);
					arms[name] = { ...result.metrics, completed: true, score: score(result.answer, data.gold), activeTools: arm.status.activeTools };
				} catch (error) {
					if (!(error instanceof Failure) || !error.metrics || error.code === "model_mismatch" || error.code === "cost_budget_exhausted") throw error;
					arms[name] = { ...error.metrics, completed: false, failure: error.code, score: score("", data.gold), activeTools: arm.status.activeTools };
				}

				await arm.c.stop(); clients.delete(arm.c);
				const unchanged = await Promise.all(Object.entries(data.files).map(async ([name, text]) => await readFile(join(work, name), "utf8") === text));
				if (unchanged.some(equal => !equal)) throw new Failure("fixture_changed");
				await save();
			}
		}
		}
		await save();
		console.log(`Aggregate report: ${o.output}`);
	} catch (error) {
		report.failure = error instanceof Failure ? error.code : "runtime_failure_diagnostics_suppressed";
		await save();
		throw new Failure(report.failure);
	} finally {
		await Promise.allSettled([...clients].map(c => c.stop()));
		await broker?.close(); auth?.close();
		await rm(root, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	try {
		if (process.argv.includes("--help")) console.log("Usage: bun run bench --model provider/model [--trials 3] [--compaction controlled|natural] [--seed public-id] [--timeout-seconds 180] [--output report.json] [--previous-extension path/index.ts] [--suite linked-registry-v1|mixed-v2] [--scope followup|lifecycle] [--max-tool-calls 16] (--dry-run | --allow-model-calls)\nSee bench/README.md for protocol, cost and safety caveats.");
		else await main(options(process.argv.slice(2)));
	}
	catch (error) {
		console.error(error instanceof Failure ? `Benchmark failed: ${error.code}` : "Invalid benchmark options or runtime failure. Use --model provider/model and --allow-model-calls (or --dry-run).");
		process.exitCode = 1;
	}
}
