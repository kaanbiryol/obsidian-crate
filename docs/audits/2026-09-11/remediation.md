# Pre-release audit remediation — September 11, 2026

This records the implementation following the [original audit](pre-release-audit.md). The original report and reproductions remain historical evidence. The user authorized fixing all findings and retained responsibility for hosted and physical-device acceptance (F04).

## Finding disposition

| Finding | Result | Main changes and proof |
| --- | --- | --- |
| F01: restore replay resurrects a deletion | Fixed | Checkpoint format 3 saves the restore's operation ID, retained key, path, hash/revision precondition and phase before dispatch. D1 commits the file mutation and exact receipt together. Retries consult receipts before retained metadata/bytes, preserving later deletes and replacements. Native Worker tests cover lost commit responses, concurrent duplicates, rejected preconditions, identical-byte reincarnation, expiry, restart and failed checkpoint writes. The dialog resumes saved restores after history expires and distinguishes remote confirmation from local sync completion. |
| F02: anonymous requests consume notification quotas | Fixed | Edge admission is scoped to source-address hash and hostname. Only verified bearers/grants charge action/day quotas; an exhausted action charges neither counter. Enrollment exchange and authenticated management have separate daily pools. Native tests show invalid credentials cannot spend the owner's final slot and that edge-denied/unknown routes do no D1 work. Distributed anonymous traffic can still consume authentication reads; the documentation no longer claims a global anonymous-cost ceiling. |
| F03: directory/file replacement cannot converge | Fixed | Incoming files remove only recursively empty directories using nonrecursive host removals. Hidden/ignored children, parent-file obstructions, permission errors and children created during removal remain safe. Obstructed incoming bytes become a separate review copy where possible. A file tombstone recognizes a directory already replacing that file and leaves the directory untouched; a replacement during a byte read still fails the identity check. Real sync-engine/Worker tests converge in both directions. The test vault now rejects writes over folders and implements nonrecursive directory removal. |
| F04: exact-candidate hosted and physical acceptance | User-owned | Per the user's instruction, no hosted deployment, independent-account restore, physical iOS/Android, minimum-Obsidian or push-device rehearsal was attempted. Candidate metadata leaves these checks unverified. |
| F05: failed token removal aborts logout | Fixed | Logout invalidates in-memory authority and clears private UI before fallible storage cleanup. Token, draft, outbox and cache deletion fail independently, with persistent recovery guidance. Synchronous remote failures cannot prevent local logout, and delayed ordinary requests remain fenced. Chromium and WebKit regressions inject denied token/draft/outbox/cache deletion and failed remote revocation. If token deletion fails, reloading cannot be guaranteed to forget it; the UI instructs site-data clearing and session revocation. |
| F06: best-effort browser storage lacks protection/export | Fixed within browser guarantees | Settings reports persistent/best-effort/unavailable storage and offers a browser persistence request. Offline or unconfirmed ordinary changes can be exported with exact operation bodies/IDs without deletion or credentials. Tests cover granted, denied and unsupported persistence and inspect the downloaded private-data export. Device loss, clearing site data and browser policy can still erase local-only changes. |
| F07: browser zoom disabled | Fixed | Removed restrictive viewport attributes and global Safari gesture cancellation. Page touch behavior allows zoom; controls use manipulation behavior for immediate taps while retaining pinch zoom. Native browser regressions verify viewport/CSS/gesture permissions and enlarged-content availability. |
| F08: verification restarts starve later files | Fixed | A small server-bound progress file saves the rotating cursor independently of the large manifest. Repeated restarts reach late-sorting paths; read failures advance fairly without asserting deletion. Invalid/foreign hints restart safely, while I/O failures surface. Engine shutdown waits for an already-started progress write. File and byte budgets remain unchanged. |
| F09: native time presentation breaks visual tests | Fixed | Screenshot-only CSS fixes the native time-control width and masks its OS-dependent presentation. The actual value is asserted independently. Keyboard tests run separately from image comparison, and the existing 0.1% pixel threshold remains. Reviewed 24 affected time-control baselines; all 58 visual/keyboard tests pass. The release check now includes visual typechecking and tests. |
| F10: no tested rolling protocol window | Fixed | Protocol 8 retains ordinary protocol-7 writes. Both production clients negotiate the highest common version without changing saved bodies. Unsafe legacy restores receive 428, and new clients refuse restore on servers lacking receipt capability. Frozen protocol-7 wire metadata tests exercise current production transports; real Worker tests execute protocol-7 uploads/reminders and duplicate receipts. Compatibility docs define the adjacent-version window, capability fences, retention and rollback rules. These are executable wire-contract checks, not a claim of physical older-client installation. |

