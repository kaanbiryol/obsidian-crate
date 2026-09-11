import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';
const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets, failMutationPaths: ['/reminders/update'] });
let revocations = 0;
server.on('request', req => { if (req.method === 'DELETE' && req.url === '/auth/session') revocations += 1; });
const origin = `http://127.0.0.1:${server.address().port}`;
try {
	for (const browserType of [chromium, webkit]) {
		revocations = 0;
		const browser = await browserType.launch();
		try {
			const context = await browser.newContext();
			const updateBodies = [];
			context.on('request', request => {
				if (request.method() === 'POST' && new URL(request.url()).pathname === '/reminders/update') updateBodies.push(request.postData());
			});
			const one = await context.newPage(); const two = await context.newPage();
			one.setDefaultTimeout(15_000); two.setDefaultTimeout(15_000);
			await one.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
			await two.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
			const cardName = 'Check this article. Press Enter to edit reminder.';
			await one.getByRole('group', { name: cardName, exact: true }).waitFor();
			await two.getByRole('group', { name: cardName, exact: true }).waitFor();
			await one.getByRole('group', { name: cardName, exact: true }).click();
			const title = one.getByRole('textbox', { name: 'Reminder title', exact: true });
			await title.fill('Keep this unsaved draft');
			await one.getByRole('button', { name: 'Save reminder', exact: true }).click();
			await expect(one.getByRole('dialog', { name: 'Edit reminder', exact: true })).toHaveCount(0);
			const pendingCardName = 'Keep this unsaved draft. Press Enter to edit reminder.';
			const pendingNotice = one.getByRole('region', { name: 'Couldn’t sync: Keep this unsaved draft', exact: true });
			await expect(pendingNotice).toBeVisible();
			await expect(one.getByRole('group', { name: pendingCardName, exact: true })).toBeVisible();
			await expect(two.getByRole('group', { name: pendingCardName, exact: true })).toBeVisible();
			await one.reload();
			await expect(pendingNotice).toBeVisible();
			await expect(one.getByRole('group', { name: pendingCardName, exact: true })).toBeVisible();
			await expect(pendingNotice.getByRole('button', { name: 'Retry: Keep this unsaved draft', exact: true })).toBeEnabled();
			await expect.poll(() => updateBodies.length).toBeGreaterThanOrEqual(2);
			expect(new Set(updateBodies).size).toBe(1);
			await one.getByRole('button', { name: 'Open settings', exact: true }).click();
			await one.getByRole('button', { name: 'Log out', exact: true }).click();
			await expect.poll(() => one.evaluate(() => localStorage.getItem('crate-reminders-auth-token'))).toBe(null);
			await expect.poll(() => revocations).toBe(1);
			await expect(two.getByRole('group', { name: pendingCardName, exact: true })).toHaveCount(0);
			await expect.poll(() => two.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('crate-reminder-outbox:')).length)).toBe(0);
			await expect.poll(() => two.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('crate-reminder-draft:')).length)).toBe(0);
			console.log(`${browserType.name()}: ambiguous saves retain optimistic state across reload, replay the same command, and logout clears open tabs`);
			await verifyEnrollmentRecovery(browser, browserType.name());
		} finally { await browser.close(); }
	}
} finally { await new Promise(resolve => server.close(resolve)); }

async function verifyEnrollmentRecovery(browser, browserName) {
  for (const mode of ['browser', 'standalone', 'failed']) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      if (mode === 'standalone') await context.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { value: true }); });
      const page = await context.newPage();
      await page.route('**/notifications/preview-session.js', route => route.fulfill({ contentType: 'application/javascript',
        body: "localStorage.setItem('crate-reminders-auth-token', 'expired-session'); sessionStorage.setItem('crate-reminder-draft:old', 'private old draft');" }));
      const exchanges = [];
      await page.route('**/notifications/reminders-exchange', route => {
        exchanges.push(route.request().postDataJSON());
        return mode === 'failed' ? route.fulfill({ status: 503, body: 'Enrollment temporarily unavailable' }) : route.continue();
      });
      await page.goto(`${origin}/notifications?token=install-fresh&browserToken=browser-fresh&folder=Reminders&tab=inbox`);
      // A failed replacement alone preserves a session. This fixture's old
      // credential is actually expired, so its subsequent list 401 logs out.
      if (mode === 'failed') await page.getByRole('button', { name: 'Open Obsidian', exact: true }).waitFor();
      else await page.getByRole('group', { name: 'Check this article. Press Enter to edit reminder.', exact: true }).waitFor();
      expect(exchanges).toHaveLength(1);
      expect(exchanges[0]).toMatchObject({ token: mode === 'standalone' ? 'install-fresh' : 'browser-fresh', previousAuthToken: 'expired-session' });
      expect(await page.evaluate(() => sessionStorage.getItem('crate-reminder-draft:old'))).toBe('private old draft');
      expect(new URL(page.url()).searchParams.has('browserToken')).toBe(mode === 'failed');
      expect(new URL(page.url()).searchParams.get('token')).toBe(mode === 'standalone' ? null : 'install-fresh');
    } finally { await context.close(); }
  }
  console.log(`${browserName}: expired-session recovery, separate browser/install tokens, failed exchange passed`);
}
