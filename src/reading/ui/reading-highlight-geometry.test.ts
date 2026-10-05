import { describe, expect, it } from 'vitest';
import { readingHighlightGeometry } from './reading-highlight-geometry';

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });

describe('reading highlight geometry', () => {
	it('paints nested inline rectangles once in scrolled reader coordinates', () => {
		const geometry = readingHighlightGeometry({
			bounds: rect(30, 50, 390, 700), scrollTop: 200, viewportHeight: 844,
			rects: [rect(50, 300, 320, 24), rect(80, 300, 60, 24), rect(50, 324, 180, 24)],
		});
		expect(geometry?.boxes).toEqual([
			{ left: 20, top: 450, width: 320, height: 24 },
			{ left: 20, top: 474, width: 180, height: 24 },
		]);
		expect(geometry?.start).toEqual(geometry?.boxes[0]);
		expect(geometry?.end).toEqual(geometry?.boxes[1]);
	});

	it('places the toolbar below a passage when its header blocks the space above', () => {
		const geometry = readingHighlightGeometry({
			bounds: rect(0, 0, 390, 844), scrollTop: 0, viewportHeight: 844,
			navigationBottom: 60, headingBottom: 200, rects: [rect(20, 220, 350, 24)],
		})!;
		expect(geometry.menu.top).toBeGreaterThan(244);
		expect(geometry.menu.left).toBeGreaterThanOrEqual(12);
		expect(geometry.menu.left + 208).toBeLessThanOrEqual(390 - 12);
	});

	it('keeps the toolbar and feedback in view near the bottom of a narrow viewport', () => {
		const geometry = readingHighlightGeometry({
			bounds: rect(0, 0, 320, 844), scrollTop: 100, viewportHeight: 600,
			navigationBottom: 60, rects: [rect(250, 570, 50, 24)],
		})!;
		expect(geometry.menu.left + 208).toBeLessThanOrEqual(320 - 12);
		expect(geometry.menu.top - 100 + 52).toBeLessThanOrEqual(600);
		expect(geometry.feedback.top).toBeLessThan(geometry.menu.top);
		expect(geometry.feedback.top - 100).toBeGreaterThanOrEqual(68);
	});

	it('omits the overlay when the passage has no visible text rectangles', () => {
		expect(readingHighlightGeometry({ bounds: rect(0, 0, 390, 844), scrollTop: 0, viewportHeight: 844, rects: [] })).toBeNull();
	});
});
