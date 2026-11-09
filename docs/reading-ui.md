# Reading UI

Reading workspace layout, article rendering and Reading-specific checks. Shared tokens, components and visual rules are in [UI styling](ui-styling.md).

## Reading workspace

`src/reading/ui/ReadingLibrary.tsx`, `Reader.tsx`, `ReadingDialog.tsx`, and
`SaveLinkForm.tsx` are shared by the Reading PWA and the Obsidian view. The Sass
under `src/reading/ui/styles/` uses the same semantic Crate tokens as reminders.
Both features use `src/ui/shared/ViewHeader.tsx`, `NavigationBar.tsx`,
`IconButton.tsx`, `Button.tsx`, and `ModalHeader.tsx`. Reminder destinations remain
in the reminder adapter; Reading supplies its own destinations to the same
navigation component. Mobile capture uses the same floating action button.
Headers, icon sizes, selection, focus, and action variants belong to these shared
controls. Reading dialogs use a host adapter: the PWA reuses Reminders’
`PwaModalSheet`, `ModalHeader`, sheet transitions, scroll lock, and settings styles.
All PWA icons use `PwaThemeIcon`. Both PWA headers use the same sync indicator and status toast, driven by
each feature's own pending work and refresh state. The indicator sits immediately
left of Settings in the header actions, with a 44px touch target. Project details
retain it on the right without a Settings button. Loading headers reserve the same position. Reading shows confirmed sync only after refreshing the
current session online; cached, offline, and unconfirmed changes stay distinct.
Reading applies saved local edits immediately and uses the header indicator for
background sync. There is no pending-change banner in its library or reader;
failed changes, refresh, and export are available under **Settings → Sync**.
Keep article typography and library layout in Reading rather than
overriding every button or dialog there. Native text fields retain browser editing
and selection behavior; composite search fields draw one focus cue around the
whole control.
Base UI provides buttons, toggles, dialogs, and drawers. Obsidian supplies the
icon renderer in the plugin; the PWA loads article-only icons with Reading. Input
modality belongs to the PWA feature shell so keyboard focus works before either
feature has been opened. Each feature retains its existing persistence and modal
lifecycle adapter.
Reading uses a single-screen library with bottom navigation at every width in
both hosts. Opening an article replaces the library; filters remain in the picker.
Reading dialogs use sheets rather than a separate desktop presentation.
Obsidian keeps separate library and reader scroll containers. The PWA reader uses
document scrolling while preserving the covered library’s filters and list position.
Browser history remains in the PWA adapter.

Article HTML still passes through the existing sanitizer. Source badges begin as
letter marks and load HTTPS favicons when available; an unavailable or offline icon
leaves the letter in place. Each host uses its own browser image cache. Appearance,
tags, and capture use the existing Base UI modal primitive with portals in the
current host document. Sync controls live under **Settings → Sync**; browser storage controls live under **Settings → Device storage**.
The shared `src/ui/shared/styles/_base-modal.scss` mixin provides dialog geometry
in both hosts. Reading and reminder sheets share the PWA modal header layout.
Phone sheets follow the visual viewport while an input is focused,
including focus inside the plugin's Shadow DOM.
The capture form preserves its draft on dismissal; only successful capture clears
it. The PWA retains the existing durable capture and metadata outbox.

