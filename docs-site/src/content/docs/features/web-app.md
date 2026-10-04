---
title: Use the web app
description: Install Crate on your phone, use Reading and Reminders outside Obsidian, and understand offline access.
---

The Crate web app gives you Reading and Reminders without opening Obsidian. It runs from your Crate server and can be added to your phone's Home Screen.

Use Obsidian with the Crate plugin when you want your **whole vault**. The web app works with your connected Reading and Reminders folders; it is not a general Obsidian editor.

## Connect for the first time

On a connected Obsidian device, finish a sync, then open **Settings → Crate → Crate web app**. Select **Open app** for this device or **Connect another device** for a QR code and **Copy link** option.

Open the connection link on the receiving device. Keep it private: it grants access to your data. If it expires, create a new link from Obsidian. With encryption, follow the [unlock instructions](/docs/features/encryption/#reading-and-reminders-web-app) if prompted.

After connecting, open a synced reminder or article to check that you are seeing the right vault. Your server must stay available, but Obsidian can close. Some encrypted article downloads still [need an unlocked Obsidian device](/docs/features/reading/#where-articles-are-downloaded).

## Install on your phone

**On iPhone or iPad:** open the connected app in Safari, select **Share → Add to Home Screen**, then open the new icon. The connection handoff lasts ten minutes; use a fresh link if you miss it. The installed app may ask you to unlock encryption again because Safari and the Home Screen app store keys separately.

**On Android:** use your browser's install or add-to-home-screen action, then open Crate from the new icon. The wording depends on the browser. You can also keep using the browser tab.

For alerts, complete [notification setup](/docs/features/notifications/) inside each receiving app. Installing it alone does not enable notifications.

## Make it yours

Open **Settings** from the web app to adjust appearance and preferences. Under **Tabs**, choose **Open app to** and reorder the navigation tabs. For example, choose **Reading** to start in your library, or **Today** to start with your reminders.

These preferences belong to this browser or installed app. The same settings screen serves Reading and Reminders. Their feature switches, folders, and notification schedule are managed in [Obsidian's Crate settings](/docs/features/settings/).

To save links from another app, see the [Reading share options](/docs/features/reading/#read-on-your-phone).

## Before going offline

Open the web app while connected and open the articles you want to read. It keeps a limited offline copy, rather than downloading your entire library.

| Activity | Offline behavior |
| --- | --- |
| View reminders | Previously cached reminders remain readable. |
| Create, edit, or complete a reminder | Reconnect before starting a new change. A previously submitted, unconfirmed change stays pending. |
| Read articles | Opened article text is cached, up to 50 articles or 20 MiB. Older cached articles can be removed as space is needed. |
| Save Reading links or edit cached Reading items | Changes can wait on this device until it reconnects. Downloading new article text needs a connection. |
| Play a saved YouTube video | Requires internet access; Crate does not download videos. Cached transcripts remain readable. |

Browser storage can be cleared by you or the browser. Treat the offline copy as a convenience, and let pending saves finish while the app is open and connected.

## Check a pending save

Open **Settings → Sync** to see the state of both features. Use **Refresh all** to check again. If a change needs review, follow the app's review or retry action and compare it with the confirmed content.

Before clearing browser data or signing out, use **Export Reading data** or **Export unsynced reminders** when offered. A session expiring keeps pending work for recovery; explicitly selecting **Log out and clear device data** clears offline data and drafts for both features on this device.

For a stuck save, expired session, or unavailable cache, use [History and recovery](/docs/troubleshooting/recovery/#pending-work-in-the-web-app).
