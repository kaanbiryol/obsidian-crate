# Shared plugin and PWA UI

The plugin and PWA compile the same reminder components and Sass. Keep changes to
card structure, editor fields, controls, typography, badges, and states in the shared files so they reach
both hosts together.

## Ownership

- `src/ui/shared/styles/_tokens.scss` defines the semantic Crate tokens for
  surfaces, controls, typography, radii, selection, and motion. Both hosts include
  this mixin on `.crate-reminders-ui`.
- Obsidian supplies the underlying CSS variables through the active community
  theme. `src/styles/plugin-ui/_theme.scss` adds the plugin's scoped control
  styles and modal/reduced-motion integration.
- The PWA supplies the same host-variable vocabulary: its palette lives in
  `src/cloudflare/worker/pwa/styles/palette.css` and `theme-light.css`,
  while `theme.css` defines standalone typography and geometry. Legacy shell
  names (`--text`, `--bg`, `--accent`, etc.) alias this palette; do not give them
  separate colors in feature styles. Existing names
  such as `--background-primary` and `--font-ui-medium` are compatibility inputs;
  using them does not import the Obsidian runtime into the browser.
- `src/pwa/components/PwaThemeProvider.tsx`, mounted once by `FeatureShell`, owns
  system-theme and cross-tab subscriptions, theme preferences, document colors,
  the light stylesheet, and browser theme-color metadata. `usePwaColorScheme`
  only reads that shared context. Keep the early launch theme in the HTML shell
  and the parsing/persistence helpers in `src/pwa/theme.ts` so first paint stays
  correct before React loads.
- `src/ui/shared/styles/_list-item.scss` owns the surface, interaction states,
  primary spacing, and title typography shared by reminder and Reading items.
  Reading uses the same cards on desktop and phones, retaining its source icon,
  favorite action, and one stacked library/reader flow at every width in both hosts.
  Reading uses bottom navigation, floating Highlights, and sheets; do not introduce
  desktop sidebars, split panes, or centered dialogs. Desktop support is separate
  future work. Covered library cards keep their resting surface on return. Shared Sass mixins preserve each
  feature's existing DOM and interaction semantics. Flat surfaces and inset
  dividers are reusable mixins here; reminders opt into them through
  `_reminder-cards.scss`. Reading retains its card presentation.
  Existing reminder surface tokens remain host-theme inputs.
- `src/reminders/ui/shared/styles/_reminder-cards.scss` owns reminder cards,
  checkboxes, metadata badges, and their states. `_primary-screen.scss` owns
  list-screen density and hierarchy. The plugin's `_card-presentation.scss`
  only handles embedded-list spacing and keyboard focus.
  **Reminders → Reminder list style** selects **Flat** (the default) or **Cards**
  locally in each host. The plugin setting applies immediately to open views,
  project lists, and embedded notes; the PWA stores its own preference and updates
  open tabs. Flat rows retain completion targets, priority, keyboard focus,
  press/drag feedback, and theme colors while removing card surfaces and metadata
  pill outlines. Their dividers align with the reminder title.
- Reading search and PWA Save a link fields opt into `crate-field--rounded`: 16px
  corners, 48px minimum height, and 16px horizontal padding. Their filled
  surfaces, borders, and focus rings retain shared theme colors. Reminder
  editor fields retain their existing geometry. Plugin Save a link uses the standard
  shared text field and reminder header Save action, with no footer actions.
