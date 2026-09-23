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
  `src/cloudflare/worker/pwa/styles/reminders-view.css` and `theme-light.css`,
  while `theme.css` defines standalone typography and geometry. Existing names
  such as `--background-primary` and `--font-ui-medium` are compatibility inputs;
  using them does not import the Obsidian runtime into the browser.
- `src/reminders/ui/shared/styles/_reminder-cards.scss` owns reminder cards,
  checkboxes, metadata badges, and their states. `_primary-screen.scss` owns
  list-screen density and hierarchy. The plugin's `_card-presentation.scss`
  only handles embedded-list spacing and keyboard focus.
- `src/ui/shared/` owns buttons, icon buttons, and modal headers. Icons use the
  existing `ThemeIcon` provider; the plugin adapters supply Obsidian icons.
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


## Making a visual change

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

`npm run test:visual` compares 48 screenshots at 390px and 1280px widths and
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
controls. Keep article typography and library layout in Reading rather than
overriding every button or dialog there. Native text fields retain browser editing
and selection behavior; composite search fields draw one focus cue around the
whole control.
Base UI provides buttons, toggles, dialogs, and drawers. Obsidian supplies the
icon renderer in the plugin; the PWA loads article-only icons with Reading. Input
modality belongs to the PWA feature shell so keyboard focus works before either
feature has been opened. Each feature retains its existing persistence and modal
lifecycle adapter.
Container queries select a three-pane desktop workspace, a two-pane compact
workspace, or phone navigation; a narrow Obsidian pane behaves like the phone UI.
The library and reader own separate scroll containers, so opening an article
preserves filters and list position. Browser history remains in the PWA adapter.

Article HTML still passes through the existing sanitizer. Source badges are local
letter marks; rendering a list makes no favicon or tracking requests. Appearance,
tags, and capture use the existing Base UI modal primitive with portals in the
current host document. Device/session controls live under **Reading settings**.
The shared `src/ui/shared/styles/_base-modal.scss` mixin provides dialog geometry
in both hosts. Reading and reminder sheets share the PWA modal header layout.
Phone sheets follow the visual viewport while an input is focused,
including focus inside the plugin's Shadow DOM.
The capture form preserves its draft on dismissal; only successful capture clears
it. The PWA retains the existing durable capture and metadata outbox.

The PWA's app switch is a single icon in each feature's existing header. Reading
shows a checklist icon for **Switch to Reminders**; Reminders shows a book for
**Switch to Reading**. The modes crossfade over roughly 200 ms. Scrolling content
shrinks by 1.5% as it leaves and settles from 1.5% larger as it enters. The
header, switch button, FAB, and bottom-bar geometry stay fixed; the titles,
metadata, and bottom-bar items crossfade with their panels. The button icon
rotates subtly and its surface pulses when the new mode appears. Reduced-motion
users switch without animation. `FeatureShell.tsx` preserves mounted feature state
and navigation, keeps the inactive panel inert, and restores keyboard focus to the
destination's switch after its initial loading completes.
Both PWA modes show layout-matched skeletons while their first usable data is
loading. Reading uses the same row skeleton when the library has no cached data;
Reminders uses card skeletons while a cached empty list is being checked. Neither
shows a zero count until that empty result is confirmed, and background refreshes
keep existing items visible.
The same switch is available on both connection screens.

Run the Reading visual specs in Chromium and WebKit for both hosts, light/dark
surfaces, mobile and desktop widths, safe rendering, article actions, capture,
and appearance controls. `scripts/reading-browser.test.mjs` exercises the built
PWA against real local storage and Worker bindings, including offline reading and
replay of a save whose response was lost. iPhone keyboard, native sharing, and
installed-app safe areas still require physical-device acceptance.
