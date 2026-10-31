# Shared plugin and PWA UI

The plugin and PWA compile the same reminder components and Sass. Keep changes to
card structure, editor fields, controls, typography, badges, and states in the shared files so they reach
both hosts together. Host-specific rules live in [PWA UI](pwa-ui.md),
[plugin UI](plugin-ui.md) and [Reading UI](reading-ui.md).

## Shared spacing

`src/ui/shared/styles/_tokens.scss` owns the shared 4, 6, 8, 12, 16, 20, and
24px spacing scale. Use `--crate-space-*` for small layout gaps and semantic
`--crate-list-*`, `--crate-dialog-*`, or `--crate-settings-*` roles for component
density. Both Obsidian and the PWA receive these tokens.

| Role | Default | Consumers |
| --- | --- | --- |
| Row padding | 12px vertically and horizontally | Reminders, projects, Reading articles, highlight article headers and picker options |
| Content / text stack gap | 12px / 4px | Leading icons or accents / title and metadata |
| Row gap | 0px flat, 8px cards | All four list types, including reminder animation and embedded lists |
| Nested row padding / indent | 8px vertically / 16px | Subprojects; highlight groups share the indent |
| Expanded group gap | 8px projects, 16px highlights | Space after expanded groups |
| Section gap | 16px Reading, 24px Upcoming | Space between sections |
| Passage padding | 16px vertically, standard row inset horizontally | Highlight passages and notes |

`_list-item.scss` supplies `primary-spacing`, `nested-spacing`, and
`passage-spacing`. Let content determine row height, retaining at least 44px
for interactive rows and completion/disclosure targets. Flat and Cards change
surfaces and exterior gaps, not basic row padding. Keep nested rows together and
leave a larger gap after expanded groups. Settings and dialogs use the same
scale through their own semantic roles; navigation, safe areas, and editor
geometry remain component-specific.

Reading date headings use 4px bottom padding before the first article row.

`src/ui/shared/styles/_app-density.scss` supplies the same screen scale to the
plugin and PWA: 24px headings, 16px list titles, 13–14px metadata, 44px search
fields and header actions, 20px Reading source icons, and a 56px dock. Rows use
12px vertical padding and completion targets remain 44px. The plugin adapter in
`src/styles/plugin-ui/_app-density.scss` handles pane-width breakpoints; the PWA
uses its viewport. Each host retains its own colors and safe-area ownership.
Dock morphs use the shared collapsed height.

## Shared typography

`_tokens.scss` maps the `--crate-font-*` roles onto Obsidian's font variables,
so community themes control them in the plugin. List screens and Reading
override the sizes through `_app-density.scss`; Obsidian mobile multiplies them
by `--preferred-text-scale`. The PWA defines the list-screen scale once on
`:root` in `src/pwa/styles/host/theme.scss`, and every PWA surface inherits it.

| Role | Obsidian source | List screens and the PWA |
| --- | --- | --- |
| `--crate-font-base` | `--font-ui-medium` | 16px |
| `--crate-font-sm` | `--font-ui-small` | 15px |
| `--crate-font-xs` | `--font-ui-smaller` | 14px |
| `--crate-font-xxs` | `--font-smallest` | 13px |
| `--crate-font-title` | `--font-ui-large` | 24px in the PWA mobile layout |
| `--crate-font-editor-title` | Clamped between base and title | Same |

Weights use `--crate-font-weight-normal`, `-medium`, `-semibold` and `-bold`;
families use `--crate-font-ui` and `--crate-font-text`; line heights use
`--crate-line-height-tight`, `-normal` and `-relaxed`. PWA settings map
`--crate-font-sm` to the 14px detail size.

## Layers, motion and radii

Values that no host or theme changes are Sass constants in `_tokens.scss`. They
compile to literals, so they also work outside the token mixin's scope, such as
the PWA shell in `src/pwa/styles/host/`. Load them with `@use` on the tokens
module.

