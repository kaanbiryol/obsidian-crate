# Database migrations

Schema 4 is the pre-launch baseline. There are no historical migrations.
Schemas 1–3 are unsupported development databases; use their matching build to
recover data or create a fresh deployment. No data is automatically reset.

Future migrations start at schema 4 and are registered in `server-release.json`.
Keep the baseline fixed when adding migrations. See `docs/server-upgrades.md`.
