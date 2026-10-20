# Embedded reminders

Add a fenced code block to an Obsidian note to display a reminder list in Reading view or Live Preview. Enable Crate reminders and adopt a reminders folder first.

## Block types

| Type | View |
| --- | --- |
| `reminders` | Reminder list |
| `reminders-today` | Today |
| `reminders-upcoming` | Upcoming |

## Project filter

Use your project's name in any reminders block. Omit `project` to include all projects.

````markdown
```reminders
project: Travel
show-completed: false
```
````

## Completed reminders

`show-completed` accepts `true` or `false`, and defaults to `false`. It is supported by all three block types. Selecting the view's completed-reminders toggle in Reading view or Live Preview saves the choice in the block's `show-completed` line.

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
