# Maintain Reading shortcuts

Installed Shortcuts are independent clients. Updating a Worker or the app wire
protocol must not require users to edit native actions or install another
shortcut when capture semantics remain compatible.

## Contracts and source

`src/reading/shortcut-contract.json` defines the capture contract version,
template revision, minimum supported revision, API paths, and public download,
support, and issue links. The native builders, Worker metadata, save page, PWA
setup, and contract documentation use this source.

The capture contract is version 1; the template is revision 2. The app wire
protocol in `src/protocol.ts`, server revision in `server-release.json`, and D1
schema are separate numbers. Do not change the capture contract or native
headers merely because one of those numbers changes.

- `POST /reading/shortcut/v1/exchange` accepts only `{ token }`, redeems a
  short-lived pairing grant once, and returns capture access. Pairing codes keep
  the released `/reading/shortcut-exchange#<grant>` format; the new native
  template derives the versioned request URL locally and sends the grant in JSON.
- `POST /reading/shortcut/v1/prepare` accepts capture access and only
  `{ url, title? }`. The server creates the immutable capture operation and a
  five-minute capability. Preparation is not a save receipt.
- The public save page commits that capability using the live server's current
  app protocol. It shows **Saved to Crate** only after a valid durable receipt.
  Retry and reload reuse the same capability and operation.

The exact released legacy requests also have adapters: preparation with app
headers 1 or 11, and pairing exchange with header 1. Only capture access bypasses
app protocol retirement on preparation. All other scopes and routes retain
normal app protocol checks. Native and legacy paths share rate limits.

## Future changes

Increase the template revision when native actions change. Keep the contract
version fixed for compatible UI, diagnostics, and setup improvements. Old
templates keep saving and the live page offers an optional download when their
revision is older. Users install updates themselves; no fetched shortcut or
plugin code executes automatically.

For a breaking capture change, add a new versioned route and an explicit adapter
for each retained contract before distributing its native template. Keep old
request meanings and capture scope limits intact. Add regression fixtures for
both old and new requests. Do not broaden the general wire gate to admit old
versions. Retire a contract or raise the minimum template revision only when
continuing support would violate current invariants, with explicit update
guidance. A newer client reaching an older supported Worker receives
**Update your Crate server**; a retired client receives **Update your shortcut**.

The revision-2 template can upgrade a stored legacy preparation endpoint locally
without another exchange if Shortcuts retains its storage. A new installation
may need pairing. The update instructions always include creating a fresh
pairing code in the enrolled Crate app. Failed re-pairing must leave previous
stored configuration intact; a lost successful exchange needs a new one-use code.

## Failure pages and privacy

Recognized native HTTP failures return a same-origin error launch URL, including
authentication, compatibility, and rate-limit failures. The native template
opens it in **Show Web View**. Missing or unusable launch URLs open the public
`/shortcuts/help/` page. That page is built from the same renderer and browser
logic as the Worker page and cannot commit saves.

**Copy diagnostics** includes stage, status, a known error code, request ID,
server revision/fingerprint, PWA asset version, app protocol, shortcut contract/revision, browser family,
and iOS version when available. It excludes the server address, article URL and
title, bearer credential, pairing code, capability, and raw server error text.
Clipboard denial reveals selectable text. **Report on GitHub** opens a prefilled
draft that the user reviews and submits. Error fragments are cleared from the
address bar and cannot replay an earlier stored capture.

iOS permission denial, TLS failure, or a native action abort before a usable
HTTP response may stop the shortcut before **Show Web View** runs. The browser
page cannot catch those native errors. Test those states on a physical iPhone;
do not promise a custom page for every OS failure. A Shortcuts completion
checkmark alone is never confirmation that Reading committed an article.

## Rollout and verification

Publish the public fallback page before distributing a template that uses it.
Update servers to revision 4 before encouraging installation of template
revision 2. This server update also recovers the released header-11 shortcut
without reinstalling it. Sign the public template locally with
`npm run build:reading-shortcut -- --pairing`, prepare its release using the
existing release workflow, and let Pages serve the signed published asset.
Retain the versioned download path used by installed servers.

Run the native source tests, real-server shortcut tests, Chromium/WebKit tests,
and the relevant protocol, handoff, and rate-limit suites. The browser suite
covers diagnostic redaction/copy, malformed replies, expired saves, a reused
page, a lost committed response, exact retry, reload, and the static fallback.
Complete the physical installation, pairing, web-sheet save, and failure checks
in [Reading testing](read-it-later-testing.md) before publishing. Building and
signing locally do not publish a shortcut or update a user's Worker.
