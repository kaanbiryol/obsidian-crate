# Read-it-later implementation plan

Planning baseline: 2026-09-21, `master` at `48b9a902`, plugin 0.3.0 / server revision 59 / schema 1 / protocol 11. Implementation is ready for integrated testing on `codex/read-it-later`. Product behavior and the Markdown example live in [the feature spec](read-it-later-spec.md).

## Implementation status

Implemented on `codex/read-it-later`: local Reading and Web Clipper adoption; server policy and scoped enrollment; durable bookmark/metadata operations; bounded background Defuddle extraction; independent web Reading with cached article text and a persistent outbox; branded iPhone handoff; signed shortcut source/build command; and Android share-target storage and capture.

Server revision 66 uses schema 2 and protocol 11. The migration preserves existing file/version/token rows. Cloudflare upgrades create a verified paired D1/R2 checkpoint under a database write guard before migrating. Local upgrades require a stopped server and a new, verified backup. Recovery can download the cloud checkpoint into the existing archive format. No production server has been changed.

The extraction prototype is now production code. Defuddle 0.19.4 performs HTML extraction and Markdown conversion through its public `createMarkdownContent` export. Crate validates URLs and removes remote media before conversion; there are no Crate Markdown formatting rules or direct Turndown dependency. A shared build adapter supplies linkedom's DOMParser inside the Defuddle module and removes source-content diagnostics. Conversion failures retain a saved link instead of publishing the library's raw-HTML fallback. Async fallback extraction is disabled. Cloudflare uses `global_fetch_strictly_public`; self-hosted workerd uses a native public-only network binding that rejects private destinations after resolution. This replaces the socket experiment, which encountered hosted TLS/SNI and Cloudflare-address restrictions.

Automated tests cover source-preserving Markdown updates, deterministic clip adoption, duplicate IDs, concurrent edits/deletion, operation replay, scoped authority, extraction, native network restrictions, migration and backup preservation, browser enrollment/install grants, pending saves, interrupted acknowledgements, cached reading, phone confirmations, share-target fallback, and explicit logout. The existing reminders layout and auth-recovery browser suites are also exercised.

The total plugin bundle is approximately 3.16 MB raw / 1.67 MB gzip, including its compressed deployable Worker. The Worker is approximately 3.20 MB raw / 1.17 MB gzip, including Defuddle's full Markdown and math support. Reading is a deferred PWA chunk; startup assets remain within the existing budget. Measured limits include modest headroom and notices cover the new dependencies.

Use [the test guide](read-it-later-testing.md) for the running sandbox, plugin installation, signed shortcut, and upgrade commands. Physical iPhone/Android, installed Obsidian/Web Clipper, and live Cloudflare acceptance remain explicit manual checks. Browser automation is not evidence that those device/deployment checks were performed.

## What we are building

One **Reading** library in Obsidian and the existing Crate web app, with two capture paths:

| Entry point | Capture and extraction | How it reaches the other devices |
| --- | --- | --- |
| iPhone **Share → Save to Crate**, Android **Share → Crate**, or paste a URL into the web app | The server commits a bookmark, then fetches the page and extracts Markdown with Defuddle | Normal vault sync downloads the note; the web app reads the server's verified Reading projection |
| **Crate: Add reading link** in Obsidian | Save a local bookmark immediately; extraction follows its successful upload | Existing automatic/manual sync; the enriched revision returns through the same sync engine |
| Desktop Obsidian Web Clipper using **Crate Reading** | Clipper captures the loaded page into the configured vault folder | Crate adopts/indexes the marked note and syncs the exact captured body; the server does not extract it again |

The initial library supports inbox/archive, favorites, tags, title/source/tag search, a reader, and offline saved text. Reading status lives in Markdown frontmatter. Opening a note does not mark it done. Permanent deletion uses Obsidian's existing file workflow. Keep RSS, AI, PDFs, transcripts, new highlight editing, automatic image downloads, and reading reminders outside this release.

Phone and web capture work without Obsidian open, provided the Crate server is available. A self-hosted server must remain running. Clipper/local Obsidian capture needs the plugin running to index and upload.

