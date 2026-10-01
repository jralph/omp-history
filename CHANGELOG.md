# Changelog

## Unreleased

- Harden both tool descriptions to include user-authored decision evidence,
  explicit supersession and historical/current-state distinctions; avoid repeated
  file lookups for conversation-only decisions and acknowledge unresolved conflicts.
  Keep current instructions authoritative. Wording-only changes preserve schemas,
  retrieval behavior, privacy boundaries and budgets; performance is not remeasured.
- Broaden the opt-in benchmark to eight-hop reconstruction, superseded user
  decisions and historical/current-state checks; measure independent full
  conversations with tool declarations enabled from the initial investigation.
  Grade honest unknowns separately from wrong claims and publish per-case
  outcomes, including an increased-cost case. Runtime tools are unchanged.
- Narrow recovery guidance to specific missing decisions, rationale, errors or
  costly prior results, with a default search/read pair and one corrected retry.
- Add optional same-entry literal `all_of` anchors and entry line bounds to grep;
  preserve literal matching, global addresses, clear/privacy boundaries and budgets.
- Explicitly emit `strict: false` so Responses tools retain optional parameters;
  retain local validators and clarify ordinary-line versus character-excerpt errors.
- Extend the benchmark with matched previous/revised/no-history conditions,
  source fingerprints and failed-arm/argument-shape diagnostics. Publish complete
  aggregate evidence, including the unsuccessful intermediate run.
- Add an explicitly opt-in, isolated, actual OMP CLI benchmark for paired
  post-compaction recovery; routine tests and CI remain model-free.
- Publish aggregate experimental evidence and concise human-facing findings,
  distinguishing observed usage from measured performance and estimates.

## 0.3.0

### Correctness and privacy

- Respect the latest OMP `/clear` boundary without losing pre-compaction history.
- Preserve tool success/error and execution exit/cancellation/truncation status;
  unknown outcomes remain unknown.
- Include entry IDs, timestamps, source provenance, and non-verbatim summary labels.
- Fix Unicode case-expansion offsets and avoid splitting surrogate pairs in previews.
- Enforce transcript budgets incrementally rather than after retaining an entire entry.
- Reject malformed snapshots and invalid read arguments before rendering the branch.
- Hash original UTF-16 code units in chunks so distinct lone surrogates cannot alias.

### Targeted retrieval

- Optional `kind` filters and 0–3 same-entry context lines in `session_grep`.
- Return match columns measured in 1-based Unicode code points.
- Explicit single-line character excerpts in `session_read`, capped at 4096 code
  points within the existing 32 KiB budget. Omitted content is clearly labeled.
- Default reads to one line and clarify snapshot-prefix EOF.
- Keep the two tools, read-only behavior, and existing output/transcript limits.

### Validation

- Strict TypeScript checking, pinned development dependencies, and CI on Bun 1.3.14/1.4.0.
- Real in-memory OMP SessionManager/schema tests and deterministic Unicode property tests.

### Upgrade note

Snapshot format is now `v3:` and provenance changes transcript line addressing.
Regenerate references with `session_grep` after updating. Old snapshots are rejected.
This release is tested with OMP 18.4.4; use 18.4.4 or newer for durable clear boundaries.

## 0.2.1

- MIT license, package metadata, public release, and OMP marketplace distribution.

## 0.2.0

- Initial bounded active-branch `session_grep` and `session_read` implementation.
