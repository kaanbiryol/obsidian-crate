import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowUpRight, Check } from 'lucide-react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { Button } from '../../ui/shared/Button';
import { IconButton } from '../../ui/shared/IconButton';
import { ToggleButton } from '../../ui/shared/ToggleButton';
import type { ReadingMetadata, ReadingChanges } from '../core/model';
import { ReadingDialog } from './ReadingDialog';
import { readingSource } from './reading-presentation';

const markdownParser = new Marked({ async: false, gfm: true });

/** All article HTML is untrusted, including content captured by Web Clipper. */
function renderReadingText(markdown: string, source: string): string {
	const html = markdownParser.parse(markdown, { async: false });
	const container = DOMPurify.sanitize(html, {
		RETURN_DOM: true,
		ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code', 'a', 'blockquote', 'ul', 'ol', 'li', 'em', 'strong', 'b', 'i', 's', 'del', 'mark', 'sup', 'sub', 'br', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td'],
		ALLOWED_ATTR: ['href', 'title', 'colspan', 'rowspan'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
	}) as HTMLElement; // RETURN_DOM with WHOLE_DOCUMENT disabled returns the sanitized body.
	for (const link of Array.from(container.querySelectorAll('a'))) {
		const unlink = () => link.replaceWith(...Array.from(link.childNodes));
		try {
			const href = link.getAttribute('href');
			if (!href) { unlink(); continue; }
			const url = new URL(href, source);
			if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { unlink(); continue; }
			link.setAttribute('href', url.href); link.setAttribute('target', '_blank'); link.setAttribute('rel', 'noopener noreferrer');
		} catch { unlink(); }
	}
	return container.innerHTML;
}

