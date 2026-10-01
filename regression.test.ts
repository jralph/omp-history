import { expect, test } from "bun:test";
import { buildTranscript, grepTranscript, readTranscript } from "./transcript";
const message = (m: unknown) => ({ type: "message", id: "a", message: m });

test("never exposes !!/$$ output or hidden custom continuity messages", () => {
 const t = buildTranscript([
  message({ role: "bashExecution", command: "secret", output: "private", excludeFromContext: true }),
  message({ role: "pythonExecution", code: "secret", output: "private", excludeFromContext: true }),
  message({ role: "custom", display: false, content: "hidden thinking" }),
  { type: "custom_message", id: "b", display: false, content: "hidden thinking" },
 ]);
 expect(t.lines).toEqual([]);
});
test("keeps natural text lines, including search terms crossing old wrapping boundary", () => {
 const text = "x".repeat(497) + "needle😀";
 const t = buildTranscript([message({ role: "user", content: text })]);
 expect(t.lines).toEqual(["[user a]", text]);
 expect(grepTranscript(t, "needle😀", 30).ok).toBe(true);
 const result = grepTranscript(t, "needle😀", 30);
 if(result.ok) expect(result.matches).toHaveLength(1);
});
test("grep errors on UTF-8 output budget even below match-count limit", () => {
 const result = grepTranscript({ lines: Array(30).fill("界".repeat(250)) }, "界", 30);
 expect(result.ok).toBe(false);
 if(!result.ok) expect(result.error).toContain("too broad");
});
test("visible array-form custom content and file mentions are searchable", () => {
 const t = buildTranscript([
  { type: "custom_message", id: "b", display: true, content: [{type:"text", text:"remember me"}] },
  message({role:"fileMention", files:[{path:"old.ts",content:"original file contents"}]}),
 ]);
 expect(t.lines.join("\n")).toContain("remember me");
 expect(t.lines.join("\n")).toContain("original file contents");
});
test("preserves assistant text/tool-call ordering", () => {
 const t = buildTranscript([message({role:"assistant",content:[
  {type:"text",text:"before"}, {type:"toolCall",name:"read",arguments:{path:"a"}}, {type:"text",text:"after"}
 ]})]);
 expect(t.lines).toEqual(["[assistant a]","before",'Tool call: read {"path":"a"}',"after"]);
});
test("preserves literal whitespace, rejects invalid queries and oversized natural line reads", () => {
 const t = {lines:["x abc y", "abc", "z".repeat(40000)]};
 const found = grepTranscript(t," abc ",30);
 expect(found.ok && found.matches.length).toBe(1);
 expect(grepTranscript(t,"x".repeat(257),30).ok).toBe(false);
 expect(grepTranscript(t,"a\nb",30).ok).toBe(false);
 expect(readTranscript(t,3,1).ok).toBe(false);
});
