# Database migrations

The baseline is the complete schema 1 in `schema.sql`. There are no registered
migrations. Do not relabel schema markers.

Future migrations are registered with checksums in `server-release.json`. Keep
released steps unchanged. SQL for steps at or below `minimumSchemaVersion` may be
deleted, but keep their manifest entries. See `docs/server-upgrades.md` for
retiring migrations, backup and recovery.
