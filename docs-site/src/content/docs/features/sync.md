---
title: Vault sync
description: Keep your Obsidian vault in sync, review pending changes, and understand what Crate transfers.
---

Crate syncs files between copies of your Obsidian vault through your server. Notes stay ordinary files on your devices.

## Automatic and manual sync

Crate checks for changes on startup, when Obsidian resumes, after file changes, and during periodic checks. To sync manually, run **Crate: Sync - sync now** from the command palette.

For manual-only syncing on one device, turn off **Settings → Crate → Sync → Automatic sync**. A running sync can still finish. To stop it, use **Pause sync** in Sync activity or **Crate: Sync - stop sync**. Stopping also turns off automatic sync on that device until you enable it again.

## Review pending changes

Open **Sync activity → Pending** to see files that have changed. Select a file to compare your local edits with this device's last-synced copy. These comparisons do not include newer edits from another device.

- **Sync all** transfers all pending files.
- Uncheck files and use **Sync selected** to transfer a subset. The other files remain pending.
- If no previous copy is cached, Crate shows the file status without a text comparison. Binary and large files show a size summary.

Selecting a subset applies to that sync only. It does not permanently ignore files or disable automatic sync.

## What syncs

Sync includes file creation, edits, deletions, renames, and attachments, with a maximum file size of 25 MiB. Updates to existing binary files require review.

Crate excludes its own plugin data, workspace state, conflict copies, and temporary files. Other Obsidian configuration and plugin settings can sync unless ignored. Review your ignore rules if those files contain device-specific settings or credentials.

Adding an ignore rule does not remove a copy that is already on the server. Use the explicit remote-file cleanup controls only after reviewing the affected paths.

## Conflicts and earlier versions

When versions need your input, Crate preserves content for review. [Conflict management](/docs/troubleshooting/conflicts/) explains how to choose or combine versions.

Server file history retains replaced and deleted files for 30 days. Shared checkpoints let you inspect and restore an earlier synced state. See [History and recovery](/docs/troubleshooting/recovery/) before restoring.

Sync carries deletions as well as edits. Keep an independent backup of important notes.
