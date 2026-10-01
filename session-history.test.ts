import { describe, expect, test } from "bun:test";
import { buildTranscript, grepTranscript, readTranscript } from "./transcript";

const entries = [
	{
		type: "message",
		id: "user0001",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: "Find the authentication regression", timestamp: 1 },
	},
	{
		type: "message",
		id: "assistant",
		parentId: "user0001",
		timestamp: "2026-01-01T00:00:01.000Z",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "This must never be exposed." },
				{ type: "text", text: "The regression is in auth.ts." },
				{ type: "toolCall", id: "call1", name: "read", arguments: { path: "auth.ts" } },
			],
			timestamp: 2,
		},
	},
];

describe("session transcript", () => {
	test("renders visible session content but excludes assistant thinking", () => {
		const transcript = buildTranscript(entries);
		const text = transcript.lines.join("\n");

		expect(text).toContain("Find the authentication regression");
		expect(text).toContain("The regression is in auth.ts.");
		expect(text).toContain('read {"path":"auth.ts"}');
		expect(text).not.toContain("This must never be exposed.");
	});

	test("uses natural transcript lines rather than arbitrary wrapping", () => {
		const transcript = buildTranscript([
			{
				type: "message",
				id: "longtext",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: "x".repeat(1_001), timestamp: 1 },
			},
		]);

		expect(transcript.lines).toHaveLength(2); // header + one natural content line
		expect(transcript.lines[1]).toHaveLength(1_001);
	});

	test("omits prior session-history tool calls and results to prevent recursive output", () => {
		const transcript = buildTranscript([
			{
				type: "message",
				id: "historycall",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call", name: "session_grep", arguments: { query: "secret" } }],
					timestamp: 1,
				},
			},
			{
				type: "message",
				id: "historyresult",
				parentId: "historycall",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: {
					role: "toolResult",
					toolName: "session_grep",
					content: [{ type: "text", text: "secret output" }],
					timestamp: 2,
				},
			},
		]);

		expect(transcript.lines).toEqual([]);
	});

	test("rejects broad searches instead of returning partial matches", () => {
		const transcript = { lines: Array.from({ length: 51 }, () => "matching text") };
		const result = grepTranscript(transcript, "matching", 50);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("too broad");
	});

	test("reads only an explicitly bounded transcript range", () => {
		const transcript = { lines: ["one", "two", "three"] };
		const result = readTranscript(transcript, 2, 2);

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.lines).toEqual(["2: two", "3: three"]);
	});

	test("rejects reads whose rendered output would exceed the byte limit", () => {
		const transcript = { lines: Array.from({ length: 50 }, () => "x".repeat(1_000)) };
		const result = readTranscript(transcript, 1, 50);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("bytes");
	});

	test("rejects oversized read requests instead of truncating", () => {
		const transcript = { lines: Array.from({ length: 51 }, () => "x") };
		const result = readTranscript(transcript, 1, 51);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("maximum is 50");
	});
});