The iPhone experience uses a branded web page: **Share → Save to Crate → Crate logo / Saving… → Saved ✓**. The Shortcut prepares a narrowly scoped save handoff; the browser page commits it and confirms its receipt. Reading the library still requires separate Reading enrollment. The page does not wait for article extraction or promise to close itself and return to the original app.

## What changed since the original draft

| Current code or contract | Consequence for this work |
| --- | --- |
| `src/cloudflare/server-release.json` has schema 1 and an empty migration registry | Reading introduces a real upgrade; do not reuse the old experimental schema assumptions. Allocate the next available schema and server revision at implementation time. |
| `provisioner.ts` exposes `beforeDatabaseUpgrade`, but upgrades require an integrated verified checkpoint | Cloud migration/backup integration is a prerequisite for release, not a final documentation task. |
| `scripts/local-server-runtime.mjs` checks exact schema/runtime compatibility | Add an explicit safe migration path for populated local/Docker data. Changing `server.json` is not a migration. |
| `auth_tokens.scope` is constrained to `vault` and `reminders`; router and authentication code assume those two cases | Add Reading scope checks and a tested token-table migration together. Existing reminder grants keep exactly their present access. |
| `src/pwa/main.tsx` and config are reminder-specific, with one stored reminder token | Introduce a small host shell and independent feature sessions. Avoid granting Reading through an old reminders token. |
| Manifest identity, scope, assets and service worker use `/notifications` | Keep those installed-app contracts. Add Reading deep links and an in-scope Android POST share handler. |
| `link-title.ts` already fetches bounded public HTML without caller credentials | Reuse compatible mechanics, while testing destination isolation separately for extraction in cloud and local runtimes. |
| Shared React, Base UI controls, semantic tokens, and Shadow DOM tests now exist | Build on current UI primitives. Share Reading content components; keep Obsidian and browser navigation/persistence adapters separate. |
| Reading would add to already constrained Worker/PWA/plugin bundles | Measure dependency and chunk costs early. Defuddle is server-only but its bundled Worker is embedded in the plugin. |

## Delivery order

Milestones are reviewable changes with executable acceptance checks. Complete them sequentially at the integration boundaries; do not distribute a partial server/schema change without its upgrade and recovery support.

### 0. Validate extraction and capture contracts

Deliverables:

- A small Defuddle + linkedom prototype inside Crate's actual Worker test/build environment, with no production route yet. Compare its output against representative article fixtures: headings, lists, tables, code, footnotes, relative links, multilingual text, malformed HTML, and pages with no usable article.
- Confirm the exact import entry point, conversion options, no extractor-initiated network calls (`useAsync: false`), resource limits and sanitization needs. Pin the validated versions and record their bundle/CPU/memory impact; do not import a URL-fetching CLI.
- Prove safe outbound HTTP behavior in Cloudflare and local workerd: time/byte limits, redirect validation, private destinations and DNS resolution/rebinding. A string-level hostname check is insufficient evidence. Select a constrained transport if the host fetch path cannot enforce the requirement; report the limitation explicitly before enabling extraction.
- Import a sample **Crate Reading** template into the real Web Clipper version. Verify destination, typed properties, timestamp with timezone, new-note collision handling and exact selected-content capture.
- Prototype the iPhone Shortcut's one-time configuration, URL/text input and browser handoff against a disposable test endpoint. Verify the branded saving/success/error page, operation-bound capability exchange, launch without a browser Reading session, early close/reload and actual Safari behavior. The preliminary Shortcut request retains system UI. This can validate the UX before the production enrollment API exists.

Done when: extraction runs in the target runtime with measured output/cost and an established network boundary; the capture formats are proven. Physical phone testing remains explicitly pending if no device is available. Record those results in this plan, including failed cases, rather than treating Node-only success as Worker support.

No real vault, production server, or live credential is needed for this milestone.

### 1. Local Reading and Web Clipper

Primary modules: new `src/reading/core/`, `data/`, `ui/`, `runtime.ts`, `register-integrations.ts`, and `clipper-template.ts`; focused integration with plugin settings/lifecycle.

