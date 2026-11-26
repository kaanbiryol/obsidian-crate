/** Object URLs no view shows that stay for reuse, such as when scrolling back up. */
const IDLE_URLS = 60;
/** Bytes of the images held as object URLs, shown or not, past which unused ones are revoked. */
const HELD_BYTES = 40 * 1024 * 1024;

interface Entry { url: Promise<string | null>; users: number; controller: AbortController; done: boolean; size: number }

/**
 * Object URLs for vault images, shared by the views that show them. A view uses an image from
 * its `load` until it aborts the signal it passed. An image no view uses keeps its URL among
 * the last `idle` such images while all held images total at most `bytes`, then the URL is
 * revoked, oldest first; one still downloading is cancelled.
 */
export function createImageUrls(fetchImage: (path: string, signal: AbortSignal, itemId?: string) => Promise<Blob>, idle = IDLE_URLS, bytes = HELD_BYTES) {
	const entries = new Map<string, Entry>();
	// Unused images, oldest first.
	const unused = new Set<string>();
	// Bytes of the blobs behind the current URLs.
	let held = 0;
	const drop = (path: string, entry: Entry) => {
		entries.delete(path); unused.delete(path);
		held -= entry.size; entry.size = 0;
		entry.controller.abort();
		void entry.url.then(url => { if (url) URL.revokeObjectURL(url); });
	};
	const trim = () => {
		for (const oldest of unused) {
			if (unused.size <= idle && held <= bytes) break;
			drop(oldest, entries.get(oldest)!);
		}
	};
	const release = (path: string, entry: Entry) => {
		entry.users--;
		// A view that reloads the same image cleans up first and loads again in the same commit.
		queueMicrotask(() => {
			if (entry.users > 0 || entries.get(path) !== entry) return;
			if (!entry.done) { drop(path, entry); return; }
			unused.add(path);
			trim();
		});
	};
	return {
		load: (path: string, signal: AbortSignal, itemId?: string): Promise<string | null> => {
			// A view already gone starts no download that nothing would release.
			if (signal.aborted) return Promise.resolve(null);
			let entry = entries.get(path);
			if (!entry) {
				const controller = new AbortController();
				const created: Entry = { url: Promise.resolve(null), users: 0, controller, done: false, size: 0 };
				const url = created.url = fetchImage(path, controller.signal, itemId).then(blob => {
					if (controller.signal.aborted) return null;
					created.size = blob.size; held += blob.size;
					// Images shown now always stay; unused ones make room for them.
					trim();
					return URL.createObjectURL(blob);
				}, () => null);
				entry = created;
				entries.set(path, created);
				// A failed image is asked for again the next time a view shows it.
				void url.then(value => { created.done = true; if (!value && entries.get(path) === created) entries.delete(path); });
			}
			const used = entry;
			used.users++; unused.delete(path);
			signal.addEventListener('abort', () => release(path, used), { once: true });
			return used.url;
		},
		/** Revokes every URL, such as when the session ends. */
		clear: (): void => { for (const [path, entry] of [...entries]) drop(path, entry); },
	};
}
