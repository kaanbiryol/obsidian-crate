import React from 'react';
import type { ReadingItem } from '../core/model';
import { youtubeVideoId } from '../core/youtube';
import { readingSource, readingTitle } from '../core/reading-presentation';
import { ReadingSourceIcon } from './ReadingSourceIcon';
import { ReadingVideoThumbnail } from './ReadingVideo';

// Rows re-render on every search keystroke; unchanged items skip this work.
export const ReadingItemContent = React.memo(function ReadingItemContent({ item }: { item: ReadingItem }) {
	const videoId = youtubeVideoId(item.source_url);
	return <>
		<ReadingSourceIcon item={item} />
		<span className="crate-reading__item-copy"><strong>{readingTitle(item)}</strong>
			<span className="crate-reading__meta">{videoId ? `Video · ${item.author || 'YouTube'}` : <>{readingSource(item.source_url)}{item.extraction_status !== 'ready' && <><span aria-hidden="true"> · </span>{item.extraction_status === 'pending' ? 'Text pending' : item.source_url ? 'Link only' : 'Empty note'}</>}</>}</span>
		</span>
		{videoId && <ReadingVideoThumbnail key={videoId} id={videoId} />}
	</>;
});
