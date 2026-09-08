# Security policy

## Supported versions

Security fixes are provided for the latest published Crate version. Upgrade the Obsidian plugin and authorize any accompanying Worker update before reporting an issue that may already be fixed.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/kaanbiryol/obsidian-crate/security/advisories/new). Do not open a public issue for a suspected vulnerability.

Include the affected Crate version, Obsidian and operating-system versions, the relevant component, reproduction steps, and the impact. Redact vault contents and personal information. Never include Cloudflare OAuth codes, access tokens, device credentials, enrollment links, push subscription keys, or unredacted Worker logs.

You should receive an acknowledgment within seven days. Please allow time for investigation and a coordinated fix before publishing details.

## Engineering controls

GitHub Actions are pinned to commit SHAs. Build jobs have read-only repository access without persisted checkout credentials; release/Pages publication runs in separate jobs. `npm run security:check` runs `npm audit --audit-level=low --include=dev` and verifies the pinned Gitleaks binary before scanning all fetched Git history plus current source, with redacted output. Shallow history is rejected. This security gate is required by `release:check` and the Pages build before either publication job can run. An unavailable registry or scanner fails the gate. Local environment/credential files are ignored. Regenerated third-party notices are also checked by the release gate.

Dependabot proposes npm and GitHub Actions updates through the checked-in configuration; updates require review and passing checks. Repository-level security alerts, private reporting and required branch checks must be enabled by a maintainer and are part of the release acceptance record.

Reminder sessions are folder-bound and cannot administer the deployment. Push endpoints are restricted to supported provider hosts; redirects are rejected, delivery has a deadline, and ownership, subscription caps, and rate limits are enforced in D1. Mutation diagnostics use request/session/operation IDs and opaque file revisions without note contents or filenames. Paired archives contain sensitive source data and keys; follow [the recovery runbook](docs/recovery.md).
