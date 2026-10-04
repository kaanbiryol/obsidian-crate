import { readerScrollElement } from './reader-scroll';
import { animate, motionValue, type MotionValue } from 'motion';
import { PWA_SURFACE_SPRING } from '@/ui/shared/navigation/motion';

const positions = new WeakMap<HTMLElement, MotionValue<number>>();

/** Scroll only the reader, leaving enough room below the stationary video. */
export function revealTranscriptPassage(element: HTMLElement, player: HTMLElement, reader: HTMLElement): void {
	const win = reader.ownerDocument.defaultView;
	if (!win || !element.getClientRects().length) return;
	const scroll = readerScrollElement(reader), bounds = scroll.getBoundingClientRect();
	const documentScroll = scroll === reader.ownerDocument.scrollingElement;
	const top = documentScroll ? 0 : bounds.top;
	const bottom = Math.min(win.innerHeight, documentScroll ? win.innerHeight : bounds.bottom);
	const stickyTop = parseFloat(win.getComputedStyle(player).top) || 0;
	const visibleTop = top + stickyTop + player.offsetHeight + 20;
	const space = Math.max(0, bottom - visibleTop - 64);
	const passage = element.getBoundingClientRect();
	const desired = visibleTop + Math.max(0, (space - passage.height) / 3);
	const target = Math.max(0, Math.min(scroll.scrollHeight - scroll.clientHeight, scroll.scrollTop + passage.top - desired));
	if (Math.abs(target - scroll.scrollTop) < 2) { stopTranscriptScroll(reader); return; }
	if (win.matchMedia('(prefers-reduced-motion: reduce)').matches || reader.ownerDocument.body.classList.contains('reduce-motion')) {
		stopTranscriptScroll(reader); scroll.scrollTo({ top: target, behavior: 'instant' }); return;
	}
	let position = positions.get(scroll);
	if (!position) {
		position = motionValue(scroll.scrollTop);
		position.on('change', value => scroll.scrollTo({ top: value, behavior: 'instant' }));
		positions.set(scroll, position);
	} else if (Math.abs(position.get() - scroll.scrollTop) > 2) position.jump(scroll.scrollTop);
	// Reuse the shared spring and retain velocity when a seek interrupts following.
	// Owning this animation also makes unpinning stop synchronously.
	void animate(position, target, PWA_SURFACE_SPRING);
}

export function stopTranscriptScroll(reader: HTMLElement): void {
	const scroll = readerScrollElement(reader);
	positions.get(scroll)?.destroy();
	positions.delete(scroll);
}
