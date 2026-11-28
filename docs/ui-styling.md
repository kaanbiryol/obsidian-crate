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
| Row padding | 12px vertically and horizontally | Reminders, projects, Reading articles and picker options |
| Content / text stack gap | 12px / 4px | Leading icons or accents / title and metadata |
| Row gap | 0px flat, 8px cards | All four list types, including reminder animation and embedded lists |
| Nested row padding / indent | 8px vertically / 16px | Subprojects |
| Expanded group gap | 8px projects | Space after expanded groups |
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

## Style files and host themes

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
  using them does not import the Obsidian runtime into the browser. The PWA's
  theme provider is described in [PWA UI](pwa-ui.md#theme).
- `src/pwa/styles/foundation.scss` installs the shared tokens, controls, modal
  primitives, and PWA header defaults for every feature. The PWA stylesheet
  entry point loads it independently of the reminder layout stylesheet.
- `src/ui/shared/styles/_list-item.scss` owns the surface, interaction states,
  primary spacing, and title typography shared by reminder and Reading items.
  Shared Sass mixins preserve each feature's existing DOM and interaction
  semantics. Flat surfaces are reusable mixins here. Reminders, projects, Reading
  articles, and Highlights use spacing between flat rows without dividers.
  Existing reminder surface tokens remain host-theme inputs.
- `src/reminders/ui/shared/styles/_reminder-cards.scss` owns reminder cards,
  checkboxes, metadata badges, and their states. `_primary-screen.scss` owns
  list-screen density and hierarchy. The plugin's `_card-presentation.scss`
  only handles embedded-list spacing and keyboard focus.
- `ReminderEditorFields` and `ReminderActionChips` are shared editor content.
  Their styles live in `src/reminders/ui/shared/styles/_editor-*.scss`; header
  and control styles live in `src/ui/shared/styles/`. The plugin field adapter
  supplies the theme's project icon mask.
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

## Shared components

- `src/ui/shared/` owns buttons, icon buttons, text fields, and headers.
  Obsidian modal shells, native modal controls and stylesheet/React mounting
  helpers live in `src/ui/plugin/`. Shared controls remain independent of these
  host APIs; ESLint enforces the import boundary for shared UI and the PWA.
  Icons use the existing `ThemeIcon` provider; the plugin adapters supply
  Obsidian icons.
- Shared text fields use one rounded style in both hosts: 16px corners, 48px
  minimum height, and 16px horizontal padding. Their filled surfaces, borders,
  and focus cues retain shared theme colors. Flat Reading rows use the same 8px
  hover/press corners as reminder rows.
- `src/ui/shared/CopyableText.tsx` owns clipboard feedback and the selectable
  readonly fallback. It uses the control's owner window, ignores stale copy
  completions, and runs an optional synchronous feature guard before copying.
  Shortcut setup retains pairing expiry and session validation; diagnostics
  retains its payload. Copy failure never changes or regenerates the value.
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
  semantics and explicit Enter/click selection. Motion handles list,
  reorder, and content animations.
- Obsidian Settings, Notice, Menu, and its other native modal screens stay on
  Obsidian's APIs. Plain native select/number/date/time inputs and review
  checkboxes remain browser controls. The rich-text editor's caret-based project
  completion remains editor logic; it is not a plain combobox input.
- The plugin's `PluginReminderSourceNotice` shows local scan failures in a subtle
  tinted surface using compact shared typography, icons, and action buttons. Lead
  with a plain-language problem, then the filename and available line number;
  include the full path when affected filenames would be ambiguous. Known scanner
  messages get readable descriptions while original diagnostics remain intact.
  Keep **Editing is paused** secondary, emphasize **Open note**, and keep **Retry**
  quieter. All details stay visible without a disclosure; long lists scroll.
  Successful recovery removes the notice and any old action error.
- Each host retains its own sheet, keyboard, navigation, and persistence
  behavior. The PWA editor layout sets browser sheet height, safe areas, and
  touch target sizes. Its focus/keyboard-save hook remains in the PWA adapter.
  Date, project, and repeat picker content and styles are shared too. Host adapters
  keep apply/cancel semantics, keyboard geometry, and date-input commit timing.
  PWA sheets and keyboard handling are in [PWA UI](pwa-ui.md#sheets-and-keyboard).

### List style

**Appearance → List style** in Obsidian and in the PWA
select **Flat** (the default) or **Cards** for reminders, projects, and Reading locally in each
host. Existing saved choices are retained. The plugin setting applies immediately to open views,
project lists, embedded notes, and Reading; the PWA stores its own preference and updates
open tabs. Flat rows retain completion targets, priority, keyboard focus,
press/drag feedback, and theme colors while removing card surfaces and metadata
pill outlines. Flat reminder and project rows have no dividers, including expanded
subproject groups; the main header separator remains. Inbox hides its redundant project
label while retaining dates and recurrence; mixed-project views keep project labels.
Reading rows follow the same preference; see [Reading UI](reading-ui.md#library-rows-dialogs-and-capture).

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

### Schedule switcher and navigation

Both hosts’ **Reminders** screens contain a compact **Today / Upcoming** segmented
control with a flat, opaque track and sliding selection. The PWA track uses the
flat chrome surface; Obsidian uses the theme's raised background. It uses 13px labels and a
32px visible track within 44px touch targets.
`ScheduleSwitcher` in `src/ui/shared/navigation/` keeps the controls mounted while the shared reminder panels
change. Their content reuses the shared `TabTransition` for the same stationary dissolve
as dock navigation, while the heading and segmented control stay mounted.
Upcoming retains its configured range, date groups, and launch links.
Today and Upcoming are not dock destinations: both select the Reminders slot
(`dockDestinationIndex` in `src/ui/shared/navigation/dock-destinations.ts`). The opening shell reserves the chips' final space
before JavaScript loads. Once the initial reminder snapshot is ready, the counts,
chips, and list reveal together with the shared fade. The title, actions,
and dock stay painted; reduced motion reveals content immediately, and background
refreshes do not replay the entrance. `tests/browser/pwa/pwa-schedule-test.mjs` checks cold
and cached launches with overdue reminders, coordinated reveal, selection,
keyboard focus, launch geometry, rapid reversals, stable card geometry and scroll,
empty states, and light/dark responsive layouts in Chromium and WebKit.

The plugin uses the same dock, date switcher and project transition components. `PluginWorkspaceNavigation` retains both features inside one pane, while `PluginRemindersAppShell` manages local project navigation without browser history. Compact project sheets keep their own header and omit the main dock. Plugin pane geometry and Obsidian bottom obstructions live in `src/ui/plugin/plugin-navigation.scss`; dock, schedule and navigation presentation lives in the shared Sass modules. Dock destinations persist through Obsidian device-local storage. The PWA's dock settings are in [PWA UI](pwa-ui.md#bottom-tabs).

## Interaction rules

`usePressFeedback` owns momentary interaction state for buttons, reminder cards,
and native picker rows. Style it with `data-press-active`; never use CSS
`:active` or Base UI's persistent toggle `data-pressed` for that feedback.
Release, cancellation, scrolling, pointer exit, blur, activation, and app
backgrounding clear the press. Scope hover effects to `(hover: hover) and
(pointer: fine)`. Keep actual selection, checked states, keyboard focus, and
native field editing independent of press feedback.

Compound fields use `focus.within` from `src/ui/shared/styles/_focus.scss`
for one focus cue around the whole control. Text inputs, textareas and compound
text fields change their existing border color on focus without an outer ring.
Buttons, links, tabs and non-text selectors retain visible keyboard-focus rings.
Settings selectors, number fields, and search boxes share the focus mixin. The PWA enables that outline only after keyboard
navigation through `--crate-compound-focus-style`; touch and mouse focus stay
undecorated without blurring controls. Obsidian retains its normal focus cue.

Headers with `preventFocusOnPress` also preserve field focus and selection on
title and empty-header taps, using the reminder editor's shared
`usePreserveFieldFocus` hook. These taps keep the keyboard open; header drags
and explicit actions retain their normal behavior.

## Motion rules

PWA surface motion lives in `src/ui/shared/navigation/motion.ts` and
`src/pwa/styles/motion.scss`. Project details and picker entrances use a
critically damped Motion spring; CSS-owned drawers and Reading navigation
use a sampled spring curve with a cubic fallback. Direct drawer dragging
remains unanimated, and CSS transitions resume from the current position.
Sheet presentation and keyboard motion in the PWA are in [PWA UI](pwa-ui.md#sheets-and-keyboard).

Every stationary fade uses one shared fade: 270ms `cubic-bezier(0.3, 0.3, 0.2, 1)`.
It starts moving on the first frame, is half done at about 70ms and 90% done at
about 150ms, so a screen change reads as a dissolve rather than a cut without two
screens sitting muddled for long. It is defined once as
`--pwa-motion-fade-duration` and `--pwa-motion-fade-ease` in
`src/ui/shared/styles/_navigation-motion.scss` and mirrored by `PWA_FADE` and
`PWA_FADE_TIMING` in `src/ui/shared/navigation/motion.ts` (a unit test keeps them equal).
Never hard-code a fade duration; first visits and returns must look the same.
Tab dissolves use it while the dock's collapse carries the motion. Switching to
or from Reading uses that same dissolve in both hosts. A Reading tag change
dissolves a copy of the departing rows over the new list with the same fade, so
rows both tags list stay steady. Content that replaces a loading state fades in
with it through `useContentReveal`, as do list rows, empty states and toasts, so a
Reading section that has to load never pops in; a screen read before draws at
once without fading. Reading section loading is described in [Reading UI](reading-ui.md#library-rows-dialogs-and-capture).

Press feedback uses
120ms ease-out (`--pwa-motion-feedback-ease`), and control movement uses the shared control spring or 180ms CSS curve.
The dock selection highlight uses a 300ms spring-like curve so adjacent-tab
changes retain visible travel instead of spending almost all their time settling.
Dock expansion uses a spring with a soft overshoot of a few pixels and closes
on a quicker critically damped spring; its choices' icons and labels rise 8px
into stationary hit targets. While the surface changes shape, the choices and
tab icons crossfade where they overlap, so a chosen view visibly collapses back
into the bar; neither carries a filter, since WebKit paints blurred layers inside
the clipped menu with stray edge artifacts. A held switcher swells until the menu opens, the expanded surface
gains a shadow with its progress, and one highlight slides between choices
under a held finger. Native dragging remains immediate.

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

Keep native history gestures immediate and tab changes as stationary outgoing-screen dissolves over opaque incoming screens,
and reduced-motion paths free of spatial transitions.

## Making a visual change

The shared components and semantic tokens are Crate's design system. Extend
them for common controls and states; keep feature layouts and article typography
in their feature styles. PWA-wide behavior belongs in the PWA host layer; see
[PWA interaction policy](pwa-ui.md#interaction-policy).

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
the sync button's quiet outlined treatment. `_tokens.scss` maps the action tokens to
host theme values. Actions use the sync button's input radius and smaller UI text
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

`scripts/bundle-budgets.mjs` is the source of truth for the stylesheet's size:
it records measured baselines and explicit raw/gzip limits for `dist/styles.css`,
the plugin, embedded Worker, PWA entry and all PWA assets.

`scripts/pwa-asset-version.mjs` hashes the compiled PWA Sass in addition to client
assets and Worker PWA sources. Changes to transitive shared imports therefore
invalidate the installed PWA shell cache. Plugin-only styles do not change the
PWA version. `src/pwa/pwa-asset-version.test.ts` protects that boundary.

Knip ignores the `tailwindcss` dependency because its direct import is the Sass
`@use "tailwindcss/theme.css"` in `src/styles/main.scss`, which Knip does not scan.
Keep that dependency while the stylesheet imports its theme.

## Visual regression coverage

`npm run build && npm run preview:ui` serves the isolated gallery on port 8790.
It renders production cards, editor fields, pickers, Reading and other fixtures with
plugin or PWA styles. Query parameters select `host=plugin|pwa`,
`theme=light|dark`, and `scene`. The screenshot scenes are
`cards`, `flat`, `editor`, `date` (the default), `project`, `weekly` and `monthly`;
`tests/visual/gallery/main.tsx` also defines `reading`, `controls`, `motion`,
`list-style`, `navigation`, `tabs`, `draft`, `lexical`, `source`, `metadata`,
`delete`, `progress`, `status`, `project-interactions`, `loading` and
`loading-block` for the other specs.
The plugin fixture supplies deterministic Obsidian-style variables; it does not
replace testing actual community themes or native modal/keyboard integration.

`npm run test:visual` builds a private gallery snapshot on its own port before
comparing screenshots and checking project/repeat keyboard navigation.
`tests/visual/baselines` holds 74 images: `shared-ui.spec.ts` compares the seven
screenshot scenes for both hosts and themes at 390px and 1280px widths (56), and
`reading.spec.ts` compares the Reading library, reader and appearance screens (18).
The canonical snapshot platform is
macOS 26 on Apple silicon, matching the `macos-26` CI runner. Use that platform
when comparing or updating these images: system fonts and native controls can
render differently on Linux or Windows. Chromium comes from the lockfile; CI
also fixes locale, timezone, and clock. Functional Chromium/WebKit release tests
continue to run on Linux. Failures upload screenshots, diffs, and traces. To propose
new baselines, dispatch **Shared UI visual checks** with **Generate candidate
baselines for review**, inspect its artifact, and commit only approved images
from `tests/visual/baselines`. Normal CI never updates baselines automatically.

`tests/browser/plugin/base-ui-plugin-test.mjs` checks Dialog/Drawer nesting, keyboard navigation,
focus return, pending mutations, native Obsidian overlay handoff, touch gestures,
and portal content initialization in Chromium and WebKit. The smaller
`tests/browser/plugin/react-shadow-dom-test.mjs` covers editing and single button activation
across mount/unmount cycles.

## Sync indicator appearance

The Obsidian status bar and Sync activity share the sync indicator. A configured
vault starts yellow while saved sync state loads and local startup checks run,
including when automatic sync is off. Show **Checking local files…** in Sync
activity until those checks finish; do not display **All synced** from an older
saved timestamp during startup. Actual sync progress, errors, and offline warnings
retain their own labels. This startup readiness flag belongs to the plugin runtime;
the PWA continues to supply its own session and refresh state.

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
and desktop widths. Token and scoping conventions are covered by source assertions.

`node scripts/visual-test-run.mjs tests/visual/reminder-list-style.spec.ts tests/visual/reminder-list-style-webkit.spec.ts --workers=2`
checks the shared list presentation and animated mouse reordering in both hosts.
The drag surface lifts while row geometry stays unchanged, releasing commits the
order without opening a reminder, and the next click still opens it.

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
