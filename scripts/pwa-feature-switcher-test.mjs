import { switchFeature, featureNavigationTarget, installFeatureNavigation } from './pwa-feature-navigation.mjs';
import { checkBackGesture } from './pwa-back-gesture-checks.mjs';
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
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme:theme, reducedMotion:'reduce', hasTouch:true });
        const page = await context.newPage(); await installFeatureNavigation(page); const errors=[]; page.on('pageerror',error=>errors.push(error.message));
        await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
        await page.getByRole('button',{name:'Open settings',exact:true}).waitFor();
        await expect(page.locator('.crate-feature-nav')).toHaveCount(0);
        await expect(page.locator('.crate-feature-panel[data-crate-section="reading"]')).toHaveCSS('transition-duration', '0s');
        const visibleTitle = await page.locator('.view-header-title').innerText();
        await mkdir('test-results/feature-switcher',{recursive:true});
        const historyLength = await page.evaluate(() => history.length);
        await checkBackGesture(page, '[data-crate-section="reminders"]');
        await switchFeature(page, 'Reading');
        await page.getByRole('heading',{name:'Your reading, everywhere',exact:true}).waitFor();
        await checkBackGesture(page, '[data-crate-section="reading"]');
        assert.equal(await page.evaluate(() => history.length), historyLength);
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(featureNavigationTarget(page)).toBeFocused();
        await featureNavigationTarget(page).press('Enter');
        await expect(page.locator('.view-header-title')).toHaveText(visibleTitle);
        await expect(featureNavigationTarget(page)).toBeFocused();
        await page.screenshot({path:`test-results/feature-switcher/${name}-${theme}-reminders.png`});
        await page.getByRole('button',{name:'Open settings',exact:true}).tap();
        await page.getByRole('dialog',{name:'Settings',exact:true}).waitFor();
        const settingsTrigger = page.locator('.pwa-header-settings-button');
        await expect(settingsTrigger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(settingsTrigger).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
        await expect(settingsTrigger).toHaveCSS('opacity', '1');
        await expect(settingsTrigger).not.toHaveAttribute('aria-pressed');
        await page.getByRole('button',{name:'Close settings',exact:true}).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await page.setViewportSize({width:844,height:320});
        await switchFeature(page, 'Reading'); await switchFeature(page, 'Reminders');
        await expect(page.locator('.view-header-title')).toHaveText(visibleTitle);
        await page.setViewportSize({width:1280,height:900});
        await switchFeature(page, 'Reading');
        await expect(featureNavigationTarget(page)).toBeFocused();
        await switchFeature(page, 'Reminders');
        await expect(page.locator('.view-header-title')).toHaveText(visibleTitle);
        if(errors.length) throw new Error(errors.join('\n'));
        await context.close();
      }
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, reducedMotion: 'no-preference', serviceWorkers: 'block' });
      try {
        const page = await context.newPage(); await installFeatureNavigation(page);
        await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
        await featureNavigationTarget(page).waitFor();
        await page.locator('.pwa-reminders-view:not([data-pwa-opening])').waitFor();
        const panel = section => page.locator(`[data-crate-section="${section}"]`);
        const settled = async section => {
          await expect(panel(section)).toHaveAttribute('data-active', 'true');
          await expect(panel(section)).toHaveCSS('opacity', '1');
          await expect(panel(section === 'reading' ? 'reminders' : 'reading')).toHaveCSS('opacity', '0');
          await expect(page.locator('.crate-feature-panel[data-leaving="true"]')).toHaveCount(0);
        };
        // A lazy feature must show an opaque loading surface under the dissolve.
        let releaseReading;
        const heldReading = new Promise(resolve => { releaseReading = resolve; });
        await page.route('**/notifications/assets/*', async route => { await heldReading; await route.continue(); });
        const sampleSwitch = async destination => page.evaluate(async destination => {
          const panels = [...document.querySelectorAll('.crate-feature-panel')];
          const outgoing = panels.find(el => el.dataset.active === 'true');
          await window.__switchFeature(destination);
          const samples = [], start = performance.now();
          while (performance.now() - start < 260) {
            await new Promise(requestAnimationFrame);
            samples.push({ outgoing: Number(getComputedStyle(outgoing).opacity),
              coverage: 1 - panels.reduce((unpainted, el) => unpainted * (1 - Number(getComputedStyle(el).opacity)), 1),
              stationary: panels.every(el => getComputedStyle(el).transform === 'none'),
              inert: outgoing.inert });
          }
          return samples;
        }, destination);
        try {
          const frames = await sampleSwitch('Reading');
          assert.ok(frames.some(frame => frame.outgoing > 0 && frame.outgoing < 1), JSON.stringify(frames));
          assert.ok(frames.every(frame => frame.coverage === 1 && frame.stationary && frame.inert));
          await expect(page.getByRole('status', { name: 'Loading Reading' })).toBeVisible();
        } finally { releaseReading(); }
        await page.getByRole('heading', { name: 'Your reading, everywhere', exact: true }).waitFor();
        await settled('reading');
        await expect(featureNavigationTarget(page)).toBeFocused();
        const reverseFrames = await sampleSwitch('Reminders');
        assert.ok(reverseFrames.some(frame => frame.outgoing > 0 && frame.outgoing < 1));
        assert.ok(reverseFrames.every(frame => frame.coverage === 1 && frame.stationary && frame.inert));
        await settled('reminders');
        // Freeze the painted midpoint, then reverse without swapping layers or
        // restarting at opacity 1. Repeated toggles must remain usable throughout.
        for (let iteration = 0; iteration < 3; iteration++) {
          const reversal = await page.evaluate(async () => {
            const frame = () => new Promise(requestAnimationFrame);
            await window.__switchFeature('Reading');
            await frame(); await frame();
            const front = document.querySelector('.crate-feature-panel[data-front="true"]');
            const fade = front.getAnimations().find(animation => animation.transitionProperty === 'opacity');
            if (!fade) throw new Error('Expected a feature dissolve');
            fade.pause(); fade.currentTime = 60;
            const before = Number(getComputedStyle(front).opacity);
            const zIndex = getComputedStyle(front).zIndex;
            await window.__switchFeature('Reminders');
            // Inspect the replacement transition's starting keyframe before
            // a delayed CI frame can advance the return motion.
            const painted = Number(getComputedStyle(front).opacity);
            const reverse = front.getAnimations().find(animation => animation.transitionProperty === 'opacity');
            const after = reverse ? Number(reverse.effect.getKeyframes()[0].opacity) : painted;
            return { before, after,
              sameLayer: getComputedStyle(front).zIndex === zIndex,
              active: front.dataset.active, inert: front.inert };
          });
          assert.ok(reversal.before > 0 && reversal.before < 1, JSON.stringify(reversal));
          assert.ok(Math.abs(reversal.after - reversal.before) < .25, JSON.stringify(reversal));
          assert.ok(reversal.sameLayer && reversal.active === 'true' && !reversal.inert, JSON.stringify(reversal));
          await settled('reminders');
        }
        const delayed = await page.evaluate(async () => {
          await window.__switchFeature('Reading');
          await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
          const front = document.querySelector('.crate-feature-panel[data-front="true"]');
          const fade = front.getAnimations().find(animation => animation.transitionProperty === 'opacity');
          if (!fade) throw new Error('Expected a feature dissolve');
          fade.pause(); fade.currentTime = 60;
          await new Promise(resolve => setTimeout(resolve, 320));
          const retained = front.dataset.leaving === 'true';
          fade.finish();
          return retained;
        });
        assert.equal(delayed, true, 'Cleanup must follow the painted fade');
        await settled('reading');
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const reduced = await sampleSwitch('Reminders');
        assert.ok(reduced.every(frame => frame.coverage === 1 && frame.stationary && frame.outgoing === 0));
        await settled('reminders');
        assert.equal(await panel('reminders').evaluate(el => el.getAnimations().length), 0);
        await expect(featureNavigationTarget(page)).toBeFocused();
      } finally { await context.close(); }
      console.log(`${name}: feature fades, rapid reversal continuity, opaque loading, reduced motion, focus, and retained navigation passed.`);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