- Layers: `tokens.$layer-raised` (10), `$layer-menu` (20), `$layer-tab-bar`
  (40), `$layer-floating` (50), `$layer-overlay` (60), `$layer-popover` (100),
  `$layer-sheet` (1000) and `$layer-dialog` (10000). Offset a constant by one to
  sit just above or below it, as the dock backdrop and iOS status bar do.
  Stacking inside one component (-9 to 9) stays inline.
- Motion: durations and curves come from the `--pwa-motion-*` roles in
  `_navigation-motion.scss` and the `--crate-motion-*` roles, which follow
  Obsidian's animation settings. `tokens.$easing-settle` is the settle curve
  shared by the sync indicator and list height changes.
- Radii: the `--crate-radius-*` roles follow the host theme;
  `tokens.$radius-pill` rounds capsules and pills. The PWA shell in
  `src/pwa/styles/host/` uses the host's `--radius-s`, `--radius-m` and
  `--radius-l` directly, because many shell elements sit outside the token
  mixin's scope.

## Style token check

`npm run check:style-tokens` checks `src/**/*.{scss,css}` for declarations that
bypass these roles:

| Rule | Rejects |
| --- | --- |
| `font` | Absolute font sizes (`px`, `pt`, `rem`) and numeric weights, including the `font` shorthand |
| `layer` | `z-index` values of 10 or more |
| `motion` | Non-zero literal durations and `cubic-bezier()` curves in `transition` and `animation` |
| `radius` | Non-zero pixel radii |
| `spacing` | Padding, margin and gap values under 24px that are off the 4, 6, 8, 12, 16 and 20px scale; 1px and 2px nudges pass |

Roles, Sass constants, `var()` fallbacks, keywords and relative units pass.
Custom properties are never checked because they define the roles. Existing
literals are counted per rule and file in `scripts/style-token-baseline.json`,
and a count can only go down: after moving literals onto roles, run
`node scripts/check-style-tokens.mjs --write`.

## Ownership

- `src/ui/shared/styles/_tokens.scss` defines the semantic Crate tokens for
  surfaces, controls, typography, radii, selection, and motion. Both hosts include
  this mixin on `.crate-reminders-ui`.
- Obsidian supplies the underlying CSS variables through the active community
  theme. `src/styles/plugin-ui/_theme.scss` adds the plugin's scoped control
  styles and modal/reduced-motion integration.
- The PWA supplies the same host-variable vocabulary: its palette lives in
  `src/pwa/styles/host/palette.scss` and `theme-light.scss`,
  while `theme.scss` defines standalone typography and geometry. Legacy shell
  names (`--text`, `--bg`, `--accent`, etc.) alias this palette; do not give them
  separate colors in feature styles. Existing names
  such as `--background-primary` and `--font-ui-medium` are compatibility inputs;
  using them does not import the Obsidian runtime into the browser.
- `src/pwa/components/PwaThemeProvider.tsx`, mounted once by `FeatureShell`, owns
  system-theme and cross-tab subscriptions, theme preferences, document colors,
  the light stylesheet, and browser theme-color metadata. `usePwaColorScheme`
  only reads that shared context. Keep the early launch theme in the HTML shell
  and the parsing/persistence helpers in `src/pwa/shell/theme.ts` so first paint stays
  correct before React loads.
- `src/ui/shared/styles/_list-item.scss` owns the surface, interaction states,
  primary spacing, and title typography shared by reminder and Reading items.
  Reading uses the same list presentation on desktop and phones, retaining its source icon
  and one stacked library/reader flow at every width in both hosts.
  Favorite actions are available only inside the article reader.
  Reading uses bottom navigation, floating Highlights, and sheets; do not introduce
  desktop sidebars, split panes, or centered dialogs. Desktop support is separate
  future work. Covered library cards keep their resting surface on return. Shared Sass mixins preserve each
  feature's existing DOM and interaction semantics. Flat surfaces are reusable
  mixins here. Reminders, projects, Reading articles, and Highlights use spacing
  between flat rows without dividers.
  Existing reminder surface tokens remain host-theme inputs.
