# Opt-in CLI benchmark

This is an experiment, **not** normal validation. `bun run check` and CI do not
call models. Live runs require user approval, an installed `omp` 18.4.4, existing
working authentication, and the explicit flag below. They can consume quota or
incur charges.

```bash
# Model-free fixture/experiment plan
bun run bench --model openai-codex/gpt-5.5 --dry-run

# Paid/quota-consuming experiment
bun run bench --model openai-codex/gpt-5.5 --trials 3 \
  --allow-model-calls --output bench-results/run.json
```

Other options: `--seed <public-identifier>`, `--timeout-seconds <10–600>`
(default 180), and `--compaction controlled|natural` (default controlled).
Trials are limited to 1–10. Use an exact `provider/model`, never OpenRouter.
To compare a previous implementation on the same seed sessions, add
`--previous-extension /path/to/previous/index.ts`. Its `transcript.ts` and
`snapshot.ts` siblings must also exist. This adds a third condition; order rotates
so each condition occupies each position once across three trials. Only load
trusted extension code. Source checksums are recorded without exporting paths.
Outputs contain the seed; do not put secrets in it. Report paths must end in
`.json`; existing files are not overwritten. The default output is timestamped
under `bench-results/`. Use `bun run bench --help` for a short option reference.

## Protocol

1. Generate approximately 1 MB of synthetic registry records across 128 files.
   Eight random-looking string values for one service are distributed across
   four records connected by references. The initial prompt includes approximately
   48 KB of unrelated project context. No answers occur in either question.
2. Launch the actual `omp --mode rpc` executable through OMP's official RPC
   client. Have the model investigate and produce a migration brief. Require all
   eight exact JSON values to be correct before admitting the trial.
3. Add a short unrelated retained tail using an extension command, then invoke
   **OMP's actual compaction command**. In controlled mode a benchmark-only hook
   supplies the same deliberately lossy summary for every trial. No summarizer
   model call is needed. Natural mode uses OMP's soft summarizer instead; its
   reported `model_usage` entries are recorded separately.
4. Inspect the runtime's compacted messages. All eight answer strings must be
   absent; otherwise the trial is marked ineligible, not counted as recovery.
5. Clone that synthetic session into two fresh isolated agent homes with new
   session identities. Verify identical compacted contexts and missing facts.
   Only the history-enabled arm loads this repository's extension. Both receive
   the same follow-up and unchanged sources. Arm order alternates by trial.
6. Grade exact JSON fields without a model judge. Capture each follow-up's
   elapsed time, completed model messages, requested tool calls, tool errors,
   text-result bytes, provider-reported input/output/cache/total tokens, and
   OMP's estimated cost. Common investigation/compaction is reported separately.

Timed-out/budget-exhausted follow-up arms retain their spent-call measurements
and are marked `completed: false`, with no completed-answer credit; other arms
continue. Model mismatches and the run-wide estimated-cost cap still abort the
experiment. No failed arm is silently discarded.

The agent is **not forced to use history**. Skipping it, unsuccessful calls,
partial answers, and redoing source lookups are outcomes, not exclusions.
A correct answer alone does not prove history helped.

## Isolation and safety

Each experiment creates a private temporary directory for HOME, XDG paths,
configuration, fixtures, sessions, caches, and logs. Discovery of other
extensions, rules, skills, LSP, and automatic titles is disabled. Memory,
automatic/background compaction, cache warming, retries and model fallback are
off. Only read/grep/glob and, for one arm, the two history tools are active.
A benchmark-only hook confines file-tool paths to the synthetic working directory
and rejects external/internal URLs, tilde expansion and traversal. This is a
tool-level restriction, **not an OS sandbox**. No shell, writes, raw-session
reads, bulk history exports, or cross-session retrieval are offered to the model.

Authentication uses OMP's existing vault via a temporary, authenticated loopback
broker. Its random bearer is supplied in the child environment, never argv or
reports. No existing credential database/configuration is copied. Normal vault
refresh/account updates can occur; temporary clients may cache access tokens as
OMP normally does. OpenRouter is explicitly disabled and its API-key environment
value is removed from child access. The live configuration and live sessions are
not edited.

