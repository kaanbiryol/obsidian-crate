# Crate documentation

Maintainer and contributor documentation for the plugin, Worker and PWA. User-facing guides live on [the documentation site](https://crate.kaanbiryol.com/docs/). Start with the [architecture](architecture.md) and the [testing guide](testing.md).

## Architecture and protocol

- [Architecture](architecture.md) - plugin, Worker and PWA responsibilities, bindings, authentication, build and component ownership.
- [Protocol](protocol.md) - protocol versions and the retry, revision and storage rules between clients and the Worker.
- [Worker API](worker-api.md) - endpoints, authentication, request formats and responses.
- [Current contract](current-contract.md) - generated, source-checked server revision, schema, protocol and transfer limits.
- [Compatibility](compatibility.md) - upgrade order, compatibility and rollback rules across plugin, Worker, PWA and persisted formats.
- [End-to-end encryption](e2ee-implementation.md) - opt-in encryption: enabling, recovery, approval protocol, protection boundary and limits.

## Sync

- [Sync pipeline](sync-pipeline.md) - how the plugin discovers, plans and transfers vault changes.
- [Content verification](content-verification.md) - the rotating content check that catches edits preserving timestamps and sizes.
- [Checkpoint recovery](sync-checkpoint-recovery.md) - how the local sync checkpoint is scoped to a server and kept when servers change.
- [Upload recovery](upload-recovery.md) - resumable initial import, upload retries and rename preservation.
- [Initial upload performance](sync-performance.md) - write budget, local benchmarks and hosted verification of the initial import.
- [Sync capacity](sync-capacity.md) - local capacity and interrupted-history regression measurements.
- [Sync diagnostics](sync-diagnostics.md) - sync history and the exportable diagnostics report.

## Reminders

- [Embedded reminders](embedded-reminders.md) - fenced code blocks that show reminder lists inside notes.
- [Reminder clock](reminder-clock.md) - the shared clock that keeps Today, Upcoming and overdue views current.
- [Reminder retention](reminder-retention.md) - the retry window and retention policy for web reminder commands.
- [Reminder source recovery](reminder-source-recovery.md) - recovering reminder notes that cannot be read safely.
- [Notification processing](notification-processing.md) - how committed changes become scheduled notifications, and the database reads involved.

## Reading

- [Test Reading](read-it-later-testing.md) - running, installing and testing Reading, including the local preview, iPhone shortcut and Web Clipper.
- [Reading highlights](reading-highlights.md) - how highlights are stored in article Markdown and edited safely.
- [Reading shortcuts](reading-shortcuts.md) - maintaining the iPhone shortcut and its capture contract.
- [Reading and encryption](reading-e2ee-assessment.md) - how Reading works with end-to-end encryption.
- `shortcuts/save-to-crate.plist` is the iPhone shortcut source file, not a document.

## PWA and shared UI

- [PWA storage recovery](pwa-storage-recovery.md) - browser storage for confirmed offline copies, pending commands and drafts, and how it recovers.
- [Tab convergence](pwa-tab-convergence.md) - how confirmed reminder changes reach other open tabs.
- [UI styling](ui-styling.md) - shared plugin and PWA components, Sass and visual rules.

## Server and deployment

- [Deploying and operating the server](deployment.md) - Cloudflare OAuth setup, deployment, updates, recovery and deletion.
- [Self-hosting](self-hosting.md) - running the server locally or in Docker, remote access, backups and updates.
- [Server upgrades](server-upgrades.md) - server revision, schema versioning, migration and release contracts.
- [Backup and recovery](recovery.md) - paired D1 and R2 archives, restoring automatic upgrade backups and investigating missing notes.

## Testing and release

- [Testing](testing.md) - test suites, harnesses and acceptance checks.
- [Preparing a plugin release](releases.md) - draft release, signed shortcut, assets and publishing.

## Archive

Historical notes kept for context. They describe past states and may not match the current code; use the documents above for current behavior.

- [Read it later design](archive/read-it-later-spec.md) - original Reading design notes.
- [Read it later implementation plan](archive/read-it-later-plan.md) - original Reading implementation plan and status.
- [E2EE review](archive/e2ee-review.md) - dated snapshot review of the encryption work (2026-10-02).
- [Reading extraction evaluation](archive/reading-extraction-evaluation.md) - comparison of Defuddle, Readability, Firecrawl and Jina on sample pages.
- [Article fetching research](archive/reading-fetch-research.md) - why article fetching stays on the server rather than in the PWA.
