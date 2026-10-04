---
title: Choose and manage features
description: Turn Crate features on or off, understand which devices a setting affects, and choose folders and preferences.
---

You can use Crate for vault sync, Reading, Reminders, or a combination. You do not have to enable notifications or encryption to use the other features.

Open **Settings → Crate** in Obsidian. Once you have connected a server, expand **Reading**, **Reminders**, or **Notifications** to see their controls. Sync controls appear under **Sync**.

## What starts on?

These are the defaults for a new installation. Connecting to an existing server can bring in its shared settings.

| Feature | Default | Where to change it |
| --- | --- | --- |
| Automatic vault sync | Off on each Obsidian device | **Sync → Automatic sync** |
| Reading | On, using the `Reading` folder | **Reading → Enable reading** |
| Reminders | On, using the `Reminders` folder | **Reminders → Enable reminders** |
| Reminder notifications | Off | **Notifications → Push notifications**, then [register each receiving device](/docs/features/notifications/) |
| End-to-end encryption | Off | **Sync → End-to-end encryption** |

If you only want sync, turn off **Enable reading** and **Enable reminders**. If you want reminders without alerts, leave Reminders on and **Push notifications** off.

You can try [Reading](/docs/features/reading/#save-your-first-article) and [Reminders](/docs/features/reminders/#create-a-reminder) locally without a server, using their commands and default folders. The current settings screen shows feature controls after a server is connected.

## Pause Reading or Reminders

Turn off **Enable reading** or **Enable reminders** in its settings section. Turn the same switch on to resume.

- Pausing Reading stops its scanning and article downloads. Saved notes remain in your vault.
- Pausing Reminders stops its scanning, processing, and notification delivery. Existing tasks remain in your notes.
- Both switches keep your server connection and vault sync. Resuming does not require another server setup.

These switches affect **all devices connected to this server**. Changing them requires a connection. Other devices pick up the change when they check the server; an offline device keeps its last confirmed setting until it reconnects.

## Pause sync on one device

Turn off **Sync → Automatic sync** for manual-only syncing on that Obsidian device. You can still run **Crate: Sync - sync now**. A sync already in progress can finish.

To stop a running sync, use **Pause sync** in Sync activity or **Crate: Sync - stop sync**. This also turns automatic sync off; enable it again when you are ready.

This does not pause other devices, the web app, or server notifications. To stop alerts everywhere, turn off **Notifications → Push notifications**.

## Know which settings are shared

Crate labels settings **This device** or **All devices** where applicable.

| Setting | Applies to |
| --- | --- |
| Automatic sync and delay after editing | This Obsidian device |
| Remote check interval and excluded files | Connected Obsidian devices, through shared settings |
| Reading and Reminders on/off switches | All devices on the server |
| Push notifications, notification folder, timezone, and all-day alert time | The server's schedule for all subscribed devices |
| List style, default reminders tab, default due date, startup view, and upcoming range | This Obsidian device |
| Web app theme, tabs, list style, and upcoming range | That browser or installed web app |

Shared changes reach other devices after they contact or sync with the server. A browser and an installed Home Screen app may have separate preferences and connections, even on the same phone.

## Choose your folders

Use **Reading → Reading folder** and **Reminders → Reminders folder** to choose where Crate looks for notes. Start with separate folders such as `Reading` and `Reminders`; neither should be inside the other. Reading also needs a visible folder outside Obsidian's configuration folder and outside your sync exclusions.

Changing a folder setting **does not move existing notes**. Move files deliberately in Obsidian if you want them in the new folder, check that they appear, then sync. Let pending Reading saves finish before changing its folder. If encryption reports a pending folder change, finish that flow before making another change.

Folder changes can affect what the server and web app show. Check the folder on your other Obsidian devices and reconnect the web app if it asks for a fresh link.

## Make the views your own

Under **Reminders**, choose **Default due date**, **Open reminders on startup**, **Default reminders tab**, and **Upcoming range (days)**. These change the view or the starting values for new reminders; they do not reschedule existing tasks.

**Appearance → List style** switches between **Flat** rows and **Cards** for reminders, projects, and Reading. The web app has its own [appearance and tab settings](/docs/features/web-app/#make-it-yours).

To disconnect a device or remove its access, use the [device guide](/docs/getting-started/devices/#disconnect-a-device). Turning [encryption off](/docs/features/encryption/#turn-encryption-off) resets server data; read that guide before proceeding.
