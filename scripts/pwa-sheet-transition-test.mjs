import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, webkit, expect } from '@playwright/test';

// Exercise the real hook without an animation library delivering onCloseEnd.
const { outputFiles } = await build({
 stdin: { contents: `
 import React from 'react';
 import { createRoot } from 'react-dom/client';
 import { useSheetTransition } from './src/pwa/hooks/useSheetTransition';
 let closed = 0;
 function Harness() {
  const [open, setOpen] = React.useState(true);
  const onClosed = React.useCallback(() => { closed++; setOpen(false); }, []);
  const transition = useSheetTransition(onClosed);
  window.controls = { ...transition, closed: () => closed };
  return React.createElement('button', { id: 'background', inert: open }, 'Background');
 }
 window.root = createRoot(document.getElementById('root'));
 window.root.render(React.createElement(Harness));
 `, resolveDir: process.cwd(), loader: 'js' },
 bundle: true, write: false, format: 'iife', platform: 'browser',
});
for (const browserType of [chromium, webkit]) {
 const browser = await browserType.launch();
 try {
  const page = await browser.newPage();
  async function mount() {
   await page.goto('about:blank');
   await page.setContent('<div id="root"></div>');
   await page.addScriptTag({ content: outputFiles[0].text });
   await page.waitForFunction(() => Boolean(window.controls));
  }
  await mount();
  await page.evaluate(() => window.controls.requestClose());
  await expect(page.locator('#background')).not.toHaveAttribute('inert', '', { timeout: 2000 });
  assert.equal(await page.evaluate(() => window.controls.closed()), 1);
  await page.evaluate(() => window.controls.finishClose());
  assert.equal(await page.evaluate(() => window.controls.closed()), 1, 'Late callback must not close twice');

  await mount();
  await page.evaluate(() => window.controls.requestClose());
  await page.waitForTimeout(100);
  await page.evaluate(() => window.controls.cancelClose());
  await page.waitForTimeout(1100);
  assert.equal(await page.evaluate(() => window.controls.closed()), 0, 'Cancelled close must not dismiss a reopened sheet');
  await page.evaluate(() => window.controls.requestClose());
  await page.waitForTimeout(100);
  await page.evaluate(() => window.controls.finishClose());
  await expect(page.locator('#background')).not.toHaveAttribute('inert', '');
  await page.waitForTimeout(1100);
  assert.equal(await page.evaluate(() => window.controls.closed()), 1);

  await mount();
  await page.evaluate(() => window.controls.requestClose());
  await page.waitForTimeout(100);
  await page.evaluate(() => window.root.unmount());
  await page.waitForTimeout(1100);
  assert.equal(await page.evaluate(() => window.controls.closed()), 0, 'Unmount must cancel recovery');
  console.log(browserType.name() + ': sheet close recovery passed');
 } finally { await browser.close(); }
}
