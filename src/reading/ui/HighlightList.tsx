import React, { useState } from 'react';
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

/**
 * Compact rows: the row opens the passage. With row actions a toolbar holds the
 * date, then note, copy and delete controls as separate targets.
 */
export function HighlightList<T extends ReadingMetadata>({ entries, onView, onAnnotate, onDelete, onCopy, disabled = false, moment, onPlay }: {
	moment?: (highlight: ReadingHighlight) => number | undefined;
	onPlay?: (seconds: number) => void;
	entries: { item: T; highlight: ReadingHighlight }[];
	onView?: (item: T, highlight: ReadingHighlight) => void;
	onAnnotate?: (item: T, highlight: ReadingHighlight) => void;
	onDelete?: (item: T, highlight: ReadingHighlight) => void;
	onCopy?: () => void;
	disabled?: boolean;
}) {
	const withActions = Boolean(onAnnotate || onDelete);
	const [copied, setCopied] = useState<string | null>(null);
	const copy = async (key: string, text: string) => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(key);
			onCopy?.();
		} catch { setCopied(null); }
	};
	return <ul className="crate-reading-highlights" aria-label="Highlights">{entries.map(({ item, highlight }, index) => {
		const key = `${item.crate_reading_id}:${highlight.id ?? index}`;
		const seconds = moment?.(highlight);
		const viewLabel = youtubeVideoId(item.source_url) ? 'View in transcript' : 'View in article';
		const momentControls = seconds !== undefined && <>
			<Button className="crate-reading-highlights__seek" aria-label={`Seek to ${timestampLabel(seconds)}`} onClick={() => onPlay?.(seconds)}><ThemeIcon id="play" size="xs" aria-hidden="true" /><span>{timestampLabel(seconds)}</span></Button>
			<a className="crate-reading-highlights__link" href={youtubeMomentUrl(item.source_url, seconds)} target="_blank" rel="noopener noreferrer" aria-label="Open moment on YouTube" title="Open moment on YouTube"><ThemeIcon id="external-link" size="s" aria-hidden="true" /></a>
		</>;
		return <li className="crate-reading-highlights__item" data-openable={onView ? '' : undefined} key={key}>
			{onView && <Button className="crate-reading-highlights__open" data-reading-id={item.crate_reading_id} disabled={disabled} onClick={() => onView(item, highlight)}>
				<span className="crate-reading__sr-only">{viewLabel}</span>
			</Button>}
			<blockquote className="crate-reading-highlights__excerpt">{highlight.text}</blockquote>
			{highlight.note && <p className="crate-reading-highlights__note">{highlight.note}</p>}
			{withActions
				? <div className="crate-reading-highlights__toolbar">
					{highlight.createdAt ? <time className="crate-reading-highlights__date" dateTime={highlight.createdAt}>{highlightDate(highlight.createdAt)}</time> : <span className="crate-reading-highlights__date" />}
					{onAnnotate && <IconButton icon={highlight.note ? 'pencil' : 'notepad-text'} iconSize="s" label={highlight.note ? 'Edit note' : 'Add note'} disabled={disabled} onClick={() => onAnnotate(item, highlight)} />}
					<IconButton icon={copied === key ? 'check' : 'copy'} iconSize="s" label={copied === key ? 'Text copied' : 'Copy text'} onClick={() => void copy(key, highlight.text)} />
					{momentControls}
					{onDelete && <IconButton className="crate-reading-highlights__delete" icon="trash-2" iconSize="s" tone="danger" label="Delete highlight" disabled={disabled} onClick={() => onDelete(item, highlight)} />}
				</div>
				: <div className="crate-reading-highlights__meta">
					{highlight.createdAt ? <time dateTime={highlight.createdAt}>{highlightDate(highlight.createdAt)}</time> : <span />}
					{momentControls && <div className="crate-reading-highlights__actions">{momentControls}</div>}
				</div>}
		</li>;
	})}</ul>;
}
