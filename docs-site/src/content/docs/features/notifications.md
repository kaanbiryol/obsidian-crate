---
title: Set up notifications
description: Receive reminder alerts, choose an all-day alert time, and turn notifications off for one device or your whole vault.
---

Crate can send reminder alerts to your phones and browsers while Obsidian is closed. Your server must be running, and the reminder must have reached it through sync or the web app.

There are two controls: Obsidian manages whether the vault sends alerts, and each receiving device grants notification permission.

## Enable alerts for your vault

1. In Obsidian, open **Settings → Crate → Reminders** and check that **Enable reminders** is on.
2. Expand **Notifications** and turn on **Push notifications**.
3. Check the displayed notification folder and timezone. To use this device's reminders folder and timezone, select **Use this device’s settings** under **Notification folder and timezone**.
4. For reminders with a date but no time, set **All-day notification time**. Leave it empty to receive alerts only for reminders with an explicit time.

These settings apply to all subscribed devices. The saved notification timezone does not change just because another device opens Crate or you travel.

## Connect each receiving device

1. [Open the Crate web app](/docs/getting-started/devices/#open-the-web-app) on the device.
2. On iPhone or iPad, [add it to your Home Screen](/docs/features/web-app/#install-on-your-phone) and open the installed app first.
3. Open the app's **Settings → Reminders** and select **Enable** beside **Push notifications**.
4. Allow notifications when the browser or device asks. Wait until Crate shows **On**.

Repeat on each device where you want alerts. **Off for vault** means this device is registered, but Reminders or the vault's notification setting is paused; check **Reminders** and **Notifications** in Obsidian.

## Check that it works

In Obsidian, open **Settings → Crate → Notifications**. Under **Notification devices**, select **Refresh** and check that your device appears. Select **Send test** under **Test notification** to send to all enabled devices.

Then create a reminder a few minutes in the future and sync it. This checks scheduling as well as delivery. An all-day reminder needs an all-day notification time; its date alone does not enable an alert.

## Turn alerts off

| What you want | What to do |
| --- | --- |
| Stop alerts everywhere, keep using reminders | Turn off **Settings → Crate → Notifications → Push notifications** in Obsidian. |
| Stop alerts on one device | Turn off notifications for Crate in that device's browser or system settings. |
| Stop only date-only alerts | Select **Turn off** beside **All-day notification time**, or clear its time. Timed reminders still qualify for alerts. |
| Pause the entire Reminders feature | Turn off **Reminders → Enable reminders**. This also stops notification processing. |

Use **Notification devices → Remove notification subscription** to remove an obsolete registration. To remove a device's access to Crate as well, [disconnect its session](/docs/getting-started/devices/#disconnect-a-device).

## What to expect

Device permissions, Focus modes, network access, and your hosting provider can affect delivery. Crate cannot schedule a reminder that exists only on an offline Obsidian device. A Docker host must stay awake and online.

Turning alerts back on does not guarantee that old missed reminders will be replayed. For a missed reminder that still matters, choose a new future time and sync it.

If an alert does not arrive, follow [Notification troubleshooting](/docs/troubleshooting/notifications/).
