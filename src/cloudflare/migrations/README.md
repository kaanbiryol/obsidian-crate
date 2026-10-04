# Database migrations

The pre-launch baseline is the complete schema 2 in `schema.sql`. There are no
registered migrations. Retired development databases require their matching old
build for export, then a fresh deployment; do not relabel their schema markers.

Future migrations are registered with checksums in `server-release.json`. Keep
released steps unchanged. See `docs/server-upgrades.md` for backup and recovery.