- `src/reminders/ui/shared/styles/_reminder-cards.scss` owns reminder cards,
  checkboxes, metadata badges, and their states. `_primary-screen.scss` owns
  list-screen density and hierarchy. The plugin's `_card-presentation.scss`
  only handles embedded-list spacing and keyboard focus.
  **Appearance → List style** in Obsidian and **General → List style** in the PWA
  select **Flat** (the default) or **Cards** for reminders, projects, and Reading locally in each
  host. Existing saved choices are retained. The plugin setting applies immediately to open views,
  project lists, embedded notes, and Reading; the PWA stores its own preference and updates
  open tabs. Flat rows retain completion targets, priority, keyboard focus,
  press/drag feedback, and theme colors while removing card surfaces and metadata
  pill outlines. Flat reminder and project rows have no dividers, including expanded
  subproject groups; the main header separator remains. Inbox hides its redundant project
  label while retaining dates and recurrence; mixed-project views keep project labels.
  Reading articles follow the same divider-free flat/card preference. Highlight
  passages always use compact rows separated by inset hairlines, in both styles.
  The Highlights library groups passages by article, ordered by the newest highlight.
  Article disclosure headers use flat rows at rest with rounded hover/press feedback,
  or card surfaces when Cards is selected. The newest group starts expanded; older
  groups expand on selection. A compact article filter opens the shared searchable
  Reading picker sheet with a close header and scrolling options. In Obsidian it
  rises from the pane bottom to a 20px top inset, with rounded upper corners and
  a drag handle; the PWA uses its tall Settings-style presentation. Closing retains
  the sheet through its downward exit motion. Article reader highlights use the same rows.
  Reading dialogs opened inside the Obsidian workspace portal into a pane-local
  overlay outside clipped tab and feature layers. Sheets and their backdrops stay
  inside the pane, above its dock, without covering the rest of Obsidian.
  Project cards and subproject groups share this setting, retaining their colored
  accents, progress, disclosures, and focus/press feedback in either presentation.
  Project counts use smaller, regular-weight text with a dot separator. Flat project
  rows share the reminders’ rounded hover/press fills; expanded parent rows have
  no persistent background. Subproject rows use tighter vertical padding, with
  extra space after an expanded top-level group to distinguish the next project.
  Flat reminder rows share the common row padding and text spacing, with
  slightly smaller metadata icons and slightly larger checkbox
  circles. They retain 44px completion targets and softly rounded hover/press fills;
  row motion reads `--crate-reminder-row-gap` so it preserves the selected style.
  Today shows overdue reminders and those due today in one continuous list,
  ordered by due date without section headings. Flat Upcoming and Completed sections
  hide their decorative separators while preserving group spacing, date headings,
  and the Completed toggle. Header, settings, picker, toolbar, and article-content
  separators retain their existing treatment. Metadata and overdue dates use the host's
  original text and error colors; only hover/press fills add surface blending.
- Shared text fields use one rounded style in both hosts: 16px corners, 48px
  minimum height, and 16px horizontal padding. Their filled surfaces, borders,
  and focus cues retain shared theme colors. Plugin Save a link uses the reminder
  header Save action, with no footer actions. Flat Reading rows use the same 8px
  hover/press corners as reminder rows.
- `src/ui/shared/` owns buttons, icon buttons, text fields, and headers.
  Obsidian modal shells, native modal controls and stylesheet/React mounting
  helpers live in `src/ui/plugin/`. Shared controls remain independent of these
  host APIs; ESLint enforces the import boundary for shared UI and the PWA.
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
  The browser setup screen uses `_browser-setup.scss` to keep its brand, heading,
  and install/browser choices together. Choice rows reuse shared buttons and
  theme icons; inline installation steps leave the actions in place. This layout
  is scoped to setup so connection recovery screens retain their own geometry.
  `_sheet-headers.scss` owns the rounded, tinted 44px close/back controls for
  all PWA sheets, including Settings, Reading dialogs, reminder editors, and
  pickers. Keep this treatment here rather than adding feature-specific overrides.
