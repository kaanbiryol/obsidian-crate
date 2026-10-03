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
const headerGeometry = page => page.locator('.crate-feature-panel[data-active="true"] .view-header').evaluate(header => {
  const rect = selector => {
    const bounds = header.querySelector(selector).getBoundingClientRect();
    return [bounds.x, bounds.y, bounds.height];
  };
  return {
    bottom: header.getBoundingClientRect().bottom,
    title: rect('.view-header-title'),
    meta: rect('.view-header-meta'),
    count: rect('.view-header-count'),
    settings: rect('[data-icon="settings"]'),
  };
});
try {
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({headless:true});
    try {
      for (const theme of ['light','dark']) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme:theme, reducedMotion:'reduce', hasTouch:true });
        const page = await context.newPage(); await installFeatureNavigation(page); const errors=[]; page.on('pageerror',error=>errors.push(error.message));
        await page.goto(`${origin}/notifications?folder=Reminders&tab=today`);
        await page.getByRole('button',{name:'Open settings',exact:true}).waitFor();
        await expect(page.locator('.crate-feature-nav')).toHaveCount(0);
        await expect(page.locator('.crate-feature-panel[data-crate-section="reading"]')).toHaveCSS('transition-duration', '0s');
        const title = page.locator('.crate-feature-panel[data-active="true"] .view-header-title');
        const visibleTitle = await title.innerText();
        const remindersHeader = await headerGeometry(page);
        expect(remindersHeader.meta[1] - (remindersHeader.title[1] + remindersHeader.title[2])).toBeCloseTo(6, 1);
        await mkdir('test-results/feature-switcher',{recursive:true});
        const historyLength = await page.evaluate(() => history.length);
        await checkBackGesture(page, '[data-crate-section="reminders"]');
        await switchFeature(page, 'Reading');
        await page.getByRole('heading',{name:'Connect your Reading folder',exact:true}).waitFor();
        expect(await headerGeometry(page)).toEqual(remindersHeader);
        await checkBackGesture(page, '[data-crate-section="reading"]');
        assert.equal(await page.evaluate(() => history.length), historyLength);
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(featureNavigationTarget(page)).toBeFocused();
        const headerSwitch = page.getByRole('button', { name: 'Switch to Reminders', exact: true });
        await (await headerSwitch.isVisible() ? headerSwitch : page.locator('.crate-feature-panel[data-active="true"] .pwa-dock [data-tab="today"]')).press('Enter');
        await expect(title).toHaveText(visibleTitle);
        await expect(featureNavigationTarget(page)).toBeFocused();
        await page.screenshot({path:`test-results/feature-switcher/${name}-${theme}-reminders.png`});
        await page.getByRole('button',{name:'Open settings',exact:true}).tap();
        await page.getByRole('dialog',{name:'Settings',exact:true}).waitFor();
        const settingsTrigger = page.locator('[data-crate-section="reminders"] .pwa-header-settings-button');
        await expect(settingsTrigger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(settingsTrigger).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
        await expect(settingsTrigger).toHaveCSS('opacity', '1');
        await expect(settingsTrigger).not.toHaveAttribute('aria-pressed');
        await page.getByRole('button',{name:'Close settings',exact:true}).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await page.setViewportSize({width:844,height:320});
        await switchFeature(page, 'Reading'); await switchFeature(page, 'Reminders');
        await expect(title).toHaveText(visibleTitle);
        await page.setViewportSize({width:1280,height:900});
        const desktopHeader = await headerGeometry(page);
        expect(desktopHeader.meta[1] - (desktopHeader.title[1] + desktopHeader.title[2])).toBeCloseTo(6, 1);
        expect(desktopHeader.title[0]).toBe(18);
        await switchFeature(page, 'Reading');
        expect(await headerGeometry(page)).toEqual(desktopHeader);
        await expect(featureNavigationTarget(page)).toBeFocused();
        await switchFeature(page, 'Reminders');
        await expect(title).toHaveText(visibleTitle);
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
        // A transition existing is insufficient: retain visible outgoing content
        // through the early frames instead of making ordinary dock taps look instant.
        for (const tab of ['today', 'projects', 'inbox', 'projects', 'today', 'inbox']) {
          const dissolve = await page.evaluate(async tab => {
            const panel = document.querySelector('[data-crate-section="reminders"]');
            const container = panel.querySelector('.pwa-navigation-viewport > .pwa-tab-transition');
            const outgoing = container.querySelector(':scope > .pwa-tab-panel:not([data-leaving])');
            panel.querySelector(`.pwa-dock [data-tab="${tab}"]`).click();
            await Promise.resolve();
            const fade = outgoing.getAnimations().find(animation => animation.transitionProperty === 'opacity');
            if (!fade) throw new Error(`Missing screen dissolve to ${tab}`);
            fade.pause();
            const opacity = time => { fade.currentTime = time; return Number(getComputedStyle(outgoing).opacity); };
            const incoming = container.querySelector(':scope > .pwa-tab-panel:not([data-leaving])');
            const result = { early: opacity(60), middle: opacity(120), duration: Number(fade.effect.getTiming().duration),
              interactive: !incoming.inert && outgoing.inert, covered: getComputedStyle(incoming).opacity === '1' };
            fade.finish();
            return result;
          }, tab);
          assert.ok(dissolve.early >= .7 && dissolve.early < 1, `${name} → ${tab}: keep the outgoing screen visible at 60ms: ${JSON.stringify(dissolve)}`);
          assert.ok(dissolve.middle >= .35 && dissolve.middle <= .65, `${name} → ${tab}: show both screens at 120ms: ${JSON.stringify(dissolve)}`);
          assert.ok(dissolve.duration <= 320 && dissolve.interactive && dissolve.covered);
          await expect(page.locator('.pwa-tab-panel[data-leaving]')).toHaveCount(0);
        }
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
        await page.getByRole('heading', { name: 'Connect your Reading folder', exact: true }).waitFor();
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
        // A second tab tap during the feature handoff must retain its own
        // outgoing screen, rather than being discarded by handoff cleanup.
        for (const tab of ['projects', 'inbox', 'projects']) {
          const localFade = await page.evaluate(async tab => {
            await window.__switchFeature('Reminders');
            const front = document.querySelector('.crate-feature-panel[data-front="true"]');
            const outer = front.getAnimations().find(animation => animation.transitionProperty === 'opacity');
            if (!outer) throw new Error('Expected a return dissolve');
            outer.pause(); outer.currentTime = 60;
            await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
            const panel = document.querySelector('[data-crate-section="reminders"]');
            const container = panel.querySelector('.pwa-tab-transition');
            const outgoing = container.querySelector(':scope > .pwa-tab-panel:not([data-leaving])');
            const entering = panel.dataset.entering;
            panel.querySelector(`.pwa-dock [data-tab="${tab}"]`).click();
            await Promise.resolve();
            const fade = outgoing.getAnimations().find(animation => animation.transitionProperty === 'opacity');
            if (fade) { fade.pause(); fade.currentTime = 60; }
            const result = { entering, retained: outgoing.isConnected, inert: outgoing.inert,
              opacity: outgoing.isConnected ? Number(getComputedStyle(outgoing).opacity) : 0,
              opaque: [...container.children].some(layer => getComputedStyle(layer).opacity === '1'),
              stationary: [...container.children].every(layer => getComputedStyle(layer).transform === 'none'),
              active: container.querySelector(':scope > .pwa-tab-panel:not([data-leaving])')?.dataset.tabView };
            fade?.finish(); outer.finish();
            return result;
          }, tab);
          assert.equal(localFade.entering, 'true');
          assert.ok(localFade.retained && localFade.inert && localFade.opacity > 0 && localFade.opacity < 1, JSON.stringify(localFade));
          assert.equal(localFade.active, tab === 'projects' ? 'browse' : tab);
          assert.ok(localFade.opaque && localFade.stationary, 'The tab dissolve stays covered and stationary');
          await settled('reminders');
          await expect(page.locator('.pwa-tab-panel[data-leaving]')).toHaveCount(0);
          await switchFeature(page, 'Reading');
          await settled('reading');
        }
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
