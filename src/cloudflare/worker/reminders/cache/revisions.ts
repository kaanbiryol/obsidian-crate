import { reminderRevision } from '@/reminders/core/reminderRevision';
import { isSha256Hex } from '../../../../platform/validation';
import type { RemoteReminderRecord } from '../types';

// Each listed reminder carries a SHA-256 revision, which costs more than the rest of a
// full list. Cache rows store it beside the reminder; loading moves it here, keyed by the
// loaded record, so it never travels with a copy that may have changed.
const revisions = new WeakMap<RemoteReminderRecord, string>();

/** The revision stored with a cached reminder, when its row had one. */
export const storedReminderRevision = (reminder: RemoteReminderRecord): string | undefined => revisions.get(reminder);

/** A cached reminder without its stored revision, which is remembered for this record. */
export function takeStoredRevision(value: RemoteReminderRecord & { revision?: unknown }): RemoteReminderRecord {
	if (!('revision' in value)) return value;
	const { revision, ...reminder } = value;
	if (isSha256Hex(revision)) revisions.set(reminder, revision);
	return reminder;
}

/** The record as a cache row stores it, with its revision. */
export async function withRevision(reminder: RemoteReminderRecord): Promise<RemoteReminderRecord & { revision: string }> {
	let revision = revisions.get(reminder);
	if (!revision) revisions.set(reminder, revision = await reminderRevision(reminder));
	return { ...reminder, revision };
}
