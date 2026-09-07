# Sync checkpoint recovery

The plugin stores its common sync ancestor in `file-manifest.json` and may retain a newer `file-manifest.json.tmp` after an interrupted write. Both generations belong to the normalized Worker URL recorded in their `authority` field. A checkpoint from another server, or an older unscoped pre-release checkpoint, cannot authorize synchronization.

Changing servers first stops event processing and waits for the old engine's file operations and checkpoint writes to settle. It saves verified recovery copies of every checkpoint generation, then removes both active generations before persisting the new connection. Any backup or removal failure stops the transition. Recovery copies have a `.previous-<id>` suffix and are never loaded automatically. They remain inside the plugin directory and contain filenames, hashes and revisions, so keep them private with the vault backup.

Renewing credentials for the same normalized Worker URL keeps the checkpoint and cursor. This preserves pending local deletions and the common ancestor. Explicitly disconnecting clears active sync state after preserving recovery copies; reconnecting then starts reconciliation without the old baseline.

If startup reports that the checkpoint is not bound to this server, Crate leaves local files and checkpoint bytes intact and disables sync. Back up the vault, confirm which server should own it, then use **Settings → Crate** to disconnect and reconnect. Older unscoped pre-release checkpoints require this explicit recovery decision; Crate does not guess their authority. Normal reconciliation preserves both sides of concurrent edits. Review any restored files or conflicts before relying on the new baseline.

An interrupted reset can leave some active generations and all verified recovery copies. Retry the reset after correcting the filesystem problem. Do not manually copy a previous server's checkpoint into the active checkpoint path. A paired server backup restores remote data; a checkpoint alone contains no note bytes.