The PWA uses `src/pwa/components/PwaDock.tsx` for its floating bottom navigation.
Both sections share four configurable tabs, defaulting to Inbox, Reminders,
Projects, and Reading. The last slot has small up/down chevrons. Holding it for
420 ms or sliding upward expands the pill to show only destinations absent from
the visible bottom bar, including reminder screens removed in Settings. The
picker replaces only the fourth, last slot with the chosen destination and saves
that order. The first three tabs keep their configured destinations, including
Reading when it sits there. The displaced fourth destination returns to the menu,
and the new fourth destination is excluded. Today and Upcoming are date views
inside Reminders, so neither appears
as a dock slot or expanded-menu choice. **Open app to** can open **Reminders — Today**
or **Reminders — Upcoming** at launch. The dock contains one Reminders slot. Settings changes and resets immediately update the menu.
The feature shell routes explicit tab requests across feature mounts, while
each feature owns its view, search, and list state. All PWA code, including
encryption and article extraction, loads at startup, so no screen shows a
loading state. The same controls remain
available while reading, so returning to a reminder view takes one tap.
The pill expands with a heavily damped spring, maintaining its height and velocity
when opening is interrupted or reversed. Its corner radius follows the same
progress. The surface is flat, with no edge highlight. The spring also
controls the tab icons' opacity and reveals the choices along the surface's painted
edge, so text stays inside the material and held-finger targets remain stationary.
A short, reversible popup fade handles dismissal without delaying input. Reduced
motion jumps to the final shape and reveals the choices immediately;
increased contrast or reduced transparency uses an opaque surface.
Choosing a destination commits immediately while retaining the closing menu's rows.
Retained feature docks share the surface spring and reveal progress, so a feature
switch continues the current shrink before revealing its icons and selection.
Reopening during dismissal uses the updated choices and reverses the same spring.
The compact dropdown has no visible header or close button. Tapping outside or
pressing Escape dismisses it. A background highlight marks the selected reading
view, and a muted highlight follows the held finger. Release commits the preview;
release outside after sliding cancels. A stationary hold leaves it open for a tap.
Down arrow, Shift+F10, and right-click provide keyboard and pointer access.
Sideways/downward movement aborts a pending hold; cancellation or app interruption
cancels the selection. The add button and page layout stay in place.
Ordinary tab buttons select their view; the sliding highlight follows the active
destination. Both feature docks share the indicator position, so it slides from
the selected slot when switching features, even when returning to a view that
was already selected before the switch. Plugin icon emphasis follows that spring's
painted position; the PWA's icon colors use the indicator's duration and easing.
Selection and keyboard semantics update immediately, while visible emphasis blends
with the highlight and follows interruptions. Reminder tabs,
Reading filters, and Reminders/Reading switches use the same 160 ms ease-out
stationary dissolve. Tab panels and feature layers use reversible CSS opacity
transitions and retain their paint order until the switch settles, so a rapid
reversal continues from the current blend. Feature layers stay mounted after the
fade; only the outgoing tab panels unmount. New screens enter beneath the painted stack. Headers and list
content change together, with no
blank frame or dip in background opacity. The dock stays outside tab transitions.
Outgoing screens are inert, retain their scroll position, and unmount on transition
completion; a timeout only recovers cancelled transitions. Newly mounted reminder
cards use their measured heights during the dissolve instead of offscreen estimates;
retained lists keep their existing layout. Upcoming's date styles belong to its
list rather than the active navigation state. Returning from another
feature lets the feature shell own the dissolve without adding a second tab fade.
Reduced motion switches tabs and features immediately.
Both header gears open the same **Settings** sheet above the feature panels.
The feature shell owns its visibility and preserves the underlying tab, search,
scroll position, and focus. Settings use General, Reminders, and Reading sections,
with separate Sync, Device storage, Encryption, and About sections. Settings actions use full-width
text rows with shared spacing and touch targets. Device storage and version diagnostics stay visible alongside sync status.
Reading has no general export action in Settings; unsynced reminder exports
appear only when needed. Web app and server versions show directly without
a separate build-comparison message. **Reset tabs**
appears only when the dock differs from its defaults. Theme and opening-screen
preferences apply across both features; explicit launch links take precedence.
Feature runtimes publish status and actions through the settings store, while
retaining ownership of their persistence, recovery, and session cleanup. Opening
settings loads the other feature as needed without navigating to it. Inactive
features do not open restored editors or apply automatic updates.
The shared logout confirmation explains cleanup for both features and exposes
unsynced reminder exports and recovery before clearing private device data.
**Set up iPhone shortcut** opens in its own full-height Settings-style sheet.
Its circular close control, downward swipe, Escape, and browser Back return to
the retained Settings screen and scroll position. The nested sheet keeps the
app canvas at the parent sheet's depth and shares the existing reduced-motion
and keyboard behavior. Browser Forward can reopen setup. As a modal sheet it
blocks the native left-edge Back swipe.
The separate circular add action uses the existing editor/capture flow, including
on Projects. Insets reserve the home indicator once. Loading shells use matching
dock geometry.
The dock overlaps the full-height list viewport. In Obsidian, its pill and add
button use a flat, opaque theme surface with a hairline border, bright icons and a
quiet selection fill, with no blur, rim or shadow, so community themes keep control
of the palette. A shared backdrop layer fades rows into the host background from
the pill's top edge through the bottom safe area, so rows recede instead of
remaining readable around the controls.
The PWA uses one flat material for all floating chrome: the dock pill, add
button, back button, header actions, article reader controls, sheet header
buttons, the **Today / Upcoming** track, and toasts.
`src/pwa/styles/_glass.scss` defines it; the theme files set its `--pwa-glass-*`
fill, hover fill, border, and shadow (none). Surfaces are opaque with a hairline
border and no blur, sheen, or rim. Toasts override the fill, border and shadow
with `--pwa-toast-*` so they read above content. The PWA backdrop layer starts below the
pill's top edge and stays partly transparent, so rows soften beneath the pill.
Content above the pill remains clear.
The layer spans the PWA viewport or Obsidian pane, even when the pill reaches its
maximum width. Reduced transparency and increased contrast remove this layer;
increased contrast also strengthens the chrome border. Scroll containers reserve dock height plus a small gap at
the end, keeping the final item reachable above the controls. Space around the pill and add button
passes gestures through to the list; the expanded picker still blocks the backdrop.
The Reading panel accepts a host navigation renderer; the Obsidian panel keeps
its shared navigation. Obsidian wide layouts retain their sidebar; PWA connection
screens retain the header switch for enrollment.
The feature shell preserves mounted state and browser locations and restores focus to
its visible navigation control. The modes dissolve the outgoing panel over an opaque incoming panel over 160 ms;
scrolling content, headers, and docks keep their geometry throughout the dissolve. Opening a PWA Reading
article slides the reader over the stationary library and bottom bar. Both stay
painted beneath the full-height article, with background controls inert. Toolbar
Back slides the article out once, then traverses history after the exit ends.
Native history closes commit the library immediately and let it paint before
replacing the forward entry, so WebKit cannot record the outgoing reader as the
library snapshot. Loading and loaded content share one reader component. On phone slides, article downloads start immediately, while Markdown parsing, syntax highlighting, and body layout wait for the pane’s transform transition to settle. Reduced-motion and non-sliding opens render without that wait. Detail history slots are
scoped to the running document; reloads create a fresh library predecessor so Back
cannot restore an older page instance. Reduced-motion users switch sections
immediately while spatial animations are disabled. Dismissing an article clears its forward-history
destination, so a right-edge swipe cannot reopen a dismissed article.
Projects and Reading share `src/pwa/navigation/detail-history.ts`. Every reopen revisits the
known same-document predecessor while leaving the current list rendered, then
pushes a fresh detail entry before mounting it. Replacing a closed detail entry
alone retains old native-preview pixels, even when the destination tab matches:
its theme, data, filters, scroll position, or dock may have changed. Refresh the
whole predecessor instead of maintaining per-setting invalidation rules. The
internal traversal is consumed by the coordinator; normal Back still closes once,
and repeated visits replace the forward slot without growing history. Feature
switches cancel pending opens. Physical iPhone edge swipes still require device
verification; browser tests inspect the rendered predecessor at each push.
`FeatureShell.tsx` preserves mounted feature state
and navigation, keeps the inactive panel inert, and restores keyboard focus to the
destination's visible navigation control after its initial loading completes.
Both PWA modes and shared plugin views use a small, muted spinner while their
first usable data is loading. Its 12-spoke graphic and stepped rotation match
pull-to-refresh. Keep it horizontally centered at the top of the content, with
16px of padding below the screen's header controls rather than vertically centering
it in a tall loading container. After a 250 ms delay to avoid quick flashes, it
fades in using the shared fast duration. Reduced motion skips the fade and keeps
the spinner still. Reading uses it when the library has no cached
data; Reminders uses it while a cached empty list is being checked. Neither
shows a zero count until that empty result is confirmed, and background refreshes
keep existing items visible.
Phone screen headers use a 24px title at its natural line height and a compact
20px count row separated by 2px. The top gap is 4px beyond the status-bar safe area; bottom padding is 8px.
Loaded and opening headers share these PWA spacing tokens so hydration does not
move the title or content. Sync and settings retain 44px touch targets.
On identified iOS/iPadOS 27 Home Screen apps, the head bootstrap enables the
iOS 27 progressive-blur workaround while keeping `black-translucent` status-bar
mode. It accepts a real OS 27 token or Safari 27 on an Apple mobile device
(including desktop-mode iPads); ambiguous frozen user agents skip it.
Other versions and ordinary browser layouts retain their existing styling.
iOS 27 Home Screen apps start below the status bar whatever the status-bar
style, and blur content scrolling under it. iOS paints the status bar in the
color of a real fixed element at the top, so a 12px `#pwa-status-bar` strip
sets it to the theme color. iOS ignores pseudo-elements for this, and the
element must stay at least 6px tall and 80% wide. The strip stays above sheets,
which tint it to match their backdrop as they move. Content reserves at least
the strip's height at the top. The document and app use
`min(100vh, 100dvh + top inset)`, because `100vh` still spans the whole screen
when the app starts below the status bar.
Headers stay opaque and sticky in the same theme color. Check launch/resume,
rotation, light/dark themes, scrolling, and sheets on an installed iOS 27
device: desktop WebKit can verify layout and platform gating but cannot
reproduce native blur or status-bar tinting.
`tests/browser/pwa/pwa-safe-area-test.mjs` covers the inset and viewport geometry;
`tests/browser/pwa/pwa-ios27-header-test.mjs` covers Reading headers, dock menus, sheets,
theme changes, rotation, and reload against the built local Worker.
The dock reserves the current device-reported bottom safe area once, with a 10px
minimum visual gap (not an additional 10px). Use `safe-area-inset-bottom`, not
`safe-area-max-inset-bottom`: the static maximum can exceed the clearance needed
inside the current viewport. Do not impose a fixed 34px inset on phone layouts: devices
with smaller safe areas must be able to place the dock lower. The menu and dock
share this bottom offset; the bar's internal padding does not add exterior space.
The same switch is available on both connection screens. Top-level modes suppress
single-finger back gestures starting within 20px of the left edge; an open Reading
article retains native back navigation to its library. Other touch starts and
multitouch gestures are left to the browser.

