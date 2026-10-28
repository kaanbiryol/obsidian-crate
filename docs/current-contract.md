# Current release contract

Generated from the release manifest, wire and shortcut protocols, and shared transfer limits.
Run `node scripts/check-contract-docs.mjs --write` after changing those contracts;
`npm run check:contracts` rejects stale values.

| Contract | Current value |
| --- | --- |
| Server candidate revision | 2 |
| Fresh database schema | 1 |
| Oldest supported database schema | 1 |
| Wire protocol | 1 |
| Oldest compatible wire protocol | 1 |
| Shortcut capture contract | 1 |
| Shortcut template revision | 1 |
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

Schema 1 is the baseline with no registered migrations. Matching numbers alone
do not establish compatibility. See [server upgrades](server-upgrades.md),
[compatibility](compatibility.md), and [recovery](recovery.md).
