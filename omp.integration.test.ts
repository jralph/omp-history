import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
// Use the locally installed OMP runtime, not a mock schema builder or provider request.
const root = process.env.OMP_PACKAGE_ROOT ?? join(homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent");
const { loadExtensions } = await import(join(root, "src/extensibility/extensions/loader.ts"));
const { RegisteredToolAdapter } = await import(join(root, "src/extensibility/extensions/wrapper.ts"));
const { discoverExtensionPaths } = await import(join(root, "src/extensibility/extensions/loader.ts"));
const path = join(import.meta.dir,"index.ts");
const loaded = await loadExtensions([path], homedir());
const entry = (text: string, id = "a") => ({type:"message",id,parentId:null,message:{role:"user",content:text}});
let entries = [entry("the missing decision")];
let sessionId = "test-session";
const ctx = { sessionManager: { getBranch: () => entries, getSessionId: () => sessionId } };
function tool(name: string) {
 const registered = loaded.extensions[0].tools.get(name);
 return new RegisteredToolAdapter(registered, {createContext: () => ctx});
}
test("actual OMP loader and adapter register read-only essential tools", () => {
 expect(loaded.errors).toEqual([]);
 for(const registered of loaded.extensions[0].tools.values()) {
  expect(registered.definition.approval).toBe("read");
  expect(registered.definition.loadMode).toBe("essential");
 }
});
test("explicit package discovery loads only the entry point, never test/helper modules", async () => {
 expect(await discoverExtensionPaths([import.meta.dir],homedir(),undefined,{ambient:false})).toEqual([path]);
});
test("grep -> read uses actual OMP invocation order, supports appends, rejects stale sessions", async () => {
 entries = [entry("the missing decision")]; sessionId = "test-session";
 const grep = await tool("session_grep").execute("call",{query:"missing"});
 expect(grep.content[0].text).toContain("2: the missing decision");
 const snapshot = grep.details.snapshot;
 entries.push(entry("later message","b"));
 const read = await tool("session_read").execute("call",{snapshot,start_line:2,line_count:1});
 expect(read.content[0].text).toContain("2: the missing decision");
 expect(read.content[0].text).toContain("EOF");
 sessionId = "another-session";
 await expect(tool("session_read").execute("call",{snapshot,start_line:2,line_count:1})).rejects.toThrow("Run session_grep again");
 sessionId = "test-session";
 entries = [entry("rewritten history")];
 await expect(tool("session_read").execute("call",{snapshot,start_line:2,line_count:1})).rejects.toThrow("Run session_grep again");
});
test("aborted and invalid requests are rejected before building history", async () => {
 const controller = new AbortController(); controller.abort();
 await expect(tool("session_grep").execute("call",{query:"missing"},controller.signal)).rejects.toThrow();
 await expect(tool("session_read").execute("call",{snapshot:"bad",start_line:1,line_count:51})).rejects.toThrow("narrower range");
});
test("OMP adapter gets error, not partial success, for broad grep", async () => {
 entries = [entry(Array(31).fill("repeated").join("\n"))];
 await expect(tool("session_grep").execute("call",{query:"repeated"})).rejects.toThrow("too broad");
});
