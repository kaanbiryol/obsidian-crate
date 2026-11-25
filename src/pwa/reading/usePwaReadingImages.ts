import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { ReadingImageHost, ReadingImageLoader } from '@/reading/ui/useReadingImages';
import { loadReadingImage } from './api';
import { readOfflineReadingImage } from './storage/storage';
import type { ReadingSession } from './session/session';
import { createImageUrls } from './image-urls';

/** Vault images for the web app, as object URLs released once no view shows them (see
 * `createImageUrls`) and when the session changes. An image saved with an article's offline
 * copy is shown from it; others are fetched. `host` serves the open article, `loader` any article. */
export function usePwaReadingImages(session: ReadingSession | null | undefined, article: { id: string; notePath: string } | undefined, remote: boolean): { host?: ReadingImageHost; loader?: ReadingImageLoader } {
	// Images last as long as the credential: a refreshed session object keeps them.
	const current = useRef(session);
	useLayoutEffect(() => { current.current = session; });
	const token = session?.token;
	const urls = useMemo(() => token ? createImageUrls((path, signal, itemId) => {
		const session = current.current!;
		return (itemId ? readOfflineReadingImage(session, itemId, path).catch(() => undefined) : Promise.resolve(undefined))
			.then(saved => saved ?? loadReadingImage(session, path, signal));
	}) : undefined, [token]);
	useEffect(() => () => urls?.clear(), [urls]);
	const loader = useMemo<ReadingImageLoader | undefined>(() => urls ? { remote, load: urls.load } : undefined, [urls, remote]);
	const id = article?.id, notePath = article?.notePath;
	const host = useMemo<ReadingImageHost | undefined>(() => loader && id && notePath
		? { notePath, remote: loader.remote, load: (path, signal, itemId) => loader.load(path, signal, itemId ?? id) } : undefined, [loader, id, notePath]);
	return { host, loader };
}
