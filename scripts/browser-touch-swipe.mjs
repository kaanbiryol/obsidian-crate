import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

// Chromium receives native touch input. Desktop WebKit has no touch-drag API;
// dispatch its TouchEvents to cover the drawer's gesture arbitration there.
export async function swipe(page, target, distance = 120, duration = 80) {
	const box = await target.boundingBox();
	assert.ok(box);
	const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	const session = page.context().browser().browserType() === chromium
		? await page.context().newCDPSession(page) : null;
	async function dispatch(type, y) {
		if (session) {
			await session.send('Input.dispatchTouchEvent', {
				type, touchPoints: type === 'touchEnd' ? [] : [{ x: point.x, y }],
			});
		} else {
			await target.evaluate((element, { type, x, y }) => {
				const touch = { identifier: 1, target: element, clientX: x, clientY: y };
				const event = new Event(type.toLowerCase(), { bubbles: true, cancelable: true, composed: true });
				Object.defineProperties(event, {
					touches: { value: type === 'touchEnd' ? [] : [touch] },
					changedTouches: { value: [touch] },
				});
				element.dispatchEvent(event);
			}, { type, x: point.x, y });
		}
	}
	try {
		await dispatch('touchStart', point.y);
		for (let step = 1; step <= 4; step++) {
			await page.waitForTimeout(duration / 4);
			await dispatch('touchMove', point.y + distance * step / 4);
		}
		await dispatch('touchEnd', point.y + distance);
	} finally { await session?.detach(); }
}
