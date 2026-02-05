# Obsidian R2 Sync — Minimal Open Source PRD (v1)

## 1. Goal

Build a minimal, usable sync solution for Obsidian vaults using Cloudflare R2.

This project is:
- Open source
- Not a hosted SaaS
- Users bring their own Cloudflare account + storage
- Focused on simplicity, reliability, and a great "getting started" experience

The product should feel like:

> "Run one command, paste one config into Obsidian, and sync works."

---

## 2. Target Users

- Obsidian users who want sync without subscriptions
- Technical users comfortable with BYO cloud accounts
- Users who want ownership and control over their data

---

## 3. Core User Experience

### Setup Flow (5 minutes)

1. User runs:

   `crate init`

2. The tool:
   - Guides them through connecting their Cloudflare account
   - Creates the required storage automatically
   - Outputs a single pasteable sync configuration

3. User opens Obsidian → Sync Plugin Settings
4. User pastes the configuration
5. Sync begins immediately

---

## 4. MVP Feature Set (v1)

### 4.1 File Sync (Must Have)

- Sync all vault files between:
  - Desktop Obsidian
  - Obsidian Mobile

- Support:
  - New files
  - File edits
  - File renames
  - Attachments (PDFs, images, etc.)

---

### 4.2 Conflict Safety (Must Have)

If two devices edit the same note before syncing:

- Do not overwrite silently
- Create a conflict copy automatically
- Preserve both versions

User should never lose data.

---

### 4.3 Delete Propagation (Must Have)

- Deleting a file on one device should delete it on others
- Deletions must sync reliably across devices

---

### 4.4 Basic Vault History (Minimal)

v1 should support "future version history" by design.

For MVP:
- Store previous file versions implicitly
- No UI for browsing history yet
- Restoring versions can come later

---

### 4.5 Minimal Ignore Rules

Avoid syncing unnecessary Obsidian noise:

- Workspace state files
- Temporary caches
- Other non-content metadata

Defaults should work out of the box.

---

## 5. CLI Product Requirements

### 5.1 `crate init`

This is the primary onboarding command.

It should:

- Create everything needed in the user's Cloudflare account
- Walk the user through credentials safely
- Output a single configuration blob

Success looks like:

> "Copy this into Obsidian → Sync is ready."

---

### 5.2 `crate doctor`

A debugging command for users:

- Verifies configuration
- Confirms connectivity
- Detects missing permissions or misconfigurations

---

## 6. Plugin Requirements (Obsidian)

### Settings UX

The plugin should support:

- Paste config once
- "Test connection" button
- Manual "Sync now"
- Show last sync time + device name

---

### Sync Behavior

- Desktop: sync continuously or on file change
- Mobile: sync periodically + manual sync button

Must be battery-conscious.

---

## 7. Non-Goals for v1 (Explicitly Out of Scope)

These should NOT block launch:

- Full UI version history browser
- End-to-end encryption (possible later)
- Real-time collaboration
- Server-side database or hosted coordination layer
- Multi-user vault sharing
- Advanced performance optimizations

---

## 8. Design Principles

- Minimal, boring, reliable
- No subscriptions, no accounts, no vendor lock-in
- Users own their storage
- Sync must never lose data
- Conflicts are acceptable, silent overwrite is not
- Setup should feel like "one command + one paste"

---

## 9. Success Criteria

v1 is successful if:

- Users can sync a vault between phone + laptop reliably
- Setup takes under 5 minutes
- Conflicts are handled safely
- Community can build on it for:
  - Encryption
  - Better history UI
  - Sharing
  - Faster sync

---

## 10. Future Extensions (v2+)

- Browsable version history + restore
- Client-side encryption
- Better attachment chunking
- Multiple vault support
- Sharing + collaboration modes
- Optional coordination via Workers/Durable Objects

---

## Deliverable

A minimal open-source sync system with:

- CLI initializer (`crate init`)
- Obsidian plugin configuration
- Reliable cross-device sync
- Conflict-safe behavior
- Strong foundation for future growth