- Implement schema/version validation, conservative URL identity, frontmatter creation and surgical metadata patches. Preserve unknown properties and unchanged body bytes. Crate-created filenames use IDs; imports keep their filenames.
- Register stable `add-reading-link` and `open-reading` commands and a Reading workspace view. Reuse existing shared buttons, icons, theme tokens and modal primitives.
- Provide opt-in settings and folder validation. Keep the server's folder/generation authoritative once connected; stale device startup must not overwrite it. Mirror the configured policy locally for offline indexing. No implicit adoption of unmarked Markdown.
- Export the **Crate Reading** Clipper template. Normalize only marked imports, fill missing metadata/identity once, preserve filenames/body, and mark their capture method so no enrichment is scheduled.
- Scope scans to the configured folder and metadata candidates; debounce events, defer normalization during active sync, guard conditional writes, and stop watchers on unload. Follow lifecycle cancellation patterns from `src/reminders/runtime.ts` without sharing reminder domain state.
- Add local inbox/archive/favorite/tag actions and open-note behavior. URL-only bookmarks remain visibly pending until an extraction-capable server processes them. Clipper text is readable immediately.

Done when: a real Clipper save appears in the Obsidian Reading view, survives reload/rename, and syncs as an ordinary file without altering its body. An unrelated file in the folder is untouched. Concurrent local adoption either converges on the same persisted ID or reports ambiguity without rewriting user content.

### 2. Storage upgrade, policy, and durable server capture

Primary integration: `schema.sql`, `server-release.json`, `migrations/`, database upgrade/provisioning/recovery code, local launcher, `authenticate.ts`, `router.ts`, and new `worker/reading/` modules.

Persist these responsibilities separately:

| Record | Purpose |
| --- | --- |
| Reading policy | Enabled state, exact folder, policy generation and optimistic policy revision |
| Reading item/source projection | Item ID, source file revision/hash/path, display metadata and searchable tags; rebuildable from verified notes |
| Identity/URL reservations | Stable item ownership and atomic capture deduplication; never choose a duplicate source arbitrarily |
| Reading operation receipts | Caller/policy binding, request hash, response and server-issued retry window |
| Projection/extraction jobs | Source identity, generation, attempt/lease/retry state and expected managed-block hash |
| Reading enrollment and grant metadata | Single-use grant kind, expiry, folder/generation and relationship to issued token IDs |
| Capture handoffs | Exact prepared capture, original operation ID, hashed short-lived capability, fixed expiry and originating grant; no library authority |

- Register the next schema migration and update the fresh schema together. Rebuild the constrained token table transactionally if needed; retain all existing IDs, hashes, metadata, expiry, indexes and push ownership. Separate typed Reading enrollment from existing reminder enrollment.
- Wire a verified paired cloud backup into `beforeDatabaseUpgrade`. For self-hosting, add an explicit stopped-storage upgrade using the same validated migration registry, with an exclusive lock, verified backup, transactional schema/receipts, integrity checks and atomic compatible runtime metadata publication. Repeated/interrupted attempts inspect persisted state; they do not reinitialize storage. Restore tests use the matching old runtime and a separate destination.
- Add exhaustive `vault`, `reminders`, `reading`, and `reading_capture` authorization. Unknown scopes fail closed. Bind scoped access to folder and policy generation, and validate that authority again at mutation publication. Include creation, listing and revocation of Reading grants in plugin account/device settings.
- Implement policy read/enable/update, enrollment issuance/exchange, capture, scoped receipt lookup, browser handoff prepare/commit/status, cursor list/detail, metadata update and extraction-retry routes. Handoff commits reuse the atomic capture path and recheck their originating grant. The spec's API table describes public behavior; define exact DTOs and errors before clients depend on them.
- Reuse `storage.ts`, staged immutable objects, `commitStagedFile`/commit effects, retained versions, namespace checks and changelog. Extend helpers with opaque revision preconditions where required; a content hash alone cannot distinguish delete-and-recreate of the same bytes. Do not build a parallel file API.
- Atomically commit a bookmark, receipt, identity/URL reservation and job. Distinguish durable bookmark acceptance from finished extraction. Expired requests stop for review; lost responses reuse exact bytes and IDs.
- Hook Reading projection into ordinary uploads, bulk uploads, restores, renames and deletes. Bootstrap existing marked files in bounded batches without blocking sync or rebuilding all items on every request.

