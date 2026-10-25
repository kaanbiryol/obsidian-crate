---
title: Notification problems
description: Fix blocked permissions, unconfirmed device registration, and reminders that do not send an alert.
---

Missing alerts don't affect your reminders. They're still safe in your notes.

For an alert to arrive, three things must be in place: notifications turned on for the vault, permission on your device, and the device registered with your server. Setting up for the first time? Start with [Set up notifications](/docs/features/notifications/).

## The app says "Off for vault"

Your device is registered, but alerts are paused for this vault.

1. In Obsidian, open **Settings → Crate**.
2. Turn on **Reminders → Enable reminders** and **Notifications → Push notifications**.
3. Reopen the web app to check its status.

## The app says "Install first"

On iPhone or iPad, alerts only work from the Home Screen app.

1. Open the connected app in Safari.
2. Add it to the Home Screen.
3. Open the installed app and turn on notifications there.

If the installed app asks you to connect again, follow the [installation steps](/docs/features/web-app/#install-on-your-phone).

## Notifications are blocked

1. Allow notifications for the site in your browser settings, and for the app in your phone or computer's notification settings.
2. Reopen Crate and register again.

If Crate shows **Retry**, select it to finish registering the permission you already gave. Focus modes and device notification settings can still silence an alert that arrived.

## A reminder didn't send an alert

Go through these in order:

1. **Check the time.** Make sure the reminder has the right future date and time, including the notification timezone and the time used for all-day reminders.
2. **Check it synced.** A reminder saved only in an offline Obsidian vault hasn't reached your server yet, so it can't be scheduled.
3. **Check the settings.** **Enable reminders** and the vault's **Push notifications** setting must both be on. Pausing Reminders also pauses alerts.
4. **Check the server.** It must be reachable. A Docker server's computer must stay awake, online, and running Docker.
5. **Check this device.** Make sure this web app session still has notifications on. If the session expired, reconnect and register again.

To test delivery, select **Settings → Crate → Notifications → Test notification → Send test** in Obsidian. After fixing a problem, set a reminder for a new time in the future to check scheduling too. Alerts you already missed may not be sent again.

## Still not working

Check Crate's sync diagnostics for notification failures and follow the repair steps it suggests.

If you report the problem, include:

- Plugin and server versions
- Device and browser
- The reminder's due time and timezone
- The error you see

Leave out credentials and connection links.