export function ReadingReader({ item, markdown, onBack, onEdit, onUpdate, status, onRetry, notice }: {
	item: ReadingMetadata; markdown: string; onBack: () => void; onEdit?: () => void; onUpdate?: (changes: ReadingChanges) => Promise<void>;
	status?: string; onRetry?: () => Promise<void>; notice?: React.ReactNode;
}) {
	const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
	const [dialog, setDialog] = useState<'appearance' | 'tags' | null>(null), [tags, setTags] = useState('');
	const [fontSize, setFontSize] = useState(19), [serif, setSerif] = useState(false), [copied, setCopied] = useState(false);
	const pending = useRef(false), article = useRef<HTMLElement>(null), heading = useRef<HTMLHeadingElement>(null);
	const copyTimer = useRef<{ window: Window; id: number } | undefined>(undefined);
	const clearCopyTimer = () => { if (copyTimer.current) copyTimer.current.window.clearTimeout(copyTimer.current.id); };
	useEffect(() => {
		article.current?.scrollTo({ top: 0 }); heading.current?.focus({ preventScroll: true });
		setError(null); setCopied(false); setDialog(null);
		return clearCopyTimer;
	}, [item.crate_reading_id]);
	const run = async (action: () => Promise<void>) => {
		if (pending.current) return;
		pending.current = true; setBusy(true); setError(null);
		try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update this article.'); }
		finally { pending.current = false; setBusy(false); }
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
	const html = useMemo(() => renderReadingText(markdown, item.source_url), [markdown, item.source_url]);
	const minutes = useMemo(() => Math.max(1, Math.ceil(markdown.trim().split(/\s+/).length / 220)), [markdown]);
	return <article ref={article} className="crate-reading crate-reading-reader" data-serif={serif} style={{ '--reading-font-size': `${fontSize}px` } as React.CSSProperties}>
		<nav className="crate-reading-reader__nav" aria-label="Article actions">
			<IconButton size="large" iconSize="l" icon="chevron-left" label="Back to reading" onClick={onBack} />
			<div className="crate-reading-reader__mode"><span>Reader</span><a href={item.source_url} target="_blank" rel="noopener noreferrer">Original<ArrowUpRight size={13} aria-hidden="true" /></a></div>
			<div className="crate-reading-reader__quick-actions">{onUpdate && <><IconButton size="large" icon={item.reading_status === 'archived' ? 'archive-restore' : 'archive'} label={item.reading_status === 'archived' ? 'Move to inbox' : 'Archive article'} disabled={busy} onClick={() => void run(() => onUpdate({ reading_status: item.reading_status === 'archived' ? 'inbox' : 'archived' }))} /><IconButton size="large" icon="star" label={item.favorite ? 'Remove favorite' : 'Favorite article'} aria-pressed={item.favorite} data-filled={item.favorite} disabled={busy} onClick={() => void run(() => onUpdate({ favorite: !item.favorite }))} /></>}</div>
		</nav>
		<div className="crate-reading-reader__page">
			{notice}
			<header className="crate-reading-reader__header"><a className="crate-reading-reader__source" href={item.source_url} target="_blank" rel="noopener noreferrer"><span className="crate-reading__source-icon" aria-hidden="true">{readingSource(item.source_url).slice(0, 1).toUpperCase()}</span>{readingSource(item.source_url)}<ArrowUpRight size={14} aria-hidden="true" /></a><h1 ref={heading} tabIndex={-1}>{item.title}</h1>
				<div className="crate-reading-reader__byline">{item.author && <span>{item.author}</span>}<time dateTime={item.saved_at}>{new Date(item.saved_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time>{item.extraction_status === 'ready' && <span>{minutes} min read</span>}</div>
				<div className="crate-reading-reader__tools"><div className="crate-reading-reader__availability">{status && <span role="status"><Check size={13} aria-hidden="true" />{status}</span>}</div><IconButton size="large" icon="type" label="Reading appearance" onClick={() => setDialog('appearance')} />{onUpdate && <IconButton size="large" icon="hash" label="Edit article tags" onClick={() => { setTags(item.tags.join(', ')); setDialog('tags'); }} />}{onEdit && <IconButton size="large" icon="file-text" label="Open note" onClick={onEdit} />}<IconButton size="large" icon={copied ? 'check' : 'share-2'} label={copied ? 'Link copied' : 'Share article'} disabled={busy} onClick={() => void run(share)} /></div>
				{item.tags.length > 0 && <div className="crate-reading-reader__tags">{item.tags.map(tag => <span key={tag}>#{tag}</span>)}</div>}
			</header>
			{error && <p role="alert" className="crate-reading__notice">{error}</p>}
			{copied && <span className="crate-reading__sr-only" role="status">Link copied</span>}
			{item.extraction_status !== 'ready' && <p className="crate-reading__notice">{item.extraction_status === 'pending' ? 'Your link is saved. Article text is on its way.' : 'Article text couldn’t be saved. You can still read the original.'}{onRetry && item.extraction_status === 'unavailable' && <Button variant="outline" disabled={busy} onClick={() => void run(onRetry)}>Try again</Button>}</p>}
			<div className="crate-reading-reader__body" dangerouslySetInnerHTML={{ __html: html }} />
			{item.extraction_status === 'ready' && <footer className="crate-reading-reader__end"><span aria-hidden="true">✦</span><p>You’ve reached the end.</p>{onUpdate && item.reading_status === 'inbox' && <Button variant="outline" disabled={busy} onClick={() => void run(() => onUpdate({ reading_status: 'archived' }))}><Archive size={17} />Mark as read</Button>}</footer>}
		</div>
		{dialog === 'appearance' && <ReadingDialog title="Reading appearance" onClose={() => setDialog(null)}><div className="crate-reading-reader__preferences"><span>Typeface</span><div className="crate-reading-reader__font-choice"><ToggleButton variant="outline" pressed={!serif} onPressedChange={() => setSerif(false)}>Modern<span>Sans serif</span></ToggleButton><ToggleButton variant="outline" pressed={serif} onPressedChange={() => setSerif(true)}>Literary<span>Serif</span></ToggleButton></div><div className="crate-reading-reader__font-size"><span>Text size</span><Button variant="outline" aria-label="Decrease text size" disabled={fontSize <= 16} onClick={() => setFontSize(size => size - 1)}>A−</Button><output aria-label="Text size">{fontSize}</output><Button variant="outline" aria-label="Increase text size" disabled={fontSize >= 26} onClick={() => setFontSize(size => size + 1)}>A+</Button></div><p className="crate-reading-reader__sample" style={{ fontSize, fontFamily: serif ? 'Georgia, serif' : 'var(--font-interface)' }}>A little room to read.<br />A little space to think.</p></div></ReadingDialog>}
		{dialog === 'tags' && onUpdate && <ReadingDialog title="Article tags" busy={busy} onClose={() => setDialog(null)}><form className="crate-reading__capture" onSubmit={event => { event.preventDefault(); void run(async () => { await onUpdate({ tags: [...new Set(tags.split(',').map(tag => tag.trim()).filter(Boolean))] }); setDialog(null); }); }}><label>Tags, separated by commas<input data-initial-focus value={tags} disabled={busy} placeholder="design, essays, inspiration" onChange={event => setTags(event.target.value)} /></label>{error && <p role="alert">{error}</p>}<div className="crate-reading-dialog__actions"><Button variant="outline" disabled={busy} onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" type="submit" disabled={busy}>Save tags</Button></div></form></ReadingDialog>}
	</article>;
}
