---
title: History and recovery
description: Restore a file version or a saved vault state, and preserve pending work in the web app.
---

Lost a change? There's a good chance Crate still has it. Start with the smallest fix: one file, then your whole vault, then unsent work on a device.

## Get back an earlier version of a file

Your server keeps replaced and deleted files for 30 days.

1. In Obsidian, open the file's menu and select **File history**, or run **Crate: Show file sync history** for the open file.
2. Pick an earlier version and compare it with what you have now.
3. Restore the version you want, check the note, then sync.

**Looking for a deleted file?** Open **Sync activity → History → File history**. Also check your vault's `.trash` folder, where files removed by sync from another device end up.

Files that only ever lived on one device may have no server history.

## Put your whole vault back the way it was

Crate saves recent snapshots of your synced vault, called checkpoints.

1. Before you start, back up your current vault and let any unsent web app edits finish.
2. Turn off automatic sync on your other devices while you work.
3. Open **Sync activity → History** and select a checkpoint.
4. Select **Return to this state** and review the file-by-file preview.
5. Confirm, then check the restored vault before turning automatic sync back on elsewhere.

<details>
<summary>Good to know</summary>

- Crate keeps the latest 20 checkpoints, for up to 30 days, and all your connected devices can see them.
- Restoring keeps local recovery copies of what it replaces.
- Files you've excluded on the restoring device aren't touched.
- If no checkpoints show up, [update your server](/docs/troubleshooting/updates/) and complete a successful sync.

</details>

## Pending work in the web app

If the app couldn't confirm a save, your draft or change is still there. Don't create the same item again; use the app's retry, edit, or review controls instead.

If your session needs renewing:

1. Reconnect to the same server and folder.
2. Review your saved work.
3. Select **Resume saved changes** when it's offered.

Export pending work before you clear browser data.

:::caution[Don't sign out to fix a stuck save]
**Signing out clears cached data, pending changes, and drafts.** Try the steps above first.
:::

## The app says "Offline copy unavailable"

1. Reconnect and close any old Crate tabs.
2. Select **Rebuild offline copy**. This rebuilds the app's saved copy and keeps your pending changes and drafts.

If that doesn't fix it, keep any export you have and write down the error before you change browser storage by hand.

## Keep a backup of your own

Crate's history only goes back so far, and deletions sync like any other change. Keep a separate backup of vaults that matter to you.

- **Self-hosted:** use the [verified backup and restore commands](/docs/reference/self-hosting/#verified-backups-restore-and-updates).
- **Cloudflare:** restoring the server's storage means restoring its database and file storage together. See the [operator recovery runbook](https://github.com/kaanbiryol/obsidian-crate/blob/master/docs/recovery.md).
