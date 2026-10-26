import { highlightReadingCode } from './code-highlighting';
import { DEFAULT_READING_APPEARANCE, type ReadingAppearance } from './appearance';
import { readerScrollElement } from './reader-scroll';
import { useReaderNavigation } from './useReaderNavigation';
import { useReadingReaderActions } from './useReadingReaderActions';
import { useDeferredEntry } from './useDeferredEntry';
import { useReaderHighlights } from './useReaderHighlights';
import { ReadingHighlightActions } from './ReadingHighlightActions';
import { ReadingBody } from './ReadingBody';
import { ReadingTagsForm } from './ReadingTagsForm';
import { ReadingHighlightNoteForm } from './ReadingHighlightNoteForm';
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ThemeIcon } from '@/ui/shared/ThemeIcon';
import { readingDocument } from '../core/markdown';
import { renderReadingContent } from './reading-content';
import type { ReadingHighlight } from '../core/highlights';
import { HighlightList } from './HighlightList';
import { Button } from '../../ui/shared/Button';
import { IconButton } from '../../ui/shared/IconButton';
import { BackButton } from '../../ui/shared/BackButton';
import { ToggleButton } from '../../ui/shared/ToggleButton';
import type { ReadingMetadata, ReadingChanges } from '../core/model';
import { ReadingDialog } from './ReadingDialog';
import { youtubeVideoId } from '../core/youtube';
import { ReadingVideo } from './ReadingVideo';
import { decorateTranscript } from './transcript-content';
import { transcriptSegments, transcriptMoment } from '../core/transcript';
import { readingSource, readingTitle } from '../core/reading-presentation';
import { ReadingSourceIcon } from './ReadingSourceIcon';
import { LoadingIndicator } from '../../ui/shared/LoadingIndicator';
import { EmptyState } from '../../ui/shared/EmptyState';

