/** Object URLs no view shows that stay for reuse, such as when scrolling back up. */
const IDLE_URLS = 60;

interface Entry { url: Promise<string | null>; users: number; controller: AbortController; done: boolean }

/**
 * Object URLs for vault images, shared by the views that show them. A view uses an image from
 * its `load` until it aborts the signal it passed. An image no view uses keeps its URL among
 * the last `idle` such images, then the URL is revoked; one still downloading is cancelled.
 */
export function createImageUrls(fetchImage: (path: string, signal: AbortSignal, itemId?: string) => Promise<Blob>, idle = IDLE_URLS) {
	const entries = new Map<string, Entry>();
	// Unused images, oldest first.
	const unused = new Set<string>();
	const drop = (path: string, entry: Entry) => {
		entries.delete(path); unused.delete(path);
		entry.controller.abort();
		void entry.url.then(url => { if (url) URL.revokeObjectURL(url); });
	};
	const release = (path: string, entry: Entry) => {
		entry.users--;
		// A view that reloads the same image cleans up first and loads again in the same commit.
		queueMicrotask(() => {
			if (entry.users > 0 || entries.get(path) !== entry) return;
			if (!entry.done) { drop(path, entry); return; }
			unused.add(path);
			for (const oldest of unused) {
				if (unused.size <= idle) break;
				drop(oldest, entries.get(oldest)!);
			}
		});
	};
	return {
		load: (path: string, signal: AbortSignal, itemId?: string): Promise<string | null> => {
			let entry = entries.get(path);
			if (!entry) {
				const controller = new AbortController();
				const url = fetchImage(path, controller.signal, itemId).then(blob => controller.signal.aborted ? null : URL.createObjectURL(blob), () => null);
				const created: Entry = { url, users: 0, controller, done: false };
				entry = created;
				entries.set(path, created);
				// A failed image is asked for again the next time a view shows it.
				void url.then(value => { created.done = true; if (!value && entries.get(path) === created) entries.delete(path); });
			}
			if (signal.aborted) return Promise.resolve(null);
			const used = entry;
			used.users++; unused.delete(path);
			signal.addEventListener('abort', () => release(path, used), { once: true });
			return used.url;
		},
		/** Revokes every URL, such as when the session ends. */
		clear: (): void => { for (const [path, entry] of [...entries]) drop(path, entry); },
	};
}
