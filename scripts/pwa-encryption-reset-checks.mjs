import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

/** Exercise the real reset API and expired-session logout in the same browser
 * partition, where old encryption markers must not silently allow a downgrade. */
export async function verifyEncryptionReset({ admin, page, origin, owner, runtime }) {
	const peer = await page.context().newPage();
	try {
		await peer.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
		await expect(peer.getByText('Private browser task', { exact: true })).toBeVisible();
		await peer.evaluate(() => { window.crateResetDocument = 'original-encrypted-tab'; });
		await resetAndReconnect({ admin, page, peer, origin, owner, runtime });
	} finally { await peer.close(); }
}

async function resetAndReconnect({ admin, page, peer, origin, owner, runtime }) {
	const oldWebToken = await page.evaluate(() => localStorage.getItem('crate-reminders-auth-token'));
	const next = await admin.evaluate(async ({ origin, token }) => {
		const t = window.crateEncryptionTest;
		const transport = async request => {
			const response = await fetch(request.url, { method: request.method, body: request.body, headers: { ...request.headers, 'Content-Type': request.contentType ?? 'application/json' } });
			const buffer = await response.arrayBuffer();
			return { status: response.status, headers: Object.fromEntries(response.headers), arrayBuffer: buffer, text: new TextDecoder().decode(buffer) };
		};
		const create = token => new t.WorkerApiHttpClient(origin, token, transport);
		const http = create(token);
		const state = await t.readServerEncryption(http);
		const reset = t.createEncryptionReset(origin, token, state, true);
		await t.resetRemoteEncryption(reset, () => {}, () => {}, create, () => {});
		const api = new t.SyncApiClient(origin, reset.replacementToken, transport);
		const content = '- [ ] New unencrypted reminder <!-- crate-id:after-reset -->\n';
		const bytes = new TextEncoder().encode(content);
		const info = await api.getServerInfo();
		const upload = await fetch(`${origin}/sync/upload?path=Reminders%2FInbox.md`, { method: 'PUT', body: bytes, headers: {
			Authorization: `Bearer ${reset.replacementToken}`, 'X-Crate-Protocol': String(info.protocol.current), 'Content-Type': 'text/markdown',
			'X-Crate-Expected-Hash': 'absent', 'X-Crate-Upload-Operation': `e1_${String(info.reminderOperationDay).padStart(8, '0')}_${crypto.randomUUID()}`,
		} });
		if (!upload.ok) throw new Error(await upload.text());
		// A repeat after the new upload must return the receipt, never wipe again.
		await t.resetRemoteEncryption(reset, () => {}, () => {}, create, () => {});
		return api.createRemindersEnrollmentToken('Reminders');
	}, { origin, token: owner.token });
	assert.equal((await fetch(`${origin}/health`, { headers: { Authorization: `Bearer ${owner.token}` } })).status, 401);
	if (oldWebToken) assert.equal((await fetch(`${origin}/health`, { headers: { Authorization: `Bearer ${oldWebToken}` } })).status, 401);
	assert.equal(await runtime.db.prepare("SELECT 1 FROM maintenance_state WHERE key = 'e2ee:state'").first(), null);
	assert.equal(await runtime.db.prepare('SELECT 1 FROM file_versions').first(), null);
	await page.reload();
	await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
	assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('crate-encryption-session:'))), true);
	await page.getByRole('button', { name: 'Log out', exact: true }).click();
	await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('crate-encryption-session:')))).toBe(false);
	await page.goto(`${origin}/notifications?browserToken=${next.browserToken}&folder=Reminders&tab=inbox`);
	await expect(page.getByText('New unencrypted reminder', { exact: true })).toBeVisible();
	await expect(page.getByText('Private browser task', { exact: true })).toHaveCount(0);
	// This tab must adopt the new session through native storage events, without
	// reloading away the in-memory lock left by its previous encrypted session.
	await expect(peer.getByText('New unencrypted reminder', { exact: true })).toBeVisible();
	assert.equal(await peer.evaluate(() => window.crateResetDocument), 'original-encrypted-tab');
	await peer.locator('[data-action="open-create-modal"]').click();
	await peer.getByRole('textbox', { name: 'Reminder title', exact: true }).fill('Saved from the open tab after reset');
	await expect.poll(() => peer.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('crate-reminder-draft:')
		&& sessionStorage.getItem(key).includes('Saved from the open tab after reset')))).toBe(true);
	await peer.getByRole('button', { name: 'Add reminder', exact: true }).click();
	await expect(peer.getByRole('textbox', { name: 'Reminder title', exact: true })).toHaveCount(0);
	await expect(page.getByText('Saved from the open tab after reset', { exact: true })).toBeVisible();
	await expect.poll(() => peer.evaluate(async () => {
		const database = await new Promise((resolve, reject) => {
			const request = indexedDB.open('crate-reminders');
			request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
		});
		try {
			const snapshot = await new Promise((resolve, reject) => {
				const request = database.transaction('snapshots').objectStore('snapshots').get('Reminders');
				request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
			});
			return !snapshot?.encrypted && snapshot?.reminders.some(reminder => reminder.content === 'Saved from the open tab after reset');
		} finally { database.close(); }
	})).toBe(true);
	await page.reload();
	await expect(page.getByText('New unencrypted reminder', { exact: true })).toBeVisible();
	await expect(page.getByText('Saved from the open tab after reset', { exact: true })).toBeVisible();
}
