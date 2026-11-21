---
title: Conflict management
description: Review competing file versions, compare changes, and choose what to keep without losing track of either copy.
---

A conflict doesn't lose anything. Crate keeps both versions and waits for you to choose.

When two devices edit different parts of the same note before they sync, Crate combines the edits on its own. A conflict happens when they changed the same lines, when the note is very large (over 1 MB or 20,000 lines), when Crate has no earlier synced copy to compare against, or when a non-text file such as an image or PDF changed in both places. Crate keeps the other version next to yours as a conflict copy, named like `Note (conflict 2026-11-21 14-05-09 a1b2).md`.

## Resolve a conflict in a note

![Review conflict window comparing the current file with the saved copy, with options to keep either version, both, or a custom result](../../../assets/screenshots/crate-conflict-review.png)

1. Run **Crate: Show sync activity** and open **Conflicts**.
2. Select **Review** next to the file.
3. Compare your current file with the saved copy. Red is removed text; green is added text.
4. Choose **Keep current**, **Use saved copy**, **Keep both**, or **Custom result** to combine them yourself.
5. Check the result, then select **Resolve conflict**.
6. Open the note to make sure it looks right, then sync again.

If you build your own combined version, read the whole thing through before you confirm.

Not sure yet? Leave both copies in place while you think it over. Don't delete conflict copies just to clear the list.

## Attachments and binary files

When an existing image, PDF, or other non-text file changes, Crate asks you to review it too. It keeps and shows both files, but it can't blend them together like text.

Open each version in an app that can view it, then choose the one to keep. If you delete the incoming copy without choosing, Crate saves it again on the next sync.

## Avoid conflicts next time

- Let one device finish syncing before you keep editing the same note on another.
- After a long time offline, check your pending changes and let your devices catch up before you edit more.

If a conflict needs more time, turn off automatic sync on that device and back up its vault. Look through [file history and earlier vault states](/docs/troubleshooting/recovery/) before you throw anything away.
