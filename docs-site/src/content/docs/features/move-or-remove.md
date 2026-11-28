---
title: Move or remove Crate
description: Move your vault to a different server, delete a server you no longer use, or uninstall Crate and keep your notes.
---

Your notes are ordinary files in your vault, so moving servers or removing Crate never deletes them from your devices. Read the steps through first: some actions delete server data for good.

## Move to a different server

Use this to switch between Cloudflare and your own hardware, or to start over on a new server. Crate doesn't copy anything between servers. The new server starts empty, and your devices fill it.

1. Sync every Obsidian device, and let the web app finish any pending saves.
2. Make a separate backup of your vault.
3. On each Obsidian device, open **Settings → Crate → Account and devices** and select **Disconnect this device**. If it was connected to Cloudflare, also select **Forget saved connection**.
4. Set up the new server with [Cloudflare](/docs/getting-started/cloudflare/) or [Docker](/docs/getting-started/self-hosting/).
5. Connect the device whose vault is most complete first, then run **Crate: Sync now**. It uploads the whole vault.
6. Connect your other devices. Because the server now has files, Crate asks to replace each vault with the server's contents; the replaced files go to the vault's `.trash` folder.
7. Open a fresh link in each web app, and turn notifications on again on each device that should get alerts.

Some things stay behind on the old server: file history, saved vault states, device connections, and the record of which reminders already alerted.

**Using encryption?** The new server starts without it. On the first device, sync stops because the server isn't encrypted. Select **Enable encryption** in Crate's Sync settings, then **Turn on encryption**. This creates new keys and a new recovery key, so save the new key. Your old recovery key only opens backups of the old server.

## Delete a Cloudflare server

This permanently deletes the server and everything stored on it: files, history, the web app, and device connections. Your local vault files, other Crate servers, and unrelated Cloudflare resources are kept.

1. Sync every device you want to keep using, and back up your vault.
2. On a desktop connected with your Cloudflare account, open **Settings → Crate → Server → Advanced server actions** and select **Delete server and all data**. Devices added with a code from **Add a device** don't show this option.
3. Check the account, server, database, and bucket names shown, type **delete**, and select **Delete server**.

On a disconnected device, **Advanced server actions** appears at the bottom of Crate settings instead. If the deletion is interrupted, the same place offers **Resume server deletion**.

## Delete a Docker or local server

Stop the server and remove its data. With Docker, run this from the repository folder:

```sh
docker compose down --volumes
```

This deletes the server's files, history, and settings for good. Use the same `-p` project name if you started it with one, and keep any backups you still want first. For a server you started with Node, delete its data directory; [Data and additional devices](/docs/reference/self-hosting/#data-and-additional-devices) shows where it is.

## Uninstall Crate

1. If you use encryption, save your recovery key outside the vault first. Disconnecting removes this device's saved encryption keys.
2. In **Settings → Crate → Account and devices**, select **Disconnect this device**.
   - **Cloudflare server:** in the dialog, also select **Forget saved connection**, then **Disconnect**. Without it, the device keeps its Cloudflare sign-in in Obsidian's secret storage after Crate is gone. If you already disconnected, select **Forget saved connection** in Crate settings instead.
   - **Your own server:** select **Disconnect**. Crate revokes the device's access token if the server is reachable.
3. Open **Settings → Community plugins**, find **Crate**, and uninstall it.

Your notes stay as they are. A few traces of Crate remain in them, all harmless:

- **Reminders:** each checkbox line in your reminders folder keeps a hidden comment such as `<!-- crate-id:abc123 -->`. Reading view hides it. To remove them, search the folder for `<!-- crate-id:` and delete the comments.
- **Reading:** notes in your Reading folder keep their `crate_reading_` properties, and saved article images stay in its `attachments` folder.
- **Conflict copies:** files named `… (conflict <date>).md` are ordinary notes. Delete them once you've kept what you need.

Uninstalling on one device doesn't affect your other devices or your server. To stop using Crate everywhere, first [delete the server](#delete-a-cloudflare-server) from a device that can still reach it, then uninstall Crate on each device.
