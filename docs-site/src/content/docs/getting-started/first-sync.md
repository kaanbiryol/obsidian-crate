---
title: Your first sync
description: Choose what Crate manages in your vault, run your first sync, and decide whether each device syncs on its own.
prev:
  link: /docs/getting-started/hosting/
  label: Choose your hosting
---

Connecting a server doesn't move any files yet. These steps finish setup on your first device.

## Choose what Crate manages

On the first device you connect, Crate ends setup with **Choose what Crate manages in this vault**. It lists Reminders and Reading with the folder each one uses. Both start off:

- **An empty or new folder** shows what Crate will store there.
- **A folder that already has notes** shows how many notes it has and what turning the feature on changes: Reminders adds a small ID comment to each task and turns dates like "tomorrow" into fixed dates, and Reading adds Crate frontmatter to each note.

Select **Finish** to turn on what you chose. Crate saves the features you turned on for the vault, so devices you connect later turn them on without asking. If you leave both off, the next device you connect asks again. Features you leave off don't change any notes, and closing the step without **Finish** changes nothing. You can change these later in [Crate settings](/docs/features/settings/).

## Run your first sync

1. Open Obsidian's command palette and select **Crate: Sync now**, or select **Sync now** in the **Get started** checklist at the top of Crate settings. On a phone, keep Obsidian open until it finishes.
2. Run **Crate: Show sync activity** and check **History** for errors or conflicts.
3. Open a synced note to make sure it looks right.

A very large first upload on Cloudflare's Free plan can pause at the [daily database limit](/docs/getting-started/limits/#cloudflares-free-daily-limits). Nothing is lost; it picks up where it stopped the next day.

## Let it sync on its own

**Automatic sync** starts off on every device, including each one you connect later. Turn on **Settings → Crate → Sync → Automatic sync** on each device where you want it. [Sync automatically](/docs/features/sync/#sync-automatically) explains when it runs.

Next, [connect your other devices or the web app](/docs/getting-started/devices/).
