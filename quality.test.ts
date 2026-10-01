import { expect, test } from "bun:test";
import { buildTranscript, grepTranscript, readTranscript, MAX_READ_BYTES, MAX_TRANSCRIPT_BYTES, MAX_TRANSCRIPT_LINES, validateReadRequest } from "./transcript";
import { parseSnapshot, snapshotId, validateSnapshot } from "./snapshot";

const message = (m: unknown, id = "a", timestamp?: string) => ({ type: "message", id, timestamp, message: m });

test("success, failure, cancellation, and truncation are retained as evidence", () => {
	const transcript = buildTranscript([
		message({ role: "toolResult", toolName: "deploy", isError: false, content: "attempted" }, "ok"),
		message({ role: "toolResult", toolName: "deploy", isError: true, content: "attempted" }, "failed"),
		message({ role: "bashExecution", command: "deploy", output: "attempted", exitCode: 7, cancelled: false, truncated: true }, "bash"),
		message({ role: "pythonExecution", code: "deploy()", output: "attempted", exitCode: 0, cancelled: true, truncated: false }, "python"),
	]);
	const text = transcript.lines.join("\n");
	expect(text).toContain("status=success");
	expect(text).toContain("status=error");
	expect(text).toContain("exit=7; truncated=true");
	expect(text).toContain("status=cancelled; exit=0");
	const missing = buildTranscript([message({ role: "toolResult", toolName: "deploy", content: "attempted" })]);
	expect(missing.lines[0]).toContain("status=unknown");
});

test("timestamps, provenance and summary distinction reach search and read output", () => {
	const transcript = buildTranscript([
		message({ role: "user", content: "needle" }, "a", "2026-01-01T00:00:00Z"),
		{ type: "compaction", id: "b", summary: "needle summary" },
	]);
	const found = grepTranscript(transcript, "needle", 30);
	expect(found.ok).toBe(true);
	if (found.ok) {
		expect(found.matches.join("\n")).toContain("@2026-01-01T00:00:00Z");
		expect(found.matches.join("\n")).toContain("not verbatim");
		expect(found.hits[0]!.source?.entryId).toBe("a");
	}
	const read = readTranscript(transcript, 2, 2);
	expect(read.ok && read.lines.join("\n")).toContain("Source: [user a @2026-01-01T00:00:00Z]");
	expect(read.ok && read.lines.join("\n")).toContain("not verbatim");
});

test("Unicode case expansion maps preview and columns back to original text", () => {
	const line = "İ".repeat(300) + "😀needle" + "界".repeat(300);
	const found = grepTranscript({ lines: [line] }, "NEEDLE", 30);
	expect(found.ok).toBe(true);
	if (found.ok) {
		expect(found.matches[0]).toContain("😀needle");
		expect(found.matches[0]).not.toContain("\ufffd");
		expect(found.hits[0]!.startColumn).toBe(302);
		expect(found.hits[0]!.endColumn).toBe(307);
	}
	const astral = grepTranscript({ lines: ["😀".repeat(150) + "NEEDLE" + "😀".repeat(150)] }, "needle", 30);
	expect(astral.ok && astral.matches[0]).not.toContain("\ufffd");
	const dotted = grepTranscript({ lines: ["İ"] }, "i", 30);
	expect(dotted.ok && dotted.hits[0]!.startColumn).toBe(1);
});

test("kind filters preserve global line addressing and context stays within its entry", () => {
	const transcript = buildTranscript([
		message({ role: "assistant", content: "unrelated private-to-filter context" }, "a"),
		message({ role: "user", content: "before\nneedle\nafter" }, "b"),
		message({ role: "toolResult", toolName: "read", content: "needle", isError: false }, "c"),
	]);
	const found = grepTranscript(transcript, "needle", 30, undefined, { kind: "user", context_lines: 3 });
	expect(found.ok).toBe(true);
	if (found.ok) {
		expect(found.hits).toHaveLength(1);
		expect(found.hits[0]!.line).toBe(5);
		expect(found.matches[0]).toContain("before");
		expect(found.matches[0]).toContain("after");
		expect(found.matches[0]).not.toContain("unrelated");
		expect(found.matches[0]).not.toContain("tool result");
	}
	expect(grepTranscript(transcript, "needle", 30, undefined, { kind: "invalid" as never }).ok).toBe(false);
	expect(grepTranscript(transcript, "needle", 30, undefined, { context_lines: 4 }).ok).toBe(false);
});

