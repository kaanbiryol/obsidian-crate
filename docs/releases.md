# Preparing a plugin release

Plugin assets and the public iPhone shortcut share one GitHub release. The shortcut
is signed on a maintainer's Mac using its existing iCloud login. Apple credentials
are never sent to GitHub Actions. Generated binaries stay out of Git.

## Prepare a draft with one command

Commit the intended source changes first, including the release tooling and
workflows. Use the Node.js version in `.nvmrc`, sign in to iCloud on macOS 27 or
later, and authenticate `gh` with repository, releases and Actions access.

Prepare the next patch release:

```sh
npm run release:prepare -- patch
```

Use `minor`, `major`, or an explicit version such as `0.4.2` instead of `patch`.
The command takes committed HEAD into an isolated checkout, updates all four
version files, commits them as `chore: release <version>`, and signs the pairing
shortcut. It pushes the version commit to `release/<version>` and a tag exactly
matching the manifest, uploads the signed shortcut to a draft, waits for branch
verification (unless a version-only parent build can be reused), and dispatches **Release plugin**. It waits for release verification
and prints the draft and workflow links. Publication remains an explicit maintainer
action after device and hosted acceptance.

Your current branch, staged changes and uncommitted files are preserved. The
version commit stays on the remote release branch until you merge it after
publishing (see [Test and publish](#test-and-publish)). Preparation does not
include uncommitted source changes.

Preview the version changes without signing, committing, tagging or accessing
GitHub:

```sh
npm run release:prepare -- patch --dry-run
```

Add `--no-wait` to return after dispatching the release workflow. Preparation still
waits for an existing branch verification before dispatch, avoiding a duplicate
full test run. Existing local or remote tags resume their exact commit and are
never moved. Ordinary pushes refuse divergent branches and tags.

The v1 shortcut assets are `save-to-crate-ios-27-v1.shortcut` and
`reading-shortcut-v1.json`. Shortcut metadata records the signed file's SHA-256 and the source fingerprint.
No file is selected by modification time, and stale files in the original checkout's
`dist/` are never used. Retries reuse an existing draft shortcut only after its tag,
source and checksum pass verification; `--resign` explicitly signs a replacement.

The workflow rejects missing shortcut assets, checksum mismatches, source drift,
and published releases. It selects a successful **Node.js build** push run from
this repository for the exact tag commit, with unexpired release artifacts.
Pull-request, fork, failed, cancelled and different-commit runs cannot substitute.
When the release commit only bumps the version over a commit that already passed a
push build, such as a green `master`, it reuses that parent run for the browser,
Worker and Docker tests instead. The source checks, plugin build and reproducible
rebuild still run on the release commit, and preparation dispatches **Release
plugin** without waiting for the release branch's own push build. Without either
run it runs the complete verification suite.

For the fastest release, prepare it from a commit whose push build already passed.
Push builds run only for `master` and `release/**`, so that is usually a green `master`
commit; other branches are verified through their pull requests.

Reused assets retain their original candidate record, commit, workflow identity,
toolchain and checksums. Security and server-revision checks run again, the current
Worker/PWA and source metadata must match, and a separate clean-install build must
reproduce the plugin, CSS and server artifacts. That rebuild starts as soon as
source artifacts are ready, alongside remaining tests. Plugin provenance covers
the distributable assets. CI does not claim to have signed the local shortcut.

A successful **Release plugin** run for the exact commit satisfies the automated
release gate. Use focused checks during development; a second local
`release:check` is unnecessary after CI has passed. The full local command remains
available for reproducing the suite. See [testing](testing.md#release-verification).

To test artifact reuse and reproducibility in CI without preparing a draft, dispatch
**Node.js build** on the same branch, with `release-tag` set to the manifest version
and `reuse-run-id` set to its successful push run. This verification-only workflow
has read permissions and does not sign, tag, upload release assets or publish.

A failed upload or dispatch leaves a draft, not a public release. Rerun the command
with the explicit version to resume. On failures the command prints and retains
its isolated checkout for recovery; successful checkouts are removed. Do not run
preparation concurrently for the same version. If only CI failed, rerun its failed
jobs without signing again, then resume preparation. Published releases cannot be
changed by this command. Tag pushes alone do not start **Release plugin**.

## Test and publish

Wait for **Release plugin** to succeed. Download the exact shortcut from the draft
and test import, pairing, and saving on iOS 27 or later. Complete the plugin's
[release acceptance checks](testing.md#public-release-acceptance) against its draft
assets. Publish the draft through GitHub only after those checks pass. This remains
an explicit maintainer action; preparing the release does not publish it.

Right after publishing, merge `release/<version>` into `master`. Obsidian reads
`manifest.json` from the default branch to list the plugin version and offer
updates, so a published release stays invisible to users until that merge. The
merge also lets the next `release:prepare` bump from the published version. For a
community catalog release, publish a regular release rather than a pre-release;
the website changelog marks pre-releases as beta.

Replace the draft's generated notes with a summary for users before publishing.
The notes become the release's entry on the website changelog at `/changelog/`.
Write them in Markdown; raw HTML is shown as text, and images appear as links.
The trailing **Full changelog** line becomes a compare link. A release published
without other notes shows "No notes were written for this release."

Publishing triggers **Deploy GitHub Pages**, which builds the published tag.
Website-related pushes to `master` only validate the build. Publication compares
the complete built website against the last successful deployment and skips
unchanged content; new shortcut bytes count as a change. A manual workflow run
without `release_tag` force-deploys `master` for independent website fixes.

The website build selects the most recently published
release containing shortcut metadata, including prereleases, verifies the download,
and serves it at `shortcuts/v1/Save to Crate.shortcut`.
Plugin-only releases do not replace that selection. An incomplete or corrupted
shortcut release fails deployment instead of silently serving another version.

The same build regenerates `changelog/index.html` from every published release,
newest first, with `scripts/build-changelog.mjs`. Editing notes after publication
does not deploy on its own; dispatch **Deploy GitHub Pages** with `release_tag`
set to the latest published tag to refresh the page.

Until a v1 shortcut release is published, Pages generates an unavailable install
page with a manual-save alternative. Existing releases without shortcut metadata
are not modified automatically. Publishing manually through
GitHub triggers Pages; if publishing via a workflow's `GITHUB_TOKEN`, explicitly
dispatch **Deploy GitHub Pages** with `release_tag` set to the published tag,
because token-created release events do not start another workflow.