Run the Reading visual specs in Chromium and WebKit for both hosts, light/dark
surfaces, mobile and desktop widths, safe rendering, article actions, capture,
and appearance controls. `tests/browser/reading/reading-browser-test.mjs` exercises the built
PWA against real local storage and Worker bindings, including offline reading and
replay of a save whose response was lost. iPhone keyboard, native sharing, and
installed-app safe areas still require physical-device acceptance.

`tests/browser/pwa/pwa-dock-test.mjs` exercises the built Worker in Chromium and WebKit:
section switching, retained tabs/search, directional slides, reduced motion,
minimum touch targets, stationary dock geometry, focus return, capture/settings
sheets, and light/dark phone and landscape layouts. Drag-to-select coverage checks
live highlighting, release outside, and interruption in both engines, plus native
Chromium touch selection and pointer cancellation. Physical iPhone safe areas, VoiceOver, and Home Screen behavior remain
device acceptance checks.

In Reading, releasing a text selection saves a highlight automatically and opens
an inline action menu with **Copy**, **Share**, and **Delete highlight**. Copy and
Share use the passage text and remain available while a highlight save is pending.
Share opens the device share sheet where supported, otherwise it copies the text
with feedback. Cancellation is quiet; failed actions show an error without
claiming success. Tapping a saved highlight reopens its menu and resize handles.
The menu stays within the reader viewport and clear of the passage and handles.
Dragging a handle previews the range without moving the article; release saves
the resized range. Handles auto-scroll near the reader edges and support Left/Right
keys. Escape or pointer cancellation abandons an in-progress drag. Outside taps
and ordinary scrolling dismiss the menu and handles without removing the highlight;
handle auto-scroll keeps the controls attached. Late save/share completions never
reopen dismissed controls.
The PWA persists changes before confirming them, coalesces undispatched highlight
edits offline, and keeps dispatched updates immutable until confirmed or reviewed.
A failed save retains the selected range with an error and retry action. Highlights
remain note metadata shared by both reader hosts; changed article text is never
marked unless it still matches the saved text at the saved offsets.

