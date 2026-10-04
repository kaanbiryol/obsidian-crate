---
title: Connect your devices
description: Connect another Obsidian vault copy or open the Crate web app for reading and reminders.
---

Use the Obsidian plugin for a full vault on another device. Use the Crate web app for reading and reminders without opening Obsidian.

## Another Obsidian device

1. Finish a sync on your first device.
2. On the other device, open a local vault and [install Crate](/docs/getting-started/installation/). Use an empty vault for a fresh copy, or back up an existing copy before combining changes.
3. Connect to the **same server**. With Cloudflare, select **Connect with Cloudflare** and choose the existing server. With Docker, select **Connect to your server** and use a new [pairing code](/docs/getting-started/self-hosting/#create-another-pairing-code).
4. If encryption is enabled, open **Manage encryption** in Crate’s Sync settings and enter your saved recovery key.
5. Run **Crate: Sync - sync now** and wait for it to finish.
6. Open a note on both devices to confirm your changes have arrived. If both devices edited the same content, [review any conflicts](/docs/troubleshooting/conflicts/).
7. If you want ongoing automatic transfers, enable **Settings → Crate → Sync → Automatic sync** on the new device. It starts off independently on each device.

Use a separate server for each unrelated vault. Connecting two different vaults to the same server combines their files.

## Open the web app

After connecting Obsidian and syncing your vault:

1. Open **Settings → Crate → Crate web app**.
2. Select **Open app** to use this device, or **Connect another device** to show a QR code. **Copy link** gives you the same connection link to open on your other device.
3. Open the link or scan the code on the device you want to connect.

Reading and Reminders share the web app. It connects to your server and works without Obsidian staying open. Connection links provide access to your library and reminders; keep them private.

With encryption enabled, select **Connect with Obsidian** if the app asks to unlock, then approve the matching code on both devices. A recovery key is also supported. Follow the [encryption guide](/docs/features/encryption/#reading-and-reminders-web-app); encrypted article downloads that the browser cannot complete wait for an unlocked Obsidian device.

## Add it to your Home Screen

Use your browser's install action. On iPhone, open the connected app in Safari, then select **Share → Add to Home Screen**. Open the installed app promptly: its installation handoff expires after ten minutes. Generate a fresh connection link if the handoff has expired.

To receive reminders, enable the vault's **Push notifications** setting in Obsidian and register this device in the web app. Follow [Set up notifications](/docs/features/notifications/) for both steps.

See [Use the web app](/docs/features/web-app/) for Android installation, navigation preferences, and everyday use.

## Offline use

Obsidian keeps your local vault available. The web app can show cached reminders and opened article text. Reading saves and edits can wait for reconnection; new reminder changes require a connection.

Before signing out or clearing browser data, review pending work. [Recovery](/docs/troubleshooting/recovery/#pending-work-in-the-web-app) explains how to preserve it.

## Disconnect a device

To stop syncing on the Obsidian device you are using, open **Settings → Crate → Account and devices** and select **Disconnect this device**. Your local files and server data are kept, and other devices stay connected. With encryption, keep your recovery key first: disconnecting removes this device's saved encryption keys.

To remove another device's access, find it under **Account and devices → Connected devices and sessions** and select **Disconnect device** or **Disconnect session**. Browsers and Home Screen apps appear separately, even on the same phone. Removing access does not remotely erase files already stored on that device.

Disconnecting is different from pausing a feature. For a temporary pause, use [feature and sync controls](/docs/features/settings/) instead. To stop only notifications on a phone, [turn its alerts off](/docs/features/notifications/#turn-alerts-off).