- `src/ui/shared/` owns buttons, icon buttons, text fields, and headers.
  `usePressFeedback` owns momentary interaction state for buttons, reminder cards,
  and native picker rows. Style it with `data-press-active`; never use CSS
  `:active` or Base UI's persistent toggle `data-pressed` for that feedback.
  Release, cancellation, scrolling, pointer exit, blur, activation, and app
  backgrounding clear the press. Scope hover effects to `(hover: hover) and
  (pointer: fine)`. PWA project cards restore their resting styles immediately
  on touch release so native Back previews cannot capture a release fade.
  Keep actual selection, checked states, keyboard focus, and
  native field editing independent of press feedback. Icons use the
  existing `ThemeIcon` provider; the plugin adapters supply Obsidian icons.
  Compound fields use `focus.within` from `src/ui/shared/styles/_focus.scss`
  for one focus cue around the whole control. Text inputs, textareas and compound
  text fields change their existing border color on focus without an outer ring.
  Buttons, links, tabs and non-text selectors retain visible keyboard-focus rings.
  Settings selectors, number fields, and search boxes share the focus mixin. The PWA enables that outline only after keyboard
  navigation through `--crate-compound-focus-style`; touch and mouse focus stay
  undecorated without blurring controls. Obsidian retains its normal focus cue.
  Reading form actions use `crate-dialog-actions`
  for the plugin confirmation’s shared minimum width, padding, and subtle borders.
  Phone layouts give both actions equal width and 48px minimum height.
  The PWA delete confirmation uses a single-line centered header title, a close
  control to cancel, and a danger-colored **Delete** text action on the right.
  Its body contains only the confirmation message; both header controls disable
  while deletion is pending and retain at least 44px touch targets.
  PWA **Save a link** uses the shared reminder editor header instead: close on
  the left, title centered, and **Save** on the right, disabled until the web link
  is valid. Its header submit action targets the form; there are no footer actions.
  Link capture in both hosts asks only for the URL; article extraction supplies the
  title, with the hostname as the fallback while extraction is pending.
  Headers with `preventFocusOnPress` also preserve field focus and selection on
  title and empty-header taps, using the reminder editor's shared
  `usePreserveFieldFocus` hook. These taps keep the keyboard open; header drags
  and explicit actions retain their normal behavior.
- `src/pwa/styles/foundation.scss` installs the shared tokens, controls, modal
  primitives, and PWA header defaults for every feature. The PWA stylesheet
  entry point loads it independently of the reminder layout stylesheet.
  `_sheet-headers.scss` owns the rounded, tinted 44px close/back controls for
  all PWA sheets, including Settings, Reading dialogs, reminder editors, and
  pickers. Keep this treatment here rather than adding feature-specific overrides.
- `src/ui/shared/styles/_view-header.scss` owns common header presentation.
  `foundation.scss` supplies PWA title/count geometry for both features and their
  loading screens. Feature adapters retain their safe-area ownership.
- `src/pwa/components/SettingsSection.tsx` and `SettingsRow.tsx` own settings
  grouping and row structure. Settings reuses the shared list-item surface and title
  mixins, with semantic filled controls and shared button press feedback for its
  theme selector. Native selects and number fields retain 16px text for iPhone focus.
  Sections generate unique heading associations;
  rows can wrap a native control with a label. Feature settings keep their own
  validation, async actions, and persistence.
  **Default tab** belongs to **Tabs** and retains the saved opening preference.
  **Sync and device** and **About** are always-visible sections. Shortcut setup
  uses these same section surfaces, typography and shared action controls.
- `PwaPushStack` owns retained sheet pages, push/pop motion and focus return.
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
- `src/pwa/components/PwaToast.tsx` renders feedback from `useToast` in either
  feature. Errors use assertive alerts; other feedback uses polite status messages.
  Both features share bottom-center positioning above the dock and safe area.
  Toasts fade in and out over 160ms without moving; reduced motion skips the fade.
  Replacing feedback updates the current toast instead of stacking another one.
  Reading confirms explicit link, tag, and highlight-note saves after local
  persistence; offline confirmations say they are saved on this device. Favorite,
  archive, and passage-highlight changes use their immediate visual state.
  Input validation stays beside the field. Failed local writes also show an error
  toast. Both features announce rejected changes or exhausted automatic retries
  once per operation, when the feature is visible; routine retries and refreshes
  stay quiet. Persistent sync notices and settings retain the recovery details.
- `src/pwa/components/PwaNotice.tsx` owns notice title/body/action layout, with
  styles in `src/pwa/styles/_notice.scss` loaded by the common foundation.
  Recovery features retain their announcements, retry/discard decisions, and
  review-before-removal safeguards. Standard actions use `Button`/`PwaButton`;
  PWA feature code cannot import Base UI Button directly.
