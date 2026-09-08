# Confirmed reminder changes across browser tabs

Open tabs with the same server origin, authenticated session and exact reminders folder receive confirmed creations, edits, completions, deletions and reorders. Web Locks serialize pending commands. The sending tab publishes the confirmed result before removing its durable command, so peers replace their optimistic state with that result even while an earlier list request is delayed.

Results carry their previous reminder revision or project order. A delayed confirmation cannot overwrite a newer confirmed base. Peers invalidate older reads and request a current list after confirmation; observing an external command removal also triggers a fresh read if the confirmation event was missed. Pending edits and editor drafts retain their existing recovery behavior.

The confirmation uses a transient local-storage entry scoped by a session-token hash and folder. It is removed immediately after publication, and explicit sign-out clears its private namespace. It introduces no external service or server endpoint. If browser storage fails during publication, the exact pending command and operation ID remain available for a safe receipt retry.

The release browser gate exercises the built application in Chromium and WebKit with three tabs, native storage and Web Locks, either tab selected as sender, deliberately delayed list responses, and a missed confirmation event. HTTP mutation responses use the preview's receipt implementation; these tests do not claim hosted concurrency or physical mobile acceptance. Pure settlement/outbox tests separately check scope isolation, malformed packets, stale revisions/orders, and failed confirmation publication.
