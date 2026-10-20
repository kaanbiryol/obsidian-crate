import { expect } from '@playwright/test';

export async function checkReadingLogoutCorruption(browser, origin) {
  const page = await browser.newPage({ serviceWorkers: 'block' });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('**/reading/exchange', route => route.fulfill({ json: {
      id: 'logout-reading', token: 'reading-test-token', folderPath: 'Reading', generation: 'logout-generation', expiresAt: Date.now() + 86400000,
    } }));
    await page.route('**/reading/list*', route => route.fulfill({ json: { items: [], issues: [], cursor: null } }));
    await page.route('**/auth/session', route => route.fulfill({ status: 204 }));
    await page.goto(`${origin}/notifications?section=reading#reading=logout-test-grant`);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('crate-reading-session-v1') ?? '{}').id)).toBe('logout-reading');
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('crate-reading-v1', 1);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const tx = db.transaction('values', 'readwrite');
      tx.objectStore('values').put('Private saved article', 'article:logout-reading:private');
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
      db.close();
      // Damage stored credentials after hydration, while this tab remains signed in.
      localStorage.setItem('crate-reading-session-v1', '{ damaged credentials');
      sessionStorage.setItem('crate-reminder-draft:logout-test', 'Private draft');
      localStorage.setItem('crate-reminder-outbox:logout-test', 'Private queued change');
    });
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await page.getByRole('button', { name: 'Log out and clear device data', exact: true }).click();
    await expect.poll(() => page.evaluate(() => [
      localStorage.getItem('crate-reading-session-v1'), localStorage.getItem('crate-reminders-auth-token'),
      sessionStorage.getItem('crate-reminder-draft:logout-test'), localStorage.getItem('crate-reminder-outbox:logout-test'),
    ])).toEqual([null, null, null, null]);
    await expect.poll(() => page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('crate-reading-v1', 1);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const count = await new Promise((resolve, reject) => {
        const request = db.transaction('values').objectStore('values').count();
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      db.close(); return count;
    })).toBe(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}