### Article code examples

The shared reader enables `highlightReadingCode` for both the plugin and PWA.
Syntax grammars load with the PWA’s startup bundle and are bundled into
the plugin. Code
uses language labels where available and bounded detection for short unlabelled
blocks. Unsupported languages and oversized examples remain plain text. Highlighted
markup is sanitized and accepted only if it preserves the exact original text,
so copying and annotation offsets remain stable. Colors use `--reading-code-*`
palette tokens in both PWA themes, with Obsidian’s `--code-*` theme tokens as
the plugin fallback.

`reading-content.ts` returns a sanitized DOM fragment. `ReadingBody` inserts a
clone directly, without serializing it into HTML for a second parse. Equivalent
fragments retain existing paragraphs so highlight edits preserve scroll anchors.
Keep this boundary for both Obsidian's Shadow DOM and the PWA; browser CSP is an
additional defense, not a replacement for sanitizing article content.

Supported article code languages and formats: JavaScript (including JSX),
TypeScript (including TSX), Python, Bash, shell sessions, Swift, Java, Kotlin,
C, C++, C#, Objective-C, Go, Rust, Ruby, PHP, Dart, R, MATLAB, Julia, Lua,
Perl, Scala, PowerShell, HTML/XML, CSS, SCSS, SQL, GraphQL, JSON, YAML,
INI/TOML, Dockerfile, Markdown, and diff. Language aliases such as `c#`,
`c++`, `jsx`, `tsx`, and `toml` work in fenced code labels. Explicit language
support is broader than automatic detection; the latter remains limited to
JavaScript, Python, Bash, JSON, CSS, HTML/XML, SQL, and Swift.