- `src/ui/shared/CopyableText.tsx` owns clipboard feedback and the selectable
  readonly fallback. It uses the control's owner window, ignores stale copy
  completions, and runs an optional synchronous feature guard before copying.
  Shortcut setup retains pairing expiry and session validation; diagnostics
  retains its payload. Copy failure never changes or regenerates the value.
- `src/pwa/download.ts` owns the JSON download and Blob URL lifecycle shared by
  Reading and reminder recovery. Each caller retains its filename, payload
  format, and export snapshot. Starting a download does not prove it was saved.
- `ReminderEditorFields` and `ReminderActionChips` are shared editor content.
  Their styles live in `src/reminders/ui/shared/styles/_editor-*.scss`; header
  and control styles live in `src/ui/shared/styles/`. The plugin field adapter
  supplies the theme's project icon mask.
- Each host retains its own sheet, keyboard, navigation, and persistence
  behavior. The PWA editor layout sets browser sheet height, safe areas, and
  touch target sizes. Its focus/keyboard-save hook remains in the PWA adapter.
  Date, project, and repeat picker content and styles are shared too. Host adapters
  keep apply/cancel semantics, keyboard geometry, and date-input commit timing.
- `src/pwa/components/PwaModalSheet.tsx` wraps Base UI Drawer for focus containment,
  dismissal, and downward swipe gestures. `drawer.css` owns its transitions,
  including reduced motion. The PWA retains its document scroll lock and editor
  keyboard geometry; editor fields opt out of swiping to preserve native selection
  and scrolling. Swiping the editor retains its draft, while swiping a picker or
  delete confirmation returns to the editor. Explicit editor close still discards
  the draft. Busy operations and screen transitions block dismissal.
  Forms opt into opening focus with `data-initial-focus`. The shared sheet focuses
  that field without scrolling during mount and applies the same no-scroll focus
  to touch activation of editable fields. Open capture synchronously within its
  initiating tap so iOS can show the keyboard. Outer sheet wrappers use clipped
  overflow; the form's content panel retains native scrolling and selection.
  `scripts/pwa-sheet-field-test.mjs` checks capture focus and simulated keyboard
  geometry in Chromium/WebKit; installed iPhone keyboard behavior needs a device check.

  PWA surface motion lives in `src/pwa/motion.ts` and
  `src/pwa/styles/motion.scss`. Project details and picker entrances use a
  critically damped Motion spring; CSS-owned drawers and Reading navigation
  use a sampled spring curve with a cubic fallback. Direct drawer dragging
  remains unanimated, and CSS transitions resume from the current position.
  All modal sheets and backdrops use the shared 420ms spring curve on entry
  and a coordinated 320ms exit. Sheet swipes shorten that exit to 240–320ms
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
  Stationary tab dissolves and toasts share a 160ms fade. Press feedback uses
  120ms, and control movement uses the shared control spring or 180ms CSS curve.
  The dock selection highlight uses a 300ms spring-like curve so adjacent-tab
  changes retain visible travel instead of spending almost all their time settling.
  Dock expansion uses the surface spring; native dragging remains immediate.
  Shared control tokens inherit these PWA defaults without changing Obsidian.
  Shared navigation indicators use a critically damped spring. Centered Obsidian
  dialogs use a stationary fade; bottom sheets retain their source direction and
  swipe tracking. Completion checkmarks settle without overshooting, and progress
  meters scale their fill without relaying out neighboring content. Checkmark and
  pull-to-refresh animations stop under reduced motion.
  Empty/list replacements dissolve concurrently. Departing content leaves normal
  flow in its current position, keeping the incoming scroller’s parent and geometry
  intact. Incoming reminders accept input immediately; departing content is inert.
  Empty-state copy and icons fade as one unit without a separate icon delay.
  Reading library, filter results, and setup guidance reuse the reminders
  `EmptyState` component and shared `empty-state` Sass. Center these messages in
  the space below the search and filters, clear of navigation; short screens
  scroll from the top so their text and actions remain reachable.
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
  Keep native history gestures immediate and tab changes as stationary outgoing-screen dissolves over opaque incoming screens,
  and reduced-motion paths free of spatial transitions. Reader content stays
  mounted until its exit completes; timeout cleanup is only a recovery path. Phone-sized
  PWA readers use document scrolling so iOS can own the status-bar scroll-to-top
  gesture. The PWA adapter restores the embedded scroll position for the closing
  animation; desktop and plugin readers retain their own scroll container. The
  sticky action header hides on downward scroll and returns on upward scroll or
  keyboard focus. Verify the status-bar gesture in an installed app on an iPhone;
  desktop browser automation cannot establish that OS behavior.

