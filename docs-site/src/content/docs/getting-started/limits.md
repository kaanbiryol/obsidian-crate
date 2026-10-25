---
title: What to know before you start
description: The practical limits of Crate, including background sync, file sizes, offline use, history, and privacy.
---

Crate keeps your notes in your vault and lets you run the server yourself. Here are the limits you're most likely to notice day to day.

:::caution[Crate is in beta]
Try it with a vault you don't depend on yet, and keep a separate backup of your notes. Sync carries deletions as well as edits, so a backup is your safety net.
:::

## Sync needs an open Obsidian app

Crate syncs while Obsidian is open and running. Phones pause apps in the background, and sync pauses with them. Before switching devices, let sync finish on the first one, then sync the second.

**Automatic sync starts off on each device.** Connecting a server doesn't move any files. Run **Crate: Sync now**, or turn on **Settings → Crate → Sync → Automatic sync**.

The web app and scheduled notifications talk to your server directly, so Obsidian can be closed once your notes have synced. If your server runs on your own hardware, it needs to stay awake and online.

## File and storage limits

| Limit | What it means for you |
| --- | --- |
| 25 MB per synced file | Bigger files stay on the device and show up as sync errors. Keep large media outside the synced vault, or exclude it. |
| 1 MB per Reading note | Bigger notes are reported instead of opened in Reading. Shorten the note or read the original source. |
| 1 MB per reminder note in the web app | Bigger notes, or notes with a very large number of reminders, are left out with an explanation. Split them into smaller project notes to edit and schedule them in the web app again. |
| 200 articles or 50 MB in the web app's article cache | Articles you've opened are kept first, then your newest inbox articles. Open the web app while online before going offline so it can catch up. |
| 30 days of server history for replaced or deleted files | Recover promptly. Files that only ever existed on one device may have no server history. |
| Latest 20 checkpoints, for up to 30 days | Checkpoints are saved states of your whole vault you can return to. They cover recent syncs, not an unlimited backup archive. |

Sizes are rounded down, so a file under the listed size always fits. The Reading and reminder limits can apply even when a note is small enough to sync.

<details>
<summary>Good to know about files</summary>

- **Attachments:** new attachments download on their own. When an existing image, PDF, or other attachment changes, you [review it](/docs/troubleshooting/conflicts/#attachments-and-binary-files) before it's replaced.
- **File names have to work on every device.** Names that differ only by capitalization, names Windows reserves, and names ending in a dot or space can block sync. Rename the file named in the error and sync again.
- **With [encryption](/docs/features/encryption/),** files can be nested at most 36 folders deep.

</details>

## Offline access is different in each app

**In Obsidian,** your notes, reminders, and saved article text are always there. Changes sync when you're back online and sync runs, automatically or by hand.

**In the web app,** cached reminders are read-only offline. Reading can queue saves and edits, but downloading new articles needs a connection. Your browser can clear cached data, and signing out clears pending work and drafts. See [offline use and pending saves](/docs/features/web-app/#before-going-offline).

## Some websites can't be saved as full articles

Pages that need a login, block automated downloads, or depend heavily on scripts may stay as bookmarks. YouTube transcripts need captions to exist; videos are streamed, not downloaded.

Keep the link and try again later, or [use Web Clipper](/docs/features/reading/#use-obsidian-web-clipper) to save text you can see in your browser.

## Cloudflare's free daily limits

On Cloudflare's Free plan, the database Crate uses allows 100,000 row writes and 5 million row reads a day. The first upload of a very large vault, or turning on encryption for one (which uploads the whole vault again), can hit the write limit.

If that happens, sync stops with **Cloudflare’s free daily database limit stopped this sync**. Nothing is lost: your changes stay on the device. After 00:00 UTC, sync again or resume encryption setup, and the upload picks up where it stopped.

To see where you stand, open **Settings → Crate → Server and usage → Cloudflare usage**. It compares your usage, including storage, with the free allowances. File storage beyond its free allowance is billed rather than stopped.

## Privacy and backups

**Without [end-to-end encryption](/docs/features/encryption/),** your server can read synced content. **With it,** content and file and folder names are encrypted, but folder structure, approximate sizes, and some scheduling information stay visible. Keep your recovery key outside your vault; Crate can't replace a lost key.

Reading can contact saved websites to fetch article text, icons, or video playback. [Reading's privacy notes](/docs/features/reading/#privacy-and-availability) explain when.

Keep an independent backup, and use [history and recovery](/docs/troubleshooting/recovery/) when you need an earlier version. Cloudflare may charge for usage, and self-hosting means looking after storage, maintenance, and backups yourself.
