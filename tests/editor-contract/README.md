# Editor migration compatibility

This suite was written against the original editor at commit
`4ac503fa54ba36aa54b8a64d916db65dc008bae0`, before running the same cases against
Lexical. The original source stays unchanged in a temporary Git archive. The
working checkout keeps the Lexical implementation and all uncommitted work.
Both runs share the installed dependency versions to isolate application code.
Only the test harness and built-PWA test script are copied into the old archive.

Run with the repository's Node version after `npm install`:

- `npm run test:editor-compat`: old editor first, current editor second, with a
  comparison report at `.generated/editor-contract/comparison.md` and JSON next
  to it. Requires the pinned commit in local Git history and port 8791 free.
- `npm run test:editor-contract`: current editor plus built-PWA integration only;
  no historical checkout is needed.
- `npm run typecheck:editor-contract`: type-check the browser harness and tests.

The shared browser checks also run through `npm run test:visual`, and the built
PWA checks through `npm run test:pwa-browser`. The existing Lexical-specific
suite remains separate, under `tests/visual/lexical-trial.spec.ts`.

## What is compared

There are 26 scenarios, each run in Chromium and WebKit, in ordinary DOM and
plugin Shadow DOM: 104 cases per implementation. They exercise public editor
props/handles, native keyboard/selection operations, plain-text clipboard events,
and emitted Markdown. They never inspect a Lexical node, editor model, private
property, or implementation marker.

Coverage includes initial content and remounts; whitespace, Unicode and multiline
text; caret insertion at the beginning/middle/end; forward and backward selection
across links and chips; link label edits and full deletion; editable project
markers; plain-text paste and HTML rejection; duplicate-marker normalization;
Enter and Backspace; autocomplete following links; parent keyboard handling;
external value/caret updates; read-only changes; focus requests; separate editor
histories; fresh history on remount; select-all deletion; typed Markdown links;
project-list changes; combined emoji deletion; and a long multiline paste.

The same production-PWA script is also run against both source trees. It checks
real autocomplete controls, typing after acceptance, undo/redo, paste cleanup,
exact save request bodies, empty-title validation, draft persistence and reload,
description/Unicode preservation, recovered-editor history and draft removal
after saving. Its API is a local synthetic server; it does not write real
reminders, alter Obsidian, or deploy anything.

External caret updates in the old editor happen on an animation frame. The
comparison allows that public API to settle before typing after autocomplete.
This tests the final supported behavior rather than requiring Lexical's
synchronous timing from the old implementation. Clipboard events and browser
keyboards are synthetic; they do not establish native iPhone keyboard acceptance.

## Reading the results

A passing old case that fails on the current editor is a regression. A failing
old case that passes now is an improvement. Failures in both are retained as
existing failures. Missing cases and any current failure produce a nonzero exit
code. Baseline-only mode intentionally exits nonzero for historical defects;
comparison mode can succeed when all current cases pass despite old defects.
The built-PWA results and full logs are reported separately. Browser page errors
fail that suite; ResizeObserver warnings are not filtered out.

The initial established baseline passed 100/104 cases. The four failing cases
were the same shared-component defect: Enter between `alpha` and `omega` emitted
`alphaomega` instead of `alpha\nomega`. Lexical passed all 104, preserving every
old passing case and retaining the line break in that additional case. This is
an observation at the shared editor boundary, not a claim that every app-level
Enter action was broken (hosts can intercept Enter).

The built-PWA comparison also caught a repeatable WebKit ResizeObserver loop
notification when the description grew. The sheet height observer now schedules
subsequent measurements on an animation frame, while initial sizing remains
synchronous. The error assertion is retained as a regression check.

Undo grouping is deliberately not required to be identical: the old editor
recorded each input event, while Lexical groups typing. External updates also
retain history in Lexical so autocomplete/picker edits can be undone; the old
editor reset it. The tests verify single-operation undo/redo, independent fields,
and a fresh history when mounting a different editor, rather than freezing
those implementation policies.

Passing this suite is evidence for the covered behaviors, not proof that no
possible regression exists. Native iPhone selection handles, autocorrect,
dictation, IME keyboards, keyboard Done and installed-app lifecycle still need
physical-device checks.
