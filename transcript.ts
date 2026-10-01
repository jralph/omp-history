export const MAX_GREP_BYTES = 8 * 1024;
export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
export const MAX_TRANSCRIPT_LINES = 1_000_000;
export const MAX_READ_LINES = 50;
export const MAX_READ_BYTES = 32 * 1024;
export const MAX_EXCERPT_CHARS = 4096;
const METADATA_RESERVE = 512;

export const KINDS = ["user", "assistant", "tool", "summary", "other"] as const;
export type Kind = typeof KINDS[number];
export interface Source {
	kind: Kind;
	/** The same visible provenance header used in the rendered transcript. */
	header: string;
	entryId: string;
	timestamp?: string;
}
export interface Transcript {
	lines: string[];
	sources?: Source[];
	/** Latest /clear boundary; part of the snapshot identity, even for empty history. */
	boundaryId?: string;
}
export interface GrepOptions { kind?: Kind; context_lines?: number; all_of?: string[] }
export interface ReadOptions { start_column?: number; char_count?: number }
export interface Hit { line: number; startColumn: number; endColumn: number; source?: Source; entryStartLine: number; entryEndLine: number }
type Success<T> = { ok: true } & T;
type Failure = { ok: false; error: string };
export type Result<T> = Success<T> | Failure;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function safeJson(value: unknown): string {
	try { return JSON.stringify(value) ?? "null"; }
	catch { return "[unserializable arguments]"; }
}
function singleLine(value: string): string {
	return value.replace(/[\r\n]/g, " ").slice(0, 160);
}
function sourceFor(entry: Record<string, unknown>, kind: Kind, label: string): Source {
	const entryId = typeof entry.id === "string" ? singleLine(entry.id) : "unknown";
	const timestamp = typeof entry.timestamp === "string" ? singleLine(entry.timestamp) : undefined;
	return { kind, entryId, timestamp, header: `[${label} ${entryId}${timestamp ? ` @${timestamp}` : ""}]` };
}

/** Checks each natural line before retaining it; never allocates a full split/join of an entry. */
class TranscriptWriter {
	readonly lines: string[] = [];
	readonly sources: Source[] = [];
	private bytes = 0;
	constructor(private signal?: AbortSignal) {}
	private budget(length: number) {
		this.signal?.throwIfAborted();
		if (this.lines.length >= MAX_TRANSCRIPT_LINES || this.bytes + length + 1 > MAX_TRANSCRIPT_BYTES) {
			throw new Error("Session transcript exceeds the local safety budget (64 MiB / 1,000,000 lines); no partial history returned.");
		}
	}
	line(text: string, source: Source) {
		this.budget(text.length); // UTF-8 uses at least one byte per UTF-16 code unit.
		const bytes = Buffer.byteLength(text, "utf8");
		this.budget(bytes);
		this.bytes += bytes + 1;
		this.lines.push(text);
		this.sources.push(source);
	}
	text(text: string, source: Source) {
		const separators = /\r\n|\r|\n/g;
		let start = 0;
		let match: RegExpExecArray | null;
		while ((match = separators.exec(text))) {
			this.budget(match.index - start);
			this.line(text.slice(start, match.index), source);
			start = match.index + match[0].length;
		}
		this.budget(text.length - start);
		this.line(text.slice(start), source);
	}
	content(content: unknown, source: Source, fallback: string) {
		if (typeof content === "string") { this.text(content || fallback, source); return; }
		let found = false;
		if (Array.isArray(content)) for (const block of content) {
			this.signal?.throwIfAborted();
			if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text) {
				this.text(block.text, source);
				found = true;
			}
		}
		if (!found) this.text(fallback, source);
	}
}

