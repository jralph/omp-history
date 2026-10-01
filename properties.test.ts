import { expect, test } from "bun:test";
import { buildTranscript, grepTranscript, readTranscript, MAX_GREP_BYTES, MAX_READ_BYTES } from "./transcript";
import { snapshotId, validateSnapshot } from "./snapshot";

test("500 deterministic mixed-Unicode fixtures preserve lines, matches, snapshots and budgets", () => {
	let state = 42;
	const rand = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
	const tokens = ["a", "B", "界", "😀", "\r", "\n", "\r\n", " ", "İ"];
	for (let sample = 0; sample < 500; sample++) {
		const content = Array.from({ length: rand() % 200 }, () => tokens[rand() % tokens.length]!).join("");
		const transcript = buildTranscript([{ type: "message", id: "fixed", message: { role: "user", content } }]);
		const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
		expect(transcript.lines.slice(1)).toEqual((normalized || "[no text content]").split("\n"));
		const token = snapshotId("session", transcript);
		expect(validateSnapshot("session", { ...transcript, lines: [...transcript.lines, "append"] }, token).lines).toEqual(transcript.lines);
		expect(() => validateSnapshot("other", transcript, token)).toThrow("Run session_grep again");
		const query = ["a", "界", "😀", "İ"][rand() % 4]!;
		const grep = grepTranscript(transcript, query, 30);
		if (grep.ok) {
			expect(grep.matches.length).toBeLessThanOrEqual(30);
			expect(Buffer.byteLength(grep.matches.join("\n"))).toBeLessThan(MAX_GREP_BYTES);
			const expected = transcript.lines.flatMap((line, i) => line.toLowerCase().includes(query.toLowerCase()) ? [i + 1] : []);
			expect(grep.hits.map(hit => hit.line)).toEqual(expected);
			for (const hit of grep.hits) {
				const excerpt = readTranscript(transcript, hit.line, 1, { start_column: hit.startColumn, char_count: hit.endColumn - hit.startColumn + 1 });
				expect(excerpt.ok).toBe(true);
				if (excerpt.ok) {
					const text = excerpt.lines.at(-1)!.slice(`${hit.line}: `.length);
					expect(text.toLowerCase()).toContain(query.toLowerCase());
				}
			}
		}
		const start = 1 + rand() % transcript.lines.length;
		const count = 1 + rand() % 50;
		const read = readTranscript(transcript, start, count);
		expect(read.ok).toBe(true);
		if (read.ok) {
			expect(read.lines.filter(line => /^\d+:/.test(line)).length).toBe(Math.min(count, transcript.lines.length - start + 1));
			expect(Buffer.byteLength(read.lines.join("\n"))).toBeLessThan(MAX_READ_BYTES);
		}
	}
});
