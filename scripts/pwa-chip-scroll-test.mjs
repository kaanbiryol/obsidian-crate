import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
try {
  for (const browserType of [chromium, webkit]) {
    const browser = await browserType.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      await page.route('**/reminders/list?*', route => route.fulfill({ json: {
        reminders: [{ id: 'chips', content: 'Check chip scrolling', project: 'Inbox', priority: 4,
          completed: false, filePath: 'Reminders/Inbox.md', revision: 'one' }],
        projects: ['Inbox', 'supersipeedlfkdkdksk'],
      } }));
      await page.goto(`http://127.0.0.1:${server.address().port}/notifications?folder=Reminders&tab=inbox`);
      await page.locator('[data-reminder-id="chips"]').click();
      const title = page.getByRole('textbox', { name: 'Reminder title', exact: true });
      await expect(title).toBeFocused();
      await title.fill('Check chip scrolling #supersipeedlfkdkdksk');
      const row = page.locator('.reminder-action-chips');
      await expect(row).toBeVisible();
      await expect.poll(() => row.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(40);
      if (browserType === chromium) {
        const session = await page.context().newCDPSession(page);
        await expect(page.locator('.pwa-modal-sheet__container')).toHaveCSS('transform', 'none');
        await expect(page.locator('.pwa-reminder-sheet-stage')).toHaveCSS('transform', 'none');
        const bounds = await row.boundingBox();
        const y = bounds.y + bounds.height / 2;
        const swipe = async (start, end) => {
          await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start, y }] });
          for (let step = 1; step <= 12; step++) {
            await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start + (end - start) * step / 12, y }] });
          }
          await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        };
        await swipe(300, 80);
        await expect.poll(() => row.evaluate(element => element.scrollLeft)).toBeGreaterThan(40);
        await swipe(80, 320);
        await expect.poll(() => row.evaluate(element => element.scrollLeft)).toBeLessThan(5);
        await expect(title).toBeFocused();
      }
      // Both engines must allow native panning even when starting on a chip.
      const policies = await row.locator('button').evaluateAll(buttons => buttons.map(button => {
        const event = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch' });
        button.dispatchEvent(event);
        return event.defaultPrevented;
      }));
      assert.ok(policies.every(value => !value), 'Touch presses must not cancel native scrolling');
      console.log(`${browserType.name()}: chip scroll passed`);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
