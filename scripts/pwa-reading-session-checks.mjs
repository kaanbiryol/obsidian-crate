import { expect } from '@playwright/test';

export async function verifyReadingEnrollmentAuthority(browser, origin) {
  const readingKey = 'crate-reading-session-v1';
  const original = { token: 'original-reading', id: 'original', folderPath: 'Reading', generation: 'one', expiresAt: Date.now() + 86400000 };
  const delayed = { ...original, token: 'delayed-reading', id: 'delayed' };
  const replacement = { ...original, token: 'replacement-reading', id: 'replacement' };
  for (const change of ['logout', 'replacement']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const exchangeStarted = Promise.withResolvers(), releaseExchange = Promise.withResolvers();
    const revocations = [], listTokens = [], errors = [];
    try {
      await context.addInitScript(({ readingKey, original }) => {
        if (localStorage.getItem('reading-session-test')) return;
        localStorage.setItem('reading-session-test', 'yes');
        localStorage.setItem(readingKey, JSON.stringify(original));
      }, { readingKey, original });
      await context.route('**/notifications/preview-session.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
      await context.route('**/reading/list*', route => {
        listTokens.push(route.request().headers().authorization);
        return route.fulfill({ json: { items: [], issues: [], cursor: null } });
      });
      await context.route('**/auth/session', route => {
        revocations.push(route.request().headers().authorization);
        return route.fulfill({ status: 204 });
      });
      await context.route('**/reading/exchange', async route => {
        exchangeStarted.resolve();
        await releaseExchange.promise;
        await route.fulfill({ json: { ...delayed, installToken: 'discarded-install' } });
      });
      const peer = await context.newPage();
      peer.on('pageerror', error => errors.push(error.message));
      await peer.goto(`${origin}/notifications?section=reading`);
      await expect(peer.getByRole('searchbox', { name: 'Search reading' })).toBeVisible();
      const pending = await context.newPage();
      pending.on('pageerror', error => errors.push(error.message));
      await pending.goto(`${origin}/notifications?section=reading#reading=delayed-grant`);
      await exchangeStarted.promise;
      if (change === 'logout') {
        await peer.bringToFront();
        await peer.getByRole('button', { name: 'Open settings', exact: true }).click();
        await peer.getByRole('button', { name: 'Log out', exact: true }).click();
        await peer.getByRole('button', { name: 'Log out and clear device data', exact: true }).click();
        await expect.poll(() => peer.evaluate(key => localStorage.getItem(key), readingKey)).toBeNull();
        await expect.poll(() => peer.evaluate(() => localStorage.getItem('crate-reminders-logout'))).not.toBeNull();
      } else {
        await peer.evaluate(({ readingKey, replacement }) => localStorage.setItem(readingKey, JSON.stringify(replacement)), { readingKey, replacement });
      }
      releaseExchange.resolve();
      await pending.bringToFront();
      await expect.poll(() => revocations).toContain(`Bearer ${delayed.token}`);
      await expect(pending.getByRole('heading', { name: 'Your reading, everywhere' })).toBeVisible();
      expect(await pending.evaluate(key => localStorage.getItem(key), readingKey)).toBe(change === 'logout' ? null : JSON.stringify(replacement));
      expect(await context.cookies()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'crate-reading-install' })]));
      expect(listTokens).not.toContain(`Bearer ${delayed.token}`);
      expect(revocations).not.toContain(`Bearer ${replacement.token}`);
      if (change === 'replacement') {
        await pending.reload();
        await expect(pending.getByRole('searchbox', { name: 'Search reading' })).toBeVisible();
        await expect.poll(() => listTokens).toContain(`Bearer ${replacement.token}`);
      }
      expect(errors).toEqual([]);
    } finally {
      releaseExchange.resolve();
      await context.close();
    }
  }
}
