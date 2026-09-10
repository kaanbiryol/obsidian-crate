import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

export async function checkNativeEditorGestures(page, title) {
	await expect(page.locator('.pwa-modal-sheet__container')).toHaveCSS('transform', 'none');
	await expect(page.locator('.pwa-reminder-sheet-stage')).toHaveCSS('transform', 'none');
	const gestures = await title.evaluate(element => {
		const selection = document.getSelection();
		const range = document.createRange();
		range.selectNodeContents(element);
		selection.removeAllRanges();
		selection.addRange(range);
		const background = element.closest('.modal-form').querySelector('.reminder-modal-body');
		const dispatch = target => ['touchstart', 'touchmove', 'touchend'].map(type => {
			const event = new Event(type, { bubbles: true, cancelable: true });
			const touches = type === 'touchend' ? [] : [{ clientX: 100, clientY: type === 'touchmove' ? 80 : 100 }];
			Object.defineProperties(event, { touches: { value: touches }, changedTouches: { value: touches } });
			target.dispatchEvent(event);
			return event.defaultPrevented;
		});
		const selected = dispatch(element);
		selection.collapseToEnd();
		return { selected, collapsed: dispatch(element), background: dispatch(background) };
	});
	assert.deepEqual(gestures.selected, [false, false, false], 'Selected editor gestures must remain native');
	assert.deepEqual(gestures.collapsed, [false, false, false], 'Caret gestures must remain native');
	assert.deepEqual(gestures.background, [false, false, false], 'Scroll containment must not cancel touch events');

	// Scroll to both ends of the containment layer. Its contents must stay
	// anchored even though it has a native scroll range for WebKit to latch to.
	const boundary = page.locator('.pwa-modal-sheet__scroll-boundary');
	const beforeScroll = await title.boundingBox();
	for (const top of [100, 0]) {
		await boundary.evaluate((element, scrollTop) => { element.scrollTop = scrollTop; }, top);
		if (top > 0) assert.ok(await boundary.evaluate(element => element.scrollTop > 0), 'Exercise actual native scrolling inside the containment layer');
		const afterScroll = await title.boundingBox();
		assert.ok(Math.abs(afterScroll.y - beforeScroll.y) < 1, 'Scrolling the containment layer must not move the editor');
		assert.equal(await page.evaluate(() => window.scrollY), 0, 'Containment must not move the document');
	}

	// Exercise browser hit-testing, not a hand-written selection-reset handler.
	const point = await title.evaluate(element => {
		const text = element.firstChild;
		const selection = document.getSelection();
		selection.setBaseAndExtent(text, 0, text, 4);
		const caret = document.createRange();
		caret.setStart(text, 15);
		caret.setEnd(text, 16);
		const rect = caret.getBoundingClientRect();
		return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
	});
	await page.touchscreen.tap(point.x, point.y);
	await expect.poll(() => title.evaluate(element => {
		const selection = document.getSelection();
		return selection.isCollapsed && element.contains(selection.anchorNode);
	})).toBe(true);
}
