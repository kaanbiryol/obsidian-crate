import React from 'react';
import { youtubeVideoId, youtubeMomentUrl } from '../core/youtube';
import { timestampLabel } from '../core/transcript';
import type { ReadingHighlight } from '../core/highlights';
import type { ReadingMetadata } from '../core/model';
import { Button } from '../../ui/shared/Button';
import { ThemeIcon } from '@/ui/shared/ThemeIcon';

export function HighlightList<T extends ReadingMetadata>({ entries, onView, onAnnotate, disabled = false, hideSource = false, moment, onPlay }: {
	moment?: (highlight: ReadingHighlight) => number | undefined;
	onPlay?: (seconds: number) => void;
	entries: { item: T; highlight: ReadingHighlight }[];
	onView?: (item: T, highlight: ReadingHighlight) => void;
	onAnnotate?: (item: T, highlight: ReadingHighlight) => void;
	disabled?: boolean;
	hideSource?: boolean;
}) {
	return <ul className="crate-reading-highlights" aria-label="Highlights">{entries.map(({ item, highlight }, index) => <li className="crate-reading-highlights__card" key={`${item.crate_reading_id}:${highlight.id ?? index}`}>
		<blockquote>{highlight.text}</blockquote>
		{!hideSource && <div className="crate-reading-highlights__source"><strong>{item.title}</strong>{item.author && <span>{item.author}</span>}{highlight.createdAt && <time dateTime={highlight.createdAt}>{new Date(highlight.createdAt).toLocaleDateString()}</time>}</div>}
		{highlight.note && <p className="crate-reading-highlights__note">{highlight.note}</p>}
		{(onView || onAnnotate) && <div className="crate-reading-highlights__actions">
			{onView && <Button variant="ghost" size="touch" data-reading-id={item.crate_reading_id} disabled={disabled} onClick={() => onView(item, highlight)}>
				<ThemeIcon id="arrow-up-right" size="s" aria-hidden="true" />
				<span>{youtubeVideoId(item.source_url) ? 'View in transcript' : 'View in article'}</span>
			</Button>}
			{moment?.(highlight) !== undefined && <><Button variant="ghost" size="touch" onClick={() => onPlay?.(moment(highlight)!)}>Seek to {timestampLabel(moment(highlight)!)}</Button><a href={youtubeMomentUrl(item.source_url, moment(highlight)!)} target="_blank" rel="noopener noreferrer">Open moment on YouTube</a></>}
			{onAnnotate && <Button variant="ghost" size="touch" disabled={disabled} onClick={() => onAnnotate(item, highlight)}>
				<ThemeIcon id="square-pen" size="s" aria-hidden="true" />
				<span>{highlight.note ? 'Edit note' : 'Add note'}</span>
			</Button>}
		</div>}
	</li>)}</ul>;
}
