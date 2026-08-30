# D1 schema migrations

`schema.sql` is the complete schema for newly created databases and records the
`0001_initial.sql` baseline in Cloudflare's standard `d1_migrations` table.

For every schema change after the first public release:

1. Update `../schema.sql` so newly created databases receive the latest schema.
2. Add a migration named `NNNN_short_description.sql` here.
3. Add or update a provisioner test that starts from the previous schema.

The plugin embeds these files, verifies their hashes, and applies unapplied
migrations in filename order before uploading the Worker.
