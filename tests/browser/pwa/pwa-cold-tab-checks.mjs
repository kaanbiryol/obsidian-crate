import { expect } from '@playwright/test';

/** Every pair of already loaded tabs may dissolve between its two destinations,
 * but must never reveal a third tab from an earlier visit. Covers direct dock
 * selections and the overflow picker as its pinned destination changes. */
export async function checkWarmTabDestinations(browser, origin) {
  const tabs = ['Inbox', 'Reminders', 'Projects', 'Reading', 'Favorites', 'Archive', 'Highlights'];
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion, serviceWorkers: 'block' });
    try {
      await context.route('**/reading/session', route => route.fulfill({ json: { id: 'warm-reading', folderPath: 'Reading', generation: 'one', expiresAt: Date.now() + 86400000 } }));
      await context.route('**/reading/list*', route => route.fulfill({ json: { items: [], issues: [], cursor: null } }));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/notifications?tab=inbox`);
      await page.locator('.pwa-reminders-view:not([data-pwa-opening])').waitFor();
      const select = async title => {
        const dock = page.locator('.crate-feature-panel[data-active="true"] .pwa-dock');
        const pinned = dock.getByRole('button', { name: title, exact: true });
        if (await pinned.count()) await pinned.click();
        else {
          await dock.locator('[data-dock-group]').press('ArrowDown');
          await page.getByRole('dialog', { name: 'More views', exact: true }).getByRole('button', { name: title, exact: true }).click();
        }
        await expect(page.locator('.crate-feature-panel[data-leaving="true"], .pwa-tab-panel[data-leaving]')).toHaveCount(0);
        await expect(page.locator('.crate-feature-panel[data-active="true"] .view-header-title')).toHaveText(title);
        await expect(page.locator('.crate-feature-panel[data-active="true"] .pwa-dock [data-dock-active="true"]')).toHaveAttribute('aria-label', title);
      };
      // Warm both features before checking remembered tab state.
      await select('Reading');
      await page.locator('.crate-reading-workspace').waitFor();
      for (const source of tabs) {
        for (const target of tabs.filter(tab => tab !== source)) {
          await select(source);
          await page.evaluate(() => {
            const titles = new Set();
            const sample = () => {
              for (const heading of document.querySelectorAll('.crate-feature-panel[data-active="true"] .view-header-title')) {
                const layer = heading.closest('.pwa-tab-panel');
                if (!layer || Number(getComputedStyle(layer).opacity) > 0) titles.add(heading.textContent);
              }
            };
            const observer = new MutationObserver(sample);
            observer.observe(document.querySelector('.crate-feature-shell'), { subtree: true, childList: true, characterData: true, attributes: true });
            let frame;
            const tick = () => { sample(); frame = requestAnimationFrame(tick); };
            tick();
            window.__stopWarmTabCapture = () => { observer.disconnect(); cancelAnimationFrame(frame); return [...titles]; };
          });
          await select(target);
          const titles = await page.evaluate(() => window.__stopWarmTabCapture());
          expect(titles.filter(title => title !== source && title !== target), `${source} → ${target}`).toEqual([]);
          expect(titles).toContain(target);
        }
      }
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }
}
