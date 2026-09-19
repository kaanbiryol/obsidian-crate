# Crate development

Crate is an Obsidian community plugin with Cloudflare sync and a reminders PWA. These instructions retain project-specific constraints while leaving implementation choices to the agent.

## Working approach

- Complete the requested work through implementation, relevant verification, and fixes for failures caused by the change. Make reasonable assumptions for routine, reversible choices; ask when missing information materially changes scope or correctness.
- Inspect the affected code and load only the documentation and skills relevant to the task. Use an explicitly requested skill; otherwise select skills by their actual workflow, not incidental keywords. Read supporting skill resources only as needed.
- Preserve unrelated working-tree changes. Keep cleanup focused on the requested outcome.
- Report the result, checks performed, and any remaining blockers concisely. Distinguish automated checks from manual or physical-device verification.

## Project map and contextual documentation

- `src/main.ts` is the bundle entry shell; plugin lifecycle belongs in `src/plugin/CratePlugin.ts` and focused modules under `src/plugin/`.
- `src/sync/` owns sync planning and transfer; `src/reminders/` owns reminders; `src/ui/` owns plugin UI; `src/cloudflare/` owns deployment and server code.
- Read [architecture](docs/architecture.md) when changing responsibility boundaries. Sync decisions belong to the plugin; the Worker stores data, serves the PWA/API, and schedules notifications.
- For sync changes, consult [sync pipeline](docs/sync-pipeline.md) and [protocol](docs/protocol.md). For API or compatibility changes, use [Worker API](docs/worker-api.md) and [compatibility](docs/compatibility.md).
- For UI changes, use [UI styling](docs/ui-styling.md). Shared reminder components run in Obsidian Shadow DOM and the PWA document; verify the affected surfaces.
- For PWA persistence and recovery, use [storage recovery](docs/pwa-storage-recovery.md) and [tab convergence](docs/pwa-tab-convergence.md).
- For test selection or release acceptance, use [testing](docs/testing.md). For deployment or server revision changes, use [deployment](docs/deployment.md) and [server upgrades](docs/server-upgrades.md).

## Tooling and verification

Use npm and the Node.js range declared in `package.json` (currently `^26.8.2`). Scripts in `package.json` are the source of truth.

- Install: `npm install`; development watch: `npm run dev`.
- Production build: `npm run build` builds the Worker, type-checks the plugin, and bundles it with Vite/Rollup into `dist/`.
- Static checks: `npm run lint`, `npm run typecheck`, and `npm run typecheck:worker` for their affected targets.
- Unit tests: `npm test`, or `npx vitest run <test-file>` for a focused regression.
- Worker integration: `npm run test:worker-runtime` builds the Worker and tests local D1/R2/Durable Object bindings.
- Browser coverage: select relevant tests from `npm run test:pwa-browser` or `npm run test:visual`; see the testing guide for harness requirements.
- Broad validation: `npm run check`. Before publishing a plugin or server release, run `npm run release:check` and complete the applicable acceptance checks in the testing guide.

Match verification to the behavior changed. Add regression coverage for meaningful behavior or failure modes; documentation-only edits need a diff/link review, not the application test suites. After relevant checks pass, repeat or broaden them only for new edits, failures, or unresolved risks.

For manual plugin testing, copy `dist/main.js`, `manifest.json`, and `dist/styles.css` into `<Vault>/.obsidian/plugins/<plugin-id>/`, reload Obsidian, and enable it in **Settings → Community plugins**. Test mobile-specific behavior on iOS/Android where available; report when device testing was unavailable.

## Implementation constraints

- Keep modules focused and `src/main.ts` minimal. Split by responsibility when needed; file length alone is not a reason to refactor.
- Preserve strict TypeScript checking. Prefer browser-compatible dependencies and keep bundles small; plugin runtime dependencies must be bundled into `main.js`.
- Preserve mobile compatibility unless `manifest.json` explicitly declares desktop-only support. Avoid Node/Electron APIs in shared plugin code.
- Register commands with `this.addCommand(...)` and preserve released command IDs. Provide sensible settings defaults and validation; await `loadData()` / `saveData()` where persistence ordering matters.
- Use Obsidian `register*` helpers for lifecycle cleanup of events, DOM listeners, and intervals. Reload/unload must not leak resources.
- Keep startup light, defer expensive work, batch vault access, and debounce expensive filesystem reactions. Avoid unnecessary scans and large in-memory structures on mobile.
- Use sentence case and short, clear UI copy. In instructions, use **bold** for literal UI labels, “select” for interactions, and arrows for navigation.

## Runtime privacy and data safety

These constraints govern shipped plugin/server behavior and access to users' vault data.

- Keep local features usable offline. Network access must serve a disclosed feature; cloud services and optional analytics require explicit user opt-in documented in `README.md` and settings.
- Read, store, or transmit only the vault data required for the consented feature. Plugin filesystem access must stay within the vault.
- Never execute fetched code or auto-update plugin code outside normal releases. No hidden telemetry, deceptive UI, ads, or spam notifications.
- Follow Obsidian's [developer policies](https://docs.obsidian.md/Developer+policies) and [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines) when changing integrations or release behavior.

## Git and releases

- Use `gh` CLI for GitHub operations.
- Commit messages must be entirely lowercase Conventional Commits: `<type>(<scope>): <description>`. Allowed types: `fix`, `feat`, `chore`, `refactor`, `perf`, `build`, `ci`. Use `ios` or `android` for platform-only changes; omit scope for cross-platform or repository-wide work.
- Do not add `Co-Authored-By` trailers or generated-by attribution to PR descriptions.
- Never commit `node_modules/`, `dist/`, `.generated/`, root release bundles such as `main.js`, or other generated build output.
- Preserve the released plugin `id`. Keep `minAppVersion` accurate for the APIs used and retain required manifest metadata.
- For a release, bump `manifest.json` using semantic versioning and update `versions.json`. The GitHub release tag must exactly match the manifest version, with no leading `v`.
- Attach `manifest.json`, built `main.js`, and `styles.css` when present as individual release assets. Follow community catalog requirements where applicable.
