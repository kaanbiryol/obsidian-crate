import type { ReadingChanges, ReadingItem } from '@/reading/core/model';
import type { PendingReading } from './storage';

/** Keep durable local edits visible while a confirmed library refresh is in flight. */
export function presentReadingItems(items: ReadingItem[], pending: PendingReading[]): ReadingItem[] {
	const changesById = new Map<string, ReadingChanges>();
	for (const op of pending) {
		if (op.action !== 'update' || op.review || typeof op.intent.id !== 'string') continue;
		const raw = op.intent.changes;
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
		const value = raw as Record<string, unknown>;
		const changes: ReadingChanges = {};
		if (typeof value.favorite === 'boolean') changes.favorite = value.favorite;
		if (value.reading_status === 'inbox' || value.reading_status === 'archived') changes.reading_status = value.reading_status;
		if (Array.isArray(value.tags) && value.tags.every(tag => typeof tag === 'string')) changes.tags = value.tags;
		if (Object.keys(changes).length) changesById.set(op.intent.id, { ...changesById.get(op.intent.id), ...changes });
	}
	if (!changesById.size) return items;
	return items.map(item => {
		const changes = changesById.get(item.crate_reading_id);
		return changes ? { ...item, ...changes } : item;
	});
}
