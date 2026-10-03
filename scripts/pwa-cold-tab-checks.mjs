import { expect } from '@playwright/test';

/** First entry from a saved Reading default must paint the requested tab even
 * while its lazy chunk is unavailable, and keep it through hydration. */
export async function checkColdReminderTabs(browser, origin) {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    for (const [tab, title] of [['inbox', 'Inbox'], ['projects', 'Projects']]) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion, serviceWorkers: 'block' });
      let release;
      const held = new Promise(resolve => { release = resolve; });
      try {
        await context.addInitScript(() => localStorage.setItem('crate-reminders-preferences', JSON.stringify({ defaultScreen: 'reading' })));
        const page = await context.newPage();
        await page.goto(`${origin}/notifications`);
        await page.getByRole('heading', { name: 'Connect your Reading folder', exact: true }).waitFor();
        // Reading has loaded, but Reminders has never mounted in this session.
        await page.route('**/notifications/assets/*', async route => { await held; await route.continue(); });
        await page.evaluate(() => {
          const panel = document.querySelector('[data-crate-section="reminders"]');
          window.__coldTabTitles = [];
          const sample = () => {
            if (panel.dataset.active !== 'true') return;
            for (const heading of panel.querySelectorAll('.view-header-title')) {
              const layer = heading.closest('.pwa-tab-panel');
              if (!layer || Number(getComputedStyle(layer).opacity) > 0) window.__coldTabTitles.push(heading.textContent);
            }
          };
          const observer = new MutationObserver(sample);
          observer.observe(panel, { subtree: true, childList: true, characterData: true, attributes: true });
          let frame;
          const tick = () => { sample(); frame = requestAnimationFrame(tick); };
          tick();
          window.__stopColdTabCapture = () => { observer.disconnect(); cancelAnimationFrame(frame); return window.__coldTabTitles; };
        });
        await page.locator(`.crate-feature-panel[data-active="true"] .pwa-dock [data-tab="${tab}"]`).click();
        const panel = page.locator('[data-crate-section="reminders"]');
        await expect(panel.locator('.pwa-launch-splash .view-header-title')).toHaveText(title);
        // Let the outer fade finish before hydration; a slow load must not
        // create a second, local fade from the default Reminders tab.
        await expect(page.locator('.crate-feature-panel[data-leaving="true"]')).toHaveCount(0);
        release();
        await panel.locator('.pwa-reminders-view:not([data-pwa-opening])').waitFor();
        await expect(panel.locator('.pwa-tab-panel[data-leaving]')).toHaveCount(0);
        await expect(panel.locator('.view-header-title')).toHaveText(title);
        expect(await page.evaluate(() => [...new Set(window.__stopColdTabCapture())])).toEqual([title]);
      } finally { release(); await context.close(); }
    }
  }
}
