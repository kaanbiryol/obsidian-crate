/** HTTP freshness of the confirmed reminder list, kept outside React state. */
export function createReminderListCursor() {
	let etag: string | undefined;
	// The ETag stored with the offline copy; 304 freshness is recorded against it.
	let persistedEtag: string | undefined;
	// Server changelog position of the confirmed snapshot. Locally confirmed
	// changes since then are in notes the next delta replaces, so it stays valid.
	let deltaBase: string | undefined;
	let lastCheckedAt: number | null = null;
	return {
		get persistedEtag() { return persistedEtag; },
		get deltaBase() { return deltaBase; },
		get lastCheckedAt() { return lastCheckedAt; },
		isFresh(maxAgeMs: number | undefined, now = Date.now()): boolean {
			return maxAgeMs !== undefined && lastCheckedAt !== null && now - lastCheckedAt < maxAgeMs;
		},
		/** Ask for notes changed since a complete confirmed snapshot only. */
		request(folderPath: string, complete: boolean): { path: string; headers: Headers; since?: string } {
			const headers = new Headers();
			if (etag) headers.set('If-None-Match', etag);
			const since = deltaBase && complete ? deltaBase : undefined;
			return { path: `/reminders/list?folderPath=${encodeURIComponent(folderPath)}${since ? `&since=${encodeURIComponent(since)}` : ''}`, headers, since };
		},
		/** Other vault changes refresh the ETag and delta base of unchanged reminders. */
		notModified(headers: Headers, at: number): void {
			etag = headers.get('ETag') ?? etag;
			deltaBase = headers.get('X-Crate-Delta-Base') ?? deltaBase;
			lastCheckedAt = at;
		},
		confirmed(next: { etag?: string; deltaBase?: string }, at: number): void {
			etag = next.etag;
			persistedEtag = next.etag;
			if (next.deltaBase !== undefined) deltaBase = next.deltaBase;
			lastCheckedAt = at;
		},
		dropDeltaBase(): void { deltaBase = undefined; },
		hydrate(snapshot: { etag?: string; deltaBase?: string; savedAt: number }): void {
			etag = snapshot.etag;
			persistedEtag = snapshot.etag;
			deltaBase = snapshot.deltaBase;
			lastCheckedAt = snapshot.savedAt;
		},
		/** Force the next read to fetch the full list after the offline copy was rebuilt. */
		forgetServerPosition(): void {
			etag = undefined;
			deltaBase = undefined;
			lastCheckedAt = null;
		},
		reset(): void {
			etag = undefined;
			persistedEtag = undefined;
			deltaBase = undefined;
			lastCheckedAt = null;
		},
	};
}
