import { useState } from 'react';
import { readingUrlIdentity, type ReadingItem } from '@/reading/core/model';

/** The open article's identity for the reader. A pending link has a queued ID until its note is
 * saved; the saved note is the same article, so the reader keeps its place, sheets and video. */
export function useReaderArticleKey(item: ReadingItem | undefined): string | undefined {
	const [shown, setShown] = useState(item && { item, key: item.crate_reading_id });
	if (!item) {
		if (shown) setShown(undefined);
		return undefined;
	}
	if (shown?.item.crate_reading_id === item.crate_reading_id) return shown.key;
	const key = shown && savedFromPending(shown.item, item) ? shown.key : item.crate_reading_id;
	setShown({ item, key });
	return key;
}

function savedFromPending(pending: ReadingItem, saved: ReadingItem): boolean {
	if (pending.path || !pending.source_url || !saved.source_url) return false;
	try { return readingUrlIdentity(pending.source_url) === readingUrlIdentity(saved.source_url); } catch { return false; }
}
