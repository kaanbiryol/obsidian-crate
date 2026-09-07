# Crate test vault

Use this vault for local Crate testing. The plugin is installed under `.obsidian/plugins/crate`.

## Vault guide

- [[Notes/Sync sandbox|Sync sandbox]]: disposable content for file edits and sync checks.
- [[Notes/Feature tours/Reminder feature tour|Reminder feature tour]]: reminder views and editing scenarios.
- [[Notes/Sync cases/Conflict walkthrough|Conflict walkthrough]]: conflict testing steps.
- `Reminders/`: sample projects covering recurrence, priorities, descriptions, nested folders, and completed items. Fixed dates intentionally provide overdue examples; `today` and `tomorrow` examples remain relative.

This vault is excluded from Git by the repository’s `.gitignore`. Crate sync is configured separately in the plugin settings.

## Demo flow

1. Open the Crate settings tab and verify sync, reminder, notification, and infrastructure sections render.
2. Open the Reminders view and switch between Inbox, Today, Upcoming, Browse, and a project detail view.
3. Edit, complete, reorder, and delete one seeded reminder, then confirm the Markdown file updates.
4. Open [[Notes/Feature tours/Reminder feature tour|Reminder feature tour]] for a guided reminder walkthrough.
5. Open [[Notes/Sync cases/Conflict walkthrough|Conflict walkthrough]] for safe sync demos.

## Today view

```reminders-today
```

## Upcoming view

```reminders-upcoming
```

## All active reminders

```reminders
```

## Work project with completed items

```reminders
project: Work
show-completed: true
```

## Crate demo project

```reminders-upcoming
project: Crate Demo
show-completed: true
```

## Health project

```reminders
project: Personal/Health
show-completed: true
```

## Engineering project

```reminders
project: Engineering
show-completed: true
```

## Finance upcoming

```reminders-upcoming
project: Personal/Finance
show-completed: true
```

## Reading project

```reminders
project: Reading
show-completed: true
```
