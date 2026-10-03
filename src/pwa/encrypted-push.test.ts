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

it.each(['declarative', 'legacy'] as const)('decrypts %s pushes and preserves the notification navigation URL', async delivery => {
	const { notice, keys } = await fixture();
	vi.mocked(readReminderKeys).mockResolvedValue(keys);
	const payload = { notification: { title: 'Crate reminder', body: 'Open Crate to view your reminder.',
		navigate: `https://crate.test/notifications?reminderId=${notice.reminderId}`,
		data: { encrypted: notice, project: '', reminderId: notice.reminderId } } };
	const handlers = new Map<string, (event: unknown) => void>();
	const showNotification = vi.fn(async (_title: string, options: { navigate?: string }) => {
		// WebKit rejects replacement notifications without a valid navigation URL.
		if (delivery === 'declarative' && !options.navigate?.startsWith('https://crate.test/')) throw new Error('Missing declarative navigation');
	});
	new Script(SERVICE_WORKER_JS).runInNewContext({
		self: { addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler), registration: { showNotification } },
		crateEncryptedPush: { decryptPushDisplay },
	});
	let completed!: Promise<void>;
	handlers.get('push')!({
		// Safari supplies a Notification with prototype getters and null event.data.
		...(delivery === 'declarative' ? { data: null, notification: Object.create(payload.notification) as unknown }
			: { data: { json: () => payload } }),
		waitUntil: (work: Promise<void>) => { completed = work; },
	});
	await completed;
	expect(showNotification).toHaveBeenCalledExactlyOnceWith('Private push', expect.objectContaining({
		navigate: payload.notification.navigate,
		data: { project: '', reminderId: notice.reminderId, navigate: payload.notification.navigate },
	}));
});

it.each(['declarative', 'legacy'] as const)('falls back when reading notification keys never settles for a %s push', async delivery => {
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
	const notification = { navigate: 'https://crate.test/notifications?reminderId=one', data: { encrypted: notice, reminderId: 'one' } };
	handlers.get('push')!({ ...(delivery === 'declarative' ? { data: null, notification } : { data: { json: () => ({ notification }) } }),
		waitUntil: (work: Promise<void>) => { completed = work; } });
	await vi.advanceTimersByTimeAsync(3000);
	await completed;
	expect(showNotification).toHaveBeenCalledExactlyOnceWith('Crate reminder', expect.objectContaining({ body: 'Open Crate to view your reminder', navigate: notification.navigate }));
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