- `src/reminders/components/BaseModal.tsx` uses Base UI Dialog on desktop and
  Drawer for mobile sheets. Portals remain inside the same themed mount and
  owner document, including Obsidian Shadow DOM and popout windows. Nested
  pickers share the parent's dialog tree and restore editor focus. Pending
  saves/deletes reject all dismissal paths. `_modal.scss` owns transitions.
- `BaseUiModal` retains Obsidian's modal shell, history, and selection restoration,
  replacing its keyboard scope so native Escape and focus handling do not race
  Base UI. The React trap yields when Obsidian opens a native menu or another
  modal above it. Activity and Exclusions initialize their imperative content
  inside the mounted portal.
- React buttons use Base UI Button; recurrence and activity tabs use Tabs;
  completion controls use Checkbox; priority/date/day controls use Toggle;
  completed lists and project branches use Collapsible; progress uses Progress.
  The project list composes Toolbar's roving focus with its existing listbox
  semantics and explicit Enter/click selection. The old click bridge and Motion
  sheet gesture/backdrop components are removed. Motion remains for list,
  reorder, and content animations.
- Obsidian Settings, Notice, Menu, and its other native modal screens stay on
  Obsidian's APIs. Plain native select/number/date/time inputs and review
  checkboxes remain browser controls. The rich-text editor's caret-based project
  completion remains editor logic; it is not a plain combobox input.


## App update notice

`PwaUpdateProvider` in the shared feature shell owns version detection,
preparation, and update activation for both features. It checks on launch,
foreground/pageshow, reconnect, and every five minutes while visible and online.
`PwaUpdateButton` shows a compact **Update** pill in the Reminders and Reading
headers, to the left of sync and Settings. Selecting **Update** immediately starts
applying the update without a confirmation sheet. Offline or pending work disables
the action; update failures appear as toast feedback. `PwaUpdateNotice` provides the
same action at the top of Settings. There is no floating update banner.
The existing bounded Reminders launch update stays behind its launch splash;
after launch, applying an update requires an explicit action. Feature readiness
and durable pending commands are checked before reload.

## Making a visual change

PWA **Settings → Tabs** lets people choose exactly four bottom destinations from
Inbox, Reminders, Today, Upcoming, Projects, Reading, Favorites, Archive, and Highlights.
Each row has a replacement picker and a drag handle (also movable with arrow
keys). There are no add or remove actions. Older saved layouts with fewer than four
tabs retain their selections and fill the remaining slots from the defaults.
Preferences persist on the device and update across browser tabs.
**Reset tabs** restores Inbox, Reminders, Projects, and Reading. **Default tab** and
explicit links remain independent of visibility. Pinned Reading destinations open
directly. The last dock slot always opens the Reading view picker on hold or upward
slide, regardless of its destination; a normal tap still opens that slot’s view.
A small, muted up/down chevron pair marks this control, vertically centered beside
the destination icon without shifting it or adding a badge background. The cached
launch shell uses the same order, visibility, and selection before React starts.