- `src/ui/shared/styles/_view-header.scss` owns common header presentation. Its
  `primary-screen` mixin supplies shared responsive padding, title rows, and count
  rows to reminder screens and Reading in both hosts. Count text has an explicit
  shared line height. Titles use their natural line height; compact count rows
  fit overdue badges without changing header height and grow with theme text.
  Both hosts use the typography from `_app-density.scss` and a 2px title-to-count
  gap; `foundation.scss` also supplies PWA loading-screen geometry. Both features retain the
  shared header inset on desktop. Plugin and PWA headers reserve the count row
  while loading; PWA loading screens also reserve the floating dock's space
  throughout startup. Feature adapters retain their safe-area ownership.
- `src/pwa/settings/SettingsSection.tsx` and `SettingsRow.tsx` own settings
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
  Toasts use the chrome surface raised by the `--pwa-toast-*` tokens (a lighter dark fill, stronger border and shadow) so they stand out from cards.
  Toasts fade in and out over 160ms without moving; reduced motion skips the fade.
  Replacing feedback updates the current toast instead of stacking another one.
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
- `src/pwa/components/PwaNotice.tsx` owns notice title/body/action layout, with
  styles in `src/pwa/styles/_notice.scss` loaded by the common foundation.
  Recovery features retain their announcements, retry/discard decisions, and
  review-before-removal safeguards. Standard actions use `Button`/`PwaButton`;
  PWA feature code cannot import Base UI Button directly.
- The plugin's `PluginReminderSourceNotice` shows local scan failures in a subtle
  tinted surface using compact shared typography, icons, and action buttons. Lead
  with a plain-language problem, then the filename and available line number;
  include the full path when affected filenames would be ambiguous. Known scanner
  messages get readable descriptions while original diagnostics remain intact.
  Keep **Editing is paused** secondary, emphasize **Open note**, and keep **Retry**
  quieter. All details stay visible without a disclosure; long lists scroll.
  Successful recovery removes the notice and any old action error.
- `src/ui/shared/CopyableText.tsx` owns clipboard feedback and the selectable
  readonly fallback. It uses the control's owner window, ignores stale copy
  completions, and runs an optional synchronous feature guard before copying.
  Shortcut setup retains pairing expiry and session validation; diagnostics
  retains its payload. Copy failure never changes or regenerates the value.
- `src/pwa/storage/download.ts` owns the JSON download and Blob URL lifecycle shared by
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

  PWA surface motion lives in `src/ui/shared/navigation/motion.ts` and
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
  Stationary tab dissolves use 240ms ease-in-out so outgoing content stays visible
  through the early frames and both screens blend at the midpoint. Switching
  to or from Reading uses that same tab dissolve in both hosts. Toasts retain
  their 160ms fade. Press feedback uses
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
  Reading library, filter results, and setup guidance reuse the shared
  `EmptyState` component and `empty-state` Sass from `src/ui/shared/`. Center these messages in
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
  desktop browser automation cannot establish that OS behavior. Sheets over the
  document reader hold its offset with `html.pwa-sheet-scroll-held` instead of
  fixing the body: re-layering a long article made iOS paint it a frame late,
  flashing the library and its dock through the article.

- On phone-sized iOS layouts, the settled reminders lists, Projects, a pushed
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
  they animate exactly as before. Scroll consumers read the active owner
  through `scrollPort`. `pwa-document-scroll-test.mjs` checks that both modes
  draw identical pixels.

- `src/ui/shared/BaseModal.tsx` uses Base UI Dialog on desktop and
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

## Making a visual change

PWA **Settings → Tabs** lets people choose exactly four bottom destinations from
Inbox, Reminders, Today, Upcoming, Projects, Reading, Favorites, Archive, and Highlights.
Each row has a replacement picker and a drag handle (also movable with arrow
keys). There are no add or remove actions. Older saved layouts with fewer than four
tabs retain their selections and fill the remaining slots from the defaults.
Preferences persist on the device and update across browser tabs.
**Reset tabs** restores Inbox, Reminders, Projects, and Reading. **Open app to** and
explicit links remain independent of visibility. Pinned Reading destinations open
directly. The last dock slot always opens the Reading view picker on hold or upward
slide, regardless of its destination; a normal tap still opens that slot’s view.
A small, muted up/down chevron pair marks this control, vertically centered beside
the destination icon without shifting it or adding a badge background. The cached
launch shell uses the same order, visibility, and selection before React starts.