Temporary data is deleted on completion or caught failure. A hard termination
can leave a private `omp-history-bench-*` directory under the system temp directory;
remove it rather than publishing it. Only aggregate reports are exported;
`bench-results/` is ignored. Do not commit temporary sessions, logs or credentials.

Each model phase times out and stops above `--max-tool-calls` requested tool
calls (default 16; configurable 16–48) or that cap plus two completed model
messages. The run aborts above $5 of reported catalog-estimated cost,
checked **after** completed calls. This is not a hard billing cap; in-flight work,
provider billing and incomplete usage reports can exceed estimates. Prompt
caching remains enabled and cached tokens are reported separately. In default
`--scope followup` mode, history is disabled in the shared seed investigation:
those comparisons do **not** measure conversation-lifetime overhead. In
`--scope lifecycle`, independent investigations load each condition's tools from
the start and their usage is included. `elapsedMs` measures model phases (plus
compaction in lifecycle sums), excluding process startup; lifecycle
`wallElapsedMs` additionally includes fixture preparation and process launches.

## Mixed scenarios and lifecycle measurement

```bash
bun run bench --model openai-codex/gpt-5.5 --suite mixed-v2 \
  --scope lifecycle --trials 2 --max-tool-calls 32 --dry-run

# Explicitly paid/quota-consuming; two repetitions × four cases × two conditions
bun run bench --model openai-codex/gpt-5.5 --suite mixed-v2 \
  --scope lifecycle --trials 2 --max-tool-calls 32 --timeout-seconds 240 \
  --allow-model-calls --output bench-results/mixed-lifecycle.json
```

`--suite linked-registry-v1` and `--scope followup` remain defaults, preserving
old workload prompts. In `mixed-v2`, `--trials` means repetitions of **each** case:

- **Cheap control:** the original four linked records, eight values.
- **Deep reconstruction:** eight dependent records across 256 shards, about
  1.38 MB, with one answer value per record.
- **User decision:** actual model-generated draft investigation, then a second
  user turn superseding all eight values with approved values absent from files.
  The model acknowledges them; both draft and approval remain in visible history.
- **Changed source:** after compaction the harness updates all eight target
  values in the fixture. The final answer must distinguish eight historical
  values from eight current values. No filesystem history/backup is available.

No answers are included in the follow-up. The latter two cases allow explicit
JSON `null` for unestablishable values. All mixed cases use that same uncertainty
instruction; grading separates exact values, explicit unknowns, wrong non-null
values, missing fields, and malformed JSON. An honest unknown is **not** called
a false claim. Historical/current groups are graded separately.

Lifecycle mode investigates independently for each condition on identical
fixtures, checks every seed phase against its own gold, compacts, and verifies
all historical target strings are absent. Initial tool choices/outputs can vary;
this is not the original identical-seed experiment. History declarations are
present throughout its setup. Both restart into fresh isolated RPC clients after
compaction, verifying restored context against their own saved context, to avoid
unmeasured in-memory provider continuation. Setup, compaction and follow-up
metrics are exported separately; `lifecycle` sums them **once**. Comparison order
rotates by repetition, so each case is counterbalanced over two conditions/two
repetitions. `mixed-v2 --scope followup` instead shares a verified seed and clones
identical compacted contexts, excluding initial declaration overhead.

Fixture changes are performed only by the harness, not the read-only model;
each arm gets the same changed state, and files are checked afterward. Ineligible
seeds/retained facts are recorded rather than silently selected away. Paid
terminal-phase metrics are retained on fatal model/cost failures in new-mode
reports. None of these fixtures are real sessions or project data.

## Recorded evidence

### Initial implementation

[Three paired trials, 2026-10-01](evidence/controlled-2026-10-01.json), using
`openai-codex/gpt-5.5`, low thinking, OMP 18.4.4 and extension 0.3.0:

