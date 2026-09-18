import type { PendingDiff } from '../../sync/pending-diff';

const MAX_CACHED_CHARACTERS = 1_000_000;

/** Share background checks with selection, retaining only a bounded text cache. */
export class PendingComparisons {
    private cache = new Map<number, PendingDiff>();
    private cachedCharacters = 0;
    private inFlight = new Map<number, Promise<PendingDiff>>();
    private cursor = 0;
    private workers = 0;
    private active = false;
    private disposed = false;

    constructor(
        private readonly count: number,
        private readonly load: (index: number) => Promise<PendingDiff>,
        private readonly onResult: (index: number, snapshot: PendingDiff) => void,
        private readonly onError: (index: number) => void,
        private readonly shouldCheck: (index: number) => boolean = () => true,
    ) {}

    read(index: number): Promise<PendingDiff> {
        if (this.disposed) return Promise.reject(new Error('This comparison was closed.'));
        const pending = this.inFlight.get(index);
        if (pending) return pending;
        const cached = this.cache.get(index);
        if (cached) {
            this.cache.delete(index);
            this.cache.set(index, cached);
            return Promise.resolve(cached);
        }
        this.evict(index);
        const request = Promise.resolve().then(() => this.fetch(index));
        this.inFlight.set(index, request);
        return request;
    }

    private async fetch(index: number): Promise<PendingDiff> {
        try {
            if (this.disposed) throw new Error('This comparison was closed.');
            const snapshot = await this.load(index);
            if (!this.disposed) {
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
                this.onResult(index, snapshot);
            }
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
                try { await this.read(index); }
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
