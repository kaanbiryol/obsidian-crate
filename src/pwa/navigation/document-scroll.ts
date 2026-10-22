// iOS scrolls only the document to the top when the status bar is tapped. A
// settled phone screen hands its list scroller to the document, and returns
// the offset to the embedded scroller before anything else moves the screen.

interface DocumentScrollOwner {
	element: HTMLElement;
	release: () => void;
}

let owner: DocumentScrollOwner | undefined;
let suspensions = 0;
const resumeListeners = new Set<() => void>();

type SavedStyle = [element: HTMLElement, property: string, value: string, priority: string];

function inFlow(position: string): boolean {
	return position === 'static' || position === 'relative' || position === 'sticky';
}

function opaqueBackground(element: HTMLElement): string {
	for (let current: HTMLElement | null = element; current; current = current.parentElement) {
		const color = getComputedStyle(current).backgroundColor;
		if (color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') return color;
	}
	return 'var(--background-primary)';
}

/**
 * Let `element` scroll the document. Its ancestors grow to its content up to
 * `boundary`, sibling chrome stays where it is drawn, and the scroll offset
 * moves to the document. Releasing reverses each step.
 */
function promote(element: HTMLElement, boundary: HTMLElement, onLayoutChange: () => void): () => void {
	const document = element.ownerDocument;
	const window = document.defaultView!;
	const root = document.documentElement;
	const top = element.scrollTop;
	const saved: SavedStyle[] = [];
	const set = (target: HTMLElement, property: string, value: string) => {
		saved.push([target, property, target.style.getPropertyValue(property), target.style.getPropertyPriority(property)]);
		target.style.setProperty(property, value, 'important');
	};

	// Measure everything before changing layout.
	const ownerBounds = element.getBoundingClientRect();
	const background = opaqueBackground(element);
	const inner: HTMLElement[] = [];
	for (let current = element.parentElement; current; current = current.parentElement) {
		inner.push(current);
		if (current === boundary) break;
	}
	const outer: HTMLElement[] = [];
	for (let current = boundary.parentElement; current && current !== root; current = current.parentElement) outer.push(current);
	// Visible siblings beside the path are chrome, such as headers, notices and
	// the dock. Collapsed boxes, like an idle pull-to-refresh area, stay in flow.
	// Offsets are measured once, so any resize hands the scroll back for a fresh
	// handoff: a notice appearing, or a pull-to-refresh indicator growing.
	const watched = new Set<HTMLElement>();
	const levels: { parent: HTMLElement; chrome: { element: HTMLElement; bounds: DOMRect; position: string; zIndex: string }[] }[] = [];
	// Screens behind a covering layer, such as a pushed project, would show
	// below its content when the document bounces. Hide them instead.
	const covered: HTMLElement[] = [];
	const stackLevel = (zIndex: string) => zIndex === 'auto' ? 0 : Number(zIndex);
	const contains = (outer: DOMRect, inner: DOMRect) => outer.left <= inner.left + 0.5 && outer.top <= inner.top + 0.5
		&& outer.right >= inner.right - 0.5 && outer.bottom >= inner.bottom - 0.5;
	const growth: { element: HTMLElement; position: string; detach: boolean }[] = [];
	const visibleSiblings = (target: HTMLElement) => Array.from(target.parentElement?.children ?? [])
		.filter((sibling): sibling is HTMLElement => sibling !== target && sibling instanceof HTMLElement && sibling.getClientRects().length > 0);
	for (const [index, target] of [element, ...inner].entries()) {
		const siblings = visibleSiblings(target).map(sibling => ({ sibling, style: getComputedStyle(sibling) }));
		if (target !== boundary && target.parentElement) {
			const targetStyle = getComputedStyle(target);
			const layer = inFlow(targetStyle.position) ? undefined : { bounds: target.getBoundingClientRect(), level: stackLevel(targetStyle.zIndex) };
			const chrome = [];
			for (const { sibling, style } of siblings) {
				watched.add(sibling);
				if (style.position === 'fixed' || sibling.offsetHeight === 0) continue;
				const bounds = sibling.getBoundingClientRect();
				if (layer && stackLevel(style.zIndex) < layer.level && contains(layer.bounds, bounds)) covered.push(sibling);
				else chrome.push({ element: sibling, bounds, position: style.position, zIndex: style.zIndex });
			}
			levels.unshift({ parent: target.parentElement, chrome });
		}
		if (index === 0) continue;
		const position = getComputedStyle(target).position;
		growth.push({ element: target, position, detach: !inFlow(position) && !siblings.some(({ style }) => inFlow(style.position)) });
	}

	// Grow the screen to its content; absolute layers without in-flow siblings join the flow.
	for (const { element: target, position, detach } of growth) {
		set(target, 'overflow', 'visible');
		set(target, 'height', 'auto');
		set(target, 'max-height', 'none');
		if (detach) {
			set(target, 'position', 'relative');
			set(target, 'inset', 'auto');
		} else if (!inFlow(position)) {
			set(target, 'bottom', 'auto');
		}
	}
	// Fixed chrome stays put while the document scrolls and bounces. Pin it
	// where it is drawn, outermost first, and keep the next in-flow box in place.
	for (const { parent, chrome } of levels) {
		if (chrome.length === 0) continue;
		const pinned = new Set(chrome.map(item => item.element));
		const anchor = Array.from(parent.children).find((child): child is HTMLElement => child instanceof HTMLElement
			&& !pinned.has(child) && child.getClientRects().length > 0 && inFlow(getComputedStyle(child).position));
		const anchorTop = anchor?.getBoundingClientRect().top ?? 0;
		for (const { element: target, bounds, position, zIndex } of chrome) {
			set(target, 'position', 'fixed');
			set(target, 'box-sizing', 'border-box');
			set(target, 'top', `${bounds.top}px`);
			set(target, 'left', `${bounds.left}px`);
			set(target, 'width', `${bounds.width}px`);
			// Absolute layers are sized by their insets, not their content.
			if (!inFlow(position)) set(target, 'height', `${bounds.height}px`);
			set(target, 'right', 'auto');
			set(target, 'bottom', 'auto');
			set(target, 'margin', '0');
			// Stay above the cover that hides rows passing under the header area.
			if (zIndex === 'auto' || Number(zIndex) < 10) set(target, 'z-index', '10');
		}
		if (!anchor) continue;
		const shift = anchorTop - anchor.getBoundingClientRect().top;
		if (Math.abs(shift) > 0.5) set(anchor, 'margin-top', `${parseFloat(getComputedStyle(anchor).marginTop) + shift}px`);
	}
	for (const target of covered) set(target, 'visibility', 'hidden');
	for (const target of outer) set(target, 'overflow', 'visible');
	// Bounces past either end reveal the document canvas; match the screen.
	set(root, 'background-color', background);
	set(element, 'overflow', 'visible');
	set(element, 'height', 'auto');
	set(element, 'flex', 'none');
	set(element, 'min-height', `${ownerBounds.height}px`);
	set(element, '--pwa-document-scroll-cover', `${ownerBounds.top}px`);
	set(element, '--pwa-document-scroll-bg', background);
	// Scrolling into view must stop below the header, as it did inside the list.
	set(root, 'scroll-padding-top', `${ownerBounds.top}px`);
	element.dataset.documentScroll = 'true';
	root.classList.add('pwa-document-scroll');
	window.scrollTo({ top, behavior: 'instant' });

	const sizes = new Map<Element, string>();
	const resizes = new ResizeObserver(entries => {
		let changed = false;
		for (const { target, borderBoxSize } of entries) {
			const size = borderBoxSize.map(box => `${Math.round(box.inlineSize)}x${Math.round(box.blockSize)}`).join();
			if (sizes.has(target) && sizes.get(target) !== size) changed = true;
			sizes.set(target, size);
		}
		if (changed) onLayoutChange();
	});
	for (const target of watched) resizes.observe(target);

	return () => {
		resizes.disconnect();
		const offset = window.scrollY;
		delete element.dataset.documentScroll;
		root.classList.remove('pwa-document-scroll');
		for (const [target, property, value, priority] of saved.reverse()) {
			if (value) target.style.setProperty(property, value, priority);
			else target.style.removeProperty(property);
		}
		window.scrollTo({ top: 0, behavior: 'instant' });
		element.scrollTop = offset;
	};
}

export function documentScrollOwner(): HTMLElement | undefined {
	return owner?.element;
}

export function documentScrollSuspended(): boolean {
	return suspensions > 0;
}

export function claimDocumentScroll(element: HTMLElement, boundary: HTMLElement): void {
	if (suspensions > 0 || owner?.element === element) return;
	releaseDocumentScroll();
	const current: DocumentScrollOwner = { element, release: promote(element, boundary, () => {
		if (owner !== current) return;
		releaseDocumentScroll();
		for (const listener of resumeListeners) listener();
	}) };
	owner = current;
}

export function releaseDocumentScroll(): void {
	const current = owner;
	owner = undefined;
	current?.release();
}

/** Return the document to the app while a reader or sheet controls it. */
export function suspendDocumentScroll(): () => void {
	suspensions++;
	releaseDocumentScroll();
	let resumed = false;
	return () => {
		if (resumed) return;
		resumed = true;
		if (--suspensions === 0) for (const listener of resumeListeners) listener();
	};
}

export function onDocumentScrollResume(listener: () => void): () => void {
	resumeListeners.add(listener);
	return () => resumeListeners.delete(listener);
}
