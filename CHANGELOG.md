# Changelog

## Unreleased

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
