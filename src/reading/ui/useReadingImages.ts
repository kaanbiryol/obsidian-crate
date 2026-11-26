import { useEffect, useMemo, useState } from 'react';
import { mapBounded } from '@/platform/map-bounded';
import { READING_IMAGE_PATH_ATTRIBUTE } from './reading-content';

/** Images of one article loading at once, so a long article does not fetch and decode all of them together. */
const IMAGE_LOADS = 4;

/** How a host shows images: whether web images load, and a loader returning a URL for a vault image. */
export interface ReadingImageLoader {
	/** Load `https` images from their websites (the **Load from the website** setting). */
	remote: boolean;
	/** Resolves to a URL the reader can display, or null when the image is unavailable.
	 * `itemId` names the article that shows it, whose offline copy may hold it. */
	load: (path: string, signal: AbortSignal, itemId?: string) => Promise<string | null>;
}
/** The images of one article, whose links resolve against `notePath`. */
export interface ReadingImageHost extends ReadingImageLoader { notePath: string }

/** Loads the vault images `content` names and returns a copy that shows them. */
export function useReadingImages(content: DocumentFragment | null, host: ReadingImageHost | undefined): DocumentFragment | null {
	const paths = useMemo(() => content ? [...new Set(Array.from(content.querySelectorAll(`[${READING_IMAGE_PATH_ATTRIBUTE}]`))
		.map(image => image.getAttribute(READING_IMAGE_PATH_ATTRIBUTE)!))] : [], [content]);
	const [loaded, setLoaded] = useState<{ content: DocumentFragment | null; urls: Map<string, string> }>({ content: null, urls: new Map() });
	const load = host?.load;
	useEffect(() => {
		if (!load || !paths.length) return;
		const controller = new AbortController();
		// One update once every image settles, so the article and its highlights repaint once.
		void mapBounded(paths, IMAGE_LOADS, async path => [path, controller.signal.aborted ? null
			// A closed article starts no more loads.
			: await load(path, controller.signal).catch(() => null)] as const).then(results => {
			if (controller.signal.aborted) return;
			setLoaded({ content, urls: new Map(results.filter((entry): entry is [string, string] => entry[1] !== null)) });
		});
		return () => controller.abort();
	}, [content, paths, load]);
	return useMemo(() => {
		if (!content || loaded.content !== content || !loaded.urls.size) return content;
		const copy = content.cloneNode(true) as DocumentFragment;
		for (const image of Array.from(copy.querySelectorAll(`[${READING_IMAGE_PATH_ATTRIBUTE}]`))) {
			const url = loaded.urls.get(image.getAttribute(READING_IMAGE_PATH_ATTRIBUTE)!);
			if (url) image.setAttribute('src', url);
		}
		return copy;
	}, [content, loaded]);
}
