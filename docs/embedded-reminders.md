# Embedded reminders

Add a fenced code block to an Obsidian note to display a reminder list in Reading view or Live Preview. Enable Crate reminders and adopt a reminders folder first.

## Block types

| Type | View |
| --- | --- |
| `reminders` | Reminder list |
| `reminders-today` | Today |
| `reminders-upcoming` | Upcoming |

`reminders-tasks` is an alias for `reminders` in Reading view. Use `reminders` for Live Preview support.

## Project filter

Use your project's name in a `reminders` block. Omit `project` to include all projects.

````markdown
```reminders
project: Travel
show-completed: false
```
````

## Completed reminders

`show-completed` accepts `true` or `false`, and defaults to `false`. It is supported by all three block types. The view's completed-reminders toggle can override this initial preference.

````markdown
```reminders-upcoming
show-completed: true
```
````

## Today in a daily note

````markdown
```reminders-today
```
````
