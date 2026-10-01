import { expect, test } from "bun:test";
import { snapshotId, validateSnapshot } from "./snapshot";
test("snapshot survives appends, reload and compaction appended to history", () => {
 const old = {lines:["user", "original"]};
 const token = snapshotId("session-a", old);
 expect(validateSnapshot("session-a", {lines:[...old.lines,"new","summary"]},token)).toEqual(old);
});
test("rejects wrong session, changed prefix, invalid or shorter transcript", () => {
 const token = snapshotId("session-a", {lines:["original"]});
 for(const [session,lines,ref] of [
  ["session-b",["original"],token], ["session-a",["rewritten"],token],
  ["session-a",[],token], ["session-a",["original"],"invalid"],
 ] as const) expect(() => validateSnapshot(session,{lines:[...lines]},ref)).toThrow("Run session_grep again");
});
