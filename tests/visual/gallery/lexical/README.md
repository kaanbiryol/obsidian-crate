# Lexical editor fixture

The reminder editor now uses Lexical in both Obsidian and the PWA. This gallery
uses that same component with sample text; it does not save to the vault.

Run `npm run build` if `dist/styles.css` is missing, then `npm run preview:ui`.
Open <http://127.0.0.1:8790/?scene=lexical&host=plugin&theme=dark> for plugin styles
and a real open Shadow DOM, or use `host=pwa` for the ordinary DOM. Both support
`theme=light`.

`npx playwright test tests/visual/lexical-trial.spec.ts --workers=2` checks editing,
Markdown links, chips, Unicode, paste and history in Chromium and WebKit.
The built-PWA focus and selection scripts additionally exercise saving and
picker restoration. Desktop browser tests do not establish physical iPhone
keyboard, dictation or installed-app acceptance.

## Regression suite

Run `npm run test:lexical` with the repository's Node version. Playwright starts
(or reuses) the gallery server; the integration scripts build the production
PWA and start isolated local servers with synthetic reminders. No real vault
or deployed server is modified.

Coverage:

- 23 unit cases, including 150 reproducible generated documents: Markdown and
  JSON round trips, Unicode, whitespace, repeated decoration, project changes,
  every caret offset around links/newlines, backward ranges and stale offsets.
- 40 browser cases: ten scenarios in Chromium and WebKit, each in ordinary DOM
  and the plugin's Shadow DOM. Covers chip/link editing, cross-node selection,
  undo/redo, external loads, line breaks, clipboard normalization, HTML treated
  as text, read-only changes, remount cleanup and history isolation.
- Built PWA: autocomplete after links, committed marker normalization, exact
  saved Markdown, empty-title validation, draft reload with description and
  Unicode, recovered-history isolation, selection/scroll restoration through
  pickers, long editors, composition commit, focus/discard/save/delete,
  damaged-draft recovery and safe service-worker updates.

The unit generator has a fixed seed so failures are reproducible. Browser
assertions verify text, selection, links and request bodies rather than
relying on snapshots or arbitrary sleeps. A single replacement insertion is
one undo operation; replacing a range and then typing more characters can
produce separate history entries, as defined by Lexical.

Still verify on an installed iPhone PWA: native selection handles, autocorrect,
Japanese/Chinese keyboard composition, dictation, emoji deletion, keyboard
Done, app switching and reopening while a draft is unsaved. Desktop WebKit
and synthetic composition events do not reproduce the native keyboard.
