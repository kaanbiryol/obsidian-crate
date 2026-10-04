---
title: Connect your devices
description: Connect another Obsidian vault copy or open the Crate web app for reading and reminders.
---

Use the Obsidian plugin for a full vault on another device. Use the Crate web app for reading and reminders without opening Obsidian.

## Another Obsidian device

1. Finish a sync on your first device.
2. On the other device, open a local vault and [install Crate](/docs/getting-started/installation/). Use an empty vault for a fresh copy, or back up an existing copy before combining changes.
3. Connect to the **same server**. With Cloudflare, select **Connect with Cloudflare** and choose the existing server. With Docker, select **Connect to your server** and use a new [pairing code](/docs/reference/self-hosting/#storage-and-lifecycle).
4. If encryption is enabled, open **Manage encryption** in Crate’s Sync settings and enter your saved recovery key.
5. Run **Crate: Sync - sync now** and wait for it to finish.
6. Open a note on both devices to confirm your changes have arrived. If both devices edited the same content, [review any conflicts](/docs/troubleshooting/conflicts/).

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

To receive reminders, enable **Push notifications** in the app and allow notifications when the device asks. See [Notifications](/docs/troubleshooting/notifications/) if registration does not complete.

## Offline use

Obsidian keeps your local vault available. The web app can show cached reminders and opened article text. Reading saves and edits can wait for reconnection; new reminder changes require a connection.

Before signing out or clearing browser data, review pending work. [Recovery](/docs/troubleshooting/recovery/#pending-work-in-the-web-app) explains how to preserve it.
