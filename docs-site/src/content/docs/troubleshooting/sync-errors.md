---
title: Sync errors
description: What each sync error means and how to fix it, from files that are too large to a server limit or a device that needs to reconnect.
---

When a sync can't finish, run **Crate: Show sync activity** to see what went wrong. Your files stay on this device while you fix it, and other files keep syncing where they can. Find the message you see below.

## A file can't sync

### This file exceeds the sync size limit

Files over 25 MB, or over your [self-hosted server's limit](/docs/reference/self-hosting/#sync-larger-files), stay on this device. Make the file smaller, or [exclude it from sync](/docs/features/sync/#keep-files-on-one-device), then sync again.

### This file's name or location is not compatible with sync on this device

A name that works on one system can block sync on another:

- Names that differ only by capitalization, such as `Note.md` and `note.md` in the same folder
- Names Windows reserves, such as `CON` or `NUL`, and names ending in a dot or space
- On Windows and Android, names with `< > : " | ? *`

Rename the file on the device where it was created, then sync again.

### Skipped local file nested more than 36 folders deep

Encrypted vaults can't sync files nested that deep. Move the file higher in the vault, then sync again.

## Another device is uploading this vault for the first time

The first device to sync uploads the whole vault, and other devices wait until it finishes. Let it finish, then sync this device again.

If you see this on the device that started the upload, for example after reconnecting it, select **Replace server files** under **Settings → Crate → Server → Advanced server actions** to finish. This replaces the server's files with this device's and deletes files that exist only on the server, so use it only on that device.

If the message says **The first upload of this vault has not finished**, sync on the device that started it, then sync here.

## Cloudflare's free daily database limit stopped this sync

A very large first upload, or turning on encryption for a large vault, can use up the day's database writes on Cloudflare's Free plan. Nothing is lost: your changes stay on this device.

After the limit resets at 00:00 UTC, sync again, or resume encryption setup. The upload picks up where it stopped. **Settings → Crate → Usage** shows today's totals, and Cloudflare's Workers Paid plan removes the daily limit. [Will my vault fit?](/docs/getting-started/limits/#will-my-vault-fit) helps you plan.

## A storage or server limit stopped this sync

Check the free space on this device and **Settings → Crate → Usage**. After freeing space or resolving the limit, sync again. If the message says **This device has run out of storage space**, free space on the device and sync again.

## This device needs to reconnect to sync

Also shown as **This device's sync access is no longer valid**. It usually means this device was disconnected from another device.

Open **Settings → Crate → Account and devices** and select **Reconnect**, then sync again. On your own server, you need a [new pairing code](/docs/getting-started/self-hosting/#add-another-device). If encryption was just turned on or off, follow [those reconnect steps](/docs/features/encryption/#after-turning-encryption-on) instead.

## The server denied this device access

Open **Settings → Crate → Account and devices** and check this device's connection. Reconnect it, then sync again.

## The server is temporarily limiting requests

Wait a minute, then sync again. Your pending changes are retried.

## Crate could not reach the sync server

Also shown as **The sync server could not complete this request**. Check your internet connection and that the server is running. For a server on your own hardware, its address may have changed. See [Connection problems](/docs/troubleshooting/connection/).

## The plugin and server need compatible versions

Update the Crate plugin and your server to the same version, then sync again. See [Updates](/docs/troubleshooting/updates/).

## A file changed or moved while sync was running

Finish editing or moving the file, then sync again. If both versions need keeping, Crate lists them under **Conflicts**; see [Conflict management](/docs/troubleshooting/conflicts/).

## A deletion is waiting for other changes to finish syncing

Fix the other errors listed, then sync again. Crate keeps the server copy until those changes are safe.

## Crate could not finish recovering a previous sync

Keep the vault and Crate's saved sync data as they are. Make sure the device has free space and the server is reachable, then sync again. If it keeps happening, follow [Get help](/docs/troubleshooting/get-help/).

## An incoming version of this file is waiting for review

Another device changed an image, PDF, or other attachment that also exists here. [Review it](/docs/troubleshooting/conflicts/#attachments-and-binary-files) under **Conflicts**. Other files keep syncing meanwhile.

## Reminder notes need attention

These affect reminders only. The note's file still syncs.

| Message | Fix |
| --- | --- |
| **Multiple reminders have the same identifier** | A task was probably copied with its hidden `crate-id` comment. Remove the comment from the copy, or delete the duplicate task, then sync again. |
| **This note is too large to index its reminders** | Split the note into notes of 1 MB or smaller, or [archive completed reminders](/docs/features/reminders/#archive-completed-reminders). |
| **A reminder date or repeat rule could not be read** | Open the note and fix the task's date or repeat rule, then sync again. |
| **A reminder description could not be read** | Back up the note and open it in Source mode. Remove only the broken `crate-desc` comment, keeping the task and its `crate-id`. Add the description again in Crate, then sync. |
| **This note uses a text encoding that reminders cannot read** | Keep a copy, then save the note as UTF-8 and sync again. |

## Something else

Sync again. If the same error comes back, run **Settings → Crate → Troubleshooting → Run diagnostics**, then follow [Get help](/docs/troubleshooting/get-help/). Don't reset your server or replace server files just to clear an error.