Both hosts’ **Reminders** screens contain a compact **Today / Upcoming** segmented
control with a shared frosted track and sliding selection. It uses 13px labels
and a 32px visible track within 44px touch targets.
`ScheduleSwitcher` in `src/ui/shared/navigation/` keeps the controls mounted while the shared reminder panels
change. Their content reuses the shared `TabTransition` for the same stationary dissolve
as dock navigation, while the heading and segmented control stay mounted.
Upcoming retains its configured range, date groups, and launch links;
Both views select Reminders in the default dock; a pinned Upcoming tab has its own selection. The opening shell reserves the chips' final space
before JavaScript loads. Once the initial reminder snapshot is ready, the counts,
chips, and list reveal together with the shared 160ms fade. The title, actions,
and dock stay painted; reduced motion reveals content immediately, and background
refreshes do not replay the entrance. `scripts/pwa-schedule-test.mjs` checks cold
and cached launches with overdue reminders, coordinated reveal, selection,
keyboard focus, launch geometry, rapid reversals, stable card geometry and scroll,
empty states, and light/dark responsive layouts in Chromium and WebKit. The plugin uses the same dock, date switcher and project transition components. `PluginWorkspaceNavigation` retains both features inside one pane, while `PluginRemindersAppShell` manages local project navigation without browser history. Compact project sheets keep their own header and omit the main dock. Plugin pane geometry and Obsidian bottom obstructions live in `src/ui/plugin/plugin-navigation.scss`; dock, schedule and navigation presentation lives in the shared Sass modules. Dock destinations persist through Obsidian device-local storage.

The shared components and semantic tokens are Crate's design system. Extend
them for common controls and states; keep feature layouts and article typography
in their feature styles. PWA-wide behavior belongs in the host layer:

- `src/cloudflare/worker/pwa/styles/interactions.css` owns native control taps,
  selection, callouts, and the reusable `.pwa-screen` gesture policy. Use this
  class on a feature's PWA screen, including its loading state. Screens allow
  horizontal/vertical scrolling while suppressing touch page zoom. Do not put
  the policy on `#app` or the portal mount: sheets retain native editing gestures.
- App chrome is not selectable. Inputs and editable text retain selection and
  callouts; article pages explicitly enable both for reading and copying.
  Reader font-size controls remain available. Browser/OS accessibility zoom is
  outside this touch policy; the viewport has no scaling restriction.
- `button-feedback.scss`, `focus.css`, and `motion.scss` own PWA press feedback,
  input-modality focus, and motion respectively. New features reuse them rather
  than adding a second interaction policy.

Built-app checks in `scripts/reading-browser.test.mjs` and
`scripts/pwa-focus-test.mjs` cover the shared screen policy, native Chromium
pinching, text selection, font sizing, and sheet editing boundaries. Desktop
WebKit checks the CSS policy and editing behavior; installed iPhone gestures
still need physical-device verification.

Modal surfaces inherit the shared theme border, including editors, exclusions,
and mobile sheets. Do not remove it in a screen-specific rule. Standard text
actions use `src/ui/shared/styles/_action.scss` for typography, geometry, transparent
backgrounds, theme-derived borders, and interaction states. Reminder header actions retain their transparent text-button
style in `_modal-header.scss`; icon controls use the shared icon button. Keep semantic
danger/accent treatments and responsive touch targets, but use the shared tokens
instead of introducing a separate palette or button style for each screen.

1. Change the shared component or stylesheet when the rule should apply to both
   hosts. Use existing tokens before adding a new one.
2. For a new token, give both hosts a complete value or fallback. Keep theme
   palette values in host styles. Preserve Obsidian's theme-provided geometry.
3. Keep CSS within `.crate-reminders-ui`. Avoid PWA rules that restyle shared
   cards or hard-code their typography; browser safe-area and viewport rules
   belong in the PWA layout layer.
4. Check reminder lists, projects, completed/overdue/important states, and long
   metadata in light/dark themes at narrow and wide widths. Also check embedded
   plugin cards and keyboard focus when changing card styles.

### Action controls

Plain text inputs use `src/ui/shared/TextField.tsx` and `_fields.scss`. The component
preserves native input props and refs and associates the label, description, and
error with the input. Search uses the same control with a hidden label and optional
icons/actions. Its focus cue surrounds the whole search control; the clear button
keeps its own keyboard focus cue. Use `.crate-text-input` on native textareas such
as copyable diagnostics and pairing codes. The 16px input font avoids iPhone focus
zoom. Keep rich-text caret logic and native settings select/number controls in
their existing adapters.

The `controls` gallery exercises these fields, headers, settings sections, and
toast states alongside buttons in light/dark themes at narrow and wide widths.
`controls.spec.ts` and `controls-webkit.spec.ts` check label/error associations,
selection, keyboard focus, theme aliases, and loaded/loading header geometry.

