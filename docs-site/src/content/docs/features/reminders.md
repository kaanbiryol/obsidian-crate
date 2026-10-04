---
title: Reminders
description: Create reminders, organize projects, and receive notifications while keeping tasks in Markdown.
---

Crate keeps reminders as Markdown tasks in your vault. Work with them in Obsidian or the web app, then sync the changes between your devices.

## Create a reminder

1. Open Obsidian's command palette and run **Crate: Reminders - create reminder**.
2. Enter a title such as “Send the proposal tomorrow at 12” and review the parsed date. You can set the date explicitly, choose a project, add a description, mark a priority, or make it repeat.
3. Save the reminder, then run **Crate: Open sidebar** to see your reminders.

Reminders starts enabled and uses the `Reminders` folder. Once connected to a server, you can choose a different folder under **Settings → Crate → Reminders → Reminders folder**. Local reminders do not require a server; syncing and notifications do.

Relative dates are resolved when you save. A saved “tomorrow” becomes a specific date, so it does not move forward each time you reopen the reminder.

## Links in reminders

Paste a webpage URL into a reminder’s title or description to keep an article or reference with the task. Open the link directly from the saved reminder.

When available, Crate uses the page’s title as the link label. If you paste a URL over selected text, that text stays as the label. Offline, blocked, slow, or untitled pages keep the URL label.

Page titles are fetched through your Crate server, which contacts the linked website without your cookies or authorization headers. With [end-to-end encryption](/docs/features/encryption/) enabled, title lookup is disabled and pasted links keep their URL labels.

## Organize your day

- **Inbox** holds reminders to organize later.
- **Today** brings together reminders due today and overdue items.
- **Upcoming** helps you plan what is next.
- **Projects** groups reminders by the work or part of life they belong to. Use **Crate: Reminders - open project** to jump to one in Obsidian.

Select a reminder to edit it, or its checkbox to complete it. Completing a repeating reminder advances the same task to its next occurrence. After its final occurrence it stays checked; earlier occurrences are not separate tasks in a completion history.

## Work directly in Markdown

Each note in the reminders folder represents a project. For example, `Reminders/Travel.md` is the **Travel** project. Add ordinary checkbox lines to that note:

```markdown
- [ ] Check passport expiry
- [ ] Book train tickets
- [x] Choose travel dates
```

Crate adds hidden tracking comments to checkbox lines so it can find the same reminder after edits and sync. Keep those comments when editing existing tasks. Choose a dedicated reminders folder if you do not want Crate to adopt checkboxes in your other notes.

Checkbox examples inside code blocks are ignored. For nested tasks or tasks with supporting paragraphs, use the Markdown editor to reorder them or move/delete a task together with its children; the reminder list limits these structural edits to preserve the note.

## Keep tasks beside your notes

Use an [embedded reminder block](/docs/features/embedded-reminders/) to show a project, today's reminders, or upcoming work in a note. The block shows the same underlying reminders, so edits do not create another copy.

## Notifications and the web app

Connect the [Crate web app](/docs/features/web-app/) to use reminders on your phone. Changes made there reach your Obsidian vault on its next sync.

For alerts, enable **Settings → Crate → Notifications → Push notifications** in Obsidian, then register each receiving device in the web app. A reminder with only a date also needs an **All-day notification time**. Follow [Set up notifications](/docs/features/notifications/) for the full steps and a test.

## Change defaults

Under **Settings → Crate → Reminders**, choose a **Default due date**, **Default reminders tab**, and **Upcoming range (days)**. Enable **Open reminders on startup** if you want the view ready when Obsidian opens. These preferences apply to this Obsidian device.

Changing **Reminders folder** changes where Crate looks; it does not move your existing notes. Read [Choose your folders](/docs/features/settings/#choose-your-folders) before switching an established setup.

## Offline use and pausing

Local reminders remain available in Obsidian. The web app can display cached reminders offline, but new reminder changes require a connection. If a submitted change has not been confirmed, keep its pending work until the server responds.

**Enable reminders** in Crate settings controls the feature across connected devices. Pausing it retains notes and device connections, while stopping reminder processing and notification delivery. Vault sync remains available.

For the web app, keep each reminder note within 1 MiB. If a note is reported as too large or unavailable, split it into smaller project notes and sync again. See [practical limits](/docs/getting-started/limits/) and [recovery](/docs/troubleshooting/recovery/) for more help.