The PWA article reader keeps its actions visible in their existing positions.
Back uses a circular surface, archive/favorite share a capsule, and the secondary
actions use individual rounded surfaces beside the offline status. Article and
Highlights use a rounded segmented control. These PWA-only styles use the dock's
flat material and retain 44px targets. The iOS 27 opaque header
workaround remains in place.

The PWA article opens directly into its text without Article / Highlights tabs.
Its title, byline, reading time, and text appear together once the text is available
and the opening slide has finished. Navigation stays available with a loading
indicator meanwhile; cached text adds no delay beyond the slide. Opening an article with
an offline copy asks the server only whether that revision is current (an `ETag` check, or
the file revision in an encrypted vault, from an inventory confirmed in the last 30
seconds) and downloads the text only when it changed. Only articles saved with **Save for
offline** have a copy: an opened article stays in memory, nothing downloads in the
background, and a save past 200 articles or 50 MB is refused instead of removing another
copy. Copies earlier versions stored automatically are removed. A load failure
shows the article metadata and original source alongside the error and retry action.
A floating highlighter/count button opens the article highlights in a full-height
PWA sheet using the same sizing as Settings. Its zero-height sticky layer overlays the full reading viewport; it
does not reserve a bottom bar or shorten the article. Once the phone reader's
opening slide settles, the navigation and this layer become fixed and the settled
pane drops its transform, so iOS rubber-banding moves only the article. The reader
reserves the navigation's measured height above the article. The button and navigation
bar share the same scroll-direction threshold: down hides them, up or keyboard
focus reveals them. At the fully shown/hidden endpoints, a 12px direction threshold
filters jitter. Once moving, reversals respond immediately. Navigation travels one
pixel per scroll pixel over its height plus the top safe-area inset; the floating
button shares that progress. Scroll updates drive transforms and opacity directly,
without restarting CSS easing on every frame. Reduced motion uses an immediate
visibility change without translation. Closing the sheet
restores the passage position; selecting **View in article** closes the sheet
before smoothly scrolling to and focusing the highlight; reduced motion uses an
instant scroll. Obsidian retains its reader tabs.

Reading sheets portal into a dedicated, themed viewport layer directly under the
body, outside the frozen article and feature-panel compositing layers. The body
stays at the viewport origin; only the app canvas is offset to preserve the
article beneath the sheet. Opening
a sheet deep in a document-scrolling article must keep its header and close
control in the viewport. Closing or swiping the sheet down restores the same
article URL and scroll offset; the viewport portal is removed on dismissal.

PWA screen headers share the article reader's rounded chrome: sync and Settings
sit in a capsule to the right of the title and count. Inbox, Reminders, Projects,
and all Reading library views use the same 24px heading. Project details use the
same action surface and the article reader’s shared icon-only `BackButton`. Their
navigation rows share 64px geometry and a 28px gap before the heading content.
`src/pwa/styles/_header-chrome.scss`
is loaded by the shared foundation so cached launch screens match live screens.
Each feature retains its actions and navigation; Obsidian headers remain unchanged.
Controls keep their 44px targets and opaque accessibility fallbacks.