function executionLabel(role: string, message: Record<string, unknown>): string {
	const status = message.cancelled === true ? "cancelled"
		: typeof message.exitCode === "number" ? (message.exitCode === 0 ? "success" : "error") : "unknown";
	return `${role}; status=${status}; exit=${typeof message.exitCode === "number" ? message.exitCode : "unknown"}; truncated=${typeof message.truncated === "boolean" ? message.truncated : "unknown"}`;
}
function renderMessage(writer: TranscriptWriter, entry: Record<string, unknown>, message: Record<string, unknown>, signal?: AbortSignal) {
	const role = typeof message.role === "string" ? message.role : "unknown";
	if (message.excludeFromContext === true) return;
	if ((role === "custom" || role === "hookMessage") && message.display !== true) return;
	switch (role) {
		case "user": case "developer": case "custom": case "hookMessage": {
			const source = sourceFor(entry, role === "user" ? "user" : "other", role);
			writer.line(source.header, source);
			writer.content(message.content, source, "[no text content]");
			return;
		}
		case "assistant": {
			const source = sourceFor(entry, "assistant", "assistant");
			const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }]
				: Array.isArray(message.content) ? message.content : [];
			let hasHeader = false;
			for (const block of blocks) {
				signal?.throwIfAborted();
				if (!isRecord(block)) continue;
				let text: string | undefined;
				if (block.type === "text" && typeof block.text === "string") text = block.text;
				if (block.type === "toolCall" && block.name !== "session_grep" && block.name !== "session_read") {
					text = `Tool call: ${String(block.name ?? "unknown")} ${safeJson(block.arguments)}`;
				}
				if (!text) continue;
				if (!hasHeader) writer.line(source.header, source);
				hasHeader = true;
				writer.text(text, source);
			}
			return;
		}
		case "toolResult": {
			const name = typeof message.toolName === "string" ? message.toolName : "unknown";
			if (name === "session_grep" || name === "session_read") return;
			const status = message.isError === true ? "error" : message.isError === false ? "success" : "unknown";
			const source = sourceFor(entry, "tool", `tool result: ${singleLine(name)}; status=${status}`);
			writer.line(source.header, source);
			writer.content(message.content, source, "[no text output]");
			return;
		}
		case "bashExecution": case "pythonExecution": {
			const source = sourceFor(entry, "tool", executionLabel(role, message));
			writer.line(source.header, source);
			const command = role === "bashExecution" ? message.command : message.code;
			if (typeof command === "string") writer.text(command, source);
			writer.text(typeof message.output === "string" && message.output ? message.output : "[no output]", source);
			return;
		}
		case "fileMention": {
			const source = sourceFor(entry, "other", "file mention");
			writer.line(source.header, source);
			const files = Array.isArray(message.files) ? message.files : [];
			for (const file of files) {
				signal?.throwIfAborted();
				if (!isRecord(file)) { writer.text("Referenced file", source); continue; }
				writer.text(`Referenced file: ${String(file.path ?? "unknown")}`, source);
				writer.text(typeof file.content === "string" ? file.content : "[no text content]", source);
			}
			if (!files.length) writer.text("[no referenced files]", source);
		}
	}
}

/** Active-branch visible history after the latest /clear; compaction is not a reset. */
export function buildTranscript(entries: readonly unknown[], signal?: AbortSignal): Transcript {
	signal?.throwIfAborted();
	let boundary = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		signal?.throwIfAborted();
		const entry = entries[i];
		if (isRecord(entry) && entry.type === "reset_boundary") { boundary = i; break; }
	}
	const reset = entries[boundary];
	const boundaryId = isRecord(reset) ? String(reset.id ?? `reset@${boundary}`) : undefined;
	const writer = new TranscriptWriter(signal);
	for (let i = boundary + 1; i < entries.length; i++) {
		signal?.throwIfAborted();
		const entry = entries[i];
		if (!isRecord(entry)) continue;
		if (entry.type === "message" && isRecord(entry.message)) {
			renderMessage(writer, entry, entry.message, signal);
		} else if ((entry.type === "compaction" || entry.type === "branch_summary") && typeof entry.summary === "string") {
			const source = sourceFor(entry, "summary", entry.type === "compaction" ? "compaction summary (not verbatim)" : "branch summary (not verbatim)");
			writer.line(source.header, source);
			writer.text(entry.summary, source);
		} else if (entry.type === "custom_message" && entry.display === true) {
			const source = sourceFor(entry, "other", "custom message");
			writer.line(source.header, source);
			writer.content(entry.content, source, "");
		}
	}
	return { lines: writer.lines, sources: writer.sources, boundaryId };
}

export function validateGrep(query: unknown, maxMatches: number, options: GrepOptions = {}): Result<object> {
	if (typeof query !== "string" || !query.trim() || query.length > 256 || /[\r\n]/.test(query)) {
		return { ok: false, error: "Use a non-empty, single-line literal query of at most 256 characters (no quote delimiters)." };
	}
	if (!Number.isSafeInteger(maxMatches) || maxMatches < 1 || maxMatches > 50) return { ok: false, error: "Match limit must be between 1 and 50." };
	if (options.kind !== undefined && !KINDS.includes(options.kind)) return { ok: false, error: "kind must be user, assistant, tool, summary, or other." };
	if (options.all_of !== undefined && (!Array.isArray(options.all_of) || options.all_of.length < 1 || options.all_of.length > 3 || options.all_of.some(anchor => typeof anchor !== "string" || !anchor.trim() || anchor.length > 256 || /[\r\n]/.test(anchor)))) {
		return { ok: false, error: "all_of must contain 1–3 non-empty single-line literal anchors, each at most 256 characters. Anchors must occur in the same visible entry, not elsewhere in the session." };
	}
	const context = options.context_lines === undefined ? 0 : options.context_lines;
	if (!Number.isSafeInteger(context) || context < 0 || context > 3) return { ok: false, error: "context_lines must be between 0 and 3." };
	return { ok: true };
}

