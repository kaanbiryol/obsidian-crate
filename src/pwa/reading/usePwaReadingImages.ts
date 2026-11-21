import { useEffect, useMemo, useRef } from 'react';
import type { ReadingImageHost, ReadingImageLoader } from '@/reading/ui/useReadingImages';
import { loadReadingImage } from './api';
import { readOfflineReadingImage } from './storage/storage';
import type { ReadingSession } from './session/session';

/** Vault images for the web app, as object URLs this hook revokes when the session changes.
 * An image saved with an article's offline copy is shown from it; others are fetched once per
 * session and kept in memory. `host` serves the open article, `loader` any article. */
export function usePwaReadingImages(session: ReadingSession | null | undefined, article: { id: string; notePath: string } | undefined, remote: boolean): { host?: ReadingImageHost; loader?: ReadingImageLoader } {
	const urls = useRef(new Map<string, Promise<string | null>>());
	const token = session?.token;
	useEffect(() => {
		const cached = urls.current;
		return () => {
			for (const url of cached.values()) void url.then(value => { if (value) URL.revokeObjectURL(value); });
			cached.clear();
		};
	}, [token]);
	const loader = useMemo<ReadingImageLoader | undefined>(() => session ? { remote, load: (path, _signal, itemId) => {
		let url = urls.current.get(path);
		if (!url) {
			url = (itemId ? readOfflineReadingImage(session, itemId, path).catch(() => undefined) : Promise.resolve(undefined))
				.then(saved => saved ?? loadReadingImage(session, path)).then(blob => URL.createObjectURL(blob), () => null);
			urls.current.set(path, url);
			// A failed image is asked for again the next time an article shows it.
			void url.then(value => { if (!value && urls.current.get(path) === url) urls.current.delete(path); });
		}
		return url;
	} } : undefined, [session, remote]);
	const id = article?.id, notePath = article?.notePath;
	const host = useMemo<ReadingImageHost | undefined>(() => loader && id && notePath
		? { notePath, remote: loader.remote, load: (path, signal, itemId) => loader.load(path, signal, itemId ?? id) } : undefined, [loader, id, notePath]);
	return { host, loader };
}
