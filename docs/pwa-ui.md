# PWA UI

PWA-only presentation and behavior: updates, launch, sizing, theme, tabs, settings, sheets and keyboard, document scrolling, toasts and the interaction policy. Shared tokens, components and visual rules are in [UI styling](ui-styling.md).

## App update notice

`PwaUpdateProvider` in the shared feature shell owns version detection,
preparation, and update activation for both features. It checks on launch,
foreground/pageshow and reconnect while visible and online, never on a timer.
`PwaUpdateButton` shows a compact **Update** pill in the Reminders and Reading
headers, to the left of sync and Settings. Selecting **Update** immediately starts
applying the update without a confirmation sheet. Offline or pending work dims
the pill, and selecting it then explains why in a toast, since touch devices never
show its title. Update failures also appear as toast feedback. The pill is the only
update action; Settings has none. There is no floating update banner.
At launch, a found update downloads and applies behind the Reminders launch splash
(released after a 30s stall, on failure, offline or backgrounding, and at once when
saved work needs review or a restored editor or capture form is open);
after launch, applying an update requires an explicit action. Feature readiness
and durable pending commands are checked before reload.
An update found after launch is still prepared in the background, and the browser
activates a waiting service worker once every client has closed, so a later cold
launch can start on the new version without these checks. That is safe because the
pending reminder outbox and Reading queue formats are frozen, so the new version still reads them.

## Connection banner

`PwaConnectionBanner` is the one place a feature says it is offline or could not
reach Crate: a single warning row under the header (Reading puts it at the top of
the list). It reads **Offline · updated 8m ago** while the browser is offline, and
**Couldn’t connect · updated 8m ago** when a refresh or the encryption check got no
answer, with **Retry** only in the second case. A server refusal (403, 423 or 429)
shows its own reason instead. It replaces the stale status line, the
**Unable to connect** card and Reading’s library-unavailable notice, so one cause
never produces stacked cards. While it shows, the **Get alerts** prompt is hidden
and the Reminders **+** is dimmed; selecting it explains why in a toast. Reading
still saves links offline into its queue, so its **+** dims only while storage is
locked by an unanswered encryption check. With nothing saved for offline, Reading
shows **Your library isn’t on this device** instead of its first-link empty state.

## Launch appearance

The PWA resolves its saved theme in a nonce-authorized inline script before the
stylesheets are parsed, then applies the light palette before the body appears.
The document, launch screen, update curtain, and app use matching surface colors;
the page backdrop has no gradient that can show through during mounting.
`tests/browser/pwa/pwa-startup-empty-test.mjs` samples launch frames with delayed JavaScript
and data in both engines, including saved themes opposite to the system theme.
The initial HTML includes the selected title, settings icon, bottom dock, and
a small, muted content loading indicator. `src/pwa/shell/opening-screen.ts` and `opening-dock.ts` supply the
same appearance while the app module, session, and update check load. The cached
HTML stays free of account data; nonce-authorized bootstraps resolve the current
URL and saved default tab before app.js. Browser checks delay scripts, session
hydration, and data independently, comparing header, loading indicator, icons, and dock
geometry across each handoff. Loading chrome must never be replaced by an empty
canvas while JavaScript or network requests are pending.
Once the launch destination is known, the real Reminders shell stays mounted
while data loads. Its title, settings icon, and dock keep their DOM nodes and
geometry; only the content loading indicator is replaced. Startup checks assert node
identity and sample header visibility during delayed fetches in both engines.
The service worker precaches the versioned web manifest with the shell: WebKit
holds the load event for it, and iOS keeps its launch screen until then, so a
network-only manifest left slow launches on a blank screen.
Home Screen cold launches and the OS-owned launch snapshot still require a
physical iPhone check.

## PWA sizing

PWA list screens use 24px semibold headings, 16px regular list titles, and
13–14px metadata. Reading source icons are 20px; search fields are 44px tall
and retain 16px input text. Header capsules keep their 44px touch targets with
less exterior padding. Loading headers and search placeholders use the same
geometry as loaded screens. The dock and add button are 56px tall, with 46px
tab targets and 28px side insets (16px below 361px). Its scroll reserve and
expanding menu follow that geometry; bottom safe areas are still applied once.

## Theme

