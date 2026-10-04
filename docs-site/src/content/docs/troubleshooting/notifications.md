---
title: Notifications
description: Enable reminder notifications and check permissions, server availability, and scheduling when alerts do not arrive.
---

Reminder notifications need permission on your device and a registered push subscription on your Crate server.

## Enable notifications

1. [Connect the web app](/docs/getting-started/devices/#open-the-web-app) on the device where you want alerts.
2. On iPhone, add the app to your Home Screen and open the installed app.
3. Enable **Push notifications** in Crate and allow notifications when the browser or device asks.
4. Wait for Crate to confirm that notifications are on.

Do this on each device where you want to receive reminders. Browser permission alone does not confirm that server registration succeeded.

## Permission is blocked

Check the site's notification permission in your browser and the app's notification settings in your operating system. Allow notifications, reopen Crate, and retry registration.

If Crate offers **Retry**, use it to finish registering the existing permission with the server. Focus modes and device notification settings can still silence a delivered alert.

## A scheduled reminder did not arrive

Check these in order:

1. Confirm the reminder has the intended future date and time, including the notification timezone and all-day reminder time.
2. Make sure the note has synced to the server. A reminder saved only in an offline Obsidian vault cannot be scheduled there yet.
3. Check that **Enable reminders** is on. Pausing Reminders also pauses processing and notification delivery.
4. Confirm the server is reachable. A Docker host must remain awake, online, and running Docker.
5. Check that this web app session still has notifications enabled. Reconnect and register again if the session expired.

After repairing a delivery problem, schedule a reminder for a new future time to verify it. Re-enabling notifications does not guarantee a replay of an old missed occurrence.

## Still not working

Check Crate's sync diagnostics for notification failures and follow the reported repair guidance. When reporting a problem, include the plugin/server versions, device and browser, intended due time and timezone, and the error shown. Keep credentials and connection links out of the report.
