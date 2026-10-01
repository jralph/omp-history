export const MAX_GREP_BYTES = 8 * 1024;
export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
export const MAX_READ_LINES = 50;
export const MAX_READ_BYTES = 32 * 1024;

export interface Transcript {
	lines: string[];
}

type Success<T> = { ok: true } & T;
type Failure = { ok: false; error: string };
export type Result<T> = Success<T> | Failure;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
		.map(block => (typeof block.text === "string" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "null";
	} catch {
		return "[unserializable arguments]";
	}
}

function appendText(lines: string[], text: string): void {
	for (const sourceLine of text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
		lines.push(sourceLine);
	}
}

function entryHeader(entry: Record<string, unknown>, label: string): string {
	const id = typeof entry.id === "string" ? entry.id : "unknown";
	return `[${label} ${id}]`;
}

function renderMessage(lines: string[], entry: Record<string, unknown>, message: Record<string, unknown>): void {
	const role = typeof message.role === "string" ? message.role : "unknown";
	if (message.excludeFromContext === true) return;
	if ((role === "custom" || role === "hookMessage") && message.display !== true) return;
	switch (role) {
		case "user":
		case "developer":
		case "custom":
		case "hookMessage": {
			lines.push(entryHeader(entry, role));
			appendText(lines, contentText(message.content) || "[no text content]");
			return;
		}
		case "assistant": {
			const blocks = typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: Array.isArray(message.content) ? message.content : [];
			let hasHeader = false;
			for (const block of blocks) {
				if (!isRecord(block)) continue;
				let text: string | undefined;
				if (block.type === "text" && typeof block.text === "string") text = block.text;
				if (block.type === "toolCall" && block.name !== "session_grep" && block.name !== "session_read") {
					text = `Tool call: ${String(block.name ?? "unknown")} ${safeJson(block.arguments)}`;
				}
				if (!text) continue;
				if (!hasHeader) lines.push(entryHeader(entry, "assistant"));
				hasHeader = true;
				appendText(lines, text);
			}
			return;
		}
		case "toolResult": {
			const toolName = typeof message.toolName === "string" ? message.toolName : "unknown";
			if (toolName === "session_grep" || toolName === "session_read") return;
			lines.push(entryHeader(entry, `tool result: ${toolName}`));
			appendText(lines, contentText(message.content) || "[no text output]");
			return;
		}
		case "bashExecution":
		case "pythonExecution": {
			lines.push(entryHeader(entry, role));
			const command = typeof message.command === "string" ? message.command : message.code;
			if (typeof command === "string") appendText(lines, command);
			if (typeof message.output === "string") appendText(lines, message.output || "[no output]");
			return;
		}
		case "fileMention": {
			lines.push(entryHeader(entry, "file mention"));
			const files = Array.isArray(message.files) ? message.files : [];
			appendText(
				lines,
				files
					.map(file => isRecord(file)
						? `Referenced file: ${String(file.path ?? "unknown")}\n${typeof file.content === "string" ? file.content : "[no text content]"}`
						: "Referenced file")
					.join("\n") || "[no referenced files]",
			);
			return;
		}
	}
}

/** Build a line-addressable, visible-only view of a session branch. */
export function buildTranscript(entries: readonly unknown[], signal?: AbortSignal): Transcript {
	const lines: string[] = [];
	let checked = 0;
	let bytes = 0;
	function checkBudget() {
		signal?.throwIfAborted();
		while (checked < lines.length) bytes += Buffer.byteLength(lines[checked++]!, "utf8") + 1;
		if (bytes > MAX_TRANSCRIPT_BYTES || lines.length > 1_000_000) {
			throw new Error("Session transcript exceeds the local safety budget (64 MiB / 1,000,000 lines); no partial history returned.");
		}
	}
	for (const candidate of entries) {
		checkBudget();
		if (!isRecord(candidate)) continue;
		if (candidate.type === "message" && isRecord(candidate.message)) {
			renderMessage(lines, candidate, candidate.message);
			continue;
		}
		if (candidate.type === "compaction" || candidate.type === "branch_summary") {
			if (typeof candidate.summary !== "string") continue;
			lines.push(entryHeader(candidate, candidate.type === "compaction" ? "compaction summary" : "branch summary"));
			appendText(lines, candidate.summary);
			continue;
		}
		if (candidate.type === "custom_message" && candidate.display === true) {
			lines.push(entryHeader(candidate, "custom message"));
			appendText(lines, contentText(candidate.content));
		}
	}
	checkBudget();
	return { lines };
}

