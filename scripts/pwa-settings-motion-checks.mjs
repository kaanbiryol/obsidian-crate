import { checkSheetDragPosition } from './pwa-sheet-drag-checks.mjs';
import { trackSheetDismissal } from './pwa-sheet-motion-checks.mjs';
import { swipe } from './browser-touch-swipe.mjs';
import { switchFeature } from './pwa-feature-navigation.mjs';
import { expect } from '@playwright/test';

export async function checkSettingsMotion(browser, origin) {
	const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'no-preference', serviceWorkers: 'block' });
	try {
		const page = await context.newPage();
		await page.route('**/reading/session', route => route.fulfill({ json: {
			id: 'settings-motion', folderPath: 'Reading', generation: 'settings-motion', expiresAt: Date.now() + 86400000,
		} }));
		await page.route('**/reading/list*', route => route.fulfill({ json: { items: [], issues: [], cursor: null } }));
		await page.goto(origin + '/notifications?tab=inbox');
		const gear = page.getByRole('button', { name: 'Open settings', exact: true });
		await gear.waitFor();
		// Lengthen just this entrance so the intermediate state is deterministic
		// even on a loaded CI host. Initialization must follow animation completion.
		const slow = await page.addStyleTag({ content: '.pwa-settings-root .pwa-modal-sheet__container--settings:not([data-starting-style]) { transition-duration: 900ms; }' });
		await gear.click();
		const sheet = page.getByRole('dialog', { name: 'Settings', exact: true });
		await expect.poll(() => sheet.evaluate(el => el.getAnimations().some(a => a.playState === 'running'))).toBe(true);
		await expect(page.locator('[data-crate-section="reading"] .crate-reading-web')).toHaveCount(0);
		await expect(sheet.getByRole('button', { name: 'Set up iPhone shortcut' })).toBeEnabled();
		await expect.poll(() => sheet.evaluate(el => el.getAnimations().length)).toBe(0);
		await expect(page.locator('[data-crate-section="reading"] .crate-reading-web')).toHaveCount(1);
		await slow.evaluate(el => el.remove());
		await checkSettingsPush(page);
		for (let cycle = 0; cycle < 2; cycle++) {
			await sheet.getByRole('button', { name: 'Close settings', exact: true }).evaluate(el => el.click());
			await expect(sheet).toHaveAttribute('data-ending-style', '');
			await expect(page.locator('[data-crate-section="reminders"]')).toHaveAttribute('inert', '');
			await expect(sheet).toHaveCount(0);
			await expect(gear).toBeFocused();
			await gear.click();
			await expect.poll(() => sheet.evaluate(el => el.getAnimations().length)).toBe(0);
			await expect(sheet).toHaveCSS('transition-duration', '0.42s');
		}
		const canvas = page.locator('.crate-modal-canvas');
		const backdrop = page.locator('.pwa-settings-root .pwa-modal-sheet__backdrop');
		const scale = () => canvas.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a);
		await expect.poll(scale).toBeCloseTo(.94, 3);
		await expect(canvas).toHaveCSS('border-radius', '24px');
		await expect(backdrop).toHaveCSS('transition-duration', '0s');
		await checkSheetDragPosition(page, sheet);
		// A synthetic touch drag must update all layers without a CSS lag. Returning
		// to the start cancels dismissal and restores the same mounted settings.
		const header = await sheet.locator('.reminder-modal-header-title').boundingBox();
		// Keep desktop hover from interrupting the synthetic finger in WebKit.
		await page.mouse.move(-10, -10);
		const x = header.x + header.width / 2, y = header.y + header.height / 2;
		const touch = async (type, offset) => {
			const release = await sheet.locator('.reminder-modal-header-title').evaluate((el, { type, x, y }) => {
				const point = { identifier: 1, target: el, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y };
				const event = new Event(type, { bubbles: true, cancelable: true });
				Object.defineProperties(event, { touches: { value: type === 'touchend' ? [] : [point] }, changedTouches: { value: [point] } });
				el.dispatchEvent(event);
				if (type !== 'touchend') return null;
				const popup = el.closest('[role="dialog"]');
				if (!popup.hasAttribute('data-ending-style')) return null;
								return {
					strength: Number(popup.style.getPropertyValue('--drawer-swipe-strength')),
					duration: Number.parseFloat(getComputedStyle(popup).transitionDuration),
				};
			}, { type, x, y: y + offset });
			await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
			return release;
		};
		await touch('touchstart', 0);
		for (let offset = 15; offset <= 150; offset += 15) await touch('touchmove', offset);
		await expect(sheet).toHaveAttribute('data-swiping', '');
		await expect(canvas).toHaveCSS('transition-duration', '0s');
		const progress = await canvas.evaluate(el => Number(el.style.getPropertyValue('--pwa-sheet-position')));
		expect(progress).toBeGreaterThan(0);
		expect(await scale()).toBeCloseTo(.94 + .06 * progress, 3);
		expect(Number(await backdrop.evaluate(el => getComputedStyle(el).opacity))).toBeCloseTo(1 - progress, 3);
		for (let offset = 135; offset >= 60; offset -= 15) await touch('touchmove', offset);
		await touch('touchend', 60);
		await expect.poll(() => canvas.evaluate(el => el.getAnimations().some(animation => animation.playState === 'running'))).toBe(true);
		await expect(sheet).not.toHaveAttribute('data-ending-style', '');
		await expect.poll(scale).toBeCloseTo(.94, 3);
		// A committed drag restores the background and focus after the exit.
		await touch('touchstart', 0);
		for (let offset = 30; offset <= 540; offset += 30) await touch('touchmove', offset);
		// Compare painted positions: computed CSS durations can agree even when
		// a transition has already started with a different duration.
		const motionFrames = await sheet.evaluateHandle(el => {
			const canvas = document.querySelector('.crate-modal-canvas');
			const frames = [];
			const sample = () => {
				if (!el.isConnected) return;
				frames.push({ progress: new DOMMatrix(getComputedStyle(el).transform).f / el.offsetHeight, scale: new DOMMatrix(getComputedStyle(canvas).transform).a });
				requestAnimationFrame(() => setTimeout(sample, 0));
			};
			requestAnimationFrame(() => setTimeout(sample, 0));
			return frames;
		});
		const release = await touch('touchend', 540);
		expect(release.strength).toBeGreaterThan(0);
		expect(release.strength).toBeLessThan(1);
		const duration = Math.max(.24, Math.min(.32, .32 * release.strength));
		expect(release.duration).toBeCloseTo(duration, 4);
		await expect.poll(() => canvas.evaluate(el => el.getAnimations().some(animation => animation.playState === 'running'))).toBe(true);
		await expect(sheet).toHaveCount(0);
		await expect.poll(scale).toBe(1);
		const frames = await motionFrames.jsonValue();
		await motionFrames.dispose();
		expect(frames.some(frame => frame.progress > .7 && frame.progress < .95)).toBe(true);
		// WebKit can advance its compositor between sampling the sheet and canvas.
		// Bound that discrepancy in visible pixels, rather than exact matrix equality.
		for (const frame of frames) expect(Math.abs(frame.scale - (.94 + .06 * frame.progress)) * 390).toBeLessThan(1.5);
		expect(await canvas.evaluate(el => el.style.getPropertyValue('--pwa-sheet-position'))).toBe('');
		await expect(gear).toBeFocused();
		await gear.click();
		await expect.poll(scale).toBeCloseTo(.94, 3);
		// A single fast pull must visibly settle after release, all the way
		// through unmount; long drags alone do not catch a compressed exit.
		const checkFlick = await trackSheetDismissal(sheet, { minimumSettleMs: 80 });
		await swipe(page, sheet.getByRole('heading', { name: 'Settings', exact: true }), 240, 60);
		await checkFlick();
		await gear.click();
		await expect.poll(scale).toBeCloseTo(.94, 3);
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await expect(canvas).toHaveCSS('transform', 'none');
		await sheet.getByRole('button', { name: 'Close settings', exact: true }).click();
		await expect(sheet).toHaveCount(0);
		await gear.click();
		await expect(sheet).toHaveCSS('transition-duration', '0s');
		await expect(canvas).toHaveCSS('transform', 'none');
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await page.setViewportSize({ width: 1024, height: 800 });
		await expect(canvas).toHaveCSS('transform', 'none');
		await expect(sheet.getByRole('button', { name: 'Set up iPhone shortcut' })).toBeEnabled();
		await sheet.getByRole('button', { name: 'Close settings', exact: true }).click();
		await expect(sheet).toHaveCount(0);
		await page.setViewportSize({ width: 390, height: 844 });
		await switchFeature(page, 'Reading');
		await page.getByRole('button', { name: 'Save a link', exact: true }).click();
		const reading = page.getByRole('dialog', { name: 'Save a link', exact: true });
		await expect(reading).toHaveCSS('transform', 'none');
		await expect.poll(scale).toBeCloseTo(.94, 3);
		expect(await reading.evaluate(el => Boolean(el.closest('.crate-modal-canvas')))).toBe(false);
		await expect(reading).toHaveCSS('transition-duration', '0.42s');
		await checkSheetDragPosition(page, reading);
		const checkReadingDismissal = await trackSheetDismissal(reading);
		await swipe(page, reading.getByRole('heading', { name: 'Save a link', exact: true }));
		await checkReadingDismissal();
		await expect(reading).toHaveCount(0);
		await expect.poll(scale).toBe(1);
		await expect(page.locator('.pwa-sheet-portal')).toHaveCount(0);
	} finally { await context.close(); }
}

