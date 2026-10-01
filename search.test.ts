import { expect, test } from "bun:test";
import { buildTranscript, grepTranscript, validateGrep } from "./transcript";
const entry = (id: string, role: string, content: string) => ({ type: "message", id, message: { role, content } });

test("all_of narrows by literal anchors in the same entry, preserving global lines", () => {
	const t = buildTranscript([
		entry("request", "user", "cache migration\nplease investigate rollback"),
		entry("other", "assistant", "cache migration\nno final decision"),
		entry("answer", "assistant", "CACHE migration\nDecision\nrollback: pinned policy\nowner: Team A"),
	]);
	const g = grepTranscript(t, "cache migration", 30, undefined, { kind: "assistant", all_of: ["ROLLBACK", "Team A"] });
	expect(g.ok).toBe(true);
	if (!g.ok) return;
	expect(g.hits).toHaveLength(1);
	expect(g.hits[0].source?.entryId).toBe("answer");
	expect(g.hits[0].entryStartLine).toBe(7);
	expect(g.hits[0].entryEndLine).toBe(11);
	expect(g.hits[0].line).toBe(8);
	expect(g.matches[0]).toContain("entry lines 7–11");
	expect(t.lines[g.hits[0].line - 1]).toBe("CACHE migration");
});

test("anchors cannot cross entries, reused IDs, clear boundaries, or hidden content", () => {
	const t = buildTranscript([
		entry("same", "assistant", "needle"), entry("same", "assistant", "rollback"),
		{ type: "message", id: "private", message: { role: "custom", display: false, content: "needle rollback" } },
	]);
	const g = grepTranscript(t, "needle", 30, undefined, { all_of: ["rollback"] });
	expect(g.ok && g.hits.length).toBe(0);
	const cleared = buildTranscript([entry("old", "user", "needle rollback"), { type: "reset_boundary", id: "clear" }, entry("new", "user", "needle")]);
	expect(grepTranscript(cleared, "needle", 30, undefined, { all_of: ["rollback"] })).toMatchObject({ ok: true, hits: [] });
	expect(grepTranscript({ lines: ["needle", "rollback"] }, "needle", 30, undefined, { all_of: ["rollback"] })).toMatchObject({ ok: true, hits: [] });
});

test("anchor syntax remains literal, Unicode-aware, and whitespace preserving", () => {
	const t = buildTranscript([entry("a", "user", "needle\na*b [x] İSTANBUL\n spaced anchor ")]);
	expect(grepTranscript(t, "needle", 30, undefined, { all_of: ["a*b [x]", "i̇stanbul", " spaced anchor "] })).toMatchObject({ ok: true, hits: [{ line: 2 }] });
	expect(grepTranscript(t, "needle", 30, undefined, { all_of: ["a.*b"] })).toMatchObject({ ok: true, hits: [] });
});

test("invalid anchors are rejected before rendering/search; existing limits still fail closed", () => {
	for (const all_of of [[], [""], [" "], ["a\nb"], ["x".repeat(257)], ["a", "b", "c", "d"], null, "not-an-array", [1]]) {
		expect(validateGrep("needle", 30, { all_of: all_of as string[] }).ok).toBe(false);
	}
	const t = buildTranscript([entry("a", "user", "rollback\n" + Array(31).fill("needle").join("\n"))]);
	expect(grepTranscript(t, "needle", 30, undefined, { all_of: ["rollback"] })).toMatchObject({ ok: false });
	const wide = buildTranscript(Array.from({length:20}, (_, i) => entry(`wide-${i}`, "user", "needle" + "💥".repeat(250) + "\nanchor")));
	const overBudget = grepTranscript(wide, "needle", 30, undefined, {all_of:["anchor"]});
	expect(overBudget).toMatchObject({ok:false});
	expect("matches" in overBudget).toBe(false);
	const controller = new AbortController(); controller.abort();
	expect(() => grepTranscript(t, "needle", 30, controller.signal, { all_of: ["rollback"] })).toThrow();
});