/** Map a lowercase-string match back to original code points (lowercasing may expand İ). */
function findMatch(line: string, foldedQuery: string, signal?: AbortSignal) {
	const index = line.toLowerCase().indexOf(foldedQuery);
	if (index < 0) return undefined;
	let folded = 0, column = 1, startColumn = 0, endColumn = 0;
	for (const char of line) {
		if ((column & 4095) === 0) signal?.throwIfAborted();
		const next = folded + char.toLowerCase().length;
		if (!startColumn && next > index) startColumn = column;
		if (next >= index + foldedQuery.length) { endColumn = column; break; }
		folded = next;
		column++;
	}
	return { startColumn, endColumn };
}

/** 1-based Unicode code-point columns; never cut a surrogate pair. */
function sliceColumns(line: string, startColumn: number, count: number, signal?: AbortSignal) {
	let column = 1, unit = 0, startUnit = -1, endUnit = 0;
	for (const char of line) {
		if ((column & 4095) === 0) signal?.throwIfAborted();
		if (column === startColumn) startUnit = unit;
		if (column >= startColumn + count) break;
		unit += char.length;
		endUnit = unit;
		column++;
	}
	if (startUnit < 0) {
		if (!line && startColumn === 1) return { text: "", startColumn, endColumn: 0, omittedBefore: false, omittedAfter: false };
		return undefined;
	}
	return { text: line.slice(startUnit, endUnit), startColumn, endColumn: column - 1, omittedBefore: startUnit > 0, omittedAfter: endUnit < line.length };
}
function preview(line: string, match?: { startColumn: number; endColumn: number }, signal?: AbortSignal) {
	const start = match ? Math.max(1, match.startColumn - 100) : 1;
	const count = match ? match.endColumn - start + 1 + 140 : 260;
	const excerpt = sliceColumns(line, start, count, signal)!;
	return `${excerpt.omittedBefore ? "…" : ""}${excerpt.text}${excerpt.omittedAfter ? "…" : ""}`;
}

/** Broad searches fail; optional same-entry context shares the 8 KiB / 50-line budget. */
export function grepTranscript(transcript: Transcript, query: string, maxMatches: number, signal?: AbortSignal, options: GrepOptions = {}): Result<{ matches: string[]; hits: Hit[] }> {
	const valid = validateGrep(query, maxMatches, options);
	if (!valid.ok) return valid;
	signal?.throwIfAborted();
	const foldedQuery = query.toLowerCase();
	const matches: string[] = [], hits: Hit[] = [];
	let bytes = 0, renderedLines = 0;
	const anchors = (options.all_of ?? []).map(anchor => anchor.toLowerCase());
	for (let start = 0; start < transcript.lines.length;) {
		signal?.throwIfAborted();
		const source = transcript.sources?.[start];
		let end = start + 1;
		// Source object identity denotes an entry; IDs may be absent or duplicated.
		while (source && end < transcript.lines.length && transcript.sources?.[end] === source) {
			signal?.throwIfAborted();
			end++;
		}
		const entryStartLine = start + 1, entryEndLine = end;
		const first = start;
		start = end;
		if (options.kind && source?.kind !== options.kind) continue;
		let mask = 0;
		for (let row = first; anchors.length && mask !== (1 << anchors.length) - 1 && row < end; row++) {
			signal?.throwIfAborted();
			const folded = transcript.lines[row]!.toLowerCase();
			for (let a = 0; a < anchors.length; a++) if (folded.includes(anchors[a]!)) mask |= 1 << a;
		}
		if (mask !== (1 << anchors.length) - 1) continue;
		for (let index = first; index < end; index++) {
			signal?.throwIfAborted();
			const match = findMatch(transcript.lines[index]!, foldedQuery, signal);
			if (!match) continue;
			if (matches.length >= maxMatches) return { ok: false, error: `Search is too broad: more than ${maxMatches} matching session lines. Add a distinctive literal anchor in all_of or a kind filter. No partial matches returned.` };
			const hit: Hit = { line: index + 1, ...match, source, entryStartLine, entryEndLine };
			hits.push(hit);
			let text = `${hit.line}: ${preview(transcript.lines[index]!, match, signal)}`;
			if (source) text += `\nSource: ${source.header}; entry lines ${entryStartLine}–${entryEndLine}; match columns ${match.startColumn}–${match.endColumn}`;
			renderedLines++;
			for (let j = Math.max(0, index - (options.context_lines ?? 0)); j <= Math.min(transcript.lines.length - 1, index + (options.context_lines ?? 0)); j++) {
				if (j === index || (source && transcript.sources?.[j] !== source)) continue;
				text += `\nContext ${j + 1}: ${preview(transcript.lines[j]!, undefined, signal)}`;
				renderedLines++;
			}
			bytes += Buffer.byteLength(text, "utf8") + 1;
			if (bytes > MAX_GREP_BYTES - METADATA_RESERVE || renderedLines > MAX_READ_LINES) {
				return { ok: false, error: "Search is too broad: matches/context exceed the 8 KiB / 50 transcript-line output budget. Add an all_of anchor or kind filter, or reduce context_lines. No partial matches returned." };
			}
			matches.push(text);
		}
	}
	return { ok: true, matches, hits };
}

