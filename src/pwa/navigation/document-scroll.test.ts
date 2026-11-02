import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { measureDocumentScroll } from './document-scroll';

// linkedom has no layout: boxes come from data attributes, at the full 390px width.
const { window, document } = parseHTML(`<html><body>
	<div id="app">
		<main id="screen" data-top="0" data-height="800">
			<header id="header" data-top="0" data-height="56"></header>
			<div id="behind" data-top="56" data-height="700"></div>
			<div id="layer" data-position="absolute" data-z="2" data-top="56" data-height="744" data-bg="rgb(1, 2, 3)">
				<div id="pull" data-height="0"></div>
				<div id="hidden" hidden></div>
				<ul id="list" data-top="56" data-height="744"></ul>
			</div>
			<nav id="dock" data-position="fixed" data-top="744" data-height="56"></nav>
		</main>
	</div>
</body></html>`);
const byId = (id: string) => document.getElementById(id) as unknown as HTMLElement;
const box = (element: HTMLElement) => {
	const top = Number(element.dataset.top ?? 0), height = Number(element.dataset.height ?? 10);
	return { top, left: 0, width: 390, height, right: 390, bottom: top + height } as DOMRect;
};

beforeAll(() => {
	vi.stubGlobal('HTMLElement', window.HTMLElement);
	vi.stubGlobal('getComputedStyle', (element: HTMLElement) => ({
		position: element.dataset.position ?? 'static', zIndex: element.dataset.z ?? 'auto', backgroundColor: element.dataset.bg ?? 'rgba(0, 0, 0, 0)',
	}));
	Object.assign(window, { innerHeight: 760 });
	const prototype = window.HTMLElement.prototype;
	Object.defineProperty(prototype, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return box(this).height; } });
	Object.assign(prototype, {
		getBoundingClientRect(this: HTMLElement) { return box(this); },
		getClientRects(this: HTMLElement) { return this.hidden ? [] : [box(this)]; },
	});
	Object.defineProperty(byId('list'), 'scrollTop', { value: 120 });
});
afterAll(() => { vi.unstubAllGlobals(); });

it('measures the handoff without changing the screen', () => {
	const before = document.documentElement.outerHTML;
	const layout = measureDocumentScroll(byId('list'), byId('screen'));
	expect(document.documentElement.outerHTML).toBe(before);

	expect(layout).toMatchObject({ top: 120, viewport: 760, background: 'rgb(1, 2, 3)', ownerBounds: { top: 56, height: 744 } });
	expect(layout.outer.map(element => element.id || element.localName)).toEqual(['app', 'body']);
	// Visible siblings are watched for resizes, including the fixed dock and the collapsed pull area.
	expect([...layout.watched].map(element => element.id).sort()).toEqual(['behind', 'dock', 'header', 'pull']);
	// The header is pinned; the screen below the absolute layer is hidden instead.
	expect(layout.levels.map(({ parent, chrome }) => [parent.id, chrome.map(item => item.element.id)])).toEqual([['screen', ['header']], ['layer', []]]);
	expect(layout.covered.map(element => element.id)).toEqual(['behind']);
	// The layer has in-flow siblings, so it grows in place instead of joining the flow.
	expect(layout.growth.map(({ element, position, detach }) => [element.id, position, detach])).toEqual([['layer', 'absolute', false], ['screen', 'static', false]]);
});
