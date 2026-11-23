import { useState } from 'react';
import type { PendingReading } from './outbox';

/** `pending` plus the changes that have left it since `base` was read. A sync confirms a change
 * and drops it from `pending` before the open article's copy is read again, so without these the
 * article would show its old value until then. A new `base` has caught up and starts again. */
export function useHeldPending<T>(base: T, pending: PendingReading[]): PendingReading[] {
	const [held, setHeld] = useState({ base, ops: pending });
	const caughtUp = held.base !== base;
	if (caughtUp || pending.some(op => !held.ops.includes(op))) {
		// React renders again before committing, so this render's value is never shown.
		setHeld({ base, ops: caughtUp ? pending : heldOps(held.ops, pending) });
	}
	return held.ops;
}

/** Settled changes first, in the order they were queued, then the queue as it is now. */
function heldOps(previous: PendingReading[], pending: PendingReading[]): PendingReading[] {
	const queued = new Set(pending.map(op => op.id));
	return [...previous.filter(op => !queued.has(op.id)), ...pending];
}
