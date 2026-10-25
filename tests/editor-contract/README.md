# Reminder editor contract

This suite checks the shared reminder editor at its public boundary in Chromium
and WebKit, in ordinary DOM and plugin Shadow DOM.

Run with the repository's Node version after `npm install`:

- `npm run test:editor-contract`: the browser suite plus the built-PWA editor
  integration script. Requires port 8791 free.
- `npm run typecheck:visual`: type-check the browser harness and tests, together
  with the visual suite.

The browser suite also runs through `npm run test:visual`, and the built
PWA checks through `npm run test:pwa-browser`. The Lexical-specific
suite remains separate, under `tests/visual/lexical-trial.spec.ts`.

## What is covered

The suite covers recurrence recognition and validation, local date/time pairs,
final-token selection, and preservation of earlier date, project and priority
mentions. A draft fixture also combines the plugin's production draft hook, editor
fields and submission builder to cover recurrence changes/removal, title-only edits,
Inbox selection from another project, and unsupported recurrence and timezone errors.
Address and filename cases retain literal text while recognizing a separate schedule.
The actual modal and built PWA also cover one-off Chrono timezones, recurring
named zones and fractional offsets, invalid suffixes, and preservation of the
zone and stored occurrence through reopening, priority, project and picker edits.
They exercise public editor
props/handles, native keyboard/selection operations, plain-text clipboard events,
and emitted Markdown. They never inspect a Lexical node, editor model, private
property, or implementation marker.

Coverage includes initial content and remounts; whitespace, Unicode and multiline
text; caret insertion at the beginning/middle/end; forward and backward selection
across links and chips; link label edits and full deletion; editable project
markers; plain-text paste and HTML rejection; duplicate-marker preservation;
Enter and Backspace; autocomplete following links; parent keyboard handling;
external value/caret updates; read-only changes; focus requests; separate editor
histories; fresh history on remount; select-all deletion; typed Markdown links;
project-list changes; combined emoji deletion; and a long multiline paste.

The production-PWA script checks real autocomplete controls, typing after
acceptance, undo/redo, paste cleanup, exact save request bodies, empty-title
validation, draft persistence and reload, description/Unicode preservation,
recovered-editor history and draft removal after saving. Its API is a local
synthetic server; it does not write real reminders, alter Obsidian, or deploy
anything. Clipboard events and browser keyboards are synthetic; they do not
establish native iPhone keyboard acceptance.

## Reading the results

Any failing case produces a nonzero exit code. Playwright results and failure
traces are written to `.generated/editor-contract/current/`. Browser page errors
fail the built-PWA script; ResizeObserver warnings are not filtered out.

Undo grouping is deliberately not fixed: the tests verify single-operation
undo/redo, independent fields, and a fresh history when mounting a different
editor, rather than freezing how typing is grouped or whether external updates
retain history.

Passing this suite is evidence for the covered behaviors, not proof that no
possible regression exists. Native iPhone selection handles, autocorrect,
dictation, IME keyboards, keyboard Done and installed-app lifecycle still need
physical-device checks.
