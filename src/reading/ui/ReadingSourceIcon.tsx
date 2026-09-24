import React, { useState } from 'react';
import { readingFaviconUrl, type ReadingMetadata } from '../core/model';
import { readingSource } from './reading-presentation';

export function sourceIconUrl(item: ReadingMetadata): string | null {
	if (item.favicon_url) {
		try { return readingFaviconUrl(item.favicon_url); }
		catch { /* Use the site's conventional icon when cached metadata is invalid. */ }
	}
	try {
		const source = new URL(item.resolved_url ?? item.source_url);
		return readingFaviconUrl(`https://${source.hostname}/favicon.ico`);
	} catch { return null; }
}

function Favicon({ url }: { url: string }) {
	const [loaded, setLoaded] = useState(false), [failed, setFailed] = useState(false);
	return failed ? null : <img src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"
		data-loaded={loaded} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />;
}

/** Keep the letter visible until an icon has actually loaded, including offline. */
export function ReadingSourceIcon({ item }: { item: ReadingMetadata }) {
	const url = sourceIconUrl(item);
	return <span className="crate-reading__source-icon" aria-hidden="true">
		{readingSource(item.source_url).slice(0, 1).toUpperCase()}
		{url && <Favicon key={url} url={url} />}
	</span>;
}
