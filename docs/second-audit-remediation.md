# Second audit remediation

The fresh audit starts at `f371397`, after the first round of actionable fixes. Historical audit reports remain unchanged. Findings below are independently reproduced and committed; final acceptance results will be recorded against the final candidate.

## R01 — Return committed reminder state

- **Severity / confidence:** medium, confirmed.
- **Area:** Obsidian reminder repository, Markdown writer and index.
- **Failure:** complete a recurring reminder through the repository. Markdown and the index advance its due date and occurrence count, but the returned reminder contains the old date/count and `completed: true`. Adding recurrence to an undated reminder likewise omits the generated schedule from the returned value. Consumers can render a state different from the saved note.
- **Root cause:** mutation methods reconstructed results from the pre-write record. Completion's optimistic index update also omitted the recurrence count.
- **Fix:** return the current indexed record after the writer completes and include recurrence in the completion update.
- **Proof:** a real repository/writer/rescan regression failed before the fix. The focused repository and writer suite passes 67 tests, covering partial edits, project moves, generated dates, recurring advancement, final completion, reopening and recompletion.

## Verification in progress

The first-round gate passed advisory and secret scans, lint, both typechecks, deadcode, notices, 22 recovery tests, 1,538 unit tests, 220 Worker tests and production builds. It stopped at PWA bundle budgets; later gate steps therefore were not established by that run. The bundle issue and additional parser, persistence and scale checks are part of this second audit.