| Follow-up total (3 trials) | History enabled | Disabled |
| --- | ---: | ---: |
| Exact answer fields | 24/24 | 24/24 |
| Model calls | 23 | 16 |
| Tool calls | 22 | 16 |
| Tool errors | 5 | 2 |
| Uncached input tokens | 89,212 | 19,794 |
| Cache-read tokens | 197,120 | 44,544 |
| Output tokens | 2,101 | 1,454 |
| Reported total tokens | 288,433 | 65,792 |
| Elapsed time | 78.0 s | 49.5 s |
| Catalog-estimated cost, not billing | $0.608 | $0.165 |

All three seed briefs were correct and all eight values were absent after
compaction. The enabled agent used the history tools in only one trial; that arm
had five tool errors and also redid source lookups. Error categories were
unclassified (`other`); this evidence does not establish their cause. No measured
saving was demonstrated. A preceding one-pair pilot also returned correct
answers in both arms but was slower with history (37.3 s versus 19.9 s).
The pilot is exploratory and is not pooled into the table.

These are three synthetic paired tasks on one model, not evidence that the
plugin universally helps or hurts. Deliberate omission does not measure how often
natural compaction loses useful facts. Tool choice, schema overhead, caching,
model variability and service latency affect results. Source reconstruction was
possible here; user-only decisions may have no such alternative. This experiment
does not quantify that separate benefit or any savings from real-world usage.
The archived report predates the addition of the separate `compactionUsage`
field; its controlled compactions used the hook, with no summarizer call.

### Revised instructions/search and optional-argument fix

[Fresh three-way comparison, 2026-10-01](evidence/sparse-search-2026-10-01.json):
same three deterministic workloads, model, low thinking and controlled omission.
Previous source was frozen from commit `8ce9f28`; revised source is identified by
`extensionSourceSha256` (unreleased changes, not a new 0.3.0 release).

| Follow-up total (3 tasks) | No history | Previous history | Revised history |
| --- | ---: | ---: | ---: |
| Completed tasks | 3/3 | 2/3 | 3/3 |
| Completed-answer exact fields | 24/24 | 16/24 | 24/24 |
| Model calls | 17 | 26 | 12 |
| Tool calls | 15 | 34 | 10 |
| Tool errors | 0 | 11 | 0 |
| Uncached input tokens | 19,258 | 38,719 | 20,703 |
| Cache-read tokens | 54,784 | 93,696 | 41,472 |
| Output tokens | 1,310 | 3,058 | 1,101 |
| Reported total tokens | 75,352 | 135,473 | 63,276 |
| Elapsed time | 50.2 s | 92.8 s | 42.2 s |
| Catalog-estimated cost, not billing | $0.163 | $0.332 | $0.157 |

Revised history used one successful search/read pair in tasks 1 and 2. Task 3
skipped history, used six model calls versus baseline's five, and took longer.
Across all three, revised history used about 29% fewer model calls, 16% fewer
reported total tokens and 16% less elapsed time than baseline. **Uncached input
rose about 8%; estimated cost fell only about 3.5%.** Cached-token totals are not
billing-equivalent. This remains a small, provisional result with no baseline
accuracy gain; it is not universal savings or a statistically established effect.
The previous implementation exhausted its phase tool-call budget in task 3;
its spent measurements remain included rather than dropping that failure.

Diagnostics identified invalid multi-line character-excerpt arguments, not
incorrectly copied snapshots: ten previous-arm calls had multi-line character
fields and errored; revised successful reads omitted character fields. Both tool
definitions now explicitly emit `strict: false`, preserving optional fields in
the actual Codex serializer, while local validators still enforce all budgets.
This addresses Responses interfaces that can otherwise normalize optional fields
into required ones. Improved guidance, same-entry literal anchors and entry line
ranges were changed together; this is **not an ablation proving which change
caused the measured improvement**, nor proof that `all_of` alone saved work.

[The preceding diagnostic run](evidence/sparse-search-diagnostic-2026-10-01.json)
had one completed three-way task before interruption in the old arm of task 2.
Instructions/search changes without the explicit optional-argument fix still
produced five excerpt-argument errors in its revised arm. That incomplete run is
published for transparency, not pooled into the completed comparison. Its runner
predated failed-arm metric preservation, so the interrupted arm's spent metrics
are unavailable in that artifact.

