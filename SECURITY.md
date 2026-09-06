# Security policy

## Supported versions

Security fixes are provided for the latest published Crate version. Upgrade the Obsidian plugin and authorize any accompanying Worker update before reporting an issue that may already be fixed.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/kaanbiryol/obsidian-crate/security/advisories/new). Do not open a public issue for a suspected vulnerability.

Include the affected Crate version, Obsidian and operating-system versions, the relevant component, reproduction steps, and the impact. Redact vault contents and personal information. Never include Cloudflare OAuth codes, access tokens, device credentials, enrollment links, push subscription keys, or unredacted Worker logs.

You should receive an acknowledgment within seven days. Please allow time for investigation and a coordinated fix before publishing details.

## Engineering controls

GitHub Actions are pinned to commit SHAs. Build jobs have read-only repository access; release/Pages publication runs in separate jobs. `npm run security:secrets` verifies the pinned Gitleaks binary and scans Git history plus the current worktree, with redacted output. Local environment/credential files are ignored. `npm audit` and regenerated third-party notices are release checks.

Reminder sessions are folder-bound and cannot administer the deployment. Push endpoints are restricted to supported provider hosts; redirects are rejected, delivery has a deadline, and ownership, subscription caps, and rate limits are enforced in D1. Mutation diagnostics use request/session/operation IDs and opaque file revisions without note contents or filenames. Paired archives contain sensitive source data and keys; follow [the recovery runbook](docs/recovery.md).
