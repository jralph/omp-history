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

Each model phase times out and stops at more than 16 tool calls or 18 completed
model messages. The run aborts above $5 of reported catalog-estimated cost,
checked **after** completed calls. This is not a hard billing cap; in-flight work,
provider billing and incomplete usage reports can exceed estimates. Prompt
caching remains enabled and cached tokens are reported separately. Elapsed time
excludes process startup and includes response collection.

## Recorded evidence

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
