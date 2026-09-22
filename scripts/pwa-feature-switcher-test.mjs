import { chromium, webkit, expect } from '@playwright/test';
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
        const visibleTitle = await page.locator('.view-header-title').innerText();
        await mkdir('test-results/feature-switcher',{recursive:true});
        const toReading = page.getByRole('button',{name:'Switch to Reading',exact:true});
        const toReminders = page.getByRole('button',{name:'Switch to Reminders',exact:true});
        await expect(toReading).not.toHaveAttribute('aria-haspopup');
        await toReading.click();
        await page.getByRole('heading',{name:'Your reading, everywhere',exact:true}).waitFor();
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
      console.log(`${name}: direct icon switching, signed-out Reading, retained reminder screen, keyboard focus, and settings passed in light/dark at phone, short-screen, and desktop sizes.`);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve=>server.close(resolve)); }
