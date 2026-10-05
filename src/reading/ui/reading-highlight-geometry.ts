type Box = { left: number; top: number; width: number; height: number };
type Rect = Box & { right: number; bottom: number };
export type HighlightGeometry = { boxes: Box[]; start: Box; end: Box; menu: { left: number; top: number }; feedback: { left: number; top: number } };

/** Place the selection overlay in reader coordinates, clear of the header and handles. */
export function readingHighlightGeometry({ rects, bounds, scrollTop, viewportHeight, navigationBottom, headingBottom }: {
	rects: Rect[]; bounds: Rect; scrollTop: number; viewportHeight: number;
	navigationBottom?: number; headingBottom?: number;
}): HighlightGeometry | null {
	if (!rects.length) return null;
	const convert = (rect: Rect): Box => ({ left: rect.left - bounds.left, top: rect.top - bounds.top + scrollTop, width: rect.width, height: rect.height });
	// Nested inline elements can contribute identical rectangles. Paint each area once.
	const boxes = rects.filter((rect, index) => !rects.some((other, otherIndex) => otherIndex < index && other.left <= rect.left && other.right >= rect.right && other.top <= rect.top && other.bottom >= rect.bottom)).map(convert);
	const first = convert(rects[0]!), last = convert(rects.at(-1)!);
	const viewportBottom = Math.min(bounds.bottom, viewportHeight);
	const navBottom = Math.max(0, navigationBottom ?? bounds.top);
	const firstRect = rects[0]!, lastRect = rects.at(-1)!;
	// Center the action over the passage instead of trailing its final line.
	// Keep the toolbar close, with extra clearance only where it crosses a handle.
	const passageLeft = Math.min(...rects.map(rect => rect.left));
	const passageRight = Math.max(...rects.map(rect => rect.right));
	const left = Math.max(12, Math.min(bounds.width - 220, (passageLeft + passageRight) / 2 - bounds.left - 104));
	const clearsHandles = [firstRect.left, lastRect.right].every(x => x + 22 <= bounds.left + left || x - 22 >= bounds.left + left + 208);
	const gap = clearsHandles ? 8 : 28;
	const above = firstRect.top - 52 - gap;
	const below = lastRect.bottom + gap;
	const headerBottom = headingBottom ?? navBottom;
	const desiredY = above >= Math.max(navBottom, headerBottom) + 8 ? above : below;
	const menuY = Math.max(navBottom + 8, Math.min(viewportBottom - 64, desiredY));
	const feedbackY = menuY + 156 <= viewportBottom ? menuY + 60 : Math.max(navBottom + 8, menuY - 112);
	return { boxes, start: first, end: last,
		menu: { left, top: menuY - bounds.top + scrollTop },
		feedback: { left: Math.max(12, Math.min(bounds.width - 232, left)), top: feedbackY - bounds.top + scrollTop },
	};
}