The article tags editor uses a shared wrapping chip field in both hosts. Space or
Enter commits a tag, Backspace in an empty input returns the last chip to text,
and each chip has a remove action. The header provides **Save** and a close control;
there are no footer actions. Saving includes unfinished input and removes
duplicate tags. Chip colors match the rich-text editor's accent treatment; the
compound field owns its focus outline and retains 44px touch targets.

All PWA sheet header buttons use the flat chrome surface through
`_rounded-sheet-control.scss`, applied in `_sheet-headers.scss` to close/back
controls, destructive actions, and secondary icon actions. Plain text actions
and the tonal submit circle keep their own treatment. Save and destructive actions
retain their semantic text colors; features must not opt in by action name or
duplicate the surface styling.

Disabled server Reading keeps the library header, search, sidebar, and tab bar.
Show setup guidance inline in the list area with the shared empty-state styles,
without an error alert. Keep navigation mounted while **Check again** is pending.

## Testing notes

Choosing and running suites is covered in [testing](testing.md).

### Pasted links and page titles

Run `npm run test:page-titles` for the production build, lookup/transport unit tests,
authenticated Worker-runtime tests, and Chromium/WebKit editor tests. The browser
cases run the shared editor in both PWA and plugin hosts; plugin title/description
fixtures use Shadow DOM. The browser suite is also included in `test:visual` and
`test:lexical`, while unit and Worker cases join their normal test commands.

Coverage includes automatic lookup without preferences or browser storage; title and description
pastes; selected labels; Unicode/entity/Markdown handling; caret and focus retention;
undo/redo; concurrent and out-of-order responses; external loads, remounts, read-only
state, and composition while a request is pending. Failure cases cover
network errors, unsupported servers, malformed responses, empty titles, and deadlines.
Worker tests cover authentication, expired/revoked sessions, rate limits, public URL
validation on every redirect, request/body size bounds, stream cancellation, and
ignoring title-like text in scripts, comments, attributes, and other raw-text elements.
Outbound page responses are controlled fixtures; these tests do not contact websites
or establish physical-device, installed-PWA, or hosted-network acceptance.

Playwright starts a private static gallery for each visual run. It snapshots the
built plugin stylesheet before bundling the gallery, chooses an available loopback
port, and never reuses the live preview. Rebuilding or removing `dist/` after that
snapshot cannot reload or break active fixtures. Build the plugin before starting
tests; a missing stylesheet fails with an actionable error. Source changes made
after the snapshot require a new run.

A run writes its gallery snapshot to `.generated/visual-runs/<run-id>/`, results to
`test-results/visual-<run-id>/` and the HTML report to
`playwright-report/visual-<run-id>/`. The launcher deletes that run's directories when
a local run passes. Failed runs keep them for diagnosis, and CI keeps them for artifact
upload. `npm run clean` removes accumulated output (`dist/`, `.generated/visual-runs/`,
`playwright-report/` and `test-results/`), refusing any path Git tracks.
`npm run preview:ui` remains the live editing server on port 8790.
`npm run test:ci` checks that concurrent gallery snapshots retain their own styles
even after the input stylesheet changes or disappears.

### Reading touch feedback

Run `node tests/browser/pwa/pwa-project-transition-test.mjs` for project navigation and
card feedback in Chromium/WebKit. It checks resting card styles at the history
push after held presses and native taps, including grouped and nested projects
in both themes. Verify the browser-owned swipe-back preview on an installed
iPhone separately.

Run `node tests/browser/reading/reading-touch-test.mjs` for Chromium/WebKit checks of article
open/Back cycles in both themes, retained hover, and keyboard focus restoration.
Chromium also exercises native touch cancellation and scrolling, plus a forced
stale `:active` state. The test uses the built PWA with synthetic Reading APIs
and is included in `npm run test:pwa-browser`. Installed iPhone behavior still
requires device verification.

Run `node tests/browser/plugin/shared-press-feedback-test.mjs` for the shared controls’ press
contract in Chromium and WebKit, in both document and Shadow DOM hosts. It covers
release outside an inert control, cancellation, movement into scrolling, window
blur, keyboard activation, disabled controls, persistent toggle selection, and
native input editing. It is included in `npm run test:pwa-browser`.