`src/pwa/components/PwaThemeProvider.tsx`, mounted once by `FeatureShell`, owns
system-theme and cross-tab subscriptions, theme preferences, document colors,
the light stylesheet, and browser theme-color metadata. `usePwaColorScheme`
only reads that shared context. Keep the early launch theme in the HTML shell
and the parsing/persistence helpers in `src/pwa/shell/theme.ts` so first paint stays
correct before React loads. The palette files are listed in
[UI styling](ui-styling.md#style-files-and-host-themes).

## Bottom tabs

PWA **Settings → Tabs** lets people choose exactly four bottom destinations from
Inbox, Reminders, Projects, Reading, Favorites, Archive, and Highlights
(`DOCK_TABS` in `src/ui/shared/navigation/dock-destinations.ts`). Today and
Upcoming are views inside Reminders, not destinations.
Each row has a replacement picker and a drag handle (also movable with arrow
keys). There are no add or remove actions. Saved layouts with fewer than four
tabs retain their selections and fill the remaining slots from the defaults.
Preferences persist on the device and update across browser tabs.
**Reset tabs** restores Inbox, Reminders, Projects, and Reading. **Open app to** and
explicit links remain independent of visibility. Pinned Reading destinations open
directly. The last dock slot always opens the Reading view picker on hold or upward
slide, regardless of its destination; a normal tap still opens that slot’s view.
A small, muted up/down chevron pair marks this control, vertically centered beside
the destination icon without shifting it or adding a badge background. The cached
launch shell uses the same order, visibility, and selection before React starts.
Dock behavior and motion are described in [Reading UI](reading-ui.md#reading-workspace).

## Settings

`src/pwa/settings/SettingsSection.tsx` and `SettingsRow.tsx` own settings
grouping and row structure. Settings reuses the shared list-item surface and title
mixins, with semantic filled controls and shared button press feedback for its
theme selector. Native selects and number fields retain 16px text for iPhone focus.
Sections generate unique heading associations;
rows can wrap a native control with a label. Feature settings keep their own
validation, async actions, and persistence.
Primary settings labels use the same 16px regular typography as the main lists,
with readable 14px descriptions. **Open app to** belongs to **Tabs** and retains
the saved opening preference; visible instructions explain replacing and reordering tabs.
**Sync**, **Device storage**, and **About** are always-visible sections. Shortcut setup
uses these same section surfaces, typography and shared action controls. Encryption
uses compact per-feature status rows and one shared setup note; locked and setting-up
guidance stays visible, while unlocked folder and notification details expand in place.
**Web app → Add to home screen** pushes a dedicated instructions page with retained
settings scroll/focus and browser Back/Forward. Installed apps hide this entry.

`PwaPushStack` owns retained sheet pages, push/pop motion and focus return.
Each opaque page includes its fixed header and scrolling body. It slides over
the stationary root with the Projects navigation spring; its resting offscreen
position stays at 100% even for immediate history changes or reduced motion.
This keeps subsequent pushes spatial and avoids fading or swapping the header.
`createPushedScreenHistory` owns their browser history. Keep its controller
mounted in the app shell so Back/Forward cannot reach the feature router below
an open sheet. Capture the root before showing its detail, and finish app Back
motion before traversing history. Native Back renders the root immediately.
All pushed screens declare `data-pwa-back` and a history `pwaBackDestination`;
`usePwaBackGesture` applies one native edge-swipe policy to settings pages,
Reading articles and projects. Root screens and covering modal editors block
that gesture. Do not add feature-specific gesture selectors or a second touch
recognizer on top of native history navigation.

## Sheets and keyboard

`src/pwa/components/PwaModalSheet.tsx` wraps Base UI Drawer for focus containment,
dismissal, and downward swipe gestures. `drawer.scss` owns its transitions,
including reduced motion. The PWA retains its document scroll lock and editor
keyboard geometry. As in UIKit, content scrolled to its top hands a downward
drag to the sheet, including from a focused field; Base UI ignores swipes over
an expanded selection so its handles stay native.
Swiping the editor retains its draft, while swiping a picker or
delete confirmation returns to the editor. Explicit editor close still discards
the draft. Busy operations and screen transitions block dismissal.
Forms opt into opening focus with `data-initial-focus`. The shared sheet focuses
that field without scrolling during mount and applies the same no-scroll focus
to touch activation of editable fields. Open capture synchronously within its
initiating tap so iOS can show the keyboard. Outer sheet wrappers use clipped
overflow; the form's content panel retains native scrolling and selection.
`tests/browser/pwa/pwa-sheet-field-test.mjs` checks capture focus and simulated keyboard
geometry in Chromium/WebKit; installed iPhone keyboard behavior needs a device check.

All modal sheets and backdrops use the shared 420ms spring curve on entry
and a coordinated 320ms exit. On phones (up to 640px) `PwaModalSheet`
presents a `card` or a `page`. A card (reminders, short Reading dialogs,
draft recovery) fits its content and floats 8px from the screen edges and the
keyboard, and above the home indicator when the keyboard is closed
(`--pwa-sheet-card-gap`, with no safe-area padding inside), over a lighter dim (`--pwa-sheet-card-dim`); its surface keeps the full-width layout box
and keyboard padding while `::before` paints the card. A page (settings, the
shortcut setup, full-height Reading dialogs) keeps its full height and spans
the width without a border. Both share `--pwa-sheet-card-radius` (30px) and
shadow tokens; only the card draws the border. A shadow cannot show on the
dark page, so in dark mode a card rises by surface lightness instead: it paints
`--pwa-sheet-card-surface` (lighter than the page) over a 40% dim, with lighter
header controls (`--pwa-sheet-card-control`). Light mode keeps a 20% dim and
the standard sheet surface. Sheet swipes shorten that exit to 240–320ms
using the drawer's release strength and the shared spring curve. A 240ms floor
keeps a fast flick's remaining travel visible instead of compressing it into
the first few frames;
the backdrop and canvas follow the sheet's painted position instead of animating
separately. Gesture progress resets cannot change background depth, including
when a settling sheet is grabbed again. On phones, sheets that opt into
background depth scale and round the underlying feature canvas. Modals portal outside that canvas
so their geometry and direct touch tracking remain independent. The canvas,
sheet and backdrop remain proportional during dragging, interruption, and cancellation.
Reading dialogs over a document-scrolled article retain their viewport portal
and stationary frozen article, preserving scroll position and native Back.
Reduced motion removes the depth effect and sets CSS motion durations to zero.
Initialize unvisited features and picker modules after the entrance completes.
Picker screen handoffs retain their existing focus/keyboard timing; these are
replacements inside one drawer, not additional stacked dialogs.

`_sheet-headers.scss` owns the rounded, tinted 44px close/back controls for
all PWA sheets, including Settings, Reading dialogs, reminder editors, and
pickers. Keep this treatment here rather than adding feature-specific overrides.
The PWA delete confirmation uses a single-line centered header title, a close
control to cancel, and a danger-colored **Delete** text action on the right.
Its body contains only the confirmation message; both header controls disable
while deletion is pending and retain at least 44px touch targets.

`PwaSheetSurface` owns keyboard padding and motion for reminder stages,
Reading dialogs, and Settings. `PwaModalSheet` measures the keyboard by default;
reminder navigation can override the inset while handing off to a picker.
Keep the surface anchored at the viewport bottom and paint behind the keyboard:
compact forms grow by the inset, while full-height forms retain their height
and shrink their scrollable content. Do not lift new dialogs with `bottom` or
subtract the keyboard from both the surface height and its content area.
New and edit reminders use compact content-sized sheets. Their action chips
sit outside the scrolling fields so they remain visible above the keyboard
when long content fills the available height. Reminder sheets keep the app
canvas stationary during dragging and dismissal; only the sheet and dimming
follow the gesture, avoiding horizontal movement from background scaling.
Shared keyboard updates commit height/padding once, then
`useSheetKeyboardMotion` animates the resulting displacement with independent
`translate` keyframes. Do not interpolate the inset used by height and padding:
that lays out the editor on every animation frame. Keyboard closing keeps a
temporary scaled background beneath the moving surface; interruption and
unmount remove it. Picker transitions retain their own transform, and live
reduced-motion preferences skip keyboard movement.
Keep input focus synchronous with the opening tap. During drawer transitions,
dragging, and keyboard displacement, hide only the caret with `caret-color`;
restore it when all movement ends. Do not blur/refocus or reset selection to
work around a caret lagging its transformed surface.

## Document scrolling

Reader content stays mounted until its exit completes; timeout cleanup is only a
recovery path. Phone-sized PWA readers use document scrolling so iOS can own the
status-bar scroll-to-top gesture. The PWA adapter restores the embedded scroll
position for the closing animation; desktop and plugin readers retain their own
scroll container. The sticky action header hides on downward scroll and returns on
upward scroll or keyboard focus. Verify the status-bar gesture in an installed app
on an iPhone; desktop browser automation cannot establish that OS behavior. Sheets
over the document reader hold its offset with `html.pwa-sheet-scroll-held` instead
of fixing the body, because re-layering a long article makes iOS paint it a frame
late, flashing the library and its dock through the article.

On phone-sized iOS layouts, the settled reminders lists, Projects, a pushed
project and the Reading library also scroll the document
(`src/pwa/navigation/document-scroll.ts`, `useDocumentScrollScreens`). Their
ancestors grow to the list, and sibling header, notice and dock chrome is
pinned where it is drawn with inline fixed offsets, so iOS bounces never move
it. Screens covered by a pushed layer are hidden, a fixed cover hides rows under
the header area, and any chrome resize hands the scroll back for a fresh
measurement. Installed iOS apps are taller than the layout viewport the
document scrolls against (see `ios27.scss`), so the handoff fits the screen to
`innerHeight`; otherwise a short list scrolls by the status bar inset and stays
under its header. The handoff waits until no touch, scroll, screen
transition or focused field is active. Tab, feature and project transitions,
sheets and the reader return the offset to the embedded scroller first, so
they animate exactly as in embedded scrolling. Scroll consumers read the active owner
through `scrollPort`. `pwa-document-scroll-test.mjs` checks that both modes
draw identical pixels.

## Toasts and notices

`src/pwa/components/PwaToast.tsx` renders feedback from `useToast` in either
feature. Errors use assertive alerts; other feedback uses polite status messages.
Both features share bottom-center positioning above the dock and safe area.
Toasts use the chrome surface raised by the `--pwa-toast-*` tokens (a lighter dark fill, stronger border and shadow) so they stand out from cards.
Toasts fade in and out with the shared fade without moving; reduced motion skips the fade.
Replacing feedback cross-fades the new toast in place of the current one instead of stacking another.
Reading confirms explicit link, tag, and highlight-note saves after local
persistence; offline confirmations say they are saved on this device. Favorite
and passage-highlight changes use their immediate visual state: an unsent
highlight paints lighter with a dashed underline until its change leaves the
outbox, and only an offline highlight gets a toast. Archive confirms with
**Undo**. A toast action (`Undo`, `Retry`, `Review`) sits inline after the
message and extends the toast to six seconds. The open article's header shows
its own pending changes with the shared sync dot, and falls back to its
availability label once they sync. A failure for the open article replaces the
app-wide notice with one naming the change: **Retry** resends it, and **Review**
opens settings for a rejected change, which is no longer shown as applied.
Input validation stays beside the field. Failed local writes also show an error
toast. Both features announce rejected changes or exhausted automatic retries
once per operation, when the feature is visible; routine retries and refreshes
stay quiet. Persistent sync notices and settings retain the recovery details.

`src/pwa/components/PwaNotice.tsx` owns notice title/body/action layout, with
styles in `src/pwa/styles/_notice.scss` loaded by the common foundation.
Recovery features retain their announcements, retry/discard decisions, and
review-before-removal safeguards. Standard actions use `Button`/`PwaButton`;
PWA feature code cannot import Base UI Button directly. Secondary (`outline`)
actions are compact raised buttons: 28px minimum height with a hairline border and
a slight shadow, growing taller only when a long label wraps. An invisible
pseudo-element keeps a 44px touch target.

`src/pwa/storage/download.ts` owns the JSON download and Blob URL lifecycle shared by
Reading and reminder recovery. Each caller retains its filename, payload
format, and export snapshot. Starting a download does not prove it was saved.

## Interaction policy

PWA-wide behavior belongs in the host layer:

- `src/pwa/styles/host/interactions.scss` owns native control taps,
  selection, callouts, and the reusable `.pwa-screen` gesture policy. Use this
  class on a feature's PWA screen, including its loading state. Screens allow
  horizontal/vertical scrolling while suppressing touch page zoom. Do not put
  the policy on `#app` or the portal mount: sheets retain native editing gestures.
- App chrome is not selectable. Inputs and editable text retain selection and
  callouts; article pages explicitly enable both for reading and copying.
  Reader font-size controls remain available. Browser/OS accessibility zoom is
  outside this touch policy; the viewport has no scaling restriction.
- `button-feedback.scss`, `host/focus.scss`, and `motion.scss` own PWA press feedback,
  input-modality focus, and motion respectively. New features reuse them rather
  than adding a second interaction policy.
- PWA project cards restore their resting styles immediately on touch release so
  native Back previews cannot capture a release fade.

Built-app checks in `tests/browser/reading/reading-browser-test.mjs` and
`tests/browser/pwa/pwa-focus-test.mjs` cover the shared screen policy, native Chromium
pinching, text selection, font sizing, and sheet editing boundaries. Desktop
WebKit checks the CSS policy and editing behavior; installed iPhone gestures
still need physical-device verification.

## Browser setup screen

The browser setup screen uses `_browser-setup.scss` to keep its brand, heading,
and install/browser choices together. Choice rows reuse shared buttons and
theme icons; inline installation steps leave the actions in place. This layout
is scoped to setup so connection recovery screens retain their own geometry.

## Testing notes

Choosing and running suites is covered in [testing](testing.md).

### Unified PWA settings

After building the Worker, run `CRATE_WORKER_PREBUILT=1 node tests/browser/pwa/pwa-settings-test.mjs`
for Chromium and WebKit coverage of both settings entry points, retained view/search
and focus, shared theme and preferences, Reading launch destinations, explicit-link
precedence, shortcut and installation navigation, pending Reading warnings from Reminders, and shared
logout. The test uses the built client, local synthetic APIs, and native browser
storage; screenshots include light/dark, 320px phone, and desktop layouts.
The navigation checks cover Open app to in Tabs, always-visible About, Sync,
and Device storage sections, always-visible storage and version tools, conditional tab
reset, touch targets, retained settings scroll/focus, native Back/Forward, the
header Back action, Escape, and shared edge-gesture eligibility. Motion checks
sample full-page push/pop frames, including the moving header, opaque surface,
stationary parent, fixed header during scrolling, and restored scroll/focus. Desktop engines
can check history and gesture arbitration; the interactive OS swipe preview and
cancellation still need an installed iPhone check. `pushed-screen-history.test.ts`
covers preserving an underlying feature, repeated visits and quick reopening.
Installation checks cover iPhone/Android instructions, narrow light/dark layouts,
Back/Forward, focus/scroll restoration, and hiding the entry after installation.
`EncryptionSettings.test.ts` covers unknown, disconnected, mixed, locked/setting-up,
and unlocked states without hiding problems behind the details disclosure.
Theme checks cover one document update with both features mounted, system-theme
changes, explicit overrides, settings close/reopen, feature switching, and native
cross-tab updates including invalid or removed preferences. Early HTML theme
application before React loads is covered by `tests/browser/pwa/pwa-startup-empty-test.mjs`.
Run the storage-safety, sheet-interaction, and Reading shortcut browser checks for
cleanup failures, touch/keyboard behavior, and real local pairing. Physical iPhone
keyboard, VoiceOver, installed-sheet gestures, and safe areas remain device checks.

Run `node tests/browser/pwa/pwa-sheet-field-test.mjs` for Chromium/WebKit coverage of
**Save a link** focus, keyboard geometry, and caret visibility during opening,
closing, interrupted dragging, and retargeted keyboard movement. It also checks
caret restoration with reduced motion and draft preservation across reopening.
The keyboard viewport is simulated; native caret painting and software-keyboard
behavior still require an installed-app check on an iPhone.

### App updates

`useReminderMutations-lifecycle.test.ts` mounts the production hook and settings
publication with real React. It covers delayed operation identity, overlapping
preparations, rejection, durable handoff and logout/unmount. `ReadingRuntime.test.ts`
mounts the production runtime and session hook, holding its storage lock while
capture, edit and retry commands are prepared. It checks overlapping failures,
durable publication, and logout/unmount. The mutation and failure-toast suites use
the shared real React harness for rerenders and effect cleanup. `apply-update.test.ts`
also starts transient work during asynchronous storage checks before activation
and reload.

Run `node tests/browser/pwa/pwa-update-notice-test.mjs` for Chromium/WebKit checks of global
version detection from a Reading-only launch, foreground checks, navigation,
direct header updates, offline blocking, Settings access, and light/dark mobile layouts.
Screenshots are written to `test-results/update-notice/`.
`node tests/browser/pwa/pwa-update-test.mjs` exercises real service-worker preparation,
activation, failed/slow checks, launch updates, pending writes, and other tabs.
It delays the server clock while preparing a completion command and checks that
updates stay blocked before that command reaches the durable outbox. It also holds
the native Reading mutation lock during an article edit, checks the queue is still
empty and updates are blocked, then releases the edit and completes a real update.
Both are included in `npm run test:pwa-browser`. Installed iPhone safe areas,
app suspension, and VoiceOver announcements still require physical-device checks.
