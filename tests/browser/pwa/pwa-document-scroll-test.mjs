import assert from 'node:assert/strict';
import { webkit, expect } from '@playwright/test';
import sharp from 'sharp';
import { buildPwaPreviewAssets } from '../support/preview/pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from '../support/preview/pwa-preview-server.mjs';
import { previewAuthToken } from '../support/preview/pwa-preview-fixtures.mjs';

// Settled iOS list screens scroll the document so the status-bar tap reaches
// them. Desktop WebKit cannot tap the status bar; these checks cover the
// handoff around it. Verify the gesture itself on an iPhone.
const assets = await buildPwaPreviewAssets();
const { server, origin } = await listenPwaPreviewServer({ port: 0, assets });
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const readingSession = { token: previewAuthToken, id: 'document-scroll', folderPath: 'Reading', generation: 'document-scroll', expiresAt: Date.now() + 86400000 };
const articles = Array.from({ length: 30 }, (_, index) => ({
  crate_reading_version: 1, crate_reading_id: `67de6c50-c70c-4c85-93f2-${String(index + 1).padStart(12, '0')}`,
  title: `Document scroll article ${index}`, source_url: 'https://example.com/article', saved_at: '2026-09-21T10:00:00.000Z',
  reading_status: 'inbox', favorite: false, tags: index % 3 ? [] : ['essays'], extraction_status: 'ready', capture_method: 'web-clipper', path: `Reading/${index}.md`,
}));
const reminders = Array.from({ length: 60 }, (_, index) => ({
  id: `document-scroll-${index}`, content: `Document scroll reminder ${index}`, project: index % 2 ? 'Inbox' : 'Work',
  priority: 4, completed: false, dueDate: '2026-09-26', filePath: 'Reminders/Inbox.md', revision: 'document-scroll-1', lineNumber: index + 1,
}));
// A project short enough to fit on screen.
const errands = ['Pick up coffee beans', 'Print photos'].map((content, index) => ({
  id: `document-scroll-errand-${index}`, content, project: 'Errands', priority: 4, completed: false, dueDate: '2026-12-01',
  filePath: 'Reminders/Errands.md', revision: 'document-scroll-1', lineNumber: index + 1,
}));

const browser = await webkit.launch();

