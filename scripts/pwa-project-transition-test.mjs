import { checkDetailHistoryFreshness } from './pwa-detail-history-checks.mjs';
import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';
import { checkBackGesture } from './pwa-back-gesture-checks.mjs';
import { checkProjectMouseFeedback, checkProjectTouchFeedback } from './pwa-project-touch-checks.mjs';

const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
try {
  for (const type of [chromium, webkit]) {
    const browser = await type.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, colorScheme: 'dark', serviceWorkers: 'block' });
      const page = await context.newPage();
      const projects = ['Errands', 'Personal', 'Personal/Finance', ...Array.from({ length: 24 }, (_, index) => `Project ${index + 1}`)];
      await page.route('**/reminders/list?*', route => route.fulfill({ json: {
        projects, reminders: projects.map((project, index) => ({ id: `project-${index}`, content: `Reminder ${index}`, project,
          priority: 4, completed: false, filePath: `Reminders/${project}.md`, lineNumber: 1 })),
      } }));
      await page.goto(`http://127.0.0.1:${server.address().port}/notifications?folder=Reminders&tab=browse`);
      const target = page.getByRole('button', { name: 'Open Errands', exact: true });
      await expect(target).toBeVisible();
      await checkDetailHistoryFreshness(page, {
        open: async () => { await target.click(); await expect(page.locator('.pwa-project-layer')).toHaveAttribute('data-project-open', 'true'); },
        close: async () => { await page.goBack(); await page.waitForFunction(() => history.state?.reminderProjectList === true); },
        list: page.locator('.reminders-browse-view'), stateKey: 'reminderProjectStackId', detailKey: 'reminderProject',
      });
      const disclosure = page.locator('.premium-project-expand').first();
      const children = page.locator('.premium-project-children').first();
      const fullHeight = await children.evaluate(element => element.getBoundingClientRect().height);
      for (const colorScheme of ['dark', 'light']) {
        await page.emulateMedia({ colorScheme });
        await checkProjectTouchFeedback(page);
        await expect(disclosure.locator('svg[data-icon="chevron-down"]')).toBeVisible();
        await disclosure.tap();
        await expect(children).toBeHidden();
        await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
        await expect(disclosure.locator('svg[data-icon="chevron-right"]')).toBeVisible();
        assert.equal(await disclosure.evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)', 'Touch release must clear disclosure feedback');
        await disclosure.tap();
        await expect.poll(() => children.evaluate(element => element.getBoundingClientRect().height)).toBe(fullHeight);
        await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
        await expect(disclosure.locator('svg[data-icon="chevron-down"]')).toBeVisible();
        assert.equal(await disclosure.evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)', 'Expanded disclosure must not stay highlighted');
      }
      await page.emulateMedia({ colorScheme: 'dark' });
      for (const expanding of [false, true]) {
        const heights = await disclosure.evaluate(async button => {
          const panel = button.closest('.premium-project-group').querySelector('.premium-project-children');
          const samples = [];
          button.click();
          const start = performance.now();
          while (performance.now() - start < 400) {
            await new Promise(resolve => requestAnimationFrame(resolve));
            samples.push(panel.getBoundingClientRect().height);
          }
          return samples;
        });
        assert.ok(heights.some(height => height > 1 && height < fullHeight - 1), `Subprojects must animate ${expanding ? 'open' : 'closed'}: ${heights}`);
        assert.ok(Math.abs(heights.at(-1) - (expanding ? fullHeight : 0)) < 1, 'Subprojects must settle at the final height');
      }
      await disclosure.evaluate(async button => {
        button.click();
        await new Promise(resolve => setTimeout(resolve, 70));
        button.click();
      });
      await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
      await expect.poll(() => children.evaluate(element => element.getBoundingClientRect().height)).toBe(fullHeight);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await children.evaluate(element => getComputedStyle(element).transitionDuration), '0s');
      await disclosure.tap();
      await expect(children).toBeHidden();
      await disclosure.tap();
      await expect(children).toBeVisible();
      await page.keyboard.press('Tab');
      await disclosure.focus();
      assert.equal(await disclosure.evaluate(element => getComputedStyle(element).outlineStyle), 'solid', 'Keyboard users retain a visible focus cue');
      await page.keyboard.press('Enter');
      await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
      await expect(children).toBeHidden();
      await page.keyboard.press('Space');
      await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
      await expect(children).toBeVisible();
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      // Let matchMedia subscribers restore navigation motion before sampling it.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      console.log(`${type.name()}: subproject touch feedback, animation, reversal, keyboard, and reduced motion passed`);
      const before = await page.evaluate(() => {
        const elements = [...document.querySelectorAll('.premium-project-group, .premium-project-group .premium-project-content')];
        const borders = elements.map(element => {
          const style = getComputedStyle(element);
          return [style.borderTopWidth, style.borderTopStyle, style.borderRadius, style.backgroundColor];
        });
        const scroll = document.querySelector('.reminders-browse-view .ios-scroll');
        scroll.scrollTop = 180;
        return { borders, scrollTop: scroll.scrollTop };
      });
      assert.ok(before.borders.length >= 3, 'Exercise a grouped parent and child');
      assert.ok(before.scrollTop > 0, 'Exercise a scrolled Projects list');
      const opening = await page.evaluate(async () => {
        document.querySelector('[data-action="open-project"][data-project="Errands"]').click();
        // Reopening refreshes the history entry before mounting the screen.
        // That traversal is asynchronous and can take more than one frame.
        const deadline = performance.now() + 5000;
        while (!document.querySelector('.pwa-navigation-screen--project') && performance.now() < deadline) {
          await new Promise(resolve => requestAnimationFrame(resolve));
        }
        const screen = document.querySelector('.pwa-navigation-screen--project');
        if (!screen) throw new Error('Project did not mount after its history traversal');
        const samples = [];
        const x = () => { const transform = getComputedStyle(screen).transform; return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m41; };
        const started = performance.now();
        do { samples.push(x()); await new Promise(resolve => requestAnimationFrame(resolve)); } while (performance.now() - started < 1500 && (Math.abs(x()) >= 1 || screen.getAnimations().some(animation => animation.playState === 'running')));
        samples.push(x());
        return { samples, width: screen.getBoundingClientRect().width };
      });
      assert.ok(opening.samples.some(x => x > 1 && x < opening.width - 1), 'Project should slide over Projects');
      assert.ok(Math.abs(opening.samples.at(-1)) < 1, 'Project slide should settle at the left edge');
      assert.ok(opening.samples.every(x => x >= -.5 && x <= opening.width + .5), 'The spring must settle without visible overshoot');
      await expect(page.locator('.reminders-browse-view')).toHaveCount(1);
      await expect(page.locator('.pwa-project-layer')).toHaveAttribute('data-project-open', 'true');
      await expect(page.getByRole('heading', { name: 'Errands', exact: true })).toBeVisible();
      await expect(page.locator('.pwa-screen > .pwa-dock')).toHaveAttribute('inert', '');
      await checkBackGesture(page, '.pwa-project-layer', true);
      await expect(page.getByRole('button', { name: 'Back to projects', exact: true })).toBeVisible();
      await expect(page.locator('.project-detail-navigation .crate-back-button')).toHaveText('');
      await expect(page.locator('.project-detail-navigation .crate-back-button')).toHaveCSS('width', '44px');
      await expect(page.locator('.project-detail-navigation .crate-back-button')).toHaveCSS('border-radius', '999px');
      await expect(page.locator('.project-detail-navigation .crate-back-button')).toHaveCSS('background-image', /linear-gradient/);
      await expect(page.locator('.project-detail-header')).toHaveCSS('margin-top', '28px');
      await expect(page.locator('.project-detail-navigation .pwa-sync-indicator')).toBeVisible();
      await expect(page.locator('.project-detail-header .pwa-sync-indicator')).toHaveCount(0);
      const captureStyle = element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height, background: style.background, radius: style.borderRadius, color: style.color };
      };
      assert.deepEqual(await page.locator('.pwa-project-fab').evaluate(captureStyle), await page.locator('.pwa-screen > .pwa-dock .pwa-dock__add').evaluate(captureStyle), 'Project capture uses the main dock control');
      await page.locator('.pwa-project-fab').click();
      await expect(page.getByRole('dialog', { name: 'New reminder', exact: true })).toBeVisible();
      await checkBackGesture(page, '.pwa-project-layer');
      await page.getByRole('button', { name: 'Close reminder editor', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'New reminder', exact: true })).toHaveCount(0);
      await checkBackGesture(page, '.pwa-project-layer', true);
      const covered = await page.evaluate(() => {
        const screen = document.querySelector('.pwa-navigation-screen--project');
        const bar = document.querySelector('.pwa-dock');
        const rect = bar.getBoundingClientRect();
        return screen.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
      });
      assert.equal(covered, true, 'Project screen should cover the tab bar');
      assert.equal(new URL(page.url()).searchParams.get('project'), 'Errands');
      const detailHistoryLength = await page.evaluate(() => history.length);
      const list = page.locator('.reminders-browse-view .ios-scroll');
      const listState = await list.evaluate(scroll => ({ top: scroll.scrollTop, borders: [...document.querySelectorAll('.premium-project-group, .premium-project-group .premium-project-content')].map(element => {
        const style = getComputedStyle(element);
        return [style.borderTopWidth, style.borderTopStyle, style.borderRadius, style.backgroundColor];
      }) }));
      assert.equal(listState.top, before.scrollTop, 'Project navigation should preserve list scroll');
      assert.deepEqual(listState.borders, before.borders, 'Group borders and surfaces should remain stable');

      await page.locator('.pwa-project-layer .crate-back-button').click();
      await expect(page.locator('.pwa-navigation-screen--project')).toHaveCount(0);
      await page.waitForFunction(() => history.state?.reminderProjectList === true);
      await expect(page.locator('.pwa-screen > .pwa-dock')).not.toHaveAttribute('inert', '');
      assert.equal(new URL(page.url()).searchParams.has('project'), false);
      assert.equal(await list.evaluate(scroll => scroll.scrollTop), before.scrollTop);
      await expect(target).toBeFocused();

      // Back during the entrance must retarget the same surface from its current
      // position, keeping the list and history intact throughout the reversal.
      const interrupted = await page.evaluate(async () => {
        document.querySelector('[data-action="open-project"][data-project="Errands"]').click();
        // Reopening first refreshes browser history; measure from the actual entrance.
        while (!document.querySelector('.pwa-navigation-screen--project')) await new Promise(resolve => requestAnimationFrame(resolve));
        const screen = document.querySelector('.pwa-navigation-screen--project');
        const x = () => new DOMMatrixReadOnly(getComputedStyle(screen).transform).m41;
        const width = screen.getBoundingClientRect().width, entranceStarted = performance.now();
        // The mounted surface can wait for its first animation frame on CI.
        // Interrupt actual travel rather than assuming 80 ms delivered a frame.
        while ((x() <= 1 || x() >= width - 1) && performance.now() - entranceStarted < 1000) await new Promise(requestAnimationFrame);
        const before = x();
        screen.querySelector('.crate-back-button').click();
        await Promise.resolve();
        const after = x(), samples = [after], started = performance.now();
        while (screen.isConnected && performance.now() - started < 900) {
          await new Promise(resolve => requestAnimationFrame(resolve));
          if (screen.isConnected) samples.push(x());
        }
        return { before, after, samples, width };
      });
      assert.ok(interrupted.before > 1 && interrupted.before < interrupted.width - 1, JSON.stringify(interrupted));
      assert.ok(Math.abs(interrupted.after - interrupted.before) < interrupted.width * .15, 'Reversing must not reset the detail position');
      assert.ok(interrupted.samples.every(x => x >= -.5 && x <= interrupted.width + .5), JSON.stringify(interrupted));
      await expect(page.locator('.pwa-navigation-screen--project')).toHaveCount(0);
      await page.waitForFunction(() => history.state?.reminderProjectList === true);
      assert.equal(await list.evaluate(scroll => scroll.scrollTop), before.scrollTop);
      await expect(target).toBeFocused();

      await target.click();
      await expect(page.locator('.pwa-project-layer')).toHaveAttribute('data-project-open', 'true');
      const documentMarker = await page.evaluate(() => { window.projectDocumentMarker = crypto.randomUUID(); return window.projectDocumentMarker; });
      await page.goBack();
      await page.waitForFunction(() => history.state?.reminderProjectList === true);
      await expect(page.locator('.pwa-navigation-screen--project')).toHaveCount(0);
      assert.equal(await page.evaluate(() => window.projectDocumentMarker), documentMarker, 'History swipe must stay in this document');
      assert.equal(await page.evaluate(() => history.length), detailHistoryLength, 'Repeated project visits must reuse their history slot');
      await checkBackGesture(page, '.reminders-browse-view');
      await page.goto(`http://127.0.0.1:${server.address().port}/notifications?folder=Reminders&project=Personal%2FFinance`);
      await expect(page.getByRole('heading', { name: 'Personal/Finance', exact: true })).toBeVisible();
      await page.waitForFunction(() => history.state?.reminderProject === 'Personal/Finance');
      await checkBackGesture(page, '.pwa-project-layer', true);
      await page.goBack();
      await page.waitForFunction(() => history.state?.reminderProjectList === true);
      await expect(page.locator('.pwa-navigation-screen--project')).toHaveCount(0);
      await expect(page.locator('.pwa-screen > .pwa-dock')).not.toHaveAttribute('inert', '');
      console.log(`${type.name()}: project overlay, back navigation, and edge gesture passed`);
      await checkProjectMouseFeedback(browser, `http://127.0.0.1:${server.address().port}`);
      console.log(`${type.name()}: project touch hover and mouse feedback passed in both themes`);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
