import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { openLocalRuntime, issueLocalDevice } from './local-server-runtime.mjs';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) test(`PWA dock ${name}: direct switching, motion, capture and compact layouts`, { timeout: 90000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crate-dock-'));
  let runtime, browser, server, page;
  try {
    runtime = await openLocalRuntime({ dataDir: dir });
    const vault = await issueLocalDevice(runtime.db, 'Dock test');
    const reminderFixture = { projects: ['Inbox'], reminders: Array.from({ length: 32 }, (_, index) => ({
      id: `dock-reminder-${index}`, content: `Dock scroll sample ${index + 1}`, project: 'Inbox',
      dueDatetime: new Date().toISOString(), priority: 4, completed: false, filePath: 'Reminders/Inbox.md', lineNumber: index + 1,
    })) };
    server = createServer(async (req, res) => {
      try {
        // Serve fixtures behind the service worker too; page.route does not intercept its requests.
        if (new URL(req.url, 'http://localhost').pathname === '/reminders/list') {
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(reminderFixture)); return;
        }
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
    const checkScrollUnderDock = async (selector, screenshot) => {
      const scroller = page.locator(`.crate-feature-panel[data-active="true"] ${selector}`).filter({ visible: true }).first();
      const fixtureStyle = await page.addStyleTag({ content: '[data-dock-scroll-fixture] > div { height:72px; margin-bottom:8px; padding:20px; border-radius:16px; background:var(--background-primary-alt); border:1px solid var(--background-modifier-border); color:var(--text-normal); }' });
      // Populate the real scroll container independently of the feature's empty fixture.
      await scroller.evaluate(element => {
        const fixture = document.createElement('div'); fixture.dataset.dockScrollFixture = '';
        for (let i = 0; i < 30; i++) {
          const row = document.createElement('div'); row.textContent = `Scroll sample ${i + 1}`;
          fixture.append(row);
        }
        element.append(fixture); element.scrollTop = 450;
      });
      try {
        const geometry = await scroller.evaluate(element => {
          const panel = element.closest('.crate-feature-panel');
          const bar = panel.querySelector('.pwa-dock__bar').getBoundingClientRect();
          const scroll = element.getBoundingClientRect();
          const hit = document.elementFromPoint(bar.left - 4, bar.top + bar.height / 2);
          return { bottom: scroll.bottom, panelBottom: panel.getBoundingClientRect().bottom, barTop: bar.top,
            passesThrough: element.contains(hit), padding: parseFloat(getComputedStyle(element).paddingBottom),
            clearance: scroll.bottom - bar.top };
        });
        assert.ok(Math.abs(geometry.bottom - geometry.panelBottom) < 1, 'List viewport extends behind the dock to the screen bottom');
        assert.ok(geometry.padding > geometry.clearance, 'End padding clears the dock');
        assert.equal(geometry.passesThrough, true, 'Space beside the dock passes pointer input to the list');
        await page.screenshot({ path: screenshot });
        await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
        const last = await scroller.locator('[data-dock-scroll-fixture] > :last-child').boundingBox();
        assert.ok(last.y + last.height <= geometry.barTop - 8, 'Last row scrolls fully above the dock');
      } finally {
        await scroller.evaluate(element => { element.querySelector('[data-dock-scroll-fixture]').remove(); element.scrollTop = 0; });
        await fixtureStyle.evaluate(element => element.remove());
      }
    };
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
    assert.deepEqual(await dock().locator('nav > button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))), ['Inbox', 'Schedule', 'Projects', 'Reading List']);
    await direct('Projects');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await direct('Schedule');
    // A reading destination must survive its first lazy mount.
    await selectView('Favorites');
    await expect(dock().locator('[data-dock-group]')).toBeFocused();
    await expect(page.locator('.crate-feature-panel[data-active="true"]')).toHaveAttribute('data-crate-section', 'reading');
    await page.getByRole('searchbox', { name: 'Search reading' }).fill('remember this');
    await direct('Inbox');
    await dock().locator('[data-dock-group]').tap(); await closed(); await active('Favorites');
    await expect(page.getByRole('searchbox', { name: 'Search reading' })).toHaveValue('remember this');
    // The highlight must slide from Reading even when returning to the remembered tab.
    for (const [index, label] of ['Inbox', 'Schedule', 'Projects'].entries()) {
      await direct(label);
      await dock().locator('[data-dock-group]').tap(); await closed(); await active('Favorites');
      const { positions, coverage } = await page.evaluate(async label => {
        const panel = document.querySelector('.crate-feature-panel[data-active="true"]');
        panel.querySelector(`.pwa-dock [aria-label="${label}"]`).click();
        const positions = [], coverage = []; const started = performance.now();
        while (performance.now() - started < 280) {
          await new Promise(resolve => requestAnimationFrame(resolve));
          const indicators = [...document.querySelectorAll('.crate-feature-panel .pwa-dock__indicator')];
          positions.push(indicators.map(indicator => new DOMMatrixReadOnly(getComputedStyle(indicator).transform).m41 / indicator.getBoundingClientRect().width));
          const panels = [...document.querySelectorAll('.crate-feature-panel')];
          coverage.push(1 - panels.reduce((unpainted, element) => unpainted * (1 - Number(getComputedStyle(element).opacity)), 1));
        }
        return { positions, coverage };
      }, label);
      assert.ok(coverage.every(value => value === 1), 'Section switching must never expose the backdrop');
      assert.ok(positions.some(pair => pair.every(value => value > index + .05 && value < 2.95)), `${name}: fourth-to-${label} must slide: ${JSON.stringify(positions)}`);
      assert.ok(positions.every(pair => Math.abs(pair[0] - pair[1]) < .03), 'Both docks must share one highlight position during the fade');
      assert.ok(positions.at(-1).every(value => Math.abs(value - index) < .01));
      await closed(); await active(label);
    }
    await direct('Projects'); await direct('Schedule');
    // Sideways movement cancels a pending hold.
    const start = await center(dock().locator('[data-dock-group]'));
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(start.x + 20, start.y); await page.waitForTimeout(480); await page.mouse.up();
    await closed(); await active('Schedule');
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
    // Match the working feature transition: fade the old painted screen over
    // an opaque incoming screen. A fade-in of replacement content is insufficient.
    const checkScreenFade = async (selector, interruptWith) => {
      const samples = await page.evaluate(async ({ selector, interruptWith }) => {
        const panel = document.querySelector('.crate-feature-panel[data-active="true"]');
        const container = panel.querySelector('.pwa-tab-transition');
        let outgoing = container.querySelector(':scope > .pwa-tab-panel:not([data-leaving])');
        const oldTitle = outgoing.querySelector('.view-header-title').textContent;
        const oldScroll = outgoing.querySelector('.reminders-view-scroll, .crate-reading__list-scroll');
        if (oldScroll && oldScroll.scrollHeight > oldScroll.clientHeight + 200) oldScroll.scrollTop = 180;
        const oldScrollTop = oldScroll?.scrollTop;
        const oldRect = outgoing.getBoundingClientRect();
        const click = target => panel.querySelector(target).click();
        click(selector);
        const samples = []; let started = performance.now();
        while (performance.now() - started < 420) {
          await new Promise(resolve => requestAnimationFrame(resolve));
          if (interruptWith && performance.now() - started > 80) {
            outgoing = container.querySelector(':scope > .pwa-tab-panel:not([data-leaving])');
            click(interruptWith); interruptWith = null; samples.length = 0; started = performance.now();
            continue;
          }
          const layers = [...container.querySelectorAll(':scope > .pwa-tab-panel')];
          const incoming = container.querySelector(':scope > .pwa-tab-panel:not([data-leaving])');
          const style = getComputedStyle(incoming), box = incoming.getBoundingClientRect();
          samples.push({ time: performance.now() - started,
            outgoing: outgoing.isConnected ? Number(getComputedStyle(outgoing).opacity) : 0,
            retained: outgoing.isConnected, inert: !outgoing.isConnected || outgoing.inert,
            oldTitle: outgoing.querySelector('.view-header-title').textContent === oldTitle,
            oldScroll: !outgoing.isConnected || !oldScroll || oldScroll.scrollTop === oldScrollTop,
            coverage: 1 - layers.reduce((unpainted, el) => unpainted * (1 - Number(getComputedStyle(el).opacity)), 1),
            fading: layers.some(el => { const opacity = Number(getComputedStyle(el).opacity); return opacity > .01 && opacity < .99; }), dock: Number(getComputedStyle(panel.querySelector('.pwa-dock')).opacity),
            x: box.x, y: box.y, oldX: oldRect.x, oldY: oldRect.y,
            transform: style.transform, translate: style.translate, scale: style.scale,
            animations: layers.filter(el => el.hasAttribute('data-leaving')).map(el => {
              const css = getComputedStyle(el); return [css.transitionProperty, css.transitionDuration, css.transitionTimingFunction];
            }),
          });
        }
        return samples;
      }, { selector, interruptWith });
      // Reversals shorten the remaining CSS transition, so sample its full range.
      const visibleFade = samples.filter(frame => frame.fading);
      assert.ok(visibleFade.length >= (interruptWith ? 1 : 2), JSON.stringify(samples));
      assert.ok(samples.every(frame => frame.coverage === 1 && frame.dock === 1), 'The dock stays opaque and the screen stack never exposes the backdrop');
      assert.ok(samples.every(frame => frame.inert), 'Outgoing views cannot receive input');
      if (!interruptWith) assert.ok(samples.every(frame => frame.oldTitle && frame.oldScroll), 'The outgoing title and scroll position remain painted until the dissolve finishes');
      assert.ok(samples.some(frame => frame.animations.some(animation => JSON.stringify(animation) === JSON.stringify(['opacity', '0.16s', 'ease-out']))), 'Tabs keep the feature fade duration and easing with reversible opacity transitions');
      assert.ok(samples.every(frame => frame.x === frame.oldX && frame.y === frame.oldY && frame.transform === 'none' && frame.translate === 'none' && frame.scale === 'none'));
      assert.equal(samples.at(-1).retained, false);
      await expect(page.locator('.pwa-tab-panel[data-leaving]')).toHaveCount(0);
    };
    await checkScreenFade('.pwa-dock [data-tab="projects"]');
    await active('Projects');
    await checkScreenFade('.pwa-dock [data-tab="today"]', '.pwa-dock [data-tab="inbox"]');
    await active('Inbox');
    for (const tab of ['today', 'projects', 'inbox', 'projects', 'today', 'inbox']) {
      await checkScreenFade(`.pwa-dock [data-tab="${tab}"]`);
    }
    await checkScreenFade('.pwa-dock [data-tab="today"]', '.pwa-dock [data-tab="inbox"]');
    // Like feature switching, reduced motion retains the stationary dissolve.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await checkScreenFade('.pwa-dock [data-tab="today"]');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await dock().locator('[data-dock-group]').tap(); await closed();
    await openViews();
    await checkScreenFade('[data-dock-destination="archived"]');
    await closed(); await active('Archive');
    if (process.env.PWA_DOCK_MOTION_ONLY === '1') {
      assert.deepEqual(errors, []);
      return;
    }
    const dragViews = async (input, { immediate = false, ending = 'select' } = {}) => {
      await direct('Schedule'); await page.mouse.move(-1, -1);
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
        await active('Schedule');
      }
      if (ending === 'outside') { await input.move({ x: 8, y: 140 }); await expect(views.locator('[data-preview="true"]')).toHaveCount(0); }
      if (ending === 'cancel') await input.cancel();
      else {
        if (ending === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        await input.up();
      }
      await closed(); await active(ending === 'select' ? 'Favorites' : 'Schedule');
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
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close settings', exact: true }).click(); await closed();
    await direct('Projects');
    await dock().getByRole('button', { name: 'Add reminder', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Reminder title', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close reminder editor', exact: true }).click(); await closed();
    await mkdir('test-results/dock', { recursive: true });
    for (const theme of ['light', 'dark']) for (const size of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(size); await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      const inset = size.width > size.height ? 21 : 34;
      const safeArea = await page.addStyleTag({ content: `:root { --pwa-safe-area-bottom: ${inset}px; }` });
      await direct('Schedule');
      const [reminderBar] = await geometry();
      assert.ok(Math.abs(size.height - reminderBar.y - reminderBar.height - inset) < 1, 'Reminders dock respects the safe area without adding a second gap');
      await page.screenshot({ path: `test-results/dock/${name}-${theme}-${size.width}-closed.png` });
      await checkScrollUnderDock('.reminders-view-scroll', `test-results/dock/${name}-${theme}-${size.width}-reminders-underlay.png`);
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
      await checkScrollUnderDock('.crate-reading__list-scroll', `test-results/dock/${name}-${theme}-${size.width}-reading-underlay.png`);
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


test('PWA dock indicator settles without repainting', { timeout: 30000 }, async () => {
  const { server } = await listenPwaPreviewServer({ port: 0, assets: await buildPwaPreviewAssets() });
  await mkdir('test-results/dock', { recursive: true });
  try {
    for (const engine of [chromium, webkit]) {
      const name = engine.name();
      const browser = await engine.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 393, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true, colorScheme: 'dark' });
        await page.goto(`http://127.0.0.1:${server.address().port}/notifications?folder=Reminders`);
        const dock = () => page.locator('.crate-feature-panel[data-active="true"] .pwa-dock');
        // DOM bounds miss a fractional-pixel repaint when a transform stops being
        // composited. Compare the final animated frame with the settled pixels.
        await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' });
        await expect(dock().locator('.pwa-dock__indicator')).toBeVisible();
        await expect(dock().getByRole('button', { name: 'Projects', exact: true })).toBeVisible();
        for (const label of ['Projects', 'Schedule', 'Inbox']) {
          const animation = await dock().evaluateHandle(async (element, label) => {
            element.querySelector(`[aria-label="${label}"]`).click();
            await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
            const slide = element.querySelector('.pwa-dock__indicator').getAnimations().find(animation => animation.transitionProperty === 'transform');
            if (!slide) throw new Error('Expected a sliding tab indicator');
            slide.pause(); slide.currentTime = Number(slide.effect.getTiming().duration) - .001;
            return slide;
          }, label);
          // Let the independent screen fade finish while the slide stays paused.
          await page.waitForTimeout(350);
          const bar = await dock().locator('.pwa-dock__bar').boundingBox();
          const clip = { x: Math.floor(bar.x), y: Math.floor(bar.y), width: Math.ceil(bar.width), height: Math.ceil(bar.height) };
          const moving = await page.screenshot({ clip, path: `test-results/dock/${name}-${label}-moving.png` });
          await animation.evaluate(slide => slide.finish());
          await page.waitForTimeout(100);
          const settled = await page.screenshot({ clip, path: `test-results/dock/${name}-${label}-settled.png` });
          assert.ok(moving.equals(settled), `${name}: ${label} highlight must not snap when the slide finishes`);
          await animation.dispose();
        }
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
