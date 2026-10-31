import { useEffect, useRef } from 'react';
import type { ReadingChanges, ReadingItem } from '@/reading/core/model';
import type { ShowToast, ToastAction } from '../types';
import { readingNeedsAttention, type PendingReading } from './outbox';
import { readingFailureFeedback, readingItemPending, readingUpdateFeedback, type ReaderToast } from './reader-feedback';

interface ReaderSyncFeedbackOptions {
	itemId: string | undefined;
	pending: PendingReading[];
	showToast: ShowToast;
	/** Marks an operation announced, so the app-wide failure toast skips it. */
	claimFailure: (id: string) => boolean;
	retry: () => void;
	review: () => void;
	update: (item: ReadingItem, changes: ReadingChanges) => Promise<void>;
	/** The latest presented item, so Undo starts from the current local value. */
	current: (id: string) => ReadingItem | undefined;
}

/** Point-of-action feedback for the open article. Success stays silent apart from archive. */
export function useReaderSyncFeedback({ itemId, pending, showToast, claimFailure, retry, review, update, current }: ReaderSyncFeedbackOptions) {
	const latest = useRef({ showToast, retry, review, update, current });
	useEffect(() => { latest.current = { showToast, retry, review, update, current }; });
	const show = (toast: ReaderToast, undo?: ToastAction['onSelect']) => {
		const { retry, review } = latest.current;
		const action: ToastAction | undefined = toast.action === 'undo' && undo ? { label: 'Undo', onSelect: undo }
			: toast.action === 'retry' ? { label: 'Retry', onSelect: retry }
				: toast.action === 'review' ? { label: 'Review', onSelect: review } : undefined;
		latest.current.showToast(toast.kind, toast.message, undefined, action);
	};
	useEffect(() => {
		if (!itemId || document.visibilityState === 'hidden') return;
		const failed = readingItemPending(pending, itemId).filter(readingNeedsAttention).filter(op => claimFailure(op.id));
		// Dependent edits fail with their predecessor; describe the first change.
		if (failed[0]) show(readingFailureFeedback(failed[0]));
	}, [itemId, pending, claimFailure]);

	return async (item: ReadingItem, changes: ReadingChanges) => {
		await update(item, changes);
		const toast = readingUpdateFeedback(item, changes, !navigator.onLine);
		if (!toast) return;
		show(toast, () => {
			const { current, update } = latest.current;
			const restored = current(item.crate_reading_id);
			if (restored?.reading_status === 'archived') void update(restored, { reading_status: 'inbox' }).catch(() => { /* The mutation path already shows its error. */ });
		});
	};
}
