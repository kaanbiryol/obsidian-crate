# Reading highlights

The article Markdown is the source of truth: highlighted passages use Obsidian's
`==text==` syntax. Crate edits delimiter bytes around mapped Markdown text tokens,
preserving surrounding source, link destinations, formatting, line endings, and
unrelated frontmatter. It verifies both the rendered text and HTML structure before
and after an edit, including link destinations. Complete inline code spans and
autolinks are highlighted outside their original delimiters.
Partial inline code, multiline code spans, spans containing literal `==`, and
fenced or indented code blocks keep their source unchanged. Their highlight
metadata has `codeAnchor: true`, which authorizes highlighting only the matching
code characters. These annotations sync in the note's frontmatter and appear in
Crate's PWA and Obsidian reader and Highlights views. Obsidian's ordinary Markdown
view does not paint metadata-only annotations.

Other selections that cannot safely take markers use `textAnchor: true`. This
includes partial autolinks, escaped table cells, HTML, literal `==`, and selections
inside Obsidian constructs. Their article body stays unchanged. Wikilinks, embeds,
math, footnote references, callout types, and block identifiers are treated as
atomic source text; this does not add vault navigation, equation typesetting, or
embedded-note loading. Ordinary passages elsewhere in the same article still use
native markers. Resizing a highlight recalculates whether native markers are safe.

A selection crossing inline formatting or multiple paragraphs can create several
marker spans. One metadata entry groups those spans into one excerpt. Its stable
ID, creation date, exact text, surrounding context, and optional personal note live
in the article's `highlights` frontmatter. Offsets remain UTF-16 offsets in reader
text, preserving the queued mutation contract. Context helps reattach metadata
after preceding text changes. Ambiguous matches are not guessed.

`highlight_format: markdown-v1` distinguishes this format from legacy frontmatter
overlays. Matching legacy highlights migrate when the note is next saved through
Crate. Unmatched legacy excerpts and annotations whose passage was removed or
changed are retained in `highlight_recovery`, shown under **Highlights** in the
article. Removing inline markers in Obsidian removes the corresponding active
highlight; metadata does not repaint a deleted canonical marker. An unresolved
code or text annotation also goes to recovery, even when it has no personal note.
The reader and mapper share a policy for stripping hidden HTML content. A remaining
rendered-text mismatch (for example, malformed HTML repaired differently by the
browser) still stops the edit instead of attaching a highlight to the wrong text.

Releasing an article selection saves its highlight and opens a menu with **Copy**,
**Share**, and **Delete highlight**. Copy and Share operate on the excerpt text;
Share falls back to copying when native sharing is unavailable. Scrolling, tapping
outside, or Escape dismisses the controls while retaining the highlight. Tapping
a saved highlight reopens the menu and custom resize handles. A pending save does
not disable Copy or Share, and a late completion never reopens a dismissed menu.

The shared reader offers **Article** and **Highlights**, with personal notes and
**View in article** navigation. The library's **Highlights** view collects excerpts
from inbox, favorites, and archived articles; search covers excerpts, annotations,
titles, authors, sources, and tags. Article and tag filters narrow the results.
The list renders at most 100 excerpts until **Show more** is selected. The PWA
Reading menu and Obsidian sidebar expose the same view.

Highlights use the existing durable offline queue and immutable operation receipts.
Requests keep their original before values during coalescing; dispatched requests
retain their identity and exact bytes. Metadata is normalized before queuing so
JSON key order cannot cause false conflicts. Server projections are rebuilt from
Markdown without changing the database schema. Old projections refresh on their
next library read.

The implementation follows Web Clipper's ideas of contextual anchors and grouped
selections, but does not import extension internals or copy its source. Defuddle
continues to own article import. Marked provides Markdown tokenization, and the
already-used htmlparser2 dependency is declared directly for the text/source
mapping pass; no browser extension or full DOM runtime is bundled into the reader.

Verification: `npx vitest run src/reading src/pwa/reading`, the Worker Reading
integration suite, and `node --test scripts/reading-highlights.browser.test.mjs`
after building the Worker. Browser tests use Chromium and WebKit against actual
local vault files, D1/R2 commits, offline replay, touch handles, annotations,
global search, and passage navigation. They also cover automatic highlighting, menu copying,
share payloads and user activation, cancellation/failure feedback, the copy
fallback, scroll/outside dismissal, late share completion, and reopening controls.
Chromium verifies real clipboard contents; platform failure/share cases use browser
stubs. Installed iPhone and native Obsidian
selection/Markdown rendering remain physical/manual acceptance checks.

## Video transcripts

Timestamp paragraphs from Defuddle/Clipper remain ordinary Markdown. The shared
reader adds seek controls and a transient current-passage marker without changing
visible text or its source offsets. Transcript highlights use the same markers,
context anchors, offline queue and recovery behavior as article highlights. A
highlight's video moment is derived from its current passage when opened, rather
than persisting a second timing anchor that older clients could discard.

The player is constructed from a validated video ID outside sanitized article
content. Its bundled message bridge checks the exact frame and origin, cleans up
on navigation, and pauses when the reader is hidden. Selecting Play, tapping a
passage or completing a text selection loads the frame and starts playback at the
selected timestamp. Timed transcripts open with the video pinned above the transcript,
which smoothly follows playback and player seeks. The outlined Pin video / Unpin
video control changes only pinning and following; selecting text plays in either state.
Pointer holds, native selection and the highlight editor suspend automatic scroll
so annotation controls stay stable. Unpinning allows independent scrolling and
keeps the same iframe mounted. Following scrolls only the host's actual reader
scroll owner, accounts for the pinned video's height and respects reduced motion.
The PWA permits only YouTube's privacy
embed origin as a frame source; arbitrary note iframes remain stripped.

The resize handle changes the player's width and height together at 16:9, from
240px (or smaller when the pane or available pinning height requires it) to the
reader's full available width. It expands beyond the centered text column without changing transcript layout or
replacing the iframe. Pointer capture owns the resize gesture; cancellation and
Escape restore the prior size. Double-click resets, arrows resize, and Home/End
select the minimum/maximum. The size is retained while that reader is open and
adapts to pane changes. An oversized player temporarily stops pinning/following
so the handle remains reachable; shrinking it restores the requested pin state.
**Pin video** remains available for oversized players and reduces only their size
as needed to leave space for the transcript. It preserves the mounted player,
playback position, and an already fitting video size.
The preview, playing iframe, and both pin states keep the same layout height;
pinning must never change the geometry used to decide whether it fits.
The pinned background spans the reader pane at every video size, covering and
blocking pointer access to transcript lines that scroll behind the player and controls.

Run `node scripts/reading-video.browser.test.mjs` after building the plugin for
Chromium/WebKit tests in document and Shadow DOM hosts. The player transport is
simulated; actual playback, fullscreen, app backgrounding and installed iOS/Android
selection require manual checks. Transcript fetching has separate bounded-transport
and real Defuddle fixture tests.
