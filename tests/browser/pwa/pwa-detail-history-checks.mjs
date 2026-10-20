import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

// Observe the DOM at the push that supplies the native predecessor. A settled
// screenshot after Back alone cannot detect a stale browser-owned preview.
export async function checkDetailHistoryFreshness(page, { open, close, list, stateKey, detailKey }) {
  await page.evaluate(detailKey => {
    window.__detailPredecessor = null;
    const push = history.pushState.bind(history);
    history.pushState = (state, unused, url) => {
      if (state?.[detailKey]) window.__detailPredecessor = {
        scheme: document.documentElement.dataset.pwaColorScheme,
        background: getComputedStyle(document.documentElement).backgroundColor,
        source: history.state,
        detailVisible: !!document.querySelector('.pwa-project-layer[data-project-open="true"], .crate-reading-workspace[data-reader-open="true"]'),
      };
      return push(state, unused, url);
    };
  }, detailKey);
  let length;
  for (const scheme of ['light', 'dark', 'light']) {
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('button', { name: scheme === 'light' ? 'Light' : 'Dark', exact: true }).click();
    await settings.getByRole('button', { name: 'Close settings', exact: true }).click();
    await expect(settings).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-pwa-color-scheme', scheme);
    const background = await page.locator('html').evaluate(element => getComputedStyle(element).backgroundColor);
    const before = await list.evaluate(element => ({ text: element.textContent, top: element.scrollTop }));
    await open();
    const snapshot = await page.evaluate(() => window.__detailPredecessor);
    assert.equal(snapshot?.scheme, scheme, 'Every detail visit must capture the current theme');
    assert.equal(snapshot.background, background);
    assert.equal(snapshot.detailVisible, false, 'Capture the live list before mounting the detail');
    assert.ok(snapshot.source?.[stateKey]);
    const currentLength = await page.evaluate(() => history.length);
    if (length !== undefined) assert.equal(currentLength, length, 'Refreshing the predecessor must not grow history');
    length = currentLength;
    await close();
    assert.deepEqual(await list.evaluate(element => ({ text: element.textContent, top: element.scrollTop })), before);
  }
  // Leave the caller on its original system-theme preference.
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('button', { name: 'System', exact: true }).click();
  await settings.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(settings).toHaveCount(0);
}
