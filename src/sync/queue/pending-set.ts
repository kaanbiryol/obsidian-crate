import { decodePendingChange, pendingChangeKey, type PendingChange } from '../pending/pending-change';
import type { QueueFlushBatch } from './flush';

/** The queue's pending keys, the keys a flush holds, and each key's revision. Every
 * event gives its key a new revision, so a flush or check that read an older one
 * settles nothing a newer event still needs. */
export class PendingSet {
	private readonly queued = new Set<string>();
	private readonly inFlight = new Set<string>();
	private readonly revisions = new Map<string, number>();
	private readonly times = new Map<string, { first: number; last: number }>();
	private nextRevision = 0;

	/** Pending and in-flight keys. */
	keys(): string[] {
		return Array.from(new Set([...this.queued, ...this.inFlight]));
	}

	/** `keys().includes(key)` without copying. */
	has(key: string): boolean {
		return this.queued.has(key) || this.inFlight.has(key);
	}

	/** `keys().length` without copying. */
	count(): number {
		let count = this.queued.size;
		for (const key of this.inFlight) if (!this.queued.has(key)) count++;
		return count;
	}

	/** Keys waiting for a flush, excluding those only in flight. */
	queuedKeys(): ReadonlySet<string> {
		return this.queued;
	}

	get queuedCount(): number {
		return this.queued.size;
	}

	/** When an event for `key` first and last arrived since it was last flushed. */
	timesOf(key: string): { first: number; last: number } | undefined {
		return this.times.get(key);
	}

	/** Records a new revision for the change and drops the opposite operation for its
	 * path. `changed` says whether the pending set changed. */
	add(change: PendingChange, now: number): { key: string; opposite: string; changed: boolean } {
		const key = pendingChangeKey(change.kind, change.path);
		const opposite = pendingChangeKey(change.kind === 'delete' ? 'upload' : 'delete', change.path);
		const changed = this.queued.delete(opposite) || !this.queued.has(key);
		this.revisions.delete(opposite);
		this.times.delete(opposite);
		this.queued.add(key);
		this.times.set(key, { first: this.times.get(key)?.first ?? now, last: now });
		this.revisions.set(key, ++this.nextRevision);
		return { key, opposite, changed };
	}

	/** Restores a saved key unless a live event already queued its path. */
	restore(key: string): boolean {
		const path = decodePendingChange(key).path;
		if (this.queued.has(pendingChangeKey('upload', path)) || this.queued.has(pendingChangeKey('delete', path))) return false;
		this.queued.add(key);
		this.revisions.set(key, ++this.nextRevision);
		return true;
	}

	snapshotRevisions(): ReadonlyMap<string, number> {
		return new Map(this.revisions);
	}

	/** Whether `key` is still queued, not in flight, at the revision in `snapshot`. */
	isUnchangedSince(key: string, snapshot: ReadonlyMap<string, number>): boolean {
		return this.queued.has(key) && !this.inFlight.has(key) && this.revisions.get(key) === snapshot.get(key);
	}

	/** Settles `key` unless a newer event arrived after `snapshot` was taken. */
	settleIfUnchanged(key: string, snapshot: ReadonlyMap<string, number>): void {
		if (this.revisions.get(key) !== snapshot.get(key)) return;
		this.queued.delete(key);
		this.revisions.delete(key);
		this.times.delete(key);
	}

	/** Moves every queued key `ready` accepts into flight. */
	takeBatch(ready: (key: string) => boolean): QueueFlushBatch {
		const paths = [...this.queued].filter(ready);
		const revisions = new Map(paths.map(path => [path, this.revisions.get(path)]));
		for (const path of paths) {
			this.queued.delete(path);
			this.times.delete(path);
			this.inFlight.add(path);
		}
		let released = false;
		return {
			paths,
			requeue: keys => { for (const key of keys) this.queued.add(key); },
			release: () => {
				// Reporting can outlive this batch and overlap a later flush of the
				// same path. Its finalizer must release this ownership only once.
				if (released) return;
				released = true;
				for (const path of paths) {
					this.inFlight.delete(path);
					// Every key not requeued is settled, including unchanged files the
					// flush skipped; a newer event keeps its own revision.
					if (!this.queued.has(path) && this.revisions.get(path) === revisions.get(path)) {
						this.revisions.delete(path);
					}
				}
			},
		};
	}

	clear(): void {
		this.queued.clear();
		this.inFlight.clear();
		this.revisions.clear();
		this.times.clear();
	}
}
