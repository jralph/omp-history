import { expect, test } from "bun:test";
import extension from "./index";

test("registers both session tools as read-only OMP tools", () => {
	const tools: Array<Record<string, unknown>> = [];
	const schema = {
		min: () => schema,
		max: () => schema,
		int: () => schema,
		describe: () => schema,
		optional: () => schema,
	};
	extension({
		zod: {
			string: () => schema,
			array: () => schema,
			number: () => schema,
			object: () => schema,
			enum: () => schema,
			optional: () => schema,
		},
		registerTool: (tool: Record<string, unknown>) => tools.push(tool),
	} as never);

	expect(tools.map(tool => tool.name)).toEqual(["session_grep", "session_read"]);
	expect(tools.every(tool => tool.approval === "read")).toBe(true);
	expect(tools.every(tool => typeof tool.execute === "function")).toBe(true);
	for (const tool of tools) {
		expect(tool.description).toContain("specific missing user decision");
		expect(tool.description).toContain("Never browse, paginate to reconstruct history");
		expect(tool.description).toContain("one targeted search and one small read, then stop");
		expect(tool.description).toContain("Use current context first");
		expect(tool.description).toContain("prefer authoritative files");
		expect(tool.description).toContain("one corrected retry cycle");
		expect(tool.description).toContain("verify current state");
		expect(tool.description).toContain("No match is not proof");
		expect(tool.description).toContain("never repeat unchanged failures or guess references");
	}
});
