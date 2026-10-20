import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

// Exercise the built app so portal placement and the final CSS cascade matter.
export async function checkPwaScreenGestures(page, target) {
	assert.equal(await target.evaluate(element => {
		const screen = element.closest('.pwa-screen');
		return screen && getComputedStyle(screen).touchAction;
	}), 'pan-x pan-y', 'Screens must allow scrolling without touch page zoom');
	if (page.context().browser().browserType().name() !== 'chromium') return;
	// Desktop WebKit cannot inject a native pinch. Chromium receives two actual
	// touch points; synthetic DOM events would not exercise browser zoom.
	const session = await page.context().newCDPSession(page);
	const bounds = await target.boundingBox();
	assert.ok(bounds);
	const x = bounds.x + bounds.width / 2;
	const y = Math.min(bounds.y + bounds.height / 2, page.viewportSize().height - 120);
	const scale = await page.evaluate(() => visualViewport.scale);
	try {
		const send = (type, spread) => session.send('Input.dispatchTouchEvent', {
			type, touchPoints: type === 'touchEnd' ? [] : [{ id: 1, x: x - spread, y }, { id: 2, x: x + spread, y }],
		});
		await send('touchStart', 20);
		for (let step = 1; step <= 8; step++) {
			await send('touchMove', 20 + step * 8);
			await page.waitForTimeout(16);
		}
		await send('touchEnd');
		assert.equal(await page.evaluate(() => visualViewport.scale), scale, 'Pinching a screen must not scale the page');
	} finally { await session.detach(); }
}

export async function checkPwaTextField(field, { sheet = false } = {}) {
	// Native inputs keep editable selection with the browser's default `auto`.
	const nativeInput = await field.evaluate(element => element.matches('input, textarea'));
	await expect(field).toHaveCSS('-webkit-user-select', nativeInput ? /^(text|auto)$/ : 'text');
	if (sheet) assert.equal(await field.evaluate(element => !!element.closest('.pwa-screen')), false,
		'Sheets must keep native editing outside the screen gesture policy');
}
