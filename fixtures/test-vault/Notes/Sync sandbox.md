# Sync sandbox

This note is safe to edit, rename, delete, and recreate while testing Crate's sync event handling.

## Checklist

- Edit this paragraph and confirm Crate queues the change after sync is configured.
- Duplicate this note to test create events.
- Rename this note to test rename events.
- Add an attachment or pasted image to confirm binary files appear in the sync plan.
- Toggle a few reminders while offline, then reconnect to exercise queued reminder writes.

## Suggested edits

- Add a heading above this list.
- Move this note into `Notes/Sync cases`.
- Create a copy named `Sync sandbox copy.md`, then delete it after the sync queue observes the create event.
- Temporarily create a `scratch.tmp` file and confirm it is ignored by the configured sync patterns.
