# Recover unreadable reminder sources

The plugin shows **Some reminders could not be refreshed** when a reminder note cannot be read safely. Expand **Review affected files** to see the affected paths and reasons. Previously indexed reminders remain visible but may be stale; edits to those notes are paused. Healthy notes remain usable. A full scan is complete only when every source was read successfully.

For a temporary storage error, wait until the vault is available and select **Refresh reminders**. A successful refresh clears the warning and reads the current task text. Renaming a note moves its warning to the new path; confirmed deletion removes its saved entries.

For an encoding error, preserve a separate copy of the original note before using an editor that understands its encoding to save it as UTF-8 without null characters. Crate does not guess the encoding or convert it automatically. Valid Unicode, a UTF-8 BOM and literal replacement characters are supported. Generic sync continues to preserve the original file bytes, even while reminder editing is unavailable.

An interrupted reminder move retains its journal while either source is unreadable. Restore readable source files, then use the existing interrupted-move recovery flow. Do not delete the journal to dismiss an error: it records the intent needed to distinguish an incomplete move from a duplicate task.

## Storage guarantees

All reminder rewrites validate raw bytes and compare the resulting text inside Obsidian's atomic `Vault.process` callback. Concurrent text changes cause a retry instead of an overwrite. Obsidian does not provide an atomic binary processing callback: an external raw-byte writer that changes a valid literal replacement character into malformed bytes with exactly the same lossy text during that final interval cannot be distinguished by the host callback. Avoid simultaneous raw-byte conversion by external tools while reminder edits are running.

Remote deletions recheck the target's file type and host identity after reading its hash. Adapter-only paths also recheck their type and timestamps. A replacement folder or changed file stops the operation without settling its checkpoint. Deletion always uses local trash; a final edit arriving after validation remains recoverable there. The host does not expose an atomic compare-and-delete operation.
