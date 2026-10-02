import { afterEach, expect, it, vi } from 'vitest';
import { Script } from 'node:vm';
import { SERVICE_WORKER_JS } from '../cloudflare/worker/pwa/service-worker';
import { addReminderScope, createVaultKeyBundle } from '../encryption/key-bundle';
import { createReminderProjection } from '../encryption/reminder-projection';
import { importEncryptionSecret } from '../encryption/envelope';
import { readReminderKeys, type StoredReminderKeys } from './encryption-keys';
import { decryptPushDisplay } from './encrypted-push';

vi.mock('./encryption-keys', () => ({ readReminderKeys: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

async function fixture() {
	const bundle = addReminderScope(createVaultKeyBundle(), 'Reminders');
	const projection = await createReminderProjection(bundle, 'Reminders/Inbox.md', new TextEncoder().encode('- [ ] Private push 2099-01-02 <!-- crate-id:one -->').buffer);
	const notice = projection!.reminders[0]!.notification;
	const keys = { vaultId: bundle.vaultId, scopeId: bundle.scopes[0]!.id, notifications: await importEncryptionSecret(bundle.scopes[0]!.notifications) } as StoredReminderKeys;
	return { notice, keys };
}

it('falls back when reading notification keys never settles', async () => {
	const { notice } = await fixture();
	vi.mocked(readReminderKeys).mockReturnValue(new Promise(() => {}));
	vi.useFakeTimers();
	const handlers = new Map<string, (event: unknown) => void>();
	const showNotification = vi.fn(async () => {});
	new Script(SERVICE_WORKER_JS).runInNewContext({
		self: { addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler), registration: { showNotification } },
		crateEncryptedPush: { decryptPushDisplay },
	});
	let completed!: Promise<void>;
	handlers.get('push')!({ data: { json: () => ({ notification: { data: { encrypted: notice } } }) }, waitUntil: (work: Promise<void>) => { completed = work; } });
	await vi.advanceTimersByTimeAsync(3000);
	await completed;
	expect(showNotification).toHaveBeenCalledExactlyOnceWith('Crate reminder', expect.objectContaining({ body: 'Open Crate to view your reminder' }));
	expect(vi.getTimerCount()).toBe(0);
});

it.each(['success', 'failure'])('ignores late key-read %s after the generic fallback deadline', async outcome => {
	const { notice, keys } = await fixture();
	let resolve!: (keys: StoredReminderKeys) => void, reject!: (error: Error) => void;
	vi.mocked(readReminderKeys).mockReturnValue(new Promise((yes, no) => { resolve = yes; reject = no; }));
	vi.useFakeTimers();
	const display = decryptPushDisplay(notice);
	await vi.advanceTimersByTimeAsync(3000);
	await expect(display).resolves.toBeNull();
	if (outcome === 'success') resolve(keys); else reject(new Error('Late storage failure'));
	await expect(display).resolves.toBeNull();
});

it('still decrypts notifications and clears the deadline after a successful read', async () => {
	const { notice, keys } = await fixture();
	vi.mocked(readReminderKeys).mockResolvedValue(keys);
	vi.useFakeTimers();
	await expect(decryptPushDisplay(notice)).resolves.toMatchObject({ title: 'Private push' });
	expect(vi.getTimerCount()).toBe(0);
});