test("same-entry context is fail-closed at the shared transcript-line and byte budgets", () => {
	const transcript = buildTranscript([message({ role: "user", content: Array(20).fill("needle").join("\n") })]);
	const found = grepTranscript(transcript, "needle", 30, undefined, { context_lines: 3 });
	expect(found.ok).toBe(false);
	if (!found.ok) expect(found.error).toContain("50 transcript-line");
	const bytes = buildTranscript([message({ role: "user", content: Array(30).fill("needle" + "界".repeat(250)).join("\n") })]);
	expect(grepTranscript(bytes, "needle", 30).ok).toBe(false);
});

test("long lines have explicit bounded Unicode excerpts, without weakening full-line reads", () => {
	const transcript = { lines: ["😀".repeat(20_000) + "needle" + "界".repeat(20_000)] };
	expect(readTranscript(transcript, 1, 1).ok).toBe(false);
	const found = grepTranscript(transcript, "needle", 30);
	if (!found.ok) throw new Error(found.error);
	const read = readTranscript(transcript, 1, 1, { start_column: found.hits[0]!.startColumn - 1, char_count: 8 });
	expect(read.ok).toBe(true);
	if (read.ok) {
		expect(read.lines.join("\n")).toContain("😀needle界");
		expect(read.lines.join("\n")).toContain("omitted before=true, omitted after=true");
		expect(read.excerpt?.endColumn).toBe(20_007);
	}
	expect(readTranscript(transcript, 1, 1, { start_column: 99_999, char_count: 1 }).ok).toBe(false);
	for (const options of [{ start_column: 0, char_count: 1 }, { start_column: 1 }, { char_count: 1 }, { start_column: 1, char_count: 4097 }]) {
		expect(validateReadRequest(1, 1, options).ok).toBe(false);
	}
	expect(validateReadRequest(1, 2, { start_column: 1, char_count: 1 }).ok).toBe(false);
	expect(readTranscript({ lines: [""] }, 1, 1, { start_column: 1, char_count: 1 }).ok).toBe(true);
});

test("read byte boundary includes line prefixes and fails without partial results", () => {
	const available = MAX_READ_BYTES - 512 - 4; // '1: ' plus newline
	expect(readTranscript({ lines: ["x".repeat(available)] }, 1, 1).ok).toBe(true);
	expect(readTranscript({ lines: ["x".repeat(available + 1)] }, 1, 1).ok).toBe(false);
});

test("rendering rejects oversized input before visiting later entries", () => {
	let touched = false;
	const later = { get type() { touched = true; return "message"; } };
	expect(() => buildTranscript([message({ role: "user", content: "x".repeat(MAX_TRANSCRIPT_BYTES + 1) }), later])).toThrow("safety budget");
	// Reverse scan reads the later entry's type while locating /clear, so use content to test rendering instead.
	expect(touched).toBe(true);
	let contentTouched = false;
	const after = message({ role: "user", get content() { contentTouched = true; return "later"; } });
	expect(() => buildTranscript([message({ role: "user", content: "\n".repeat(MAX_TRANSCRIPT_LINES + 1) }), after])).toThrow("safety budget");
	expect(contentTouched).toBe(false);
});

test("cancellation is checked within an entry, not only between entries", () => {
	const controller = new AbortController();
	const block = { type: "text", get text() { controller.abort(); return "cancelled"; } };
	expect(() => buildTranscript([message({ role: "user", content: [block] })], controller.signal)).toThrow();
});

test("snapshot syntax is strict, format-versioned and differentiates lone UTF-16 surrogates", () => {
	const token = snapshotId("session", { lines: ["\ud800"] });
	expect(() => validateSnapshot("session", { lines: ["\ud801"] }, token)).toThrow("Run session_grep again");
	expect(() => parseSnapshot("1:" + "a".repeat(64))).toThrow("Run session_grep again");
	for (const invalid of ["v3:01:" + "a".repeat(64), "v3:1000001:" + "a".repeat(64), "v3:1:" + "A".repeat(64), token + "\n"]) {
		expect(() => parseSnapshot(invalid)).toThrow("Run session_grep again");
	}
	expect(parseSnapshot(snapshotId("session", { lines: [] }))).toBe(0);
	const splitPair = "x".repeat(4095) + "😀";
	expect(validateSnapshot("session", { lines: [splitPair] }, snapshotId("session", { lines: [splitPair] })).lines).toEqual([splitPair]);
});

test("clear boundaries invalidate even empty-prefix snapshots", () => {
	const old = snapshotId("session", { lines: [] });
	expect(() => validateSnapshot("session", { lines: [], boundaryId: "clear" }, old)).toThrow("Run session_grep again");
});
