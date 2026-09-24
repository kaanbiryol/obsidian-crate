import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';
import { checkBackGesture } from './pwa-back-gesture-checks.mjs';

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
        await new Promise(resolve => requestAnimationFrame(resolve));
        const screen = document.querySelector('.pwa-navigation-screen--project');
        const samples = [];
        const x = () => { const transform = getComputedStyle(screen).transform; return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m41; };
        const started = performance.now();
        do { samples.push(x()); await new Promise(resolve => requestAnimationFrame(resolve)); } while (performance.now() - started < 380);
        return { samples, width: screen.getBoundingClientRect().width };
      });
      assert.ok(opening.samples.some(x => x > 1 && x < opening.width - 1), 'Project should slide over Projects');
      assert.ok(Math.abs(opening.samples.at(-1)) < 1, 'Project slide should settle at the left edge');
      await expect(page.locator('.reminders-browse-view')).toHaveCount(1);
      await expect(page.locator('.pwa-project-layer')).toHaveAttribute('data-project-open', 'true');
      await expect(page.getByRole('heading', { name: 'Errands', exact: true })).toBeVisible();
      await expect(page.locator('.bottom-tab-bar')).toHaveAttribute('inert', '');
      await checkBackGesture(page, '.pwa-project-layer', true);
      await page.locator('.pwa-project-fab').click();
      await expect(page.getByRole('dialog', { name: 'New reminder', exact: true })).toBeVisible();
      await checkBackGesture(page, '.pwa-project-layer');
      await page.getByRole('button', { name: 'Close reminder editor', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'New reminder', exact: true })).toHaveCount(0);
      await checkBackGesture(page, '.pwa-project-layer', true);
      const covered = await page.evaluate(() => {
        const screen = document.querySelector('.pwa-navigation-screen--project');
        const bar = document.querySelector('.bottom-tab-bar');
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

      await page.locator('.pwa-project-layer .premium-back-button').click();
      await expect(page.locator('.pwa-navigation-screen--project')).toHaveCount(0);
      await page.waitForFunction(() => history.state?.reminderProjectList === true);
      await expect(page.locator('.bottom-tab-bar')).not.toHaveAttribute('inert', '');
      assert.equal(new URL(page.url()).searchParams.has('project'), false);
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
      await expect(page.locator('.bottom-tab-bar')).not.toHaveAttribute('inert', '');
      console.log(`${type.name()}: project overlay, back navigation, and edge gesture passed`);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
