import { expect, test } from "bun:test";
import type { SessionManager as RuntimeSessionManager } from "@oh-my-pi/pi-coding-agent";
import { MAX_GREP_BYTES, MAX_READ_BYTES } from "./transcript";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Pinned development runtime by default; override to verify another installation.
const root = process.env.OMP_PACKAGE_ROOT ?? dirname(dirname(fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent"))));
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

const { SessionManager } = await import(join(root, "src/session/session-manager.ts"));
function realTool(name: string, manager: RuntimeSessionManager) {
 return new RegisteredToolAdapter(loaded.extensions[0].tools.get(name), { createContext: () => ({ sessionManager: manager }) });
}
test("real in-memory session: active branches, compaction, appends, and clear boundaries", async () => {
 const manager: RuntimeSessionManager = SessionManager.inMemory("/tmp/omp-history-synthetic");
 const first = manager.appendMessage({role:"user",content:"original needle",timestamp:1});
 manager.appendMessage({role:"user",content:"abandoned-only",timestamp:2});
 manager.branch(first);
 manager.appendMessage({role:"user",content:"active-only",timestamp:3});
 const grep = realTool("session_grep", manager);
 const read = realTool("session_read", manager);
 expect((await grep.execute("call",{query:"abandoned-only"})).details.matchCount).toBe(0);
 const found = await grep.execute("call",{query:"needle",kind:"user"});
 const snapshot = found.details.snapshot;
 const line = found.details.hits[0].line;
 manager.appendCompaction("non-verbatim summary",undefined,first,100);
 expect((await grep.execute("call",{query:"needle"})).details.matchCount).toBe(1);
 expect((await read.execute("call",{snapshot,start_line:line})).content[0].text).toContain("original needle");
 manager.appendResetBoundary();
 manager.appendMessage({role:"user",content:"fresh needle",timestamp:4});
 expect((await grep.execute("call",{query:"original needle"})).details.matchCount).toBe(0);
 await expect(read.execute("call",{snapshot,start_line:line})).rejects.toThrow("Run session_grep again");
 expect((await grep.execute("call",{query:"fresh needle"})).details.matchCount).toBe(1);
 expect(manager.getSessionFile()).toBeUndefined();
});
test("real session branch divergence rejects references and no provider data leaks", async () => {
 const manager: RuntimeSessionManager = SessionManager.inMemory("/tmp/omp-history-synthetic");
 const first = manager.appendMessage({role:"user",content:"first",timestamp:1});
 manager.appendMessage({role:"user",content:"old needle",timestamp:2});
 const found = await realTool("session_grep",manager).execute("call",{query:"needle"});
 manager.branch(first);
 manager.appendMessage({role:"user",content:"new needle",timestamp:3});
 await expect(realTool("session_read",manager).execute("call",{snapshot:found.details.snapshot,start_line:found.details.hits[0].line})).rejects.toThrow("Run session_grep again");
 manager.appendMessage({role:"custom",customType:"hidden",display:false,content:"PRIVATE_SENTINEL",details:{secret:"PRIVATE_SENTINEL"},timestamp:4});
 manager.appendMessage({role:"bashExecution",command:"PRIVATE_SENTINEL",output:"PRIVATE_SENTINEL",excludeFromContext:true,exitCode:0,cancelled:false,truncated:false,timestamp:5});
 manager.appendCustomEntry("hidden-state",{secret:"PRIVATE_SENTINEL"});
 expect((await realTool("session_grep",manager).execute("call",{query:"PRIVATE_SENTINEL"})).details.matchCount).toBe(0);
});
test("malformed references and read options fail before accessing the branch", async () => {
 let calls = 0;
 const registered = loaded.extensions[0].tools.get("session_read");
 const read = new RegisteredToolAdapter(registered,{createContext:()=>({sessionManager:{getBranch:()=>{calls++;throw new Error("must not access branch")}}})});
 for (const params of [
  {snapshot:"bad",start_line:1,line_count:1},
  {snapshot:"bad",start_line:1,line_count:1,start_column:1},
  {snapshot:"bad",start_line:1_000_001,line_count:1},
 ]) await expect(read.execute("call",params)).rejects.toThrow();
 expect(calls).toBe(0);
});
test("actual OMP schemas accept optional parameters and reject invalid values", () => {
 const grep = loaded.extensions[0].tools.get("session_grep").definition.parameters;
 const read = loaded.extensions[0].tools.get("session_read").definition.parameters;
 expect(grep.safeParse({query:"needle"}).success).toBe(true);
 expect(grep.safeParse({query:"needle",kind:"user",context_lines:3}).success).toBe(true);
 expect(grep.safeParse({query:"needle",kind:"unknown"}).success).toBe(false);
 expect(grep.safeParse({query:"needle",context_lines:4}).success).toBe(false);
 const snapshot = "v3:0:"+"a".repeat(64);
 expect(read.safeParse({snapshot,start_line:1}).success).toBe(true);
 expect(read.safeParse({snapshot,start_line:1,line_count:1,start_column:1,char_count:4096}).success).toBe(true);
 expect(read.safeParse({snapshot,start_line:1,line_count:51}).success).toBe(false);
 expect(read.safeParse({snapshot,start_line:1,char_count:4097}).success).toBe(false);
});
test("tool-level context and character excerpts stay within complete output budgets", async () => {
 const manager: RuntimeSessionManager = SessionManager.inMemory("/tmp/omp-history-synthetic");
 manager.appendMessage({role:"user",content:"before\n"+"😀".repeat(20_000)+"needle"+"界".repeat(20_000)+"\nafter",timestamp:1});
 const found = await realTool("session_grep",manager).execute("call",{query:"needle",context_lines:1});
 expect(Buffer.byteLength(found.content[0].text)).toBeLessThanOrEqual(MAX_GREP_BYTES);
 expect(found.content[0].text).toContain("before");
 const hit = found.details.hits[0];
 const read = await realTool("session_read",manager).execute("call",{snapshot:found.details.snapshot,start_line:hit.line,start_column:hit.startColumn,char_count:4096});
 expect(Buffer.byteLength(read.content[0].text)).toBeLessThanOrEqual(MAX_READ_BYTES);
 expect(read.details.lineCount).toBe(1);
 expect(read.content[0].text).toContain("needle");
 expect(read.content[0].text).toContain("omitted after=true");
});
