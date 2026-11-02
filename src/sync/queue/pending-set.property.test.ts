import { expect, it } from 'vitest';
import fc from 'fast-check';
import { pendingChangeKey } from '../pending/pending-change';
import { PendingSet } from './pending-set';

type Step =
	| { op: 'add'; kind: 'upload' | 'delete'; path: string }
	| { op: 'snapshot' }
	| { op: 'settle'; path: string; kind: 'upload' | 'delete' }
	| { op: 'take' }
	| { op: 'release'; requeue: boolean };

const path = fc.constantFrom('a.md', 'b.md', 'c.md');
const kind = fc.constantFrom<'upload' | 'delete'>('upload', 'delete');
const step: fc.Arbitrary<Step> = fc.oneof(
	fc.record({ op: fc.constant('add' as const), kind, path }),
	fc.constant({ op: 'snapshot' as const }),
	fc.record({ op: fc.constant('settle' as const), kind, path }),
	fc.constant({ op: 'take' as const }),
	fc.record({ op: fc.constant('release' as const), requeue: fc.boolean() }),
);

it('never settles a key an event changed after the snapshot or batch that tried to settle it', () => {
	fc.assert(fc.property(fc.array(step, { maxLength: 40 }), steps => {
		const pending = new PendingSet();
		let snapshot: ReadonlyMap<string, number> = new Map();
		const batches: Array<ReturnType<PendingSet['takeBatch']>> = [];
		// Keys with an event since the latest snapshot.
		const changedSinceSnapshot = new Set<string>();
		for (const [index, current] of steps.entries()) {
			if (current.op === 'add') {
				const { key, opposite } = pending.add(current, index);
				changedSinceSnapshot.add(key);
				expect(pending.queuedKeys().has(key)).toBe(true);
				expect(pending.queuedKeys().has(opposite)).toBe(false);
			} else if (current.op === 'snapshot') {
				snapshot = pending.snapshotRevisions();
				changedSinceSnapshot.clear();
			} else if (current.op === 'settle') {
				const key = pendingChangeKey(current.kind, current.path);
				const wasQueued = pending.queuedKeys().has(key);
				pending.settleIfUnchanged(key, snapshot);
				if (wasQueued && changedSinceSnapshot.has(key)) expect(pending.queuedKeys().has(key)).toBe(true);
			} else if (current.op === 'take') {
				const batch = pending.takeBatch(() => true);
				for (const key of batch.paths) {
					expect(pending.queuedKeys().has(key)).toBe(false);
					expect(pending.has(key)).toBe(true);
				}
				batches.push(batch);
			} else {
				const batch = batches.shift();
				if (!batch) continue;
				if (current.requeue) batch.requeue(batch.paths);
				batch.release();
				// A second release must not drop ownership a later batch holds.
				batch.release();
				if (current.requeue) for (const key of batch.paths) expect(pending.queuedKeys().has(key)).toBe(true);
			}
			expect(pending.count()).toBe(pending.keys().length);
			for (const key of pending.queuedKeys()) expect(pending.has(key)).toBe(true);
		}
	}));
});

it('restores a saved key only when no live event queued its path', () => {
	const pending = new PendingSet();
	pending.add({ kind: 'delete', path: 'a.md' }, 0);
	expect(pending.restore(pendingChangeKey('upload', 'a.md'))).toBe(false);
	expect(pending.restore(pendingChangeKey('upload', 'b.md'))).toBe(true);
	expect([...pending.queuedKeys()]).toEqual([pendingChangeKey('delete', 'a.md'), pendingChangeKey('upload', 'b.md')]);
	expect(pending.timesOf(pendingChangeKey('upload', 'b.md'))).toBeUndefined();
});