async function openApp(userAgent, path, { statusBarInset = 0, reducedMotion = 'reduce' } = {}) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, userAgent,
    serviceWorkers: 'block', timezoneId: 'UTC', reducedMotion,
  });
  await context.addInitScript(session => localStorage.setItem('crate-reading-session-v1', JSON.stringify(session)), readingSession);
  // Installed iOS 27 apps raise headers with their own z-index; chrome must stay above the cover.
  await context.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
    document.documentElement.setAttribute('data-pwa-ios27-standalone', 'true');
  }));
  await context.route('**/reading/session', route => route.fulfill({ json: readingSession }));
  await context.route('**/reading/tags*', route => route.fulfill({ json: { tags: ['essays'], counts: [articles.filter(item => item.tags.length).length] } }));
  await context.route('**/reading/items*', route => {
    const tag = new URL(route.request().url()).searchParams.get('tag');
    return route.fulfill({ json: { items: articles.filter(item => !tag || item.tags.includes(tag)), issues: [], cursor: null } });
  });
  await context.route('**/reading/item?*', route => route.fulfill({ json: {
    item: articles.find(item => item.crate_reading_id === new URL(route.request().url()).searchParams.get('id')),
    markdown: 'A long article for document scrolling. '.repeat(600),
  } }));
  await context.route('**/reminders/list?*', route => route.fulfill({ json: statusBarInset
    ? { reminders: [...reminders, ...errands], projects: ['Inbox', 'Work', 'Errands'], issues: [] }
    : { reminders, projects: ['Inbox', 'Work'], issues: [] } }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.setFixedTime(new Date('2026-09-26T12:00:00Z'));
  await page.goto(`${origin}${path}`);
  // Installed iOS apps recover the status bar inset that the shortened layout
  // viewport, and so innerHeight, excludes (ios27.css). Simulate that inset
  // before the list settles and hands its scrolling to the document.
  const app = 'html[data-pwa-ios27-standalone="true"]';
  if (statusBarInset) await page.addStyleTag({ content: `${app}, ${app} body, ${app} #app { height: calc(100vh + ${statusBarInset}px); }` });
  return { context, page, errors };
}

const owner = page => page.evaluate(() => document.querySelector('[data-document-scroll="true"]')?.className ?? null);
const documentOffset = page => page.evaluate(() => Math.round(scrollY));
const expectOwner = (page, className) => expect.poll(() => owner(page)).toContain(className);
// The visible header title, not the cover over rows, must receive hits.
const expectHeaderOnTop = page => expect.poll(() => page.evaluate(() => {
  const title = [...document.querySelectorAll('.crate-feature-panel[data-active="true"] .view-header-title')].at(-1);
  const bounds = title.getBoundingClientRect();
  return title.contains(document.elementFromPoint(bounds.left + 4, bounds.top + bounds.height / 2));
})).toBe(true);

async function pixels(page) {
  return sharp(await page.screenshot()).raw().toBuffer();
}

// The document and embedded scroller must draw the same screen at the same offset.
async function checkSeamless(path, scroller, ready) {
  const ios = await openApp(IPHONE, path);
  const desktop = await openApp(DESKTOP, path);
  try {
    for (const { page } of [ios, desktop]) await ready(page);
    await expectOwner(ios.page, scroller);
    await ios.page.evaluate(() => scrollTo({ top: 600, behavior: 'instant' }));
    assert.equal(await owner(desktop.page), null, 'other platforms keep embedded scrolling');
    await desktop.page.locator(`.crate-feature-panel[data-active="true"] .${scroller}`).evaluate(element => { element.scrollTop = 600; });
    const [document, embedded] = [await pixels(ios.page), await pixels(desktop.page)];
    let changed = 0;
    for (let index = 0; index < document.length; index++) if (Math.abs(document[index] - embedded[index]) > 8) changed++;
    // Linux WebKit draws one antialiased pixel differently in the two scrollers (3 bytes on CI).
    // Moved chrome or rows change tens of thousands.
    assert.ok(changed <= 12, `${scroller}: document scrolling must not move the header, rows or dock (${changed} bytes differ)`);
    assert.deepEqual([...ios.errors, ...desktop.errors], []);
  } finally {
    await ios.context.close();
    await desktop.context.close();
  }
}

try {
  await checkSeamless('/notifications?folder=Reminders&tab=today', 'reminders-view-scroll',
    page => expect(page.locator('.reminder-render-item')).toHaveCount(reminders.length));
  await checkSeamless('/notifications?section=reading', 'crate-reading__list-scroll',
    page => expect(page.locator('.crate-reading__open')).toHaveCount(articles.length));

  const { context, page, errors } = await openApp(IPHONE, '/notifications?folder=Reminders&tab=today');
  const today = page.locator('.crate-feature-panel[data-active="true"] .reminders-view-scroll');
  await expect(today.locator('.reminder-render-item')).toHaveCount(reminders.length);
  await expectOwner(page, 'reminders-view-scroll');
  await expectHeaderOnTop(page);
  // Fixed chrome stays put while the document scrolls and while iOS bounces it.
  const chrome = () => page.evaluate(() => [
    document.querySelector('.crate-feature-panel[data-active="true"] .view-header').parentElement,
    document.querySelector('.crate-feature-panel[data-active="true"] .pwa-schedule-switcher'),
    document.querySelector('.crate-feature-panel[data-active="true"] .pwa-dock'),
  ].map(element => `${getComputedStyle(element).position} ${Math.round(element.getBoundingClientRect().top)}`));
  const resting = await chrome();
  assert.ok(resting.every(entry => entry.startsWith('fixed ')), `header, switcher and dock are fixed: ${resting}`);
  for (const top of [900, 100000]) {
    await page.evaluate(offset => scrollTo({ top: offset, behavior: 'instant' }), top);
    assert.deepEqual(await chrome(), resting, 'chrome stays in place');
  }
  // The native status-bar tap scrolls the document to the top.
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await expect(today.locator('.reminder-render-item').first()).toBeInViewport();

  // Sheets recede an embedded screen and return the offset afterwards.
  await page.evaluate(() => scrollTo({ top: 700, behavior: 'instant' }));
  await page.getByRole('button', { name: 'Add reminder', exact: true }).first().tap();
  const editor = page.getByRole('dialog', { name: 'New reminder' });
  await editor.waitFor();
  assert.equal(await owner(page), null);
  assert.equal(await today.evaluate(element => element.scrollTop), 700);
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expectOwner(page, 'reminders-view-scroll');
  await expect.poll(() => documentOffset(page)).toBe(700);

  // A pushed project owns the document while open; Projects regains it on Back.
  await page.getByRole('button', { name: 'Projects', exact: true }).tap();
  await expectOwner(page, 'is-tab-aware');
  await page.locator('.premium-project-card').filter({ hasText: 'Work' }).first().tap();
  await expect.poll(() => page.evaluate(() => Boolean(document.querySelector('.pwa-project-layer [data-document-scroll="true"]')))).toBe(true);
  // Bouncing past the project's end must not reveal the screen and dock it covers.
  const behindProject = () => page.evaluate(() => ['.pwa-navigation-viewport', '.pwa-screen > .pwa-dock']
    .map(selector => getComputedStyle(document.querySelector(`.crate-feature-panel[data-active="true"] ${selector}`)).visibility));
  assert.deepEqual(await behindProject(), ['hidden', 'hidden']);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
    await page.evaluate(() => getComputedStyle(document.querySelector('.pwa-project-layer .pwa-navigation-screen')).backgroundColor));
  await page.getByRole('button', { name: /back/i }).first().tap();
  await expectOwner(page, 'is-tab-aware');
  assert.deepEqual(await behindProject(), ['visible', 'visible']);

  // The reader takes over the document and returns the library's offset.
  await page.getByRole('button', { name: 'Reading', exact: true }).tap();
  await expectOwner(page, 'crate-reading__list-scroll');
  await expectHeaderOnTop(page);
  await page.evaluate(() => scrollTo({ top: 500, behavior: 'instant' }));
  await page.locator('.crate-reading__open').filter({ hasText: 'Document scroll article 12' }).tap();
  await expectOwner(page, 'crate-reading-reader');
  await expect(page.locator('html')).not.toHaveClass(/pwa-document-scroll/);
  // Fixed chrome stays put while iOS bounces the article beneath it, and the
  // article still starts right below the header.
  const chromeLayout = () => page.evaluate(() => {
    const reader = document.querySelector('.crate-reading-reader');
    const nav = reader.querySelector('.crate-reading-reader__nav');
    return [nav, reader.querySelector('.crate-reading-reader__floating')].map(element => getComputedStyle(element).position)
      .concat(Math.round(reader.querySelector('.crate-reading-reader__page').getBoundingClientRect().top - nav.getBoundingClientRect().bottom));
  });
  await expect.poll(chromeLayout).toEqual(['fixed', 'fixed', 0]);
  // The article page clears the bottom safe area itself. Nothing may follow it,
  // or an article that fits on screen scrolls by the inset and stays there.
  const bottomInset = await page.addStyleTag({ content: ':root { --pwa-safe-area-bottom: 34px !important; }' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollHeight
    - Math.round(document.querySelector('.crate-reading-reader__page').getBoundingClientRect().bottom + scrollY)), 0,
  'the document ends with the article page');
  await bottomInset.evaluate(element => element.remove());
  await page.getByRole('button', { name: 'Back to reading', exact: true }).tap();
  await expectOwner(page, 'crate-reading__list-scroll');
  await expect.poll(() => documentOffset(page)).toBe(500);

  assert.deepEqual(errors, []);
  await context.close();

  // A notice that appears after the handoff, such as going offline, is pinned
  // under the header too instead of scrolling away under the cover.
  const offline = await openApp(IPHONE, '/notifications?folder=Reminders&tab=today');
  await expect(offline.page.locator('.reminder-render-item')).toHaveCount(reminders.length);
  await expectOwner(offline.page, 'reminders-view-scroll');
  await offline.context.setOffline(true);
  await offline.page.evaluate(() => window.dispatchEvent(new Event('offline')));
  const notice = offline.page.locator('.crate-feature-panel[data-active="true"] .pwa-connection-banner');
  await expect(notice).toBeVisible();
  await expect.poll(() => notice.evaluate(element => getComputedStyle(element.closest('.pwa-below-header-content')).position)).toBe('fixed');
  await expectOwner(offline.page, 'reminders-view-scroll');
  const noticeTop = await notice.evaluate(element => element.getBoundingClientRect().top);
  await offline.page.evaluate(() => scrollTo({ top: 600, behavior: 'instant' }));
  assert.equal(await notice.evaluate(element => element.getBoundingClientRect().top), noticeTop, 'the notice stays in place');
  assert.deepEqual(offline.errors, []);
  await offline.context.close();
  // The status bar inset must not let a short list scroll and stay under its
  // header, while a long list still reaches its last row.
  const inset = await openApp(IPHONE, '/notifications?folder=Reminders&tab=browse', { statusBarInset: 60 });
  await expectOwner(inset.page, 'is-tab-aware');
  const range = () => inset.page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  assert.equal(await range(), 0, 'a short list cannot scroll');
  await inset.page.locator('.premium-project-card').filter({ hasText: 'Errands' }).first().tap();
  await expect.poll(() => inset.page.evaluate(() => Boolean(document.querySelector('.pwa-project-layer [data-document-scroll="true"]')))).toBe(true);
  assert.equal(await range(), 0, 'a short project cannot scroll');
  assert.deepEqual(inset.errors, []);
  await inset.context.close();
  const long = await openApp(IPHONE, '/notifications?folder=Reminders&tab=today', { statusBarInset: 60 });
  await expect(long.page.locator('.reminder-render-item')).toHaveCount(reminders.length);
  await expectOwner(long.page, 'reminders-view-scroll');
  assert.ok(await long.page.evaluate(() => document.documentElement.scrollHeight - innerHeight) > 0, 'a long list still scrolls');
  await long.page.evaluate(() => scrollTo({ top: 100000, behavior: 'instant' }));
  await expect(long.page.locator('.reminder-render-item').last()).toBeInViewport();
  assert.deepEqual(long.errors, []);
  await long.context.close();
  // While the list scrolls the document, a pull moves its rows below the header cover rather
  // than carrying the cover down over the first rows, and a tag switch fades the old rows out
  // where they were drawn instead of a header's height lower.
  const tagged = await openApp(IPHONE, '/notifications?section=reading', { reducedMotion: 'no-preference' });
  const readingList = tagged.page.locator('.crate-feature-panel[data-active="true"] .crate-reading__list-scroll:not([data-departing-list])');
  await expect(readingList.locator('.crate-reading__open')).toHaveCount(articles.length);
  await expectOwner(tagged.page, 'crate-reading__list-scroll');
  const firstRow = () => tagged.page.evaluate(() => {
    const row = document.querySelector('.crate-feature-panel[data-active="true"] .crate-reading__list-scroll .crate-reading__open');
    const bounds = row.getBoundingClientRect();
    return { top: Math.round(bounds.top), clip: { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height } };
  });
  // The cover takes no hits, so look for the row's text in the pixels.
  const rowDrawn = async ({ clip }) => (await sharp(await tagged.page.screenshot({ clip })).stats()).channels.some(channel => channel.stdev > 8);
  const restingRow = await firstRow();
  assert.equal(await rowDrawn(restingRow), true, 'the first row shows at rest');
  const touch = (type, y) => tagged.page.evaluate(([type, y]) => {
    // Desktop WebKit does not expose a constructible Touch.
    const event = new Event(type, { bubbles: true, cancelable: true });
    const point = { clientY: y, clientX: 40 };
    Object.defineProperty(event, 'touches', { value: y === null ? { length: 0, item: () => null } : { length: 1, 0: point, item: () => point } });
    document.querySelector('.crate-feature-panel[data-active="true"] .crate-reading__list-scroll .crate-reading__open').dispatchEvent(event);
  }, [type, y]);
  await touch('touchstart', 300);
  await touch('touchmove', 500);
  await expect(tagged.page.locator('.crate-feature-panel[data-active="true"] .pwa-pull-refresh')).toHaveClass(/is-ready/);
  await expectOwner(tagged.page, 'crate-reading__list-scroll');
  const pulled = await firstRow();
  assert.ok(pulled.top - restingRow.top > 40, `the pull moves the rows down (${restingRow.top} -> ${pulled.top})`);
  assert.equal(await rowDrawn(pulled), true, 'the header cover stays over the header while pulling');
  await touch('touchcancel', null);
  await expect.poll(async () => (await firstRow()).top).toBe(restingRow.top);
  await tagged.page.evaluate(() => {
    const samples = window.__departingSamples = [];
    new MutationObserver(records => {
      for (const node of records.flatMap(record => [...record.addedNodes])) {
        if (!(node instanceof HTMLElement) || !node.dataset.departingList) continue;
        samples.push({ top: Math.round(node.querySelector('.crate-reading__open').getBoundingClientRect().top), owner: node.dataset.documentScroll ?? null });
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  const firstTop = (await firstRow()).top;
  await tagged.page.getByRole('group', { name: 'Filter by tag' }).getByRole('button', { name: 'essays', exact: true }).tap();
  await expect(readingList.locator('.crate-reading__open')).toHaveCount(articles.filter(item => item.tags.length).length);
  const departing = await tagged.page.evaluate(() => window.__departingSamples);
  assert.equal(departing.length, 1, 'the tag switch fades the old rows out');
  assert.equal(departing[0].owner, null, 'the copy is not a second document scroller');
  assert.ok(Math.abs(departing[0].top - firstTop) <= 1, `the old rows fade where they were drawn (${departing[0].top}, not ${firstTop})`);
  assert.deepEqual(tagged.errors, []);
  await tagged.context.close();
  console.log('PWA document scroll checks passed.');
} finally {
  await browser.close();
  server.close();
}
