# Database migrations

Schema 1 is the pre-launch baseline. There are no historical migrations.
Previous development databases are unsupported; use their matching build to
recover data or create a fresh deployment. No data is automatically reset.

Future migrations start at schema 1 and are registered in `server-release.json`.
Keep the baseline fixed when adding migrations. See `docs/server-upgrades.md`.
