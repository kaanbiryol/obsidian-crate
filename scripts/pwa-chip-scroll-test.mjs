import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

const projectName = 'Long project name for horizontal scrolling';

async function chipPoint(chip) {
  return chip.evaluate(button => {
    const label = button.querySelector('.reminder-action-label');
    const rect = label.getBoundingClientRect();
    const row = button.parentElement.getBoundingClientRect();
    const x = (Math.max(rect.left, row.left + 8) + Math.min(rect.right, row.right - 8)) / 2;
    const y = rect.top + rect.height / 2;
    // Clipped animated labels and SVGs are presentation, not separate native
    // gesture surfaces. Check browser hit-testing, not just a CSS declaration.
    return { x, y, hitsButton: document.elementFromPoint(x, y) === button };
  });
}

async function swipe(session, point, distance) {
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  for (let step = 1; step <= 12; step++) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
      x: point.x + distance * step / 12, y: point.y + step / 4,
    }] });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
try {
  for (const browserType of [chromium, webkit]) {
    const browser = await browserType.launch();
    try {
      // Desktop WebKit supports wheel input; Chromium supplies real touch pans.
      // Neither substitutes for the installed app on a physical iPhone.
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'platform', { get: () => 'iPhone' });
      });
      await page.route('**/reminders/list?*', route => route.fulfill({ json: {
        reminders: [{ id: 'chips', content: 'Check chip scrolling', project: 'Inbox', priority: 4,
          completed: false, filePath: 'Reminders/Inbox.md', revision: 'one' }],
        projects: ['Inbox', projectName],
      } }));
      await page.goto(`http://127.0.0.1:${server.address().port}/notifications?folder=Reminders&tab=inbox`);
      await page.locator('[data-reminder-id="chips"]').tap();
      const title = page.getByRole('textbox', { name: 'Reminder title', exact: true });
      const editor = page.getByRole('dialog', { name: 'Edit reminder', exact: true });
      await expect(title).toBeFocused();
      const row = page.locator('.reminder-action-chips');
      const session = browserType === chromium ? await page.context().newCDPSession(page) : null;
      // Exercise a date label and a project label independently, including widths
      // smaller than a typical iPhone and an update after the row has mounted.
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        for (const picker of ['date', 'project']) {
          await title.fill(picker === 'date'
            ? `Check chip scrolling on June 10 2027 at 10:30 #${projectName}`
            : `Check chip scrolling #${projectName}`);
          const chip = row.locator(`[data-picker="${picker}"]`);
          if (picker === 'project') await expect(chip).toHaveText(projectName);
          else await expect(chip).toHaveClass(/is-active/);
          await expect(row).not.toHaveAttribute('inert');
          await expect(page.locator('.pwa-modal-sheet__container')).toHaveCSS('transform', 'none');
          await expect(page.locator('.pwa-reminder-sheet-stage')).toHaveCSS('transform', 'none');
          await expect.poll(() => row.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(40);
          // Wait for label width animations too, so input lands on its final text.
          await row.evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))));
          await row.evaluate(element => { element.scrollLeft = 0; });
          const { x, y, hitsButton } = await chipPoint(chip);
          assert.ok(hitsButton, `${picker} text must target its button for native panning`);
          const before = await editor.boundingBox();
          if (session) await swipe(session, { x, y }, -Math.min(120, x - 25));
          else {
            await page.mouse.move(x, y);
            await page.mouse.wheel(160, 0);
          }
          await expect.poll(() => row.evaluate(element => element.scrollLeft)).toBeGreaterThan(30);
          await expect(editor).toBeVisible();
          await expect(title).toBeFocused();
          await expect(page.getByRole('dialog')).toHaveCount(1);
          const after = await editor.boundingBox();
          assert.ok(Math.abs(after.y - before.y) < 1, 'Horizontal panning must not drag the sheet');
          assert.equal(await page.evaluate(() => window.scrollY), 0, 'Horizontal panning must not move the document');
          const bounds = await row.boundingBox();
          if (session) await swipe(session, { x: bounds.x + 25, y }, bounds.width - 50);
          else await page.mouse.wheel(-600, 0);
          await expect.poll(() => row.evaluate(element => element.scrollLeft)).toBeLessThan(5);
          // The same control must still open its picker after a pan.
          const tap = await chipPoint(chip);
          await page.touchscreen.tap(tap.x, tap.y);
          const dialog = page.getByRole('dialog', { name: picker === 'date' ? 'Schedule reminder' : 'Select project', exact: true });
          await expect(dialog).toBeVisible();
          await dialog.getByRole('button', { name: picker === 'date' ? 'Close schedule' : 'Close project selection', exact: true }).tap();
          await expect(editor).toBeVisible();
          await expect(title).toBeFocused();
        }
      }
      await session?.detach();
      console.log(`${browserType.name()}: long date/project chips scroll both ways, preserve focus and still open pickers`);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
