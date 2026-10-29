---
title: Encryption
description: Enable optional end-to-end encryption, connect your devices, and keep your recovery key safe.
---

End-to-end encryption means your server stores only scrambled data. Your devices encrypt notes before uploading them, so not even whoever runs the server can read them. It works on both Cloudflare and self-hosted servers.

Encryption is optional and off by default. Updating Crate never turns it on.

## Enable encryption

### What will happen

Turning encryption on starts the server copy fresh from one device:

1. Crate syncs this device.
2. It deletes everything on the server, including file history and saved checkpoints.
3. It uploads this device's vault, encrypted.
4. Your other devices and web apps are disconnected and need to reconnect with your recovery key.

Your local vault stays ordinary, readable files.

### Before you start

- [ ] Pick the Obsidian device whose vault should become the new server copy.
- [ ] Update Crate on your devices and your server.
- [ ] Sync your other devices, and let web apps finish pending saves, so their changes reach the server.
- [ ] Make a separate backup of your vault.
- [ ] Close other devices and apps that edit the vault until setup finishes.

### Turn it on

1. Open **Settings → Crate → Sync → End-to-end encryption** and select **Enable encryption**.
2. Select **Copy** and save the recovery key somewhere safe outside your vault, such as a password manager.
3. Select **I’ve saved it outside my vault.** Review **What changes with encryption?**, then select **Enable encryption**.
4. Read the confirmation. It lists what will be deleted from the server and which devices must reconnect.
5. Type **encrypt**, then select **Delete server copy and encrypt**.
6. Keep Obsidian open until setup finishes. Sync and notifications pause while Crate replaces the server copy.

:::caution[This deletes the server copy]
Step 5 removes your files, file history, and checkpoints from the server. Make sure every device has synced first, so nothing exists only on the server.
:::

<details>
<summary>If setup stops or is interrupted</summary>

- If this device has sync errors or conflicts, setup stops before deleting anything. Resolve them and try again.
- If a synced file is nested more than 36 folders deep, setup stops before deleting anything. Move it higher and try again.
- If your server is still downloading saved links, setup asks you to wait and try again later.
- If setup is interrupted, select **Retry** in the dialog, or go back to the same settings and select **Resume reset**, then **Resume**. Keep your saved recovery key and this device's Crate configuration until it finishes.

</details>

### After turning encryption on

Your other devices are disconnected. Reconnect each one:

- **Obsidian devices:** open **Settings → Crate → Account and devices**, select **Disconnect this device**, connect again, and [enter your recovery key](#obsidian). Files on those devices are kept and may sync back, so review them first if you want only the first device's contents.
- **Web apps:** select **Log out** and open a fresh setup link. Logging out discards that browser's drafts and pending edits.
- **Notifications:** turn them on again on each device that should receive them.

## Connect another device

### Obsidian

[Connect the device to the same server](/docs/getting-started/devices/#another-obsidian-device), open **Manage encryption** in Crate's Sync settings, and enter your recovery key before syncing.

### Reading and Reminders web app

You can unlock the web app from an Obsidian device, without typing your recovery key:

1. In the web app, select **Connect with Obsidian** on the unlock screen.
2. On an unlocked Obsidian device, open **Settings → Crate → Sync → Manage encryption → Connect web app** and select **Connect**.
3. Compare all three groups of numbers on both screens. Select **Approve** in Obsidian only if they match, then **Confirm and unlock** in the web app after checking the same code.

This passes along the keys that unlock Reading and Reminders, without copying your recovery key. Existing drafts and queued changes are kept. No unlocked Obsidian device nearby? Select **Use recovery key instead**.

On iPhone, Safari and the Home Screen app store keys separately. After installing, open the Home Screen app and pair again if it asks to unlock.

## Keep your recovery key

:::danger[Crate can't recover a lost key]
If you lose your recovery key and every unlocked device, your encrypted server copy is gone for good. Keep the key outside your vault, for example in a password manager.
:::

To save another copy, open **Manage encryption → Recovery key → Copy** on an unlocked Obsidian device.

Only unlock web apps you trust. An unlocked web app holds the vault key, which can decrypt every synced note, not only its Reading and Reminders folders. Encryption can't protect you from a compromised device, or from malicious code served from your web app's address.

Encryption only protects data from now on. Earlier exports, hosting provider snapshots, backups, and copies on other devices stay as they were.

## What stays private

Your notes, attachments, file and folder names, file history, shared settings, reminder text, and notification text are all encrypted. So are Reading articles, links, tags, highlights, and queued saves.

Your server can still see some details about your data, such as folder structure, file sizes, and when reminders are due.

<details>
<summary>Everything the server can still see</summary>

- Folder structure: how deep folders go and how many items each holds
- Which files are Markdown notes
- Exact file sizes and how long each file's full path is
- When files change and sync
- Reminder IDs, whether reminders are complete, and due times
- Notification delivery information
- When a file gets back a name it had before in the same folder
- How long each notification's text is, and whether it changed

Without encryption, your server can also read your synced content.

Encryption stops the server from reading or forging your content, but someone with write access to your server could still bring back an older version of a file or a note you deleted.

</details>

<details>
<summary>How links are fetched with encryption</summary>

When you save an article in the web app, your server downloads it without keeping the link, and the web app encrypts it. In Obsidian, the download happens on your device. Links pasted into reminders work the same way: your server fetches the page title without keeping the link.

</details>

Encrypted names take more room, so files can be nested at most 36 folders deep.

## Turn encryption off

Turning encryption off doesn't decrypt the server copy. Instead, it starts the server copy fresh from one device without encryption:

1. On the Obsidian device whose vault should become the new server copy, open **Manage encryption**.
2. Under **Turn off encryption**, select **Turn off**, and review **Reset sync and turn off encryption**.

:::caution[This deletes the server copy]
Crate syncs this device first and stops if that sync has errors or conflicts. The reset then deletes your server files and file history, and uploads this device's files without encryption. Files this device doesn't sync, such as excluded folders, are lost.
:::

Afterwards, other Obsidian devices must reconnect, and web apps must log out and use a fresh setup link. Save any pending browser work before logging out. Keep your old recovery key for any encrypted backups.

For more detail, see the [privacy policy](/privacy/) and the [encryption implementation reference](https://github.com/kaanbiryol/obsidian-crate/blob/master/docs/e2ee-implementation.md).