`Button` is the shared text-action component. Use `variant="outline"` for normal
actions (including empty states, retry, settings, and export), `variant="ghost"`
for lightweight actions, and `variant="primary"` for an emphasized confirmation.
Add `tone="danger"` for destructive actions. Icon-only actions use `IconButton`
with a descriptive label. Leave `Button`'s variant unset only for structural
controls with their own presentation, such as navigation tabs and article rows.

`_action.scss` owns the shared border, typography, corners, and states, using
Sync vault's quiet outlined treatment. `_tokens.scss` maps the action tokens to
host theme values. Actions use Sync vault's input radius and smaller UI text
(4px corners and 12px text in the PWA). Obsidian retains its theme values.
Compact text actions are at least 28px tall, with 8px horizontal padding, including
in narrow desktop panes. Coarse pointers use at least 44px targets. `size="touch"`
retains the larger target at every width. Long labels may wrap. Hover feedback
requires a hover-capable pointer; disabled actions retain their semantic color,
and keyboard focus stays visible. Reduced motion removes action transitions.

`PwaButton` delegates to `Button` and defaults to the outline variant. Settings,
connection, notification, and recovery actions use this adapter; their local
classes may place the control but must not define another font, fill, or border.
Reminder modal-header actions retain their existing shared header treatment.
Reading's typeface previews remain typographic choices rather than text actions.

After building, open `npm run preview:ui` with
`/?scene=controls&host=pwa&theme=dark` for the control gallery. Switch `host` to
`plugin` for the Shadow DOM fixture or `theme` to `light`. It includes outlined,
primary, ghost, danger, disabled, icon, long-label, and host-adapter examples.
`node scripts/visual-test-run.mjs tests/visual/controls*.spec.ts` checks both browser engines,
hosts, themes, and widths, including keyboard activation and Reading's empty-state
capture flow. Screenshots are attached to the report for review, without changing
approved visual baselines.


## Launch appearance

The PWA resolves its saved theme in a nonce-authorized inline script before the
stylesheets are parsed, then applies the light palette before the body appears.
The document, launch screen, update curtain, and app use matching surface colors;
the page backdrop has no gradient that can show through during mounting.
`scripts/pwa-startup-empty-test.mjs` samples launch frames with delayed JavaScript
and data in both engines, including saved themes opposite to the system theme.
The initial HTML includes the selected title, settings icon, bottom dock, and
a small, muted content loading indicator. `src/pwa/opening-screen.ts` and `opening-dock.ts` supply the
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

## Validation and caching

Run `npm run build`, `npm run lint`, `npm run check:css-scope`,
`npm run size-check`, and `npm run test:pwa-preview`. Use `npm run preview:pwa`
for a local preview with disposable reminder fixtures. Test saving, completion,
project navigation, and light/dark switching when changing shared styles.

`scripts/pwa-asset-version.mjs` hashes the compiled PWA Sass in addition to client
assets and Worker PWA sources. Changes to transitive shared imports therefore
invalidate the installed PWA shell cache. Plugin-only styles do not change the
PWA version. `src/pwa/pwa-asset-version.test.ts` protects that boundary.

## Visual regression coverage

`npm run build && npm run preview:ui` serves the isolated gallery on port 8790.
It renders production cards, editor fields, and all three picker contents with
plugin or PWA styles. Query parameters select `host=plugin|pwa`,
`theme=light|dark`, and `scene=cards|editor|date|project|weekly|monthly`.
The plugin fixture supplies deterministic Obsidian-style variables; it does not
replace testing actual community themes or native modal/keyboard integration.

`npm run test:visual` builds a private gallery snapshot on its own port before
comparing 48 screenshots at 390px and 1280px widths and
checks project/repeat keyboard navigation. The canonical snapshot platform is
macOS 26 on Apple silicon, matching the `macos-26` CI runner. Use that platform
when comparing or updating these images: system fonts and native controls can
render differently on Linux or Windows. Chromium comes from the lockfile; CI
also fixes locale, timezone, and clock. Functional Chromium/WebKit release tests
continue to run on Linux. Failures upload screenshots, diffs, and traces. To propose
new baselines, dispatch **Shared UI visual checks** with **Generate candidate
baselines for review**, inspect its artifact, and commit only approved images
from `tests/visual/baselines`. Normal CI never updates baselines automatically.

