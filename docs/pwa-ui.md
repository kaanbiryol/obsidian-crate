# PWA UI

PWA-only presentation: updates, launch, sizing and settings. Shared tokens, components and visual rules are in [UI styling](ui-styling.md).

## App update notice

`PwaUpdateProvider` in the shared feature shell owns version detection,
preparation, and update activation for both features. It checks on launch,
foreground/pageshow and reconnect while visible and online, never on a timer.
`PwaUpdateButton` shows a compact **Update** pill in the Reminders and Reading
headers, to the left of sync and Settings. Selecting **Update** immediately starts
applying the update without a confirmation sheet. Offline or pending work disables
the action; update failures appear as toast feedback. `PwaUpdateNotice` provides the
same action at the top of Settings. There is no floating update banner.
At launch, a found update downloads and applies behind the Reminders launch splash
(released after a 30s stall, on failure, offline or backgrounding, and at once when
saved work needs review or a restored editor or capture form is open);
after launch, applying an update requires an explicit action. Feature readiness
and durable pending commands are checked before reload.

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
