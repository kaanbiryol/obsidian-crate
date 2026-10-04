import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { stopTranscriptScroll } from './transcript-scroll';

type Geometry = { width: number; column: number; height: number; top: number; playerHeight: number; chrome: number };
type Drag = { pointer: number; y: number; width: number; previous: number | null; handle: HTMLElement };
const ASPECT = 16 / 9;
const TRANSCRIPT_SPACE = 96;
const RESIZING_CLASS = 'crate-reading-reader--resizing-video';

/** The player can break out of the text column, but never out of its reader pane. */
export function useReadingVideoSize(container: RefObject<HTMLDivElement | null>) {
	const [fraction, setFraction] = useState<number | null>(null);
	const [geometry, setGeometry] = useState<Geometry>({ width: 0, column: 0, height: 0, top: 0, playerHeight: 0, chrome: 0 });
	const [dragging, setDragging] = useState(false);
	const drag = useRef<Drag | null>(null), resizing = useRef(false);
	const cancel = useRef<() => void>(() => {});
	const anchor = useRef<{ element: HTMLElement; previous: boolean; frame: number; win: Window } | null>(null);
	const releaseAnchoring = useCallback((defer: boolean) => {
		const current = anchor.current;
		if (!current) return;
		const restore = () => {
			current.win.cancelAnimationFrame(current.frame);
			if (!current.previous) current.element.classList.remove(RESIZING_CLASS);
			anchor.current = null;
		};
		if (defer) { if (!current.frame) current.frame = current.win.requestAnimationFrame(restore); }
		else restore();
	}, []);
	// Leave a pixel for rounding between the 16:9 media box and offsetHeight.
	const fittingWidth = Math.min(geometry.width, Math.max(1, Math.floor((geometry.height - geometry.top - geometry.chrome - TRANSCRIPT_SPACE - 1) * ASPECT)));
	const minimum = Math.min(240, geometry.width, fittingWidth);
	const defaultWidth = Math.min(geometry.column, Math.max(240, (geometry.height - geometry.top - 64) * .45 * ASPECT));
	const width = Math.min(geometry.width, Math.max(minimum, fraction === null ? defaultWidth : geometry.width * fraction));
	const fits = !geometry.height || geometry.playerHeight <= geometry.height - geometry.top - TRANSCRIPT_SPACE;

	useLayoutEffect(() => {
		const player = container.current, reader = player?.closest<HTMLElement>('.crate-reading-reader');
		const column = player?.parentElement, win = player?.ownerDocument.defaultView;
		if (!player || !reader || !column || !win) return;
		const nav = reader.querySelector<HTMLElement>('.crate-reading-reader__nav');
		const measure = () => {
			if (!player.getClientRects().length || !reader.clientWidth) return;
			const media = player.querySelector<HTMLElement>('.crate-reading-video__player, .crate-reading-video__watch');
			const next: Geometry = {
				width: reader.clientWidth, column: column.clientWidth,
				height: reader.dataset.documentScroll === 'true' ? win.innerHeight : Math.min(reader.clientHeight, win.innerHeight),
				top: (nav?.offsetHeight ?? 0) + (nav ? parseFloat(win.getComputedStyle(nav).top) || 0 : 0),
				// Both pin states and the preview use the same box geometry.
				playerHeight: player.offsetHeight,
				chrome: player.offsetHeight - (media?.offsetHeight ?? 0),
			};
			setGeometry(previous => Object.keys(next).every(key => previous[key as keyof Geometry] === next[key as keyof Geometry]) ? previous : next);
		};
		measure();
		const observer = new ResizeObserver(measure);
		for (const node of [reader, column, player, nav]) if (node) observer.observe(node);
		const blur = () => cancel.current();
		const visibility = () => { if (player.ownerDocument.hidden) blur(); };
		win.addEventListener('resize', measure); win.addEventListener('blur', blur);
		player.ownerDocument.addEventListener('visibilitychange', visibility);
		return () => {
			const current = drag.current; drag.current = null; resizing.current = false;
			releaseAnchoring(false);
			if (current?.handle.hasPointerCapture(current.pointer)) current.handle.releasePointerCapture(current.pointer);
			observer.disconnect(); win.removeEventListener('resize', measure); win.removeEventListener('blur', blur);
			player.ownerDocument.removeEventListener('visibilitychange', visibility);
		};
	}, [container, releaseAnchoring]);

	const stopFollowing = () => {
		const reader = container.current?.closest<HTMLElement>('.crate-reading-reader');
		if (!reader) return;
		stopTranscriptScroll(reader);
		// Otherwise browser anchoring follows the growing transcript below the
		// player, moving the page by exactly the amount the handle was dragged.
		if (anchor.current) { anchor.current.win.cancelAnimationFrame(anchor.current.frame); anchor.current.frame = 0; }
		else {
			anchor.current = { element: reader, win: reader.ownerDocument.defaultView!,
				previous: reader.classList.contains(RESIZING_CLASS), frame: 0 };
			reader.classList.add(RESIZING_CLASS);
		}
	};
	const changeWidth = (next: number) => { if (geometry.width) setFraction(Math.min(geometry.width, Math.max(minimum, next)) / geometry.width); };
	const fitToPin = () => {
		if (fits || !geometry.width) return;
		stopFollowing(); changeWidth(Math.min(width, fittingWidth)); releaseAnchoring(true);
	};
	const finish = (restore: boolean) => {
		const current = drag.current;
		drag.current = null; resizing.current = false; setDragging(false);
		releaseAnchoring(true);
		if (!current) return;
		if (restore) setFraction(current.previous);
		if (current.handle.hasPointerCapture(current.pointer)) current.handle.releasePointerCapture(current.pointer);
	};
	cancel.current = () => finish(true);
	const onPointerDown = (event: PointerEvent<HTMLElement>) => {
		if (event.button !== 0 || !event.isPrimary || !geometry.width) return;
		event.preventDefault(); stopFollowing();
		drag.current = { pointer: event.pointerId, y: event.clientY, width, previous: fraction, handle: event.currentTarget };
		resizing.current = true; setDragging(true); event.currentTarget.focus({ preventScroll: true });
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const onPointerMove = (event: PointerEvent<HTMLElement>) => {
		const current = drag.current;
		if (!current || event.pointerId !== current.pointer) return;
		event.preventDefault(); changeWidth(current.width + (event.clientY - current.y) * ASPECT);
	};
	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.key === 'Escape') { if (drag.current) { event.preventDefault(); finish(true); } return; }
		const step = geometry.width * (event.shiftKey ? .1 : .025);
		const next = { ArrowUp: width - step, ArrowLeft: width - step, ArrowDown: width + step, ArrowRight: width + step,
			Home: minimum, End: geometry.width, PageUp: width - geometry.width * .1, PageDown: width + geometry.width * .1 }[event.key];
		if (next === undefined) return;
		event.preventDefault(); stopFollowing(); resizing.current = true; changeWidth(next);
	};
	return {
		resizing, dragging, fits, fitToPin,
		style: { ...(geometry.width ? { '--reading-video-width': `${width}px`, '--reading-video-reader-width': `${geometry.width}px` } : {}), '--reading-video-top': `${geometry.top}px` } as CSSProperties,
		handle: {
			role: 'separator', tabIndex: 0, 'aria-label': 'Resize video', 'aria-orientation': 'horizontal' as const,
			'aria-valuemin': geometry.width ? Math.round(minimum / geometry.width * 100) : 0, 'aria-valuemax': 100,
			'aria-valuenow': geometry.width ? Math.round(width / geometry.width * 100) : 100,
			'aria-valuetext': `${geometry.width ? Math.round(width / geometry.width * 100) : 100}% of reader width`,
			title: 'Drag up or down to resize. Double-click to reset.',
			onPointerDown, onPointerMove,
			onPointerUp: (event: PointerEvent<HTMLElement>) => { if (drag.current?.pointer === event.pointerId) finish(false); },
			onPointerCancel: () => finish(true), onLostPointerCapture: () => { if (drag.current) finish(true); },
			onKeyDown, onKeyUp: () => { resizing.current = false; releaseAnchoring(true); }, onBlur: () => finish(true),
			onDoubleClick: () => { stopFollowing(); setFraction(null); releaseAnchoring(true); },
		},
	};
}
