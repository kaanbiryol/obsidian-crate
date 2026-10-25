---
title: Set up notifications
description: Receive reminder alerts, choose an all-day alert time, and turn notifications off for one device or your whole vault.
---

Get a nudge on your phone or computer when a reminder is due, even with Obsidian closed. Your server sends the alerts, so it needs to be running, and the reminder needs to have reached it through sync or the web app.

Setup has two parts: turn alerts on for your vault in Obsidian, then allow notifications on each device that should receive them.

## Enable alerts for your vault

1. In Obsidian, open **Settings → Crate → Reminders** and check that **Enable reminders** is on.
2. Expand **Notifications** and turn on **Push notifications**.
3. Check the notification folder and timezone shown. To use this device's reminders folder and timezone, select **Use this device’s settings** under **Notification folder and timezone**.
4. For reminders with a date but no time, set **All-day notification time**. Leave it empty if you only want alerts for reminders with a specific time.

These settings apply to every subscribed device. The saved timezone stays put when you travel or open Crate on another device.

## Connect each receiving device

1. [Open the Crate web app](/docs/getting-started/devices/#open-the-web-app) on the device.
2. On iPhone or iPad, [add it to your Home Screen](/docs/features/web-app/#install-on-your-phone) and open the installed app.
3. In the app, open **Settings → Reminders** and select **Enable** beside **Push notifications**.
4. Allow notifications when asked, and wait until Crate shows **On**.

Repeat this on each device where you want alerts.

If a device shows **Off for vault**, it's registered, but Reminders or the vault's notifications are paused. Check **Reminders** and **Notifications** in Obsidian.

## Check that it works

1. In Obsidian, open **Settings → Crate → Notifications**.
2. Under **Notification devices**, select **Refresh** and check that your device is listed.
3. Under **Test notification**, select **Send test**. Every enabled device should get an alert.
4. For a full check, create a reminder a few minutes from now and sync it. This tests scheduling as well as delivery.

Reminders with only a date alert at your **All-day notification time**. Without one set, they won't alert at all.

## Turn alerts off

| What you want | What to do |
| --- | --- |
| Stop alerts everywhere, keep using reminders | Turn off **Settings → Crate → Notifications → Push notifications** in Obsidian. |
| Stop alerts on one device | Turn off notifications for Crate in that device's browser or system settings. |
| Stop only date-only alerts | Select **Turn off** beside **All-day notification time**, or clear its time. Timed reminders still alert. |
| Pause the entire Reminders feature | Turn off **Reminders → Enable reminders**. This also stops notifications. |

To clean up a device you no longer use, select **Notification devices → Remove notification subscription**. To remove its access to Crate entirely, [disconnect its session](/docs/getting-started/devices/#disconnect-a-device).

## What to expect

Alerts usually just work, but a few things can get in the way:

- Device permissions, Focus modes, network access, and your hosting provider all affect delivery.
- Crate can't schedule a reminder that exists only on an offline Obsidian device.
- A server on your own hardware must stay awake and online.

Turning alerts back on doesn't replay reminders you missed. If a missed reminder still matters, give it a new time in the future and sync it.

If an alert doesn't arrive, see [Notification troubleshooting](/docs/troubleshooting/notifications/).
