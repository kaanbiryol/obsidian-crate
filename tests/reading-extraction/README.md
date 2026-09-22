# Reading extraction regressions

Run `npm run test:reading-extraction`. The test compiles a disposable Worker using
the production esbuild resolution settings and executes it with Miniflare/workerd.
It does not access a vault, a production server, or the public web. All pages are
synthetic fixtures and outbound requests are counted and denied.

`extract-document.ts` calls the production extractor. Defuddle selects article
HTML and its exported `createMarkdownContent` performs Markdown conversion.
Crate validates URLs and excludes remote media before conversion; it registers
no Markdown formatting rules and has no direct Turndown dependency.

The test and production bundles share `scripts/reading-extraction-build.mjs`.
It supplies linkedom's DOMParser through a module-local `window` in Defuddle's
browser bundle, without modifying global state or upstream conversion rules.
It also strips Defuddle diagnostics to avoid logging source content. Conversion
failures are rejected instead of saving the library's original-HTML fallback.

Regression cases cover HTML indentation, empty links, lists, tables, code fences,
unsafe URLs, React IDs, public X post markup, and parity with Defuddle's extended
Markdown rules. Transport limits and guarded publication have separate coverage.
