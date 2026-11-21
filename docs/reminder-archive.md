# Reminder archive

Completed reminders stay in their project note until the user archives them. A busy project, such as `Inbox.md`, grows without limit otherwise. Costs that scale with a note's reminder count include the Worker's parsed cache row (capped at 1.5 MiB, about 4,800 short reminders), the reminders re-sent to the web app on each change in that note, and the time to rewrite and parse the note on every edit. D1 rows per edit do not grow with the note.

## Layout

The archive is the reserved `Archive` subfolder of the reminders folder. Each project note has a matching archive note:

| Project note | Archive note |
| --- | --- |
| `Reminders/Inbox.md` | `Reminders/Archive/Inbox.md` |
| `Reminders/Work/Q1.md` | `Reminders/Archive/Work/Q1.md` |

`src/protocol/reminder-archive-path.ts` defines the rule. The folder is matched by portable path key, so any letter case or Unicode form counts. Everything that reads reminder notes uses it:

- Plugin: the vault scan, the index, the vault watcher and editor ID assignment skip archive notes. Encrypted uploads give them an empty schedule list rather than none: the server cannot tell them from projects by their tags, and a note without schedules would be reported as unscheduled.
- Worker: reminder scope, the list handler (metadata, delta paths and the ETag revision), the source scan, and web app command paths exclude them.
- Encrypted web app: the server sees only path tags, so the app derives the archive folder's tag and skips those notes before downloading. Tags fold letter case like portable keys.
- Project paths: `Archive/...` is rejected by `normalizeReminderProjectPath`, so no client can create a project inside the archive. A project named `Archive` is allowed.

An archive note is an ordinary synced file: one `files` row and one R2 object. Removing reminders from the folder looks like any note edit. Their identities, occurrence history and receipts age out under the [retention policy](reminder-retention.md).

## Running an archive

Only the plugin archives, through **Archive completed reminders**. The Worker never rewrites notes in bulk. Before each note the command checks whether sync is writing the vault; if it is, the run stops and its notice reports what was archived and asks to run it again. Plugin unload stops the run without reporting the remaining notes as failures.

`planReminderArchive` in `src/reminders/core/reminder-archive.ts` selects completed top-level reminders with a single owning checkbox line, with their description block. Nested reminders, reminders with attached content and duplicate identities stay and are counted as skipped.

Each project note is one operation in the [move journal](../src/reminders/data/reminder-move-journal.ts), as an `archive` record:

1. Write a recovery record listing the source note, the archive note and the exact blocks.
2. Append every block to the archive note in one write, in the archive note's line ending. An older archived copy of the same identity is replaced, so each identity appears once. A copy that cannot be removed safely keeps that reminder out of the run.
3. Remove the blocks from the project note in one write. A block changed since planning stays.
4. Remove the new archive copy of any block that stayed, put back the older copy that step 2 replaced for it, then clear the record.

While a record is pending, both notes are held from scans and other writes like a move.

## Recovery

Recovery runs on load and after sync, as for moves. For an archive record it removes from the project note every block the archive note holds, then clears the record. A block the archive never received stays in its project. Recovery therefore never loses a reminder; at worst it leaves an extra archived copy, which the next archive of that reminder replaces. The older copy that the interrupted run replaced is not put back, because the record does not keep it; the archive then holds the newer completed copy instead.

## Tests

- `src/reminders/core/reminder-archive.test.ts`: block selection, exact removal, appends, line endings and replacement.
- `src/reminders/data/reminder-archive-runner.test.ts`: whole runs, interruption after each write, failed archive writes, concurrent edits and the sync wait.
- `src/protocol/reminder-archive-path.test.ts`: path and project rules.
- `src/cloudflare/worker/reminders/archive-scope.integration.ts` and `list-parity.integration.ts`: the Worker list, cache and revision ignore archive notes, and the encrypted web app lists the same reminders.
