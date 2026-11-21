---
title: Connect your devices
description: Connect another Obsidian vault copy or open the Crate web app for reading and reminders.
---

There are two ways to use Crate on another device:

- **Obsidian with Crate:** your full vault, synced. Best for computers and anywhere you edit notes.
- **The Crate web app:** your reading list and reminders in a browser or on your phone's Home Screen, without Obsidian.

## Another Obsidian device

1. Let a sync finish on your first device.
2. On the other device, open a vault and [install Crate](/docs/getting-started/installation/). Use an empty vault for a fresh copy. If the vault already has files and the server does too, Crate asks before replacing them: everything in the vault moves to Obsidian's `.trash` folder and the server's contents download.
3. Connect to the **same server**:
   - **Cloudflare:** on your first device (one that has your Cloudflare sign-in saved), open **Settings → Crate → Account and devices** and select **Add a device**. Scan the code on the new device, or paste the link into **Pairing link** in Crate settings there, then select **Connect**.
   - **Your own server:** on the server computer, run the `pair` command from [Add another device](/docs/getting-started/self-hosting/#add-another-device). Scan its QR code with the new device, or open its link there, then select **Connect**. **Settings → Crate → Account and devices → Add a device** shows the right command.
4. Using encryption? [Unlock the new device](/docs/features/encryption/#obsidian) before it syncs.
5. Run **Crate: Sync now**, then open a note on both devices to check that it matches.

The new device turns on the features your first device [chose for this vault](/docs/getting-started/first-sync/#choose-what-crate-manages), or asks if no device has chosen yet. **Automatic sync** starts off; [turn it on](/docs/features/sync/#sync-automatically) if you want it.

Each unrelated vault needs [its own server](/docs/getting-started/hosting/#one-server-for-each-vault).

<details>
<summary>If the new device doesn't connect</summary>

- **The code expired:** **Add a device** codes work once and expire after 10 minutes. Select **Add a device** again. You can also select **Connect with Cloudflare** on the new device and choose the existing server; on a phone or tablet, select **Open Cloudflare** in the connection dialog first.
- **"Another device is uploading this vault for the first time":** let the first device finish its sync. If you see this on the device that started the upload, see [Sync errors](/docs/troubleshooting/sync-errors/#another-device-is-uploading-this-vault-for-the-first-time).
- **Both devices changed the same note:** [review the conflicts](/docs/troubleshooting/conflicts/).

</details>

## Open the web app

Once your vault has synced, open **Settings → Crate → Crate web app** and select **Open app**, or **Set up on phone** to show a QR code. The web app holds your reading list and reminders and talks to your server directly, so Obsidian doesn't need to stay open.

[Use the web app](/docs/features/web-app/) covers connecting, installing it on your phone, and offline use.

## Disconnect a device

**This device:** open **Settings → Crate → Account and devices** and select **Disconnect this device**. Your local files and server data are kept, and your other devices stay connected. On a Cloudflare server, Crate remembers the server so you can reconnect; select **Forget saved connection** in the confirmation if you don't want that. On a Docker server, disconnecting also removes this device's access, so you need a [new pairing code](/docs/getting-started/self-hosting/#add-another-device) to reconnect. If you use encryption, make sure you have your recovery key first: disconnecting removes this device's saved encryption keys.

**Another device:** find it under **Account and devices → Connected devices and sessions** and select **Disconnect device**, **Disconnect session** or **Disconnect shortcut**. Browsers and Home Screen apps are listed separately, even on the same phone. A disconnected iPhone shortcut needs pairing again. Disconnecting removes access but doesn't erase files already on that device.

Just want a break? [Pause a feature or sync](/docs/features/settings/) instead. To stop only notifications on a phone, [turn its alerts off](/docs/features/notifications/#turn-alerts-off).