// Check painted intermediate frames: matching durations alone would miss a
// stationary header, transparent detail or a disappearing parent screen.
async function checkSettingsPush(page) {
	const trigger = page.getByRole('button', { name: 'Set up iPhone shortcut', exact: true });
	await trigger.scrollIntoViewIfNeeded();
	await trigger.focus();
	const scrollTop = await page.locator('.settings-main').evaluate(el => el.scrollTop);
	for (const direction of ['push', 'pop']) {
		const button = direction === 'push' ? trigger : page.getByRole('button', { name: 'Back to settings' });
		const frames = await button.evaluate(async el => {
			const stack = el.closest('.pwa-push-stack');
			el.click();
			const samples = [];
			const started = performance.now();
			while (performance.now() - started < 650) {
				await new Promise(resolve => requestAnimationFrame(resolve));
				const root = stack.querySelector('.pwa-push-stack__root');
				const detail = stack.querySelector('.pwa-push-stack__detail');
				const header = detail.querySelector('.reminder-modal-header');
				const body = detail.querySelector('.pwa-push-stack__body');
				const bounds = stack.getBoundingClientRect();
				samples.push({
					width: bounds.width, x: detail.getBoundingClientRect().x - bounds.x,
					rootX: root.getBoundingClientRect().x - bounds.x, rootOpacity: Number(getComputedStyle(root).opacity),
					opacity: Number(getComputedStyle(detail).opacity), background: getComputedStyle(detail).backgroundColor,
					headerX: header ? header.getBoundingClientRect().x - bounds.x : null,
					bodyX: body ? body.getBoundingClientRect().x - bounds.x : null,
				});
			}
			return samples;
		});
		const moving = frames.filter(frame => frame.x > 2 && frame.x < frame.width - 2);
		if (!moving.length) throw new Error(`${direction} did not slide: ${JSON.stringify(frames.filter((_, i) => i % 5 === 0))}`);
		for (const frame of moving) {
			expect(frame.rootX).toBeCloseTo(0, 0);
			expect(frame.rootOpacity).toBe(1);
			expect(frame.opacity).toBe(1);
			expect(frame.background).not.toBe('rgba(0, 0, 0, 0)');
			expect(frame.headerX).toBeCloseTo(frame.x, 0);
			expect(frame.bodyX).toBeCloseTo(frame.x, 0);
		}
		expect(frames.at(-1).x).toBeCloseTo(direction === 'push' ? 0 : frames.at(-1).width, 0);
		if (direction === 'push') {
			await expect(page.getByRole('button', { name: 'Back to settings' })).toBeFocused();
			const header = page.locator('.pwa-push-stack__detail .reminder-modal-header');
			const before = await header.boundingBox();
			await page.locator('.settings-detail').evaluate(el => { el.scrollTop = el.scrollHeight; });
			expect((await header.boundingBox()).y).toBe(before.y);
		}
	}
	await expect(trigger).toBeFocused();
	expect(await page.locator('.settings-main').evaluate(el => el.scrollTop)).toBe(scrollTop);
}
