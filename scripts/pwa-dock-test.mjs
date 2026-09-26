import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { openLocalRuntime, issueLocalDevice } from './local-server-runtime.mjs';

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) test(`PWA dock ${name}: direct switching, motion, capture and compact layouts`, { timeout: 90000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crate-dock-'));
  let runtime, browser, server, page;
  try {
    runtime = await openLocalRuntime({ dataDir: dir });
    const vault = await issueLocalDevice(runtime.db, 'Dock test');
    server = createServer(async (req, res) => {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const response = await runtime.mf.dispatchFetch(`${origin}${req.url}`, { method: req.method, headers: req.headers, ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }) });
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(500); res.end('Test server failed'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://localhost:${server.address().port}`;
    const api = async (path, body) => {
      const response = await runtime.mf.dispatchFetch(`${origin}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${vault.token}`, 'X-Crate-Protocol': '11', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 200, await response.clone().text()); return response.json();
    };
    await api('/reading/policy', { enabled: true, folderPath: 'Reading', revision: null });
    const enrollment = await api('/notifications/reminders-enrollment-token', { folderPath: 'Reminders' });
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    page = await context.newPage(); page.setDefaultTimeout(7000); const errors = []; page.on('pageerror', error => errors.push(error.message));
    const dock = () => page.locator('.crate-feature-panel[data-active="true"] .pwa-dock');
    const views = page.getByRole('dialog', { name: 'Reading views', exact: true });
    const geometry = () => dock().locator('.pwa-dock__bar, .pwa-dock__add').evaluateAll(elements => elements.map(el => {
      const { x, y, width, height } = el.getBoundingClientRect(); return { x, y, width, height };
    }));
    const active = async label => {
      await expect(dock().locator('[data-dock-active="true"]')).toHaveAccessibleName(label);
      const icon = { 'Reading List': 'book-open', Favorites: 'star', Archive: 'archive' }[label];
      if (icon) await expect(dock().locator('.pwa-dock__view-icon')).toHaveAttribute('data-icon', icon);
    };
    const center = async target => { const box = await target.boundingBox(); assert.ok(box); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
    const closed = async () => {
      await expect(views).toHaveCount(0);
      await expect(dock().locator('[data-dock-group]')).toHaveCSS('opacity', '1');
      await expect(dock().locator('.pwa-dock__surface')).toHaveCSS('height', '60px');
      await page.waitForFunction(() => !document.querySelector('[data-leaving="true"]'));
    };
    const openViews = async () => {
      const before = await geometry();
      const start = await center(dock().locator('[data-dock-group]'));
      await page.mouse.move(start.x, start.y); await page.mouse.down();
      await page.waitForTimeout(480); await page.mouse.up();
      await expect(views).toBeVisible();
      await expect(views.getByRole('button')).toHaveText(['Reading List', 'Favorites', 'Archive']);
      assert.deepEqual(await geometry(), before, 'Opening must not shift the page or add action');
      await expect(dock().locator('[data-dock-group]')).toHaveCSS('opacity', '0');
      await expect.poll(async () => {
        const surface = await dock().locator('.pwa-dock__surface').boundingBox();
        const menu = await views.boundingBox();
        return Math.max(Math.abs(surface.x - menu.x), Math.abs(surface.y - menu.y), Math.abs(surface.width - menu.width), Math.abs(surface.height - menu.height));
      }).toBeLessThan(1);
    };
    const selectView = async label => { await openViews(); await views.getByRole('button', { name: label, exact: true }).click(); await closed(); await active(label); };
    const direct = async label => { await dock().getByRole('button', { name: label, exact: true }).tap(); await closed(); await active(label); };
    await page.goto(`${origin}/notifications?browserToken=${enrollment.browserToken}`);
    await expect(dock()).toBeVisible();
    await expect(dock().locator('nav > button')).toHaveCount(4);
    assert.deepEqual(await dock().locator('nav > button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))), ['Inbox', 'Today', 'Projects', 'Reading List']);
    await direct('Projects');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await direct('Today');
    // A reading destination must survive its first lazy mount.
    await selectView('Favorites');
    await expect(dock().locator('[data-dock-group]')).toBeFocused();
    await expect(page.locator('.crate-feature-panel[data-active="true"]')).toHaveAttribute('data-crate-section', 'reading');
    await page.getByRole('searchbox', { name: 'Search reading' }).fill('remember this');
    await direct('Inbox');
    await dock().locator('[data-dock-group]').tap(); await closed(); await active('Favorites');
    await expect(page.getByRole('searchbox', { name: 'Search reading' })).toHaveValue('remember this');
    // The highlight must slide from Reading even when returning to the remembered tab.
    for (const [index, label] of ['Inbox', 'Today', 'Projects'].entries()) {
      await direct(label);
      await dock().locator('[data-dock-group]').tap(); await closed(); await active('Favorites');
      const positions = await page.evaluate(async label => {
        const panel = document.querySelector('.crate-feature-panel[data-active="true"]');
        panel.querySelector(`.pwa-dock [aria-label="${label}"]`).click();
        const positions = []; const started = performance.now();
        while (performance.now() - started < 280) {
          await new Promise(resolve => requestAnimationFrame(resolve));
          const indicators = [...document.querySelectorAll('.crate-feature-panel .pwa-dock__indicator')];
          positions.push(indicators.map(indicator => new DOMMatrixReadOnly(getComputedStyle(indicator).transform).m41 / indicator.getBoundingClientRect().width));
        }
        return positions;
      }, label);
      assert.ok(positions.some(pair => pair.every(value => value > index + .05 && value < 2.95)), `${name}: fourth-to-${label} must slide: ${JSON.stringify(positions)}`);
      assert.ok(positions.every(pair => Math.abs(pair[0] - pair[1]) < .03), 'Both docks must share one highlight position during the fade');
      assert.ok(positions.at(-1).every(value => Math.abs(value - index) < .01));
      await closed(); await active(label);
    }
    await direct('Projects'); await direct('Today');
    // Sideways movement cancels a pending hold.
    const start = await center(dock().locator('[data-dock-group]'));
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(start.x + 20, start.y); await page.waitForTimeout(480); await page.mouse.up();
    await closed(); await active('Today');
    await dock().locator('[data-dock-group]').press('ArrowDown');
    await expect(views).toBeVisible(); await page.keyboard.press('Escape'); await closed();
    // A spring grows continuously and keeps its current shape when reversed.
    const interrupted = await page.evaluate(async () => {
      const dock = document.querySelector('.crate-feature-panel[data-active="true"] .pwa-dock');
      const surface = dock.querySelector('.pwa-dock__surface');
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      const height = () => parseFloat(getComputedStyle(surface).height);
      dock.querySelector('[data-dock-group]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      const samples = []; const start = performance.now();
      while (performance.now() - start < 120) { await frame(); samples.push(height()); }
      const before = height();
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await frame(); const after = height();
      return { samples, before, after };
    });
    assert.ok(interrupted.before > 70, JSON.stringify(interrupted));
    assert.ok(interrupted.samples.every((height, i, values) => height >= 60 && (!i || height >= values[i - 1] - .1)), 'Opening must grow without a staged shrink');
    assert.ok(Math.abs(interrupted.before - interrupted.after) < 20, 'Reversing must not jump');
    await closed();
    // Measure painted opacity, not merely the existence of animation keyframes.
    // The title and body must share a visible fade while the dock stays solid.
    const checkScreenFade = async (selector, interruptWith) => {
      const samples = await page.evaluate(async ({ selector, interruptWith }) => {
        const panel = document.querySelector('.crate-feature-panel[data-active="true"]');
        const screen = panel.querySelector('.pwa-navigation-viewport, .crate-reading__library');
        const title = screen.querySelector('.view-header-title');
        const body = screen.querySelector('.reminders-content, .crate-reading__list-scroll');
        const dock = panel.querySelector('.pwa-dock');
        const opacity = element => {
          let result = 1;
          for (let el = element; el && el !== panel; el = el.parentElement) result *= Number(getComputedStyle(el).opacity);
          return result;
        };
        const click = target => panel.querySelector(target).click();
        click(selector);
        const samples = []; let started = performance.now();
        while (performance.now() - started < 380) {
          await new Promise(resolve => requestAnimationFrame(resolve));
          if (interruptWith && performance.now() - started > 80) {
            click(interruptWith); interruptWith = null; samples.length = 0; started = performance.now();
            continue;
          }
          const style = getComputedStyle(screen), box = screen.getBoundingClientRect();
          samples.push({ time: performance.now() - started, title: opacity(title), body: opacity(body), dock: opacity(dock),
            x: box.x, y: box.y, transform: style.transform, translate: style.translate, scale: style.scale });
        }
        return samples;
      }, { selector, interruptWith });
      assert.ok(samples.some(frame => frame.title < .15 && frame.body < .15), JSON.stringify(samples));
      const visibleFade = samples.filter(frame => frame.title > .15 && frame.title < .85);
      assert.ok(visibleFade.length >= 4 && visibleFade.at(-1).time - visibleFade[0].time >= 80, JSON.stringify(samples));
      assert.ok(samples.every(frame => Math.abs(frame.title - frame.body) < .01 && frame.dock === 1), 'Heading and body must fade together; dock must remain solid');
      assert.ok(samples.every(frame => frame.x === samples[0].x && frame.y === samples[0].y && frame.transform === 'none' && frame.translate === 'none' && frame.scale === 'none'));
      assert.equal(samples.at(-1).title, 1); assert.equal(samples.at(-1).body, 1);
    };
    await checkScreenFade('.pwa-dock [data-tab="projects"]');
    await active('Projects');
    await checkScreenFade('.pwa-dock [data-tab="today"]', '.pwa-dock [data-tab="inbox"]');
    await active('Inbox');
    await dock().locator('[data-dock-group]').tap(); await closed();
    await openViews();
    await checkScreenFade('[data-dock-destination="archived"]');
    await closed(); await active('Archive');
    const dragViews = async (input, { immediate = false, ending = 'select' } = {}) => {
      await direct('Today'); await page.mouse.move(-1, -1);
      const start = await center(dock().locator('[data-dock-group]'));
      await input.down(start);
      if (immediate) await input.move({ x: start.x, y: start.y - 18 });
      else await page.waitForTimeout(480);
      await expect(views).toBeVisible();
      for (const label of ['Archive', 'Reading List', 'Favorites']) {
        const choice = views.getByRole('button', { name: label, exact: true });
        await input.move(await center(choice));
        await expect(choice).toHaveAttribute('data-preview', 'true');
        await expect(views.locator('[data-preview="true"]')).toHaveCount(1);
        await active('Today');
      }
      if (ending === 'outside') { await input.move({ x: 8, y: 140 }); await expect(views.locator('[data-preview="true"]')).toHaveCount(0); }
      if (ending === 'cancel') await input.cancel();
      else {
        if (ending === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        await input.up();
      }
      await closed(); await active(ending === 'select' ? 'Favorites' : 'Today');
    };
    const mouse = {
      down: async point => { await page.mouse.move(point.x, point.y); await page.mouse.down(); },
      move: point => page.mouse.move(point.x, point.y, { steps: 5 }), up: () => page.mouse.up(),
    };
    await dragViews(mouse); await dragViews(mouse, { immediate: true });
    await dragViews(mouse, { ending: 'outside' }); await dragViews(mouse, { ending: 'blur' });
    if (name === 'chromium') {
      const session = await context.newCDPSession(page);
      const send = (type, point) => session.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [point] : [] });
      const touch = { down: point => send('touchStart', point), move: point => send('touchMove', point), up: () => send('touchEnd'), cancel: () => send('touchCancel') };
      try {
        await dragViews(touch); await dragViews(touch, { immediate: true });
        await dragViews(touch, { ending: 'outside' }); await dragViews(touch, { ending: 'cancel' });
      } finally { await session.detach(); }
    }
    await selectView('Archive'); await openViews();
    await expect(views.getByRole('button', { name: 'Archive', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(views.locator('[data-icon="check"]')).toHaveCount(0);
    await page.mouse.click(8, 140); await closed(); await active('Archive');
    await selectView('Reading List');
    await dock().getByRole('button', { name: 'Save a link', exact: true }).click();
    await expect(page.getByLabel('Link', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Close/ }).click(); await closed();
    await page.getByRole('button', { name: 'Reading settings', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Reading settings', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close reading settings', exact: true }).click(); await closed();
    await direct('Projects');
    await dock().getByRole('button', { name: 'Add reminder', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Reminder title', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close reminder editor', exact: true }).click(); await closed();
    await mkdir('test-results/dock', { recursive: true });
    for (const theme of ['light', 'dark']) for (const size of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(size); await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      const inset = size.width > size.height ? 21 : 34;
      const safeArea = await page.addStyleTag({ content: `:root { --pwa-safe-area-bottom: ${inset}px; }` });
      await direct('Today');
      const [reminderBar] = await geometry();
      assert.ok(Math.abs(size.height - reminderBar.y - reminderBar.height - inset) < 1, 'Reminders dock respects the safe area without adding a second gap');
      await page.screenshot({ path: `test-results/dock/${name}-${theme}-${size.width}-closed.png` });
      await openViews();
      assert.equal(await dock().locator('.pwa-dock__surface').evaluate(element => element.getAnimations().length), 0);
      const box = await views.boundingBox();
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width + 1 && box.y + box.height <= size.height + 1);
      await page.screenshot({ path: `test-results/dock/${name}-${theme}-${size.width}-views.png` });
      await views.getByRole('button', { name: 'Archive', exact: true }).click(); await closed(); await active('Archive');
      const [readingBar] = await geometry();
      assert.ok(Math.abs(size.height - readingBar.y - readingBar.height - inset) < 1, 'Reading dock uses the same safe-area offset');
      await expect(dock().locator('.pwa-dock__indicator')).toHaveCSS('transition-duration', '0s');
      await expect(dock().locator('nav > button')).toHaveCount(4);
      assert.ok(await dock().locator('nav > button').evaluateAll(buttons => buttons.every(button => button.getBoundingClientRect().width >= 44)));
      assert.equal(await page.locator('.crate-reading__library').evaluate(el => el.getAnimations().length), 0);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await safeArea.evaluate(element => element.remove());
    }
    assert.deepEqual(errors, []);
  } catch (error) {
    if (page) { await mkdir('test-results/dock', { recursive: true }); await page.screenshot({ path: `test-results/dock/${name}-failure.png` }); console.log(await page.locator('body').innerText()); }
    throw error;
  } finally {
    await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
    await runtime?.close(); await rm(dir, { recursive: true, force: true });
  }
});
