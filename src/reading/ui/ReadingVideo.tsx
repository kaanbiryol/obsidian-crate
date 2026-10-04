import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/ui/shared/Button';
import { ToggleButton } from '@/ui/shared/ToggleButton';
import { youtubeMomentUrl, youtubeStartTime } from '../core/youtube';
import { connectYoutubePlayer } from './youtube-player';
import { getEditorSelectionRange } from '@/reminders/utils/editorSelection';
import { revealTranscriptPassage, stopTranscriptScroll } from './transcript-scroll';
import { ThemeIcon } from '@/ui/shared/ThemeIcon';
import { useReadingVideoSize } from './useReadingVideoSize';

export function ReadingVideoThumbnail({ id, large = false }: { id: string; large?: boolean }) {
	const [failed, setFailed] = useState(false), [loaded, setLoaded] = useState(false);
	return <span className="crate-reading-video__thumbnail" data-large={large} aria-hidden="true">
		{!failed && <img src={`https://i.ytimg.com/vi/${id}/${large ? 'hqdefault' : 'mqdefault'}.jpg`} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" data-loaded={loaded} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />}
		<span className="crate-reading-video__play"><ThemeIcon id="play" size={large ? 'l' : 's'} aria-hidden="true" /></span>
	</span>;
}

export function ReadingVideo({ id, source, body, content, hasTranscript, pinned, onPinnedChange, seekTarget }: {
	id: string; source: string; body: React.RefObject<HTMLDivElement | null>;
	content: DocumentFragment | null; hasTranscript: boolean; pinned: boolean; onPinnedChange: (pinned: boolean) => void;
	seekTarget?: { seconds: number; reveal?: boolean } | null;
}) {
	const [selected, setSelected] = useState(() => youtubeStartTime(source));
	const [startedAt, setStartedAt] = useState<number | null>(null);
	const [failed, setFailed] = useState(false);
	const frame = useRef<HTMLIFrameElement>(null), container = useRef<HTMLDivElement>(null);
	const size = useReadingVideoSize(container);
	const pinnedInView = hasTranscript && pinned && size.fits;
	const bridge = useRef<ReturnType<typeof connectYoutubePlayer> | null>(null);
	const pendingPlay = useRef<number | null>(null);
	const following = useRef(pinned), held = useRef(false), lastTime = useRef<number | null>(null);
	const active = useRef<HTMLElement | undefined>(undefined);
	const transcriptNodes = useRef<{ element: HTMLElement; seconds: number }[]>([]);
	following.current = pinnedInView;
	const src = useMemo(() => {
		if (startedAt === null) return undefined;
		const url = new URL(`https://www.youtube-nocookie.com/embed/${id}`);
		url.search = new URLSearchParams({ enablejsapi: '1', playsinline: '1', autoplay: '1', start: String(startedAt) }).toString();
		if (/^https?:$/.test(window.location.protocol)) url.searchParams.set('origin', window.location.origin);
		return url.href;
	}, [id, startedAt]);
	const reveal = useCallback((element: HTMLElement) => {
		const player = container.current, reader = body.current?.closest<HTMLElement>('.crate-reading-reader');
		if (player && reader) revealTranscriptPassage(element, player, reader);
	}, [body]);
	const seek = useCallback((seconds: number) => {
		setSelected(seconds); setFailed(false);
		if (bridge.current) bridge.current.playAt(seconds);
		else { pendingPlay.current = seconds; setStartedAt(start => start ?? seconds); }
	}, []);
	useEffect(() => {
		if (!seekTarget) return;
		seek(seekTarget.seconds);
		if (following.current && seekTarget.reveal !== false) {
			const passage = transcriptNodes.current.find(node => node.seconds === seekTarget.seconds);
			if (passage) reveal(passage.element);
		}
	}, [seekTarget, seek, reveal]);
	useEffect(() => {
		const reader = container.current?.closest<HTMLElement>('.crate-reading-reader');
		if (!reader) return;
		if (pinnedInView && active.current && !size.resizing.current) reveal(active.current);
		else if (!pinnedInView) stopTranscriptScroll(reader);
		return () => stopTranscriptScroll(reader);
	}, [body, pinnedInView, reveal, size.resizing]);
	useEffect(() => {
		const root = body.current;
		if (!root) return;
		transcriptNodes.current = Array.from(root.querySelectorAll<HTMLElement>('[data-transcript-seconds]')).map(element => ({ element, seconds: Number(element.dataset.transcriptSeconds) }));
		const activate = (event: Event) => {
			if (event.type === 'keydown' && !['Enter', ' '].includes((event as KeyboardEvent).key)) return;
			const element = event.target as Element | null;
			const target = element?.nodeType === 1 ? element.closest<HTMLElement>('[data-transcript-seconds]') : null;
			if (!target || !root.contains(target) || element?.closest('.crate-reading-reader__highlight')) return;
			// Links and saved highlights retain their own actions; timestamps still seek.
			if (element?.closest('a,button,[role="button"]') && !element.closest('[data-transcript-seek]')) return;
			const selection = getEditorSelectionRange(root);
			if (event.type === 'click' && selection && !selection.collapsed) return;
			event.preventDefault(); seek(Number(target.dataset.transcriptSeconds));
		};
		root.addEventListener('click', activate); root.addEventListener('keydown', activate);
		return () => { root.removeEventListener('click', activate); root.removeEventListener('keydown', activate); };
	}, [body, content, seek]);
	useEffect(() => {
		const root = body.current, reader = root?.closest<HTMLElement>('.crate-reading-reader');
		if (!root || !reader) return;
		const doc = root.ownerDocument;
		const down = () => { held.current = true; stopTranscriptScroll(reader); };
		const up = () => { held.current = false; };
		const cancel = (event: PointerEvent) => { if (event.pointerType !== 'touch') up(); };
		reader.addEventListener('pointerdown', down);
		doc.addEventListener('pointerup', up); doc.addEventListener('pointercancel', cancel);
		doc.addEventListener('touchend', up); doc.addEventListener('touchcancel', up); doc.defaultView?.addEventListener('blur', up);
		return () => {
			reader.removeEventListener('pointerdown', down);
			doc.removeEventListener('pointerup', up); doc.removeEventListener('pointercancel', cancel);
			doc.removeEventListener('touchend', up); doc.removeEventListener('touchcancel', up); doc.defaultView?.removeEventListener('blur', up);
		};
	}, [body, content]);
	useEffect(() => {
		const iframe = frame.current;
		if (!iframe) return;
		const player = connectYoutubePlayer(iframe, seconds => {
			const segments = transcriptNodes.current;
			let low = 0, high = segments.length;
			while (low < high) { const middle = Math.floor((low + high) / 2); if (segments[middle]!.seconds <= seconds) low = middle + 1; else high = middle; }
			const next = segments[low - 1]?.element;
			const changed = next !== active.current, jumped = lastTime.current === null || Math.abs(seconds - lastTime.current) > 1.5;
			lastTime.current = seconds;
			if (changed) { active.current?.removeAttribute('data-playing'); next?.setAttribute('data-playing', 'true'); active.current = next; }
			const root = body.current, selection = root && getEditorSelectionRange(root);
			const editing = root?.closest('.crate-reading-reader')?.querySelector('.crate-reading-reader__highlight-editor');
			if (following.current && next && (changed || jumped) && !held.current && !size.resizing.current && (!selection || selection.collapsed) && !editing) reveal(next);
		}, () => setFailed(true));
		bridge.current = player;
		if (pendingPlay.current !== null) { player.playAt(pendingPlay.current); pendingPlay.current = null; }
		const doc = iframe.ownerDocument;
		const pause = () => { if (doc.hidden || !iframe.getClientRects().length || container.current?.closest('[inert],[hidden],[aria-hidden="true"]')) player.pause(); };
		const observer = new MutationObserver(pause);
		let parent: Element | null = container.current;
		while (parent) {
			observer.observe(parent, { attributes: true, attributeFilter: ['inert', 'hidden', 'aria-hidden', 'style', 'class'] });
			const root = parent.getRootNode();
			parent = parent.parentElement ?? ('host' in root ? (root as ShadowRoot).host : null);
		}
		doc.addEventListener('visibilitychange', pause);
		return () => { bridge.current = null; player.dispose(); observer.disconnect(); doc.removeEventListener('visibilitychange', pause); active.current?.removeAttribute('data-playing'); active.current = undefined; };
	}, [src, body, reveal, size.resizing]);
	return <div ref={container} className="crate-reading-video" data-pinned={pinnedInView} data-resizing={size.dragging} style={size.style}>
		{src ? <iframe ref={frame} className="crate-reading-video__player" src={src} title="YouTube video player" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" referrerPolicy="strict-origin-when-cross-origin" allowFullScreen />
			: <Button className="crate-reading-video__watch" aria-label="Play video" onClick={() => seek(selected)}>
				<ReadingVideoThumbnail key={id} id={id} large />
			</Button>}
		<div className="crate-reading-video__resize" {...size.handle}><span aria-hidden="true" /></div>
		{(hasTranscript || failed) && <div className="crate-reading-video__controls">
			{hasTranscript && <ToggleButton className="crate-reading-video__pin" variant="outline" size="touch" pressed={pinnedInView} onPressedChange={next => { if (next) size.fitToPin(); onPinnedChange(next); }}>
				<ThemeIcon id={pinnedInView ? 'pin-off' : 'pin'} size="m" aria-hidden="true" />{pinnedInView ? 'Unpin video' : 'Pin video'}
			</ToggleButton>}
			{failed && <a href={youtubeMomentUrl(source, selected)} target="_blank" rel="noopener noreferrer">Open in YouTube</a>}
		</div>}
		{failed && <p className="crate-reading-video__hint">This video could not play here.</p>}
	</div>;
}
