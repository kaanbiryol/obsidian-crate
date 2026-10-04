---
title: Reminders
description: Create reminders, organize projects, and receive notifications while keeping tasks in Markdown.
---

Crate keeps reminders as Markdown tasks in your vault. Work with them in Obsidian or the web app, then sync the changes between your devices.

## Create a reminder

Choose your reminders folder under **Settings → Crate → Reminders**. Open the reminders view and select the add action.

Write a title such as “Send the proposal tomorrow at 12” and review the parsed date before saving. You can also set the date explicitly, choose a project, add a description, mark a priority, or make it repeat.

Relative dates are resolved when you save. A saved “tomorrow” becomes a specific date, so it does not move forward each time you reopen the reminder.

## Links in reminders

Paste a webpage URL into a reminder’s title or description to keep an article or reference with the task. Open the link directly from the saved reminder.

When available, Crate uses the page’s title as the link label. If you paste a URL over selected text, that text stays as the label. Offline, blocked, slow, or untitled pages keep the URL label.

Page titles are fetched through your Crate server, which contacts the linked website without your cookies or authorization headers. With [end-to-end encryption](/docs/features/encryption/) enabled, title lookup is disabled and pasted links keep their URL labels.

## Organize your day

- **Inbox** holds reminders to organize later.
- **Today** brings together reminders due today and overdue items.
- **Upcoming** helps you plan what is next.
- **Projects** groups reminders by the work or part of life they belong to.

Completing a repeating reminder advances it to its next occurrence. It does not create a separate completed task for every occurrence.

## Keep tasks beside your notes

Use an [embedded reminder block](/docs/features/embedded-reminders/) to show a project, today's reminders, or upcoming work in a note. The block shows the same underlying reminders, so edits do not create another copy.

## Notifications and the web app

Connect the [Crate web app](/docs/getting-started/devices/#open-the-web-app) to use reminders on your phone. Enable **Push notifications** separately on each device where you want alerts. Your server delivers them even when Obsidian is closed, as long as the server is running and has received the reminder.

See [Notifications](/docs/troubleshooting/notifications/) for permission, connection, and scheduling checks.

## Offline use and pausing

Local reminders remain available in Obsidian. The web app can display cached reminders offline, but new reminder changes require a connection. If a submitted change has not been confirmed, keep its pending work until the server responds.

**Enable reminders** in Crate settings controls the feature across connected devices. Pausing it retains notes and device connections, while stopping reminder processing and notification delivery. Vault sync remains available.