export function ReadingReader({ item, markdown: loadedMarkdown, deferContentUntilEntered = false, revealContentTogether = false, onBack, onEdit, onUpdate, onSaveComplete, onCopyComplete, status, onRetry, notice, pendingMessage = 'Your link is saved. Article text is on its way.', mutationPending = false, highlightsPending = mutationPending, loadingError, onRetryOpen, focusHighlight, autoHideNavigation = false, floatingHighlights = false, highlightCode = highlightReadingCode, appearance, onAppearanceChange }: {
	appearance?: ReadingAppearance; onAppearanceChange?: (appearance: ReadingAppearance) => void;
	item: ReadingMetadata; markdown: string | null; onBack: () => void; onEdit?: () => void; onUpdate?: (changes: ReadingChanges) => Promise<void>;
	/** Keep article parsing and layout out of the host's opening slide. */
	deferContentUntilEntered?: boolean;
	/** Reveal article metadata with its text; retain source access if loading fails. */
	revealContentTogether?: boolean;
	/** Host feedback after an explicit form save has been accepted. */
	onSaveComplete?: (action: 'tags' | 'note') => void;
	onCopyComplete?: () => void;
	highlightCode?: (code: string, language: string) => string | undefined;
	loadingError?: string; onRetryOpen?: () => void;
	focusHighlight?: ReadingHighlight; autoHideNavigation?: boolean; floatingHighlights?: boolean;
	pendingMessage?: string;
	status?: string; onRetry?: () => Promise<void>; notice?: React.ReactNode; mutationPending?: boolean; highlightsPending?: boolean;
}) {
	const body = useRef<HTMLDivElement>(null);
	const tagsFormId = useId(), noteFormId = useId(), deleteFormId = useId();
	const { error, setError, busy, sharing, copied, run, shareLink } = useReadingReaderActions(item.crate_reading_id);
	const [dialog, setDialog] = useState<'appearance' | 'tags' | null>(null);
	const [localAppearance, setLocalAppearance] = useState(DEFAULT_READING_APPEARANCE);
	const { fontSize, serif } = appearance ?? localAppearance;
	const updateAppearance = (changes: Partial<ReadingAppearance>) => {
		const next = { fontSize, serif, ...changes };
		setLocalAppearance(next);
		onAppearanceChange?.(next);
	};
	const [mode, setMode] = useState<'article' | 'highlights'>('article');
	const article = useRef<HTMLElement>(null), heading = useRef<HTMLHeadingElement>(null);
	const markdown = useDeferredEntry(article, deferContentUntilEntered, item.crate_reading_id) ? loadedMarkdown : null;
	const videoId = youtubeVideoId(item.source_url);
	const kind = videoId ? 'video' : 'article';
	const segments = useMemo(() => videoId && markdown !== null ? transcriptSegments(markdown) : [], [videoId, markdown]);
	const [videoSeek, setVideoSeek] = useState<{ seconds: number; reveal?: boolean } | null>(null);
	const [videoPinned, setVideoPinned] = useState(true);
	const hasVideoNotes = useMemo(() => Boolean(videoId && markdown !== null && readingDocument(markdown).text.trim()), [videoId, markdown]);
	const showHeader = !revealContentTogether || markdown !== null || Boolean(loadingError);
	useReaderNavigation(article, autoHideNavigation && (!segments.length || !videoPinned), item.crate_reading_id);
	useEffect(() => {
		if (article.current) readerScrollElement(article.current).scrollTo({ top: 0 }); (heading.current ?? article.current)?.focus({ preventScroll: true });
		setDialog(null); setVideoSeek(null); setVideoPinned(true); setMode('article');
	}, [item.crate_reading_id]);
	useEffect(() => {
		// Transfer opening focus without taking it from a control used while loading.
		if (showHeader && article.current?.ownerDocument.activeElement === article.current) heading.current?.focus({ preventScroll: true });
	}, [showHeader]);
	const content = useMemo(() => {
		if (markdown === null) return null;
		const result = renderReadingContent(markdown, item.source_url, highlightCode);
		if (videoId) decorateTranscript(result, markdown, segments);
		return result;
	}, [markdown, item.source_url, highlightCode, videoId, segments]);
	const {
		highlightsOpen, openHighlights, closeHighlights, annotation, note, setNote, noteOverHighlights, openNote, closeNote, canSaveNote,
		pendingDelete, requestDelete, cancelDelete, saveHighlights, saveNote, deleteHighlight, perform, view,
	} = useReaderHighlights({ item, markdown, content, body, article, mode, setMode, onUpdate, focusHighlight, floatingHighlights, setError, disabled: busy || highlightsPending });
	const noteDialog = annotation && <ReadingDialog title="Highlight note" action={{ label: 'Save', ariaLabel: 'Save note', type: 'submit', form: noteFormId, disabled: !canSaveNote, busy }} busy={busy} onClose={closeNote}>{close => <ReadingHighlightNoteForm id={noteFormId} excerpt={annotation.text} note={note} busy={busy} canSave={canSaveNote} error={error} onChange={setNote} onSave={() => { void run(async isCurrent => { await saveNote(); if (!isCurrent()) return; onSaveComplete?.('note'); if (isCurrent()) close(); }); }} />}</ReadingDialog>;
	const renderHighlights = (close?: () => void) => <>
		{!item.highlights?.length && <EmptyState compact icon="highlighter" iconColor="secondary" title="No highlights yet" description="Select a passage in the article to save your first highlight." />}
		<HighlightList moment={highlight => transcriptMoment(segments, highlight.start, highlight.end)} onPlay={seconds => perform(() => { setMode('article'); setVideoSeek({ seconds }); }, close)} entries={(item.highlights ?? []).map(highlight => ({ item, highlight }))} disabled={busy || highlightsPending} onView={(_item, highlight) => view(highlight, close)} onAnnotate={onUpdate ? (_item, highlight) => openNote(highlight, Boolean(close)) : undefined} onDelete={onUpdate ? (_item, highlight) => requestDelete(highlight) : undefined} onCopy={onCopyComplete} />
		{!!item.highlight_recovery?.length && <details className="crate-reading__notice"><summary>{item.highlight_recovery.length} saved highlights need reselecting</summary><p>The original excerpts are preserved here. Select their current passages in the article to highlight them again.</p><HighlightList entries={item.highlight_recovery.map(highlight => ({ item, highlight }))} /></details>}
		{close && noteOverHighlights && noteDialog}
		{pendingDelete && <ReadingDialog title="Delete highlight" role="alertdialog" action={{ label: 'Delete', ariaLabel: 'Confirm delete highlight', type: 'submit', form: deleteFormId, tone: 'danger', disabled: busy || highlightsPending, busy }} busy={busy} onClose={cancelDelete}>{closeDelete => <form id={deleteFormId} className="crate-reading-note" onSubmit={event => {
			event.preventDefault();
			void run(async isCurrent => { await deleteHighlight(pendingDelete); if (isCurrent()) closeDelete(); });
		}}>
			<blockquote className="crate-reading-note__excerpt">{pendingDelete.text}</blockquote>
			<p className="crate-reading-note__message">{pendingDelete.note ? 'This removes the highlight and its note.' : 'This removes the highlight from the article.'}</p>
			{error && <span className="crate-field__error" role="alert">{error}</span>}
		</form>}</ReadingDialog>}
	</>;
	const minutes = useMemo(() => Math.max(1, Math.ceil((markdown ?? '').trim().split(/\s+/).length / 220)), [markdown]);
	return <article ref={article} tabIndex={-1} className="crate-reading crate-reading-reader" data-serif={serif} style={{ '--reading-font-size': `${fontSize}px` } as React.CSSProperties}>
		{floatingHighlights && (!videoId || hasVideoNotes) && <div className="crate-reading-reader__floating"><Button variant="outline" size="touch" className="crate-reading-reader__highlights-button" aria-label={`Highlights (${item.highlights?.length ?? 0})`} aria-haspopup="dialog" aria-expanded={highlightsOpen} onClick={openHighlights}><ThemeIcon id="highlighter" size="m" aria-hidden="true" /><span>{item.highlights?.length ?? 0}</span></Button></div>}
		<nav className="crate-reading-reader__nav crate-detail-navigation" aria-label={videoId ? 'Video actions' : 'Article actions'}>
			<BackButton label="Back to reading" onClick={onBack} />
			<div className="crate-reading-reader__quick-actions">{onUpdate && <><IconButton size="large" icon={item.reading_status === 'archived' ? 'archive-restore' : 'archive'} label={item.reading_status === 'archived' ? 'Move to inbox' : `Archive ${kind}`} disabled={mutationPending} aria-disabled={busy || mutationPending} onClick={() => void run(() => onUpdate({ reading_status: item.reading_status === 'archived' ? 'inbox' : 'archived' }))} /><IconButton size="large" icon="star" label={item.favorite ? 'Remove favorite' : `Favorite ${kind}`} aria-pressed={item.favorite} data-filled={item.favorite} disabled={mutationPending} aria-disabled={busy || mutationPending} onClick={() => void run(() => onUpdate({ favorite: !item.favorite }))} /></>}</div>
		</nav>
		<div className="crate-reading-reader__page">
			{notice}
			{showHeader && <header className="crate-reading-reader__header">{item.source_url ? <a className="crate-reading-reader__source" href={item.source_url} target="_blank" rel="noopener noreferrer"><ReadingSourceIcon item={item} />{readingSource(item.source_url)}<ThemeIcon id="arrow-up-right" size="xs" aria-hidden="true" /></a> : <span className="crate-reading-reader__source"><ReadingSourceIcon item={item} />Vault note</span>}<h1 ref={heading} tabIndex={-1}>{readingTitle(item)}</h1>
				<div className="crate-reading-reader__byline">{item.author && <span>{item.author}</span>}<time dateTime={item.saved_at}>{new Date(item.saved_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time>{videoId && <span>Video</span>}{videoId && segments.length > 0 && item.transcript_language && <span>Transcript: {item.transcript_language}</span>}{!videoId && markdown !== null && item.extraction_status === 'ready' && <span>{minutes} min read</span>}</div>
				<div className="crate-reading-reader__tools"><div className="crate-reading-reader__availability">{status && <span role="status"><ThemeIcon id="check" size="xs" aria-hidden="true" />{status}</span>}</div>{(!videoId || hasVideoNotes) && <IconButton size="large" icon="type" label="Reading appearance" onClick={() => setDialog('appearance')} />}{onUpdate && <IconButton size="large" icon="hash" label={`Edit ${kind} tags`} disabled={mutationPending} onClick={() => setDialog('tags')} />}{onEdit && <IconButton size="large" icon="file-text" label="Open note" onClick={onEdit} />}{item.source_url && <IconButton size="large" icon={copied ? 'check' : 'share-2'} label={copied ? 'Link copied' : `Share ${kind}`} aria-disabled={sharing} onClick={() => void shareLink(article.current?.ownerDocument.defaultView, readingTitle(item), item.source_url)} />}</div>
				{item.tags.length > 0 && <div className="crate-reading-reader__tags">{item.tags.map(tag => <span key={tag}>#{tag}</span>)}</div>}
			</header>}
			{error && <p role="alert" className="crate-reading__notice">{error}</p>}
			{copied && <span className="crate-reading__sr-only" role="status">Link copied</span>}
			{!floatingHighlights && (!videoId || hasVideoNotes) && <div className="crate-reading-reader__tabs" role="group" aria-label="Article view"><ToggleButton pressed={mode === 'article'} onPressedChange={() => setMode('article')}>{videoId ? segments.length ? 'Transcript' : 'Notes' : 'Article'}</ToggleButton><ToggleButton pressed={mode === 'highlights'} onPressedChange={() => setMode('highlights')}>Highlights{item.highlights?.length ? ` (${item.highlights.length})` : ''}</ToggleButton></div>}
			{!floatingHighlights && mode === 'highlights' && renderHighlights()}
			<div hidden={mode !== 'article'}>
			{videoId && showHeader && <ReadingVideo key={item.crate_reading_id} id={videoId} source={item.source_url} body={body} content={content} hasTranscript={segments.length > 0} pinned={videoPinned} onPinnedChange={setVideoPinned} seekTarget={videoSeek} />}
			{markdown !== null && item.extraction_status !== 'ready' && <p className="crate-reading__notice">{videoId ? (item.extraction_status === 'pending' ? item.title === new URL(item.source_url).hostname ? 'Your video is saved. Fetching details and transcript…' : 'Video details are saved. Fetching the transcript…' : 'Your video is saved. You can watch it on YouTube.') : item.extraction_status === 'pending' ? pendingMessage : item.source_url ? 'Article text couldn’t be saved. You can still read the original.' : 'This note is empty.'}{onRetry && item.capture_method === 'url' && item.extraction_status === 'unavailable' && <Button variant="outline" disabled={busy || mutationPending} onClick={() => void run(onRetry)}>{videoId ? 'Retry capture' : 'Try again'}</Button>}</p>}
			{videoId && markdown !== null && item.extraction_status === 'ready' && !segments.length && <p className="crate-reading__notice">{hasVideoNotes ? 'Saved notes are available. No timed transcript was found.' : 'Transcript unavailable. You can add one with the Crate Web Clipper template.'}{!hasVideoNotes && onRetry && item.capture_method === 'url' && <Button variant="outline" disabled={busy || mutationPending} onClick={() => void run(onRetry)}>Retry transcript</Button>}</p>}
			{markdown === null ? <div className="pwa-reading-article-opening__body">
				{loadingError ? <><p role="alert">{loadingError}</p><Button variant="outline" onClick={onRetryOpen}>Retry</Button></>
					: <LoadingIndicator label={videoId ? "Loading video details" : "Loading article"} />}
			</div> : <ReadingBody body={body} article={article} content={content} highlights={item.highlights ?? []} />}
			{markdown !== null && (videoId || item.extraction_status === 'ready') && <footer className="crate-reading-reader__end">{!videoId && <><span aria-hidden="true">✦</span><p>You’ve reached the end.</p></>}{onUpdate && item.reading_status === 'inbox' && <Button variant="outline" disabled={mutationPending} aria-disabled={busy || mutationPending} onClick={() => void run(() => onUpdate({ reading_status: 'archived' }))}><ThemeIcon id="archive" size="m" aria-hidden="true" />{videoId ? 'Mark as watched' : 'Mark as read'}</Button>}</footer>}
			</div>
		</div>
		{onUpdate && markdown !== null && mode === 'article' && <ReadingHighlightActions key={item.crate_reading_id} body={body} article={article} content={content} highlights={item.highlights ?? []} disabled={busy || highlightsPending} onSave={saveHighlights} onAnnotate={openNote} onCopyComplete={onCopyComplete} onSelect={videoId ? highlight => { const seconds = transcriptMoment(segments, highlight.start, highlight.end); if (seconds !== undefined) setVideoSeek({ seconds, reveal: false }); } : undefined} />}
		{floatingHighlights && highlightsOpen && <ReadingDialog title="Highlights" fullHeight onClose={closeHighlights}>{close => renderHighlights(close)}</ReadingDialog>}
		{!(floatingHighlights && highlightsOpen && noteOverHighlights) && noteDialog}
		{dialog === 'appearance' && <ReadingDialog title="Reading appearance" onClose={() => setDialog(null)}><div className="crate-reading-reader__preferences"><span>Typeface</span><div className="crate-reading-reader__font-choice"><ToggleButton variant="outline" pressed={!serif} onPressedChange={() => updateAppearance({ serif: false })}>Modern<span>Sans serif</span></ToggleButton><ToggleButton variant="outline" pressed={serif} onPressedChange={() => updateAppearance({ serif: true })}>Literary<span>Serif</span></ToggleButton></div><div className="crate-reading-reader__font-size"><span>Text size</span><IconButton icon="minus" iconSize="s" label="Decrease text size" disabled={fontSize <= 16} onClick={() => updateAppearance({ fontSize: Math.max(16, fontSize - 1) })} /><output aria-label="Text size" aria-live="polite">{fontSize}</output><IconButton icon="plus" iconSize="s" label="Increase text size" disabled={fontSize >= 26} onClick={() => updateAppearance({ fontSize: Math.min(26, fontSize + 1) })} /></div><div className="crate-reading-reader__sample-frame"><p className="crate-reading-reader__sample" style={{ fontSize, fontFamily: serif ? 'Georgia, serif' : 'var(--font-interface)' }}>A little room to read.<br />A little space to think.</p></div></div></ReadingDialog>}
		{dialog === 'tags' && onUpdate && <ReadingDialog title={videoId ? "Video tags" : "Article tags"} action={{ label: 'Save', ariaLabel: 'Save tags', type: 'submit', form: tagsFormId, disabled: busy, busy }} busy={busy} onClose={() => setDialog(null)}>{close => <ReadingTagsForm id={tagsFormId} initialTags={item.tags} busy={busy} error={error} onSave={tags => { void run(async isCurrent => { await onUpdate({ tags }); if (!isCurrent()) return; onSaveComplete?.('tags'); if (isCurrent()) close(); }); }} />}</ReadingDialog>}
	</article>;
}
