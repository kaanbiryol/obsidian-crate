# Database migrations

The baseline is the complete schema 1 in `schema.sql`. There are no registered
migrations. Do not relabel schema markers.

Future migrations are registered with checksums in `server-release.json`. Keep
released steps unchanged. SQL for steps at or below `minimumSchemaVersion` may be
deleted, but keep their manifest entries. See `docs/server-upgrades.md` for
retiring migrations, backup and recovery.

Write guards pause old writers on every table except the control tables while
an upgrade runs. The provisioner (`deployment/database.ts`) lifts the guards on
every guarded table before each migration and restores them in the same D1
transaction, so a migration may write any table, and may rebuild one through a
copy, drop and rename. Every table that exists before a migration must still
exist after it, or restoring its guards fails the transaction. After each
migration the provisioner checks that every table is guarded and stops the
update otherwise, so a migration that adds a table needs the provisioner to
guard it first.
