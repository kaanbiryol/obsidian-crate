import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  for (const browserType of [chromium, webkit]) {
    const browser = await browserType.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block', reducedMotion: 'reduce' });
      let reminders = Array.from({ length: 20 }, (_, index) => ({
        id: `touch-${index}`, content: `Touch reminder ${index}`, description: 'Hold to reorder',
        project: 'Inbox', priority: 4, completed: false, filePath: 'Reminders/Inbox.md',
        revision: 'touch-revision', lineNumber: index + 1,
      }));
      const orders = [];
      await page.route('**/reminders/list?*', route => route.fulfill({ json: { reminders, projects: ['Inbox'] } }));
      await page.route('**/reminders/reorder', route => {
        const body = route.request().postDataJSON();
        orders.push(body.orderedIds);
        reminders = body.orderedIds.map(id => reminders.find(item => item.id === id));
        return route.fulfill({ json: { success: true } });
      });
      await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
      const first = page.locator('[data-reminder-id="touch-0"]');
      const second = page.locator('[data-reminder-id="touch-1"]');
      await expect(first).toBeVisible();
      for (const selector of ['.premium-reminder-title', '.premium-reminder-description']) {
        await expect(first.locator(selector)).toHaveCSS('-webkit-user-select', 'none');
      }
      if (browserType === chromium) {
        const session = await page.context().newCDPSession(page);
        const send = (type, point) => session.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [point] : [] });
        const from = await first.boundingBox();
        const to = await second.boundingBox();
        const x = from.x + from.width * 0.65;
        const y = from.y + from.height / 2;
        await send('touchStart', { x, y });
        await expect(first).toHaveClass(/is-long-press-armed/);
        const destination = to.y + to.height / 2 + 10;
        for (let step = 1; step <= 12; step++) {
          await send('touchMove', { x, y: y + (destination - y) * step / 12 });
        }
        await expect.poll(() => page.locator('[data-reminder-section="active"]').evaluateAll(rows => rows.slice(0, 2).map(row => row.dataset.reminderId)))
          .toEqual(['touch-1', 'touch-0']);
        await send('touchEnd');
        await expect.poll(() => orders.length).toBe(1);
        assert.deepEqual(orders[0], ['touch-1', 'touch-0', ...Array.from({ length: 18 }, (_, i) => `touch-${i + 2}`)]);
        await expect(page.getByRole('dialog')).toHaveCount(0);
        assert.equal(await page.evaluate(() => window.getSelection().toString()), '');
        // A fresh swipe must still scroll and must not submit another reorder.
        const scroll = page.locator('.reminders-view-scroll');
        const before = await scroll.evaluate(element => element.scrollTop);
        await send('touchStart', { x, y: 550 });
        for (let step = 1; step <= 10; step++) await send('touchMove', { x, y: 550 - step * 25 });
        await send('touchEnd');
        await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(before);
        assert.equal(orders.length, 1);
      }
      // Cards cannot select text, while opening a card still gives an editable title.
      await first.scrollIntoViewIfNeeded();
      await first.locator('.premium-reminder-title').tap();
      const title = page.getByRole('textbox', { name: 'Reminder title', exact: true });
      await expect(title).toBeVisible();
      await expect(title).not.toHaveCSS('-webkit-user-select', 'none');
      await title.fill('Editable after reorder');
      await title.press('ArrowLeft');
      await title.press('Shift+ArrowLeft');
      assert.ok(await page.evaluate(() => window.getSelection().toString().length > 0), 'Editor text remains selectable');
      console.log(`${browserType.name()}: card selection and editor selection passed${browserType === chromium ? '; native touch reorder, commit, and ordinary swipe passed' : ''}`);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