function preview(line: string, needle: string): string {
	const index = line.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
	if (line.length <= 260 || index < 0) return line;
	const start = Math.max(0, index - 100);
	const end = Math.min(line.length, index + needle.length + 140);
	return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
}

/** Search literal text. Broad searches fail rather than returning a partial result. */
export function grepTranscript(transcript: Transcript, query: string, maxMatches: number, signal?: AbortSignal): Result<{ matches: string[] }> {
	const needle = query;
	if (typeof needle !== "string" || !needle.trim() || needle.length > 256 || /[\r\n]/.test(needle)) {
		return { ok: false, error: "Use a non-empty, single-line literal query of at most 256 characters (no quote delimiters)." };
	}
	if (!Number.isSafeInteger(maxMatches) || maxMatches < 1 || maxMatches > 50) {
		return { ok: false, error: "Match limit must be between 1 and 50." };
	}
	const matches: string[] = [];
	let bytes = 0;
	for (let index = 0; index < transcript.lines.length; index++) {
		signal?.throwIfAborted();
		const line = transcript.lines[index]!;
		if (!line.toLocaleLowerCase().includes(needle.toLocaleLowerCase())) continue;
		matches.push(`${index + 1}: ${preview(line, needle)}`);
		bytes += Buffer.byteLength(matches[matches.length - 1]!, "utf8") + 1;
		if (bytes > MAX_GREP_BYTES - 512) {
			return { ok: false, error: "Search is too broad: rendered matches exceed the 8 KiB output budget. Use a more specific query. No partial matches returned." };
		}
		if (matches.length > maxMatches) {
			return {
				ok: false,
				error: `Search is too broad: more than ${maxMatches} matching session lines. Use a more specific query, such as a filename, identifier, error text, or distinctive phrase (without surrounding quotes).`,
			};
		}
	}
	return { ok: true, matches };
}

/** Read a bounded 1-based range from the virtual transcript. Never truncates. */
export function readTranscript(transcript: Transcript, startLine: number, lineCount: number): Result<{ lines: string[] }> {
	if (!Number.isSafeInteger(startLine) || startLine < 1) {
		return { ok: false, error: "start_line must be a positive transcript line number." };
	}
	if (!Number.isSafeInteger(lineCount) || lineCount < 1) {
		return { ok: false, error: "line_count must be at least 1." };
	}
	if (lineCount > MAX_READ_LINES) {
		return { ok: false, error: `Requested ${lineCount} session lines; maximum is ${MAX_READ_LINES}. Read a narrower range.` };
	}
	if (startLine > transcript.lines.length) {
		return { ok: false, error: `Transcript has ${transcript.lines.length} lines; line ${startLine} does not exist.` };
	}
	const end = Math.min(transcript.lines.length, startLine - 1 + lineCount);
	const lines = transcript.lines.slice(startLine - 1, end).map((line, index) => `${startLine + index}: ${line}`);
	const bytes = Buffer.byteLength(lines.join("\n"), "utf8");
	if (bytes > MAX_READ_BYTES - 512) {
		return {
			ok: false,
			error: `Requested session lines render to ${bytes} bytes (maximum is ${MAX_READ_BYTES}). Read fewer lines.`,
		};
	}
	return { ok: true, lines };
}