GitHub Dependabot security updates were also enabled and verified as enabled/unpaused. Existing scheduled dependency updates, secret scanning and push protection were retained.

## Verification

Node v26.8.2 and npm 11.19.1 were used. The repository's existing two modified browser scripts were preserved.

| Check | Result |
| --- | --- |
| ESLint, plugin and Worker TypeScript | Passed |
| Dead-code/dependency and third-party notice checks | Passed |
| Python backup/recovery tests | 24 passed |
| Unit tests | 1,721 passed in 230 files |
| Native Worker/D1/R2 suite | 316 passed in 43 files |
| Visual tests and separate keyboard tests | 58 passed; visual TypeScript passed |
| Full PWA Chromium/WebKit scripts | All 28 scripts passed in Chromium/WebKit |
| PWA production preview smoke | Passed |
| Production build, CSS scope and release artifacts | Passed in an isolated checkout |
| Repeat-build artifact hashes | Identical hashes for plugin JS/CSS, manifest, Worker and PWA asset JSON |
| npm dependency audit | Zero vulnerabilities |
| Gitleaks | History (720 commits) and current source passed |
| Git whitespace check | Passed |

The final build is created from a copy of the working source under `.generated/pre-release-fixes-2026-09-11/checkout/`, isolated from the user's running development watcher. It is based on commit `21bb9b85bf13a496c923170a47f4dd081cf31249` plus the working changes. Version remains 0.1.0. At validation time, no release, commit or push had been performed.

Local logs and candidate artifacts are retained under `.generated/pre-release-fixes-2026-09-11/`. The candidate record includes source and artifact SHA-256 hashes. It remains marked dirty and carries unverified hosted/device acceptance fields; successful local checks do not change those fields.

## Size changes

Safety and recovery code increases the plugin by about 7.3 KiB raw and PWA startup by about 1.6 KiB raw versus the audit. Device-storage settings remain in startup so the first settings tap also works offline. Pending-change export remains in the already-deferred recovery UI.

| Artifact | Measured raw | Measured gzip |
| --- | ---: | ---: |
| Plugin `main.js` | 1,451.83 KiB | 793.50 KiB |
| Plugin CSS | 138.39 KiB | 18.98 KiB |
| Worker including PWA | 1,311.31 KiB | 584.21 KiB |
| PWA startup assets | 451.10 KiB | 152.38 KiB |
| All PWA assets | 480.58 KiB | 163.56 KiB |

The plugin raw ceiling increases from 1,480,000 to 1,490,000 bytes; its gzip ceiling is unchanged. PWA startup ceilings increase from 461,000/155,600 to 463,000/156,500 raw/gzip bytes, and total raw assets from 490,000 to 493,000. Worker, CSS, PWA entry and total PWA gzip ceilings remain unchanged. These bounded increases cover the measured changes rather than suppressing size checks.

## Compatibility and recovery notes

- Update the server to gain safe restore support. Normal protocol-7 sync remains supported during the upgrade window.
- Checkpoint format 3 preserves pending restore authority. A plugin that understands only format 2 must not be used on the same checkpoint afterward.
- Restore retries always resume the saved operation. Never replace an expired uncertain operation ID to force replay; preserve the checkpoint and compare current remote state first.
- Incoming binary/topology review copies now carry the `incoming-review` cause instead of being mislabeled as concurrent edits.
- Persistent browser storage is risk reduction, not a backup. Export pending changes before clearing browser data.

Candidate source SHA-256: `b45185f37022b89bb7bb147e2576bf616b39678d326e8e8e5dc94a7581f81912`. The three files for manual installation and the full candidate record are in `.generated/pre-release-fixes-2026-09-11/candidate/`.
