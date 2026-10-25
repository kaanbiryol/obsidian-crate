---
title: Reminders inside notes
description: Use reminder blocks to show a project, today's tasks, or upcoming reminders inside an Obsidian note.
---

Put a live reminder list right next to the notes it belongs to, such as your trip plan beside its packing tasks. Blocks work in Obsidian's Reading view and Live Preview.

The block is a view, not a copy. Checking off or editing a task here updates the original in your reminders folder.

## Show a project

Add this to a note to show the unfinished reminders in your Travel project:

````markdown
```reminders
project: Travel
show-completed: false
```
````

Leave out `project` to show reminders from every project. Completed reminders are hidden by default; set `show-completed: true` to include them.

## Show today

````markdown
```reminders-today
```
````

## Show upcoming reminders

````markdown
```reminders-upcoming
show-completed: true
```
````

## Seeing code instead of a list?

Switch to Reading view or Live Preview, and check that Crate is enabled.

For every option and more examples, see the [embedded-reminders reference](https://github.com/kaanbiryol/obsidian-crate/blob/master/docs/embedded-reminders.md).
