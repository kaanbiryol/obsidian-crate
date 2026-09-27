import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;
const session = { token: 'reading-touch-test', id: 'reading-touch-test', folderPath: 'Reading', generation: 'touch-test', expiresAt: Date.now() + 86400000 };
const items = Array.from({ length: 28 }, (_, index) => ({
  crate_reading_version: 1, crate_reading_id: `67de6c50-c70c-4c85-93f2-${String(index).padStart(12, '0')}`,
  title: `Touch article ${index + 1}`, source_url: 'https://example.com/article', saved_at: '2026-09-21T10:00:00.000Z',
  reading_status: 'inbox', favorite: false, tags: [], extraction_status: 'ready', capture_method: 'web-clipper', path: `Reading/${index}.md`,
}));
const appearance = card => card.evaluate(element => {
  const css = getComputedStyle(element);
  return { background: css.backgroundColor, border: css.borderColor, shadow: css.boxShadow };
});
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(session => localStorage.setItem('crate-reading-session-v1', JSON.stringify(session)), session);
      await page.route('**/reading/session', route => route.fulfill({ json: session }));
      await page.route('**/reading/list*', route => route.fulfill({ json: { items, issues: [], cursor: null } }));
      await page.route('**/reading/item?*', route => route.fulfill({ json: {
        item: items.find(item => item.crate_reading_id === new URL(route.request().url()).searchParams.get('id')),
        markdown: 'A passage to read before returning to the library.\n\n'.repeat(80),
      } }));
      await page.goto(`${origin}/notifications?section=reading`);
      const button = page.locator('.crate-reading__open').first();
      const card = page.locator('.crate-reading__item').first();
      const workspace = page.locator('.crate-reading-workspace');
      await expect(button).toBeVisible();
      for (const colorScheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme });
        await page.mouse.move(-1, -1);
        await card.evaluate(async element => {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          await Promise.allSettled(element.getAnimations().map(animation => animation.finished));
        });
        const resting = await appearance(card);
        await card.hover();
        await expect.poll(() => appearance(card)).toEqual(resting);
        await page.mouse.move(-1, -1);
        for (const close of ['toolbar', 'history']) {
          await button.tap();
          await expect(page.locator('.crate-reading-reader__body')).toBeVisible();
          await expect(button).not.toHaveAttribute('data-press-active', '');
          if (close === 'toolbar') await page.getByRole('button', { name: 'Back to reading' }).tap();
          else await page.goBack();
          await expect(workspace).toHaveAttribute('data-reader-open', 'false');
          await expect(card).toHaveAttribute('data-selected', 'false');
          await expect.poll(() => appearance(card), { message: `${colorScheme}: ${close} return clears feedback` }).toEqual(resting);
        }
        if (engine === chromium) {
          const cdp = await page.context().newCDPSession(page);
          const send = (type, point) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [point] : [] });
          try {
            for (const ending of ['cancel', 'scroll']) {
              await button.scrollIntoViewIfNeeded();
              const box = await button.boundingBox();
              const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
              await send('touchStart', point);
              await expect(button).toHaveAttribute('data-press-active', '');
              await expect.poll(async () => (await appearance(card)).background).not.toBe(resting.background);
              if (ending === 'cancel') await send('touchCancel');
              else {
                for (let step = 1; step <= 7; step++) await send('touchMove', { x: point.x, y: point.y - step * 7 });
                await expect(button).not.toHaveAttribute('data-press-active', '');
                await expect.poll(() => appearance(card)).toEqual(resting);
                await send('touchEnd');
              }
              await expect(button).not.toHaveAttribute('data-press-active', '');
              await expect.poll(() => appearance(card)).toEqual(resting);
              await expect(workspace).toHaveAttribute('data-reader-open', 'false');
            }
            // Model the browser retaining :active after the card is covered.
            await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
            const { root } = await cdp.send('DOM.getDocument');
            const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.crate-reading__item' });
            await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['active'] });
            await expect.poll(() => appearance(card)).toEqual(resting);
            await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
          } finally { await cdp.detach(); }
        }
        await page.locator('.crate-reading__list-scroll').evaluate(element => { element.scrollTop = 0; });
      }
      // Keyboard return retains a usable focus target, without a selected card.
      await button.focus(); await page.keyboard.press('Enter');
      await expect(page.locator('.crate-reading-reader__body')).toBeVisible();
      await page.getByRole('button', { name: 'Back to reading' }).focus();
      await page.keyboard.press('Enter');
      await expect(workspace).toHaveAttribute('data-reader-open', 'false');
      await expect(button).toBeFocused();
      await expect(card).toHaveAttribute('data-selected', 'false');
      assert.deepEqual(errors, []);
      console.log(`${engine.name()}: Reading touch return, cancellation, scroll, hover, and keyboard checks passed`);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
