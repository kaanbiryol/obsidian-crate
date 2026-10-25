---
title: Choose and manage features
description: Turn Crate features on or off, understand which devices a setting affects, and choose folders and preferences.
---

Crate does several things: vault sync, Reading, and Reminders. Use one, two, or all three. Notifications and encryption are optional extras you can add whenever you like.

Everything lives under **Settings → Crate** in Obsidian. Once a server is connected, expand **Reading**, **Reminders**, or **Notifications** to see their controls. Sync controls are under **Sync**.

## What starts on?

Here's what a new installation looks like. If you connect to a server you already use, its shared settings come along.

| Feature | Starts | Where to change it |
| --- | --- | --- |
| Automatic vault sync | Off on each Obsidian device | **Sync → Automatic sync** |
| Reading | On, using the `Reading` folder | **Reading → Enable reading** |
| Reminders | On, using the `Reminders` folder | **Reminders → Enable reminders** |
| Reminder notifications | Off | **Notifications → Push notifications**, then [register each receiving device](/docs/features/notifications/) |
| End-to-end encryption | Off | **Sync → End-to-end encryption** |

A few common setups:

- **Just sync:** turn off **Enable reading** and **Enable reminders**.
- **Reminders without alerts:** leave Reminders on and **Push notifications** off.
- **Try before you set up a server:** [Reading](/docs/features/reading/#save-your-first-article) and [Reminders](/docs/features/reminders/#create-a-reminder) work locally with their commands and default folders. The settings screen shows feature controls after a server is connected.

## Pause Reading or Reminders

Turn off **Enable reading** or **Enable reminders** in its section. Turn it back on to pick up where you left off. Nothing is deleted:

- Pausing Reading stops scanning and article downloads. Your saved notes stay in your vault.
- Pausing Reminders stops scanning, processing, and notifications. Your tasks stay in your notes.
- Your server connection and vault sync keep working, and resuming needs no new setup.

:::note[These switches affect every device]
They apply to **all devices connected to this server**, so changing them needs a connection. Other devices pick up the change when they next check the server. An offline device keeps its last known setting until it reconnects.
:::

## Pause sync on one device

- **Sync only when you ask:** turn off **Sync → Automatic sync**. You can still run **Crate: Sync now**, and a sync already running can finish.
- **Stop right now:** select **Pause sync** in Sync activity, or run **Crate: Stop sync**. This also turns off automatic sync until you turn it back on.

This only affects this Obsidian device. Other devices, the web app, and notifications carry on. To stop alerts everywhere, turn off **Notifications → Push notifications**.

## Know which settings are shared

Crate labels settings **This device** or **All devices** where it matters.

| Setting | Applies to |
| --- | --- |
| Automatic sync and delay after editing | This Obsidian device |
| Remote check interval and excluded files | Your connected Obsidian devices, through shared settings |
| Reading and Reminders on/off switches | All devices on the server |
| Push notifications, notification folder, timezone, and all-day alert time | The server's alert schedule for all subscribed devices |
| List style, default reminders tab, default due date, startup view, and upcoming range | This Obsidian device |
| Web app theme, tabs, list style, and upcoming range | That browser or installed web app |

Shared changes reach other devices the next time they contact or sync with the server. On a phone, the browser and the Home Screen app can have their own preferences and connections.

## Choose your folders

Use **Reading → Reading folder** and **Reminders → Reminders folder** to tell Crate where to look. Separate folders such as `Reading` and `Reminders` work well; don't put one inside the other. The Reading folder also needs to be visible, outside Obsidian's configuration folder, and not excluded from sync.

:::caution[Changing a folder doesn't move your notes]
Crate just starts looking somewhere else. If you want existing notes in the new folder, move them yourself in Obsidian, check that they show up, then sync.
:::

<details>
<summary>Before you switch folders</summary>

- Let pending Reading saves finish before changing the Reading folder.
- If encryption reports a pending folder change, finish that first.
- Check the folder on your other Obsidian devices, since the server and web app follow the new setting.
- The web app switches to a new reminders folder on its own. Changes it saved for the old folder are kept for you to export instead of being sent.

</details>

## Make the views your own

Under **Reminders**, choose **Default due date**, **Open reminders on startup**, **Default reminders tab**, and **Upcoming range (days)**. These change what you see and the starting values for new reminders; they never reschedule existing tasks.

**Appearance → List style** switches between **Flat** rows and **Cards** for reminders, projects, and Reading. The web app has its own [appearance and tab settings](/docs/features/web-app/#make-it-yours).

Looking for something else? To disconnect a device, see the [device guide](/docs/getting-started/devices/#disconnect-a-device). Turning [encryption off](/docs/features/encryption/#turn-encryption-off) resets your server data, so read that guide first.
