# Conflict walkthrough

This note is safe to use when demonstrating Crate sync behavior.

## Basic conflict script

1. Turn off automatic sync.
2. Edit this note on one device.
3. Edit the same paragraph on another device or through the Worker API fixture.
4. Run sync and inspect the conflict copy.

## Files to touch

- `Notes/Sync sandbox.md` for regular Markdown updates.
- `Reminders/Work.md` for reminder Markdown updates.
- `Reminders/Crate Demo.md` for reorder and completion changes.

## Expected behavior

- Ignored files such as `.DS_Store`, `.trash/`, and `*.tmp` should not appear in sync plans.
- Reminder edits should stay regular Markdown changes.
- Conflict files should preserve both sides clearly enough to resolve manually.
