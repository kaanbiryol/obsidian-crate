# Article fetching on desktop and in the PWA

Checked on 2026-09-28 against the browser documentation and controlled Chromium/
WebKit requests. This is a transport decision, separate from article extraction.

## Findings

A PWA can fetch and **read** cross-origin HTML when the source server allows its
origin through CORS (or allows public, credential-free requests with `*`). A simple
GET may reach the website even without permission, but the browser withholds its
response from JavaScript. This is a browser restriction, not evidence that the
website is unreachable. [MDN: CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS).

`fetch(url, { mode: 'no-cors' })` does not bypass that read restriction: the response
is opaque, with status zero and no readable body. It cannot supply HTML to an
article extractor. Service workers use the same Fetch API; caching an opaque
response does not turn it into readable article text.
[MDN: Fetch modes](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch#making_cross-origin_requests),
[MDN: response types](https://developer.mozilla.org/en-US/docs/Web/API/Response/type).

Installing a PWA supplies no native HTTP client or extension host permissions.
For arbitrary pasted URLs, Crate cannot assume the source has granted CORS access.
Therefore retaining server fetching is the reliable general-purpose PWA design.
This is an architectural conclusion from the restrictions, not a claim that every
website blocks direct access. Browser extensions, native apps, and user-imported
HTML can supply content through different mechanisms. Clipping an already loaded,
authenticated page remains a separate useful capture path.

Obsidian exposes `requestUrl`, an HTTP API without browser CORS restrictions, so
the desktop plugin can download HTML directly. The public API returns status,
headers, bytes and text, but has no abort signal, response stream, manual-redirect
option, or final response URL. [Obsidian: requestUrl](https://docs.obsidian.md/Reference/TypeScript%20API/requestUrl),
[Obsidian API declarations](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts).

## Reproducible browser experiment

Run `node scripts/reading-cors-research.mjs`. It uses two local HTTP origins and
never contacts a public website. Both Chromium and WebKit produced these results
from both a page and its controlling service worker:

| Response configuration | Read result |
| --- | --- |
| Cross-origin GET, no CORS permission | Fetch rejects |
| Cross-origin GET, `Access-Control-Allow-Origin: *` | HTML readable, status 200 |
| Cross-origin GET, `mode: no-cors`, no permission | Opaque, status 0, empty text |

This isolates browser behavior. It does not measure how many public article sites
permit CORS, test installed phone shells, or guarantee access to login-only,
JavaScript-rendered, or bot-protected pages. Server fetching also cannot guarantee
extraction of those pages.

## Crate implementation

- Desktop plugin: save the bookmark first, download with Obsidian's native API,
  extract using the same bundled Defuddle pipeline as the Worker, then fill the
  unchanged empty article block. Existing metadata and personal notes survive.
- Mobile plugin: uses the same native extraction path as desktop. Unencrypted
  PWA saves retain server extraction; encrypted PWA saves attempt direct capture
  and hand pending notes to an unlocked Obsidian device.
- No automatic server fallback for a new desktop capture. An offline/error bookmark
  remains in the vault and can be retried. The resulting Markdown syncs normally.
- Parse only successful HTML responses up to 2 MiB and use the existing 1 MiB note
  bound. Wait at most 15 seconds for the native response; unloading or timing out
  prevents processing/publication of late responses. The native API buffers the
  download before the byte check, and its underlying request cannot be cancelled.
- Validate the requested public HTTP(S) URL and send no vault or Crate credentials.
  Obsidian owns redirect handling. Its API does not expose each redirect target or
  the final URL, so relative article links resolve against the submitted URL;
  redirecting sites can require clipping the final page URL instead.
- Generic article extraction does not fetch images, scripts, embeds, or third-party fallback
  services. YouTube capture additionally uses a bounded allowlist for caption
  requests through the same host transport. It remains independent of reading/favicons and normal vault sync.