Both hosts’ **Reminders** screens contain a compact **Today / Upcoming** segmented
control with a flat, opaque track and sliding selection. The PWA track uses the
flat chrome surface; Obsidian uses the theme's raised background. It uses 13px labels and a
32px visible track within 44px touch targets.
`ScheduleSwitcher` in `src/ui/shared/navigation/` keeps the controls mounted while the shared reminder panels
change. Their content reuses the shared `TabTransition` for the same stationary dissolve
as dock navigation, while the heading and segmented control stay mounted.
Upcoming retains its configured range, date groups, and launch links;
Both views select Reminders in the default dock; a pinned Upcoming tab has its own selection. The opening shell reserves the chips' final space
before JavaScript loads. Once the initial reminder snapshot is ready, the counts,
chips, and list reveal together with the shared 160ms fade. The title, actions,
and dock stay painted; reduced motion reveals content immediately, and background
refreshes do not replay the entrance. `tests/browser/pwa/pwa-schedule-test.mjs` checks cold
and cached launches with overdue reminders, coordinated reveal, selection,
keyboard focus, launch geometry, rapid reversals, stable card geometry and scroll,
empty states, and light/dark responsive layouts in Chromium and WebKit. The plugin uses the same dock, date switcher and project transition components. `PluginWorkspaceNavigation` retains both features inside one pane, while `PluginRemindersAppShell` manages local project navigation without browser history. Compact project sheets keep their own header and omit the main dock. Plugin pane geometry and Obsidian bottom obstructions live in `src/ui/plugin/plugin-navigation.scss`; dock, schedule and navigation presentation lives in the shared Sass modules. Dock destinations persist through Obsidian device-local storage.

The shared components and semantic tokens are Crate's design system. Extend
them for common controls and states; keep feature layouts and article typography
in their feature styles. PWA-wide behavior belongs in the host layer:

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

Built-app checks in `tests/browser/reading/reading-browser-test.mjs` and
`tests/browser/pwa/pwa-focus-test.mjs` cover the shared screen policy, native Chromium
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

## Validation and caching

Run `npm run build`, `npm run lint`, `npm run check:css-scope`,
`npm run check:style-tokens`, `npm run size-check`, and
`npm run test:pwa-preview`. Use `npm run preview:pwa`
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
limits for the plugin, embedded Worker, PWA entry and all PWA assets.

`tests/browser/plugin/base-ui-plugin-test.mjs` checks Dialog/Drawer nesting, keyboard navigation,
focus return, pending mutations, native Obsidian overlay handoff, touch gestures,
and portal content initialization in Chromium and WebKit. The smaller
`tests/browser/plugin/react-shadow-dom-test.mjs` covers editing and single button activation
across mount/unmount cycles.

Knip ignores the `tailwindcss` dependency because its direct import is the Sass
`@use "tailwindcss/theme.css"` in `src/styles/main.scss`, which Knip does not scan.
Keep that dependency while the stylesheet imports its theme.

The Obsidian status bar and Sync activity share the sync indicator. A configured
vault starts yellow while saved sync state loads and local startup checks run,
including when automatic sync is off. Show **Checking local files…** in Sync
activity until those checks finish; do not display **All synced** from an older
saved timestamp during startup. Actual sync progress, errors, and offline warnings
retain their own labels. This startup readiness flag belongs to the plugin runtime;
the PWA continues to supply its own session and refresh state.

## Sync indicator appearance

The shared indicator uses fixed green (`#22c55e`) and orange (`#f59e0b`)
for success and syncing across themes. Every state retains a solid circular dot, with
a centered completion ripple on success. Accessible labels continue to provide
the full status.
Forced-colors mode uses `CanvasText` for the dot and hides decorative halos
and ripples. The dot, glow, halo, and ripple share one SVG center; animation changes their
radii without independently scaling rasterized layers.
`tests/browser/pwa/pwa-sync-indicator-test.mjs` checks both PWA palettes, centered state
geometry, motion interruption, reduced motion, and Chromium forced colors.

