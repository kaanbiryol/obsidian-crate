import type { PendingDiff } from '../../sync/pending/pending-diff';

const MAX_CACHED_CHARACTERS = 1_000_000;

/** Share background checks with selection, retaining only a bounded text cache. */
export class PendingComparisons {
	private cache = new Map<number, PendingDiff>();
	private cachedCharacters = 0;
	private inFlight = new Map<number, { request: Promise<PendingDiff>; localOnly: boolean }>();
	private cursor = 0;
	private workers = 0;
	private active = false;
	private disposed = false;

	constructor(
		private readonly count: number,
		/** `localOnly` loads skip fetching a last-synced copy that is not cached on this device. */
		private readonly load: (index: number, localOnly: boolean) => Promise<PendingDiff>,
		private readonly onResult: (index: number, snapshot: PendingDiff) => void,
		private readonly onError: (index: number) => void,
		private readonly shouldCheck: (index: number) => boolean = () => true,
	) {}

	/** Selection loads the full comparison, including a last-synced copy from the server. */
	read(index: number): Promise<PendingDiff> { return this.request(index, false); }

	private request(index: number, localOnly: boolean): Promise<PendingDiff> {
		if (this.disposed) return Promise.reject(new Error('This comparison was closed.'));
		const pending = this.inFlight.get(index);
		// A background check that lacked the last-synced copy is followed by a full load.
		if (pending && pending.localOnly && !localOnly) {
			return pending.request.then(snapshot => snapshot.baselineUnavailable ? this.request(index, false) : snapshot, () => this.request(index, false));
		}
		if (pending) return pending.request;
		const cached = this.cache.get(index);
		if (cached) {
			this.cache.delete(index);
			this.cache.set(index, cached);
			return Promise.resolve(cached);
		}
		this.evict(index);
		const request = Promise.resolve().then(() => this.fetch(index, localOnly));
		this.inFlight.set(index, { request, localOnly });
		return request;
	}

	private async fetch(index: number, localOnly: boolean): Promise<PendingDiff> {
		try {
			if (this.disposed) throw new Error('This comparison was closed.');
			const snapshot = await this.load(index, localOnly);
			// Keep an incomplete background result out of the cache so selection loads it fully.
			if (!this.disposed && !(localOnly && snapshot.baselineUnavailable)) {
				const size = this.size(snapshot);
				while (this.cachedCharacters + size > MAX_CACHED_CHARACTERS && this.cache.size) {
					const oldest = this.cache.keys().next();
					if (oldest.done) break;
					this.evict(oldest.value);
				}
				if (size <= MAX_CACHED_CHARACTERS) {
					this.cache.set(index, snapshot);
					this.cachedCharacters += size;
				}
			}
			if (!this.disposed) this.onResult(index, snapshot);
			return snapshot;
		} catch (error) {
			if (!this.disposed) this.onError(index);
			throw error;
		} finally { this.inFlight.delete(index); }
	}

	start(): void {
		if (this.disposed) return;
		this.active = true;
		while (this.workers < 2 && this.cursor < this.count) {
			this.workers++;
			void this.runWorker();
		}
	}

	pause(): void { this.active = false; }

	dispose(): void {
		this.disposed = true;
		this.active = false;
		this.cache.clear();
		this.cachedCharacters = 0;
	}

	private async runWorker(): Promise<void> {
		try {
			while (this.active && !this.disposed && this.cursor < this.count) {
				const index = this.cursor++;
				if (!this.shouldCheck(index)) continue;
				try { await this.request(index, true); }
				catch { /* A failed check labels that row; keep checking the others. */ }
			}
		} finally { this.workers--; }
	}

	private size(snapshot: PendingDiff): number { return (snapshot.before?.length ?? 0) + (snapshot.after?.length ?? 0); }
	private evict(index: number): void {
		const snapshot = this.cache.get(index);
		if (snapshot) this.cachedCharacters -= this.size(snapshot);
		this.cache.delete(index);
	}
}