Done when: an authenticated server capture appears in Obsidian through unmodified sync behavior, duplicate/retried captures converge, and the full scope matrix passes. Fresh install plus populated upgrade/backup/recovery pass for both hosting modes, preserving reminder behavior and existing file revisions.

### 3. Enrichment and guarded publication

Primary modules: `worker/reading/extraction/`, queue/coordinator, maintenance integration, and reusable fetch mechanics only where justified.

- Persist an extraction job as part of capture publication. A dedicated bounded coordinator processes it and maintenance recovers lost wakeups. Register new Durable Object bindings/classes with cloud provisioning, local runtime, reset/ownership inventories, packaging and recovery checks; preserve the inactive CloudSafety compatibility export.
- Fetch with the validated transport, parse via Defuddle, strip prohibited content and enforce decoded input/output limits. Never fetch embedded images or invoke optional third-party content services.
- Publish only against the current policy, exact source identity/revision and unchanged managed article block. Preserve personal notes and concurrent metadata. Deleted/moved/edited sources cancel or require review; they cannot be recreated by a late job.
- Project pending/ready/unavailable status from the committed note. Store operational diagnostics separately. Do not persist credentials, full URLs with secrets or article bodies in logs.
- Retain link-only bookmarks on permanent failure, back off transient attempts, and support explicit retry. Clipper imports make zero extraction requests.

Done when: a URL-only save becomes a readable Markdown article and offline Obsidian note, while extraction failure, crash/restart and concurrent user edits preserve the saved content. Confirm both Cloudflare and self-hosted execution, including missed-wakeup recovery.

### 4. Reading in the installed web app

Primary modules: new `src/pwa/reading/`, a small app-level section/session wrapper around the existing reminders application, new shared Reading components, and existing PWA install/update assets.

- Add **Reminders / Reading** navigation and `/notifications?section=reading&item=<id>` links. Keep existing reminder links, installed manifest ID/scope, notification launch behavior and default reminder screens working. Reading can be the selected default section once enrolled.
- Preserve the existing reminder token/config/storage keys. Add a separately versioned Reading grant/config, API client and session-generation guards. Bootstrap each feature independently: no reminders setup is required to use Reading, and expiry in one feature cannot invalidate the other's work.
- Enroll Reading through the current browser/installed-app handoff pattern, with distinct one-time grants and clear consent. Never copy a vault token into browser storage or grant Reading implicitly through reminder enrollment.
- Implement inbox/archive/favorites, tags, paginated search, add-link, source links and a safe Markdown reader. Share presentation with Obsidian using current UI primitives; use dedicated Reading classes under the established theme wrapper. Lazy-load reader functionality so the reminders startup path stays within measured budgets.
- Use a Reading-specific IndexedDB namespace/schema for confirmed items/text, separate from the reminders read cache. Cache on open and explicit download. Show **Available offline** only after persistence succeeds; use the spec's bounded text cache and eviction policy.
- Keep undispatched offline intent distinct from an immutable dispatched operation. Allocate a server-issued day/ID when connectivity permits; never regenerate an uncertain operation. Reuse small proven locking/expiry/export primitives, not the reminder-specific outbox as a second domain store.
- Extend update guards, storage recovery/export, cross-tab confirmation and app logout to both features. Expiration/re-enrollment retains reviewable pending work. Explicit logout clears all feature credentials and private data, reporting storage failures.

Done when: a Clipper or server-captured article can be downloaded, reopened offline, archived/favorited offline, then reconciled without duplicate commands or lost reminder drafts. Existing installed reminders users can update without reinstalling or losing push/session behavior. Reading-only enrollment also works.

### 5. Phone sharing and release acceptance

