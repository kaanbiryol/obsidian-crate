# Read it later

Status: implemented for integrated testing on `codex/read-it-later`. See [current implementation and acceptance status](read-it-later-plan.md#implementation-status) and [testing instructions](read-it-later-testing.md). This is not a published release.

Revalidated on 2026-09-21 against `master` at `48b9a902`. See [the implementation plan](read-it-later-plan.md) for code integration points, delivery order, and release gates. The current baseline is plugin 0.3.0, server revision 59, schema 1, and protocol 11 (ordinary writes remain compatible with 7). These are observed versions, not version numbers reserved for Reading.

## Outcome

A user shares an article from their phone, sees it in Crate's reading inbox, reads its saved text offline, and finds an ordinary Markdown note in Obsidian after the next sync. Phone-to-server capture works while Obsidian is closed. Desktop users can also save through Obsidian Web Clipper into their vault; Crate indexes and syncs those notes while Obsidian and the plugin are running. The feature uses the user's existing Cloudflare or self-hosted Crate server and requires no additional hosted account. Self-hosted capture requires that server to be running and reachable; closing Obsidian does not prevent it, but stopping its server does.

## First release

- Reading inbox, archive, favorites, tags, and title/source/tag search in Obsidian and the web app.
- Save a URL from either host, an iPhone Shortcut, or an installed Android web share target.
- Import desktop Obsidian Web Clipper captures using a provided **Crate Reading** template and existing vault sync.
- Extract public HTML articles into Markdown asynchronously; retain a useful bookmark when extraction fails.
- Read cached article text offline in the web app; queue supported changes safely.
- Open the source, open the note in Obsidian, archive/unarchive, favorite/unfavorite, and edit tags.
- Add personal notes using Obsidian's normal Markdown editor.

Deferred: RSS, newsletters, PDFs, video transcripts, AI features, full-library body search, creating/managing highlights inside Crate, automatic offline image downloads, native mobile apps, and reading reminder integration. Existing highlighted text or selections saved by Web Clipper remain ordinary note content. A later **Remind me** action can create a normal Crate reminder linked to the article; the first release does not introduce another scheduling system.

## User experience

### Enable Reading

Reading is off by default. **Settings → Crate → Reading** enables it and selects a folder, defaulting to `Reading/`. Explain that saving a URL sends it to the user's Worker, which requests the source website and stores extracted text in their vault. The website sees the server request; extraction does not use the user's browser login.

Validate the folder against portable sync paths and ignore rules. Do not allow overlap with the configured reminders folder. Never rewrite unrelated notes in an existing folder. Index only explicitly marked Reading notes. Initial release folder changes require Reading to be disabled and pending work resolved; no automatic migration of notes or grants. Re-enabling for another folder requires fresh web/capture enrollment.

Local Reading notes and views work without a server. Server extraction and phone-to-server capture require a connected, compatible deployment. A local URL-only save creates a bookmark that can be enriched after it reaches the server; Web Clipper supplies its own extracted content.

### Save and read

**Reading → Add link** accepts an HTTP(S) URL and an optional title. Saving commits a bookmark before attempting extraction. Show **Saved — preparing article**, then **Ready to read**, or **Link saved — article unavailable** with **Retry extraction** and **Open original**.

Inbox contains unarchived items, newest saved first. Favorites includes favorited items regardless of archive status. Opening an article does not archive it automatically. Archive is reversible; permanent deletion in the first release uses the Obsidian file workflow. Source deletion removes the item from web listings after projection and invalidates cached content during reconciliation.

The reader shows title, source domain, author when available, saved date, article text, and archive/favorite actions. Keep navigation, typography, themes, safe areas, and accessibility consistent with each host. Share reading components and models, not host navigation shells.

Add a **Reminders / Reading** section switch to the existing web app. Preserve its `/notifications` manifest identity, scope, service-worker registration, existing reminder deep links, and push behavior. Reading uses `/notifications?section=reading` with an optional item ID; this adds a feature to an installed app rather than requiring another installation. A reminders-only session can show Reading setup, but cannot read articles until separately enrolled. Reading-only enrollment must work without configuring reminders.

### Desktop Web Clipper capture

Provide **Settings → Crate → Reading → Export Web Clipper template**. Generate an importable JSON template named **Crate Reading** for the selected vault and Reading folder. Use Web Clipper's **Create a new note** behavior, populated title/source/author/date properties, and `{{content}}` for the Markdown body. Users import it once through Web Clipper settings; no fork of the extension, server credential, or new extension-to-Worker API is needed. Template exports contain the configured vault/folder names, which setup should make clear. Changing the configured folder requires updating the template.

Daily flow: **Web Clipper → Crate Reading → Add to Obsidian**. Web Clipper creates the note in the selected vault; Crate detects it, registers it as an inbox item, and existing automatic sync uploads it. It then appears in the enrolled web app on refresh/reconciliation. Offline desktop capture stays local until sync resumes. With automatic sync disabled, the user selects **Crate: Sync now**. Saving through Clipper must not be described as a confirmed server save.

Folder membership alone does not adopt arbitrary Markdown. The template supplies the explicit import marker `crate_reading_import: web-clipper-v1` and source metadata. It must not require a nonexistent Clipper UUID variable. Crate's local import normalizer fills missing canonical metadata and identity using a conditional vault update, preserving the filename, body, and user properties. Derive the initial UUID deterministically from a fixed versioned namespace plus the normalized initial vault-relative path and exact pre-adoption bytes; two devices receiving the same unadopted file converge. Once persisted, never derive the ID again. Invalid or ambiguous imports remain intact and show a source issue. Debounce create/modify events and retry only against unchanged input to avoid adopting an incomplete write.

A normalized clip has `capture_method: web-clipper`, `reading_status: inbox`, `favorite: false`, and `extraction_status: ready` when it contains usable saved text; use `unavailable` for a link-only clip. Preserve explicit valid user values and normalize a captured timestamp with an offset to UTC. The template emits a timestamp with an explicit offset; validate its actual export against the supported Clipper version. IDs and defaults may be absent only in marked, unnormalized imports. The Worker does not independently adopt these files or fetch their URLs while waiting for the normalized revision.

Treat Clipper's Markdown as the captured article, including selections, highlights, and personal additions. Do not add extraction-owned markers to this body or automatically fetch/re-extract it, even when empty. A future user-requested replacement requires preview and explicit acceptance. Preserve image links in the source note, but the Crate reading views suppress remote image loading and apply safe Markdown rendering; normal Obsidian editing/preview behavior is controlled by Obsidian. Offline availability guarantees cached text only.

If Clipper creates another file for a previously saved URL, preserve both notes and flag the duplicate; do not silently delete or merge them. The import template must use create-new behavior and the tested host collision handling, rather than append to or overwrite a prior article. This path captures what Clipper can read from the loaded page, which can differ from what a server fetching only the URL receives.

### iPhone capture

One-time setup under **Reading → Phone capture** provides installation instructions for an Apple Shortcut named **Save to Crate** and pairs it with this deployment using a dedicated capture credential. The distributed shortcut template contains no credentials. The user explicitly installs and configures it; do not promise automatic silent installation.

On iOS 27, provide **Save to Crate (iOS 27)** with no import questions. After installation, running it from the library asks for the endpoint and Authorization header and stores them together using shortcut-scoped Storage. Later shares reuse this setup. A library run reopens setup for a changed endpoint or renewed credential; cancellation or invalid input must preserve the previous values. Stored values can sync across the user's Apple devices through Shortcuts. Keep the import-question template for older iOS. The affected iOS 27 tester could not complete that older import flow; the new variant still requires physical-device acceptance.

Daily flow: **Share → Save to Crate → Crate-branded confirmation sheet → Saved to your reading inbox → Dismiss**. Accept a shared URL or extract a URL from shared text/Safari input. The supplied first-release Shortcut saves the first URL in shared input; share one article at a time. The Shortcut prepares a save handoff with the Worker and presents the returned Crate page using **Show Web View**, with reader mode off. This uses an iOS browser sheet instead of opening a Safari tab. iOS controls the presentation size and browser controls; this is not a custom native bottom sheet. The page completes the save and reports success only after durable acceptance. Extraction completes separately.

Use an Authorization header for the Shortcut's long-lived capture credential; never place it in a URL, article note, browser page, analytics, or log. A Shortcut credential is accessible to its owner through Shortcuts; label it accordingly and allow revocation. Validate the exact setup and import flow on a physical iPhone before shipping.

#### Branded save screen

Use a small mobile page at `/notifications/save-reading`, sharing Crate's logo, theme and typography. This is the selected first-release iPhone confirmation experience. It works without a pre-existing browser Reading session and does not enroll the browser in the library.

| State | Presentation and action |
| --- | --- |
| Saving | Crate logo, subtle progress indicator, **Saving to Crate…**, and the submitted source domain; respect reduced motion and announce status changes accessibly |
| Saved | Checkmark, **Saved to your reading inbox**, **Your article is being prepared**, and **Open Reading** |
| Duplicate | Checkmark and **Already in your reading inbox**; do not unarchive or re-extract the existing item |
| Unconfirmed/error | **Save not confirmed** with an explanation and **Retry** while the handoff remains valid; never imply that a timed-out request definitely failed |
| Expired handoff | **Save link expired** and instructions to share again; do not claim that an earlier attempt was never saved |

The logo can be visible as soon as the page renders; the Shortcut's preliminary request still uses Apple's own UI. Do not add artificial delays or wait for extraction to display success. **Open Reading** uses a Reading session if available in that browser context or presents enrollment instructions; the sheet must not assume access to Safari's session. A save-only handoff cannot open article contents on its own. Provide short **You can close this page** guidance after success. The user dismisses the system sheet; do not promise automatic dismissal or a launch into the Home Screen app.

#### Shortcut-to-browser handoff

The authenticated Shortcut sends the selected URL to `POST /reading/prepare`. The server assigns a stable operation ID and durably binds that exact intent to a short-lived, single-operation capability (five minutes). Preparing a handoff is not a saved bookmark. Opening the page alone is not a mutation; its script uses an explicit POST to commit the prepared operation through the same atomic capture/receipt path as direct URL saves.

Return only a same-origin HTTPS launch URL with an opaque handoff capability in its fragment. This narrowly scoped, short-lived capability is the sole credential allowed in that handoff URL; the long-lived Shortcut credential never leaves the Shortcut. The page removes the fragment with `history.replaceState` before loading optional content or issuing API requests, uses `Referrer-Policy: no-referrer`, and sends the capability only in the `X-Crate-Capture` header to `POST /reading/handoff`. Keep the prepared URL/title on the server, not in launch query parameters. Redact capabilities from diagnostics, serve private responses with `no-store`, use no third-party page resources, and never cache private handoff state in the service worker.

The capability authorizes only committing this prepared payload and inspecting its minimal receipt. It cannot alter the URL, select another folder, read the library, mint grants, or write other notes. Revalidate its originating credential, folder and policy generation at commit. Store only token hashes server-side. Retries, duplicate page loads, and lost responses retain the prepared operation ID; a completed commit can return its receipt again but cannot run twice. Reloading or retrying the prepared handoff never extends its server deadline. Expired capabilities are rejected even when a receipt exists. The page retains the capability in tab-local session storage for a five-minute reload/retry window, including after confirmation; the server enforces the original deadline and originating credential. A fresh Shortcut invocation prepares a new operation, with URL deduplication preventing a duplicate bookmark.

Closing the page before commit can leave only a prepared intent; after commit, the bookmark survives closing the page and extraction continues on the server. Bound and expire abandoned handoff records without deleting normal capture receipts. The prototype must verify this behavior, failed page navigation, Safari session separation, history cleanup, and whether browser storage is available in the actual Shortcut launch context.

Pair against a stable server origin where possible. If a self-hosted Quick Tunnel address changes, the user updates the Shortcut's endpoint and re-enrolls the web app at the new origin. Pending browser commands are never silently transferred between origins; retain the existing export/recovery path.

The first Shortcut requires connectivity. If preparation fails before the web page opens, Shortcuts displays its standard request error. Share the link again to retry; the next prepared operation is deduplicated by URL. Once the page opens, its branded error/retry states take over. A later manual invocation may submit a fresh operation; URL deduplication prevents a second active item. Do not claim a durable offline Shortcut or handoff queue. Users can instead paste into the enrolled web app for local pending capture.

### Android capture

An installed Crate web app on supported Android browsers registers a URL/text share target at `POST /notifications/share/reading`, inside its existing scope. The service worker handles that specific POST and durably stages the incoming URL before redirecting to the Reading capture screen. **Share → Crate** opens a compact capture screen and durably stores the intent before showing **Saved on this device — waiting to upload** when offline. Once the server acknowledges it, show **Saved to your reading inbox**. Unsupported browsers retain paste-a-link capture. A network fallback serves the same capture flow without treating the unauthenticated POST as permission to write to the vault.

A shared link never carries authorization. Require an enrolled Reading session before upload, and preserve the incoming draft while enrollment is completed. Authenticate the eventual API mutation independently from the share-target navigation.

## Markdown contract

One article per file. Crate-created captures generate a stable UUID at creation and use `Reading/<uuid>.md` so titles do not cause renames or filename collisions. Imported Web Clipper notes retain their existing filenames and receive an ID during normalization. Display the title from frontmatter. Users may rename files; identity comes from `crate_reading_id`, not the path.

```markdown
---
crate_reading_version: 1
crate_reading_id: "<uuid>"
title: "Example article"
source_url: "https://example.com/article"
resolved_url: "https://example.com/article"
author: "Example Author"
saved_at: "2026-09-14T12:00:00Z"
reading_status: inbox
favorite: false
tags: []
extraction_status: pending
---

# Example article

[Original article](https://example.com/article)

<!-- crate:article:start -->
Article text will appear here when available.
<!-- crate:article:end -->

## My notes
```

Required: version, ID, title, source URL, saved date, reading status (`inbox` or `archived`), favorite, tags, and extraction status (`pending`, `ready`, or `unavailable`). Author and resolved URL are optional. Serialize frontmatter with a safe YAML serializer; imported text cannot add properties or escape into Markdown structure. Dates are UTC ISO strings, tags are strings, and unknown user properties must survive edits.

The body, including personal notes, is canonical Markdown. Extraction may replace only the initial, unchanged managed article block. Store its expected hash in the extraction job. Strip reserved marker strings from extracted content. If the user changes/removes the block or malformed/duplicate markers appear, preserve the file and stop automatic replacement. Offer explicit review of a new extraction; never overwrite an edited article on retry. Metadata changes patch only owned fields and preserve other text.

Reject unsupported versions or malformed metadata from automatic mutation and show a source issue. Duplicate IDs across files require resolution rather than choosing a winner. A move outside the configured folder removes web access and cancels enrichment. Copying an ID must not grant access to the original item.

## Source of truth and sync

Markdown in the vault/R2 is authoritative. D1 stores a rebuildable reading projection plus non-rebuildable operational records (credentials, receipts, identity reservations, extraction jobs). Index records must include the source path, opaque revision, and content hash. Never serve an item whose current source identity or folder authority cannot be verified.

Reuse existing file namespace validation, staged immutable R2 objects, conditional D1 publication, changelog, retained versions, and commit effects. Do not add a direct R2 write path that bypasses file metadata. Generalize `markdown-file-staging.ts` where needed without coupling Reading to reminder-specific errors or behavior.

A server capture stages the bookmark and atomically publishes file metadata, changelog, capture receipt, identity/URL reservation, and extraction job. R2 and D1 are not one transaction: failed publication leaves a tracked staged object for existing cleanup, not a visible reading item. A durable acknowledgment means the bookmark was published, not merely that a background promise started.

Local Obsidian saves use vault APIs and existing sync. Committed canonical Reading notes from any writer enqueue projection through commit effects; enrichment is only eligible for URL-only captures with a verified pending managed block. Web Clipper imports bypass enrichment. An unnormalized marked import may arrive through sync first; retain it as a pending source until the plugin publishes its normalized revision, without exposing an incomplete reading item or fetching the URL. Local saves awaiting sync show that state. Concurrent local/server captures of the same URL are reconciled as duplicate sources without deleting either note or merging personal notes automatically.

Archive, favorite, and tags use semantic preconditions plus file revision compare-and-swap. Preserve concurrent body changes by rereading and applying only a still-valid metadata patch; otherwise return a conflict with the current state. Extraction also verifies current identity, policy generation, file revision, and managed-block hash before publishing. Deletes, moves, and policy changes cannot be undone by a delayed job.

## Capture and deduplication

Normalize URLs conservatively: lowercase scheme/host, remove default ports, and remove fragments for the initial deduplication key. Preserve query parameters and their order; do not indiscriminately strip tracking-looking fields that may identify content. Keep the supplied URL in the note. Document fragment-based applications as link-only limitations.

Deduplicate active server captures by deployment, Reading policy generation, and normalized URL. Concurrent requests must converge through an atomic reservation, not a check followed by an unguarded insert. Saving an existing item returns **Already saved** and does not unarchive it, change its saved date, or enqueue another extraction. A capture-only response does not disclose existing article contents or personal metadata.

Request idempotency is separate from URL deduplication. Each dispatched mutation includes a versioned operation ID and immutable request bytes/hash. Matching receipts replay the result; reuse with different bytes fails. Follow the existing server-issued 180-date retry window, monotonic cleanup floor, and expired-operation review semantics in [reminder retention](reminder-retention.md), with Reading-owned records. A retained receipt for a deleted item never recreates it. A new intentional save after deletion may create a new identity.

An undispatched offline draft may receive a fresh server-issued operation ID on reconnect. Once dispatched, never silently replace its operation ID after timeout, expiry, re-enrollment, or reload.

## Extraction

Run extraction in the shared Worker runtime on both Cloudflare and self-hosted Miniflare/workerd, with a durable D1 job queue and a dedicated bounded coordinator/alarm path. Use scheduled maintenance to recover missed wakeups, including the local runtime's maintenance driver. Do not rely solely on `waitUntil`, and do not use reminder delivery capacity for article fetching. Record attempts, leases, next retry time, and a terminal reason. Start with three attempts for transient failures; retry permanent extraction failures only on explicit request. Register any new coordinator class/binding through cloud provisioning, local runtime, reset/ownership checks, and recovery verification together.

Preferred extraction candidate: **Defuddle**, the library used by [Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper) for content extraction and Markdown conversion. Evaluate it directly with a Worker-compatible DOM implementation, initially linkedom. Replace the earlier Readability-plus-converter proposal with this pipeline: Crate's bounded fetch → parsed document → Defuddle → Crate's content validation and Markdown writer. Crate continues to own IDs, frontmatter, article markers, persistence, and retry behavior.

The reviewed [Clipper API](https://github.com/obsidianmd/obsidian-clipper/blob/b522a4d44b4fda25b91262085715ad7368604f7f/src/api.ts) also accepts HTML and a caller-provided document parser, but adds template compilation and note generation. Use it as an integration reference; direct Defuddle use is the initial choice because this release has a fixed Reading note contract. Browser-extension capture can use an already loaded page; a Worker receiving only a URL still has to obtain usable HTML. Reusing the extractor does not confer browser login access or execute page JavaScript.

Before committing dependencies, prove the chosen Defuddle entry point and DOM implementation in the real Worker runtime, including extraction quality, CPU/memory use, licenses, and bundle budgets. Use supplied documents rather than a URL-fetching CLI. Set `useAsync: false` to disable Defuddle's documented third-party extraction fallbacks, and verify that the complete parsing/conversion path makes no network calls. Do not treat content extraction as sanitization. Pin the validated versions in the lockfile and include dependency notices. No browser automation service or paid extraction provider in the first release. If a page requires JavaScript execution or login, save the link and report unavailability.

The existing `src/cloudflare/worker/link-title.ts` demonstrates bounded reads, manual redirects, and credential-free requests. Extract shared fetch mechanics only where contracts match; preserve the title endpoint's response and smaller limits. Its hostname checks are not proof of DNS/destination isolation for article fetching, especially on a local server. Validate that boundary separately in both hosting modes. Defuddle stays out of plugin runtime imports and PWA assets, but its Worker bundle still increases the embedded plugin artifact size.

Initial limits to validate in the spike: HTTP(S) only, no URL credentials, ports 80/443 only, at most three redirects, 15-second overall deadline, 2 MiB decoded response body, and 1 MiB generated Markdown. Accept HTML/XHTML; reject downloads and unsupported content. Stream with a byte cap instead of trusting Content-Length. Cap title at 500 characters, URL at 8 KiB, and capture JSON at 16 KiB. Cap tags at 50 entries of 100 characters each.

Validate every redirect and block loopback, private, link-local, metadata, and deployment-internal destinations, including IPv6 and encoded IP forms. Hostname string validation alone is insufficient against DNS rebinding. The extraction spike must demonstrate enforceable destination restrictions in the actual Worker runtime. If the available fetch path cannot provide that guarantee, extraction stays disabled until a constrained fetch mechanism is established; bookmark capture can still ship.

Never forward Crate credentials, browser cookies, or authorization to article hosts. Do not fetch secondary resources. Treat HTML as untrusted: drop scripts, forms, embeds, event handlers, raw executable HTML, and unsafe URL schemes. Render Markdown using the host's safe rendering path, with equivalent protections in the PWA. Preserve links and image alt text, but do not automatically load remote images in either reader; the initial generated article omits remote image embeds. Source pages may contain instructions aimed at agents; they are article data only.

Save diagnostic categories, timing, and byte counts without logging article bodies, credentials, or full URLs containing query secrets. Explain expected Cloudflare storage/request costs in setup and documentation. Initial per-credential capture limit: 30/minute and 500/day, plus a deployment cap of 1,000 outstanding extraction jobs. Enforce bounded storage and authenticated budgets; return an actionable retry response rather than silently dropping work.

## Authorization and API

Keep existing reminder-only sessions unchanged. Add explicit `reading` and `reading_capture` scopes, each bound to a Reading folder and policy generation. A Reading session reads articles and changes reading metadata; a capture credential only prepares captures and creates bookmarks, replaying its own capture receipts on exact retries. Neither accesses sync files, reminders, shared settings, device management, or arbitrary paths. The server chooses capture paths.

The existing router currently treats all non-vault principals through a reminders allowlist. Replace that with exhaustive per-scope authorization before adding new token types. Test every scope against every route family. A combined web shell can hold separately enrolled reminders and Reading grants; enrollment in one feature does not imply consent to the other.

Use one-time, short-lived enrollment grants from an authorized plugin. Reading sessions expire after 90 days; capture credentials also expire after 90 days and can be individually revoked and replaced. Renewal requires authorized pairing, not self-renewal by a scoped token. Setup must display expiry and recovery instructions. Disabling Reading or changing its policy generation invalidates grants and blocks pending mutations/jobs; existing notes remain.

The current database restricts `auth_tokens.scope` to `vault`/`reminders`, and reminder enrollment has its own untyped table. Reading requires an explicit migration for new token scopes, generation binding, and separate typed enrollment records; extending only the router is insufficient. Preserve existing token IDs/hashes/expiry and push ownership. Use the current browser-versus-installed-app enrollment handoff, session-generation guards, and revocation patterns with separate Reading authority. Explicit app logout clears both feature sessions and private stores; expiration or replacement of one session must not erase the other feature's pending work.

Implemented routes:

| Route | Authority | Contract |
|---|---|---|
| `GET/POST /reading/policy` | vault | Read or change the opt-in destination with a policy revision precondition |
| `POST /reading/access` | vault | Issue capture access or a one-use browser setup grant |
| `POST /reading/exchange` | one-use setup/install grant | Issue a folder-bound Reading session; only an initial setup grant yields one short-lived install grant |
| `GET /reading/session` | reading, vault | Current policy generation and server operation day |
| `POST /reading/capture` | vault, reading, reading_capture | Durable bookmark commit or deduplicated result; operation ID required; exact retry replays its receipt |
| `POST /reading/prepare` | reading_capture, reading, vault | Prepare one exact capture and return a five-minute browser handoff |
| `POST /reading/handoff` | operation-bound capability | Commit the prepared operation or replay its minimal receipt |
| `GET /reading/list` | reading, vault | Verified paginated metadata; filters and title/source/tag search run in the client |
| `GET /reading/item?id=…` | reading, vault | Verified Markdown within the enrolled folder |
| `POST /reading/update` | reading, vault | Archive/favorite/tag patch with semantic preconditions and operation ID |
| `POST /reading/retry` | reading, vault | Explicit bounded extraction retry, preserving edited content |

Receipt lookup uses exact mutation replay; there is no separate public operations endpoint.

Expose feature/protocol availability through existing uncached server metadata. Use existing session revocation machinery where possible. Define structured errors for unsupported server, expired session, expired operation, conflict, source issue, rate limit, and extraction unavailable. An extraction failure does not turn an acknowledged capture into a failed save.

## Offline web behavior

Partition IndexedDB data by deployment, scope, folder, policy generation, and session ownership. Cache confirmed list records and article text with revisions. Opening an article caches it; a separate download control is deferred. Mark **Available offline** only after the text commit to IndexedDB succeeds. The inbox alone does not imply every article is downloaded.

Persist capture drafts and archive/favorite/tag commands before optimistic UI. Reuse proven outbox locking, immutable dispatched requests, receipt settlement, conflict review, expiry/export, and cross-tab coordination patterns. Do not copy reminder-specific assumptions into Reading. Coalesce only undispatched metadata drafts, never dispatched commands.

Show cache quota failures and keep exportable pending work. Evict least-recently-opened confirmed article bodies; never evict drafts or pending commands. The first release keeps up to 50 articles or 20 MiB of article text; cache-size configuration is deferred. Browser eviction remains possible, so offline availability is verified on access, not treated as a permanent guarantee.

Logout clears Reading credentials, cache, and pending private content across tabs using the existing recovery/export interaction where necessary. Remote revocation blocks further requests; an offline device cannot learn revocation until it reconnects. PWA updates must preserve pending work and require protocol compatibility before dispatch.

## Implementation boundaries

- `src/reading/`: schema/parser, URL identity, repository contracts, local index/watcher, Web Clipper template export and import normalization, metadata writer, shared reading components, commands and view registration.
- `src/cloudflare/worker/reading/`: capture, projection, safe extraction, jobs, receipts, API handlers and scope checks.
- `src/pwa/reading/`: web API, cache/outbox adapters, host views and share handling.
- Existing plugin settings/lifecycle: opt-in, folder policy, runtime registration and cleanup.
- Existing Worker schema/provisioning: new tables/indexes, constrained token-table migration and coordinator binding; allocate the next schema/protocol version at implementation time.

Do not duplicate sync, auth, or deployment infrastructure. Keep extraction dependencies in the Worker bundle and reader rendering dependencies limited to their consuming hosts.

## Upgrade and hosting requirements

Follow [server upgrades](server-upgrades.md). The schema-1 baseline has no released migration entries yet. Register a checksummed schema migration and wire the provisioner's `beforeDatabaseUpgrade` hook to a verified paired checkpoint before distributing Reading to existing Cloudflare installations. The self-hosted launcher currently rejects schema-hash changes; add a tested stopped-storage migration/backup workflow for existing local and Docker data rather than editing its compatibility metadata. Both fresh installation and upgrade are required acceptance paths.

Preserve file content hashes, storage keys, device credentials, reminder receipts/observations, pending commands, and the inactive `CloudSafety` compatibility export. Update server revision for distributable Worker/PWA/provisioning changes. Advertise a Reading capability; choose protocol changes according to actual wire invariants, and retain compatible existing sync/reminder clients. New UI on an old server offers an update and preserves local drafts. Do not rewrite the baseline schema in place or ship a migration with no supported backup/recovery route.

## Delivery sequence

1. Prove Defuddle plus a DOM implementation, outbound fetch restrictions, and bundle impact on both runtime profiles; prototype Shortcut pairing and Clipper template import. See plan milestone 0 for evidence needed before choosing dependencies.
2. Implement the Markdown contract, local Reading runtime/view, and Web Clipper template/import. Use the existing file sync and preserve captured bodies.
3. Implement tested upgrades for both hosting modes, Reading policy/credentials, atomic server capture, projection, and durable retry records.
4. Add bounded extraction jobs and guarded publication, with preserved personal edits and graceful link-only outcomes.
5. Add Reading to the existing PWA with independent enrollment, safe reader rendering, offline cache and pending changes.
6. Complete iPhone Shortcut and Android share capture, then verify both end-to-end acceptance flows and the migration/release matrix in the plan.

Each step is independently testable; the first user-facing release includes the complete phone capture flow.

## Verification and acceptance

- Unit tests: schema round trips and preserved unknown fields; malformed markers; URL normalization; extraction sanitization and size limits; deduplication semantics; metadata conflict handling.
- Real Worker/D1/R2 tests: simultaneous captures; lost acknowledgment/retry; transaction failure after staging; receipt expiry; deletion followed by replay; projection rebuild; extraction lease recovery; edits/moves/deletes during extraction; policy invalidation; exact scope isolation and destination restrictions.
- Hosting/upgrade tests: fresh and populated schema-1 cloud/local installations, checkpoint creation failure, interrupted/repeated migrations, token-table preservation, coordinator restart, self-hosted maintenance recovery, and restore from verified pre-upgrade backups. A new schema must not require vault re-upload.
- Sync integration: server-created article downloads normally; local edits survive enrichment and metadata changes; local duplicate captures preserve both notes; retained history and paired recovery include new operational records.
- Desktop Clipper integration: import the generated template into the supported extension version and capture through **Add to Obsidian**. Verify configured vault/folder, title collisions, typed properties and timestamp, idempotent normalization across devices, unnormalized uploads, moves, duplicate URLs, preserved selections/body bytes, and zero server extraction calls for imported clips. Ordinary unmarked notes in the folder remain untouched. Check paused/offline automatic sync and source image preservation versus safe reader display.
- Browser tests: offline capture draft, dispatched request replay, quota failure, body eviction, expired session, logout, multiple tabs, service-worker update, and protocol mismatch. Verify keyboard navigation and screen-reader labels.
- Physical devices: Safari share-sheet Shortcut installation/pairing and daily save; actual installed Android share target; installed iPhone/Android reader reopened offline. Desktop browser emulation is not evidence for these flows.
- Branded handoff: browser without a Reading session, normal/duplicate saves, lost preparation or commit responses, reload, early close, expiry, credential revocation, wrong-origin launch rejection, fragment removal, no private caching, and no access beyond the prepared operation. Verify visible success follows the bookmark receipt and never waits for extraction.
- Performance: bounded paginated listings at 10,000 articles; no article-body download to render the inbox; no vault-wide startup scan for Reading; existing plugin/Worker/PWA budgets remain enforced.
- Required implementation checks: repository lint, plugin and Worker type checks, focused tests, production build, then the release gate for shipping. Update dependency notices if packages are added.

Acceptance scenario: with Obsidian closed, share a public article from a phone and receive durable save confirmation. Open its extracted text in Crate, verify **Available offline**, enable airplane mode, reopen and read it, then archive it. Reconnect and sync Obsidian: exactly one article note appears with its source, text, and archived state. Repeat with extraction failure and a lost response; the bookmark remains accessible and retries do not create another active item.

Desktop acceptance: install the exported **Crate Reading** template, clip an article into the configured vault folder, and confirm it appears in the local inbox and then the web inbox through ordinary sync. The article body stays exactly as saved by Clipper, including a deliberately selected excerpt; the Worker makes no extraction request. Archive it on the phone and verify the original note's metadata updates without changing its filename or body.

## References

- [Crate architecture](architecture.md), [protocol](protocol.md), [Worker API](worker-api.md), and [retry/retention](reminder-retention.md).
- [Implementation plan](read-it-later-plan.md), [server upgrades](server-upgrades.md), [self-hosting](self-hosting.md), [browser storage recovery](pwa-storage-recovery.md), and [shared UI](ui-styling.md).
- [Shiori](https://www.shiori.sh/): product reference for capture, inbox, and reading experience; no integration dependency.
- [Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper/tree/b522a4d44b4fda25b91262085715ad7368604f7f): extraction and integration reference reviewed on 2026-09-14.
- Web Clipper [templates](https://obsidian.md/help/web-clipper/templates), [variables](https://obsidian.md/help/web-clipper/variables), and [capture flow](https://obsidian.md/help/web-clipper/capture): template import, destination selection, and saved content behavior reviewed on 2026-09-14.
- [Defuddle documentation](https://github.com/kepano/defuddle/tree/a0984a817518565cedd0f89423c85cfff9e8ba45): preferred extraction dependency; documents DOM inputs, Markdown output, and the `useAsync` option. Worker compatibility remains to be tested.
- [Apple Shortcuts share-sheet input](https://support.apple.com/en-au/guide/shortcuts/apd350ce757a/ios).
- [Web share target](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target): installed-app receiving mechanism. Android Chrome supports it; Safari/iOS does not in the compatibility data reviewed on 2026-09-14. Recheck support during implementation.