To reproduce the previous source without changing your checkout:

```bash
previous=$(mktemp -d)
for file in index.ts transcript.ts snapshot.ts; do
  git show 8ce9f28:"$file" > "$previous/$file"
done
bun run bench --model openai-codex/gpt-5.5 --trials 3 \
  --previous-extension "$previous/index.ts" --allow-model-calls \
  --output bench-results/comparison.json
rm -r "$previous"
```

### Broader scenarios, tools enabled from the start

[Eight lifecycle tasks, 2026-10-01](evidence/mixed-lifecycle-2026-10-01.json):
`mixed-v2`, two repetitions per case, two conditions, GPT-5.5/low, OMP 18.4.4,
controlled loss, cap 32 tools/34 model messages per phase, 240-second timeout.
The runtime extension is unchanged from the revised implementation above; only
the benchmark expanded. All 16 arm investigations passed exact grading and all
historical facts were absent after compaction. Both conditions completed every
follow-up. No history calls occurred before compaction; declaration overhead
and initial source-tool choices are nevertheless included.

| Two conversations per case | Baseline exact fields | History exact fields | Baseline lifecycle calls | History lifecycle calls | Baseline estimated cost | History estimated cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Cheap control | 16/16 | 16/16 | 25 | 16 | $0.408 | $0.297 |
| Eight-hop reconstruction | 16/16 | 16/16 | 43 | 24 | $0.995 | $0.425 |
| Superseded user decision | 0/16 | 16/16 | 26 | 18 | $0.450 | $0.698 |
| Historical + changed current state | 16/32 | 32/32 | 26 | 26 | $0.588 | $0.428 |

Baseline returned 32 explicit unknowns: 16 approved-decision values and 16
historical values no longer in current files. Neither condition made a wrong
non-null final claim. Both verified all 16 current-state fields correctly;
history did **not** substitute stale values. History used one successful
search/read pair in every follow-up, adding current-source checks when required.

| Whole measured conversation totals (8 tasks) | Baseline | History |
| --- | ---: | ---: |
| Exact fields | 48/80 | 80/80 |
| Explicit unknown fields | 32 | 0 |
| Model calls | 120 | 84 |
| Tool calls | 130 | 74 |
| Tool errors | 18 | 0 |
| Uncached input | 313,854 | 245,429 |
| Cache-read tokens | 1,077,760 | 800,256 |
| Output tokens | 11,103 | 7,344 |
| Reported total tokens | 1,402,717 | 1,053,029 |
| Model phases + compaction time | 378.6 s | 252.8 s |
| Cold-start wall time, including two launches per arm | 399.3 s | 275.2 s |
| Catalog-estimated cost, not billing | $2.441 | $1.848 |

The mixed total is about 25% fewer reported tokens, 33% less phase time, and
24% lower estimated cost, **but it pools tasks with different attainable
information and correctness**. Use the per-case comparisons, not a universal
savings claim. The user-decision case cost about 55% more with history: its first
history-enabled setup alone consumed unusually many tokens using native source
tools, not history calls. Independent initial investigations make that variance
part of lifecycle outcomes; this cannot isolate declaration overhead causally.

All 18 baseline errors were native follow-up file-tool errors classified `other`;
their precise cause is not established by the exported diagnostics. The harness
also rejects internal artifact URLs, which may hinder native workflows. These
restrictions and model errors can magnify measured reconstruction costs. It is
not a comparison with an optimal filesystem strategy. Cheap-control results do
not reverse the earlier evidence that history can be skipped or cost more.

Two repetitions, one model, synthetic strings, controlled summaries, no real
coding edits or subjective rationale grading: this establishes a narrowly
exercised recovery capability, not robust production ROI. It measures one short
conversation with one compaction, not continuous declaration cost over long
sessions or the natural frequency of missing facts. The total run's estimated
cost was $4.289 across both conditions; no extra unsuccessful arm was excluded.

Normal model-free tests additionally exercise same-entry isolation, reused IDs,
clear/hidden-content boundaries, literal Unicode anchors, invalid inputs,
unchanged output limits, and the real runtime's `strict: false` wire encoding.
