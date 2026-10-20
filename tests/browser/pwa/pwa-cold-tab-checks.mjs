import { expect } from '@playwright/test';

/** Pinned Reading destinations must survive the lazy feature handoff without
 * painting the default library or starting a second tab dissolve. */
export async function checkColdReadingTabs(browser, origin) {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    for (const [tab, view, title] of [['reading', 'inbox', 'Reading'], ['highlights', 'highlights', 'Highlights'], ['favorites', 'favorites', 'Favorites'], ['archive', 'archived', 'Archive']]) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion, serviceWorkers: 'block' });
      const held = Promise.withResolvers();
      try {
        await context.addInitScript(tab => localStorage.setItem('crate-reminders-preferences', JSON.stringify({ dockTabs: ['inbox', 'today', 'browse', tab] })), tab);
        await context.route('**/reading/session', route => route.fulfill({ json: { id: 'cold-reading', folderPath: 'Reading', generation: 'one', expiresAt: Date.now() + 86400000 } }));
        await context.route('**/reading/list*', route => route.fulfill({ json: { items: [], issues: [], cursor: null } }));
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${origin}/notifications?tab=browse`);
        await page.locator('.pwa-reminders-view:not([data-pwa-opening])').waitFor();
        await page.route('**/notifications/assets/*', async route => { await held.promise; await route.continue(); });
        await page.evaluate(() => {
          const panel = document.querySelector('[data-crate-section="reading"]');
          const titles = new Set();
          const sample = () => {
            if (panel.dataset.active !== 'true') return;
            for (const heading of panel.querySelectorAll('.view-header-title')) {
              const layer = heading.closest('.pwa-tab-panel');
              if (!layer || Number(getComputedStyle(layer).opacity) > 0) titles.add(heading.textContent);
            }
          };
          const observer = new MutationObserver(sample);
          observer.observe(panel, { subtree: true, childList: true, characterData: true, attributes: true });
          let frame;
          const tick = () => { sample(); frame = requestAnimationFrame(tick); };
          tick();
          window.__stopColdReadingCapture = () => { observer.disconnect(); cancelAnimationFrame(frame); return [...titles]; };
        });
        await page.locator('.crate-feature-panel[data-active="true"] .pwa-dock').getByRole('button', { name: title, exact: true }).click();
        const panel = page.locator('[data-crate-section="reading"]');
        await expect(panel.locator('.pwa-reading-opening .view-header-title')).toHaveText(title);
        await expect(panel.locator('.pwa-opening-dock')).toHaveAttribute('data-opening-selection', tab);
        // Hydrate only after the outer fade completes, so it cannot mask a
        // local transition from Reading to the requested destination.
        await expect(page.locator('.crate-feature-panel[data-leaving="true"]')).toHaveCount(0);
        held.resolve();
        await panel.locator('.crate-reading-workspace').waitFor();
        await expect(panel.locator('.pwa-tab-panel[data-leaving]')).toHaveCount(0);
        await expect(panel.locator('.view-header-title')).toHaveText(title);
        await expect(panel.locator('.pwa-tab-panel')).toHaveAttribute('data-tab-view', view);
        await expect(panel.locator('.pwa-dock [data-dock-active="true"]')).toHaveAttribute('aria-label', title);
        expect(await page.evaluate(() => window.__stopColdReadingCapture())).toEqual([title]);
        expect(errors).toEqual([]);
      } finally { held.resolve(); await context.close(); }
    }
  }
}

/** First entry from a saved Reading default must paint the requested tab even
 * while its lazy chunk is unavailable, and keep it through hydration. */
export async function checkColdReminderTabs(browser, origin) {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    for (const [tab, title] of [['inbox', 'Inbox'], ['today', 'Reminders'], ['projects', 'Projects']]) {
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
