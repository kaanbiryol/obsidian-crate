---
title: Encryption
description: Enable optional end-to-end encryption, connect your devices, and keep your recovery key safe.
---

Crate offers optional end-to-end encryption on both Cloudflare and self-hosted servers. Your devices encrypt synced content before uploading it. Encryption is off by default; updating Crate does not enable it.

## Enable encryption

Turning encryption on replaces the server copy. Crate syncs this device first, then deletes the server's files, retained history and checkpoints and uploads this device's vault encrypted. Use the Obsidian device whose vault should become the new server copy.

1. Update the plugin and server. Sync your other devices and let web apps finish pending saves so their changes reach the server. Keep an independent backup, and close other editing clients until setup finishes.
2. Open **Settings → Crate → Sync → End-to-end encryption** and select **Enable encryption**.
3. Select **Copy** and save the recovery key somewhere safe outside your vault, such as a password manager.
4. Select **I’ve saved it outside my vault.** Review **What changes with encryption?**, then select **Enable encryption**.
5. Keep Obsidian open until setup finishes. Sync and notifications pause while Crate replaces the server copy.

If this device's sync has errors or conflicts, setup stops before deleting anything; resolve them and try again. If your server is still downloading saved links, setup asks you to wait and try again later. If setup is interrupted, select **Retry** in the dialog, or return to the same settings and select **Resume reset**, then **Resume**. Keep the saved recovery key and this device’s Crate configuration.

Your local Obsidian vault stays readable as ordinary files.

### After turning encryption on

Other Obsidian devices and web apps are disconnected. On each Obsidian device, open **Settings → Crate → Account and devices**, select **Disconnect this device**, connect again, and [enter your recovery key](#obsidian). Files on those devices are kept and may sync back after reconnecting, so review them first if you want only this device's contents. In each web app, select **Log out** and open a fresh setup link; logging out discards that browser's drafts and pending edits. Enable notifications again on each device that should receive them.

## Connect another device

### Obsidian

[Connect the device to the same server](/docs/getting-started/devices/#another-obsidian-device), open **Manage encryption** in Crate’s Sync settings, and enter your saved recovery key before syncing.

### Reading and Reminders web app

1. Open your connected Crate web app and select **Connect with Obsidian** on the unlock screen.
2. On an unlocked Obsidian device, open **Settings → Crate → Sync → Manage encryption → Connect web app** and select **Connect**.
3. Compare all three groups of numbers on both screens. Select **Approve** in Obsidian only if they match, then **Confirm and unlock** in the web app after checking the same code.

This transfers your vault keys, which unlock both Reading and Reminders, without copying your recovery key. Existing drafts and queued changes are kept. If an unlocked Obsidian device is unavailable, select **Use recovery key instead**.

Safari and the installed iPhone app have separate key storage. Open the Home Screen app after installation and complete the same pairing flow if it asks to unlock.

## What stays private

Encryption protects notes, attachments, file and folder names, retained file history, shared settings, reminder text, and notification display text. Reading articles, URLs, tags, highlights, and queued captures are encrypted too.

Some metadata remains visible to your server: folder structure (how deep folders go and how many items each holds), which files are Markdown notes, approximate file sizes, revision and sync timing, reminder IDs, completion state, due times, and notification delivery information. It can tell when a file gets back a name it had before in the same folder. Without encryption enabled, your server can also read synced content.

Encrypted names take more room on the server, so files can be nested at most 36 folders deep.

In the web app, your server downloads articles for encrypted Reading without keeping the link, and the web app encrypts them. Obsidian downloads on the device. Pasted reminder links get their page titles the same way: your server fetches the title without keeping the link.

## Keep your recovery key

Crate cannot recover a lost key. If you lose your recovery key and every unlocked device’s keys, the encrypted server copy cannot be recovered. **Manage encryption → Recovery key → Copy** lets you save another copy from an unlocked Obsidian device.

Use your recovery key only in clients you trust. An unlocked web app can read complete notes in its connected Reading and Reminders folders. Encryption does not protect content from a compromised client or malicious code served by the web app’s origin.

Keep independent backups. Enabling encryption does not retroactively encrypt earlier exports, provider snapshots, backups, or copies on other devices.
## Turn encryption off

Turning encryption off resets synced data; it does not decrypt the existing server copy in place. From the Obsidian device whose vault should become the new server copy, open **Manage encryption**, select **Turn off** under **Turn off encryption**, and review **Reset sync and turn off encryption**.

The reset deletes remote files and retained history, then uploads this device’s local files without encryption. Remote-only files are lost. Other Obsidian devices must reconnect, and web apps must log out and use a fresh setup link. Preserve pending browser work before logging out. Keep the old recovery key for any encrypted backups.

For more detail, see the [privacy policy](/privacy/) and [encryption implementation reference](https://github.com/kaanbiryol/obsidian-crate/blob/master/docs/e2ee-implementation.md).
