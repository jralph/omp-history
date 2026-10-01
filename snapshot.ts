import { createHash } from "node:crypto";
import type { Transcript } from "./transcript";

/** Content-addressed reference: valid across appends/restarts, never across sessions or prefix rewrites. */
export function snapshotId(sessionId: string, transcript: Transcript): string {
 const hash = createHash("sha256").update(`session-history-v2\0${sessionId}\0`);
 for (const line of transcript.lines) hash.update(`${Buffer.byteLength(line)}:`).update(line);
 return `${transcript.lines.length}:${hash.digest("hex")}`;
}

export function validateSnapshot(sessionId: string, transcript: Transcript, token: string): Transcript {
 const match = typeof token === "string" && /^(0|[1-9]\d{0,6}):[a-f0-9]{64}$/.exec(token);
 const count = match ? Number(match[1]) : -1;
 if (count < 0 || count > transcript.lines.length) throw new Error("Invalid or stale history reference. Run session_grep again.");
 const prefix = { lines: transcript.lines.slice(0, count) };
 if (snapshotId(sessionId, prefix) !== token) throw new Error("Session or transcript changed. Run session_grep again.");
 return prefix;
}
