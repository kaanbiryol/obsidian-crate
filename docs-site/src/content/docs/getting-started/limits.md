---
title: Limits
description: File sizes, history, Reading, reminders, the web app, codes, Cloudflare's free allowances, and what changes with encryption, on a phone, or on a self-hosted server, in one place.
---

The numbers Crate works within. Feature guides link here when a limit applies.

## Files and notes

| Limit | What happens |
| --- | --- |
| 25 MB per synced file | Bigger files stay on the device and show up as sync errors. Keep large media outside the vault, or [exclude it](/docs/features/sync/#keep-files-on-one-device). A [self-hosted server](/docs/reference/self-hosting/#sync-larger-files) can allow up to 1 GB on desktop (128 MB in encrypted vaults and for Markdown notes). |
| 1 MB or 20,000 lines for merging | When two devices change a bigger note, Crate keeps both versions as a [conflict](/docs/troubleshooting/conflicts/) instead of combining them. |
| 1 MB per Reading note | Bigger notes are reported instead of opened in Reading. Shorten the note or read the original source. |
| 1 MB or 10,000 reminders per reminder note | Bigger notes are left out of the web app with an explanation, and their reminders send no alerts. They still work in Obsidian. [Archive completed reminders](/docs/features/reminders/#archive-completed-reminders) or split the note into smaller projects. |
| 256 KB for comparisons | History, restore and pending-change previews show the differences for Markdown files up to 256 KB. Larger files and attachments can still be restored, without a preview. |

Sizes are rounded down, so a file under the listed size always fits. The Reading and reminder limits can apply even when a note is small enough to sync.

File names also have to work on every device. [Sync errors](/docs/troubleshooting/sync-errors/#this-files-name-or-location-is-not-compatible-with-sync-on-this-device) lists the names that can block sync.

## History

| Limit | What it means for you |
| --- | --- |
| 30 days of server history by default | Replaced and deleted files are kept this long. Choose 7, 14, 30, 60 or 90 days under **Sync options → Keep history for**. |
| About one version every 10 minutes while editing | Crate keeps the version from before you started editing and the first version of a new file, then about one every 10 minutes. Not every save is kept. |
| Checkpoints every 10 minutes while you edit | Saved states of your whole vault: every one from the last day, one per hour for the past week, then one per day for the rest of your history period. They aren't an unlimited backup archive. |

Files that only ever existed on one device may have no server history. [History and recovery](/docs/troubleshooting/recovery/) shows how to restore.

## Reading

An article page larger than 2 MB, or one that takes longer than 15 seconds to download, is kept as a link instead of a full article. In the web app, duplicate clips of the same page are hidden, so **Review duplicate sources** and **Fill empty bookmark** are only in Obsidian.

### Reading images

| Saved by | Limit |
| --- | --- |
| Obsidian | Every image in the article, up to 10 MB each and 40 MB in all |
| Your server | The first 10 images, up to 5 MB each and 20 MB in all |
| Your server, encrypted vault | The first 10 images, up to 2 MB each and 8 MB in all |

Crate saves PNG, JPEG, GIF, WebP and AVIF images, never SVG. An image that is too large or fails to download keeps its link.

## Reminders and alerts

| Limit | What it means for you |
| --- | --- |
| 1,024 characters per title, 4,096 per description | Crate refuses to save a longer title or description. |
| Daily, weekly or monthly repeats | There's no yearly repeat. |
| Only open reminders reorder | Completed reminders, and reminders nested under another task, keep their place. |
| Alerts more than 24 hours late are dropped | If your server or device was off past a reminder's time, it doesn't send that alert later. |
| Alerts for a very large reminders folder can take days to set up on Cloudflare | When you first turn reminders on, setting up alerts is paced to Cloudflare's [free daily limits](#cloudflares-free-daily-limits). Reminders you edit get alerts right away. Self-hosted servers have no such pacing. |

## Web app

| Limit | What it means for you |
| --- | --- |
| Connections last 90 days | After that, the web app says the session expired. Open a fresh link from Crate. The iPhone shortcut stops working at the same time as the web app connection it was paired from. |
| 20 notification devices per vault, 5 per web app | Remove an old one under **Settings → Crate → Notifications → Notification devices** before adding another. |
| Notifications need a supported browser | Alerts are delivered through Apple, Google, Mozilla or Microsoft push services. On iPhone and iPad, add the web app to the Home Screen first. |
| A current Safari, Chrome or Firefox | Older browsers without Web Locks can read your library and reminders but can't send changes. |
| Request limits | Each web app connection can make 500 Reading requests a day, and per minute it can save 30 links, select **Try again** 10 times and send 3 test notifications. Past that, it asks you to try again later. |

## On a phone or tablet

- **Server changes need a desktop.** Creating, updating, repairing, restoring or deleting a Cloudflare server is only available in Obsidian on a desktop. Phones and tablets connect to an existing server.
- **Files open in Obsidian only.** Crate can't reveal a file in the phone's file manager or open a conflicting attachment in another app; compare it in Crate instead.
- **Desktop notifications are desktop only.** On a phone, reminder alerts come through the [web app](/docs/features/notifications/).

## On a self-hosted server

Self-hosted servers have some higher limits: files up to 1 GB on desktop, and history of 180 or 365 days. See [Other self-hosted limits](/docs/reference/self-hosting/#other-self-hosted-limits).

- **A Quick Tunnel address changes every time Crate restarts.** Update the address on each device and connect the web app again. Use a [named tunnel or Tailscale Funnel](/docs/reference/self-hosting/#quick-tunnel) for a stable address.
- **Cloudflare Tunnel caps one request at 100 MB.** Encrypted files and Markdown notes travel in one request, so over a tunnel they can sync only up to 100 MB.

## Codes and links

Pairing codes and **Add a device** codes work once and expire after 10 minutes. Web app connection links also expire after 10 minutes, and so does the handoff from Safari to a newly installed Home Screen app. Create a fresh one if it expires.

## Cloudflare's free daily limits

On Cloudflare's Free plan, the database Crate uses allows 100,000 row writes and 5 million row reads a day. The first upload of a very large vault, or turning on encryption for one (which uploads the whole vault again), can hit the write limit. To stay within it, Crate also paces background work: removing expired history and setting up alerts for a large reminders folder can take more than a day.

If that happens, nothing is lost: the upload picks up where it stopped after the limit resets at 00:00 UTC. See [the daily limit error](/docs/troubleshooting/sync-errors/#cloudflares-free-daily-database-limit-stopped-this-sync).

### Will my vault fit?

As a guide, a vault of 50,000 notes and 5 GB of PDFs uploads within one day of the free limits, with or without encryption. Its first upload uses about two-thirds of the day's database writes and just over half of its reads. The number of files matters more than their size: about 90,000 files fit in a day, fewer when many of them are larger than 1 MB.

File storage includes 10 GB a month for free. Your vault counts toward it, and so does server history. A shorter history period uses less, and [encryption](#with-encryption) uses more.

To see where you stand, open **Settings → Crate → Usage** and select **Refresh**. It compares your usage, including storage, with the free allowances. File storage beyond its free allowance is billed rather than stopped.

## With encryption

[End-to-end encryption](/docs/features/encryption/) changes a few limits and behaviors. Everything else on this page applies to encrypted vaults too.

| Difference | What it means for you |
| --- | --- |
| 36 folders deep | Encrypted names take more room. Encryption setup stops if a synced file is nested deeper, and deeper files created later don't sync. |
| About a third more storage | Stored files are larger, so a 5 GB vault uses about 7 GB of file storage. |
| Turning it on uploads the whole vault again | A large vault can reach [Cloudflare's daily write limit](#cloudflares-free-daily-limits). Setup picks up where it stopped after 00:00 UTC. |
| Smaller article images from your server | When your server downloads an article, it keeps smaller images. See [Reading images](#reading-images). |
| No iPhone shortcut | **Save to Crate** can't encrypt notes, so encrypted vaults don't offer it. Save links in the web app or in Obsidian. |
| Your server never downloads articles on its own | Without encryption, the server retries failed downloads and fills in saved links later. In an encrypted vault it only downloads while you save in the web app; a link that fails stays a link until a device selects **Try again**. |
| **Try again** in the web app brings back text, not images | Select **Try again** in Obsidian to save the article's images too. |
| Alerts can show generic text | When the browser can't unlock the alert in time, for example in Safari when the keys are in the Home Screen app, it reads "Crate reminder". Open Crate to see which one. |
| Alerts need smaller project notes | A project note with too many reminders stops sending encrypted alerts until you split it into smaller projects. Its reminders stay readable and editable. |
| Crate updates install without asking | Other devices install a Crate update on their next sync. See [Crate updates](/docs/features/sync/#crate-updates). |
| Keys can't be changed | There's no way to replace your recovery key or the keys that encrypt your notes. Disconnecting a device or web app removes its access to the server, not keys it already has. |
| Turning it off resets the server | The server copy and its history are deleted, then one device uploads its vault without encryption. See [Turn encryption off](/docs/features/encryption/#turn-encryption-off). |
| Older versions can come back | Your server can't read or change your notes, but someone who controls it could bring back an older version of a file or a note you deleted. |

## Other limits

- **Sync runs only while Obsidian is open.** Phones pause it in the background. See [Sync automatically](/docs/features/sync/#sync-automatically).
- **Web app search matches article titles.** Each word you type matches the start of a word in a title, and words of one or two letters match only whole words. In the **Highlights** tab it also matches highlight text, notes and tags. Search notes and authors in Obsidian.
- **Some websites can't be saved as full articles.** See [When a page won't download](/docs/features/reading/#when-a-page-wont-download).
- **The web app is limited offline.** See [Before going offline](/docs/features/web-app/#before-going-offline).
