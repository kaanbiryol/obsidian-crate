import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { youtubeVideoId, youtubeMomentUrl } from '../core/youtube';
import { timestampLabel } from '../core/transcript';
import type { ReadingHighlight } from '../core/highlights';
import { readingImageSource } from '../core/article-images';
import type { ReadingImageLoader } from './useReadingImages';
import type { ReadingMetadata } from '../core/model';
import { Button } from '../../ui/shared/Button';
import { IconButton } from '../../ui/shared/IconButton';
import { ThemeIcon } from '@/ui/shared/ThemeIcon';
import { readingTitle } from '../core/reading-presentation';
import { ReadingSourceIcon } from './ReadingSourceIcon';

// Built once: creating a formatter per row costs more than the row itself.
const SHORT_DATE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const LONG_DATE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** A highlighted image, loaded the way its article shows it; nothing loads without a loader. */
function HighlightImage({ item, highlight, images }: { item: ReadingMetadata & { path?: string }; highlight: ReadingHighlight; images?: ReadingImageLoader }) {
	const [url, setUrl] = useState<string | null>(null);
	const source = highlight.image ?? '', path = item.path, id = item.crate_reading_id;
	useEffect(() => {
		setUrl(null);
		const target = images && path ? readingImageSource(source, path) : null;
		if (!images || !target || target.kind === 'remote' && !images.remote) return;
		if (target.kind === 'remote') { setUrl(target.url); return; }
		const controller = new AbortController();
		images.load(target.path, controller.signal, id).then(value => { if (!controller.signal.aborted) setUrl(value); }, () => {});
		return () => controller.abort();
	}, [images, source, path, id]);
	return url
		? <img className="crate-reading-highlights__image" src={url} alt={highlight.text} referrerPolicy="no-referrer" loading="lazy" decoding="async" />
		: <span className="crate-reading-highlights__image-placeholder" role="img" aria-label={highlight.text || 'Image'}><ThemeIcon id="image" size="m" aria-hidden="true" /></span>;
}

function highlightDate(value: string): string {
	const date = new Date(value);
	return (date.getFullYear() === new Date().getFullYear() ? SHORT_DATE : LONG_DATE).format(date);
}

type HighlightEntry<T> = { item: T; highlight: ReadingHighlight };
interface HighlightActions<T> {
	view: (item: T, highlight: ReadingHighlight) => void;
	openItem: (item: T) => void;
	annotate: (item: T, highlight: ReadingHighlight) => void;
	remove: (item: T, highlight: ReadingHighlight) => void;
	copy: (key: string, text: string) => void;
	play: (seconds: number) => void;
}
interface HighlightRowProps<T> {
	item: T; highlight: ReadingHighlight; rowKey: string; seconds?: number; copied: boolean; disabled: boolean; images?: ReadingImageLoader;
	actions: HighlightActions<T>; can: { view: boolean; openItem: boolean; annotate: boolean; remove: boolean };
}

/** One row. It is memoized, and its props stay equal while its highlight does: actions are
 * stable and the list passes which ones exist, so typing a search re-renders no other row. */
