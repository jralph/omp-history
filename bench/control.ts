// Benchmark-only controller: never loaded by the package's extension manifest.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { resolve, relative, isAbsolute } from "node:path";
import { summary, tail } from "./fixture";
import { mixedSummary } from "./scenarios";

export function permittedPath(root: string, value: unknown): boolean {
	if (typeof value !== "string" || value.startsWith("~") || /^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
	const rel = relative(root, resolve(root, value));
	return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

export default function control(pi: ExtensionAPI) {
	const root = resolve(process.env.OMP_BENCH_CWD ?? "/__missing_benchmark_root__");
	const history = process.env.OMP_BENCH_HISTORY === "1";
	const allowed = ["read", "grep", "glob", ...(history ? ["session_grep", "session_read"] : [])];
	pi.on("session_start", async () => { await pi.setActiveTools(allowed); });
	pi.on("tool_call", event => {
		if (!allowed.includes(event.toolName)) return { block: true, reason: "Benchmark permits only read-only fixture and active-session history tools." };
		if (event.toolName.startsWith("session_")) return;
		const input = event.input as Record<string, unknown>;
		if (!permittedPath(root, input.path ?? ".") || (event.toolName === "glob" && !permittedPath(root, input.pattern ?? "*"))) {
			return { block: true, reason: "Benchmark file access is confined to its synthetic fixture directory." };
		}
	});
	pi.registerCommand("bench_status", {
		description: "Harness-only tool-isolation check (no model call)",
		handler: async (_args, ctx) => {
			const active = pi.getActiveTools().sort();
			if (JSON.stringify(active) !== JSON.stringify([...allowed].sort())) throw new Error("Benchmark tool isolation failed");
			await Bun.write(process.env.OMP_BENCH_STATUS_FILE!, JSON.stringify({ activeTools: active, sessionFile: ctx.sessionManager.getSessionFile() }));
		},
	});
	pi.registerCommand("bench_pad", {
		description: "Harness-only retained-tail preparation (no model call)",
		handler: async (_args, ctx) => {
			const messages = ctx.sessionManager.getBranch().filter(e => e.type === "message");
			const result = await ctx.newSession({ setup: async manager => {
				for (const entry of messages) {
					const message = entry.message;
					if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") await manager.appendMessage(message);
				}
				await manager.appendMessage({ role: "user", content: tail, timestamp: Date.now() });
			} });
			if (result.cancelled) throw new Error("Benchmark preparation cancelled");
		},
	});
	pi.on("session_before_compact", event => {
		if (process.env.OMP_BENCH_COMPACTION !== "controlled") return;
		const kept = [...event.branchEntries].reverse().find(e => e.type === "message" && e.message.role === "user" && e.message.content === tail);
		if (!kept) return { cancel: true };
		return { compaction: { summary: process.env.OMP_BENCH_SUITE === "mixed-v2" ? mixedSummary : summary, firstKeptEntryId: kept.id, tokensBefore: event.preparation.tokensBefore } };
	});
}
