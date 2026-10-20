/** Browser storage namespaces for unsent reminder work. Encryption, attempt
 * cleanup and logout match these, so the formats live in one place. */
export const REMINDER_OUTBOX_PREFIX = 'crate-reminder-outbox:';
export const REMINDER_DRAFT_PREFIX = 'crate-reminder-draft:';
/** Serializes outbox mutations across tabs. */
export const REMINDER_OUTBOX_LOCK = 'crate-reminder-outbox';
