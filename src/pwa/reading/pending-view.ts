import { readingHighlights } from '@/reading/core/highlights';
import { readingUrlIdentity, type ReadingChanges, type ReadingItem } from '@/reading/core/model';
import type { PendingReading } from './outbox';

/** Keep durable local edits visible while a confirmed library refresh is in flight. */
export function presentReadingItems(items: ReadingItem[], pending: PendingReading[]): ReadingItem[] {
	if (!pending.length) return items;
	const visible = [...items];
	const urls = new Set(items.filter(item => item.source_url).map(item => readingUrlIdentity(item.source_url)));
	const changesById = new Map<string, ReadingChanges & Pick<Partial<ReadingItem>, 'extraction_status' | 'highlight_format'>>();
	const deleted = new Set<string>();
	for (const op of pending) {
		if (op.review) continue;
		if (op.action === 'capture') {
			try {
				const url = readingUrlIdentity(op.intent.url);
				if (urls.has(url)) continue;
				urls.add(url);
				visible.push({ crate_reading_version: 1, crate_reading_id: op.id, source_url: url,
					title: typeof op.intent.title === 'string' && op.intent.title.trim() ? op.intent.title.trim() : new URL(url).hostname,
					saved_at: op.queuedAt ?? new Date(0).toISOString(), path: '', capture_method: 'url',
					reading_status: 'inbox', favorite: false, tags: [], extraction_status: 'pending' });
			} catch { /* Invalid recovery data must not become a library item. */ }
			continue;
		}
		if (op.action === 'delete') {
			deleted.add(op.intent.id);
			continue;
		}
		if (op.action === 'retry') {
			changesById.set(op.intent.id, { ...changesById.get(op.intent.id), extraction_status: 'pending' });
			continue;
		}
		const changes: ReadingChanges & Pick<Partial<ReadingItem>, 'highlight_format'> = { ...op.intent.changes };
		if (changes.highlights !== undefined) {
			changes.highlights = readingHighlights(changes.highlights);
			changes.highlight_format = 'markdown-v1';
		}
		if (Object.keys(changes).length) changesById.set(op.intent.id, { ...changesById.get(op.intent.id), ...changes });
	}
	const present = deleted.size ? visible.filter(item => !deleted.has(item.crate_reading_id)) : visible;
	if (!changesById.size) return present;
	return present.map(item => {
		const changes = changesById.get(item.crate_reading_id);
		return changes ? { ...item, ...changes } : item;
	});
}

/** Items that take no edits yet. Ordinary edits remain usable while sending, but new links
 * need their server ID, and rejected changes or text extraction need settlement first. */
export function blockedReadingItemIds(items: readonly ReadingItem[], pending: readonly PendingReading[]): Set<string> {
	const blocked = new Set(items.filter(item => !item.path).map(item => item.crate_reading_id));
	for (const op of pending) {
		if (op.action === 'capture') blocked.add(op.id);
		else if ((op.review || op.action === 'retry') && typeof op.intent.id === 'string') blocked.add(op.intent.id);
	}
	return blocked;
}
