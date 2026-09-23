import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';
const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({headless:true});
    try {
      for (const theme of ['light','dark']) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme:theme, reducedMotion:'reduce' });
        const page = await context.newPage(); const errors=[]; page.on('pageerror',error=>errors.push(error.message));
        await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
        await page.getByRole('button',{name:'Open settings',exact:true}).waitFor();
        await expect(page.locator('.crate-feature-nav')).toHaveCount(0);
        await expect(page.locator('.crate-feature-panel[data-crate-section="reading"]')).toHaveCSS('transition-duration', '0s');
        const visibleTitle = await page.locator('.view-header-title').innerText();
        await mkdir('test-results/feature-switcher',{recursive:true});
        const toReading = page.getByRole('button',{name:'Switch to Reading',exact:true});
        const toReminders = page.getByRole('button',{name:'Switch to Reminders',exact:true});
        const switchBounds = await toReading.boundingBox();
        await expect(toReading).not.toHaveAttribute('aria-haspopup');
        await toReading.click();
        await page.getByRole('heading',{name:'Your reading, everywhere',exact:true}).waitFor();
        const readingBounds = await toReminders.boundingBox();
        assert.ok(switchBounds && readingBounds && Math.abs(switchBounds.x - readingBounds.x) < 5 && Math.abs(switchBounds.y - readingBounds.y) < 5,
          JSON.stringify({ switchBounds, readingBounds }));
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(toReminders).toBeFocused();
        await toReminders.press('Enter');
        await expect(page.locator('.view-header-title')).toHaveText(visibleTitle);
        await expect(toReading).toBeFocused();
        await page.screenshot({path:`test-results/feature-switcher/${name}-${theme}-reminders.png`});
        await page.getByRole('button',{name:'Open settings',exact:true}).click();
        await page.getByRole('dialog',{name:'Settings',exact:true}).waitFor();
        await page.getByRole('button',{name:'Close settings',exact:true}).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await page.setViewportSize({width:844,height:320});
        await toReading.click(); await toReminders.click();
        await expect(page.locator('.view-header-title')).toHaveText(visibleTitle);
        await page.setViewportSize({width:1280,height:900});
        await toReading.press('Space');
        await expect(toReminders).toBeFocused();
        await toReminders.click();
        await expect(page.locator('.view-header-title')).toHaveText(visibleTitle);
        if(errors.length) throw new Error(errors.join('\n'));
        await context.close();
      }
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion:'no-preference', serviceWorkers:'block' });
      try {
        const page = await context.newPage();
        await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
        await page.getByRole('button',{name:'Switch to Reading',exact:true}).waitFor();
        let releaseReading;
        const heldReading = new Promise(resolve => { releaseReading = resolve; });
        await page.route('**/notifications/assets/*', async route => { await heldReading; await route.continue(); });
        const motion = await page.evaluate(async () => {
          const reading = document.querySelector('[data-crate-section="reading"]');
          const reminders = document.querySelector('[data-crate-section="reminders"]');
          const switcher = reminders.querySelector('.pwa-feature-switch-button');
          const bar = reminders.querySelector('.animated-tab-bar-bottom');
          const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
          const state = () => ({ reading: Number(getComputedStyle(reading).opacity), reminders: Number(getComputedStyle(reminders).opacity),
            readingX: new DOMMatrixReadOnly(getComputedStyle(reading).transform).m41,
            remindersX: new DOMMatrixReadOnly(getComputedStyle(reminders).transform).m41,
            remindersScale: Number(getComputedStyle(reminders.querySelector('.reminders-content')).scale),
            headerScale: getComputedStyle(reminders.querySelector('.view-header')).scale,
            barScale: getComputedStyle(bar).scale });
          const activated = new Promise(resolve => {
            const observer = new MutationObserver(() => {
              if (reading.dataset.active !== 'true') return;
              observer.disconnect(); resolve();
            });
            observer.observe(reading, { attributes: true, attributeFilter: ['data-active'] });
          });
          switcher.click();
          await activated;
          const timing = { entering: getComputedStyle(reading).transitionDuration.split(',')[0],
            entryDelay: getComputedStyle(reading).transitionDelay.split(',')[0],
            leaving: getComputedStyle(reminders).transitionDuration.split(',')[0],
            hideDelay: getComputedStyle(reminders).transitionDelay.split(',')[1].trim(),
            settle: getComputedStyle(reminders.querySelector('.reminders-content')).transitionDuration };
          await pause(40);
          const first = state();
          await pause(80);
          const second = state();
          return { first, second, timing };
        });
        assert.equal(motion.timing.entering, '0.14s');
        assert.equal(motion.timing.entryDelay, '0.06s');
        assert.equal(motion.timing.leaving, '0.11s');
        assert.equal(motion.timing.hideDelay, '0.2s');
        assert.equal(motion.timing.settle, '0.2s');
        assert.ok(motion.second.reading > motion.first.reading, JSON.stringify(motion));
        assert.ok(motion.second.reminders < motion.first.reminders, JSON.stringify(motion));
        assert.ok(motion.second.remindersScale < motion.first.remindersScale, JSON.stringify(motion));
        assert.equal(motion.second.readingX, 0); assert.equal(motion.second.remindersX, 0);
        assert.equal(motion.second.headerScale, 'none');
        assert.equal(motion.second.barScale, 'none');
        await expect(page.locator('.pwa-reading-opening')).toBeVisible();
        await expect(page.getByRole('status',{name:'Loading Reading'})).toBeVisible();
        await expect(page.locator('.crate-reading__loading-row')).toHaveCount(4);
        await page.screenshot({path:`test-results/feature-switcher/${name}-transition-mid.png`});
        releaseReading();
        await page.waitForTimeout(80);
        await page.screenshot({path:`test-results/feature-switcher/${name}-transition.png`});
        await expect(page.locator('[data-crate-section="reminders"]')).toHaveCSS('visibility', 'hidden');
        await expect(page.locator('[data-crate-section="reminders"]')).toHaveAttribute('inert', '');
        await page.getByRole('button',{name:'Switch to Reminders',exact:true}).waitFor();
        await page.getByRole('heading',{name:'Your reading, everywhere',exact:true}).waitFor();
        await page.screenshot({path:`test-results/feature-switcher/${name}-reading.png`});
        const reverse = await page.evaluate(async () => {
          const reading = document.querySelector('[data-crate-section="reading"]');
          const reminders = document.querySelector('[data-crate-section="reminders"]');
          const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
          const state = () => ({ reading: Number(getComputedStyle(reading).opacity), reminders: Number(getComputedStyle(reminders).opacity),
            readingX: new DOMMatrixReadOnly(getComputedStyle(reading).transform).m41,
            remindersX: new DOMMatrixReadOnly(getComputedStyle(reminders).transform).m41,
            remindersScale: Number(getComputedStyle(reminders.querySelector('.reminders-content')).scale),
            headerScale: getComputedStyle(reminders.querySelector('.view-header')).scale,
            readingIcon: getComputedStyle(reading.querySelector('.pwa-feature-switch-button svg')).transform,
            remindersIcon: getComputedStyle(reminders.querySelector('.pwa-feature-switch-button svg')).transform,
            barScale: getComputedStyle(reminders.querySelector('.animated-tab-bar-bottom')).scale });
          reading.querySelector('.pwa-feature-switch-button').click();
          await pause(40);
          const first = state();
          await pause(80);
          return { first, second: state() };
        });
        assert.ok(reverse.second.reading < reverse.first.reading, JSON.stringify(reverse));
        assert.ok(reverse.second.reminders > reverse.first.reminders, JSON.stringify(reverse));
        assert.equal(reverse.second.readingX, 0); assert.equal(reverse.second.remindersX, 0);
        assert.ok(reverse.second.remindersScale < reverse.first.remindersScale, JSON.stringify(reverse));
        assert.equal(reverse.second.headerScale, 'none');
        assert.equal(reverse.second.barScale, 'none');
        assert.notEqual(reverse.first.readingIcon, reverse.second.readingIcon, JSON.stringify(reverse));
        assert.notEqual(reverse.first.remindersIcon, reverse.second.remindersIcon, JSON.stringify(reverse));
        await page.screenshot({path:`test-results/feature-switcher/${name}-reverse-mid.png`});
        await expect(page.locator('[data-crate-section="reading"]')).toHaveCSS('visibility', 'hidden');
        await expect(page.getByRole('button',{name:'Switch to Reading',exact:true})).toBeFocused();
        await page.evaluate(async () => {
          const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
          document.querySelector('[data-crate-section="reminders"] .pwa-feature-switch-button').click();
          await frame(); await frame();
          document.querySelector('[data-crate-section="reading"] .pwa-feature-switch-button').click();
        });
        await expect(page.locator('[data-crate-section="reminders"]')).toHaveAttribute('data-active', 'true');
        await expect(page.locator('[data-crate-section="reading"]')).toHaveCSS('visibility', 'hidden');
        await expect(page.getByRole('button',{name:'Switch to Reading',exact:true})).toBeFocused();
      } finally { await context.close(); }
      console.log(`${name}: staged mode fade, aligned switch button and icon morph, reduced motion, retained screen state, keyboard focus, and settings passed in light/dark at phone, short-screen, and desktop sizes.`);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve=>server.close(resolve)); }
