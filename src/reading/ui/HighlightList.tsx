import React from 'react';
import { youtubeVideoId, youtubeMomentUrl } from '../core/youtube';
import { timestampLabel } from '../core/transcript';
import type { ReadingHighlight } from '../core/highlights';
import type { ReadingMetadata } from '../core/model';
import { Button } from '../../ui/shared/Button';
import { IconButton } from '../../ui/shared/IconButton';
import { ThemeIcon } from '@/ui/shared/ThemeIcon';

function highlightDate(value: string): string {
	const date = new Date(value);
	return date.toLocaleDateString(undefined, date.getFullYear() === new Date().getFullYear()
		? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Compact rows: the row opens the passage; trailing controls stay separate targets. */
export function HighlightList<T extends ReadingMetadata>({ entries, onView, onAnnotate, disabled = false, moment, onPlay }: {
	moment?: (highlight: ReadingHighlight) => number | undefined;
	onPlay?: (seconds: number) => void;
	entries: { item: T; highlight: ReadingHighlight }[];
	onView?: (item: T, highlight: ReadingHighlight) => void;
	onAnnotate?: (item: T, highlight: ReadingHighlight) => void;
	disabled?: boolean;
}) {
	return <ul className="crate-reading-highlights" aria-label="Highlights">{entries.map(({ item, highlight }, index) => {
		const seconds = moment?.(highlight);
		return <li className="crate-reading-highlights__item" data-openable={onView ? '' : undefined} key={`${item.crate_reading_id}:${highlight.id ?? index}`}>
			{onView && <Button className="crate-reading-highlights__open" data-reading-id={item.crate_reading_id} disabled={disabled} onClick={() => onView(item, highlight)}>
				<span className="crate-reading__sr-only">{youtubeVideoId(item.source_url) ? 'View in transcript' : 'View in article'}</span>
			</Button>}
			<blockquote className="crate-reading-highlights__excerpt">{highlight.text}</blockquote>
			{highlight.note && <p className="crate-reading-highlights__note"><ThemeIcon id="sticky-note" size="xs" aria-hidden="true" /><span>{highlight.note}</span></p>}
			<div className="crate-reading-highlights__meta">
				{highlight.createdAt ? <time dateTime={highlight.createdAt}>{highlightDate(highlight.createdAt)}</time> : <span />}
				<div className="crate-reading-highlights__actions">
					{seconds !== undefined && <>
						<Button className="crate-reading-highlights__seek" aria-label={`Seek to ${timestampLabel(seconds)}`} onClick={() => onPlay?.(seconds)}><ThemeIcon id="play" size="xs" aria-hidden="true" /><span>{timestampLabel(seconds)}</span></Button>
						<a className="crate-reading-highlights__link" href={youtubeMomentUrl(item.source_url, seconds)} target="_blank" rel="noopener noreferrer" aria-label="Open moment on YouTube" title="Open moment on YouTube"><ThemeIcon id="external-link" size="s" aria-hidden="true" /></a>
					</>}
					{onAnnotate && <IconButton className="crate-reading-highlights__annotate" icon="square-pen" iconSize="s" label={highlight.note ? 'Edit note' : 'Add note'} disabled={disabled} onClick={() => onAnnotate(item, highlight)} />}
				</div>
			</div>
		</li>;
	})}</ul>;
}
