# Shared UI phone check

Physical-device validation is deferred for the 0.1.0 UI prerelease. Browser
viewport checks do not establish iOS/Android keyboard or installed-PWA behavior.

Use disposable reminders in a test server/vault and record the OS, browser,
Obsidian version, theme, and exact release assets being tested.

- Open the installed PWA in light and dark modes; check circular checkboxes,
  long titles/descriptions, overdue/important items, and completed reminders.
- Create and edit a reminder. Switch between title and description, use the
  keyboard's Done action, open each picker, and verify the draft and cursor
  survive returning to the editor. Check for accidental or duplicate saves.
- Set, change, and remove a date and time, including midnight. Select a project
  with a long name. Apply weekly days and a monthly day, then remove the repeat.
- Scroll long lists and picker content. Rotate the phone and confirm controls
  remain reachable above the keyboard and bottom safe area.
- Cancel deletion, then confirm deletion of a disposable reminder.
- Install an earlier PWA build, apply the update banner, relaunch, and verify
  the shared picker styles are updated. Check offline launch and reconnection.
- Repeat the editor/picker checks in Obsidian mobile with the default theme and
  one community theme. Confirm native date/time controls remain usable.

Report any failure with the action taken, expected result, observed result,
and a screenshot or recording. Promote the prerelease only after these checks.
