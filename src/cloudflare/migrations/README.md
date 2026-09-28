# Database migrations

Schema 1 is the pre-launch baseline. `002-reading-captures.sql` upgrades it to
schema 2 with a durable queue for captures awaiting extraction. Existing file
hashes, storage references, and receipts are preserved.

Migrations are registered with checksums in `server-release.json`. Keep released
steps unchanged. See `docs/server-upgrades.md` for backup and recovery requirements.
