import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';
import { previewEnrollmentToken } from './pwa-preview-fixtures.mjs';

const { server } = await listenPwaPreviewServer({ port: 0, assets: await buildPwaPreviewAssets() });
const origin = `http://127.0.0.1:${server.address().port}`;
const reminders = [
	{ id: 'today', content: 'Send the draft', description: 'Review the detailed notes and include the final changes before sending the draft to the team.', dueDate: '2026-09-26' },
	{ id: 'tomorrow', content: 'Review the launch', dueDate: '2026-09-27' },
	{ id: 'later', content: 'Book the train', dueDate: '2026-09-29' },
	{ id: 'outside-range', content: 'Plan next month', dueDate: '2026-10-20' },
	{ id: 'completed', content: 'Finished task', dueDate: '2026-09-27', completed: true },
].map(reminder => ({ revision: 'fixture', description: '', priority: 4, completed: false, project: 'Work', filePath: 'Reminders/Work.md', ...reminder }));

async function checkTodayStartup(browser, reducedMotion) {
	const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
		timezoneId: 'UTC', serviceWorkers: 'block', reducedMotion });
	let response = Promise.withResolvers();
	const list = Array.from({ length: 21 }, (_, index) => ({ ...reminders[0], id: `overdue-${index}`, dueDate: '2026-09-25' }));
	await page.clock.setFixedTime(new Date('2026-09-26T12:00:00Z'));
	await page.route('**/reminders/list?*', async route => {
		await response.promise;
		await route.fulfill({ json: { reminders: list, projects: ['Work'], issues: [] } });
	});
	await page.addInitScript(() => {
		window.startupFrames = [];
		const sample = () => {
			const shell = document.querySelector('.pwa-reminders-view');
			if (shell) {
				const regions = ['.view-header-meta', '.pwa-schedule-switcher', '.reminders-content'].map(selector => shell.querySelector(selector));
				const cards = [...shell.querySelectorAll('[data-reminder-id]')];
				window.startupFrames.push({
					loading: shell.hasAttribute('data-pwa-loading'),
					visible: regions.map(node => getComputedStyle(node).visibility),
					opacity: regions.map(node => Number(getComputedStyle(node).opacity)),
					geometry: regions.slice(0, 2).map(node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }),
					cards: cards.length,
					cardY: cards[0]?.getBoundingClientRect().y,
					chrome: ['.view-header-title', '.view-header-actions', '.pwa-dock'].map(selector => Number(getComputedStyle(shell.querySelector(selector)).opacity)),
				});
			}
			requestAnimationFrame(sample);
		};
		requestAnimationFrame(sample);
	});
	try {
		await page.goto(`${origin}/notifications?token=${previewEnrollmentToken}&folder=Reminders&tab=today`);
		await expect(page.locator('.pwa-reminders-view[data-pwa-loading]')).toBeVisible();
		await expect(page.getByRole('group', { name: 'Reminder dates' })).toBeHidden();
		await expect(page.locator('.view-header-meta')).toBeHidden();
		await expect.poll(() => page.evaluate(() => window.startupFrames.length)).toBeGreaterThan(1);
		response.resolve();
		for (const cached of [false, true]) {
			if (cached) {
				response = Promise.withResolvers();
				await page.reload();
			}
			await expect(page.locator('.view-header-count')).toHaveText('21 reminders');
			await expect(page.locator('.view-header-overdue')).toHaveText('21 overdue');
			await expect(page.locator('[data-reminder-id]')).toHaveCount(21);
			await expect.poll(() => page.evaluate(() => window.startupFrames.filter(frame => frame.cards === 21 && frame.opacity.every(value => value === 1)).length)).toBeGreaterThan(3);
			const frames = await page.evaluate(() => window.startupFrames);
			const ready = frames.filter(frame => frame.cards === 21);
			assert.ok(frames.filter(frame => frame.loading).every(frame => frame.visible[0] === 'hidden' && frame.visible[1] === 'hidden'), 'Keep counts and dates hidden together while loading');
			assert.ok(ready.every(frame => frame.opacity.every(value => Math.abs(value - frame.opacity[0]) < .01)), 'Counts, dates, and list must fade together');
			assert.equal(ready.some(frame => frame.opacity[0] > 0 && frame.opacity[0] < 1), reducedMotion !== 'reduce', 'Respect reduced motion for cold and cached launches');
			assert.ok(frames.every(frame => frame.chrome.every(value => value === 1)), 'Title, settings, and dock stay fully painted');
			assert.ok(frames.every(frame => JSON.stringify(frame.geometry) === JSON.stringify(frames[0].geometry)), 'Keep the count row and switcher stationary');
			assert.ok(ready.every(frame => Math.abs(frame.cardY - ready[0].cardY) < 1), 'The first card must not slide during the reveal');
			if (cached) {
				await page.evaluate(() => { window.startupFrames = []; });
				list[0].content = 'Updated draft after refresh';
				response.resolve();
				await expect(page.locator('[data-reminder-id="overdue-0"]')).toContainText('Updated draft after refresh');
				await expect.poll(() => page.evaluate(() => window.startupFrames.length)).toBeGreaterThan(15);
				assert.ok(await page.evaluate(() => window.startupFrames.every(frame => frame.opacity.every(value => value === 1))), 'Background refresh must not replay the reveal');
			}
		}
	} finally { response.resolve(); await page.close(); }
}

