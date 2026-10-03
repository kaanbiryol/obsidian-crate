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
verification, and dispatches **Release plugin**. It waits for release verification
and prints the draft and workflow links. Publication remains an explicit maintainer
action after device and hosted acceptance.

Your current branch, staged changes and uncommitted files are preserved. The
version commit stays on the remote release branch; merge that commit into the
development branch before the next semantic bump, or supply the next explicit
version. Preparation does not include uncommitted source changes.

Preview the version changes without signing, committing, tagging or accessing
GitHub:

```sh
npm run release:prepare -- patch --dry-run
```

Add `--no-wait` to return after dispatching the release workflow. Preparation still
waits for an existing branch verification before dispatch, avoiding a duplicate
full test run. Existing local or remote tags resume their exact commit and are
never moved. Ordinary pushes refuse divergent branches and tags.

The private-fragment v2 assets are `save-to-crate-ios-27-v2.shortcut` and
`reading-shortcut-v2.json`. Shortcut metadata records the signed file's SHA-256 and the source fingerprint.
No file is selected by modification time, and stale files in the original checkout's
`dist/` are never used. Retries reuse an existing draft shortcut only after its tag,
source and checksum pass verification; `--resign` explicitly signs a replacement.

The workflow rejects missing shortcut assets, checksum mismatches, source drift,
and published releases. It selects a successful **Node.js build** push run from
this repository for the exact tag commit, with unexpired release artifacts.
Pull-request, fork, failed, cancelled and different-commit runs cannot substitute.
Without eligible artifacts it runs the complete verification suite.

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

Publishing triggers **Deploy GitHub Pages**. It selects the most recently published
release containing shortcut metadata, including prereleases, verifies the download,
and serves it at `shortcuts/v2/Save to Crate (iOS 27).shortcut`. It separately downloads the latest legacy artifact to preserve the v1 path for installed older servers. Publish a signed v2 release asset before shipping the encrypted Reading app; the Pages build fails closed if the v2 artifact is missing.
Plugin-only releases do not replace that selection. An incomplete or corrupted
shortcut release fails deployment instead of silently serving another version.

The first deployment using this flow needs a published release prepared this way.
Existing `0.3.0` has no shortcut metadata and is not modified automatically. Until
that first release is published, Pages fails with an explicit missing-release
message and the previously deployed site remains live. Publishing manually through
GitHub triggers Pages; if publishing via a workflow's `GITHUB_TOKEN`, explicitly
run **Deploy GitHub Pages**, because token-created events do not start another
workflow.
