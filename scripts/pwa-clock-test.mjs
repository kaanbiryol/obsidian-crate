import { chromium, webkit, expect } from '@playwright/test';
import http from 'node:http';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const upstreamOrigin = `http://127.0.0.1:${server.address().port}`;
let reminders = [];
let etag = '';
let unchangedResponses = 0;
// Real HTTP is required for WebKit's 304 behavior. Only list contents are fixtures;
// the built UI, hooks, cache, timers and DOM are exercised in both browsers.
const proxy = http.createServer((request, response) => {
	const url = new URL(request.url, upstreamOrigin);
	if (url.pathname === '/reminders/list') {
		if (request.headers['if-none-match'] === etag) {
			unchangedResponses++;
			response.writeHead(304, { ETag: etag }); response.end(); return;
		}
		response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ETag: etag });
		response.end(JSON.stringify({ reminders, projects: ['Inbox'], issues: [] })); return;
	}
	const upstream = http.request(url, { method: request.method, headers: { ...request.headers, host: new URL(upstreamOrigin).host } }, incoming => {
		response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response);
	});
	upstream.on('error', () => { response.writeHead(502); response.end(); });
	request.pipe(upstream);
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${proxy.address().port}`;
const record = dates => ({ id: 'clock-task', content: 'Clock reminder', priority: 4, completed: false,
	project: 'Inbox', filePath: 'Reminders/Inbox.md', revision: 'stable-clock-revision', ...dates });
const row = page => page.getByRole('group', { name: 'Clock reminder. Press Enter to edit reminder.', exact: true });

async function open(context, tab, time) {
	const page = await context.newPage();
	await page.clock.install({ time: new Date(time) });
	await page.goto(`${origin}/notifications?folder=Reminders&tab=${tab}`);
	await expect(page.locator('[data-action="open-create-modal"]')).toBeVisible();
	return page;
}

async function fixture(browser, verify) {
	const context = await browser.newContext({ timezoneId: 'UTC', reducedMotion: 'reduce', serviceWorkers: 'block',
		viewport: { width: 390, height: 844 } });
	const errors = [];
	context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
	try {
		await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
		await verify(context);
		expect(errors).toEqual([]);
	} finally { await context.close(); }
}

async function midnight(browser) {
	reminders = [record({ dueDate: '2026-09-09' })]; etag = '"midnight"'; unchangedResponses = 0;
	await fixture(browser, async context => {
		const today = await open(context, 'today', '2026-09-08T23:59:00Z');
		const upcoming = await open(context, 'upcoming', '2026-09-08T23:59:00Z');
		for (const page of [today, upcoming]) await page.clock.pauseAt(new Date('2026-09-08T23:59:59Z'));
		await expect(today.locator('.view-header-count')).toHaveText('0 reminders');
		await expect(row(today)).toHaveCount(0);
		await expect(row(upcoming)).toBeVisible();
		await expect(row(upcoming).locator('.premium-pill').filter({ hasText: 'Tomorrow' })).toBeVisible();
		for (const page of [today, upcoming]) await page.clock.runFor(1002);
		await expect(row(today)).toBeVisible();
		await expect(today.locator('.view-header-count')).toHaveText('1 reminder');
		await expect(row(today).locator('.premium-pill').filter({ hasText: 'Today' })).toBeVisible();
		await expect(row(upcoming)).toHaveCount(0);
		await expect(upcoming.locator('.view-header-count')).toHaveText('0 reminders');
		const before = unchangedResponses;
		for (const page of [today, upcoming]) await page.evaluate(() => window.dispatchEvent(new Event('online')));
		await expect.poll(() => unchangedResponses).toBeGreaterThanOrEqual(before + 2);
		await expect(row(today)).toBeVisible();
		await expect(row(upcoming)).toHaveCount(0);
	});
}

async function deadline(browser) {
	reminders = [record({ dueDatetime: '2026-09-09T12:00:20Z' })]; etag = '"deadline"';
	await fixture(browser, async context => {
		const upcoming = await open(context, 'upcoming', '2026-09-09T12:00:00Z');
		const inbox = await open(context, 'inbox', '2026-09-09T12:00:00Z');
		for (const page of [upcoming, inbox]) await page.clock.pauseAt(new Date('2026-09-09T12:00:19Z'));
		await expect(row(upcoming)).toBeVisible();
		await expect(row(inbox).locator('.is-overdue')).toHaveCount(0);
		for (const page of [upcoming, inbox]) await page.clock.runFor(1002);
		await expect(row(upcoming)).toHaveCount(0);
		await expect(upcoming.locator('.view-header-count')).toHaveText('0 reminders');
		await expect(row(inbox).locator('.is-overdue')).toHaveCount(1);
		await expect(inbox.locator('.view-header-overdue')).toHaveText('1 overdue');
		await inbox.clock.setSystemTime(new Date('2026-09-09T11:00:00Z'));
		await inbox.evaluate(() => window.dispatchEvent(new Event('pageshow')));
		await expect(row(inbox).locator('.is-overdue')).toHaveCount(0);
	});
}

try {
	for (const browserType of [chromium, webkit]) {
		const browser = await browserType.launch();
		try {
			await midnight(browser); await deadline(browser);
			console.log(`${browserType.name()}: midnight plus native 304, exact timed deadlines, counts, labels and clock-jump resume passed`);
		} finally { await browser.close(); }
	}
} finally {
	await new Promise(resolve => proxy.close(resolve));
	await new Promise(resolve => server.close(resolve));
}
