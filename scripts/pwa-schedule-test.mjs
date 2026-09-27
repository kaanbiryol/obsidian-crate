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

async function checkScheduleFade(page, nextView, interruptWith) {
	const samples = await page.evaluate(async ({ nextView, interruptWith }) => {
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
		const samples = [];
		let start = performance.now();
		while (performance.now() - start < 360) {
			await new Promise(requestAnimationFrame);
			if (interruptWith && performance.now() - start > 60) {
				outgoing = current(); oldText = outgoing.textContent;
				select(interruptWith); interruptWith = null; samples.length = 0; start = performance.now();
				continue;
			}
			const incoming = current(), style = getComputedStyle(incoming);
			const opacities = [...container.children].map(panel => Number(getComputedStyle(panel).opacity));
			const leavingStyle = getComputedStyle(outgoing);
			samples.push({
				retained: outgoing.isConnected,
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
		return samples;
	}, { nextView, interruptWith });
	assert.ok(samples.some(frame => frame.fading), 'Schedule content must visibly fade');
	assert.ok(samples.every(frame => frame.coverage === 1 && frame.inert && frame.oldContent && frame.stationary && frame.chromeStable), 'Keep the background covered and content stationary, departing content inert, and chrome stable');
	assert.ok(samples.some(frame => JSON.stringify(frame.transition) === JSON.stringify(['opacity', '0.16s', 'ease-out'])), 'Reuse the dock tab fade');
	assert.equal(samples.at(-1).retained, false, 'Remove the old content after the fade');
	await expect(page.locator('.pwa-tab-panel[data-leaving]')).toHaveCount(0);
}

// Compare each screen's actual contribution to the composite, not just its own
// opacity: swapping two partly faded layers can flash while both look animated.
async function checkRapidSwitches(page, dock = false) {
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
		if (previous) {
			assert.deepEqual(frame.order.filter(view => previous.order.includes(view)), previous.order.filter(view => frame.order.includes(view)), 'Retained screens must not swap paint order on reversal');
		}
		if (previous) for (const view of new Set([...Object.keys(frame.weights), ...Object.keys(previous.weights)])) {
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
			const geometry = () => page.locator('.pwa-schedule-switcher:visible').evaluate(element => {
				const rect = node => { const box = node.getBoundingClientRect(); return [box.x, box.y, box.width, box.height]; };
				return [rect(element), ...Array.from(element.querySelectorAll('.pwa-schedule-control, .pwa-schedule-chip'), rect)];
			});
			for (const initialTab of ['today', 'upcoming']) {
				const app = Promise.withResolvers();
				await page.route('**/notifications/app.js*', async route => { await app.promise; await route.continue(); });
				try {
					await page.goto(`${origin}/notifications?token=${previewEnrollmentToken}&folder=Reminders&tab=${initialTab}&upcomingDays=7`, { waitUntil: 'commit' });
					const opening = page.locator('.pwa-launch-splash');
					await expect(opening.locator('.pwa-schedule-switcher')).toBeVisible();
					await expect(opening.locator('.view-header-title')).toHaveText('Schedule');
					await expect(opening.locator('.pwa-schedule-chip[aria-pressed="true"]')).toHaveText(initialTab === 'today' ? 'Today' : 'Upcoming');
					const openingGeometry = await geometry();
					app.resolve();
					await expect(live).toBeVisible();
					await expect(live.locator('.view-header-title')).toHaveText('Schedule');
					assert.deepEqual(await geometry(), openingGeometry, 'Chips must not shift between the cached shell and the live app');
					await expect(chip(initialTab === 'today' ? 'Today' : 'Upcoming')).toHaveAttribute('aria-pressed', 'true');
					await expect(dock.getByRole('button', { name: 'Schedule', exact: true })).toHaveAttribute('aria-current', 'page');
					await expect(dock.locator('.pwa-dock__indicator')).toHaveCSS('opacity', '1');
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
			await page.emulateMedia({ reducedMotion: 'no-preference' });
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
				return { positions, destination: parseFloat(getComputedStyle(control, '::after').width) };
			});
			assert.ok(slide.positions.some(x => x > 0 && x < slide.destination), 'The shared selection must slide between segments');
			assert.ok(Math.abs(slide.positions.at(-1) - slide.destination) < 1, 'The selection must settle under Upcoming');
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
			await dock.getByRole('button', { name: 'Schedule', exact: true }).tap();
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
