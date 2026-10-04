# Current release contract

Generated from the release manifest, wire and shortcut protocols, and shared transfer limits.
Run `node scripts/check-contract-docs.mjs --write` after changing those contracts;
`npm run check:contracts` rejects stale values.

| Contract | Current value |
| --- | --- |
| Server candidate revision | 8 |
| Fresh database schema | 2 |
| Oldest supported database schema | 2 |
| Wire protocol | 2 |
| Oldest compatible wire protocol | 1 |
| Shortcut capture contract | 1 |
| Shortcut template revision | 2 |
| Oldest compatible shortcut revision | 1 |
| Registered migrations | None |
| Markdown upload batch | 3 files |
| Asset upload batch | 4 files |
| New-file import batch | 8 files |
| Delete batch | 4 files |
| Download batch | 50 files |
| Upload batch bytes | 10485760 |
| Download batch bytes | 8388608 |
| Largest file | 26214400 bytes |

Schema 2 is the pre-launch baseline with no registered migrations. Databases from the retired pre-reset development sequence require
their matching old build and recovery instructions; matching numbers alone do
not establish compatibility. See [server upgrades](server-upgrades.md),
[compatibility](compatibility.md), and [recovery](recovery.md).