- Ship the tested **Save to Crate** Shortcut template, paired to an explicitly issued capture-only credential. Keep endpoint/secret configuration outside the distributable template. A new capture gets its operation ID from server metadata; an in-flight retry keeps it. Prepare the operation-bound handoff using the credential in an Authorization header, validate the same-origin launch URL and open `/notifications/save-reading`.
- Build the lightweight branded screen with Crate's logo, theme, reduced-motion progress and accessible status announcements. POST the prepared save, then show **Saved to your reading inbox** or **Already in your reading inbox** only after its receipt. Offer **Open Reading** with normal enrollment requirements, **You can close this page**, and accurate failure/expiry states. Never display artificial saving delays or wait for extraction.
- Keep handoff capability fragments short-lived, remove them from visible history immediately, and use header authentication for subsequent requests. No permanent browser login, library access, third-party resources or service-worker caching of private handoff data. Test lost replies, reloads, duplicate commits, early closure, revoked grants and expiry; expire abandoned intents while preserving capture receipts. Preparation failure before navigation uses the Shortcut's standard error UI.
- Add the Android manifest `share_target` and targeted service-worker POST handler at `/notifications/share/reading`. Persist bounded incoming URL/text before redirecting, then authenticate upload in the app. First install/no active service worker falls back to the online capture screen. Preserve a signed-out share as an unassigned local draft and require selecting/enrolling its destination before upload.
- Test native share input variations, multiple URLs, offline queueing, denied storage, cancellation, expired credentials and repeated sharing. Do not promise offline queueing for the first iPhone Shortcut.
- Document local server availability, public HTTPS and Quick Tunnel address changes. Prevent credentials or pending operations from being silently carried to another origin. A stable origin is recommended for everyday capture.
- Update privacy/setup instructions and dependency notices. Assign current release/schema/protocol/capability values, verify exact artifacts and update recovery tooling together. Do not bump versions in this planning-only change.

Done when both product acceptance flows pass:

1. With Obsidian closed, share a URL from an iPhone and from Android. On iPhone, verify the branded browser page progresses from saving to confirmed success without requiring a Reading browser session or waiting for extraction. Then use an enrolled Reading app to open/cache the article, reopen offline and archive it. After reconnecting and syncing Obsidian, the Markdown note contains the article and archived state. Lost acknowledgments do not create another active item.
2. Clip a selected excerpt on desktop through **Crate Reading**, let normal sync upload it, read it on the phone and archive it there. Its original filename/body remain unchanged; no server extraction occurs.

## Checks by area

| Change | Evidence required |
| --- | --- |
| Markdown and import | Fixture/property-preservation tests, malformed/unrecognized source handling, rename/duplicate identity, safe host rendering |
| Storage/auth/API | Real D1/R2 integration tests for atomicity, replay/expiry, scope isolation, projection invalidation and source verification |
| Migration/hosting | Actual populated baseline fixtures, failed/interrupted/repeated upgrade, matching backup restoration, unchanged hashes/tokens/reminders; local/Docker and hosted acceptance |
| Extraction | Real Worker fixtures, denied destinations/redirects, no hidden fetches, resource caps, retries/restarts and stale job rejection |
| PWA | Built Chromium and WebKit tests with native IndexedDB/Web Locks: cache failure, offline intents, exact retry, two feature sessions, multiple tabs, logout, update and install handoff |
| Shared UI | Light/dark and narrow/wide, Obsidian Shadow DOM, keyboard/focus, long article rendering, accessibility and affected visual baselines |
| Mobile capture | Physical iPhone Shortcut with branded browser handoff, capability isolation and all terminal states; installed Android share target; emulation alone does not establish these integrations |

Run affected lint/type checks, focused tests and production builds as each milestone lands. Measure `npm run size-check` when dependencies or rendering change. Before distribution, run `npm run release:check` and applicable local/server-package/Docker checks; retain the exact-artifact hosted and physical-device results. Browser cache body limits and upstream resource limits are initial product constraints, not claims of measured performance.

## Decisions retained and unresolved evidence

Retained decisions: Markdown is authoritative; one existing Crate app; two capture paths; opt-in Reading folder; independently scoped Reading access; Defuddle is preferred; no paid extraction service; first-release offline content is text; iPhone saving uses a Crate-branded web screen; existing notes and reminders are preserved.

Remaining acceptance evidence: hosted CPU/memory and Cloudflare upgrade/extraction, installed Clipper behavior, physical Shortcut install/pairing, and Android system share delivery. Local runtime and automated browser results are recorded above.

The milestones below describe the implementation sequence. The status above and test guide describe the current branch.
