---
title: Settings
description: Turn Crate features on or off, pause them, choose folders, and look up every setting, what it affects, and its default.
---

Crate does several things: vault sync, Reading, and Reminders. Use one, two, or all three. Notifications and encryption are optional extras you can add whenever you like.

Everything lives under **Settings → Crate** in Obsidian. Expand **Reading** or **Reminders** under **Features** to see their controls, with or without a server. **Sync**, **Crate web app** and **Appearance** appear once a server is connected, and **Notifications** once Reminders is on too.

## Choose your features

Everything starts off: automatic sync, Reading, Reminders, notifications, and encryption. If you connect to a server you already use, its shared settings come along.

Reading and Reminders change the notes in their folders: Reading adds properties to every Markdown note in the `Reading` folder, and Reminders adds hidden tracking IDs to checkboxes in the `Reminders` folder. That's why neither starts on its own. When you turn one on, Crate names the folder it will use and asks first. To use a different folder, change **Reading folder** or **Reminders folder** before turning the feature on.

A few common setups:

- **Just sync:** leave **Enable reading** and **Enable reminders** off.
- **Reminders without alerts:** turn on Reminders and leave **Push notifications** off.
- **Try before you set up a server:** turn on [Reading](/docs/features/reading/#save-your-first-article) or [Reminders](/docs/features/reminders/#create-a-reminder). Both work locally with their commands.

## Pause Reading or Reminders

Turn off **Enable reading** or **Enable reminders** in its section. Turn it back on to pick up where you left off. Nothing is deleted:

- Pausing Reading stops scanning and article downloads. Your saved notes stay in your vault.
- Pausing Reminders stops scanning, processing, and notifications. Your tasks stay in your notes.
- Your server connection and vault sync keep working, and resuming needs no new setup.

:::note[These switches affect every device]
They apply to **all devices connected to this server**, so changing them needs a connection. Other devices pick up the change when they next check the server. An offline device keeps its last known setting until it reconnects.

When you connect the first device, you choose these in the last setup step, [Choose what Crate manages in this vault](/docs/getting-started/first-sync/#choose-what-crate-manages).
:::

## Pause sync on one device

Turn off **Sync → Automatic sync**, or run **Crate: Stop sync** to stop right away. Both affect only this device. [Take a break from syncing](/docs/features/sync/#take-a-break-from-syncing) explains the difference.

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

## All settings

**Applies to** matches the **This device** or **All devices** label Crate shows next to each setting. Shared changes reach other devices the next time they contact or sync with the server.

### Sync

Appears once a server is connected. **Sync options** holds everything except **Automatic sync** and encryption.

| Setting | What it does | Applies to | Default |
| --- | --- | --- | --- |
| **Automatic sync** | Syncs after edits, on startup and resume, and at the check interval. Turning it off lets a running sync finish. | This device | Off |
| **Sync delay after editing (seconds)** | How long to wait after a change before syncing. 0 syncs right away. | This device | 5 |
| **Check for remote changes** | How often to look for edits from your other devices: **Off**, 1, 5 or 15 minutes, or a custom number of seconds. With automatic sync off, changes found show as **Changes on server** and are not synced. | All devices | 5 minutes |
| **Sync Crate updates** | Shares the Crate version installed here with your other devices and installs newer ones they share. See [Crate updates](/docs/features/sync/#crate-updates). | This device | On |
| **Keep history for** | How long the server keeps earlier file versions and saved vault states: 7, 14, 30, 60 or 90 days, and also 180 or 365 on a [self-hosted server](/docs/reference/self-hosting/#other-self-hosted-limits). | All devices | 30 days |
| **Excluded files and folders** | Files that stay local, one pattern per line. See [Keep files on one device](/docs/features/sync/#keep-files-on-one-device). | All devices | Common temporary and system files, such as `.git/`, `.trash/` and `.DS_Store` |
| **Remove excluded server files** | Removes server copies of files you've since excluded. | All devices | - |
| **End-to-end encryption** | Turns encryption on or off and manages keys. See [Encryption](/docs/features/encryption/). | All devices | Off |

### Crate web app and Appearance

| Setting | What it does | Applies to | Default |
| --- | --- | --- | --- |
| **Crate web app** | Opens the web app here, or shows a QR code or link to connect another device. See [Use the web app](/docs/features/web-app/). | - | - |
| **Appearance → List style** | **Flat** rows or **Cards** for reminders, projects, and Reading, including reminders in notes. | This device | Flat |

### Reminders

Under **Features → Reminders**.

| Setting | What it does | Applies to | Default |
| --- | --- | --- | --- |
| **Enable reminders** | Pauses or resumes reminders and their notifications. Notes and vault sync are kept. | All devices | Off |
| **Reminders folder** | Where Crate looks for reminders. Changing it doesn't move notes; see [Choose your folders](#choose-your-folders). | This device; the server and web app follow it | `Reminders` |
| **Default due date** | The date filled in for new reminders: **None**, **Today** or **Tomorrow**. | This device | None |
| **Open reminders on startup** | Opens the reminders view when Obsidian starts. | This device | Off |
| **Default reminders tab** | The tab the reminders view opens to. | This device | Inbox |
| **Upcoming range (days)** | How many days ahead the Upcoming view shows. | This device | 7 |
| **Desktop notifications** | Shows reminder alerts from Obsidian on this computer while it's open. See [Desktop notifications without a server](/docs/features/notifications/#desktop-notifications-without-a-server). | This device | On |
| **All-day notification time** | When reminders with a date but no time alert. Here only without a server; with one, it's under **Notifications**. | This device | Empty, so they don't alert |

### Reading

Under **Features → Reading**.

| Setting | What it does | Applies to | Default |
| --- | --- | --- | --- |
| **Enable reading** | Pauses or resumes Reading and article downloads. | All devices | Off |
| **Reading folder** | Where Crate looks for Reading notes. Changing it doesn't move notes. | This device; the server and web app follow it | `Reading` |
| **Article images** | **Save in the vault** or **Load from the website**, for articles saved from then on. See [Article images](/docs/features/reading/#article-images). | All devices | Save in the vault |

### Notifications

Appears once a server is connected and Reminders is on. See [Set up notifications](/docs/features/notifications/).

| Setting | What it does | Applies to | Default |
| --- | --- | --- | --- |
| **Push notifications** | Sends reminder alerts to subscribed phones and browsers. | All devices | Off |
| **Notification folder and timezone** | The reminders folder and timezone the server schedules alerts with. **Use this device’s settings** copies this device's. | All devices | - |
| **All-day notification time** | When reminders with a date but no time alert. Leave empty to skip them. | All devices | Empty |
| **Notification devices** | Lists subscribed devices, and removes ones you no longer use. | - | - |
| **Test notification** | Sends a test alert to every subscribed device. | - | - |

### Management

| Setting | What it does |
| --- | --- |
| **Account and devices → Add a device** | Shows a one-time code or link to connect another Obsidian device. See [Connect your devices](/docs/getting-started/devices/). |
| **Account and devices → Connected devices and sessions** | Lists devices, browsers and shortcuts with access, and disconnects them. |
| **Account and devices → Disconnect this device** | Stops sync here and keeps your files. See [Disconnect a device](/docs/getting-started/devices/#disconnect-a-device). |
| **Usage** | Cloudflare's usage estimates compared with the free allowances. See [Cloudflare's free daily limits](/docs/getting-started/limits/#cloudflares-free-daily-limits). |
| **Server → Update server address** | Points this device at a server's new address. |
| **Server → Server backup recovery** | Restores a Cloudflare server backup as a separate server. See [Keep a backup of your own](/docs/troubleshooting/recovery/#keep-a-backup-of-your-own). |
| **Server → Advanced server actions** | **Replace server files** and **Delete server and all data**. Both remove data for good; read [Move or remove Crate](/docs/features/move-or-remove/) first. |
| **Troubleshooting** | **Run diagnostics**, **Export diagnostics** and **Debug logging**. See [Get help](/docs/troubleshooting/get-help/). |

### Web app settings

Open **Settings** in the web app. Its theme, tabs, list style and **Open app to** belong to that browser or installed app; on a phone, the browser and the Home Screen app keep their own. Feature switches, folders and the notification schedule are managed in Obsidian. See [Make it yours](/docs/features/web-app/#make-it-yours).
