---
title: What to know before you start
description: The practical limits of Crate, including background sync, file sizes, offline use, history, and privacy.
---

Crate keeps your notes in your vault and lets you run the server yourself. These are the limits most likely to affect everyday use.

## Sync needs an open Obsidian app

The plugin syncs while Obsidian is running and able to work. Do not rely on a phone completing sync after Obsidian has been closed or suspended. Before switching devices, let sync finish on the first one, then sync the second.

**Automatic sync starts off on each device.** Enable it in **Settings → Crate → Sync**, or use **Crate: Sync - sync now**. Connecting a server does not perform your first file transfer.

The web app and scheduled notifications use your server directly, so Obsidian can be closed after the relevant notes have synced. A server on your own hardware must stay awake and online.

## File and storage limits

| Limit | What it means for you |
| --- | --- |
| 25 MiB per synced file | Larger files stay on the device and appear as sync errors. Keep large media outside the synced vault or exclude it. |
| 1 MiB per Reading note | Oversized notes are reported instead of opened in Reading. Keep a shorter note or read the original source. |
| 1 MiB per reminder note for the web app | Oversized notes, or notes with too much parsed reminder data, are omitted with an explanation. Split them into smaller project notes to restore web editing and scheduling. |
| 50 opened articles or 20 MiB in the web app's article cache | Open articles before going offline. The entire library is not kept offline. |
| 30 days of replaced or deleted server file versions | Recover promptly. Local-only files may have no server history. |
| Latest 20 shared checkpoints, for up to 30 days | Checkpoints cover recent synced states, not an unlimited backup archive. |

MiB is a file-size unit: 1 MiB is 1,048,576 bytes, roughly one megabyte. The separate Reading and reminder limits can apply even when a note is small enough for ordinary vault sync.

Updated attachments such as PDFs and images require [conflict review](/docs/troubleshooting/conflicts/#attachments-and-binary-files). New attachments can download automatically. File names also need to work across devices: names differing only by capitalization, Windows-reserved names, and trailing dots or spaces can block sync. Rename files identified in an error and retry.

## Offline access is different in each app

In Obsidian, your local notes, reminders, and saved article text remain available. Changes sync when you reconnect and run sync, automatically or manually.

In the web app, cached reminders are read-only offline. Reading can queue saves and edits, but new article downloads need a connection. The browser can remove cached data, and signing out clears pending work and drafts. See [offline use and pending saves](/docs/features/web-app/#before-going-offline).

## Some websites cannot be saved as full articles

Pages requiring a login, restricting automated downloads, or relying heavily on scripts may remain bookmarks. Encryption can also mean a web app save waits for an unlocked Obsidian device to download it. YouTube transcripts depend on available captions; videos are streamed, not downloaded.

Keep the saved link, retry when connected, or [use Web Clipper](/docs/features/reading/#use-obsidian-web-clipper) to save text you can access in your browser.

## Privacy and backups

Without [end-to-end encryption](/docs/features/encryption/), your server can read synced content. With it, content is encrypted, but file paths, approximate sizes, and some scheduling information remain visible. Keep the recovery key outside your vault; Crate cannot replace a lost key.

Reading can contact saved websites for article text, favicons, or video playback. [Reading's privacy notes](/docs/features/reading/#privacy-and-availability) explain when that happens.

Sync carries deletions as well as edits. Keep an independent backup, and use [history and recovery](/docs/troubleshooting/recovery/) when you need an earlier version. Cloudflare usage charges can apply; self-hosting also needs storage, maintenance, and backups. Crate is currently beta software, so try it with a non-critical vault first.
