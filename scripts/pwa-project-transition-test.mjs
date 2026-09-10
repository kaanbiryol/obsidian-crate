import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
try {
  for (const type of [chromium, webkit]) {
    const browser = await type.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, colorScheme: 'dark' });
      const projects = ['Errands', 'Personal', 'Personal/Finance'];
      await page.route('**/reminders/list?*', route => route.fulfill({ json: {
        projects, reminders: projects.map((project, index) => ({ id: `project-${index}`, content: `Reminder ${index}`, project,
          priority: 4, completed: false, filePath: `Reminders/${project}.md`, lineNumber: 1 })),
      } }));
      await page.goto(`http://127.0.0.1:${server.address().port}/notifications?folder=Reminders&tab=browse`);
      const target = page.getByRole('button', { name: 'Open Errands', exact: true });
      await expect(target).toBeVisible();
      await page.evaluate(() => {
        const elements = [...document.querySelectorAll('.premium-project-group, .premium-project-group .premium-project-content')];
        const styles = () => elements.map(element => {
          const style = getComputedStyle(element);
          return [style.borderTopWidth, style.borderTopStyle, style.borderRadius, style.backgroundColor];
        });
        window.projectBorderBefore = styles();
        window.projectBorderFrames = [];
        const sample = () => {
          if (!elements.every(element => element.isConnected)) return;
          window.projectBorderFrames.push(styles());
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await target.tap();
      await expect(page.locator('.reminders-browse-view')).toHaveCount(0);
      const samples = await page.evaluate(() => ({ before: window.projectBorderBefore, frames: window.projectBorderFrames }));
      assert.ok(samples.before.length >= 3, 'Exercise a grouped parent and child');
      assert.ok(samples.frames.length > 2, 'Sample the animated outgoing list');
      for (const frame of samples.frames) assert.deepEqual(frame, samples.before, 'Group borders and surfaces must remain stable during navigation');
      console.log(`${type.name()}: grouped project borders stayed stable across ${samples.frames.length} animation frames`);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
