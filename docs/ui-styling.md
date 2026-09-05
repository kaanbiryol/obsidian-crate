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
  keep native modal behavior, apply/cancel semantics, and date-input commit timing.

## Making a visual change

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
checks project/repeat keyboard navigation. CI pins browser dependencies, locale,
timezone, and clock. Failures upload screenshots, diffs, and traces. To propose
new baselines, dispatch **Shared UI visual checks** with **Generate candidate
baselines for review**, inspect its artifact, and commit only approved images
from `tests/visual/baselines`. Normal CI never updates baselines automatically.

The CSS cleanup reduced the plugin stylesheet from approximately 146 KB to
138 KB by limiting Tailwind scanning to application source, shortening repeated
primary-screen selectors, and removing obsolete picker/footer rules. The raw
budget is now 140,000 bytes; the existing 20,000-byte gzip limit is unchanged.
