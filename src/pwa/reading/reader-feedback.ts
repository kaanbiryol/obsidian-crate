import type { ReadingHighlight } from '@/reading/core/highlights';
import type { ReadingChanges, ReadingItem } from '@/reading/core/model';
import type { SyncIndicatorState } from '@/ui/shared/SyncIndicator';
import { readingSyncStatus } from '../sync/reading-status';
import type { ToastKind } from '../types';
import type { PendingReading } from './outbox';
import { presentReadingItems } from './pending-view';

/** Outbox work that belongs to one open article, including its own pending capture. */
export function readingItemPending(pending: PendingReading[], id: string): PendingReading[] {
	return pending.filter(op => op.action === 'capture' ? op.id === id : op.intent.id === id);
}

/** The article header reports only its own changes; app-wide refreshes stay in the app header. */
export function readingItemSyncStatus(pending: PendingReading[], id: string, isOffline: boolean): { state: SyncIndicatorState; label: string } {
	const own = readingItemPending(pending, id);
	if (!own.length) return { state: 'synced', label: 'All changes synced' };
	return readingSyncStatus({ pending: own, isOffline, loading: false, refreshing: false, confirmed: true, error: null, recovery: false });
}

const sameRange = (a: ReadingHighlight, b: ReadingHighlight) => a.start === b.start && a.end === b.end && a.text === b.text;

/** Passages shown from local intent that the confirmed article does not have yet. */
export function pendingReadingHighlights(confirmed: ReadingItem, pending: PendingReading[]): ReadingHighlight[] {
	if (!readingItemPending(pending, confirmed.crate_reading_id).some(op => op.action === 'update' && op.intent.changes.highlights !== undefined)) return [];
	const saved = confirmed.highlights ?? [];
	const shown = presentReadingItems([confirmed], pending)[0]?.highlights ?? [];
	return shown.filter(highlight => !saved.some(existing => sameRange(existing, highlight)));
}

export interface ReaderToast { kind: ToastKind; message: string; action?: 'undo' | 'retry' | 'review' }

/** Feedback once a reader change is stored on this device. Most changes stay silent. */
export function readingUpdateFeedback(previous: ReadingItem, changes: ReadingChanges, offline: boolean): ReaderToast | null {
	if (changes.reading_status === 'archived' && previous.reading_status !== 'archived') {
		return { kind: 'success', message: offline ? 'Archived on this device' : 'Archived', action: 'undo' };
	}
	// Notes and deletions keep their own feedback; only a new or resized passage is announced.
	if (offline && changes.highlights?.some(highlight => !(previous.highlights ?? []).some(existing => sameRange(existing, highlight)))) {
		return { kind: 'info', message: 'Highlight saved on this device' };
	}
	return null;
}

/** A change that needs the user: a definite rejection, or retries that ran out. */
export function readingFailureFeedback(op: PendingReading): ReaderToast {
	const action = op.review ? 'review' : 'retry';
	if (op.action !== 'update') return { kind: 'error', message: 'Change didn’t sync', action };
	const { changes } = op.intent;
	if (changes.highlights !== undefined) return { kind: 'error', message: 'Highlight didn’t sync', action };
	if (changes.reading_status !== undefined) return { kind: 'error', message: changes.reading_status === 'archived' ? 'Couldn’t archive' : 'Couldn’t move to inbox', action };
	if (changes.favorite !== undefined) return { kind: 'error', message: changes.favorite ? 'Couldn’t favorite' : 'Couldn’t remove favorite', action };
	if (changes.tags !== undefined) return { kind: 'error', message: 'Tags didn’t sync', action };
	return { kind: 'error', message: 'Change didn’t sync', action };
}
