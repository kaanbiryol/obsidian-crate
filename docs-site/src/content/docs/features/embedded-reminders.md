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

## Options

All three blocks accept the same two lines:

| Option | What it does |
| --- | --- |
| `project: <name>` | Shows only that project. Leave it out to show every project. |
| `show-completed: true` | Includes completed reminders. The default is `false`. |

Selecting the completed-reminders toggle in the block updates its `show-completed` line for you. Inside a callout or quote the toggle can't edit the line, so change it in the note instead.

## Seeing code instead of a list?

Switch to Reading view or Live Preview, and check that **Settings → Crate → Reminders → Enable reminders** is on.