const HighlightRow = memo(function HighlightRow<T extends ReadingMetadata & { path?: string }>({ item, highlight, rowKey, seconds, copied, disabled, images, actions, can }: HighlightRowProps<T>) {
	const withActions = can.annotate || can.remove;
	const viewLabel = youtubeVideoId(item.source_url) ? 'View in transcript' : 'View in article';
	const momentControls = seconds !== undefined && <>
		<Button className="crate-reading-highlights__seek" aria-label={`Seek to ${timestampLabel(seconds)}`} onClick={() => actions.play(seconds)}><ThemeIcon id="play" size="xs" aria-hidden="true" /><span>{timestampLabel(seconds)}</span></Button>
		<a className="crate-reading-highlights__link" href={youtubeMomentUrl(item.source_url, seconds)} target="_blank" rel="noopener noreferrer" aria-label="Open moment on YouTube" title="Open moment on YouTube"><ThemeIcon id="external-link" size="s" aria-hidden="true" /></a>
	</>;
	return <li className="crate-reading-highlights__item" data-openable={can.view ? '' : undefined}>
		{can.view && <Button className="crate-reading-highlights__open" data-reading-id={item.crate_reading_id} disabled={disabled} onClick={() => actions.view(item, highlight)}>
			<span className="crate-reading__sr-only">{viewLabel}</span>
		</Button>}
		{highlight.image !== undefined
			? <figure className="crate-reading-highlights__figure"><HighlightImage item={item} highlight={highlight} images={images} />
				{highlight.text && <figcaption className="crate-reading-highlights__caption">{highlight.text}</figcaption>}</figure>
			: <blockquote className="crate-reading-highlights__excerpt">{highlight.text}</blockquote>}
		{highlight.note && <p className="crate-reading-highlights__note">{highlight.note}</p>}
		{withActions
			? <div className="crate-reading-highlights__toolbar">
				{highlight.createdAt ? <time className="crate-reading-highlights__date" dateTime={highlight.createdAt}>{highlightDate(highlight.createdAt)}</time> : <span className="crate-reading-highlights__date" />}
				{can.annotate && <IconButton icon="notepad-text" iconSize="s" label={highlight.note ? 'Edit note' : 'Add note'} disabled={disabled} onClick={() => actions.annotate(item, highlight)} />}
				{highlight.image === undefined && <IconButton icon={copied ? 'check' : 'copy'} iconSize="s" label={copied ? 'Text copied' : 'Copy text'} onClick={() => actions.copy(rowKey, highlight.text)} />}
				{momentControls}
				{can.remove && <IconButton className="crate-reading-highlights__delete" icon="trash-2" iconSize="s" tone="danger" label="Delete highlight" disabled={disabled} onClick={() => actions.remove(item, highlight)} />}
			</div>
			: <div className="crate-reading-highlights__meta">
				{can.openItem && <Button className="crate-reading-highlights__source" disabled={disabled} aria-label={`${readingTitle(item)}, open ${youtubeVideoId(item.source_url) ? 'video' : 'article'}`}
					onClick={() => actions.openItem(item)}><ReadingSourceIcon item={item} /><span>{readingTitle(item)}</span></Button>}
				{highlight.createdAt ? <time dateTime={highlight.createdAt}>{highlightDate(highlight.createdAt)}</time> : <span />}
				{momentControls && <div className="crate-reading-highlights__actions">{momentControls}</div>}
			</div>}
	</li>;
}) as <T extends ReadingMetadata & { path?: string }>(props: HighlightRowProps<T>) => ReactElement;

/**
 * Compact rows: the row opens the passage. With row actions a toolbar holds the
 * date, then note, copy and delete controls as separate targets. With `onOpenItem`
 * each row names its article, which opens from that line.
 */
export function HighlightList<T extends ReadingMetadata & { path?: string }>({ entries, onView, onOpenItem, onAnnotate, onDelete, onCopy, disabled = false, moment, onPlay, images }: {
	/** Shows highlighted images; without it they show as placeholders. */
	images?: ReadingImageLoader;
	moment?: (highlight: ReadingHighlight) => number | undefined;
	onPlay?: (seconds: number) => void;
	entries: HighlightEntry<T>[];
	onView?: (item: T, highlight: ReadingHighlight) => void;
	onOpenItem?: (item: T) => void;
	onAnnotate?: (item: T, highlight: ReadingHighlight) => void;
	onDelete?: (item: T, highlight: ReadingHighlight) => void;
	onCopy?: () => void;
	disabled?: boolean;
}) {
	const [copied, setCopied] = useState<string | null>(null);
	// Restore the copy icon, matching the reader's link copy confirmation.
	useEffect(() => {
		if (copied === null) return;
		const timer = window.setTimeout(() => setCopied(null), 2500);
		return () => window.clearTimeout(timer);
	}, [copied]);
	// Callers pass new handlers on every render; rows call the latest through stable actions.
	const latest = useRef({ onView, onOpenItem, onAnnotate, onDelete, onCopy, onPlay });
	useLayoutEffect(() => { latest.current = { onView, onOpenItem, onAnnotate, onDelete, onCopy, onPlay }; });
	const actions = useMemo<HighlightActions<T>>(() => ({
		view: (item, highlight) => latest.current.onView?.(item, highlight),
		openItem: item => latest.current.onOpenItem?.(item),
		annotate: (item, highlight) => latest.current.onAnnotate?.(item, highlight),
		remove: (item, highlight) => latest.current.onDelete?.(item, highlight),
		play: seconds => latest.current.onPlay?.(seconds),
		copy: (key, text) => {
			navigator.clipboard.writeText(text).then(() => {
				setCopied(key);
				latest.current.onCopy?.();
			}).catch(() => setCopied(null));
		},
	}), []);
	const view = Boolean(onView), openItem = Boolean(onOpenItem), annotate = Boolean(onAnnotate), remove = Boolean(onDelete);
	const can = useMemo(() => ({ view, openItem, annotate, remove }), [view, openItem, annotate, remove]);
	return <ul className="crate-reading-highlights" aria-label="Highlights">{entries.map(({ item, highlight }, index) => {
		const key = `${item.crate_reading_id}:${highlight.id ?? index}`;
		return <HighlightRow key={key} rowKey={key} item={item} highlight={highlight} seconds={moment?.(highlight)} copied={copied === key}
			disabled={disabled} images={images} actions={actions} can={can} />;
	})}</ul>;
}
