---
title: Encryption
description: Enable optional end-to-end encryption, connect your devices, and keep your recovery key safe.
---

Crate offers optional end-to-end encryption on both Cloudflare and self-hosted servers. Your devices encrypt synced content before uploading it. Encryption is off by default; updating Crate does not enable it.

## Enable encryption

1. Update the plugin and server. Finish any running sync, keep an independent backup, and close other editing clients during conversion.
2. Open **Settings → Crate → Sync → End-to-end encryption** and select **Enable encryption**.
3. Select **Copy** and save the recovery key somewhere safe outside your vault, such as a password manager.
4. Select **I’ve saved it outside my vault.** Review **What changes with encryption?**, then select **Enable encryption**.
5. Keep Obsidian open until conversion finishes. Sync and notifications pause while Crate encrypts existing synced files and retained history.

If conversion is interrupted, return to the same settings and select **Resume conversion**. Keep the saved recovery key and this device’s Crate configuration.

An empty server starts encrypted without uploading local files. Unsynced local changes wait for your next automatic or manual sync. Your local Obsidian vault stays readable as ordinary files.

## Connect another device

### Obsidian

[Connect the device to the same server](/docs/getting-started/devices/#another-obsidian-device), open **Manage encryption** in Crate’s Sync settings, and enter your saved recovery key before syncing.

### Reading and Reminders web app

1. Open your connected Crate web app and select **Connect with Obsidian** on the unlock screen.
2. On an unlocked Obsidian device, open **Settings → Crate → Sync → Manage encryption → Connect web app** and select **Connect**.
3. Compare all three groups of numbers on both screens. Select **Approve** in Obsidian only if they match, then **Confirm and unlock** in the web app after checking the same code.

This transfers the keys for the connected Reading and Reminders folders without copying your recovery key. Existing drafts and queued changes are kept. If an unlocked Obsidian device is unavailable, select **Use recovery key instead**.

Safari and the installed iPhone app have separate key storage. Open the Home Screen app after installation and complete the same pairing flow if it asks to unlock.

## What stays private

Encryption protects notes, attachments, retained file history, shared settings, reminder text, and notification display text. Reading articles, URLs, tags, highlights, and queued captures are encrypted too.

Some metadata remains visible to your server: file and folder paths, approximate file sizes, revision and sync timing, reminder IDs, completion state, due times, and notification delivery information. Without encryption enabled, your server can also read synced content.

Encrypted Reading saves use your browser to download an article where the source website allows it. Other links wait for an unlocked Obsidian device to extract them. Private reminder links keep their URL labels because server-side page-title lookup is disabled.

## Keep your recovery key

Crate cannot recover a lost key. If you lose your recovery key and every unlocked device’s keys, the encrypted server copy cannot be recovered. **Manage encryption → Recovery key → Copy** lets you save another copy from an unlocked Obsidian device.

Use your recovery key only in clients you trust. An unlocked web app can read complete notes in its connected Reading and Reminders folders. Encryption does not protect content from a compromised client or malicious code served by the web app’s origin.

Keep independent backups. Enabling encryption does not retroactively encrypt earlier exports, provider snapshots, backups, or copies on other devices.

## Turn encryption off

Turning encryption off resets synced data; it does not decrypt the existing server copy in place. From the Obsidian device whose vault should become the new server copy, open **Manage encryption**, select **Turn off** under **Turn off encryption**, and review **Reset sync and turn off encryption**.

The reset deletes remote files and retained history, then uploads this device’s local files without encryption. Remote-only files are lost. Other Obsidian devices must reconnect, and web apps must log out and use a fresh setup link. Preserve pending browser work before logging out. Keep the old recovery key for any encrypted backups.

For more detail, see the [privacy policy](/privacy/) and [encryption implementation reference](https://github.com/kaanbiryol/obsidian-crate/blob/master/docs/e2ee-implementation.md).
