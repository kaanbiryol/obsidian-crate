# Remediation verification — 6 September 2026

This evidence belongs to the working-tree fixes following candidate `12f01b7`. Logs in the sibling `2026-09-06` directory describe the original audit and intentionally reproduce defects; they are not post-fix tests.

Host: macOS 26.5.1, Apple silicon. Main validation: Node 24.19.0, npm from that runtime, Python 3.14. Browser tests use the lockfile's Playwright 1.58.2 Chromium and WebKit builds. Local Worker tests run real D1/R2/Durable Object bindings under workerd with injected failures.

| Evidence | Command/result |
|---|---|
| [Clean install](clean-install.log) | `npm ci` passed; native package lifecycle policy warnings did not prevent builds or runtime tests. |
| [Release gate](release-check.log) | `npm run release:check` passed after the clean install: 1,013 unit tests, 42 Worker runtime tests, five recovery tests, static checks, builds, budgets, artifacts, and both browser engines. |
| [Visual comparison](visual-check.log) | `npm run test:visual -- --workers=2`: 48 passed, with normal comparison and no snapshot-update flag. `npm run typecheck:visual` also passed. |
| [Node 20 build](build-node20.log) | Production build passed with Node 20.20.2; all three release artifact hashes matched Node 24. |
| [Node 22 build](build-node22.log) | Production build passed with Node 22.23.2; all three release artifact hashes matched Node 24. |
| [Node 24 build](build-node24.log) | Final production rebuild passed with Node 24.19.0 and matched the same hashes. |
| [Dependency audit](npm-audit.json) | `npm audit --json`: zero vulnerabilities in every severity. |
| [Secret scan](secrets.log) | Gitleaks 8.30.1: available Git history and pending source passed; public OAuth client-ID exceptions are scoped in the repository configuration. |

Release artifact SHA-256 values:

```text
77847fd553093a005e18319caab52fbb3d56ff7a5e40e7ab473c865b277ed7b1  dist/main.js
7dc75f7503e211e7699088548d09097fe1406661cbac67c5cecf015b4dcfe968  dist/styles.css
e7fff40af51d7388907e6ed6a2e60e7b472fd08eed026ef8658628c541d5003a  manifest.json
```

The initial extra visual run passed eight images and differed in 40. Each changed rendering was reviewed for typography, wrapping, spacing, clipping, controls, and light/dark contrast. The differences corresponded to existing UI changes since the snapshots and host font rendering. The production styles were unchanged by remediation. Reviewed snapshots were refreshed and the strict suite rerun successfully. Screenshot CI uses the explicit `macos-26` platform; it no longer compares macOS captures with Linux system fonts. See [the visual workflow](../../../.github/workflows/visual.yml) and [UI testing documentation](../../ui-styling.md). GitHub publishes the [macOS 26 Apple silicon runner image](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md).

No live Cloudflare deployment, external-account OAuth/push, physical-device test, hosted restore, community-directory scanner, or final-commit GitHub Actions run is claimed. Cross-Node evidence is build reproducibility on this host; full release checks at the minimum Node versions are configured in CI. These limits are explicit in [the remediation record](../../audit-remediation.md).
