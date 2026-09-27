import { readerScrollElement } from './reader-scroll';
import { useReaderNavigation } from './useReaderNavigation';
import { ReadingHighlightActions } from './ReadingHighlightActions';
import { ReadingBody } from './ReadingBody';
import { TextField } from '../../ui/shared/TextField';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ThemeIcon } from '../../reminders/components/theme-icon';
import { readingMarkdown, readingDocument } from '../core/markdown';
import { READING_DROP_CONTENTS, READING_HTML_TAGS } from '../core/html-policy';
import { anchorHighlight, writeMarkdownHighlights } from '../core/markdown-highlights';
import type { ReadingHighlight } from '../core/highlights';
import { HighlightList } from './HighlightList';
import DOMPurify from 'dompurify';
import { Button } from '../../ui/shared/Button';
import { IconButton } from '../../ui/shared/IconButton';
import { ToggleButton } from '../../ui/shared/ToggleButton';
import type { ReadingMetadata, ReadingChanges } from '../core/model';
import { ReadingDialog } from './ReadingDialog';
import { readingSource } from './reading-presentation';
import { ReadingSourceIcon } from './ReadingSourceIcon';
import { LoadingIndicator } from '../../ui/shared/LoadingIndicator';

/** All article HTML is untrusted, including content captured by Web Clipper. */
function renderReadingText(markdown: string, source: string, highlightCode?: (code: string, language: string) => string | undefined): string {
	const html = readingMarkdown.parse(markdown, { async: false });
	const container = DOMPurify.sanitize(html, {
		// Parse an article fragment: document parsing drops whitespace after an
		// opening comment (including Crate's article marker), shifting offsets.
		RETURN_DOM: true, FORCE_BODY: true,
		ADD_ATTR: (attribute, tag) => Boolean(highlightCode) && tag === 'code' && attribute === 'class',
		ALLOWED_TAGS: READING_HTML_TAGS, FORBID_CONTENTS: READING_DROP_CONTENTS,
		ALLOWED_ATTR: ['href', 'title', 'colspan', 'rowspan', 'data-crate-native'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
	}) as HTMLElement; // RETURN_DOM with WHOLE_DOCUMENT disabled returns the sanitized body.
	// Metadata paints the current (including offline pending) set. Native markers
	// are already represented in that set and must also be removable optimistically.
	for (const mark of Array.from(container.querySelectorAll('mark[data-crate-native]'))) mark.replaceWith(...Array.from(mark.childNodes));
	for (const link of Array.from(container.querySelectorAll('a'))) {
		const unlink = () => link.replaceWith(...Array.from(link.childNodes));
		try {
			const href = link.getAttribute('href');
			if (!href) { unlink(); continue; }
			const url = new URL(href, source || undefined);
			if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { unlink(); continue; }
			link.setAttribute('href', url.href); link.setAttribute('target', '_blank'); link.setAttribute('rel', 'noopener noreferrer');
		} catch { unlink(); }
	}
	let remainingCode = 100_000;
	for (const code of Array.from(container.querySelectorAll('code'))) {
		const language = /(?:^|\s)language-([\w+#-]+)/i.exec(code.className)?.[1]?.toLowerCase() ?? '';
		code.removeAttribute('class');
		const text = code.textContent ?? '';
		if (!highlightCode || code.parentElement?.tagName !== 'PRE' || text.length > remainingCode) continue;
		remainingCode -= text.length;
		const highlighted = highlightCode(text, language);
		if (highlighted !== undefined) {
			const tokens = DOMPurify.sanitize(highlighted, { RETURN_DOM_FRAGMENT: true, ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false });
			if (tokens.textContent === text) code.replaceChildren(tokens);
		}
	}
	return container.innerHTML;
}

export function ReadingReader({ item, markdown: loadedMarkdown, deferContentUntilEntered = false, revealContentTogether = false, onBack, onEdit, onUpdate, onSaveComplete, onCopyComplete, status, onRetry, notice, mutationPending = false, highlightsPending = mutationPending, loadingError, onRetryOpen, focusHighlight, autoHideNavigation = false, floatingHighlights = false, highlightCode }: {
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
	status?: string; onRetry?: () => Promise<void>; notice?: React.ReactNode; mutationPending?: boolean; highlightsPending?: boolean;
}) {
	const body = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
	const [sharing, setSharing] = useState(false);
	const [dialog, setDialog] = useState<'appearance' | 'tags' | null>(null), [tags, setTags] = useState('');
	const [fontSize, setFontSize] = useState(19), [serif, setSerif] = useState(false), [copied, setCopied] = useState(false);
	const [mode, setMode] = useState<'article' | 'highlights'>('article');
	const [highlightsOpen, setHighlightsOpen] = useState(false);
	const sheetAction = useRef<(() => void) | null>(null);
	const targetAfterSheet = useRef(false);
	const [target, setTarget] = useState<ReadingHighlight | null>(null);
	const [annotation, setAnnotation] = useState<ReadingHighlight | null>(null), [note, setNote] = useState('');
	const pending = useRef({ mutation: false, share: false }), article = useRef<HTMLElement>(null), heading = useRef<HTMLHeadingElement>(null);
	const [enteredId, setEnteredId] = useState<string | null>(null);
	const markdown = deferContentUntilEntered && enteredId !== item.crate_reading_id ? null : loadedMarkdown;
	const showHeader = !revealContentTogether || markdown !== null || Boolean(loadingError);
	useEffect(() => {
		if (!deferContentUntilEntered) return;
		let cancelled = false;
		// Reading the pane's animations flushes its new style, including the first
		// opening transition. Cached/network text can arrive while it is moving.
		const animations = article.current?.closest('.crate-reading__reader-pane')?.getAnimations()
			.filter(animation => 'transitionProperty' in animation && animation.transitionProperty === 'transform') ?? [];
		void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
			if (!cancelled) setEnteredId(item.crate_reading_id);
		});
		return () => { cancelled = true; };
	}, [deferContentUntilEntered, item.crate_reading_id]);
	useReaderNavigation(article, autoHideNavigation, item.crate_reading_id);
	const copyTimer = useRef<{ window: Window; id: number } | undefined>(undefined);
	const clearCopyTimer = () => { if (copyTimer.current) copyTimer.current.window.clearTimeout(copyTimer.current.id); };
	useEffect(() => {
		if (article.current) readerScrollElement(article.current).scrollTo({ top: 0 }); (heading.current ?? article.current)?.focus({ preventScroll: true });
		setError(null); setCopied(false); setDialog(null);
		setMode('article'); setAnnotation(null); setHighlightsOpen(false); sheetAction.current = null;
		return clearCopyTimer;
	}, [item.crate_reading_id]);
	useEffect(() => {
		// Transfer opening focus without taking it from a control used while loading.
		if (showHeader && article.current?.ownerDocument.activeElement === article.current) heading.current?.focus({ preventScroll: true });
	}, [showHeader]);
	// Serialize metadata writes without dimming unrelated toolbar actions. Sharing
	// has its own guard so it remains available while a local write settles.
	// Native sharing may settle after the sheet closes; keep its button visually
	// stable throughout, with aria-disabled and the guard preventing repeat shares.
	const run = async (action: () => Promise<void>, kind: 'mutation' | 'share' = 'mutation') => {
		if (pending.current[kind]) return;
		const setPending = kind === 'share' ? setSharing : setBusy;
		pending.current[kind] = true; setPending(true); setError(null);
		try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update this article.'); }
		finally { pending.current[kind] = false; setPending(false); }
	};
	const share = async () => {
		const ownerWindow = article.current?.ownerDocument.defaultView;
		if (!ownerWindow) return;
		const navigator = ownerWindow.navigator;
		try {
			if (navigator.share) await navigator.share({ title: item.title, url: item.source_url });
			else { await navigator.clipboard.writeText(item.source_url); setCopied(true); clearCopyTimer(); copyTimer.current = { window: ownerWindow, id: ownerWindow.setTimeout(() => setCopied(false), 2500) }; }
		} catch (cause) { if (!(cause instanceof Error && cause.name === 'AbortError')) throw cause; }
	};
	const html = useMemo(() => markdown === null ? '' : renderReadingText(markdown, item.source_url, highlightCode), [markdown, item.source_url, highlightCode]);
	useEffect(() => { if (focusHighlight) { setMode('article'); setTarget(focusHighlight); } }, [focusHighlight]);
	useEffect(() => {
		if (!target || mode !== 'article' || markdown === null) return;
		const ownerWindow = article.current?.ownerDocument.defaultView;
		if (!ownerWindow) return;
		const focusPassage = () => {
			const passage = body.current?.querySelector<HTMLElement>(`[data-highlight-start="${target.start}"]`);
			if (passage) {
				passage.focus({ preventScroll: true });
				passage.scrollIntoView({ block: 'center', behavior: floatingHighlights && !ownerWindow.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant' });
			}
			else setError('This passage changed. Find it in the article before highlighting again.');
			setTarget(null);
		};
		if (!targetAfterSheet.current) { focusPassage(); return; }
		// Let the closing sheet release its scroll lock and restore trigger focus first.
		const frame = ownerWindow.requestAnimationFrame(() => { targetAfterSheet.current = false; focusPassage(); });
		return () => ownerWindow.cancelAnimationFrame(frame);
	}, [target, mode, markdown, html, floatingHighlights]);
	const saveHighlights = async (highlights: ReadingHighlight[]) => {
		if (!onUpdate || markdown === null) throw new Error('Open the article before saving highlights.');
		const document = readingDocument(markdown);
		if (body.current && document.text !== body.current.textContent) throw new Error('This article contains unsupported formatting. Edit its highlights in Obsidian.');
		const prepared = writeMarkdownHighlights(markdown, highlights.map(highlight => anchorHighlight(document.text, highlight)));
		await onUpdate({ highlights: prepared.highlights });
	};
	const saveNote = async () => {
		if (!annotation) return;
		const current = item.highlights?.find(highlight => annotation.id ? highlight.id === annotation.id : highlight.start === annotation.start && highlight.end === annotation.end);
		if (!current || current.text !== annotation.text || current.note !== annotation.note) throw new Error('This highlight changed elsewhere. Your note is still here; copy it before reopening the highlight.');
		await saveHighlights((item.highlights ?? []).map(highlight => highlight === current ? { ...highlight, note: note.trim() } : highlight));
	};
	const perform = (action: () => void, close?: () => void) => {
		if (close) { sheetAction.current = action; close(); } else action();
	};
	const renderHighlights = (close?: () => void) => <>
		{!item.highlights?.length && <p className="crate-reading__notice">Select a passage in the article to save your first highlight.</p>}
		<HighlightList entries={(item.highlights ?? []).map(highlight => ({ item, highlight }))} disabled={busy || highlightsPending} onView={(_item, highlight) => perform(() => { targetAfterSheet.current = Boolean(close); setMode('article'); setTarget(highlight); }, close)} onAnnotate={onUpdate ? (_item, highlight) => perform(() => { setError(null); setAnnotation(highlight); setNote(highlight.note ?? ''); }, close) : undefined} />
		{!!item.highlight_recovery?.length && <details className="crate-reading__notice"><summary>{item.highlight_recovery.length} saved highlights need reselecting</summary><p>The original excerpts are preserved here. Select their current passages in the article to highlight them again.</p><HighlightList entries={item.highlight_recovery.map(highlight => ({ item, highlight }))} /></details>}
	</>;
	const minutes = useMemo(() => Math.max(1, Math.ceil((markdown ?? '').trim().split(/\s+/).length / 220)), [markdown]);
	return <article ref={article} tabIndex={-1} className="crate-reading crate-reading-reader" data-serif={serif} style={{ '--reading-font-size': `${fontSize}px` } as React.CSSProperties}>
		{floatingHighlights && <div className="crate-reading-reader__floating"><Button variant="outline" size="touch" className="crate-reading-reader__highlights-button" aria-label={`Highlights (${item.highlights?.length ?? 0})`} aria-haspopup="dialog" aria-expanded={highlightsOpen} onClick={() => setHighlightsOpen(true)}><ThemeIcon id="highlighter" size="m" aria-hidden="true" /><span>{item.highlights?.length ?? 0}</span></Button></div>}
		<nav className="crate-reading-reader__nav" aria-label="Article actions">
			<IconButton size="large" iconSize="l" icon="chevron-left" label="Back to reading" onClick={onBack} />
			<div className="crate-reading-reader__quick-actions">{onUpdate && <><IconButton size="large" icon={item.reading_status === 'archived' ? 'archive-restore' : 'archive'} label={item.reading_status === 'archived' ? 'Move to inbox' : 'Archive article'} disabled={mutationPending} aria-disabled={busy || mutationPending} onClick={() => void run(() => onUpdate({ reading_status: item.reading_status === 'archived' ? 'inbox' : 'archived' }))} /><IconButton size="large" icon="star" label={item.favorite ? 'Remove favorite' : 'Favorite article'} aria-pressed={item.favorite} data-filled={item.favorite} disabled={mutationPending} aria-disabled={busy || mutationPending} onClick={() => void run(() => onUpdate({ favorite: !item.favorite }))} /></>}</div>
		</nav>
		<div className="crate-reading-reader__page">
			{notice}
			{showHeader && <header className="crate-reading-reader__header">{item.source_url ? <a className="crate-reading-reader__source" href={item.source_url} target="_blank" rel="noopener noreferrer"><ReadingSourceIcon item={item} />{readingSource(item.source_url)}<ThemeIcon id="arrow-up-right" size="xs" aria-hidden="true" /></a> : <span className="crate-reading-reader__source"><ReadingSourceIcon item={item} />Vault note</span>}<h1 ref={heading} tabIndex={-1}>{item.title}</h1>
				<div className="crate-reading-reader__byline">{item.author && <span>{item.author}</span>}<time dateTime={item.saved_at}>{new Date(item.saved_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time>{markdown !== null && item.extraction_status === 'ready' && <span>{minutes} min read</span>}</div>
				<div className="crate-reading-reader__tools"><div className="crate-reading-reader__availability">{status && <span role="status"><ThemeIcon id="check" size="xs" aria-hidden="true" />{status}</span>}</div><IconButton size="large" icon="type" label="Reading appearance" onClick={() => setDialog('appearance')} />{onUpdate && <IconButton size="large" icon="hash" label="Edit article tags" disabled={mutationPending} onClick={() => { setTags(item.tags.join(', ')); setDialog('tags'); }} />}{onEdit && <IconButton size="large" icon="file-text" label="Open note" onClick={onEdit} />}{item.source_url && <IconButton size="large" icon={copied ? 'check' : 'share-2'} label={copied ? 'Link copied' : 'Share article'} aria-disabled={sharing} onClick={() => void run(share, 'share')} />}</div>
				{item.tags.length > 0 && <div className="crate-reading-reader__tags">{item.tags.map(tag => <span key={tag}>#{tag}</span>)}</div>}
			</header>}
			{error && <p role="alert" className="crate-reading__notice">{error}</p>}
			{copied && <span className="crate-reading__sr-only" role="status">Link copied</span>}
			{!floatingHighlights && <div className="crate-reading-reader__tabs" role="group" aria-label="Article view"><ToggleButton pressed={mode === 'article'} onPressedChange={() => setMode('article')}>Article</ToggleButton><ToggleButton pressed={mode === 'highlights'} onPressedChange={() => setMode('highlights')}>Highlights{item.highlights?.length ? ` (${item.highlights.length})` : ''}</ToggleButton></div>}
			{!floatingHighlights && mode === 'highlights' && renderHighlights()}
			<div hidden={mode !== 'article'}>
			{markdown !== null && item.extraction_status !== 'ready' && <p className="crate-reading__notice">{item.extraction_status === 'pending' ? 'Your link is saved. Article text is on its way.' : item.source_url ? 'Article text couldn’t be saved. You can still read the original.' : 'This note is empty.'}{onRetry && item.capture_method === 'url' && item.extraction_status === 'unavailable' && <Button variant="outline" disabled={busy || mutationPending} onClick={() => void run(onRetry)}>Try again</Button>}</p>}
			{markdown === null ? <div className="pwa-reading-article-opening__body">
				{loadingError ? <><p role="alert">{loadingError}</p><Button variant="outline" onClick={onRetryOpen}>Retry</Button></>
					: <LoadingIndicator label="Loading article" />}
			</div> : <ReadingBody body={body} article={article} html={html} highlights={item.highlights ?? []} />}
			{markdown !== null && item.extraction_status === 'ready' && <footer className="crate-reading-reader__end"><span aria-hidden="true">✦</span><p>You’ve reached the end.</p>{onUpdate && item.reading_status === 'inbox' && <Button variant="outline" disabled={mutationPending} aria-disabled={busy || mutationPending} onClick={() => void run(() => onUpdate({ reading_status: 'archived' }))}><ThemeIcon id="archive" size="m" aria-hidden="true" />Mark as read</Button>}</footer>}
			</div>
		</div>
		{onUpdate && markdown !== null && mode === 'article' && <ReadingHighlightActions key={item.crate_reading_id} body={body} article={article} content={html} highlights={item.highlights ?? []} disabled={busy || highlightsPending} onSave={saveHighlights} onCopyComplete={onCopyComplete} />}
		{floatingHighlights && highlightsOpen && <ReadingDialog title="Highlights" fullHeight onClose={() => { setHighlightsOpen(false); const action = sheetAction.current; sheetAction.current = null; action?.(); }}>{close => renderHighlights(close)}</ReadingDialog>}
		{annotation && <ReadingDialog title="Highlight note" busy={busy} onClose={() => setAnnotation(null)}>{close => <form className="crate-reading-reader__annotation" onSubmit={event => { event.preventDefault(); void run(async () => { await saveNote(); onSaveComplete?.('note'); close(); }); }}><blockquote>{annotation.text}</blockquote><label htmlFor="reading-highlight-note">Your note</label><textarea id="reading-highlight-note" data-initial-focus value={note} maxLength={4000} onChange={event => setNote(event.target.value)} disabled={busy || highlightsPending} />{error && <p role="alert">{error}</p>}<div className="crate-dialog-actions crate-reading-dialog__actions"><Button variant="outline" disabled={busy} onClick={close}>Cancel</Button><Button variant="primary" type="submit" disabled={busy || highlightsPending}>Save note</Button></div></form>}</ReadingDialog>}
		{dialog === 'appearance' && <ReadingDialog title="Reading appearance" onClose={() => setDialog(null)}><div className="crate-reading-reader__preferences"><span>Typeface</span><div className="crate-reading-reader__font-choice"><ToggleButton variant="outline" pressed={!serif} onPressedChange={() => setSerif(false)}>Modern<span>Sans serif</span></ToggleButton><ToggleButton variant="outline" pressed={serif} onPressedChange={() => setSerif(true)}>Literary<span>Serif</span></ToggleButton></div><div className="crate-reading-reader__font-size"><span>Text size</span><IconButton icon="minus" iconSize="s" label="Decrease text size" disabled={fontSize <= 16} onClick={() => setFontSize(size => Math.max(16, size - 1))} /><output aria-label="Text size" aria-live="polite">{fontSize}</output><IconButton icon="plus" iconSize="s" label="Increase text size" disabled={fontSize >= 26} onClick={() => setFontSize(size => Math.min(26, size + 1))} /></div><div className="crate-reading-reader__sample-frame"><p className="crate-reading-reader__sample" style={{ fontSize, fontFamily: serif ? 'Georgia, serif' : 'var(--font-interface)' }}>A little room to read.<br />A little space to think.</p></div></div></ReadingDialog>}
		{dialog === 'tags' && onUpdate && <ReadingDialog title="Article tags" busy={busy} onClose={() => setDialog(null)}>{close => <form className="crate-reading__capture" onSubmit={event => { event.preventDefault(); void run(async () => { await onUpdate({ tags: [...new Set(tags.split(',').map(tag => tag.trim().replace(/^#+/, '')).filter(Boolean))] }); onSaveComplete?.('tags'); close(); }); }}><TextField label="Tags, separated by commas" data-initial-focus value={tags} disabled={busy} placeholder="design, essays, inspiration" onChange={event => setTags(event.target.value)} />{error && <p role="alert">{error}</p>}<div className="crate-dialog-actions crate-reading-dialog__actions"><Button variant="outline" disabled={busy} onClick={close}>Cancel</Button><Button variant="primary" type="submit" disabled={busy}>Save tags</Button></div></form>}</ReadingDialog>}
	</article>;
}