async function checkScheduleFade(page, nextView, interruptWith) {
	const reducedMotion = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
	const samples = await page.evaluate(async ({ nextView, interruptWith, reducedMotion }) => {
		const shell = document.querySelector('.pwa-reminders-view');
		const container = shell.querySelector('.reminders-content > .pwa-tab-transition');
		const current = () => container.querySelector(':scope > .pwa-tab-panel:not([data-leaving])');
		const rect = element => { const box = element.getBoundingClientRect(); return [box.x, box.y, box.width, box.height]; };
		const chrome = [shell.querySelector('.view-header'), shell.querySelector('.pwa-schedule-switcher'), shell.querySelector('.pwa-dock')];
		const chromeRects = chrome.map(rect);
		const select = name => [...shell.querySelectorAll('.pwa-schedule-chip')].find(button => button.textContent === name).click();
		let outgoing = current(), oldText = outgoing.textContent;
		const oldRect = rect(outgoing);
		select(nextView);
		// Seek native CSS transitions so a dropped CI frame cannot skip the
		// entire dissolve. Keep reduced-motion rendering on its normal frames.
		const samples = [], animations = new Map();
		for (let time = 0; time <= 420; time += 20) {
			if (reducedMotion) await new Promise(requestAnimationFrame);
			await Promise.resolve();
			if (interruptWith && time === 80) {
				outgoing = current(); oldText = outgoing.textContent;
				select(interruptWith); interruptWith = null; samples.length = 0;
				await Promise.resolve();
			}
			if (!reducedMotion) for (const layer of container.children) for (const animation of layer.getAnimations()) {
				if (animation.transitionProperty !== 'opacity' || animation.playState === 'finished') continue;
				if (!animations.has(animation)) { animation.pause(); animations.set(animation, time); }
				animation.currentTime = Math.min(time - animations.get(animation), Number(animation.effect.getTiming().duration));
			}
			const incoming = current(), style = getComputedStyle(incoming);
			const opacities = [...container.children].map(panel => Number(getComputedStyle(panel).opacity));
			const leavingStyle = getComputedStyle(outgoing);
			samples.push({
				outgoing: outgoing.isConnected ? Number(leavingStyle.opacity) : 0,
				coverage: 1 - opacities.reduce((gap, opacity) => gap * (1 - opacity), 1),
			fading: opacities.some(opacity => opacity > .1 && opacity < .9),
				inert: !outgoing.isConnected || (outgoing.inert && outgoing.getAttribute('aria-hidden') === 'true'),
				oldContent: outgoing.textContent === oldText,
				stationary: JSON.stringify(rect(incoming)) === JSON.stringify(oldRect) && style.transform === 'none',
				chromeStable: chrome.every((element, index) => element.isConnected && getComputedStyle(element).opacity === '1' && JSON.stringify(rect(element)) === JSON.stringify(chromeRects[index])),
				transition: [style.transitionProperty, style.transitionDuration, style.transitionTimingFunction],
			});
		}
		for (const animation of container.getAnimations({ subtree: true })) {
			if (animations.has(animation)) animation.finish();
		}
		return samples;
	}, { nextView, interruptWith, reducedMotion });
	assert.equal(samples.some(frame => frame.fading), !reducedMotion, 'Fade only when motion is enabled');
	assert.ok(samples.every(frame => frame.coverage === 1 && frame.inert && frame.oldContent && frame.stationary && frame.chromeStable), 'Keep the background covered and content stationary, departing content inert, and chrome stable');
	assert.ok(samples.some(frame => JSON.stringify(frame.transition) === JSON.stringify(['opacity', reducedMotion ? '0s' : '0.16s', 'ease-out'])), 'Reuse the dock tab fade');
	await expect(page.locator('.pwa-tab-panel[data-leaving]')).toHaveCount(0);
}

