# D1 schema migrations

`schema.sql` is the complete schema for newly created databases and records the
`0001_initial.sql` baseline in Cloudflare's standard `d1_migrations` table.
`0002_launch_hardening.sql` upgrades databases created by pre-release builds;
the provisioner applies migrations before reconciling the complete schema.

For every schema change after the first public release:

1. Update `../schema.sql` so newly created databases receive the latest schema.
2. Add a migration named `NNNN_short_description.sql` here.
3. Add or update a provisioner test that starts from the previous schema.

The plugin embeds these files, verifies their hashes, and applies unapplied
migrations in filename order before uploading the Worker.

The complete schema is only for new databases. Migrations 0003–0008 add reminder receipts/identities, file revisions, a portable-path migration fence, notification projections/policy, folder-scoped credentials and subscription ownership, request rates, and the shared enabled setting. The provisioner installs the new protocol gate before running `portable-path-migration.ts`; that NFC/Unicode backfill cannot be replaced by SQLite `lower()`. Failed or colliding backfills leave writes fenced and can be retried. See `docs/deployment.md` for the upgrade procedure.

Migration 0009 records expected notification/policy identities on projections and terminal delivery failures on schedules. It queues existing Markdown files for reprojection before old schedules may deliver and disables push subscriptions whose owner cannot be identified. Those devices must explicitly enroll again. Apply this migration through the server update flow before uploading the matching Worker; retry interrupted updates through that same flow.
