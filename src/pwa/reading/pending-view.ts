import { readingHighlights } from '@/reading/core/highlights';
import { readingUrlIdentity, type ReadingChanges, type ReadingItem } from '@/reading/core/model';
import type { PendingReading } from './storage';

/** Keep durable local edits visible while a confirmed library refresh is in flight. */
export function presentReadingItems(items: ReadingItem[], pending: PendingReading[]): ReadingItem[] {
	if (!pending.length) return items;
	const visible = [...items];
	const urls = new Set(items.filter(item => item.source_url).map(item => readingUrlIdentity(item.source_url)));
	const changesById = new Map<string, ReadingChanges & Pick<Partial<ReadingItem>, 'extraction_status' | 'highlight_format'>>();
	for (const op of pending) {
		if (op.review) continue;
		if (op.action === 'capture') {
			try {
				const url = readingUrlIdentity(String(op.intent.url));
				if (urls.has(url)) continue;
				urls.add(url);
				visible.push({ crate_reading_version: 1, crate_reading_id: op.id, source_url: url,
					title: typeof op.intent.title === 'string' && op.intent.title.trim() ? op.intent.title.trim() : new URL(url).hostname,
					saved_at: op.queuedAt ?? new Date(0).toISOString(), path: '', capture_method: 'url',
					reading_status: 'inbox', favorite: false, tags: [], extraction_status: 'pending' });
			} catch { /* Invalid recovery data must not become a library item. */ }
			continue;
		}
		if (typeof op.intent.id !== 'string') continue;
		if (op.action === 'retry') {
			changesById.set(op.intent.id, { ...changesById.get(op.intent.id), extraction_status: 'pending' });
			continue;
		}
		const raw = op.intent.changes;
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
		const value = raw as Record<string, unknown>;
		const changes: ReadingChanges & Pick<Partial<ReadingItem>, 'highlight_format'> = {};
		if (value.highlights !== undefined) {
			changes.highlights = readingHighlights(value.highlights);
			changes.highlight_format = 'markdown-v1';
		}
		if (typeof value.favorite === 'boolean') changes.favorite = value.favorite;
		if (value.reading_status === 'inbox' || value.reading_status === 'archived') changes.reading_status = value.reading_status;
		if (Array.isArray(value.tags) && value.tags.every(tag => typeof tag === 'string')) changes.tags = value.tags;
		if (Object.keys(changes).length) changesById.set(op.intent.id, { ...changesById.get(op.intent.id), ...changes });
	}
	if (!changesById.size) return visible;
	return visible.map(item => {
		const changes = changesById.get(item.crate_reading_id);
		return changes ? { ...item, ...changes } : item;
	});
}
