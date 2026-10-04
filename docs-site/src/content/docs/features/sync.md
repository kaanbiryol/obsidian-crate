---
title: Vault sync
description: Keep your Obsidian vault in sync, review pending changes, and understand what Crate transfers.
---

Crate syncs files between copies of your Obsidian vault through your server. Notes stay ordinary files on your devices.

## Automatic and manual sync

**Automatic sync is off by default on each device.** After [connecting your server](/docs/getting-started/hosting/), run **Crate: Sync - sync now** from Obsidian's command palette for your first sync. Connecting alone does not transfer files.

To keep syncing automatically, turn on **Settings → Crate → Sync → Automatic sync**. Crate then syncs after file changes, on startup and resume, and when periodic checks find changes. Enable it separately on each Obsidian device.

Under **Sync → Sync options**, you can adjust:

| Control | What it changes |
| --- | --- |
| **Sync delay after editing (seconds)** | How long this device waits after an edit; the default is 5 seconds. Set it to 0 for immediate syncing. |
| **Check for remote changes** | How often connected devices check for other devices' changes; the default is 5 minutes. **Off** stops periodic checks, while edits, startup, and resume can still trigger sync. |

Keep Obsidian open until sync finishes, especially on mobile. Sync cannot keep running reliably while the operating system suspends the app.

## Pause or resume

For manual-only syncing on one device, turn off **Settings → Crate → Sync → Automatic sync**. A running sync can still finish. To stop it, use **Pause sync** in Sync activity or **Crate: Sync - stop sync**. Stopping also turns off automatic sync on that device until you enable it again.

The web app and server notifications continue independently. Turning off automatic sync also leaves a small server availability check on startup and resume; that check does not transfer files.

## Review pending changes

Run **Crate: Sync - show activity**, then select **Pending**. Select a file to compare your local edits with this device's last-synced copy. These comparisons do not include newer edits from another device.

- **Sync all** transfers all pending files.
- Uncheck files and use **Sync selected** to transfer a subset. The other files remain pending.
- If no previous copy is cached, Crate shows the file status without a text comparison. Binary and large files show a size summary.

Touched files can remain in the list until sync even if you undo their edits; matching files are labeled **Unchanged**.

Selecting a subset applies to that sync only. It does not permanently ignore files or disable automatic sync. Turn automatic sync off first if you want to control exactly when the remaining files transfer.

The file menu also offers actions to discard local changes. Check the filenames in the confirmation: discarding restores server versions or moves local additions to trash. Use this only when you want to give up those edits; it is not needed to leave a file pending.

## What syncs

Sync includes file creation, edits, deletions, renames, and attachments, with a maximum file size of 25 MiB. Updates to existing binary files require review.

Crate excludes its own plugin folder, workspace state, conflict copies, and common temporary files. Other Obsidian configuration, plugins, and their settings can sync unless excluded. After a successful sync, restart Obsidian to load downloaded plugins and settings. Install and connect Crate separately on every device.

## Keep files local

1. Open **Settings → Crate → Sync → Sync options → Excluded files and folders**.
2. Keep the existing rules you need, and add one pattern per line. A folder pattern ends in `/`; `*` and `?` are supported wildcards.
3. Select **Preview files** to check the matching paths before your next sync.

For example:

```text
Private/
*.psd
.obsidian/plugins/example-plugin/
```

These exclude a folder, Photoshop files, and one plugin's files and settings. Replace `example-plugin` with the actual plugin folder, and use your vault's configuration folder if it is not `.obsidian`. Check plugins that store credentials or device-specific paths. Hidden files are otherwise eligible for sync.

Exclusions are shared with your other Obsidian devices. Adding a rule stops future transfers but keeps existing server copies. To remove those too, select **Review and remove** under **Remove excluded server files** in the same section. Review the listed files before confirming; local files are kept, and removed server copies remain recoverable for 30 days.

## Conflicts and earlier versions

When versions need your input, Crate preserves content for review. [Conflict management](/docs/troubleshooting/conflicts/) explains how to choose or combine versions.

Server file history retains replaced and deleted files for 30 days. Shared checkpoints let you inspect and restore an earlier synced state. See [History and recovery](/docs/troubleshooting/recovery/) before restoring.

Sync carries deletions as well as edits. Keep an independent backup of important notes.
