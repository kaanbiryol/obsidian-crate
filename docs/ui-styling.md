# Shared plugin and PWA UI

The plugin and PWA compile the same reminder components and Sass. Keep changes to
card structure, typography, badges, and states in the shared files so they reach
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
- Each host retains its own layout, sheet, keyboard, navigation, and persistence
  behavior. Editors and pickers still have host-specific presentation; sharing
  their content is a separate migration.

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
