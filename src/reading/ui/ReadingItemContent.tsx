import React from 'react';
import type { ReadingItem } from '../core/model';
import { youtubeVideoId } from '../core/youtube';
import { readingSource, readingTitle } from '../core/reading-presentation';
import { ReadingSourceIcon } from './ReadingSourceIcon';
import { ReadingVideoThumbnail } from './ReadingVideo';

// Rows re-render on every search keystroke; unchanged items skip this work.
export const ReadingItemContent = React.memo(function ReadingItemContent({ item }: { item: ReadingItem }) {
	const videoId = youtubeVideoId(item.source_url);
	// A link shows a placeholder title until its article arrives.
	const fetching = !videoId && item.extraction_status === 'pending' && !!item.source_url;
	return <>
		<ReadingSourceIcon item={item} />
		<span className="crate-reading__item-copy">{fetching ? <span className="crate-reading__title-placeholder" aria-hidden="true" /> : <strong>{readingTitle(item)}</strong>}
			<span className="crate-reading__meta">{videoId ? `Video · ${item.author || 'YouTube'}` : <>{readingSource(item.source_url)}{item.extraction_status !== 'ready' && !fetching && <><span aria-hidden="true"> · </span>{item.extraction_status === 'pending' ? 'Fetching article' : item.source_url ? 'Link only' : 'Empty note'}</>}</>}</span>
		</span>
		{videoId && <ReadingVideoThumbnail key={videoId} id={videoId} />}
	</>;
});
