---
title: Connect your devices
description: Connect another Obsidian vault copy or open the Crate web app for reading and reminders.
---

There are two ways to use Crate on another device:

- **Obsidian with Crate:** your full vault, synced. Best for computers and anywhere you edit notes.
- **The Crate web app:** your reading list and reminders in a browser or on your phone's Home Screen, without Obsidian.

## Another Obsidian device

1. Let a sync finish on your first device.
2. On the other device, open a vault and [install Crate](/docs/getting-started/installation/). Use an empty vault for a fresh copy. If the vault already has notes, back them up first, because they'll be combined with the synced ones.
3. Connect to the **same server**:
   - **Cloudflare:** select **Connect with Cloudflare** and choose the existing server.
   - **Docker:** select **Connect to your server** and use a new [pairing code](/docs/getting-started/self-hosting/#create-another-pairing-code).
4. If you use encryption, open **Manage encryption** in Crate’s Sync settings and enter your recovery key.
5. Run **Crate: Sync now** and wait for it to finish.
6. Open a note on both devices to check that it matches. If both devices changed the same content, [review the conflicts](/docs/troubleshooting/conflicts/).
7. If you want this device to keep syncing on its own, turn on **Settings → Crate → Sync → Automatic sync**. It starts off on every new device.

:::caution[One vault per server]
Connecting two different vaults to the same server merges their files. Give each unrelated vault its own server.
:::

## Open the web app

Once Obsidian is connected and your vault has synced:

1. Open **Settings → Crate → Crate web app**.
2. Select **Open app** to use it on this device, or **Connect another device** to show a QR code. **Copy link** gives you the same link to open elsewhere.
3. Open the link or scan the code on the device you want to connect.

The web app holds both Reading and Reminders. It talks to your server directly, so Obsidian doesn't need to stay open.

Anyone with a connection link can see your library and reminders, so keep links private.

**Using encryption?** If the app asks to unlock, select **Connect with Obsidian** and approve the matching code on both devices, or use your recovery key. See the [encryption guide](/docs/features/encryption/#reading-and-reminders-web-app). Encrypted article downloads the browser can't finish wait until an unlocked Obsidian device is available.

## Add it to your Home Screen

Use your browser's install option. On iPhone, open the connected app in Safari, then select **Share → Add to Home Screen**.

Open the installed app soon afterwards: the handoff from Safari expires after ten minutes. If it does, generate a fresh connection link.

To get reminder alerts, turn on the vault's **Push notifications** setting in Obsidian, then register this device in the web app. [Set up notifications](/docs/features/notifications/) walks through both.

For Android installation, navigation preferences, and everyday use, see [Use the web app](/docs/features/web-app/).

## Offline use

Obsidian always has your local vault. The web app can show cached reminders and articles you've opened. Reading saves and edits wait until you're back online; reminder changes need a connection.

Before signing out or clearing browser data, check for pending work. [Recovery](/docs/troubleshooting/recovery/#pending-work-in-the-web-app) explains how to keep it.

## Disconnect a device

**This device:** open **Settings → Crate → Account and devices** and select **Disconnect this device**. Your local files and server data are kept, and your other devices stay connected. If you use encryption, make sure you have your recovery key first: disconnecting removes this device's saved encryption keys.

**Another device:** find it under **Account and devices → Connected devices and sessions** and select **Disconnect device** or **Disconnect session**. Browsers and Home Screen apps are listed separately, even on the same phone. Disconnecting removes access but doesn't erase files already on that device.

Just want a break? [Pause a feature or sync](/docs/features/settings/) instead. To stop only notifications on a phone, [turn its alerts off](/docs/features/notifications/#turn-alerts-off).
