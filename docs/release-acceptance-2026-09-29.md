# Crate 0.4.0 candidate acceptance

Automated evidence and the final decision are in the
[final engineering audit](pre-release-final-audit-2026-09-29.md).
Physical devices and native Obsidian are deliberately left to the maintainer.
Every native/hosted item below starts **unverified**; a browser simulation does not tick it off.

Use disposable vaults and a disposable server/account for destructive and recovery
scenarios. Preserve baseline file copies and hashes so the result can be checked.
The existing development watcher can rewrite the main checkout's `dist/`; use the
frozen candidate files in `.generated/pre-release-final/candidate-plugin/`, produced
by the passing release gate. Copy `main.js`, `styles.css` and `manifest.json` to
`<Vault>/.obsidian/plugins/crate/`, reload Obsidian and enable **Crate**. Do not use
an unrelated development build for this acceptance.

Record: candidate source/artifact hashes, Obsidian version (including minimum
**1.13.0**), OS/browser versions, device model, server revision and result. Use a
second device or vault for B and an installed PWA for C.

## Native Obsidian and device checks — maintainer

| Check | Steps and pass criteria | Result |
| --- | --- | --- |
| Bootstrap and restart | Import a fixture vault containing Markdown, UTF-8/BOM/CRLF notes, nested folders, a hidden file and two binary attachments. Connect B. Compare names and bytes. Restart/reload both plugins; no lost content or repeated pending work. | Unverified |
| Concurrent edits | Take A and B offline, edit different lines of one note, reconnect in both orders. Preserve both edits. Then edit the same YAML field and the same fenced block differently: require a recoverable conflict, never invented/invalid metadata. | Unverified |
| Edit/delete | A edits while B deletes, then reverse the roles/order. The edited version survives with visible race/conflict history. For an unchanged remote delete, local bytes are in `.trash`. | Unverified |
| Rename and recreation | A renames while B edits the old name; both changes remain recoverable. Rename to two different destinations; verify both copies. Delete/recreate with identical bytes on B while A has an old delete: the new incarnation must survive. | Unverified |
| Writes during download | Edit/rename a note while sync is applying remote content. Crate must defer or preserve the edit and must not follow a renamed TFile into another path. Repeat with another plugin making the local write. | Unverified |
| Binary review and interruption | Change an existing attachment remotely. Confirm **Incoming copy** provenance; test **Keep local**, **Keep both**, and **Use incoming copy → Apply choice**. Sync/restart afterward: resolution stays settled. Interrupt replacement on a disposable vault; previous bytes remain in local trash/recovery copies. Include a hidden path. | Unverified |
| Plugin lifecycle | Disable/enable/reload during startup and during a transfer. Switch active files/panes and reopen the vault. Old work must not modify the new lifecycle; no repeated watchers or repeated commands. | Unverified |
| PWA/plugin concurrency | Open a reminder in C, change it in Obsidian, then save C's stale draft. The draft must be retained for review and the plugin change must survive. Repeat for completion, deletion, project move and recurring completion. | Unverified |
| Native editing | Type/paste and immediately select Save or keyboard Done. Verify the full title, description Markdown and repeat/time rule. Remove a repeat rule and save immediately. Rapid double actions must create one reminder. Check both installed iOS and Android when supported. | Unverified |
| Offline and suspension | Let an accepted mutation lose connectivity, suspend/kill the PWA, reopen and reconnect. One logical operation is eventually confirmed; pending work survives. Confirm that cached Reminders browsing is read-only while offline. Exercise Reading's supported offline queue separately. | Unverified |
| Updates and multiple windows | Leave an old installed app/window open, install a server update, and use another window. Pending drafts/commands survive; old lazy screens remain available or offer a recoverable update. Close/reopen both windows; no duplicated effects. | Unverified |
| Push and calendar | Enable push, schedule timed/all-day reminders and a recurring reminder, then suspend the app. Confirm delivery and correct notification target. Change timezone, cross representative DST transitions, revoke permission, and restore permission. Status must reflect the actual registration; complete the same occurrence from two clients without advancing twice. | Unverified |
| Accessibility/layout | Check VoiceOver/TalkBack, keyboard focus, zoom, long titles/descriptions, 320px layouts, safe areas and the software keyboard. Recovery choices and errors remain readable/actionable. | Unverified |
| Logout/privacy | Log out with pending work only after reviewing the warning/export. Reopen offline and use another existing tab: private content/drafts must not remain accessible. A denied storage cleanup must show clear site-data/revocation instructions. | Unverified |

## Hosted and repository acceptance — maintainer/environment-dependent

These are distinct from native-device tests. No live infrastructure was provisioned
or deployed by this audit.

- [ ] Authenticate/provision through real Cloudflare OAuth, upgrade schema 1 → 2,
  and verify a refused unsupported/rollback version leaves existing data intact.
- [ ] Run the documented 1,000/10,000-note/reminder checks on disposable hosted
  resources. Record Worker CPU/errors, D1 rows read, response sizes, cold-index time,
  network latency and device memory. Set a supported size from measurements.
- [ ] Rehearse the [paired backup/restore runbook](recovery.md) into different empty
  D1/R2 resources (preferably another account). Compare every restored file hash,
  verify retained versions/receipts, re-enroll devices and confirm real push.
- [ ] Rehearse “Crate deleted my note”: recover from local trash/version history,
  correlate request/operation/revision IDs and share a redacted diagnostic export.
- [x] Read-only GitHub checks confirmed private vulnerability reporting,
  vulnerability alerts, Dependabot security updates, secret scanning and
  secret-scanning push protection are enabled.
- [ ] Configure required CI on `master`: it currently has no branch protection or
  rulesets (R3). Retain the commit's CI results, including native Linux AMD64 and
  ARM64 Docker jobs; the local macOS gate does not replace those jobs. The local
  Docker daemon was unavailable during this audit.
- [ ] Commit the reviewed source and rerun required CI. Confirm manifest/version
  metadata and exact tag `0.4.0` (no leading `v`) if that is the version being
  published. Attach the verified manifest, plugin bundle and stylesheet. Do not
  commit generated output or publish a candidate with failed acceptance items.

## Sign-off

- Candidate release-input SHA-256: `17bc6f56a878e6b9a9c283a3c0e6e50efbd1a03c505dc72a35404aa0c33bc2be`
- Candidate artifact manifest: `.generated/pre-release-final/artifact-manifest.json`
- Plugin ZIP: `.generated/pre-release-final/crate-0.4.0-audit-candidate.zip`
- Native Obsidian result and versions:
- iOS/iPadOS result and versions:
- Android result and versions:
- Hosted OAuth/limits/push result:
- Independent restore result:
- CI commit/check links:
- Accepted limitations:
- Release approver/date:
