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
3. In the app, open **Settings → Notifications** and select **Enable** beside **Push notifications**. In Safari on iPhone or iPad it shows **Install first** until you open the Home Screen app.
4. Allow notifications when asked, and wait until Crate shows **On**.

Repeat this on each device where you want alerts.

If a device shows **Off for vault**, it's registered, but Reminders or the vault's notifications are paused. Check **Reminders** and **Notifications** in Obsidian.

## Check that it works

1. In Obsidian, open **Settings → Crate → Notifications**.
2. Under **Notification devices**, select **Refresh** and check that your device is listed.
3. Under **Test notification**, select **Send test**. Every enabled device should get an alert.
4. For a full check, create a reminder a few minutes from now and sync it. This tests scheduling as well as delivery.

Reminders with only a date alert at your **All-day notification time**. Without one set, they won't alert at all.

## Desktop notifications without a server

On desktop, Obsidian can show reminder alerts itself, so reminders work even when no server is connected. These alerts only appear while Obsidian is open.

1. Open **Settings → Crate → Reminders** and check that **Enable reminders** is on.
2. Check that **Desktop notifications** is on.
3. For reminders with a date but no time, set **All-day notification time**. Without a server it's under **Reminders**. With a server it's under **Notifications** and applies to every device, even with **Push notifications** off.

When Obsidian opens, it alerts once for reminders that fell due in the last day while it was closed. With sync on, it syncs first, so a reminder you completed on another device stays quiet. Several at once arrive as one summary.

Desktop notifications also work with a server connected. To get alerts on your computer with Obsidian closed, open the web app in your browser and turn on notifications there. If you do, turn off **Desktop notifications** on that computer so you don't get each reminder twice. Each device with Obsidian open checks its own copy of the vault, so two open computers both alert.

## Turn alerts off

| What you want | What to do |
| --- | --- |
| Stop alerts everywhere, keep using reminders | Turn off **Settings → Crate → Notifications → Push notifications** in Obsidian. |
| Stop alerts on one device | Turn off notifications for Crate in that device's browser or system settings. |
| Stop only date-only alerts | Select **Turn off** beside **All-day notification time**, or clear its time. Timed reminders still alert. |
| Pause the entire Reminders feature | Turn off **Reminders → Enable reminders**. This also stops notifications. |

To clean up a device you no longer use, select **Notification devices → Remove notification subscription**. To remove its access to Crate entirely, [disconnect its session](/docs/getting-started/devices/#disconnect-a-device).

If an alert doesn't arrive, or you turned alerts back on and missed some, see [Notification problems](/docs/troubleshooting/notifications/).