## Testing notes

Choosing and running suites is covered in [testing](testing.md).

### Portable visual baselines

`npm run test:visual` fixes time, timezone and browser locale. Native time controls still use the operating system's 12/24-hour preference, so screenshots normalize their width and mask only the native time-input region. The time value is asserted independently, the surrounding labels/layout keep the existing 0.1% pixel threshold, and project, repeat-tab and time keyboard behavior run in separate tests. Baseline updates should affect only the intended time-control region; inspect mobile and desktop examples before accepting them. Browser zoom remains enabled in production.

`node scripts/visual-test-run.mjs tests/visual/project-interactions.spec.ts tests/visual/project-interactions-webkit.spec.ts --workers=2`
checks project pickers and autocomplete using the compiled host styles in plugin
Shadow DOM and the PWA document. It covers selected-row centering, wheel scroll
containment, synthetic touch-event propagation, keyboard navigation, dropdown
placement, and selection/focus restoration through the real plugin editor overlay.
It also checks title focus during opening, picker width at 320px and desktop sizes,
and applied autocomplete selection colors in both themes. Interaction coverage does
not depend on component source text. Physical touch scrolling still requires a device.

After building the plugin styles, run
`node scripts/visual-test-run.mjs tests/visual/reminder-editor-layout.spec.ts tests/visual/reminder-editor-layout-webkit.spec.ts --workers=2`
for editor geometry in both hosts. Chromium and WebKit check header alignment,
title/description hierarchy, compact spacing and long-field scrolling at 320px,
390px and desktop widths in light and dark themes. They also check placeholders,
disabled submission, inline marker geometry, property colors, and the delete
action's hover and keyboard states using the production reminder header. Chip
selection and pressing must change color without scaling the surface. Picker
checks cover native date/time inputs, selected rows and keyboard focus at narrow
and desktop widths.
These replace the corresponding SCSS text checks; token and scoping conventions
remain covered by source assertions.

`node scripts/visual-test-run.mjs tests/visual/reminder-list-style.spec.ts tests/visual/reminder-list-style-webkit.spec.ts --workers=2`
checks the shared list presentation and animated mouse reordering in both hosts.
The drag surface lifts while row geometry stays unchanged, releasing commits the
order without opening a reminder, and the next click still opens it. This replaces
source checks for Motion props and drag wrappers.

`node tests/browser/plugin/activity-empty-layout-test.mjs` mounts the production activity and
conflict modals against synthetic Obsidian host CSS. Chromium and WebKit check
header alignment, viewport fit, centered empty states, disabled sync actions and
matching primary controls in light/dark themes at desktop, mobile and short sizes.
It is included in `npm run test:activity-browser`; native Obsidian window behavior
still needs manual acceptance.

### Motion continuity

Use `node scripts/visual-test-run.mjs [Playwright arguments]` for gallery tests.
The launcher assigns an isolated output directory and port before starting Playwright;
the configuration itself performs no network work, so static analysis and
`npx playwright test --list` can read it directly. Preview build/serve lifecycle
remains in `scripts/visual-preview.mjs`.

`node tests/browser/pwa/pwa-feature-switcher-test.mjs` checks opaque feature dissolves,
mid-fade reversals, delayed animation cleanup, lazy-loading surfaces, immediate
reduced-motion switching and focus in Chromium/WebKit. Build the Worker first,
or let its preview harness build it.

After `npm run build:plugin`, run
`node scripts/visual-test-run.mjs tests/visual/motion.spec.ts tests/visual/motion-webkit.spec.ts --workers=1`
for shared empty/list reversals, immediate input, stable list geometry, progress
fill geometry, restrained checkmarks and reduced motion. The plugin fixture uses
Shadow DOM and also checks stationary centered dialogs. Actual installed iPhone
and Obsidian rendering still requires device verification.