// Compare each screen's actual contribution to the composite, not just its own
// opacity: swapping two partly faded layers can flash while both look animated.
async function checkRapidSwitches(page, dock = false) {
	const reducedMotion = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
	const frames = await page.evaluate(async dock => {
		const shell = document.querySelector('.pwa-reminders-view');
		const container = shell.querySelector(dock
			? '.pwa-navigation-viewport > .pwa-tab-transition'
			: '.reminders-content > .pwa-tab-transition');
		const sequence = dock
			? ['projects', 'inbox', 'today', 'inbox', 'projects', 'today']
			: ['today', 'upcoming', 'today', 'upcoming', 'today', 'upcoming'];
		const sample = () => {
			const panels = [...container.children].sort((a, b) => Number(getComputedStyle(b).zIndex) - Number(getComputedStyle(a).zIndex));
			let uncovered = 1;
			const weights = {}, cards = {};
			for (const panel of panels) {
				const opacity = Number(getComputedStyle(panel).opacity);
				weights[panel.dataset.tabView] = uncovered * opacity;
				uncovered *= 1 - opacity;
				for (const row of panel.querySelectorAll('[data-reminder-id]')) {
					const rect = row.getBoundingClientRect();
					if (rect.top >= 0 && rect.bottom <= innerHeight) cards[`${panel.dataset.tabView}:${row.dataset.reminderId}`] = [rect.y, rect.height];
				}
			}
			return { time: performance.now(), weights, uncovered, cards, order: panels.map(panel => panel.dataset.tabView) };
		};
		const frames = [sample()], start = performance.now();
		let step = 0;
		while (performance.now() - start < 750) {
			if (step < sequence.length && performance.now() - start >= step * 60) {
				const view = sequence[step++];
				const button = dock ? shell.querySelector(`.pwa-dock [data-tab="${view}"]`)
					: [...shell.querySelectorAll('.pwa-schedule-chip')].find(button => button.textContent.toLowerCase() === view);
				button.click();
			}
			await new Promise(requestAnimationFrame);
			frames.push(sample());
		}
		return frames;
	}, dock);
	const geometry = new Map();
	for (let index = 0; index < frames.length; index++) {
		const frame = frames[index], previous = frames[index - 1];
		assert.equal(frame.uncovered, 0, 'Rapid switching must never expose the background');
		if (reducedMotion) assert.ok(Object.values(frame.weights).every(weight => weight === 0 || weight === 1), 'Reduced motion switches without intermediate fades');
		if (previous) {
			assert.deepEqual(frame.order.filter(view => previous.order.includes(view)), previous.order.filter(view => frame.order.includes(view)), 'Retained screens must not swap paint order on reversal');
		}
		if (previous && !reducedMotion) for (const view of new Set([...Object.keys(frame.weights), ...Object.keys(previous.weights)])) {
			const change = Math.abs((frame.weights[view] ?? 0) - (previous.weights[view] ?? 0));
			// Allow one compositor frame of sampling skew. A third dock screen
			// can also contribute two overlapping fades at once.
			assert.ok(change <= .04 + (frame.time - previous.time + 17) / (dock ? 40 : 80),
				`${view} flashed by ${change.toFixed(3)} in ${(frame.time - previous.time).toFixed(1)}ms`);
		}
		for (const [id, rect] of Object.entries(frame.cards)) {
			const before = geometry.get(id);
			if (before) assert.ok(rect.every((value, i) => Math.abs(value - before[i]) < 1), `${id} changed geometry during a switch: ${before} -> ${rect}`);
			geometry.set(id, rect);
		}
	}
	assert.equal(frames.at(-1).weights[dock ? 'today' : 'upcoming'], 1, 'Settle on the latest requested screen');
	await expect(page.locator('.pwa-tab-panel[data-leaving]')).toHaveCount(0);
}

