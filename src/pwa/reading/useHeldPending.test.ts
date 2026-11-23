import { expect, it } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import type { PendingReading } from './outbox';
import { useHeldPending } from './useHeldPending';

const favorite: PendingReading = { action: 'update', id: 'favorite', sessionId: 'session', intent: { id: 'article', before: { favorite: false }, changes: { favorite: true } } };
const tags: PendingReading = { action: 'update', id: 'tags', sessionId: 'session', intent: { id: 'article', before: { tags: [] }, changes: { tags: ['work'] } } };

it('keeps a confirmed change until the open article is read again', () => {
	let base = { id: 'article' }, pending: PendingReading[] = [favorite];
	const hook = renderHook(() => useHeldPending(base, pending));
	expect(hook.current).toEqual([favorite]);
	// Before: confirming the change dropped it while the reader still held the old copy, so the star flipped back.
	pending = [tags];
	hook.rerender();
	expect(hook.current).toEqual([favorite, tags]);
	// The article read after the sync already has the change.
	base = { id: 'article' };
	hook.rerender();
	expect(hook.current).toEqual([tags]);
});

it('shows the newest copy of a change still queued', () => {
	const failed = { ...favorite, error: 'Offline' };
	let pending: PendingReading[] = [favorite];
	const hook = renderHook(() => useHeldPending('article', pending));
	pending = [failed];
	hook.rerender();
	expect(hook.current).toEqual([failed]);
});
