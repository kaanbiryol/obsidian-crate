# Crate

Crate is an Obsidian community plugin (`id: crate`, mobile supported) that syncs a vault and reminders through Cloudflare (Worker, R2, D1, Durable Objects), plus a reminders/reading PWA. The same Worker can run locally via `packages/server`. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup and PR expectations.

## Working approach

- Finish the task end to end: implement, verify, and fix failures your change caused. Make reasonable calls on routine, reversible choices; ask only when missing information changes scope or correctness.
- Read the code and the relevant doc before editing. Load only the docs and skills the task needs.
- Keep changes surgical and preserve unrelated working-tree changes. Match surrounding style.
- Report what changed, which checks ran, and what remains. Separate automated checks from manual or physical-device verification.

## Layout

| Path | Owns |
| --- | --- |
| `src/main.ts` | Bundle entry shell only |
| `src/plugin/` | Plugin lifecycle, commands, settings wiring |
| `src/sync/` | Sync planning, manifest/checkpoints, transfer. Sync decisions live here |
| `src/reminders/`, `src/reading/` | Reminder and Reading features (shared rules in `core/`, vault access in `data/`) |
| `src/encryption/` | End-to-end encryption formats, keys, pairing |
| `src/protocol/` | Wire formats, limits, compatibility. Shared by plugin, PWA and Worker |
| `src/pwa/` | Browser app: session, cache, outbox, service worker |
| `src/ui/` | Plugin UI and shared React/Sass components |
| `src/cloudflare/` | Deployment/OAuth (plugin side) and `worker/` (API, D1 publication, R2, notifications) |
| `packages/server/` | Standalone local/Docker server around the Worker |
| `scripts/` | Build, release, dev and check tooling; `scripts/recovery/` is Python |
| `tests/` | Browser, visual and editor-contract suites |
| `docs/` | Design, protocol and operations docs; `docs-site/` and `site/` are the public sites |

The Worker stores data, serves the PWA/API and schedules notifications; it never decides sync plans. Keep reminder rules in shared modules so the plugin, PWA predictions and Worker mutations agree.

## Docs to read by task

- Boundaries: [architecture](docs/architecture.md)
- Sync: [sync pipeline](docs/sync-pipeline.md), [protocol](docs/protocol.md), [sync checkpoint recovery](docs/sync-checkpoint-recovery.md)
- API or compatibility: [Worker API](docs/worker-api.md), [compatibility](docs/compatibility.md), [server upgrades](docs/server-upgrades.md)
- Encryption: [e2ee implementation](docs/e2ee-implementation.md)
- UI: [UI styling](docs/ui-styling.md). Shared components render in Obsidian Shadow DOM and the PWA document; verify both
- PWA persistence: [storage recovery](docs/pwa-storage-recovery.md), [tab convergence](docs/pwa-tab-convergence.md)
- Reading: [reading highlights](docs/reading-highlights.md), [reading shortcuts](docs/reading-shortcuts.md)
- Deployment and releases: [deployment](docs/deployment.md), [releases](docs/releases.md), [self-hosting](docs/self-hosting.md)
- Choosing tests: [testing](docs/testing.md)
- Everything else: [documentation index](docs/README.md)

## Commands

Use npm with the Node version in `.nvmrc` and `package.json` `engines`. `package.json` scripts are the source of truth.

- `npm run dev` watches and installs builds into `test-vault/` (create it with `npm run vault:setup`)
- `npm run build` builds the Worker, type-checks and bundles the plugin into `dist/`
- `npm run lint`, `npm run typecheck`, `npm run typecheck:worker`, `npm run typecheck:service-worker`, `npm run deadcode`
- `npm test` or `npx vitest run <file>` for unit tests
- `npm run test:worker-runtime` for Worker behavior against local D1/R2/Durable Objects
- `npm run test:pwa-browser`, `npm run test:visual`, `npm run test:reading` for browser coverage
- `npm run check` for broad validation; `npm run release:check` is the full release gate

Match verification to the change. Add regression tests for meaningful behavior and failure modes, reproducing the failure through the real boundary (D1/R2 tests for publication guarantees). Documentation-only edits need a link and diff review, not the test suites. After checks pass, rerun only for new edits, failures or open risks. Never replace visual baselines just to make a comparison pass.

## Generated files

- After changing release manifest, wire or shortcut protocols, or transfer limits, run `node scripts/check-contract-docs.mjs --write` to refresh `docs/current-contract.md`.
- After changing dependencies, run `npm run notices:generate`.
- Server-side changes may need a server revision update; see [server upgrades](docs/server-upgrades.md) and `npm run check:server-revision`.

## Implementation rules

- Strict TypeScript. Prefer browser-compatible dependencies, keep bundles small and within `npm run size-check` budgets; runtime dependencies must be bundled into `main.js`.
- Shared plugin code must run on mobile: no Node or Electron APIs. Plugin file access stays inside the vault.
- Register commands with `this.addCommand(...)` and keep released command IDs. Give settings defaults and validation; await `loadData()` / `saveData()` where ordering matters.
- Use Obsidian `register*` helpers so reload and unload leak nothing.
- Keep startup light. Defer expensive work, batch vault access, debounce filesystem reactions, and avoid large in-memory structures.
- Preserve data-safety invariants: a successful request keeps byte, revision and operation-identity guarantees under response loss and retries; deletion requires verified absence; recovery retains local-only intent.
- Use sentence case and short UI copy. In instructions, **bold** literal UI labels, say "select" for interactions, and use arrows for navigation.
- Do not use em dashes in docs or comments.

## Privacy and security

- Local features work offline. Network access must serve a disclosed feature; cloud sync and any analytics are opt-in and documented in `README.md` and settings.
- Read, store or transmit only the vault data a consented feature needs. No hidden telemetry, deceptive UI, ads or spam notifications.
- Never execute fetched code or auto-update plugin code outside normal releases.
- Never commit secrets, `.env*`, `.dev.vars`, or real vault data. Use synthetic notes in tests and issues. `npm run security:check` runs the audit and secret scan.
- Follow Obsidian's [developer policies](https://docs.obsidian.md/Developer+policies) and [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines).

## Git and releases

- Use the `gh` CLI for GitHub operations.
- Commits are lowercase Conventional Commits: `<type>(<scope>): <description>`. Types: `fix`, `feat`, `chore`, `refactor`, `perf`, `build`, `ci`. Scope is optional; use `ios` or `android` only for platform-specific changes.
- No `Co-Authored-By` trailers or generated-by attribution in commits or PR descriptions.
- Keep PRs focused; describe behavior and recovery implications and what was actually tested.
- Never commit `node_modules/`, `dist/`, `.generated/`, `test-vault/`, `main.js`, signed `.shortcut` files, or other build output.
- Keep the plugin `id` stable and `minAppVersion` accurate for the APIs used.
- Releases go through `npm run release:prepare` per [releases](docs/releases.md): the tag equals the manifest version with no leading `v`, and `manifest.json`, `versions.json`, `main.js` and `styles.css` ship as release assets. A successful **Release plugin** run for the exact commit satisfies the automated gate, so do not repeat `release:check` just to duplicate CI.
