import type { ReadingLibrary } from './library';
import type { ReadingMaintenance } from './maintenance';

/** Vault events settle this long before a refresh; a burst, such as a sync download,
 * still refreshes at least every `REFRESH_MAX_WAIT_MS`. */
const REFRESH_DELAY_MS = 400;
const REFRESH_MAX_WAIT_MS = 2_000;

interface ReadingRefreshOptions {
	maintenance: Pick<ReadingMaintenance, 'start' | 'changed' | 'retry'>;
	library: Pick<ReadingLibrary, 'active' | 'refreshPaths' | 'refreshProperties'>;
	signal: AbortSignal;
	/** False while a refresh cannot run yet, such as before the workspace layout is ready. */
	canRun: () => boolean;
	/** Runs as each refresh starts, before its work. */
	beforeRefresh?: () => void;
	onError: (error: unknown) => void;
}

/** Batches vault events into debounced refreshes of Reading's background work and card list.
 * The first refresh finds clips waiting for import; later ones handle notes that changed and
 * retry work that waited for sync or an editor. */
export function createReadingRefresh({ maintenance, library, signal, canRun, beforeRefresh, onError }: ReadingRefreshOptions) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let scheduledAt = 0;
	let starting = true, retrying = false;
	// Vault events update cards; re-indexed notes update cards from the cache and are checked
	// by the background work, which reads each once.
	const changedPaths = new Set<string>(), reindexedPaths = new Set<string>(), checkPaths = new Set<string>();
	const refreshes = new Set<Promise<void>>();

	const refresh = () => {
		timer = undefined;
		if (signal.aborted || !canRun()) return;
		beforeRefresh?.();
		const first = starting, paths = [...changedPaths], checks = [...checkPaths], retry = retrying;
		const reindexed = [...reindexedPaths].filter(path => !changedPaths.has(path));
		starting = false; retrying = false; changedPaths.clear(); reindexedPaths.clear(); checkPaths.clear();
		const work = (async () => {
			if (first) await maintenance.start();
			if (checks.length) await maintenance.changed(checks);
			else if (retry && !first) await maintenance.retry();
			if (!library.active) return;
			if (paths.length) await library.refreshPaths(paths);
			if (reindexed.length) await library.refreshProperties(reindexed);
		})().catch((error: unknown) => { if (!signal.aborted) onError(error); });
		refreshes.add(work); void work.finally(() => refreshes.delete(work));
	};
	const schedule = () => {
		if (signal.aborted) return;
		const now = Date.now();
		if (timer === undefined) scheduledAt = now;
		else clearTimeout(timer);
		timer = setTimeout(refresh, Math.min(REFRESH_DELAY_MS, Math.max(0, scheduledAt + REFRESH_MAX_WAIT_MS - now)));
	};

	return {
		schedule,
		/** A note was created, edited, deleted or moved: its card is read again. */
		changed(path: string): void { changedPaths.add(path); schedule(); },
		/** Obsidian re-indexed a note: its card takes the cached properties, and the background work checks it. */
		reindexed(path: string): void { reindexedPaths.add(path); checkPaths.add(path); schedule(); },
		/** The background work checks a note that no re-index will report, such as one moved into the folder. */
		check(path: string): void { checkPaths.add(path); schedule(); },
		/** Retries background work that waited for sync or an editor. */
		retry(): void { retrying = true; schedule(); },
		/** Stops the pending timer and settles once running refreshes finish. */
		stop(): Promise<void> {
			clearTimeout(timer); timer = undefined;
			return Promise.allSettled([...refreshes]).then(() => {});
		},
	};
}
