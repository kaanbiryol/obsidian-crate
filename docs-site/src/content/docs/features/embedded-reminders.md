---
title: Reminders inside notes
description: Use reminder blocks to show a project, today's tasks, or upcoming reminders inside an Obsidian note.
---

Embed a live reminder list next to the notes it belongs to. Blocks work in Obsidian's Reading view and Live Preview.

## Show a project

Add this block to a note to show unfinished reminders in your Travel project:

````markdown
```reminders
project: Travel
show-completed: false
```
````

Leave out `project` to show reminders from all projects. `show-completed` defaults to `false`; set it to `true` to include completed reminders.

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

The block is a view of your reminders. Changing a task here updates its source in your reminders folder.

If you only see the block's code, switch to Reading view or Live Preview and make sure Crate is enabled. The older `reminders-tasks` alias works only in Reading view; use `reminders` for new notes.

For parser details and further examples, see the [embedded-reminders reference](https://github.com/kaanbiryol/obsidian-crate/blob/master/docs/embedded-reminders.md).