The stylesheet is approximately 170 KB raw / 24 KB gzip after the shared Base UI
migration. `scripts/bundle-budgets.mjs` records measured baselines and explicit
limits for the plugin, embedded Worker, and PWA startup/deferred assets.

`scripts/base-ui-plugin-test.mjs` checks Dialog/Drawer nesting, keyboard navigation,
focus return, pending mutations, native Obsidian overlay handoff, touch gestures,
and portal content initialization in Chromium and WebKit. The smaller
`scripts/react-shadow-dom-test.mjs` covers editing and single button activation
across mount/unmount cycles.

Knip ignores the `tailwindcss` dependency because its direct import is the Sass
`@use "tailwindcss/theme.css"` in `src/styles/main.scss`, which Knip does not scan.
Keep that dependency while the stylesheet imports its theme.

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
failed changes, refresh, and export are available under **Settings → Sync and device**.
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
current host document. Device/session controls live under **Settings → Sync and device**.
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
as a dock slot or expanded-menu choice. **Default tab** can open **Reminders — Today**
or **Reminders — Upcoming** at launch. Older Today/Upcoming dock slots migrate to
one Reminders slot. Settings changes and resets immediately update the menu.
The feature shell routes explicit tab requests across lazy feature mounts, while
each feature owns its view, search, and list state. The same controls remain
available while reading, so returning to a reminder view takes one tap.
The pill expands with a heavily damped spring, maintaining its height and velocity
when opening is interrupted or reversed. Its corner radius follows the same
progress. The translucent surface has a restrained edge highlight. The spring also
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
with visible Sync and device and About sections. Settings actions use full-width
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
and keyboard behavior. Browser Forward can reopen setup.
The separate circular add action uses the existing editor/capture flow, including
on Projects. Insets reserve the home indicator once. Loading shells use matching
dock geometry.
The dock overlaps the full-height list viewport. Its pill and add button use a
nearly opaque, raised theme surface with a fine highlight, bright icons, and a
quiet selection fill. A shared backdrop layer gently dissolves rows into the host
background from the pill's top edge through the bottom safe area, with only slight
softening. Content above the pill remains clear; rows beneath it recede instead
of remaining readable through the controls.
It spans the PWA viewport or Obsidian pane, even when the pill reaches its maximum
width. Reduced transparency and increased contrast remove this layer and keep
the controls opaque. Scroll containers reserve dock height plus a small gap at
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
Projects and Reading share `src/pwa/detail-history.ts`. Every reopen revisits the
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
Phone screen headers use a 32px title, a 44px title row, and a compact 20px count
row. The top gap is 4px beyond the status-bar safe area; bottom padding is 8px.
Loaded and opening headers share these PWA spacing tokens so hydration does not
move the title or content. Sync and settings retain 44px touch targets.
On identified iOS/iPadOS 27 Home Screen apps, the head bootstrap selects `default`
status-bar mode and enables opaque sticky headers for the iOS 27 progressive-blur
workaround. It accepts a real OS 27 token or Safari 27 on an Apple mobile device
(including desktop-mode iPads); ambiguous frozen user agents keep the old mode.
Other versions and ordinary browser layouts retain their existing styling.
The workaround uses the current top safe-area inset once, without the maximum
inset fallback. The document and app use `min(100vh, 100dvh + top inset)`:
existing installations may retain translucent status-bar mode after the metadata
changes. Both the dynamic viewport and fixed-position containing block can be
shorter than the drawable canvas. Restore only the reported top inset, capped
at `100vh`; default status-bar mode has no top inset and keeps its smaller canvas.
Reading retains its wrapper inset; Reminders retains its header inset. Header
surfaces use the same theme color as startup chrome. Check launch/resume, rotation,
light/dark themes, scrolling, and sheets on an installed iOS 27 device: desktop
WebKit can verify layout and platform gating but cannot reproduce native blur.
`scripts/pwa-safe-area-test.mjs` covers the inset and viewport geometry;
`scripts/pwa-ios27-header-test.mjs` covers Reading headers, dock menus, sheets,
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
and appearance controls. `scripts/reading-browser.test.mjs` exercises the built
PWA against real local storage and Worker bindings, including offline reading and
replay of a save whose response was lost. iPhone keyboard, native sharing, and
installed-app safe areas still require physical-device acceptance.

