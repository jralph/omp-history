import { createHash } from "node:crypto";
import { MAX_TRANSCRIPT_LINES, type Transcript } from "./transcript";

/** Validate syntax before obtaining/rendering a potentially large branch. */
export function parseSnapshot(token: unknown): number {
	const match = typeof token === "string" && /^v3:(0|[1-9]\d{0,6}):[a-f0-9]{64}$/.exec(token);
	const count = match && match[0] === token ? Number(match[1]) : -1;
	if (count < 0 || count > MAX_TRANSCRIPT_LINES) throw new Error("Invalid or stale history reference. Run session_grep again.");
	return count;
}

/** Encode original UTF-16 code units, including lone surrogates, in bounded chunks. */
export function snapshotId(sessionId: string, transcript: Transcript, signal?: AbortSignal): string {
	const hash = createHash("sha256").update(`session-history-v3\0${JSON.stringify([sessionId, transcript.boundaryId ?? null])}\0`);
	for (const line of transcript.lines) {
		signal?.throwIfAborted();
		hash.update(`${line.length}:`);
		for (let start = 0; start < line.length; start += 4096) {
			signal?.throwIfAborted();
			hash.update(Buffer.from(line.slice(start, start + 4096), "utf16le"));
		}
	}
	return `v3:${transcript.lines.length}:${hash.digest("hex")}`;
}

export function validateSnapshot(sessionId: string, transcript: Transcript, token: string, signal?: AbortSignal): Transcript {
	const count = parseSnapshot(token);
	if (count > transcript.lines.length) throw new Error("Invalid or stale history reference. Run session_grep again.");
	const prefix: Transcript = { lines: transcript.lines.slice(0, count) };
	if (transcript.sources) prefix.sources = transcript.sources.slice(0, count);
	if (transcript.boundaryId !== undefined) prefix.boundaryId = transcript.boundaryId;
	if (snapshotId(sessionId, prefix, signal) !== token) throw new Error("Session or transcript changed. Run session_grep again.");
	return prefix;
}
