# Upload retries and rename preservation

Protocol 7 binds every upload to a stable operation ID, exact content hash, size, path, content type and expected remote hash. The plugin saves the exact payload in its private `pending-uploads/` directory before dispatch. Each batch member has its own identity. A disk-write failure prevents dispatch.

D1 atomically records both successful commits and rejected preconditions. Replaying a successful upload returns its original revision even if another device has since edited or deleted the file; it never recreates that file. A rejected request cannot become a write when the state changes. Reusing an ID with different input fails.

On restart, the plugin replays unresolved records in dispatch order before reading remote state for a new sync plan. A confirmed receipt restores the common ancestor and Markdown merge base. The local checkpoint records settled identities before journal files are removed. Failed cleanup cannot roll the checkpoint backward. Records stay bound to their original server; disconnect/reconfiguration archives them alongside previous checkpoint generations.

Upload IDs use the server's UTC day and the same 180-UTC-date window as reminder operations. Maintenance advances the monotonic floor and prunes at most 500 expired upload receipts in its transaction. A retained receipt can still confirm an older outcome. Once pruned, an expired ID cannot mutate. An expired unresolved upload requires preservation and comparison of local and remote files; resetting sync is not an automatic retry.

Renames recorded while the plugin is running retain a source/destination dependency in the checkpoint, including chained and folder renames. Deletion of the old path waits until the destination's current local bytes match an acknowledged remote revision. Queue, incremental and full sync also defer remote deletions after upload or reconciliation failures. Offline renames cannot always be distinguished from an independent create and delete, so this failure barrier conservatively preserves old remote copies until the unresolved work succeeds. Force upload retains its existing failure barrier.

Keep the vault, manifest, `pending-uploads/`, previous checkpoint backups and Markdown base cache together when investigating failed sync. Journal and backup files contain private vault data. They are excluded from synchronization with the rest of the plugin's private directory.