`scripts/pwa-dock-test.mjs` exercises the built Worker in Chromium and WebKit:
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
Syntax grammars stay in the PWA’s deferred Reading bundle and are bundled into
the plugin. Code
uses language labels where available and bounded detection for short unlabelled
blocks. Unsupported languages and oversized examples remain plain text. Highlighted
markup is sanitized and accepted only if it preserves the exact original text,
so copying and annotation offsets remain stable. Colors use `--reading-code-*`
palette tokens in both PWA themes, with Obsidian’s `--code-*` theme tokens as
the plugin fallback.

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
Highlights use a rounded segmented control. These PWA-only styles reuse the dock
palette, retain 44px targets, and fall back to opaque surfaces without backdrop
filtering or when reduced transparency is requested. The iOS 27 opaque header
workaround remains in place.

The PWA article opens directly into its text without Article / Highlights tabs.
Its title, byline, reading time, and text appear together once the text is available
and the opening slide has finished. Navigation stays available with a loading
indicator meanwhile; cached text adds no delay beyond the slide. A load failure
shows the article metadata and original source alongside the error and retry action.
A floating highlighter/count button opens the article highlights in a full-height
PWA sheet using the same sizing as Settings. Its zero-height sticky layer overlays the full reading viewport; it
does not reserve a bottom bar or shorten the article. The button and navigation
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
and all Reading library views use the same 32px heading. Project details use the
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

All PWA sheet header buttons use the shared rounded surface from
`_sheet-headers.scss`, including close/back controls, text actions, and secondary
icon actions. Save and destructive actions retain their semantic text colors;
features must not opt in by action name or duplicate the surface styling.

Disabled server Reading keeps the library header, search, sidebar, and tab bar.
Show setup guidance inline in the list area with the shared empty-state styles,
without an error alert. Keep navigation mounted while **Check again** is pending.

## Plugin settings disclosure

Plugin settings use three top-level groups: **Sync** for connection status,
sync options, and web app access; **Features** for the matching **Reminders**,
**Reading**, and **Notifications** disclosures; and **Management** for
**Account and devices**, **Server**, and **Troubleshooting**. Feature switches
live inside their disclosures. Collapsed rows summarize folder choices or status.
The web-app row has two visible actions: **Open app** and **Connect another device**.
Connecting another device opens a QR dialog with **Copy link**; if clipboard
access fails, the same dialog reveals a read-only setup link.
Collapsed folder and timing summaries show current choices. Reminder display
preferences disappear when local reminders are off; folder selection stays
available. Notifications remain independent of the local reminders switch.
Reading folder selection stays available while disabled because server folder
changes require Reading to be off.

**Account and devices** and **Server** mount their contents on first expansion;
the notification toggle, schedule, and device controls mount when **Notifications**
opens. The collapsed status and notification toggle check the shared server policy.
Device lists are not fetched for collapsed sections. Management sections avoid
redundant nested accordions. Saved recovery operations surface a review action
at the top; update notices remain visible outside **Server**.

Native details/summary controls support keyboard expansion. Stable section keys
preserve expansion, control focus, and scroll across settings rerenders, even
when summary values change or expanded sections mount lazily.

Plugin disclosure rows use the same 16px content inset as settings cards, a subtle
border, a trailing CSS chevron, and smaller secondary summaries. Section headings
use a 20px/8px spacing rhythm. Expanded controls sit inside the disclosure without
nested card backgrounds. Narrow panes stack fields and multi-button actions below
their labels; buttons retain 44px targets. All colors come from Obsidian theme
variables and native summary keyboard behavior is preserved.
