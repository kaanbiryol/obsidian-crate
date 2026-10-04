---
title: Notification problems
description: Fix blocked permissions, unconfirmed device registration, and reminders that do not send an alert.
---

Reminder alerts need the vault's notification setting, permission on your device, and confirmed registration with your server. For a new setup, start with [Set up notifications](/docs/features/notifications/).

## The app says “Off for vault”

This device is registered, but alerts are paused on the server. In Obsidian, open **Settings → Crate** and turn on both **Reminders → Enable reminders** and **Notifications → Push notifications**. Reopen the web app to check its status.

## The app says “Install first”

On iPhone or iPad, open the connected app in Safari, add it to the Home Screen, then open the installed app. Enable notifications there. See the [installation steps](/docs/features/web-app/#install-on-your-phone) if the installed app asks to connect again.

## Permission is blocked

Check the site's notification permission in your browser and the app's notification settings in your operating system. Allow notifications, reopen Crate, and retry registration.

If Crate offers **Retry**, use it to finish registering the existing permission with the server. Focus modes and device notification settings can still silence a delivered alert.

## A scheduled reminder did not arrive

Check these in order:

1. Confirm the reminder has the intended future date and time, including the notification timezone and all-day reminder time.
2. Make sure the note has synced to the server. A reminder saved only in an offline Obsidian vault cannot be scheduled there yet.
3. Check that **Enable reminders** and the vault's **Push notifications** setting are both on. Pausing Reminders also pauses processing and notification delivery.
4. Confirm the server is reachable. A Docker host must remain awake, online, and running Docker.
5. Check that this web app session still has notifications enabled. Reconnect and register again if the session expired.

Use **Settings → Crate → Notifications → Test notification → Send test** in Obsidian to check delivery to registered devices. After repairing a delivery problem, schedule a reminder for a new future time to verify scheduling too. Re-enabling notifications does not guarantee a replay of an old missed occurrence.

## Still not working

Check Crate's sync diagnostics for notification failures and follow the reported repair guidance. When reporting a problem, include the plugin/server versions, device and browser, intended due time and timezone, and the error shown. Keep credentials and connection links out of the report.