try {
	await mkdir('test-results/schedule', { recursive: true });
	for (const engine of [chromium, webkit]) {
		const browser = await engine.launch();
		try {
			await checkTodayStartup(browser, 'no-preference');
			await checkTodayStartup(browser, 'reduce');
			const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, timezoneId: 'UTC', serviceWorkers: 'block' });
			const errors = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.clock.setFixedTime(new Date('2026-09-26T12:00:00Z'));
			let empty = false, list = reminders;
			await page.route('**/reminders/list?*', route => route.fulfill({ json: { reminders: empty ? [] : list, projects: ['Work'], issues: [] } }));
			const live = page.locator('.pwa-reminders-view:not([data-pwa-opening])');
			const chips = live.getByRole('group', { name: 'Reminder dates' });
			const chip = name => chips.getByRole('button', { name, exact: true });
			const dock = live.locator('.pwa-dock');
			const row = id => live.locator(`[data-reminder-id="${id}"]`);
			const geometry = () => page.locator('.pwa-schedule-switcher').evaluate(element => {
				const rect = node => { const box = node.getBoundingClientRect(); return [box.x, box.y, box.width, box.height]; };
				return [rect(element), ...Array.from(element.querySelectorAll('.pwa-schedule-control, .pwa-schedule-chip'), rect)];
			});
			for (const initialTab of ['today', 'upcoming']) {
				const app = Promise.withResolvers();
				await page.route('**/notifications/app.js*', async route => { await app.promise; await route.continue(); });
				try {
					await page.goto(`${origin}/notifications?token=${previewEnrollmentToken}&folder=Reminders&tab=${initialTab}&upcomingDays=7`, { waitUntil: 'commit' });
					const opening = page.locator('.pwa-launch-splash');
					await expect(opening.locator('.pwa-schedule-switcher')).toBeHidden();
					await expect(opening.locator('.view-header-title')).toHaveText('Reminders');
					await expect(opening.locator('.pwa-schedule-chip[aria-pressed="true"]')).toHaveText(initialTab === 'today' ? 'Today' : 'Upcoming');
					const openingGeometry = await geometry();
					app.resolve();
					await expect(live).toBeVisible();
					await expect(live.locator('.view-header-title')).toHaveText('Reminders');
					assert.deepEqual(await geometry(), openingGeometry, 'Chips must not shift between the cached shell and the live app');
					await expect(chip(initialTab === 'today' ? 'Today' : 'Upcoming')).toHaveAttribute('aria-pressed', 'true');
					await expect(dock.getByRole('button', { name: 'Reminders', exact: true })).toHaveAttribute('aria-current', 'page');
					await expect(dock.locator('.pwa-dock__indicator')).toHaveCSS('opacity', '1');
					await expect(chips).toHaveCSS('opacity', '1');
				} finally { app.resolve(); await page.unroute('**/notifications/app.js*'); }
			}
			await expect(row('tomorrow')).toBeVisible();
			await expect(row('later')).toBeVisible();
			await expect(row('today')).toHaveCount(0);
			await expect(row('outside-range')).toHaveCount(0);
			await expect(row('completed')).toHaveCount(0);
			await expect(live.locator('.upcoming-date-header')).toHaveCount(2);
			await expect(live.locator('.view-header-count')).toHaveText('2 reminders');
			await checkScheduleFade(page, 'Today');
			await checkScheduleFade(page, 'Upcoming');
			await checkScheduleFade(page, 'Today', 'Upcoming');
			await checkRapidSwitches(page);
			await page.emulateMedia({ reducedMotion: 'reduce' });
			await checkScheduleFade(page, 'Today');
			await checkScheduleFade(page, 'Upcoming');
			await checkRapidSwitches(page);
			// Higher contrast adds borders to the selection. Percentage transforms
			// travel by its border box, which can differ from computed content width.
			await page.emulateMedia({ reducedMotion: 'no-preference', contrast: 'more' });
			const upcomingButton = await chip('Upcoming').elementHandle();
			await chip('Today').tap();
			await expect(row('today')).toBeVisible();
			await expect(row('tomorrow')).toHaveCount(0);
			await expect(live.locator('.view-header-count')).toHaveText('1 reminder');
			const control = chips.locator('.pwa-schedule-control');
			await expect.poll(() => control.evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element, '::after').transform).m41)).toBe(0);
			const slide = await chips.evaluate(async element => {
				const control = element.querySelector('.pwa-schedule-control');
				element.querySelector('[aria-pressed="false"]').click();
				const positions = [], start = performance.now();
				while (performance.now() - start < 260) {
					await new Promise(requestAnimationFrame);
					positions.push(new DOMMatrixReadOnly(getComputedStyle(control, '::after').transform).m41);
				}
				const style = getComputedStyle(control, '::after');
				const borders = style.boxSizing === 'border-box' ? 0 : parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)
					+ parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
				return { positions, destination: parseFloat(style.width) + borders };
			});
			assert.ok(slide.positions.some(x => x > 0 && x < slide.destination), 'The shared selection must slide between segments');
			await expect.poll(() => control.evaluate(element => {
				const style = getComputedStyle(element, '::after');
				const borders = style.boxSizing === 'border-box' ? 0 : parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)
					+ parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
				return Math.abs(new DOMMatrixReadOnly(style.transform).m41 - parseFloat(style.width) - borders);
			}), { message: 'The selection must settle under Upcoming' }).toBeLessThan(1);
			await page.emulateMedia({ contrast: 'no-preference' });
			await chip('Upcoming').focus();
			await page.keyboard.press('Space');
			await expect(chip('Upcoming')).toBeFocused();
			await expect(row('tomorrow')).toBeVisible();
			assert.equal(await upcomingButton.evaluate(element => element.isConnected), true, 'Switching lists must retain the chip controls');
			for (const name of ['Today', 'Upcoming', 'Today', 'Upcoming']) await chip(name).tap();
			await expect(chip('Upcoming')).toHaveAttribute('aria-pressed', 'true');
			await expect(chips.locator('[aria-pressed="true"]')).toHaveCount(1);
			await expect(live.locator('.pwa-tab-panel')).toHaveCount(2);
			await dock.getByRole('button', { name: 'Inbox', exact: true }).tap();
			await expect(chips).toHaveCount(0);
			await dock.getByRole('button', { name: 'Reminders', exact: true }).tap();
			await expect(chip('Today')).toHaveAttribute('aria-pressed', 'true');
			await expect(row('today')).toBeVisible();
			await checkRapidSwitches(page, true);
			for (const theme of ['dark', 'light']) for (const width of [320, 390, 1024]) {
				await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
				await page.setViewportSize({ width, height: 844 });
				for (const name of ['Today', 'Upcoming']) {
					await chip(name).tap();
					await expect(chip(name)).toHaveAttribute('aria-pressed', 'true');
					await expect(live.locator('.pwa-tab-panel[data-leaving]')).toHaveCount(0);
					await expect(chip(name)).toHaveCSS('transition-duration', '0s');
					assert.equal(await control.evaluate(element => getComputedStyle(element, '::after').transitionDuration), '0s');
					const bounds = await chips.getByRole('button').evaluateAll(buttons => buttons.map(button => {
						const rect = button.getBoundingClientRect(); return { height: rect.height, right: rect.right, left: rect.left };
					}));
					assert.ok(bounds.every(box => box.height >= 44 && box.left >= 0 && box.right <= width));
					assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
					await page.screenshot({ path: `test-results/schedule/${engine.name()}-${theme}-${width}-${name.toLowerCase()}.png` });
				}
			}
			// Reversing while scrolled must retain the same cards in the viewport.
			list = Array.from({ length: 100 }, (_, index) => ({ ...reminders[0], id: `scroll-${index}`, description: index % 2 ? reminders[0].description : '' }));
			await page.emulateMedia({ reducedMotion: 'no-preference' });
			await page.setViewportSize({ width: 390, height: 844 });
			await page.reload();
			await chip('Today').tap();
			await expect(live.locator('.pwa-tab-panel[data-leaving]')).toHaveCount(0);
			await live.locator('.reminders-view-scroll').evaluate(element => { element.scrollTop = 2000; });
			await page.waitForTimeout(200);
			await checkRapidSwitches(page);
			empty = true;
			await page.reload();
			await expect(live.getByRole('heading', { name: 'No upcoming reminders', exact: true })).toBeVisible();
			await chip('Today').tap();
			await expect(live.getByRole('heading', { name: 'Nothing due today', exact: true })).toBeVisible();
			await expect(live.locator('.pwa-tab-panel[data-leaving]')).toHaveCount(0);
			await checkScheduleFade(page, 'Upcoming');
			assert.deepEqual(errors, []);
			console.log(`${engine.name()}: schedule chips, keyboard focus, filters, empty states, launch, and responsive themes passed`);
		} finally { await browser.close(); }
	}
} finally { await new Promise(resolve => server.close(resolve)); }
