---
title: History and recovery
description: Restore a file version or a saved vault state, and preserve pending work in the web app.
---

Choose the smallest recovery that solves the problem: one file, a saved vault state, or pending work on a device.

## Restore a file

Crate retains server versions of replaced and deleted files for 30 days.

1. Open the file's context menu in Obsidian and select **File history**, or run **Crate: Sync - show file history** for the active file.
2. Choose an earlier version and compare it with your current file.
3. Restore the version you want, check the resulting note, then sync.

For a deleted file, look under **Sync activity → History → File history**. Local-only files may have no server history. Also check the vault's `.trash` folder for files removed by remote sync.

## Return to an earlier vault state

Under **Sync activity → History**, select a checkpoint and use **Return to this state**. Review the file-by-file preview before confirming.

The latest 20 shared checkpoints are available across connected devices for up to 30 days. Restoration keeps local recovery copies, and files excluded on the restoring device remain untouched.

If shared checkpoints are unavailable, [update the server](/docs/troubleshooting/updates/) and complete a successful sync. Older local-only checkpoints remain on the device that created them.

Before a broad restore, back up the current vault and let pending browser edits finish. Pause automatic sync on other devices while you inspect and verify the restored state.

## Pending work in the web app

If a save is not confirmed, keep the draft or pending change. Use the app's retry, edit, or review controls instead of repeatedly creating the same item.

When a session needs renewal, reconnect to the same server and folder, review the saved work, and use **Resume saved changes** when offered. Export pending work before clearing browser data.

**Signing out clears cached data, pending changes, and drafts.** It is not the first step for recovering an unconfirmed save.

## Rebuild an offline copy

If the app reports **Offline copy unavailable**, reconnect and close old tabs. Use **Rebuild offline copy** to rebuild the cache while preserving pending changes and drafts. If it still cannot recover, retain any export and record the error before changing storage manually.

## Keep an independent backup

Sync history has a retention window, and sync propagates deletions. Back up important vaults separately.

For a self-hosted server, use the [verified backup and restore commands](/docs/reference/self-hosting/#verified-backups-restore-and-updates). Cloudflare storage recovery requires matching database and file storage; see the [operator recovery runbook](https://github.com/kaanbiryol/obsidian-crate/blob/master/docs/recovery.md).
