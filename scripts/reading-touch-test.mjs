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

async function checkScrollMotion(page, reducedMotion) {
  const samples = await page.locator('.crate-reading-reader').evaluate(async reader => {
    const nav = reader.querySelector('.crate-reading-reader__nav');
    const floating = reader.querySelector('.crate-reading-reader__floating');
    const scroller = reader.dataset.documentScroll === 'true' ? document.scrollingElement : reader;
    const sample = async top => {
      scroller.scrollTo({ top, behavior: 'instant' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { scroll: scroller.scrollTop, bottom: nav.getBoundingClientRect().bottom,
        opacity: Number(getComputedStyle(nav).opacity), floatingOpacity: Number(getComputedStyle(floating).opacity) };
    };
    const frames = [];
    // Small scroll steps and immediate reversals expose transitions that keep
    // restarting behind the gesture, even if the eventual endpoints look right.
    for (const top of [1800, 1796, 1776, 1772, 1776, 1772, 1768]) frames.push(await sample(top));
    frames.push(await sample(100), await sample(0));
    return frames;
  });
  assert.equal(samples[0].scroll, 1800);
  assert.equal(samples[0].opacity, 0);
  assert.equal(samples[1].opacity, 0, 'A tiny reversal at the hidden endpoint must not flicker');
  for (const sample of samples) assert.ok(Math.abs(sample.opacity - sample.floatingOpacity) < .001, 'Both controls follow the same scroll progress');
  if (reducedMotion === 'reduce') {
    for (const sample of samples) assert.ok(sample.opacity === 0 || sample.opacity === 1, 'Reduced motion switches visibility without a partial fade');
  } else {
    for (const [index, movement] of [[2, 12], [3, 4], [4, -4], [5, 4], [6, 4]]) {
      assert.ok(Math.abs(samples[index].bottom - samples[index - 1].bottom - movement) < 1,
        `Navigation must follow each scroll step without easing lag: ${JSON.stringify(samples)}`);
    }
  }
  assert.equal(samples.at(-2).opacity, 1);
  assert.equal(samples.at(-1).opacity, 1);
}

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
      let heldArticle;
      await page.route('**/reading/item?*', async route => {
        if (heldArticle) {
          const held = heldArticle; heldArticle = undefined;
          held.started.resolve();
          if (await held.release.promise === 'fail') return route.fulfill({ status: 503, json: { error: 'Article unavailable' } });
        }
        return route.fulfill({ json: {
          item: items.find(item => item.crate_reading_id === new URL(route.request().url()).searchParams.get('id')),
          markdown: 'A passage to read before returning to the library.\n\n'.repeat(80),
        } });
      });
      await page.goto(`${origin}/notifications?section=reading`);
      const button = page.locator('.crate-reading__open').first();
      const card = page.locator('.crate-reading__item').first();
      const workspace = page.locator('.crate-reading-workspace');
      await expect(button).toBeVisible();
      // Hold uncached content beyond the transition, including desktop and reduced motion.
      for (const [index, width, reducedMotion, fail] of [[1, 390, 'no-preference', false], [2, 390, 'reduce', false], [3, 1280, 'no-preference', false], [4, 390, 'no-preference', true]]) {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ reducedMotion });
        const safeArea = index === 1 ? await page.addStyleTag({ content: ':root { --pwa-safe-area-top: 47px; }' }) : null;
        const held = { started: Promise.withResolvers(), release: Promise.withResolvers() };
        heldArticle = held;
        try {
          await page.locator('.crate-reading__open').nth(index).click();
          await held.started.promise;
          const reader = page.locator('.crate-reading-reader');
          await expect(reader.getByRole('status', { name: 'Loading article', exact: true })).toBeVisible();
          await expect(reader.locator('h1')).toHaveCount(0);
          await expect(reader.locator('.crate-reading-reader__body')).toHaveCount(0);
          const back = reader.getByRole('button', { name: 'Back to reading' });
          await expect(back).toBeEnabled();
          await back.focus();
          held.release.resolve(fail ? 'fail' : 'ready');
          if (fail) {
            await expect(reader.getByRole('alert')).toBeVisible();
            await expect(reader.getByRole('heading', { name: items[index].title, exact: true })).toBeVisible();
            await expect(reader.locator('.crate-reading-reader__source')).toHaveAttribute('href', items[index].source_url);
            await reader.getByRole('button', { name: 'Retry', exact: true }).click();
          }
          await expect(reader.locator('.crate-reading-reader__body')).toBeVisible();
          await expect(reader.getByRole('heading', { name: items[index].title, exact: true })).toBeVisible();
          await expect(reader.getByText(/\d+ min read/)).toBeVisible();
          if (!fail) await expect(back).toBeFocused();
          if (!fail) {
            await back.evaluate(element => element.blur());
            await checkScrollMotion(page, reducedMotion);
            await back.focus();
          }
          await back.click();
          await expect(workspace).toHaveAttribute('data-reader-open', 'false');
          await expect(reader).toHaveCount(0);
        } finally { held.release.resolve('ready'); await safeArea?.evaluate(element => element.remove()); }
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
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
          // Sample the whole reveal, not only the settled card after Back.
          await page.evaluate(() => {
            window.readingReturnFrames = new Promise(resolve => {
              const frames = [], card = document.querySelector('.crate-reading__item');
              const workspace = document.querySelector('.crate-reading-workspace');
              let started;
              const sample = now => {
                if (workspace.dataset.readerOpen === 'false') {
                  started ??= now;
                  const css = getComputedStyle(card);
                  frames.push({ background: css.backgroundColor, border: css.borderColor, shadow: css.boxShadow });
                }
                if (started !== undefined && now - started >= 450) resolve(frames);
                else requestAnimationFrame(sample);
              };
              requestAnimationFrame(sample);
            });
          });
          if (close === 'toolbar') await page.getByRole('button', { name: 'Back to reading' }).tap();
          else await page.goBack();
          await expect(workspace).toHaveAttribute('data-reader-open', 'false');
          await expect(card).toHaveAttribute('data-selected', 'false');
          await expect.poll(() => appearance(card), { message: `${colorScheme}: ${close} return clears feedback` }).toEqual(resting);
          const frames = await page.evaluate(() => window.readingReturnFrames);
          assert.ok(frames.length > 1);
          assert.ok(frames.every(frame => JSON.stringify(frame) === JSON.stringify(resting)), `${colorScheme}: ${close} must not flash a selected card during return: ${JSON.stringify(frames)}`);
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
      // Wait for the app Back traversal before opening another article.
      await expect(workspace).toHaveAttribute('data-reader-motion', 'none');
      // The PWA keeps the stacked reader flow at desktop widths, without a selected-card surface.
      await page.setViewportSize({ width: 1280, height: 900 });
      const wideResting = await appearance(card);
      await button.tap();
      await expect(card).toHaveAttribute('data-selected', 'true');
      await card.evaluate(async element => {
        await Promise.allSettled(element.getAnimations().map(animation => animation.finished));
      });
      assert.equal((await appearance(card)).background, wideResting.background);
      assert.deepEqual(errors, []);
      console.log(`${engine.name()}: Reading return frames, desktop reader selection, touch cancellation, scroll, hover, and keyboard checks passed`);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
