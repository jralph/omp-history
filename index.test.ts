import { expect, test } from "bun:test";
import extension from "./index";

test("registers both session tools as read-only OMP tools", () => {
	const tools: Array<Record<string, unknown>> = [];
	const schema = {
		min: () => schema,
		max: () => schema,
		int: () => schema,
		describe: () => schema,
	};
	extension({
		zod: {
			string: () => schema,
			number: () => schema,
			object: () => schema,
			optional: () => schema,
		},
		registerTool: (tool: Record<string, unknown>) => tools.push(tool),
	} as never);

	expect(tools.map(tool => tool.name)).toEqual(["session_grep", "session_read"]);
	expect(tools.every(tool => tool.approval === "read")).toBe(true);
	expect(tools.every(tool => typeof tool.execute === "function")).toBe(true);
	for (const tool of tools) {
		expect(tool.description).toContain("specific missing information");
		expect(tool.description).toContain("Do not reread the full session");
		expect(tool.description).toContain("Stop once the missing information is recovered");
		expect(tool.description).toContain("Use available context or the compaction summary first");
		expect(tool.description).toContain("Do not bypass limits");
		expect(tool.description).toContain("Distinguish plans from confirmed actions");
		expect(tool.description).toContain("verify current state");
		expect(tool.description).toContain("No match is not proof");
		expect(tool.description).toContain("never invent missing details");
	}
});
