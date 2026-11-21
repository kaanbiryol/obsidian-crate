---
title: Get help
description: Check your connection with diagnostics, turn on debug logs, and report a problem without sharing private notes.
---

Start with the page for what you're seeing: [sync errors](/docs/troubleshooting/sync-errors/), [connection](/docs/troubleshooting/connection/), [conflicts](/docs/troubleshooting/conflicts/), [history and recovery](/docs/troubleshooting/recovery/), [notifications](/docs/troubleshooting/notifications/), or [updates](/docs/troubleshooting/updates/). If that doesn't solve it, these tools help you, or whoever helps you, find the cause.

All of them are in **Settings → Crate → Troubleshooting**.

## Run diagnostics

Select **Run** beside **Run diagnostics**. Crate checks that your server is compatible with this plugin, that this device is still signed in, that the server is healthy, and that it can read your synced file list. The result of each check appears below the button.

To see what happened in recent syncs, run **Crate: Show sync activity** and open **History**. It lists recent syncs with their errors and conflict counts.

## Turn on debug logs

Turn on **Debug logging** to write detailed sync and reminder logs to Obsidian's developer console. On desktop, open the console with **View → Toggle Developer Tools**. Turn it off again when you're done, and check the console output for file names before you share it.

## Repair an unfinished Cloudflare setup

If setting up or updating a Cloudflare server stopped partway, a desktop shows **Repair server**. It finishes the setup without deleting anything already on the server. Reconnect this device when it finishes.

## Report a problem

1. Select **Export** beside **Export diagnostics**. Crate shows a report with versions, sync counts, times, and request IDs. It leaves out note text, file names, credentials, and raw error messages.
2. Read the report before you copy it. Times and counts can still say something about your activity.
3. Open a [bug report on GitHub](https://github.com/kaanbiryol/obsidian-crate/issues/new/choose) and paste the report. Describe the steps in order: which device did what, which was offline, and when each one synced.

Use a made-up note to show the problem, never a note from your vault. Leave out passwords, recovery keys, connection or pairing links, and server logs you haven't checked.

Think you found a security problem? Don't open a public issue. Use [private vulnerability reporting](https://github.com/kaanbiryol/obsidian-crate/security/advisories/new) instead.

:::caution[Keep your data while you wait]
Don't reset your server, turn encryption off, or replace server files just to see whether a problem goes away. If something looks missing, keep each device's vault as it is and check [History and recovery](/docs/troubleshooting/recovery/) first.
:::
