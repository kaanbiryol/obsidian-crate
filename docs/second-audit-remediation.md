# Second audit remediation

The fresh audit starts at `f371397`, after the first round of actionable fixes. Historical audit reports remain unchanged. Findings below are independently reproduced and committed; final acceptance results will be recorded against the final candidate.

## R01 — Return committed reminder state

- **Severity / confidence:** medium, confirmed.
- **Area:** Obsidian reminder repository, Markdown writer and index.
- **Failure:** complete a recurring reminder through the repository. Markdown and the index advance its due date and occurrence count, but the returned reminder contains the old date/count and `completed: true`. Adding recurrence to an undated reminder likewise omits the generated schedule from the returned value. Consumers can render a state different from the saved note.
- **Root cause:** mutation methods reconstructed results from the pre-write record. Completion's optimistic index update also omitted the recurrence count.
- **Fix:** return the current indexed record after the writer completes and include recurrence in the completion update.
- **Proof:** a real repository/writer/rescan regression failed before the fix. The focused repository and writer suite passes 67 tests, covering partial edits, project moves, generated dates, recurring advancement, final completion, reopening and recompletion.

## R02 — Preserve literal title text during schedule decoding

- **Severity / confidence:** high, confirmed.
- **Area:** shared reminder parser, editor/Markdown round trip and Worker caches.
- **Failure:** save an editor title containing `[Weekly report](https://example.com/report)` with a recurrence. The editor protects the link, but durable decoding previously interpreted `Weekly` as the rule and rejected the saved schedule. A literal `!` inside a link changed priority and disappeared from the title. Repeated date/rule text could also remove the wrong occurrence.
- **Root cause:** durable parsing searched raw text and removed the first matching string, independently of the editor's protected, indexed matches.
- **Fix:** share those matches, select the appended schedule and remove only its original ranges. Parser version 7 invalidates old list caches and requires current-source notification revalidation without changing Markdown bytes.
- **Proof:** four new round-trip cases failed before the fix. The reminder/PWA suite passes 753 tests; the final persisted-schedule suite passes 24 cases, including identical all-day/timed date mentions. Thirteen actual Worker tests cover create/list, parser-6 cache replacement, durable authority migration, unchanged R2 bytes and notification migration fences. Targeted lint and both typechecks pass.

## R03 — Preserve damaged or colliding saved editor drafts

- **Severity / confidence:** high, confirmed.
- **Area:** PWA session storage and reminder editor lifecycle.
- **Failure:** a saved draft has a string title but an object description or invalid recurrence. Ordinary restore previously passed it to the editor, where it could fail rendering/saving; closing the sheet unconditionally deleted the only original copy. A different operation's draft could also be overwritten when opening recovery in the same slot.
- **Root cause:** ordinary restore validated only title type; recovery validation omitted recurrence, and neither path provided an exportable quarantine before replacement.
- **Fix:** validate the draft and retained attempt before rendering. Damaged/incompatible strings stay in place behind a review screen. Close/reload preserves them; exact export, explicit review, same-key/folder/string comparison and verified removal precede a fresh editor. Storage access failure stays actionable. Valid legacy bodies are retained byte for byte.
- **Proof:** three damaged-field regressions failed before the fix. All 264 PWA unit tests and targeted lint/typecheck pass. Chromium/WebKit draft recovery, first-tap focus, authentication recovery and two-tab outbox recovery pass, including changed bytes, failed deletion, full Unicode export, inert markup and folder isolation.

## R04 — Batch cold full-sync uploads within existing safety budgets

- **Severity / confidence:** medium, confirmed.
- **Area:** full-sync workflow and upload transport.
- **Failure:** a 10,000-note cold full sync performed 20,002 requests, including a protocol preflight and individual upload for each note. The initial-upload path already supported bounded batching.
- **Root cause:** full reconciliation routed upload diffs through the individual conflict-processing function instead of the existing batch transport.
- **Fix:** reuse byte-budgeted preparation and three-file batch publication. Preparation forces a fresh read with the plan's remote-hash/absence guard; confirmed hash/revision updates, errors, progress and edit/delete notices retain their semantics.
- **Proof:** the 398-test sync suite, final four-case workflow suite, eight interrupted-history tests, three new real-Worker failure cases and all four 1k/10k capacity cases pass. Targeted lint and both typechecks pass. Cold requests fall to 674/6,722 (about 66% lower), with all final bytes and hashes verified. [Measurements and scope](sync-capacity.md).

## Verification in progress

The first-round gate passed advisory and secret scans, lint, both typechecks, deadcode, notices, 22 recovery tests, 1,538 unit tests, 220 Worker tests and production builds. It stopped at PWA bundle budgets; later gate steps therefore were not established by that run. The bundle issue and additional parser, persistence and scale checks are part of this second audit.