export function validateReadRequest(startLine: number, lineCount: number, options: ReadOptions = {}): Result<object> {
	if (!Number.isSafeInteger(startLine) || startLine < 1 || startLine > MAX_TRANSCRIPT_LINES) return { ok: false, error: "start_line must be a positive transcript line number, at most 1,000,000." };
	if (!Number.isSafeInteger(lineCount) || lineCount < 1) return { ok: false, error: "line_count must be at least 1." };
	if (lineCount > MAX_READ_LINES) return { ok: false, error: `Requested ${lineCount} session lines; maximum is ${MAX_READ_LINES}. Read a narrower range.` };
	if (options.start_column !== undefined || options.char_count !== undefined) {
		if (lineCount !== 1 || !Number.isSafeInteger(options.start_column) || options.start_column! < 1 || options.start_column! > MAX_TRANSCRIPT_BYTES || !Number.isSafeInteger(options.char_count) || options.char_count! < 1 || options.char_count! > MAX_EXCERPT_CHARS) {
			return { ok: false, error: "For a character excerpt supply line_count=1, start_column>=1 (at most 64 MiB), and char_count between 1 and 4096. Columns count Unicode code points." };
		}
	}
	return { ok: true };
}

/** Full natural lines, or an explicitly requested, labeled single-line character excerpt. */
export function readTranscript(transcript: Transcript, startLine: number, lineCount: number, options: ReadOptions = {}, signal?: AbortSignal): Result<{ lines: string[]; excerpt?: { startColumn: number; endColumn: number; omittedBefore: boolean; omittedAfter: boolean } }> {
	const valid = validateReadRequest(startLine, lineCount, options);
	if (!valid.ok) return valid;
	signal?.throwIfAborted();
	if (startLine > transcript.lines.length) return { ok: false, error: `Transcript has ${transcript.lines.length} lines; line ${startLine} does not exist.` };
	const output: string[] = [];
	let bytes = 0;
	function add(text: string): boolean {
		bytes += Buffer.byteLength(text, "utf8") + 1;
		if (bytes > MAX_READ_BYTES - METADATA_RESERVE) return false;
		output.push(text);
		return true;
	}
	const source = transcript.sources?.[startLine - 1];
	if (source && !add(`Source: ${source.header}`)) return { ok: false, error: "Source exceeds the read output budget." };
	if (options.start_column !== undefined) {
		const excerpt = sliceColumns(transcript.lines[startLine - 1]!, options.start_column, options.char_count!, signal);
		if (!excerpt) return { ok: false, error: "start_column is past the end of this line." };
		const { text, ...bounds } = excerpt;
		if (!add(`Excerpt line ${startLine}, columns ${bounds.startColumn}–${bounds.endColumn}; omitted before=${bounds.omittedBefore}, omitted after=${bounds.omittedAfter}`) || !add(`${startLine}: ${text}`)) return { ok: false, error: "Excerpt exceeds the 32 KiB output budget. Request fewer characters." };
		return { ok: true, lines: output, excerpt: bounds };
	}
	let lastSource = source;
	for (let index = startLine - 1; index < Math.min(transcript.lines.length, startLine - 1 + lineCount); index++) {
		signal?.throwIfAborted();
		const currentSource = transcript.sources?.[index];
		if (currentSource && currentSource !== lastSource) {
			if (!add(`Source: ${currentSource.header}`)) return { ok: false, error: "Read exceeds the 32 KiB output budget. Read fewer lines." };
			lastSource = currentSource;
		}
		const line = transcript.lines[index]!;
		if (line.length > MAX_READ_BYTES - METADATA_RESERVE || !add(`${index + 1}: ${line}`)) return { ok: false, error: "Requested session lines exceed the 32 KiB bytes budget. Read fewer lines; for one oversized line use line_count=1, start_column and char_count for a bounded excerpt." };
	}
	return { ok: true, lines: output };
}
